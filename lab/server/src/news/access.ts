/**
 * Can a viewer actually read this source? (Jake 2026-10-02: "make the news
 * presenter only use sources for the presentation for stories that are not
 * blocked by a sign-in or subscription wall".)
 *
 * The presenter's source tab opens the article on Jake's screen, logged out.
 * A page is NOT usable when, fetched the way a logged-out reader gets it:
 *   - it answers 401/402/403/407/429/451, or fails outright (a login wall, a
 *     subscription wall, or a bot wall — the server cannot tell those apart,
 *     and none of them is a page to put on screen);
 *   - its own structured data says `isAccessibleForFree: false` (how The
 *     Verge, NYT, WSJ, Bloomberg, Wired, FT… mark subscriber pages);
 *   - its text asks the reader to subscribe / sign in / register to keep
 *     reading;
 *   - it is on a known hard-paywall domain;
 *   - it carries almost no readable text (a wall or an app shell).
 * Results are cached (news_source_access, 3 days) so a deck build checks each
 * URL once. Never throws.
 */
import { db } from "../db/index.js";
import { rankBestSources, type BestSource } from "./outlets.js";

db.exec(`
CREATE TABLE IF NOT EXISTS news_source_access (
  url TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- open | paywall | signin | blocked | unreadable
  reason TEXT,
  http_status INTEGER,
  checked_at TEXT NOT NULL
);
`);

export type AccessStatus = "open" | "paywall" | "signin" | "blocked" | "unreadable";
export interface Access { url: string; status: AccessStatus; reason: string; httpStatus: number | null; cached: boolean }

const TTL_MS = 3 * 86_400_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/** Sites whose articles are behind a subscription for a logged-out reader. */
const HARD_PAYWALL = [
  "wsj.com", "ft.com", "bloomberg.com", "nytimes.com", "theinformation.com", "economist.com", "barrons.com",
  "washingtonpost.com", "businessinsider.com", "theatlantic.com", "newyorker.com", "wired.com", "fortune.com",
  "statnews.com", "thetimes.co.uk", "telegraph.co.uk", "hbr.org", "seekingalpha.com", "nikkei.com", "asia.nikkei.com",
  "latimes.com", "bostonglobe.com", "foreignpolicy.com", "puck.news", "stratechery.com", "technologyreview.com",
];

const WALL_TEXT = [
  /subscribe (?:now |today )?to (?:continue|keep) reading/i,
  /subscribe (?:now |today )?to read/i,
  /(?:this|the) (?:article|story|post) is (?:only )?(?:available )?(?:exclusively )?(?:for|to) (?:paid )?subscribers/i,
  /subscribers?[- ]only (?:article|story|content)/i,
  /(?:sign|log) in to (?:continue|keep) reading/i,
  /(?:sign|log) in to read (?:the|this) (?:full )?(?:article|story)/i,
  /create (?:a )?free account to (?:continue|keep|read)/i,
  /register (?:for free )?to (?:continue|keep) reading/i,
  /you(?:'|’)ve reached your (?:free )?(?:article|story) limit/i,
  /become a (?:member|subscriber) to (?:continue|read)/i,
];

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const onHost = (host: string, d: string) => host === d || host.endsWith(`.${d}`);

function cached(url: string): Access | null {
  const r = db.prepare(`SELECT * FROM news_source_access WHERE url = ?`).get(url) as any;
  if (!r || Date.now() - Date.parse(r.checked_at) > TTL_MS) return null;
  return { url, status: r.status, reason: r.reason ?? "", httpStatus: r.http_status ?? null, cached: true };
}

function store(a: Access): Access {
  db.prepare(`INSERT OR REPLACE INTO news_source_access (url, status, reason, http_status, checked_at) VALUES (?, ?, ?, ?, ?)`)
    .run(a.url, a.status, a.reason.slice(0, 300), a.httpStatus, new Date().toISOString());
  return a;
}

/** Visible text of a page (scripts, styles, nav chrome removed). */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Judge one fetched page. Pure — exported for tests. */
export function judgePage(url: string, httpStatus: number, html: string): Omit<Access, "cached"> {
  const host = hostOf(url);
  if ([401, 407].includes(httpStatus)) return { url, status: "signin", reason: `the site refused the page (${httpStatus} — a sign-in or bot wall)`, httpStatus };
  if (httpStatus === 402) return { url, status: "paywall", reason: "the site answered 402 (payment required)", httpStatus };
  if ([403, 429, 451].includes(httpStatus) || httpStatus >= 500 || httpStatus === 0) return { url, status: "blocked", reason: httpStatus ? `the site refused the page (${httpStatus})` : "the page could not be loaded", httpStatus };
  if (httpStatus >= 400) return { url, status: "blocked", reason: `the page answered ${httpStatus}`, httpStatus };
  const hard = HARD_PAYWALL.find((d) => onHost(host, d));
  if (hard) return { url, status: "paywall", reason: `${hard} is a subscription site`, httpStatus };
  if (/"isAccessibleForFree"\s*:\s*"?false"?/i.test(html) || /itemprop=["']isAccessibleForFree["'][^>]*content=["']false/i.test(html)) {
    return { url, status: "paywall", reason: "the page marks itself as subscriber-only (isAccessibleForFree: false)", httpStatus };
  }
  const text = visibleText(html);
  const wall = WALL_TEXT.find((re) => re.test(text));
  if (wall) {
    const m = text.match(wall)?.[0] ?? "";
    return { url, status: /sign|log|register|account/i.test(m) ? "signin" : "paywall", reason: `the page says "${m}"`, httpStatus };
  }
  if (text.length < 800) return { url, status: "unreadable", reason: `almost no readable text on the page (${text.length} characters)`, httpStatus };
  return { url, status: "open", reason: "readable without signing in", httpStatus };
}

/** Check one URL (cached). `html`/`httpStatus` may be passed when the caller already fetched it. */
export async function checkAccess(url: string, prefetched?: { httpStatus: number; html: string }): Promise<Access> {
  const hit = cached(url);
  if (hit) return hit;
  if (prefetched) return store({ ...judgePage(url, prefetched.httpStatus, prefetched.html), cached: false });
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
    const html = res.ok ? (await res.text()).slice(0, 3_000_000) : "";
    return store({ ...judgePage(res.url || url, res.status, html), url, cached: false });
  } catch (e) {
    return store({ url, status: "blocked", reason: `the page could not be loaded (${e instanceof Error ? e.message.slice(0, 80) : "error"})`, httpStatus: null, cached: false });
  }
}

export const isUsable = (a: Access | null | undefined) => a?.status === "open";

/* ── picking the presentation source ───────────────────────────────────────── */


export interface ReadablePick { best: BestSource | null; skipped: Array<{ name: string; url: string; reason: string }> }

/**
 * The best source a logged-out viewer can actually read: the same priority as
 * pickBestSource, skipping anything behind a sign-in, subscription or bot wall.
 * Checks at most 12 candidates (cached). When none is readable, `best` is null —
 * the slide then has no source link rather than a wall.
 */
export async function pickReadableSource(
  blogSources: { company: string; url: string; isOfficial?: boolean }[],
  articleSources: { outlet: string; url: string; title?: string }[],
  headline = "",
): Promise<ReadablePick> {
  const candidates = rankBestSources(blogSources, articleSources, headline).slice(0, 12);
  const skipped: ReadablePick["skipped"] = [];
  // Three at a time, in priority order: most stories settle on the first batch.
  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const results = await Promise.all(batch.map((c) => checkAccess(c.url)));
    for (let j = 0; j < batch.length; j++) {
      if (isUsable(results[j])) return { best: batch[j], skipped };
      skipped.push({ name: batch[j].name, url: batch[j].url, reason: results[j].reason });
    }
  }
  return { best: null, skipped };
}
