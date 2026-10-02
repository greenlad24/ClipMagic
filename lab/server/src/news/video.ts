/**
 * AI News Stream — the video for a story's second "screen", or nothing.
 *
 * Jake (2026-10-01): each story gets the most impressive video of the same
 * story, full screen behind him while he talks. It must be the OFFICIAL video
 * (the company's own launch film / demo) — "if that video doesn't exist, don't
 * show anything", never a reviewer, a creator or a random channel. Follow-ups
 * the same day: look at a VARIETY of sources (the company's channels, its
 * pages, its newsroom, the news articles), take native videos too (Vimeo,
 * <video> files, JSON-LD, og:video). Then, after seeing a CNBC segment picked:
 * "I would rather not have a CNBC video. I want to show a demo video or a
 * marketing video of each story" — so news-outlet footage is NEVER picked, and
 * the fallback when there is no launch video for the news is the company's own
 * demo/marketing video of the PRODUCT (see `productFallback`).
 *
 * ⚠️ PRECISION OVER RECALL, AT EVERY STEP. Every source feeds one pool, the
 * pool is cut to what is provably the company's own, mechanical filters drop what can never work on a big screen
 * (not embeddable, live, vertical, under 5–8 s, over 15 min, tiny icon loops),
 * and ONE model call per tier must pick the video for THIS story or say none.
 * See `search()` for the sources and the ownership rule.
 *
 * ⚠️ HANDLES ARE NOT IDENTITIES. Measured 2026-10-01: `@xai` is a 20-subscriber
 * channel called "RPlm", `@xaiofficial` is a 931k-subscriber Khmer gaming
 * channel, `@perplexity` is "Alacrity", `@qwen` is a person,
 * `@BloombergTelevision` a Korean vlog. The real ones are `@grok`,
 * `@perplexity-ai`, `@QwenLM`, `@business`. So every allowlisted channel is
 * PINNED to the id it was verified against, and the handle is re-resolved and
 * must still point there (a handle can be released and re-registered).
 *
 * Quota: the Data API has 10,000 units a day. Every response is cached in
 * `news_yt_cache`, channel ids in `news_yt_channels`, the per-story pick in
 * `news_video_picks`; uploads are read from playlists (1 unit a page) and
 * search.list (100 units) runs only when nothing else matched, at most twice a
 * story; a quotaExceeded stops all YouTube calls for an hour. Without a key the
 * page sources still run and YouTube is skipped.
 */
import { db } from "../db/index.js";
import { getYoutubeDataApiKey } from "../settings/postizSecrets.js";
import { callNewsModel } from "./ai.js";
import { claudeVisionLabeledJSON, type LabeledImage } from "../ai/claude.js";
import { slides, stories, type StoryRecord, type SlideRecord } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS news_yt_cache (
  cache_key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS news_yt_channels (
  handle TEXT PRIMARY KEY,
  channel_id TEXT,
  title TEXT,
  subscribers INTEGER,
  uploads_playlist TEXT,
  ok INTEGER NOT NULL,
  note TEXT,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS news_video_picks (
  story_id TEXT PRIMARY KEY,
  video_id TEXT,
  video_title TEXT,
  video_channel TEXT,
  reason TEXT,
  candidates_json TEXT,
  manual INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL
);
`);
// The muted-screen verdict per YouTube video (see `muteFit`) — one vision call per video, ever.
db.exec(`CREATE TABLE IF NOT EXISTS news_video_fit (
  video_id TEXT PRIMARY KEY,
  fit INTEGER NOT NULL,
  shot TEXT,
  reason TEXT,
  algo INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
)`);
// Added with non-YouTube videos (Vimeo, native files), the tiers, and `algo` (which version of the finder made the pick).
for (const col of ["video_kind TEXT", "video_url TEXT", "video_tier TEXT", "video_proxy INTEGER", "algo INTEGER"]) {
  const name = col.split(" ")[0];
  const has = (db.prepare(`PRAGMA table_info(news_video_picks)`).all() as { name: string }[]).some((c) => c.name === name);
  if (!has) db.exec(`ALTER TABLE news_video_picks ADD COLUMN ${col}`);
}

/**
 * Bump when the finder's rules change: a cached pick made by an older version
 * is never reused (manual picks always are).
 *   2 — Jake 2026-10-01: no news-outlet footage ever (a CNBC segment had been
 *       picked); a company product demo is the fallback instead.
 *   3 — Jake 2026-10-01: a pick must work MUTED (no talking heads — see
 *       `muteFit`), Huawei is on the allowlist, and a deck never shows the
 *       same video twice (`uniqueVideos`).
 */
const PICK_ALGO = 3;

/*
 * ⚠️ THE OUTLET TIER IS GONE, AND SO ARE ITS LEFTOVERS. Jake: "I would rather
 * not have a CNBC video. I want a demo video or a marketing video." Outlet picks
 * already sitting on slides (Gemini 4 Argon, FTC probe on the 2026-10-01 deck)
 * are cleared here at startup — idempotent, never touches a manual pick — and
 * every non-manual cached pick from an older finder is dropped, so a rebuild or
 * "Find video" recomputes instead of reusing it.
 */
try {
  db.prepare(`DELETE FROM news_video_picks WHERE manual = 0 AND (video_tier = 'outlet' OR COALESCE(algo, 0) < ?)`).run(PICK_ALGO);
  db.prepare(`UPDATE news_slides SET video_id = NULL, video_kind = NULL, video_url = NULL, video_tier = NULL, video_proxy = 0,
    video_title = NULL, video_channel = NULL, video_checked_at = NULL,
    video_reason = 'A news-outlet clip was removed (company demo/marketing videos only). Press "Find video" to look again.'
    WHERE video_tier = 'outlet'`).run();
} catch (err) {
  console.warn("[news-video] clearing outlet picks failed:", err);
}

/* ── the allowlist ────────────────────────────────────────────────────────── */

interface OfficialChannel {
  handle: string;
  /** The channel id the handle was verified against (title + subscribers + content), 2026-10-01. */
  id: string;
}
interface Company {
  name: string;
  /** Words that say a headline is about this company. The FIRST company named is the subject. */
  match: RegExp;
  /** The company's own web domains — an article on one of these is an announcement page. */
  domains: string[];
  /** The company's newsroom/blog index — scanned for the launch post when the story did not carry it. */
  newsroom?: string[];
  channels: OfficialChannel[];
}

/**
 * Official channels, each verified on 2026-10-01 by resolving the handle
 * (channels.list?forHandle, 1 unit) and reading title, subscriber count and
 * the latest uploads — and, where the company's homepage links a channel,
 * checking it is that one. Companies with no verifiable channel (DeepSeek,
 * ByteDance Seed — `@ByteDance` is a careers channel) are deliberately absent:
 * they fall through to the strict path 3.
 *
 * ⚠️ DEEPSEEK, RE-CHECKED 2026-10-01: deepseek.com, /en and api-docs link no
 * YouTube channel at all; `@deepseek` does not resolve, `@DeepSeekAI` is a
 * 9-subscriber Hindi tech channel, and `@deepseek-ai` ("DeepSeek", 257 subs)
 * holds two 2023–24 research-talk uploads and nothing since. Nothing there can
 * be verified as the company's, and nothing there would go on screen anyway.
 *
 * To add one: resolve the handle, check it is really the company, pin its id.
 */
export const OFFICIAL_COMPANIES: Company[] = [
  { name: "OpenAI", match: /\b(openai|chatgpt|gpt-?\d[\w.]*|sora|codex)\b/i, domains: ["openai.com", "chatgpt.com"],
    newsroom: ["https://openai.com/news/"],
    channels: [{ handle: "OpenAI", id: "UCXZCJLdBC09xxGZ6gcdrc6A" }] },
  { name: "Anthropic", match: /\b(anthropic|claude)\b/i, domains: ["anthropic.com", "claude.ai", "claude.com"],
    newsroom: ["https://www.anthropic.com/news"],
    channels: [{ handle: "anthropic-ai", id: "UCrDwWp7EBBv4NwvScIpBDOA" }, { handle: "claude", id: "UCV03SRZXJEz-hchIAogeJOg" }] },
  { name: "Google", match: /\b(google|gemini|deepmind|veo|gemma|notebooklm|pixel)\b/i,
    domains: ["blog.google", "google.com", "deepmind.google", "deepmind.com", "gemini.google", "googleblog.com", "store.google.com"],
    newsroom: ["https://blog.google/", "https://deepmind.google/discover/blog/"],
    channels: [
      { handle: "Google", id: "UCK8sQmJBp8GCxrOtXWBpyEA" },
      { handle: "googledeepmind", id: "UCP7jMXSY2xbc3KCAE0MHQ-A" },
      { handle: "GoogleGemini", id: "UCNW6J6bFBIAmvbrnE0rCPnA" },
      { handle: "GoogleLabs", id: "UCB5ofLXaAv_a1QopZ801K7A" },
      { handle: "GoogleDevelopers", id: "UC_x5XG1OV2P6uZZ5FSM9Ttw" },
      { handle: "madebygoogle", id: "UCIG1k8umaCIIrujZPzZPIMA" },
      { handle: "googlecloud", id: "UCTMRxtyHoE3LPcrl-kT4AQQ" },
    ] },
  { name: "Meta", match: /\b(meta|llama|ray-ban)\b/i, domains: ["about.fb.com", "ai.meta.com", "meta.com"],
    newsroom: ["https://about.fb.com/news/"],
    channels: [
      { handle: "Meta", id: "UC04FyDIvYXNecpbG8gyOw4A" },
      { handle: "AIatMeta", id: "UC5qxlwEKM7-5YZudb24l0bg" },
      // The glasses' own channel ("Ray-Ban | Meta"), where Meta's glasses launch films go.
      { handle: "RayBanMeta", id: "UCr6KJz_DHUXSwN3sP0gOoOw" },
    ] },
  { name: "NVIDIA", match: /\bnvidia\b/i, domains: ["nvidia.com", "blogs.nvidia.com", "nvidianews.nvidia.com"],
    newsroom: ["https://nvidianews.nvidia.com/"],
    channels: [{ handle: "NVIDIA", id: "UCHuiy8bXnmK5nisYHUd1J5g" }, { handle: "NVIDIADeveloper", id: "UCBHcMCGaiJhv-ESTcWGJPcw" }] },
  { name: "Microsoft", match: /\b(microsoft|copilot|bing|azure)\b/i, domains: ["microsoft.com", "blogs.microsoft.com", "news.microsoft.com"],
    newsroom: ["https://news.microsoft.com/source/", "https://blogs.microsoft.com/"],
    channels: [
      { handle: "Microsoft", id: "UCFtEEv80fQVKkD4h1PF-Xqw" },
      // Formerly @Microsoft365, now "Microsoft Copilot" (758k) — the Copilot launch videos live here.
      { handle: "microsoft.copilot", id: "UCc3pNIRzIZ8ynI38GO6H01Q" },
      { handle: "MicrosoftDeveloper", id: "UCsMica-v34Irf9KVTh6xx-g" },
      { handle: "MicrosoftAzure", id: "UC0m-80FnNY2Qb7obvTL_2fA" },
    ] },
  { name: "xAI", match: /\b(xai|grok)\b/i, domains: ["x.ai"], newsroom: ["https://x.ai/news"],
    channels: [{ handle: "grok", id: "UCxgo0OMZU9SiaYpJsuZKWkQ" }] },
  { name: "Mistral", match: /\bmistral\b/i, domains: ["mistral.ai"], newsroom: ["https://mistral.ai/news"],
    channels: [{ handle: "MistralAIOfficial", id: "UC5-pBdfdA3KUo-vq72l-umA" }] },
  { name: "Apple", match: /\b(apple|siri|iphone|ipad|macbook|vision pro)\b/i, domains: ["apple.com"], newsroom: ["https://www.apple.com/newsroom/"],
    channels: [{ handle: "Apple", id: "UCE_M8A5yxnLfW0KghEeajjw" }, { handle: "AppleDeveloper", id: "UCwrVwiJllwhJUKXKmjLcckQ" }] },
  { name: "Amazon", match: /\b(amazon|aws|alexa\+?)\b/i, domains: ["aboutamazon.com", "amazon.com", "aws.amazon.com"],
    newsroom: ["https://www.aboutamazon.com/news"],
    channels: [
      { handle: "amazon", id: "UCkLXELm63_pH7L-r-548kig" },
      { handle: "AmazonNews", id: "UCzE5rz2KHTFYAkmMksUpPLA" },
      { handle: "amazonwebservices", id: "UCd6MoB9NC6uYN2grvUNT-Zg" },
    ] },
  { name: "Samsung", match: /\b(samsung|galaxy)\b/i, domains: ["samsung.com", "news.samsung.com"], newsroom: ["https://news.samsung.com/global/"],
    channels: [{ handle: "Samsung", id: "UCWwgaK7x0_FR1goeSRazfsQ" }] },
  { name: "Tesla", match: /\b(tesla|optimus)\b/i, domains: ["tesla.com"],
    channels: [{ handle: "tesla", id: "UC5WjFrtBdufl6CZojX3D8dQ" }] },
  { name: "Figure", match: /\bfigure (ai|0?\d{1,2})\b|\bfigure's (robot|humanoid)s?\b|\bhelix\b/i, domains: ["figure.ai"], newsroom: ["https://www.figure.ai/news"],
    channels: [{ handle: "figureai", id: "UCYlq-KmwPjc1DtsGmthFqSQ" }] },
  { name: "Boston Dynamics", match: /\bboston dynamics\b/i, domains: ["bostondynamics.com"], newsroom: ["https://bostondynamics.com/blog/"],
    channels: [{ handle: "BostonDynamics", id: "UC7vVhkEfw4nOGp8TyDk7RcQ" }] },
  { name: "Unitree", match: /\bunitree\b/i, domains: ["unitree.com"],
    channels: [{ handle: "unitreerobotics", id: "UCsMbp4V8oxzHCMdOUP-3oWw" }] },
  { name: "1X", match: /\b1x\b|\bneo (home )?robot\b/i, domains: ["1x.tech"],
    channels: [{ handle: "1X-tech", id: "UCoHslVexR2q57wUoCRfdUsg" }] },
  { name: "Runway", match: /\brunway( ?ml)?\b/i, domains: ["runwayml.com"], newsroom: ["https://runwayml.com/news"],
    channels: [{ handle: "runwayml", id: "UCUBqu_z5uP0AZhYtuyFZB3g" }] },
  { name: "Pika", match: /\bpika\b/i, domains: ["pika.art"],
    channels: [{ handle: "pika_labs", id: "UC0SclYU4iiQRihtmDnak-gQ" }] },
  { name: "Luma AI", match: /\bluma\b/i, domains: ["lumalabs.ai"],
    channels: [{ handle: "lumalabsai", id: "UC45T0I4p7A3dI0XvhivafZQ" }] },
  { name: "Kling", match: /\b(kling|kuaishou)\b/i, domains: ["klingai.com"],
    channels: [{ handle: "kling_ai", id: "UC1i21joJVJVVRUGUOGFEdVQ" }] },
  { name: "ElevenLabs", match: /\beleven ?labs\b/i, domains: ["elevenlabs.io"], newsroom: ["https://elevenlabs.io/blog"],
    channels: [{ handle: "elevenlabs", id: "UC-ew9TfeD887qUSiWWAAj1w" }] },
  { name: "Perplexity", match: /\bperplexity\b/i, domains: ["perplexity.ai"],
    channels: [{ handle: "perplexity-ai", id: "UCYqxnCFtaC4-iC_bwt2bRLg" }] },
  { name: "Adobe", match: /\b(adobe|firefly|photoshop|premiere pro)\b/i, domains: ["adobe.com", "blog.adobe.com", "news.adobe.com"],
    newsroom: ["https://news.adobe.com/"],
    channels: [
      { handle: "Adobe", id: "UC5_SBQbLA9Kg7Jh5GpXoP3g" },
      { handle: "AdobeFirefly", id: "UCPoZs42STdjL0-HMjw-PIqA" },
      { handle: "adobecreativecloud", id: "UCL0iAkpqV5YaIVG7xkDtS4Q" },
      { handle: "AdobeVideo", id: "UCzgPg1KhiJTzkxy0IUciRaQ" },
    ] },
  { name: "Midjourney", match: /\bmidjourney\b/i, domains: ["midjourney.com"], newsroom: ["https://updates.midjourney.com/"],
    channels: [{ handle: "midjourney", id: "UCldFPBqAVrok5DPUQeSMEqQ" }] },
  { name: "Stability AI", match: /\b(stability ai|stable diffusion)\b/i, domains: ["stability.ai"], newsroom: ["https://stability.ai/news"],
    channels: [{ handle: "Stability_AI", id: "UCpi_ULPErwrxGTDWZey5azQ" }] },
  { name: "Alibaba Qwen", match: /\b(qwen|alibaba)\b/i, domains: ["qwen.ai", "qwenlm.github.io", "alibabacloud.com", "alibabagroup.com"],
    channels: [{ handle: "QwenLM", id: "UCWeqUXS57KQhmup0wlymlIQ" }, { handle: "AlibabaCloud", id: "UCipPA-ZHX6UYGH_Iyti1-Jw" }] },
  { name: "Suno", match: /\bsuno\b/i, domains: ["suno.com"], newsroom: ["https://suno.com/blog"],
    channels: [{ handle: "suno", id: "UCB80OYIR33HGCc-_cT0AsUA" }] },
  { name: "Cursor", match: /\bcursor\b/i, domains: ["cursor.com"], newsroom: ["https://cursor.com/blog"],
    channels: [{ handle: "cursor_ai", id: "UC6YYHJzM6PhZ2Yey9BQiUaw" }] },
  { name: "Replit", match: /\breplit\b/i, domains: ["replit.com", "blog.replit.com"], newsroom: ["https://blog.replit.com/"],
    channels: [{ handle: "replit", id: "UCgoJjdR6-7AMu9fDitb6nVw" }] },
  { name: "Notion", match: /\bnotion\b/i, domains: ["notion.com", "notion.so"], newsroom: ["https://www.notion.com/releases"],
    channels: [{ handle: "Notion", id: "UCoSvlWS5XcwaSzIcbuJ-Ysg" }] },
  { name: "Canva", match: /\bcanva\b/i, domains: ["canva.com"], newsroom: ["https://www.canva.com/newsroom/news/"],
    channels: [{ handle: "canva", id: "UCEDLeLo3HNQZiJOTR2svg2A" }] },
  { name: "Higgsfield", match: /\bhiggsfield\b/i, domains: ["higgsfield.ai"],
    channels: [{ handle: "higgsfieldai", id: "UCh13OyDSm-Kb8ij3yZArtFg" }] },
  // Verified 2026-10-01: @huawei "Welcome to the official channel for Huawei" (1.39M, 3.6k videos);
  // @huaweimobile is the one consumer.huawei.com links (3.2M); @huaweienterprise (14k) carries
  // the Ascend/data-center films. (@huaweicloud is a 4-subscriber stranger.)
  { name: "Huawei", match: /\b(huawei|harmonyos)\b/i, domains: ["huawei.com"], newsroom: ["https://www.huawei.com/en/news"],
    channels: [
      { handle: "huawei", id: "UCtjV1_XU6gvPYyreaFScxBQ" },
      { handle: "huaweienterprise", id: "UCtoueYt1HK2Y7P5rkz7C4Aw" },
      { handle: "huaweimobile", id: "UCM_zp2dVNflkGFWAFM_N7lg" },
    ] },
  { name: "Hugging Face", match: /\bhugging ?face\b/i, domains: ["huggingface.co"], newsroom: ["https://huggingface.co/blog"],
    channels: [{ handle: "HuggingFace", id: "UCHlNU7kIZhRgSbhHvFoy72w" }] },
];

/* ── YouTube Data API, cached ─────────────────────────────────────────────── */

const YT = "https://www.googleapis.com/youtube/v3";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export class VideoQuotaError extends Error {}
class NoKeyError extends Error {}

let quotaBlockedUntil = 0;
let unitsTotal = 0;
/** Quota units this process has spent on video lookups (cache hits are free). */
export const videoQuotaUsed = (): number => unitsTotal;

interface Ctx {
  units: number;
  searches: number;
  /** Media keys (`videoKey`) another slide of the same deck already shows — never picked again. */
  exclude?: Set<string>;
  /** Candidates dropped because an earlier slide has them. */
  dupSkipped?: number;
  /** Picks the muted-screen check turned down, as "title (why)". */
  fitRejected?: string[];
}

const inflight = new Map<string, Promise<any>>();

async function yt(endpoint: string, params: Record<string, string>, cost: number, ttlMs: number, ctx: Ctx): Promise<any> {
  const key = getYoutubeDataApiKey();
  if (!key) throw new NoKeyError("YouTube key not set");
  const cacheKey = endpoint + "?" + Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  if (ttlMs > 0) {
    const row = db.prepare(`SELECT json, fetched_at FROM news_yt_cache WHERE cache_key = ?`).get(cacheKey) as { json: string; fetched_at: number } | undefined;
    if (row && Date.now() - row.fetched_at < ttlMs) return JSON.parse(row.json);
  }
  const pending = inflight.get(cacheKey);
  if (pending) return pending;
  if (Date.now() < quotaBlockedUntil) throw new VideoQuotaError("YouTube quota exhausted — video lookups paused");
  const p = (async () => {
    const qs = new URLSearchParams({ ...params, key });
    const res = await fetch(`${YT}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(15000) });
    ctx.units += cost;
    unitsTotal += cost;
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = json?.error?.errors?.[0]?.reason || "";
      if (res.status === 403 && /quota|rateLimit|dailyLimit/i.test(reason)) {
        quotaBlockedUntil = Date.now() + HOUR;
        throw new VideoQuotaError(`YouTube quota exceeded (${reason})`);
      }
      throw new Error(`YouTube ${endpoint} HTTP ${res.status} ${reason}`);
    }
    if (ttlMs > 0) {
      db.prepare(`INSERT INTO news_yt_cache (cache_key, json, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`).run(cacheKey, JSON.stringify(json), Date.now());
    }
    return json;
  })();
  inflight.set(cacheKey, p);
  try { return await p; } finally { inflight.delete(cacheKey); }
}

interface ResolvedChannel { channelId: string; title: string; uploads: string }

/**
 * An allowlisted handle → its channel, ONLY if it still is the channel it was
 * verified as. Cached 30 days in `news_yt_channels`; a failed check is cached
 * too, so a dead handle costs one unit a month, not one per story.
 */
async function resolveOfficial(ch: OfficialChannel, company: Company, ctx: Ctx): Promise<ResolvedChannel | null> {
  const row = db.prepare(`SELECT * FROM news_yt_channels WHERE handle = ?`).get(ch.handle.toLowerCase()) as any;
  if (row && Date.now() - row.checked_at < 30 * DAY) {
    return row.ok ? { channelId: row.channel_id, title: row.title, uploads: row.uploads_playlist } : null;
  }
  const json = await yt("channels", { part: "snippet,statistics,contentDetails", forHandle: ch.handle }, 1, 0, ctx);
  const it = json?.items?.[0];
  const id: string = it?.id ?? "";
  const title: string = it?.snippet?.title ?? "";
  const subs = Number(it?.statistics?.subscriberCount ?? 0);
  const uploads: string = it?.contentDetails?.relatedPlaylists?.uploads ?? "";
  let ok = !!it && !!uploads;
  let note = "";
  if (!it) { ok = false; note = "handle does not resolve"; }
  else if (ch.id && id !== ch.id) { ok = false; note = `handle now points to ${id} (${title}), not the verified ${ch.id}`; }
  else if (!ch.id) {
    // Unpinned entry: the channel must at least carry the company's name and a real audience.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!norm(title).includes(norm(company.name)) && !norm(company.name).includes(norm(title))) { ok = false; note = `title "${title}" does not match ${company.name}`; }
    else if (subs < 10000) { ok = false; note = `only ${subs} subscribers`; }
  }
  if (!ok) console.warn(`[news-video] dropping @${ch.handle} for ${company.name}: ${note}`);
  db.prepare(`INSERT INTO news_yt_channels (handle, channel_id, title, subscribers, uploads_playlist, ok, note, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET channel_id = excluded.channel_id, title = excluded.title,
    subscribers = excluded.subscribers, uploads_playlist = excluded.uploads_playlist, ok = excluded.ok, note = excluded.note, checked_at = excluded.checked_at`)
    .run(ch.handle.toLowerCase(), id, title, subs, uploads, ok ? 1 : 0, note, Date.now());
  return ok ? { channelId: id, title, uploads } : null;
}

/** Uploads published inside [from, to], newest-first, reading at most 4 pages of 50. */
async function uploadsInWindow(uploads: string, from: Date, to: Date, ctx: Ctx): Promise<{ ids: string[]; covered: boolean }> {
  const ids: string[] = [];
  let pageToken = "";
  for (let page = 0; page < 4; page++) {
    const params: Record<string, string> = { part: "contentDetails", playlistId: uploads, maxResults: "50" };
    if (pageToken) params.pageToken = pageToken;
    const json = await yt("playlistItems", params, 1, 2 * HOUR, ctx);
    let oldest = Infinity;
    for (const it of json?.items ?? []) {
      const at = Date.parse(it?.contentDetails?.videoPublishedAt ?? "");
      const id = it?.contentDetails?.videoId;
      if (!id || isNaN(at)) continue;
      oldest = Math.min(oldest, at);
      if (at >= from.getTime() && at <= to.getTime()) ids.push(id);
    }
    pageToken = json?.nextPageToken ?? "";
    if (oldest < from.getTime() || !pageToken) return { ids, covered: true };
  }
  return { ids, covered: false };
}

interface VideoInfo {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  seconds: number;
  views: number;
  embeddable: boolean;
  publicVideo: boolean;
  live: boolean;
  ageRestricted: boolean;
  /** Portrait (taller than wide) — a Short or a phone clip; letterboxed to a sliver on a 16:9 screen. */
  vertical: boolean;
}

function isoSeconds(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

async function videoDetails(ids: string[], ctx: Ctx): Promise<VideoInfo[]> {
  const out: VideoInfo[] = [];
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 50) {
    // `player` with maxHeight returns the embed size at the video's own aspect
    // ratio — the only key-only way to tell a vertical Short from a 16:9 trailer
    // (measured: the two "Introducing Claude Sonnet 5.5" uploads are 1280×720
    // and 405×720). Same 1 unit.
    const json = await yt("videos", { part: "snippet,contentDetails,status,statistics,player", maxHeight: "720", id: uniq.slice(i, i + 50).join(",") }, 1, 6 * HOUR, ctx);
    for (const v of json?.items ?? []) {
      out.push({
        id: v.id,
        title: v.snippet?.title ?? "",
        description: v.snippet?.description ?? "",
        channelId: v.snippet?.channelId ?? "",
        channelTitle: v.snippet?.channelTitle ?? "",
        publishedAt: v.snippet?.publishedAt ?? "",
        seconds: isoSeconds(v.contentDetails?.duration ?? ""),
        views: Number(v.statistics?.viewCount ?? 0),
        embeddable: v.status?.embeddable === true,
        publicVideo: v.status?.privacyStatus === "public",
        live: (v.snippet?.liveBroadcastContent ?? "none") !== "none",
        ageRestricted: v.contentDetails?.contentRating?.ytRating === "ytAgeRestricted",
        vertical: Number(v.player?.embedHeight ?? 0) > Number(v.player?.embedWidth ?? 0) && Number(v.player?.embedWidth ?? 0) > 0,
      });
    }
  }
  return out;
}

/** One YouTube video's length + description (Deep Dive uses it to cut clips at chapters / quarter points). */
export async function youtubeInfo(id: string): Promise<{ seconds: number; description: string; title: string; channelTitle: string } | null> {
  const ctx: Ctx = { units: 0, searches: 0 };
  const [v] = await videoDetails([id], ctx).catch(() => [] as VideoInfo[]);
  return v ? { seconds: v.seconds, description: v.description, title: v.title, channelTitle: v.channelTitle } : null;
}

/** Why a video can never go on screen, or "" if it can. Mechanical rules only. */
function hardReject(v: VideoInfo): string {
  if (!v.embeddable) return "not embeddable";
  if (!v.publicVideo) return "not public";
  if (v.live) return "live/upcoming";
  if (v.ageRestricted) return "age-restricted";
  if (v.seconds > 15 * 60) return "longer than 15 minutes";
  // 8s, not 20: official launch teasers run short ("Introducing Claude Sonnet
  // 5.5" is 14s) and a short one loops fine behind the presenter.
  if (v.seconds < 8) return "shorter than 8 seconds";
  if (v.vertical) return "vertical (a Short)";
  if (/#shorts?\b/i.test(v.title + " " + v.description.slice(0, 300))) return "a Short";
  return "";
}

/* ── official pages ───────────────────────────────────────────────────────── */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchPage(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
    if (!res.ok) return "";
    const text = await res.text();
    return text.slice(0, 3_000_000);
  } catch {
    return "";
  }
}

/** Every YouTube video id a page embeds or links (iframes, og:video, watch/short links, player data). */
export function extractYouTubeIds(html: string): string[] {
  const ids = new Set<string>();
  const res = [
    /youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:[^"'\s>]*?&(?:amp;)?)?v=|v\/|shorts\/|live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/g,
    /youtu\.be\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/g,
    /data-(?:youtube|yt|video)-?id=["']([A-Za-z0-9_-]{11})["']/g,
  ];
  for (const re of res) for (const m of html.matchAll(re)) ids.add(m[1]);
  return [...ids];
}

/** Channels a page links to: @handles and /channel/UC… ids. */
function extractChannelLinks(html: string): { handles: Set<string>; ids: Set<string> } {
  const handles = new Set<string>();
  const ids = new Set<string>();
  for (const m of html.matchAll(/youtube\.com\/@([A-Za-z0-9_.-]+)/g)) handles.add(m[1].toLowerCase().replace(/[.-]+$/, ""));
  for (const m of html.matchAll(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})/g)) ids.add(m[1]);
  return { handles, ids };
}

const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const onDomain = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith("." + d));

/* ── story → company + keywords ───────────────────────────────────────────── */

interface BlogSrc { company: string; url: string; title?: string; isOfficial?: boolean }
interface ArticleSrc { outlet: string; url: string; title?: string }

/**
 * Subjects that are NOT on the allowlist — other companies, regulators,
 * courts, governments. ⚠️ Without this the first ALLOWLISTED name wins even
 * when it is the object: "DeepSeek and Huawei Partner to Build Open-Source
 * Nvidia Rival" was searched on NVIDIA's channel, "FTC Investigates OpenAI…"
 * on OpenAI's. When one of these is named first, the story has no allowlisted
 * subject and only the strict path 3 can apply.
 */
const OTHER_SUBJECTS = /\b(deepseek|moonshot|kimi|baidu|ernie|tencent|hunyuan|bytedance|tiktok|zhipu|minimax|iflytek|sensetime|xiaomi|cohere|ai21|inflection|character\.ai|thinking machines|safe superintelligence|scale ai|databricks|snowflake|salesforce|ibm|intel|amd|qualcomm|tsmc|oracle|softbank|coreweave|palantir|ftc|doj|sec|fcc|eu|european (commission|union)|congress|senate|white house|pentagon|supreme court|court|judge|lawsuit|regulators?|uk|china|india|japan|california|trump)\b/i;

const MAIN_VERB = /\b(launch(es|ed)?|release[sd]?|unveil(s|ed)?|announce[sd]?|introduce[sd]?|debut(s|ed)?|add(s|ed)?|bring(s)?|brought|partner(s|ed)?|team(s|ed)? up|sue[sd]?|buy(s)?|bought|acquire[sd]?|rais(es|ed)|hire[sd]?|ship(s|ped)?|roll(s|ed)? out|open(s|ed)?|build(s)?|beat(s)?|rival(s)?|replace[sd]?|tests?|testing|begins?|expands?|cuts?|wins?|signs?)\b/i;

/** The subject company: the one named FIRST in the headline; else the one whose official post the story carries. */
export function companyFor(headline: string, blogs: BlogSrc[]): Company | null {
  let best: Company | null = null;
  let bestAt = Infinity;
  for (const c of OFFICIAL_COMPANIES) {
    const m = c.match.exec(headline);
    if (m && m.index < bestAt) { best = c; bestAt = m.index; }
  }
  const other = OTHER_SUBJECTS.exec(headline);
  // A JOINT subject counts: "DeepSeek and Huawei Partner to…" is Huawei's story
  // too. Only a bare conjunction between the two names — "FTC Investigates
  // OpenAI" still has the FTC as its subject.
  const joint = !!other && !!best && /^\s*(and|&|,|with|\+)\s*$/i.test(headline.slice(other.index + other[0].length, bestAt));
  if (other && other.index < bestAt && !joint) return null;
  // The subject comes before the main verb: "DoorDash Launches … in Apple
  // Messages" is DoorDash's story, not Apple's.
  const verb = MAIN_VERB.exec(headline);
  if (best && verb && verb.index < bestAt) return null;
  if (best) return best;
  for (const b of blogs.filter((x) => x.isOfficial)) {
    const host = hostOf(b.url);
    const c = OFFICIAL_COMPANIES.find((co) => onDomain(host, co.domains) || co.match.test(b.company || ""));
    if (c) return c;
  }
  return null;
}

const STOP = new Set(`a an the and or of to in on for with from by at as is are was be its it this that these those new now says say said report reports
reportedly amid after over into out up via vs about more most than just how why what who when where will can could may might has have had
launch launches launched launching release releases released unveil unveils unveiled announce announces announced introduce introduces
introduced debut debuts rolls rolling roll expands expand adds add brings bring gets get makes make takes take ai artificial intelligence
model models company companies tech big first latest next update updates week today plans plan says set sets`.split(/\s+/));

/** Distinctive words from the headline — the product/model names a matching video title would carry. */
export function storyKeywords(headline: string, company: Company | null): string[] {
  const companyWords = new Set((company?.name ?? "").toLowerCase().split(/\s+/));
  const words = headline.toLowerCase().replace(/[“”"'’()[\]:,!?]/g, " ").split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9+]+$/g, ""))
    .filter((w) => w && !STOP.has(w) && !companyWords.has(w) && !/^(19|20)\d\d$/.test(w) && !/^\d$/.test(w) && (w.length >= 3 || /\d/.test(w)));
  return [...new Set(words)];
}

/* ── news outlets: never a source of footage ───────────────────────────────── */

/**
 * ⚠️ OUTLET FOOTAGE IS NEVER PICKED (Jake 2026-10-01: "I would rather not have
 * a CNBC video"). This list only orders which articles are read first — a big
 * outlet's article often embeds the COMPANY's trailer, which counts when its
 * channel is the company's. It briefly was a second tier; that is gone.
 *
 * Channel ids verified 2026-10-01 like the companies' (and two traps again:
 * `@BloombergTelevision` is a Korean family vlog, `@techreview` is "Tech
 * Reviews"; the real ones are `@business` and `@technologyreview`). `cdn`
 * tokens match an outlet's own CDN host (CNBC serves from
 * pdl-iphone-cnbc-com.akamaized.net); a generic player CDN (JW Player) never
 * counts as the outlet.
 */
interface Outlet { name: string; domains: string[]; cdn: string[]; channels: OfficialChannel[] }
export const OUTLETS: Outlet[] = [
  { name: "Reuters", domains: ["reuters.com"], cdn: ["reuters"], channels: [{ handle: "Reuters", id: "UChqUTb7kYRX8-EiaN3XFrSQ" }] },
  { name: "Bloomberg", domains: ["bloomberg.com"], cdn: ["bloomberg"], channels: [{ handle: "business", id: "UCUMZ7gohGI9HcU9VNsr2FJQ" }] },
  { name: "Associated Press", domains: ["apnews.com"], cdn: ["apnews"], channels: [{ handle: "AssociatedPress", id: "UC52X5wxOL_s5yw0dQk7NtgA" }] },
  { name: "The New York Times", domains: ["nytimes.com", "nyt.com"], cdn: ["nytimes", "nyt"], channels: [{ handle: "nytimes", id: "UCqnbDFdCpuN8CMEg0VuEBqA" }] },
  { name: "WSJ", domains: ["wsj.com", "wsj.net"], cdn: ["wsj"], channels: [{ handle: "wsj", id: "UCK7tptUDHh-RYDsdxO1-5QQ" }] },
  { name: "Financial Times", domains: ["ft.com"], cdn: [], channels: [{ handle: "FinancialTimes", id: "UCoUxsWakJucWg46KW5RsvPw" }] },
  { name: "The Washington Post", domains: ["washingtonpost.com"], cdn: ["washingtonpost", "wapo"], channels: [{ handle: "WashingtonPost", id: "UCHd62-u_v4DvJ8TCFtpi4GA" }] },
  { name: "BBC", domains: ["bbc.com", "bbc.co.uk", "bbci.co.uk"], cdn: ["bbc"], channels: [{ handle: "BBCNews", id: "UC16niRr50-MSBwiO3YDb3RA" }] },
  { name: "CNBC", domains: ["cnbc.com", "cnbcfm.com"], cdn: ["cnbc"], channels: [{ handle: "CNBC", id: "UCvJJ_dzjViJCoLf5uKUTwoA" }, { handle: "CNBCtelevision", id: "UCrp_UI8XtuYfpiqluWLD7Lw" }] },
  { name: "The Guardian", domains: ["theguardian.com", "guim.co.uk"], cdn: ["guim", "guardian"], channels: [{ handle: "guardiannews", id: "UCIRYBXDze5krPDzAEOxFGVA" }] },
  { name: "The Verge", domains: ["theverge.com"], cdn: ["theverge"], channels: [{ handle: "TheVerge", id: "UCddiUEpeqJcYeBxX1IVBKvQ" }] },
  { name: "TechCrunch", domains: ["techcrunch.com"], cdn: ["techcrunch"], channels: [{ handle: "TechCrunch", id: "UCCjyq_K1Xwfg8Lndy7lKMpA" }] },
  { name: "Wired", domains: ["wired.com"], cdn: ["wired"], channels: [{ handle: "WIRED", id: "UCftwRNsjfRo08xYE31tkiyw" }] },
  { name: "Axios", domains: ["axios.com"], cdn: ["axios"], channels: [{ handle: "axios", id: "UCfU4-ArXuSX0tpyApyklMAg" }] },
  { name: "CNET", domains: ["cnet.com"], cdn: ["cnet"], channels: [{ handle: "CNET", id: "UCOmcA3f_RrH6b9NmcNa4tdg" }] },
  { name: "Ars Technica", domains: ["arstechnica.com"], cdn: ["arstechnica"], channels: [{ handle: "arstechnica", id: "UCCDU1fsmgvWljcW2aodfJsA" }] },
  { name: "Business Insider", domains: ["businessinsider.com"], cdn: ["businessinsider", "insider"], channels: [{ handle: "BusinessInsider", id: "UCcyq283he07B7_KUX07mmtA" }] },
  { name: "Fortune", domains: ["fortune.com"], cdn: ["fortune"], channels: [{ handle: "Fortune", id: "UCP2gdh7HfjgCoi8lO50dA5w" }] },
  { name: "Engadget", domains: ["engadget.com"], cdn: ["engadget"], channels: [{ handle: "engadget", id: "UC-6OW5aJYBFM33zXQlBKPNA" }] },
  { name: "MIT Technology Review", domains: ["technologyreview.com"], cdn: ["technologyreview"], channels: [{ handle: "TechnologyReview", id: "UCgy4Mf_tlZGqesYNqPNxjPw" }] },
  { name: "IEEE Spectrum", domains: ["spectrum.ieee.org"], cdn: ["ieee"], channels: [{ handle: "IEEESpectrum", id: "UCFQDtftsHGzSh1-TReNT4lA" }] },
  { name: "9to5Mac", domains: ["9to5mac.com"], cdn: ["9to5mac"], channels: [{ handle: "9to5mac", id: "UChjRM_qQAaOAiLNbOGbYcRA" }] },
  { name: "9to5Google", domains: ["9to5google.com"], cdn: ["9to5google"], channels: [{ handle: "9to5google", id: "UCzIO0iX4yKW2P4NkmmKq1PA" }] },
  { name: "Yahoo Finance", domains: ["finance.yahoo.com"], cdn: [], channels: [{ handle: "YahooFinance", id: "UCEAZeUIeJs0IjQiqTCdVSIg" }] },
  { name: "The Information", domains: ["theinformation.com"], cdn: [], channels: [{ handle: "theinformation", id: "UCoKqUtcUtf8QPb0GWxe5e7Q" }] },
  { name: "Semafor", domains: ["semafor.com"], cdn: ["semafor"], channels: [{ handle: "semafor", id: "UCtB4ylCuQW0ue8ACIsHmD1w" }] },
];
const outletFor = (url: string): Outlet | undefined => { const h = hostOf(url); return OUTLETS.find((o) => onDomain(h, o.domains)); };

/* ── every kind of video a page can carry ─────────────────────────────────── */

export type VideoKind = "youtube" | "vimeo" | "file";
/** official = the launch video for THIS news · product = the company's own demo/marketing video of the product · manual = set by Jake. */
export type VideoTier = "official" | "product" | "manual";

interface PageMedia {
  youtube: string[];
  vimeo: { id: string; h?: string; label: string }[];
  /** Direct files (mp4/webm). `fromMarkup`: a real <video>/<source>/JSON-LD/og tag, not a URL found in a script blob. */
  files: { url: string; label: string; fromMarkup: boolean }[];
}

/** Script blobs escape their URLs ("https://…", "https:\/\/…"); undo that before matching. */
const unescapeJs = (s: string) => s.replace(/\\u002F/gi, "/").replace(/\\u0026/gi, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&");

/** The human description sitting next to a media reference (alt text, aria-label, title, caption). */
function labelNear(html: string, at: number): string {
  const win = html.slice(Math.max(0, at - 700), at + 400);
  const m = /(?:altText|alt|aria-label|title|caption|videoTitle|description)["']?\s*[:=]\s*["']([^"'<>]{8,200})["']/i.exec(win);
  return m ? m[1].trim() : "";
}

const FILE_RE = /\.(mp4|webm|mov|m4v)(\?|$)/i;

/**
 * YouTube, Vimeo, and direct files: <video>/<source>, JSON-LD VideoObject,
 * og:video / twitter:player(:stream). HLS (.m3u8) is skipped on purpose —
 * desktop Chrome has no native HLS, so a stream URL would play nowhere.
 */
export function scanPage(raw: string, pageUrl: string, official: boolean): PageMedia {
  const html = unescapeJs(raw);
  const abs = (u: string) => { try { return new URL(u.trim(), pageUrl).toString(); } catch { return ""; } };
  const out: PageMedia = { youtube: extractYouTubeIds(html), vimeo: [], files: [] };
  const files = new Map<string, { url: string; label: string; fromMarkup: boolean }>();
  const addFile = (u: string, label: string, fromMarkup: boolean) => {
    const url = abs(u);
    if (!url || !FILE_RE.test(new URL(url).pathname + (url.includes("?") ? "?" : ""))) return;
    const prev = files.get(url);
    if (!prev || (!prev.label && label) || (!prev.fromMarkup && fromMarkup)) files.set(url, { url, label: label || prev?.label || "", fromMarkup: fromMarkup || !!prev?.fromMarkup });
  };
  const vimeos = new Map<string, { id: string; h?: string; label: string }>();
  const addVimeo = (id: string, h: string | undefined, label: string) => {
    const prev = vimeos.get(id);
    vimeos.set(id, { id, h: h || prev?.h, label: prev?.label || label });
  };

  // <video …> and its <source>s
  for (const m of html.matchAll(/<video\b([^>]*)>([\s\S]{0,2000}?)<\/video>|<video\b([^>]*)\/>/gi)) {
    const attrs = m[1] ?? m[3] ?? "";
    const label = (/aria-label=["']([^"']+)/i.exec(attrs)?.[1] || /title=["']([^"']+)/i.exec(attrs)?.[1] || labelNear(html, m.index ?? 0)).trim();
    const src = /\ssrc=["']([^"']+)/i.exec(attrs)?.[1];
    if (src) addFile(src, label, true);
    for (const s of (m[2] ?? "").matchAll(/<source\b[^>]*src=["']([^"']+)["']/gi)) addFile(s[1], label, true);
  }
  // og:video / twitter:player
  for (const m of html.matchAll(/<meta\b[^>]*(?:property|name)=["'](og:video(?::url|:secure_url)?|twitter:player(?::stream)?)["'][^>]*>/gi)) {
    const content = /content=["']([^"']+)/i.exec(m[0])?.[1];
    if (!content) continue;
    const title = /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i.exec(html)?.[1] ?? "";
    if (FILE_RE.test(content)) addFile(content, title, true);
    const yt = extractYouTubeIds(content);
    if (yt.length) out.youtube.push(...yt);
    const vm = /player\.vimeo\.com\/video\/(\d+)(?:[^"'\s]*?[?&]h=([0-9a-f]+))?/.exec(content);
    if (vm) addVimeo(vm[1], vm[2], title);
  }
  // JSON-LD VideoObject
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const walk = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const type = node["@type"];
      if (type === "VideoObject" || (Array.isArray(type) && type.includes("VideoObject"))) {
        const label = [node.name, node.description].filter(Boolean).join(" — ").slice(0, 400);
        if (typeof node.contentUrl === "string" && FILE_RE.test(node.contentUrl)) addFile(node.contentUrl, label, true);
        if (typeof node.embedUrl === "string") {
          const yt = extractYouTubeIds(node.embedUrl);
          if (yt.length) out.youtube.push(...yt);
          const vm = /player\.vimeo\.com\/video\/(\d+)(?:[^"'\s]*?[?&]h=([0-9a-f]+))?/.exec(node.embedUrl);
          if (vm) addVimeo(vm[1], vm[2], label);
        }
      }
      for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
    };
    walk(data);
  }
  // Vimeo players/links anywhere (OpenAI's launch posts embed Vimeo, with the
  // `h` hash that makes an unlisted video playable — measured: it plays from any origin).
  for (const m of html.matchAll(/player\.vimeo\.com\/video\/(\d{6,})(?:\?h=([0-9a-f]{6,})|[^"'\s<>]*?[?&]h=([0-9a-f]{6,}))?/g)) {
    addVimeo(m[1], m[2] || m[3], labelNear(html, m.index ?? 0));
  }
  for (const m of html.matchAll(/(?<!player\.)vimeo\.com\/(\d{6,})(?:\/([0-9a-f]{8,}))?/g)) addVimeo(m[1], m[2], labelNear(html, m.index ?? 0));
  // On the company's OWN page, a file URL inside its page data is its own media
  // too (Next.js pages ship them in JSON, not <video> tags). Not on outlet
  // pages: there, script blobs are where "latest videos" carousels live.
  if (official) {
    for (const m of html.matchAll(/https?:\/\/[^"'\s<>()\\]+?\.(?:mp4|webm|mov|m4v)(?:\?[^"'\s<>()\\]*)?/gi)) addFile(m[0], labelNear(html, m.index ?? 0), false);
  }
  out.youtube = [...new Set(out.youtube)];
  out.vimeo = [...vimeos.values()];
  out.files = [...files.values()];
  return out;
}

/* ── checking a Vimeo video / a direct file before it can go on air ───────── */

interface ProbedMedia {
  title: string;
  description: string;
  author: string;
  seconds: number;
  width: number;
  height: number;
  publishedAt: string;
  url: string;
  proxy: boolean;
}

/** Vimeo oEmbed: title, author, duration, size — and a 200 means it is embeddable. */
async function probeVimeo(id: string, h: string | undefined): Promise<ProbedMedia | null> {
  const player = `https://player.vimeo.com/video/${id}${h ? `?h=${h}` : ""}`;
  try {
    const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(player)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    return {
      title: String(j.title ?? ""), description: String(j.description ?? "").slice(0, 600), author: String(j.author_name ?? ""),
      seconds: Number(j.duration ?? 0), width: Number(j.width ?? 0), height: Number(j.height ?? 0),
      publishedAt: String(j.upload_date ?? ""), url: player, proxy: false,
    };
  } catch {
    return null;
  }
}

const LAB_ORIGIN = (process.env.PUBLIC_BASE_URL || "https://lab.jakedaw.com").replace(/\/+$/, "");

/** One small ranged GET: does this URL serve a video, and how big is it? */
async function rangeProbe(url: string, referer: string | null): Promise<{ ok: boolean; type: string; size: number }> {
  try {
    const headers: Record<string, string> = { "User-Agent": UA, Range: "bytes=0-1023" };
    if (referer) headers.Referer = referer;
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(12000) });
    const type = (res.headers.get("content-type") || "").toLowerCase();
    const range = res.headers.get("content-range");
    const size = range ? Number(range.split("/")[1] || 0) : Number(res.headers.get("content-length") || 0);
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { ok: res.status === 200 || res.status === 206, type, size };
  } catch {
    return { ok: false, type: "", size: 0 };
  }
}

/** Duration and frame size, read by ffprobe straight from the URL (it only reads what it needs). */
async function ffprobe(url: string, referer: string | null): Promise<{ seconds: number; width: number; height: number } | null> {
  const { execFile } = await import("node:child_process");
  const args = ["-v", "error", "-print_format", "json", "-show_entries", "format=duration:stream=width,height,codec_type", "-user_agent", UA];
  if (referer) args.push("-headers", `Referer: ${referer}\r\n`);
  args.push(url);
  return new Promise((resolve) => {
    execFile("ffprobe", args, { timeout: 25000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        const v = (j.streams ?? []).find((s: any) => s.codec_type === "video" && s.width);
        resolve({ seconds: Math.round(Number(j.format?.duration ?? 0)), width: Number(v?.width ?? 0), height: Number(v?.height ?? 0) });
      } catch { resolve(null); }
    });
  });
}

/**
 * A direct file, held to Jake's rules: reachable, a video content-type, not a
 * tiny loop (≥300 KB, ≥5 s, no icon/logo/loader in the name), landscape.
 * ⚠️ HOTLINKING: the display page requests it with the Lab as Referer; when
 * the CDN refuses that (or only serves its own site), the file is marked for
 * the Lab's streaming proxy (`/api/news/video-file/<slide>`).
 */
export async function probeFile(url: string): Promise<(ProbedMedia & { reject?: string }) | null> {
  let path = "";
  try { path = new URL(url).pathname; } catch { return null; }
  const base: ProbedMedia = { title: "", description: "", author: hostOf(url), seconds: 0, width: 0, height: 0, publishedAt: "", url, proxy: false };
  if (/icon|logo|loader|spinner|favicon|avatar|emoji/i.test(path)) return { ...base, reject: "an icon/logo/loader file" };
  let plain = await rangeProbe(url, null);
  let referer: string | null = null;
  if (!plain.ok) {
    // Some CDNs only serve their own site: try once as the site itself, then proxy.
    referer = `https://${hostOf(url)}/`;
    plain = await rangeProbe(url, referer);
    if (!plain.ok) return { ...base, reject: "not reachable" };
    base.proxy = true;
  }
  if (!plain.type.startsWith("video/") && !(plain.type === "application/octet-stream" && FILE_RE.test(path))) return { ...base, reject: `not a video (${plain.type || "no type"})` };
  if (plain.size && plain.size < 300_000) return { ...base, reject: `too small (${Math.round(plain.size / 1024)} KB)` };
  if (!base.proxy) {
    const fromLab = await rangeProbe(url, `${LAB_ORIGIN}/news-gatherer/present/audience`);
    if (!fromLab.ok) base.proxy = true;
  }
  const meta = await ffprobe(url, referer);
  if (!meta || !meta.width) return { ...base, reject: "unreadable" };
  return { ...base, seconds: meta.seconds, width: meta.width, height: meta.height };
}

/** Mechanical rejections for Vimeo/file media (YouTube has hardReject). */
function mediaReject(p: ProbedMedia): string {
  if (p.seconds && p.seconds < 5) return "shorter than 5 seconds";
  if (p.seconds > 15 * 60) return "longer than 15 minutes";
  if (p.width && p.height && p.width / p.height < 1.3) return p.width < p.height ? "vertical" : "not landscape (square loop?)";
  return "";
}

/* ── the pick ─────────────────────────────────────────────────────────────── */

export interface VideoCandidateSummary {
  key: string;
  kind: VideoKind;
  tier: VideoTier;
  title: string;
  channel: string;
  seconds: number;
  publishedAt: string;
  source: string;
}

export interface VideoResult {
  /** YouTube id (kind youtube only). */
  videoId: string | null;
  kind?: VideoKind;
  /** Vimeo player URL (with its hash) or the direct file URL. */
  url?: string;
  tier?: VideoTier;
  /** A file whose CDN refuses the Lab as referer — served through the Lab's proxy. */
  proxy?: boolean;
  title?: string;
  channel?: string;
  reason: string;
  /** False when the lookup could not run — nothing is cached then. */
  checked: boolean;
  units: number;
  candidates: VideoCandidateSummary[];
}

/** Anything that can go on screen, whatever it came from. */
interface Cand {
  key: string;
  kind: VideoKind;
  tier: "official" | "product";
  videoId?: string;
  url?: string;
  proxy?: boolean;
  title: string;
  description: string;
  channel: string;
  publishedAt: string;
  seconds: number;
  views?: number;
  sources: Set<string>;
}

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const KIND_LABEL: Record<VideoKind, string> = { youtube: "YouTube", vimeo: "Vimeo", file: "video file" };

async function judge(story: StoryRecord, company: string, tier: "official" | "product", cands: Cand[], product = ""): Promise<{ index: number | null; reason: string }> {
  const list = cands.map((c, i) =>
    `[${i + 1}] ${KIND_LABEL[c.kind]} · ${c.channel}
    title: ${c.title || "(none)"}
    found on: ${[...c.sources].join("; ")}
    ${c.publishedAt ? `published: ${c.publishedAt.slice(0, 10)} · ` : ""}duration ${c.seconds ? fmtDur(c.seconds) : "unknown"}${c.views ? ` · ${c.views.toLocaleString("en-US")} views` : ""}
    description: ${(c.description || "").replace(/\s+/g, " ").slice(0, 500) || "(none)"}`).join("\n\n");
  const rules = tier === "official"
    ? `CANDIDATES (all from ${company}'s own channels, or on ${company}'s own pages):
${list}

RULES:
- Pick ONLY a video that is the company's own release, launch, marketing or demo video for THIS exact news (same product/model/feature/event). Prefer a polished launch trailer or product demo.
- A video about a different product, an earlier version, a different announcement, or a general brand ad is NOT a match — even from the same company in the same week.
- When one candidate is specifically about the story's product (e.g. "Meet <product>", "Introducing <product>", a launch film named after it), pick it over an event recap or keynote highlight reel that covers many announcements.
- A file or Vimeo video embedded on the company's announcement page for this news counts as its launch video unless it is plainly decorative (an abstract background loop, a logo animation, a UI micro-clip of a few seconds).
- Never pick: livestreams or event replays, keynotes over 15 minutes, interviews, podcasts, panels, earnings calls, customer testimonials, tutorials/how-tos, recruiting videos, Shorts.
- If the story is not about something the company released or showed (a lawsuit, an investigation, a leak, an IPO, a funding round, a security incident, a rumor), answer none unless a candidate is unmistakably the company's own video about that exact event.
- Prefer 20 seconds to 6 minutes, but a short official launch teaser is fine when it is the release video. When two fit, take the one that looks most impressive on a big screen (product footage over talking heads). The same film on YouTube and Vimeo: either is fine.`
    : `There is no launch video for this exact news, so the show falls back to ${company}'s own DEMO or MARKETING video of the product the story is about: ${product}.
CANDIDATES (all from ${company}'s own verified channels or pages, newest first):
${list}

RULES:
- Pick ONLY ${company}'s own demo or marketing video that SHOWS ${product} itself: product footage, a demo of it working, a polished launch/brand film for it. Any recent version of ${product} counts (an earlier model's launch film is fine).
- Prefer a flagship launch film or product demo of ${product} itself (e.g. "Introducing <product/model>", "Meet <product>") over a niche enterprise/B2B use-case clip, a single-feature tip, or a customer story.
- Among those, prefer the most recent, and the one that looks most impressive on a big screen (real product footage, not slides).
- Never pick: a talking head, keynote, livestream or event replay/recap, interview, podcast, panel, earnings call, customer testimonial or case study, Short, tutorial/how-to/webinar, recruiting video, or a video about a different product.
- 20 seconds to 6 minutes is ideal.
- When in doubt, answer none.`;
  const prompt = `A live AI news show plays a video full screen behind the presenter while he talks about a story. Pick that video from the candidates below, or pick none.

STORY HEADLINE: ${story.headline}
STORY SUMMARY: ${(story.summary || "").slice(0, 1200)}
STORY FIRST SEEN: ${(story.firstSeenAt || "").slice(0, 10)}
COMPANY: ${company}

${rules}
- The video plays MUTED, with no captions, behind the presenter. It has to tell its story with pictures: product footage, the UI working, a demo, robots moving, a cinematic film that cuts between scenes. A video that is mostly one person talking to camera, an interview, a podcast, a stage keynote or a narrated explainer over a speaker is useless muted — pass on it, even when it is the official launch video.
- When unsure, answer none. No video is better than the wrong one.

Reply with ONLY this JSON: {"pick": <candidate number> or null, "reason": "<one short sentence>"}`;
  const text = await callNewsModel(prompt, "news-video", "research");
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { index: null, reason: "Model gave no answer — no video." };
  let parsed: { pick?: number | string | null; reason?: string };
  try { parsed = JSON.parse(m[0]); } catch {
    // A stray quote or newline in the reason breaks JSON.parse; the pick itself is still readable.
    const pm = /"pick"\s*:\s*(null|"?\d+"?)/.exec(m[0]);
    if (!pm) return { index: null, reason: "Model answer unreadable — no video." };
    parsed = { pick: pm[1] === "null" ? null : pm[1].replace(/"/g, ""), reason: /"reason"\s*:\s*"([^"\n]{0,300})/.exec(m[0])?.[1] ?? "" };
  }
  const n = parsed.pick === null || parsed.pick === undefined ? NaN : Number(parsed.pick);
  const reason = String(parsed.reason || "").slice(0, 300);
  if (!Number.isInteger(n)) return { index: null, reason: reason || "No video for this story." };
  if (n < 1 || n > cands.length) return { index: null, reason: `Model named a candidate that does not exist — no video. (${reason})` };
  return { index: n - 1, reason: reason || "Release video." };
}

function parseJson<T>(s: string | undefined, fallback: T): T {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}

/* ── fit for a MUTED screen ───────────────────────────────────────────────── */

/**
 * Jake (2026-10-01), after the Anthropic slide played "just a person talking
 * with no captions": the video runs MUTED behind him, so it must carry the
 * story in pictures. Target visual, not narration-heavy videos — never one
 * person speaking without cutting away.
 *
 * ⚠️ TITLES CANNOT TELL YOU THIS. "Introducing Claude Fable 5.1" reads like a
 * launch film and is one man talking in one shot for its whole length. The
 * only reliable signal is the picture, so the judge LOOKS: YouTube serves
 * three frames from every public video at ~25/50/75% (`maxres1-3.jpg`, or
 * `hq1-3.jpg`) plus the uploader's thumbnail, and a vision model reads them.
 *
 * ⚠️ THREE FRAMES OF FACES IS NOT A TALKING HEAD. OpenAI's "Introducing dots"
 * film shows a face in two of its three frames — but two different women in
 * two different rooms: it CUTS. The tell is the same person in the same setup
 * every time, with nothing else on screen. The storyboard (dozens of frames)
 * would be better still, but YouTube serves it only to signed-in clients from
 * this server's IP (watch page and youtubei player both answer LOGIN_REQUIRED).
 *
 * Cached forever per video in `news_video_fit` (bump FIT_ALGO to re-judge).
 * Vimeo/file candidates are not frame-checked: they come from the company's
 * own announcement pages, where the embedded clip is product footage.
 */
const FIT_ALGO = 2; // +1 2026-10-01: an edited film that cuts between people is a fit (Dots was wrongly "interview")

async function frameB64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok || !/image\//.test(res.headers.get("content-type") || "")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 1500 ? buf.toString("base64") : null;
  } catch {
    return null;
  }
}

/** The frames a vision model can see: three from inside the video + the thumbnail. */
async function videoFrames(videoId: string): Promise<LabeledImage[]> {
  const base = `https://i.ytimg.com/vi/${videoId}`;
  const pos = ["about 25%", "about 50%", "about 75%"];
  const frames = await Promise.all([1, 2, 3].map(async (n) => (await frameB64(`${base}/maxres${n}.jpg`)) ?? (await frameB64(`${base}/hq${n}.jpg`))));
  const out: LabeledImage[] = [];
  frames.forEach((data, i) => { if (data) out.push({ label: `Frame ${i + 1} — from ${pos[i]} of the way through the video:`, data, mediaType: "image/jpeg" }); });
  const thumb = await frameB64(`${base}/hqdefault.jpg`);
  if (thumb) out.push({ label: "The uploader's chosen thumbnail (designed to attract clicks — may not show what plays):", data: thumb, mediaType: "image/jpeg" });
  return out;
}

/** Whether `c` works full screen, muted, behind the presenter. Never throws. */
async function muteFit(c: Cand): Promise<{ ok: boolean; reason: string }> {
  if (c.kind !== "youtube" || !c.videoId) return { ok: true, reason: "not frame-checked (not on YouTube)" };
  const row = db.prepare(`SELECT fit, shot, reason FROM news_video_fit WHERE video_id = ? AND algo = ?`).get(c.videoId, FIT_ALGO) as { fit: number; shot: string; reason: string } | undefined;
  if (row) return { ok: row.fit === 1, reason: row.reason || row.shot || "" };

  const images = await videoFrames(c.videoId);
  // Without frames there is nothing to judge — let it through rather than lose every video to a CDN hiccup. Not cached.
  if (images.filter((im) => im.label.startsWith("Frame")).length < 2) return { ok: true, reason: "not frame-checked (frames unavailable)" };
  let verdict: { fit?: boolean; shot?: string; reason?: string };
  try {
    const text = await claudeVisionLabeledJSON({
      purpose: "news-video",
      system: "You check whether a video works as a silent, full-screen background on a live AI news show. You judge only from the frames you are shown. Reply in the exact JSON requested.",
      images,
      userText: `A live AI news show plays this video MUTED, with NO captions, full screen behind the presenter for 30–90 seconds while he talks about the story. Nobody will hear a word of it.

VIDEO: "${c.title}" · ${c.channel} · ${c.seconds ? fmtDur(c.seconds) : "unknown length"}
DESCRIPTION: ${(c.description || "").replace(/\s+/g, " ").slice(0, 400) || "(none)"}

Look at the three frames from inside the video (the thumbnail is the uploader's pick and often unrepresentative — trust the frames).

NOT A FIT (fit=false):
- A talking head: the SAME person in the SAME setup/framing in the frames, speaking to camera or to an off-screen interviewer, with nothing else to look at. This is the main thing to catch.
- An interview, podcast, panel or conversation where the frames stay on the SAME seated setup (same room, same framing) — people talking with nothing else to look at.
- A stage keynote or presentation: a speaker on a stage, or slides of text.
- A screen of mostly text, or a static logo/title card in every frame.

A FIT (fit=true):
- Product footage, the app/UI in use, screen recordings, demos.
- Robots, hardware, devices, places, things happening.
- A cinematic or marketing film that CUTS between different scenes — different people, rooms or shots across the frames — even if people appear in it.
- Motion graphics or animation that shows what the product does.

When the frames mix a speaker with product footage or other scenes, it cuts away — that is a fit.
A produced launch film that cuts between DIFFERENT people, rooms or shots (e.g. a close-up of one person, then someone else somewhere else) is edited footage, not a talking head — that is a fit, even if every frame happens to show a person. Only reject when the frames look like one continuous setup. (Jake's rule: reject "one person speaking without cutting away".)

Reply with ONLY this JSON: {"fit": true or false, "shot": "talking head" | "interview" | "keynote" | "text/slides" | "product footage" | "demo/UI" | "cinematic film" | "b-roll" | "animation" | "mixed", "reason": "<one short sentence about what the frames show>"}`,
    });
    verdict = JSON.parse(text);
  } catch (err) {
    console.warn(`[news-video] fit check failed for ${c.videoId}:`, err);
    return { ok: true, reason: "not frame-checked (vision check failed)" };
  }
  const ok = verdict.fit === true;
  const reason = `${String(verdict.shot || "").slice(0, 40)}${verdict.reason ? `: ${String(verdict.reason).slice(0, 200)}` : ""}` || (ok ? "visual" : "not visual");
  db.prepare(`INSERT INTO news_video_fit (video_id, fit, shot, reason, algo, checked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET fit = excluded.fit, shot = excluded.shot, reason = excluded.reason, algo = excluded.algo, checked_at = excluded.checked_at`)
    .run(c.videoId, ok ? 1 : 0, String(verdict.shot || ""), reason, FIT_ALGO, Date.now());
  console.log(`[news-video] fit ${ok ? "✓" : "✗"} ${c.videoId} "${c.title}" — ${reason}`);
  return { ok, reason };
}

/** A cached "not a fit", without spending anything. */
function knownUnfit(c: Cand): string | null {
  if (c.kind !== "youtube" || !c.videoId) return null;
  const row = db.prepare(`SELECT fit, reason FROM news_video_fit WHERE video_id = ? AND algo = ?`).get(c.videoId, FIT_ALGO) as { fit: number; reason: string } | undefined;
  return row && row.fit === 0 ? row.reason || "not visual" : null;
}

/**
 * The model's pick, then the muted-screen check on it; a pick that fails is
 * removed and the model asked again (at most three rounds). Candidates already
 * known to fail never reach the model.
 */
async function chooseFitting(story: StoryRecord, company: string, tier: "official" | "product", pool: Cand[], ctx: Ctx, product = ""):
  Promise<{ pick: Cand | null; reason: string }> {
  let list = pool.filter((c) => {
    const bad = knownUnfit(c);
    if (bad) (ctx.fitRejected ??= []).push(`"${c.title}" (${bad})`);
    return !bad;
  });
  let last = "";
  for (let round = 0; round < 3 && list.length; round++) {
    const v = await judge(story, company, tier, list, product);
    if (v.index === null) return { pick: null, reason: v.reason };
    const c = list[v.index];
    const fit = await muteFit(c);
    if (fit.ok) return { pick: c, reason: v.reason };
    (ctx.fitRejected ??= []).push(`"${c.title}" (${fit.reason})`);
    last = `"${c.title}" does not work muted (${fit.reason}).`;
    list = list.filter((x) => x !== c);
  }
  return { pick: null, reason: last || "No candidate works on a muted screen." };
}

/** One identity for a video, whatever it came from: `yt:<id>` or `url:<player/file url>`. */
export function videoKey(r: { videoId?: string | null; url?: string | null } | null | undefined): string {
  if (!r) return "";
  if (r.videoId) return `yt:${r.videoId}`;
  if (r.url) return `url:${r.url}`;
  return "";
}

/** The whole search for one story. Never throws: a failure is a result with no video.
 *  `exclude` = videos other slides of the same deck already show (see `uniqueVideos`). */
export async function findVideoForStory(story: StoryRecord, opts: { force?: boolean; exclude?: Set<string> } = {}): Promise<VideoResult> {
  const ctx: Ctx = { units: 0, searches: 0, exclude: opts.exclude, dupSkipped: 0, fitRejected: [] };
  const none = (reason: string, checked = true): VideoResult => ({ videoId: null, reason, checked, units: ctx.units, candidates: [] });

  if (!opts.force && story.id) {
    const row = db.prepare(`SELECT * FROM news_video_picks WHERE story_id = ?`).get(story.id) as any;
    const cachedKey = videoKey({ videoId: row?.video_id, url: row?.video_url });
    const clash = !!cachedKey && !!opts.exclude?.has(cachedKey);
    if (row && (row.manual || (!clash && row.algo === PICK_ALGO && row.video_tier !== "outlet" && Date.now() - row.checked_at < 12 * HOUR))) {
      const has = !!(row.video_id || row.video_url);
      return { videoId: row.video_id ?? null, kind: has ? (row.video_kind || "youtube") : undefined, url: row.video_url ?? undefined,
        tier: row.video_tier ?? undefined, proxy: !!row.video_proxy, title: row.video_title ?? undefined, channel: row.video_channel ?? undefined,
        reason: row.reason ?? "", checked: true, units: 0, candidates: parseJson(row.candidates_json, []) };
    }
  }

  let result: VideoResult;
  try {
    result = await search(story, ctx);
  } catch (err) {
    console.warn(`[news-video] "${story.headline}" failed:`, err);
    return none(`Lookup failed: ${err instanceof Error ? err.message : String(err)}`, false);
  }
  result.units = ctx.units;
  if (result.checked && story.id) {
    db.prepare(`INSERT INTO news_video_picks (story_id, video_id, video_title, video_channel, reason, candidates_json, manual, checked_at, video_kind, video_url, video_tier, video_proxy, algo)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?) ON CONFLICT(story_id) DO UPDATE SET video_id = excluded.video_id, video_title = excluded.video_title,
      video_channel = excluded.video_channel, reason = excluded.reason, candidates_json = excluded.candidates_json, manual = 0, checked_at = excluded.checked_at,
      video_kind = excluded.video_kind, video_url = excluded.video_url, video_tier = excluded.video_tier, video_proxy = excluded.video_proxy, algo = excluded.algo`)
      .run(story.id, result.videoId, result.title ?? null, result.channel ?? null, result.reason, JSON.stringify(result.candidates), Date.now(),
        result.kind ?? null, result.url ?? null, result.tier ?? null, result.proxy ? 1 : 0, PICK_ALGO);
  }
  return result;
}

/** Links on a page that point at the company's own domains, with their anchor text. */
function extractLinks(html: string, base: string, domains: string[]): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*?href=["']([^"'#]+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    let url: string;
    try { url = new URL(m[1].replace(/&amp;/g, "&"), base).toString(); } catch { continue; }
    if (!/^https?:/.test(url) || seen.has(url) || !onDomain(hostOf(url), domains)) continue;
    seen.add(url);
    out.push({ url, text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
  }
  return out;
}

const kwRe = (k: string) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);

/** The links most likely to be THIS launch's page: the most headline keywords in URL + anchor text. */
function launchLinks(links: { url: string; text: string }[], kws: string[], exclude: Set<string>, max: number, minHits: number): string[] {
  return links
    .filter((l) => !exclude.has(l.url))
    .map((l) => {
      let path = l.url;
      try { path = decodeURIComponent(l.url); } catch { /* keep raw */ }
      const hay = (path.replace(/[-_/]+/g, " ") + " " + l.text).toLowerCase();
      return { url: l.url, hits: kws.filter((k) => kwRe(k).test(hay)).length };
    })
    .filter((x) => x.hits >= minHits)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max)
    .map((x) => x.url);
}

function textHits(text: string, kws: string[]): number {
  const hay = text.toLowerCase();
  return kws.filter((k) => kwRe(k).test(hay)).length;
}

const NON_LAUNCH_CATEGORIES = /drama|rumou?r|business|policy/i;
const shortUrl = (u: string) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/$/, "").slice(0, 90); } catch { return u.slice(0, 90); } };

/**
 * Jake (2026-10-01): "usually the company also adds a marketing video on their
 * YouTube channel — it should look at a variety of sources", and "looking at
 * the sources themselves — some of them have a video". Every source below adds
 * to one pool; each video remembers where it was found; then ONE rule decides
 * what may go on screen, by tier:
 *
 *   OFFICIAL — the subject company's own video: on one of its verified YouTube
 *     channels (allowlisted, or for a company not on the list, a channel its
 *     own site links to), or a Vimeo/native file on the company's own pages.
 *   PRODUCT (only when there is no launch video) — the company's own demo or
 *     marketing video of the product the story is about (`productFallback`).
 *   News outlets' own footage is never picked.
 *
 * Sources: the announcement page(s) · product pages it links to · the
 * company's newsroom (→ its post on this launch) · every official channel's
 * uploads in the window (1 unit a page) · search.list on an official channel
 * (only when nothing else matched — 100 units) · the story's own news
 * articles. The company's X posts are not read: x.com serves nothing without
 * a login.
 */
async function search(story: StoryRecord, ctx: Ctx): Promise<VideoResult> {
  const headline = story.headline || "";
  const blogs = parseJson<BlogSrc[]>(story.blogSources, []);
  const articles = parseJson<ArticleSrc[]>(story.articleSources, []);
  const company = companyFor(headline, blogs);
  const direct = (u: string) => !!u && /^https?:/.test(u) && !u.includes("news.google.com");
  const officialBlog = blogs.find((b) => b.isOfficial && direct(b.url));
  const kws = storyKeywords(headline, company);
  const domains = company?.domains ?? (officialBlog ? [hostOf(officialBlog.url).split(".").slice(-2).join(".")] : []);
  const companyName = company?.name ?? officialBlog?.company ?? "";
  const ytOn = !!getYoutubeDataApiKey() && Date.now() >= quotaBlockedUntil;
  let ytNote = ytOn ? "" : (getYoutubeDataApiKey() ? "YouTube quota exhausted" : "no YouTube key");

  const seen = Date.parse(story.firstSeenAt || "") || Date.now();
  const from = new Date(seen - 10 * DAY);
  const to = new Date(Math.min(Date.now(), seen + 10 * DAY));

  /* ── 1. pages ───────────────────────────────────────────────────────────── */
  const officialUrls = new Set<string>();
  for (const b of blogs) if (b.isOfficial && direct(b.url)) officialUrls.add(b.url);
  for (const a of articles) if (direct(a.url) && domains.length && onDomain(hostOf(a.url), domains)) officialUrls.add(a.url);
  const annUrls = [...officialUrls].slice(0, 3);
  const newsroomUrls = (company?.newsroom ?? []).slice(0, 2);
  // The story's own articles, big outlets first — read only for embeds of the COMPANY's videos.
  // Up to 12 are tried and the first 6 that actually load are kept: the biggest
  // outlets are also the likeliest to answer with a sign-in, subscription or bot
  // wall, and a page that comes back empty hides every video it embeds
  // (Jake 2026-10-02: the story with the blocked source also got no video).
  const articleCandidates = articles
    .filter((a) => direct(a.url) && !officialUrls.has(a.url))
    .sort((x, y) => (outletFor(x.url) ? 0 : 1) - (outletFor(y.url) ? 0 : 1))
    .slice(0, 12);
  const [annPages, roomPages, candidatePages] = await Promise.all([
    Promise.all(annUrls.map(fetchPage)),
    Promise.all(newsroomUrls.map(fetchPage)),
    Promise.all(articleCandidates.map((a) => fetchPage(a.url))),
  ]);
  const readable = articleCandidates.map((a, i) => ({ a, html: candidatePages[i] })).filter((x) => x.html.length > 0).slice(0, 6);
  const blockedArticles = articleCandidates.filter((_, i) => !candidatePages[i]).length;
  const outletArticles = readable.map((x) => x.a);
  const newsPages = readable.map((x) => x.html);

  /** Every page that was read, with whose page it is. */
  const pages: { url: string; html: string; owner: "official" | "article"; label: string }[] = [];
  annPages.forEach((html, i) => pages.push({ url: annUrls[i], html, owner: "official", label: "announcement page" }));
  newsPages.forEach((html, i) => pages.push({ url: outletArticles[i].url, html, owner: "article", label: `news article (${outletFor(outletArticles[i].url)?.name ?? outletArticles[i].outlet})` }));
  if (domains.length && kws.length) {
    const exclude = new Set([...officialUrls, ...newsroomUrls]);
    const productUrls = launchLinks(annPages.flatMap((h, i) => extractLinks(h, annUrls[i], domains)), kws, exclude, 2, 1);
    productUrls.forEach((u) => exclude.add(u));
    const roomPostUrls = launchLinks(roomPages.flatMap((h, i) => extractLinks(h, newsroomUrls[i], domains)), kws, exclude, 2, 2);
    const [productPages, roomPosts] = await Promise.all([Promise.all(productUrls.map(fetchPage)), Promise.all(roomPostUrls.map(fetchPage))]);
    productPages.forEach((html, i) => pages.push({ url: productUrls[i], html, owner: "official", label: "product page" }));
    roomPosts.forEach((html, i) => pages.push({ url: roomPostUrls[i], html, owner: "official", label: "newsroom post" }));
  }
  roomPages.forEach((html, i) => pages.push({ url: newsroomUrls[i], html, owner: "official", label: "newsroom" }));

  /** youtube id → sources; vimeo id → {h, label, sources, pages}; file url → {label, sources, page owner, outlet}. */
  const ytFound = new Map<string, { sources: Set<string>; outletPages: Set<Outlet> }>();
  const addYt = (id: string, source: string, outlet?: Outlet) => {
    if (!ytFound.has(id)) ytFound.set(id, { sources: new Set(), outletPages: new Set() });
    const e = ytFound.get(id)!;
    e.sources.add(source);
    if (outlet) e.outletPages.add(outlet);
  };
  const vimeoFound = new Map<string, { h?: string; label: string; sources: Set<string>; official: boolean; outlet?: Outlet }>();
  const fileFound = new Map<string, { label: string; sources: Set<string>; official: boolean; outlet?: Outlet; fromMarkup: boolean }>();
  /** Every file URL each page mentions — the other renditions of a clip (CNBC's JSON-LD names its 534px one). */
  const pageFiles: string[][] = [];
  for (const p of pages) {
    if (!p.html) continue;
    pageFiles.push([...new Set([...unescapeJs(p.html).matchAll(/https?:\/\/[^"'\s<>()\\]+?\.(?:mp4|webm)(?:\?[^"'\s<>()\\]*)?/gi)].map((m) => m[0]))]);
    const outlet = p.owner === "article" ? outletFor(p.url) : undefined;
    const src = `${p.label} ${shortUrl(p.url)}`;
    const media = scanPage(p.html, p.url, p.owner === "official");
    // The newsroom INDEX lists every recent post; its embeds are not about this story by default.
    const indexPage = p.label === "newsroom";
    for (const id of media.youtube) addYt(id, src, outlet);
    for (const v of media.vimeo) {
      const e = vimeoFound.get(v.id) ?? { h: v.h, label: v.label, sources: new Set<string>(), official: false };
      e.h = e.h || v.h; e.label = e.label || v.label; e.sources.add(src);
      if (p.owner === "official" && !indexPage) e.official = true;
      if (outlet) e.outlet = outlet;
      vimeoFound.set(v.id, e);
    }
    for (const f of media.files) {
      if (indexPage) continue;
      const e = fileFound.get(f.url) ?? { label: f.label, sources: new Set<string>(), official: false, fromMarkup: f.fromMarkup };
      e.label = e.label || f.label; e.sources.add(src); e.fromMarkup = e.fromMarkup || f.fromMarkup;
      if (p.owner === "official") e.official = true;
      if (outlet) e.outlet = outlet;
      fileFound.set(f.url, e);
    }
  }

  /* ── 2. the official YouTube channels: uploads first, they are cheap ───── */
  const officialChannels: ResolvedChannel[] = [];
  const uncovered: ResolvedChannel[] = [];
  const ytStep = async (fn: () => Promise<void>) => {
    if (!ytOn || ytNote) return;
    try { await fn(); } catch (err) {
      if (err instanceof VideoQuotaError || err instanceof NoKeyError) { ytNote = err.message; return; }
      throw err;
    }
  };
  await ytStep(async () => {
    if (company) for (const ch of company.channels) {
      const r = await resolveOfficial(ch, company, ctx);
      if (r) officialChannels.push(r);
    }
    for (const ch of officialChannels) {
      const { ids, covered } = await uploadsInWindow(ch.uploads, from, to, ctx);
      ids.forEach((id) => addYt(id, "channel uploads"));
      if (!covered) uncovered.push(ch);
    }
  });
  const officialIds = new Set(officialChannels.map((c) => c.channelId));

  // A company NOT on the list: the channels its own site links to are its own.
  const siteVerified = new Set<string>();
  const verifyChannels = async (channelIds: string[]) => {
    if (company || !domains.length || !channelIds.length) return;
    const home = await fetchPage(`https://${domains[0]}/`);
    const links = [home, ...pages.filter((p) => p.owner === "official").map((p) => p.html)].map(extractChannelLinks);
    const handles = new Set(links.flatMap((l) => [...l.handles]));
    const ids = new Set(links.flatMap((l) => [...l.ids]));
    const cj = await yt("channels", { part: "snippet", id: [...new Set(channelIds)].slice(0, 50).join(",") }, 1, 7 * DAY, ctx);
    for (const c of cj?.items ?? []) {
      const handle = String(c?.snippet?.customUrl ?? "").replace(/^@/, "").toLowerCase();
      if (ids.has(c.id) || (handle && handles.has(handle))) siteVerified.add(c.id);
    }
  };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nameIs = (t: string, name: string) => { const a = norm(t), b = norm(name); return !!a && !!b && (a.includes(b) || b.includes(a)); };

  let ytDetails: VideoInfo[] = [];
  await ytStep(async () => {
    if (ytFound.size) ytDetails = await videoDetails([...ytFound.keys()], ctx);
    if (!company) {
      await verifyChannels(ytDetails.map((d) => d.channelId));
      // Embedded on the company's own page by a channel carrying its name → its own.
      for (const d of ytDetails) {
        const srcs = [...ytFound.get(d.id)!.sources].join(" ");
        if (/announcement page|product page|newsroom post/.test(srcs) && nameIs(d.channelTitle, companyName)) siteVerified.add(d.channelId);
      }
    }
  });

  /* ── 3. Vimeo + files: probed, then held to the same ownership rule ────── */
  const cands: Cand[] = [];
  const rejected: string[] = [];
  const STRONG = /announcement page|product page|newsroom post|news article/;

  const addYtCands = () => {
    cands.splice(0, cands.length, ...cands.filter((c) => c.kind !== "youtube"));
    for (const v of ytDetails) {
      const f = ytFound.get(v.id)!;
      // Outlet channels never count (Jake 2026-10-01: no CNBC/Reuters footage) — the company's own only.
      const tier: "official" | null = officialIds.has(v.channelId) || siteVerified.has(v.channelId) ? "official" : null;
      if (!tier) continue;
      const why = hardReject(v);
      if (why) { rejected.push(`${v.title} (${why})`); continue; }
      cands.push({ key: `yt:${v.id}`, kind: "youtube", tier, videoId: v.id, title: v.title, description: v.description, channel: v.channelTitle,
        publishedAt: v.publishedAt, seconds: v.seconds, views: v.views, sources: f.sources });
    }
  };
  addYtCands();

  const vimeoJobs = [...vimeoFound.entries()].filter(([, e]) => e.official).slice(0, 6);
  const vimeoProbed = await Promise.all(vimeoJobs.map(([id, e]) => probeVimeo(id, e.h)));
  vimeoJobs.forEach(([id, e], i) => {
    const p = vimeoProbed[i];
    if (!p) { rejected.push(`Vimeo ${id} (not embeddable)`); return; }
    // Official: on the company's own page AND uploaded by the company's Vimeo account.
    const tier = e.official && nameIs(p.author, companyName) ? "official" : null;
    if (!tier) { rejected.push(`Vimeo "${p.title}" by ${p.author} (not the company's own)`); return; }
    const why = mediaReject(p);
    if (why) { rejected.push(`Vimeo "${p.title}" (${why})`); return; }
    cands.push({ key: `vimeo:${id}`, kind: "vimeo", tier, url: p.url, title: e.label ? `${e.label} [${p.title}]` : p.title, description: p.description,
      channel: `${p.author} (Vimeo)`, publishedAt: p.publishedAt, seconds: p.seconds, sources: e.sources });
  });

  // Files: the company's own pages (any host — it chose to show it), or an
  // outlet's article when the outlet hosts it AND it is labelled (an
  // unlabelled clip on a news page cannot be told apart from an ad).
  const fileJobs = [...fileFound.entries()]
    .filter(([, e]) => e.official)
    .sort(([, a], [, b]) => Number(b.official) - Number(a.official))
    .slice(0, 6);
  const fileProbed = await Promise.all(fileJobs.map(([url]) => probeFile(url)));
  fileJobs.forEach(([url, e], i) => {
    const p = fileProbed[i];
    if (!p || p.reject) { rejected.push(`${shortUrl(url)} (${p?.reject ?? "unreadable"})`); return; }
    const why = mediaReject(p);
    if (why) { rejected.push(`${shortUrl(url)} (${why})`); return; }
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    cands.push({ key: `file:${url}`, kind: "file", tier: "official", url, proxy: p.proxy,
      title: e.label || name, description: `file ${name} · ${p.width}x${p.height}`, channel: `${companyName} (own site/CDN)`,
      publishedAt: "", seconds: p.seconds, sources: e.sources });
  });

  /* ── 4. pools, with search.list only as the last official resort ──────── */
  const notTaken = (c: Cand): boolean => {
    if (!ctx.exclude?.size || !ctx.exclude.has(videoKey(c))) return true;
    ctx.dupSkipped = (ctx.dupSkipped ?? 0) + 1;
    return false;
  };
  const officialPool = () => cands
    .filter((c) => c.tier === "official" && (!ctx.exclude?.size || !ctx.exclude.has(videoKey(c))))
    .map((c) => {
      const strong = [...c.sources].some((s) => STRONG.test(s));
      const hits = textHits(`${c.title} ${c.description.slice(0, 1500)}`, kws);
      return { c, score: (strong ? 100 : 0) + hits, ok: strong || hits > 0 };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.c);
  let official = officialPool();

  const launchy = !NON_LAUNCH_CATEGORIES.test(story.category || "");
  const q = kws.slice(0, 5).join(" ");
  if (!official.length && launchy && q) {
    await ytStep(async () => {
      const searchIds: string[] = [];
      if (company) {
        for (const ch of [...uncovered, ...officialChannels.filter((c) => !uncovered.includes(c))]) {
          if (ctx.searches >= 1) break; // one launch search; the product fallback has its own two
          ctx.searches++;
          const json = await yt("search", { part: "snippet", channelId: ch.channelId, q, type: "video", order: "relevance", maxResults: "15",
            publishedAfter: from.toISOString(), publishedBefore: to.toISOString() }, 100, DAY, ctx);
          for (const it of json?.items ?? []) if (it?.id?.videoId) { searchIds.push(it.id.videoId); addYt(it.id.videoId, "channel search"); }
        }
      } else if (officialBlog && ctx.searches < 1) {
        ctx.searches++;
        const json = await yt("search", { part: "snippet", q: `${officialBlog.company} ${kws.slice(0, 4).join(" ")}`, type: "video", order: "relevance", maxResults: "15",
          publishedAfter: from.toISOString(), publishedBefore: to.toISOString() }, 100, DAY, ctx);
        const named = (json?.items ?? []).filter((it: any) => it?.id?.videoId && nameIs(it?.snippet?.channelTitle ?? "", companyName));
        named.forEach((it: any) => { searchIds.push(it.id.videoId); addYt(it.id.videoId, "company channel search"); });
        await verifyChannels(named.map((it: any) => it.snippet.channelId as string));
      }
      const fresh = searchIds.filter((id) => !ytDetails.some((d) => d.id === id));
      if (fresh.length) ytDetails = ytDetails.concat(await videoDetails(fresh, ctx));
      addYtCands();
    });
    official = officialPool();
  }

  const summarize = (list: Cand[]): VideoCandidateSummary[] => list.map((c) => ({ key: c.key, kind: c.kind, tier: c.tier, title: c.title, channel: c.channel,
    seconds: c.seconds, publishedAt: c.publishedAt, source: [...c.sources].join("; ") }));
  // A chosen file is swapped for the sharpest rendition of the SAME clip on the
  // same page (same directory, or the same file name in another size folder),
  // when it is as long as the original and can be played the same way.
  const upgrade = async (c: Cand): Promise<void> => {
    if (c.kind !== "file" || !c.url) return;
    const dir = c.url.slice(0, c.url.lastIndexOf("/") + 1);
    const name = c.url.slice(c.url.lastIndexOf("/") + 1).split("?")[0];
    const host = hostOf(c.url);
    const sibs = [...new Set(pageFiles.flat())].filter((u) => u !== c.url && hostOf(u) === host && !/126K|_\d{2,3}x\d{2,3}_/i.test(u)
      && (u.startsWith(dir) || u.split("?")[0].endsWith("/" + name))).slice(0, 5);
    if (!sibs.length) return;
    const orig = await ffprobe(c.url, null);
    const probed = await Promise.all(sibs.map(async (u) => ({ u, m: await ffprobe(u, null) })));
    const best = probed
      .filter((x) => x.m && x.m.width > (orig?.width ?? 0) && x.m.width / Math.max(1, x.m.height) >= 1.3 && Math.abs(x.m.seconds - c.seconds) <= 2)
      .sort((a, b) => b.m!.width - a.m!.width)[0];
    if (!best) return;
    const check = await probeFile(best.u);
    if (!check || check.reject) return;
    c.url = best.u;
    c.proxy = check.proxy;
    c.description = `${c.description} → ${best.m!.width}x${best.m!.height} rendition`;
  };
  // What was passed over on the way, so the dashboard says why the obvious video is not the one playing.
  const skipped = (): string => {
    const notes: string[] = [];
    if (ctx.dupSkipped) notes.push(`${ctx.dupSkipped} video${ctx.dupSkipped === 1 ? "" : "s"} skipped — already on an earlier slide`);
    if (ctx.fitRejected?.length) notes.push(`not used muted: ${[...new Set(ctx.fitRejected)].slice(0, 3).join("; ")}`);
    return notes.length ? ` (${notes.join(" · ")})` : "";
  };
  const outcome = (c: Cand, why: string, all: Cand[]): VideoResult => ({
    videoId: c.kind === "youtube" ? c.videoId! : null, kind: c.kind, url: c.kind === "youtube" ? undefined : c.url, tier: c.tier, proxy: !!c.proxy,
    title: c.title, channel: c.channel, checked: true, units: 0, candidates: summarize(all),
    reason: `[${c.tier}] ${why} Found via: ${[...c.sources].join("; ")}.${skipped()}`,
  });

  /* ── 5. the launch video for THIS news ─────────────────────────────────── */
  cands.filter((c) => c.tier === "official").forEach(notTaken);
  let officialWhy = "";
  if (official.length) {
    const v = await chooseFitting(story, companyName || "the company", "official", official, ctx);
    if (v.pick) { await upgrade(v.pick); return outcome(v.pick, v.reason, official); }
    officialWhy = v.reason;
  }

  /* ── 6. none: the company's own demo/marketing video of the PRODUCT ────── */
  const prod = await productFallback(story, ctx, cands.filter((c) => c.tier === "official" && (!ctx.exclude?.size || !ctx.exclude.has(videoKey(c)))));
  if (prod.pick) {
    await upgrade(prod.pick);
    return { ...outcome(prod.pick, prod.reason, prod.pool), reason: `[product] No launch video for this news${officialWhy ? ` (${officialWhy.replace(/\.$/, "")})` : ""}. ${prod.reason} Found via: ${[...prod.pick.sources].join("; ")}.${skipped()}` };
  }
  if (prod.ytNote) ytNote = ytNote || prod.ytNote;

  const articleNote = `${outletArticles.length} news article(s)${blockedArticles ? ` (${blockedArticles} more would not load — sign-in/subscription/bot walls)` : ""}`;
  const where = company ? `${company.name}'s ${officialChannels.length} channel(s), its pages and ${articleNote}` : `the story's pages and ${articleNote}`;
  const launchWhy = officialWhy || `No launch video on ${where} within 10 days of the story${rejected.length ? ` (${rejected.length} rejected: ${rejected.slice(0, 2).join("; ")})` : ""}.`;
  const reason = `${launchWhy} Product demo: ${prod.reason}${skipped()}`;
  // With YouTube unavailable the answer is incomplete — show it, but do not cache it.
  return { videoId: null, reason: ytNote ? `${reason} (${ytNote}; YouTube not checked)` : reason, checked: !ytNote, units: 0, candidates: summarize([...official, ...prod.pool]) };
}

/**
 * Tier 2 (Jake 2026-10-01): "I want to show a demo video or a marketing video
 * of each story (a demo of the feature or the product)." When there is no
 * launch video for this exact news, the company's own demo/marketing video of
 * the PRODUCT the story is about — newest first, up to ~18 months old — from
 * its verified channels only. "Gemini 4 Argon" with no Argon film → the newest
 * Gemini demo; an Anthropic IPO leak → a Claude demo; an FTC probe of OpenAI
 * and Anthropic → a ChatGPT or Claude demo. A company with no verified channel
 * (DeepSeek) gets nothing — but "DeepSeek and Huawei…" now names Huawei too.
 *
 * One fast model call names the company + product + search words (only from
 * allowlisted companies the story actually names), then at most two
 * search.list calls (100 units each, cached a week) on that company's channels.
 */
const PRODUCT_MAX_AGE_DAYS = 548;

async function productFallback(story: StoryRecord, ctx: Ctx, seed: Cand[]):
  Promise<{ pick: Cand | null; reason: string; pool: Cand[]; ytNote?: string }> {
  const headline = story.headline || "";
  const summary = story.summary || "";
  const named = OFFICIAL_COMPANIES
    .map((c) => { const h = c.match.exec(headline); const s = h ? null : c.match.exec(summary); return { c, at: h ? h.index : s ? 1000 + s.index : -1 }; })
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, 4)
    .map((x) => x.c);
  if (!named.length) return { pick: null, reason: "no company with a verified channel is named in the story.", pool: [] };

  const prompt = `A live AI news show plays the company's own product demo behind the presenter. Decide which PRODUCT this story is about and which company makes it.

STORY HEADLINE: ${headline}
STORY SUMMARY: ${summary.slice(0, 1200)}

COMPANIES WITH VERIFIED YOUTUBE CHANNELS (only these may be chosen):
${named.map((c) => `- ${c.name}: ${c.channels.map((ch) => "@" + ch.handle).join(", ")}`).join("\n")}

RULES:
- Name the PRODUCT FAMILY, not the new version: the new version has no video yet, which is why this fallback runs. "Gemini 4 Argon" → "Gemini"; "Claude Sonnet 5.5" → "Claude"; "GPT-6.1 Sol" → "ChatGPT"; "Copilot Autopilot mode" → "Copilot"; "Atlas at Hyundai" → "Atlas robot".
- If the story is about a company in general (an IPO, a lawsuit, an investigation, a leak, funding), use that company's flagship consumer AI product (Anthropic → Claude, OpenAI → ChatGPT, Google → Gemini). With two companies, take the first one named.
- If the product belongs to a company NOT in the list (e.g. DeepSeek, Baidu), or the story is about no product, answer company null. Never substitute a different company's product.
- query: 1–2 words to search that company's channels for the product family (usually just its name, e.g. "Gemini").
- channels: up to 2 handles from that company's list where its product demos are most likely posted.

Reply with ONLY this JSON: {"company": "<exact name from the list>" or null, "product": "...", "query": "...", "channels": ["@handle", ...], "reason": "<short>"}`;
  let parsed: { company?: string | null; product?: string; query?: string; channels?: string[]; reason?: string } = {};
  try {
    const m = /\{[\s\S]*\}/.exec(await callNewsModel(prompt, "news-video", "fast"));
    parsed = m ? JSON.parse(m[0]) : {};
  } catch {
    return { pick: null, reason: "could not tell which product the story is about.", pool: [] };
  }
  const company = named.find((c) => c.name === parsed.company);
  if (!company) return { pick: null, reason: parsed.reason ? `none (${parsed.reason}).` : "the story's product has no company channel on the list.", pool: [] };
  const product = String(parsed.product || company.name).slice(0, 80);
  const query = String(parsed.query || product).replace(/[^\p{L}\p{N} .+-]/gu, " ").trim().slice(0, 60);
  const wanted = new Set((parsed.channels || []).map((h) => String(h).replace(/^@/, "").toLowerCase()));

  if (!getYoutubeDataApiKey() || Date.now() < quotaBlockedUntil) {
    return { pick: null, reason: `${product}: YouTube unavailable.`, pool: [], ytNote: getYoutubeDataApiKey() ? "YouTube quota exhausted" : "no YouTube key" };
  }
  const cutoff = new Date(Date.now() - PRODUCT_MAX_AGE_DAYS * DAY);
  // Month-rounded so the cached search is reused all month rather than missed daily.
  const after = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1));
  const ids: string[] = [];
  const officialIds = new Set<string>();
  try {
    const resolved: { ch: OfficialChannel; r: ResolvedChannel }[] = [];
    for (const ch of company.channels) {
      const r = await resolveOfficial(ch, company, ctx);
      if (r) { resolved.push({ ch, r }); officialIds.add(r.channelId); }
    }
    const order = [...resolved.filter((x) => wanted.has(x.ch.handle.toLowerCase())), ...resolved.filter((x) => !wanted.has(x.ch.handle.toLowerCase()))];
    let searches = 0;
    for (const { r } of order) {
      if (searches >= 2 || !query) break;
      searches++;
      ctx.searches++;
      const json = await yt("search", { part: "snippet", channelId: r.channelId, q: query, type: "video", order: "relevance", maxResults: "20",
        publishedAfter: after.toISOString() }, 100, 7 * DAY, ctx);
      for (const it of json?.items ?? []) if (it?.id?.videoId) ids.push(it.id.videoId);
    }
  } catch (err) {
    if (err instanceof VideoQuotaError || err instanceof NoKeyError) return { pick: null, reason: `${product}: ${err.message}.`, pool: [], ytNote: err.message };
    throw err;
  }

  const words = [...new Set(`${product} ${query}`.toLowerCase().split(/[^a-z0-9.+-]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
  const about = (c: { title: string; description: string }) => !words.length || textHits(`${c.title} ${c.description.slice(0, 1500)}`, words) > 0;
  const pool: Cand[] = [];
  const seen = new Set<string>();
  // The launch-window candidates and the company's own page media, if about the product.
  for (const c of seed) if (about(c) && !seen.has(c.key)) { seen.add(c.key); pool.push(c); }
  const details = ids.length ? await videoDetails(ids, ctx) : [];
  for (const v of details) {
    if (!officialIds.has(v.channelId) || seen.has(`yt:${v.id}`)) continue;
    if (ctx.exclude?.has(`yt:${v.id}`)) { ctx.dupSkipped = (ctx.dupSkipped ?? 0) + 1; continue; }
    if (hardReject(v) || Date.parse(v.publishedAt) < cutoff.getTime() || !about(v)) continue;
    seen.add(`yt:${v.id}`);
    pool.push({ key: `yt:${v.id}`, kind: "youtube", tier: "official", videoId: v.id, title: v.title, description: v.description, channel: v.channelTitle,
      publishedAt: v.publishedAt, seconds: v.seconds, views: v.views, sources: new Set([`product search "${query}"`]) });
  }
  // Product-search hits first (they are ABOUT the product, across 18 months), then the
  // launch-window seed — newest first within each. Sorting everything by date let a
  // week of Google Cloud clips crowd every Gemini launch film out of the list.
  const bySearch = (c: Cand) => ([...c.sources].some((x) => x.startsWith("product search")) ? 0 : 1);
  pool.sort((a, b) => bySearch(a) - bySearch(b) || (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  const top = pool.slice(0, 18);
  if (!top.length) return { pick: null, reason: `no ${product} demo on ${company.name}'s channels in the last 18 months.`, pool: [] };
  const v = await chooseFitting(story, company.name, "product", top, ctx, product);
  if (!v.pick) return { pick: null, reason: `${product}: ${v.reason}`, pool: top };
  const pick: Cand = { ...v.pick, tier: "product" };
  return { pick, reason: `${company.name}'s own ${product} demo: ${v.reason}`, pool: top };
}

/* ── slides ───────────────────────────────────────────────────────────────── */

/** The slide fields a result writes. An unchecked result with no video leaves the slide as it was. */
export function slideVideoFields(r: VideoResult | null): Partial<SlideRecord> {
  if (!r) return {};
  const has = !!(r.videoId || r.url);
  if (!r.checked && !has) return {};
  return {
    videoId: r.videoId ?? null,
    videoKind: has ? r.kind ?? "youtube" : null,
    videoUrl: has && r.kind !== "youtube" ? r.url ?? null : null,
    videoTier: has ? r.tier ?? null : null,
    videoProxy: has ? !!r.proxy : false,
    videoTitle: has ? r.title ?? "" : null,
    videoChannel: has ? r.channel ?? "" : null,
    videoReason: r.reason,
    videoCheckedAt: new Date().toISOString(),
  } as Partial<SlideRecord>;
}

/* ── one deck, no repeats ──────────────────────────────────────────────────── */

/**
 * ⚠️ TWO SLIDES MUST NEVER PLAY THE SAME VIDEO (Jake 2026-10-01: "FTC slide
 * loaded the video from another slide"). Stories are searched in parallel and
 * each one, alone, is right to want "Introducing dots" — OpenAI's newest
 * film — so the clash only exists at deck level and is settled there:
 *
 *   1. Manual picks win, and count as taken.
 *   2. Then in deck order, the earlier slide keeps its video; a later slide
 *      whose pick is taken is searched again with every taken video excluded
 *      (the next-best fitting video, or none — never the same one).
 *
 * Takes the results already found, re-searches only the clashing ones.
 */
export async function uniqueVideos(entries: { story: StoryRecord; result: VideoResult | null }[]): Promise<(VideoResult | null)[]> {
  const out = entries.map((e) => e.result);
  const manual = entries.map((e) => !!e.story.id
    && !!(db.prepare(`SELECT manual FROM news_video_picks WHERE story_id = ? AND manual = 1`).get(e.story.id)));
  const taken = new Set<string>();
  out.forEach((r, i) => { if (manual[i] && videoKey(r)) taken.add(videoKey(r)); });
  for (let i = 0; i < entries.length; i++) {
    if (manual[i]) continue;
    let key = videoKey(out[i]);
    if (key && taken.has(key)) {
      const again = await findVideoForStory(entries[i].story, { force: true, exclude: new Set(taken) }).catch(() => null);
      // Never leave the duplicate in place, even when the second look fails.
      out[i] = again && (again.checked || videoKey(again))
        ? again
        : { videoId: null, reason: "Same video as an earlier slide, and the search for another one failed. Press \"Find video\" to try again.", checked: true, units: again?.units ?? 0, candidates: [] };
      if (videoKey(out[i]) && taken.has(videoKey(out[i]))) {
        out[i] = { videoId: null, reason: "Same video as an earlier slide — nothing else fits.", checked: true, units: out[i]!.units, candidates: [] };
      }
      key = videoKey(out[i]);
    }
    if (key) taken.add(key);
  }
  return out;
}

const storyOf = (slide: SlideRecord): StoryRecord =>
  (slide.story ? stories.get(slide.story) : undefined) ?? { id: "", headline: slide.topicLabel, firstSeenAt: slide.publishedAt };

/** Re-run the search for one slide (ignores the cached pick, keeps the API cache), skipping the deck's other videos. */
export async function findSlideVideo(slideId: string): Promise<{ slide: SlideRecord | undefined; result: VideoResult }> {
  const slide = slides.get(slideId);
  if (!slide) throw Object.assign(new Error("Slide not found."), { status: 404 });
  const others = slide.deck
    ? slides.where("deck_id = ? AND id != ? AND (deleted IS NULL OR deleted = 0)", slide.deck, slideId).map((s) => videoKey({ videoId: s.videoId, url: s.videoUrl })).filter(Boolean)
    : [];
  const result = await findVideoForStory(storyOf(slide), { force: true, exclude: new Set(others) });
  const fields = slideVideoFields(result);
  if (Object.keys(fields).length) slides.update(slideId, fields as Record<string, unknown>);
  return { slide: slides.get(slideId), result };
}

/** Every slide of a deck, three at a time, then made unique across the deck. */
export async function findDeckVideos(deckId: string, write?: (chunk: string) => void | Promise<void>): Promise<{ found: number; checked: number; units: number }> {
  const list = slides.where("deck_id = ? AND (deleted IS NULL OR deleted = 0)", deckId).sort((a, b) => (a.position || 0) - (b.position || 0));
  const results: (VideoResult | null)[] = new Array(list.length).fill(null);
  let units = 0;
  let done = 0;
  for (let i = 0; i < list.length; i += 3) {
    await Promise.all(list.slice(i, i + 3).map(async (s, j) => {
      const r = await findVideoForStory(storyOf(s), { force: true });
      results[i + j] = r;
      units += r.units;
      done++;
      await write?.(JSON.stringify({ message: `${s.topicLabel}: searched`, percent: Math.round((90 * done) / list.length) }));
    }));
  }
  const unique = await uniqueVideos(list.map((s, k) => ({ story: storyOf(s), result: results[k] })));
  let found = 0;
  for (const [k, s] of list.entries()) {
    const r = unique[k];
    if (r !== results[k]) units += r?.units ?? 0;
    const fields = slideVideoFields(r);
    if (Object.keys(fields).length) slides.update(s.id, fields as Record<string, unknown>);
    if (r?.videoId || r?.url) found++;
    await write?.(JSON.stringify({ message: `${s.topicLabel}: ${r?.videoId || r?.url ? `▶ ${r.title}` : `no video — ${r?.reason ?? ""}`}`, percent: 100 }));
  }
  return { found, checked: list.length, units };
}

/** "dQw4w9WgXcQ", a watch/share/embed/shorts link → the 11-char id, or null. */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return extractYouTubeIds(s)[0] ?? null;
}

const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

/**
 * Jake's override: clear a wrong video, or paste a better one — a YouTube
 * link/id, a Vimeo link, or a direct .mp4/.webm link. Kept on the story as a
 * MANUAL pick, so rebuilding the deck does not undo it.
 */
export async function setSlideVideo(slideId: string, input: string | null): Promise<SlideRecord | undefined> {
  const slide = slides.get(slideId);
  if (!slide) throw Object.assign(new Error("Slide not found."), { status: 404 });
  const now = new Date().toISOString();
  const empty = { videoId: null, videoKind: null, videoUrl: null, videoTier: null, videoProxy: false, videoTitle: null, videoChannel: null };
  let fields: Record<string, unknown>;
  const text = (input ?? "").trim();
  if (!text) {
    fields = { ...empty, videoReason: "Removed by hand.", videoCheckedAt: now };
  } else if (/vimeo\.com\//i.test(text)) {
    const m = /vimeo\.com\/(?:video\/)?(\d{6,})(?:\/([0-9a-f]{8,}))?(?:[^"'\s]*?[?&]h=([0-9a-f]+))?/i.exec(text);
    if (!m) throw bad("That Vimeo link has no video id.");
    const p = await probeVimeo(m[1], m[2] || m[3]);
    if (!p) throw bad("Vimeo will not embed that video (private or domain-locked).");
    fields = { ...empty, videoKind: "vimeo", videoUrl: p.url, videoTier: "manual", videoTitle: p.title, videoChannel: `${p.author} (Vimeo)`, videoReason: "[manual] Set by hand.", videoCheckedAt: now };
  } else if (/^https?:\/\//i.test(text) && FILE_RE.test(text.split("#")[0]) && !extractYouTubeIds(text).length) {
    const p = await probeFile(text);
    if (!p || p.reject) throw bad(`That file cannot go on screen: ${p?.reject ?? "unreadable"}.`);
    fields = { ...empty, videoKind: "file", videoUrl: text, videoTier: "manual", videoProxy: p.proxy, videoTitle: decodeURIComponent(new URL(text).pathname.split("/").pop() || "video"),
      videoChannel: hostOf(text), videoReason: `[manual] Set by hand${p.proxy ? " (served through the Lab — the host blocks hotlinking)" : ""}.`, videoCheckedAt: now };
  } else {
    const id = parseVideoId(text);
    if (!id) throw bad("That is not a YouTube, Vimeo or .mp4 link.");
    let title = "";
    let channel = "";
    if (getYoutubeDataApiKey()) {
      const [v] = await videoDetails([id], { units: 0, searches: 0 });
      if (!v) throw bad("YouTube does not know that video (deleted or private?).");
      if (!v.embeddable) throw bad("That video's owner does not allow embedding, so it cannot play on the show.");
      title = v.title;
      channel = v.channelTitle;
    }
    fields = { ...empty, videoId: id, videoKind: "youtube", videoTier: "manual", videoTitle: title, videoChannel: channel, videoReason: "[manual] Set by hand.", videoCheckedAt: now };
  }
  slides.update(slideId, fields);
  if (slide.story) {
    db.prepare(`INSERT INTO news_video_picks (story_id, video_id, video_title, video_channel, reason, candidates_json, manual, checked_at, video_kind, video_url, video_tier, video_proxy)
      VALUES (?, ?, ?, ?, ?, '[]', 1, ?, ?, ?, ?, ?) ON CONFLICT(story_id) DO UPDATE SET video_id = excluded.video_id, video_title = excluded.video_title,
      video_channel = excluded.video_channel, reason = excluded.reason, manual = 1, checked_at = excluded.checked_at,
      video_kind = excluded.video_kind, video_url = excluded.video_url, video_tier = excluded.video_tier, video_proxy = excluded.video_proxy`)
      .run(slide.story, fields.videoId ?? null, fields.videoTitle ?? null, fields.videoChannel ?? null, String(fields.videoReason), Date.now(),
        fields.videoKind ?? null, fields.videoUrl ?? null, fields.videoTier ?? null, fields.videoProxy ? 1 : 0);
  }
  return slides.get(slideId);
}

/**
 * The Lab's streaming proxy for a slide's video FILE whose CDN refuses the
 * Lab as referer. ⚠️ NOT AN OPEN PROXY: it serves exactly the URL stored on
 * that slide, only for kind "file", only a video content-type, behind the
 * Lab's sign-in (mounted on /api/news). Range requests pass through, so the
 * <video> element can seek and loop.
 */
export async function streamSlideVideo(slideId: string, range: string | undefined, signal: AbortSignal):
  Promise<{ status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null } | { status: number; error: string }> {
  const slide = slides.get(slideId);
  const url = slide?.videoKind === "file" ? slide.videoUrl : undefined;
  if (!url || !/^https?:\/\//i.test(url)) return { status: 404, error: "No video file on this slide." };
  const attempt = async (referer: string | null) => {
    const headers: Record<string, string> = { "User-Agent": UA };
    if (range) headers.Range = range;
    if (referer) headers.Referer = referer;
    return fetch(url, { headers, redirect: "follow", signal });
  };
  let res = await attempt(null);
  if (res.status === 401 || res.status === 403) { try { await res.body?.cancel(); } catch { /* ignore */ } res = await attempt(`https://${hostOf(url)}/`); }
  const type = res.headers.get("content-type") || "";
  if (!(res.status === 200 || res.status === 206) || !(type.startsWith("video/") || type === "application/octet-stream")) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { status: 502, error: `Upstream answered ${res.status} ${type}` };
  }
  const headers: Record<string, string> = { "Content-Type": type.startsWith("video/") ? type : "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  for (const h of ["content-length", "content-range"]) { const v = res.headers.get(h); if (v) headers[h.replace(/(^|-)\w/g, (s) => s.toUpperCase())] = v; }
  return { status: res.status, headers, body: res.body };
}
