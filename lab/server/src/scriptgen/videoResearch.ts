/**
 * Video research: what the newest popular tutorials actually show on screen.
 *
 * Web research is good at what a tool IS and bad at where its buttons are — a
 * pricing page never says "click Settings, then Skills, then Browse". That gap is
 * why `stepScaffoldBlock` exists and why walkthroughs came out hedged behind
 * `[VERIFY ON SCREEN: …]` markers. A recent, heavily-watched tutorial is the one
 * source that does show the click path, because someone recorded themselves doing it.
 *
 * Two services, both already configured for other tools here:
 *   - YouTube Data API (getYoutubeDataApiKey) finds the videos.
 *   - An Apify actor pulls the transcript. YouTube blocks player requests from
 *     this server outright — LOGIN_REQUIRED on a datacenter IP — so scraping
 *     captions directly is not an option, and Apify is the same escape hatch
 *     engage/tiktok.ts and audit/content.ts already use.
 *
 * What comes back is fed to a model that extracts the PROCEDURE and never the
 * wording: menu names, the order of steps, the settings, the gotchas. Steps are
 * facts and facts are free; sentences belong to whoever wrote them, and a copied
 * sentence would break Jake's voice even where it broke nothing else.
 */
import { getApifyToken, getRapidApiKey, getYoutubeDataApiKey } from "../settings/postizSecrets.js";

const APIFY_BASE = process.env.APIFY_BASE_URL || "https://api.apify.com";
const TRANSCRIPT_ACTOR = process.env.SCRIPTGEN_TRANSCRIPT_ACTOR || "pintostudio~youtube-transcript-scraper";
const RAPIDAPI_HOST = "yt-api.p.rapidapi.com";

/** Jake's window: the newest tutorials, ranked by views. */
export const SEARCH_MONTHS = 3;
export const VIDEO_COUNT = 4;

/**
 * How many searches to run. One query is one guess at how the topic is titled,
 * and it is usually the product's name — which finds videos about the PRODUCT
 * when the video is about a USE of it. A run on "Claude as a note-taking app"
 * searched "Using Claude as a replacement for" and came back with Claude Code,
 * Claude Design and a one-person-business video: all real Claude tutorials,
 * none about note-taking. Two or three angles on the same topic cover it far
 * better than one, and the searches are cheap next to the transcripts.
 */
export const QUERY_COUNT = 3;

/**
 * How many candidates the selector is allowed to see. The list is what it
 * costs — 25 results per query, three queries, is enough titles to blow past
 * the point where more of them help.
 */
const MAX_CANDIDATES = 30;

/**
 * The model client, injected rather than imported.
 *
 * This module is otherwise pure HTTP + parsing, and its unit tests import it
 * directly under `--experimental-strip-types`; pulling `ai/claude.ts` in here
 * would drag the whole client module graph into them. Injection also means the
 * two model-backed steps below have a real fallback: no `chat`, and the search
 * behaves exactly as it did before it existed.
 */
export type ChatFn = (p: {
  prompt: string;
  maxTokens: number;
  thinking: boolean;
  label: string;
}) => Promise<string>;

/**
 * Under four minutes there is no workflow in the video — it is a Short, a teaser
 * or a "what is X" explainer. Those out-rank real tutorials on views (an 8.3M-view
 * "What is Claude Code?" beat every walkthrough on the topic), so length is the
 * filter that keeps view-ranking from selecting against the thing we came for.
 */
const MIN_SECONDS = 240;

/**
 * A live search for "Claude Code tutorial" returned, in the top four by views, a
 * 58-minute Japanese walkthrough and a video titled "Claude Code (Free Plan) +
 * YouTube = $77,000/Month". Neither is a source of click paths, and between them
 * they were most of the token budget.
 *
 * `relevanceLanguage` only biases the ranking, so language has to be filtered
 * afterwards on the video's own metadata. And an income-bait title is a reliable
 * marker of a video that never opens the product — plus Rule 6 bans money claims
 * outright, so a transcript full of them is the last thing this script needs
 * near its facts.
 */
const MONEY_BAIT = /\$\s?\d|\bincome\b|\bmake (?:money|\$)|\b\d+k\s*(?:\/|per |a )\s*(?:mo|month)|\bper month\b|\bpassive income\b/i;

/**
 * Does this video actually cover the topic, or is it just popular nearby?
 *
 * Every word of the topic that carries meaning has to appear in the title or
 * description. A one-word topic ("Blotato") must be named outright; a multi-word
 * one ("Claude Code") is allowed to have a word missing, because titles compress
 * — but not all of them.
 */
export function mentionsTopic(haystack: string, topic: string): boolean {
  const hay = haystack.toLowerCase();
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9.+]+/i)
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "how", "app", "ai"].includes(w));
  if (words.length === 0) return true;
  const hits = words.filter((w) => hay.includes(w)).length;
  return words.length === 1 ? hits === 1 : hits >= words.length - 1;
}

/**
 * The thing to actually search YouTube for, out of Stage 0's research brief.
 *
 * `coreTopic` is written for the researcher, not for a search box. A live run on
 * 2026-09-03 classified the topic as "Claude Cowork (Anthropic's
 * collaborative/agentic workspace feature) — what it is, how it works, setup,
 * and core use cases" and the whole sentence went into `q` and into
 * `mentionsTopic`. Both failed on it: YouTube matched nothing against a
 * 120-character query, and the relevance filter demanded eleven of its twelve
 * meaningful words in one title. The run logged "no recent tutorials found" and
 * the script was written with no click paths at all — the exact hedging this
 * feature exists to remove. Searching the same run for "Claude Cowork" returns a
 * three-hour full course and a beginners' walkthrough.
 *
 * So: drop parenthetical asides, cut the explanatory tail at the first dash or
 * colon, and cap what is left — a tutorial search is a product's NAME, and past
 * about six words the extra ones only narrow it towards nothing.
 */
export function searchTopic(topic: string): string {
  let t = (topic || "").replace(/\([^)]*\)/g, " ");
  // "Claude Cowork — what it is" / "Repurposing: one video into ten". The tail
  // after these is always the brief describing what to find out, never the name.
  t = t.split(/\s+[—–]\s+|\s+-\s+|[:;]/)[0];
  t = t.replace(/\s+/g, " ").replace(/[\s,.]+$/, "").trim();
  const words = t.split(" ").filter(Boolean);
  return words.length > 6 ? words.slice(0, 6).join(" ") : t;
}

/**
 * Topics that ARE developer tools. When the topic is one of these, a terminal
 * is the honest answer and the gate below has to get out of the way.
 *
 * Everything else is gated: Jake's audience is solopreneurs and small business
 * owners who "need clear, step-by-step guidance without tech jargon"
 * (stage2-outline's AUDIENCE PROFILE, stage-preamble's CONTENT RULES). A
 * note-taking video that teaches a CLI install, a Git URL and a trusted
 * workspace has answered a different question than the one the viewer clicked.
 */
const DEVELOPER_TOPIC =
  /\b(claude code|codex|copilot|cli|command line|terminal|shell|sdk|api|github|git|vs ?code|vscode|cursor|npm|node|docker|self[- ]host(ed|ing)?|python|javascript|typescript|webhook|regex)\b/i;

/** Did anyone actually ask for a developer workflow — the topic, the focus, or the brief? */
export function wantsDeveloperWorkflow(...parts: Array<string | undefined | null>): boolean {
  return DEVELOPER_TOPIC.test(parts.filter(Boolean).join(" "));
}

/**
 * The audience gate, in the words the pipeline already uses for it.
 *
 * Returns "" when a developer workflow was asked for, so the rule is absent
 * rather than negated — a prompt that says "normally avoid terminals, but this
 * time allow them" reads as hesitancy about the thing the viewer came for.
 */
export function audienceRule(developerOk: boolean): string {
  if (developerOk) return "";
  return [
    "AUDIENCE GATE — this video is for solopreneurs and small business owners who need step-by-step guidance without tech jargon.",
    "A tutorial aimed at developers teaches the wrong path to them: installing a command-line tool, trusting a workspace, cloning a Git URL, editing config files, running commands, or using an IDE.",
    "Reject those in favour of one that does the same job in the app's own interface. Only prefer a developer walkthrough when nothing else covers the topic at all.",
  ].join("\n");
}

/**
 * Ask for the two or three things a viewer would actually type to find this
 * topic. Deliberately short: the point is coverage of the topic's ANGLES (the
 * product's name, the job it is being used for, the thing it replaces), not
 * three rewordings of one phrase.
 *
 * "tutorial" is banned from the output because every query gets it appended —
 * see `searchOnce` — and "claude note taking tutorial tutorial" matches nothing.
 */
export function queriesPrompt(topic: string, focus?: string, developerOk = false): string {
  const gate = audienceRule(developerOk);
  return [
    "You are choosing what to search YouTube for, to find tutorials that SHOW this topic being done on screen.",
    "",
    `TOPIC: ${topic}`,
    ...(focus ? [`SPECIFIC FOCUS: ${focus}`] : []),
    ...(gate ? ["", gate] : []),
    "",
    `Give ${QUERY_COUNT === 3 ? "2 or 3" : `up to ${QUERY_COUNT}`} short search queries — what a real person would type into the YouTube search box.`,
    "",
    "Rules:",
    "- Each query is 2-5 words. Cover different ANGLES of the topic: the product's name, the job it is used for, the thing it replaces.",
    "- Do NOT include the words tutorial, guide, walkthrough, how to, or a year. Those are added for you.",
    "- No punctuation, no quotes, no boolean operators.",
    "- If the topic is a single product with no particular use attached, one or two queries is the honest answer. Do not pad.",
    "",
    'Reply with JSON only: {"queries": ["...", "..."]}',
  ].join("\n");
}

/** Strip the words the search adds back, so no query can carry them twice. */
function stripAppendedWords(q: string): string {
  return q
    .replace(/\b(tutorial|guide|walkthrough|explained|how to)\b/gi, " ")
    .replace(/[^a-z0-9.+\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read the queries back. A model that answers badly must not be able to empty
 * this stage, so anything unusable falls back to the mechanical `searchTopic`,
 * which is what ran before there were queries at all.
 */
export function parseQueries(text: string, fallback: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const q = stripAppendedWords(raw);
    // A one-character query matches everything; a very long one matches nothing.
    if (q.length < 3 || q.split(" ").length > 8) return;
    const k = q.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(q);
  };
  try {
    const parsed = JSON.parse(extractJsonish(text)) as { queries?: unknown };
    if (Array.isArray(parsed?.queries)) parsed.queries.forEach(push);
  } catch {
    // Unparseable is not exceptional — it is one more reason to use the fallback.
  }
  if (out.length === 0) push(fallback);
  return out.slice(0, QUERY_COUNT);
}

/** The smallest JSON-looking substring, so a model preamble cannot break parsing. */
function extractJsonish(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export interface Candidate extends TutorialVideo {
  /** Title + description, kept for the selector and never returned to the caller. */
  haystack: string;
  /** Which query surfaced it first — useful when a whole angle turns out to be junk. */
  foundBy: string;
}

/**
 * What the selector reads. Descriptions are cut hard: the first two lines carry
 * what the video is, and everything after them is links and timestamps.
 */
export function candidateBlock(cands: Candidate[]): string {
  return cands
    .map((c, i) => {
      const desc = c.haystack
        .slice(c.title.length)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
      return (
        `[${i + 1}] ${c.title}\n` +
        `    ${c.channel} · ${c.views.toLocaleString()} views · ${c.publishedAt} · ${stamp(c.seconds)}\n` +
        (desc ? `    ${desc}\n` : "")
      );
    })
    .join("");
}

/**
 * Pick the videos that are actually about the topic.
 *
 * This replaces a word-overlap heuristic (`mentionsTopic`) that could not tell
 * "Claude for note-taking" from "Claude Code" — both name Claude, and the
 * heuristic allows one word to be missing because titles compress. Reading the
 * title against the topic is a judgement, so it gets thinking and a model.
 */
export function selectionPrompt(
  topic: string,
  cands: Candidate[],
  count: number,
  focus?: string,
  developerOk = false,
): string {
  const gate = audienceRule(developerOk);
  return [
    "Pick the YouTube videos that would actually teach someone this topic by SHOWING it on screen.",
    "",
    `TOPIC: ${topic}`,
    ...(focus ? [`SPECIFIC FOCUS: ${focus}`] : []),
    "",
    "CANDIDATES:",
    candidateBlock(cands),
    "",
    `Choose at most ${count}, best first. What matters:`,
    "- The video is about THIS topic, not about the same product used for something else. A video about the product's other features is the wrong video.",
    "- It demonstrates a workflow: menus, clicks, settings, the order things happen in.",
    "- Prefer the video that covers the topic directly over a longer one that touches it in passing.",
    "- Views and recency break ties. They do not outrank relevance.",
    "",
    "Reject roundups that mention the topic in a list, reaction and news videos, and anything whose title promises money rather than a method.",
    ...(gate ? ["", gate, ""] : []),
    `Returning fewer than ${count} is correct when fewer are relevant. Returning none is correct when none are.`,
    "",
    'Reply with JSON only: {"picks": [{"n": 1, "why": "one short clause"}]}',
  ].join("\n");
}

/**
 * Read the picks back, by list position. Positions are used rather than video
 * IDs because an 11-character ID is the one thing in this payload a model can
 * plausibly get subtly wrong, and a wrong ID is a silently different video.
 */
export function parseSelection(text: string, cands: Candidate[], count: number): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  try {
    const parsed = JSON.parse(extractJsonish(text)) as { picks?: Array<{ n?: unknown }> };
    for (const pick of parsed?.picks ?? []) {
      const n = Number(pick?.n);
      if (!Number.isInteger(n) || n < 1 || n > cands.length) continue;
      const c = cands[n - 1];
      if (seen.has(c.videoId)) continue;
      seen.add(c.videoId);
      out.push(c);
    }
  } catch {
    // Falls back to the mechanical ranking in the caller.
  }
  return out.slice(0, count);
}

function isEnglish(lang: string | undefined): boolean {
  // Absent is common and not a reason to drop a video — only an explicit
  // non-English tag is. "en", "en-US" and "en-GB" all pass: they are English and
  // they all surface in a US search, and dropping en-GB would lose good
  // walkthroughs for no gain in what the viewer sees on screen.
  return !lang || /^en/i.test(lang);
}

export interface TutorialVideo {
  videoId: string;
  /** The video's own language tag, where it declares one. */
  lang?: string;
  title: string;
  channel: string;
  publishedAt: string;
  views: number;
  seconds: number;
  url: string;
}

export interface TranscribedVideo extends TutorialVideo {
  /** Plain transcript text with a timestamp every few lines, for citation. */
  transcript: string;
}

export function videoResearchConfigured(): boolean {
  // Search is required. Either transcript source will do — Apify is tried first
  // and RapidAPI catches the runs where an actor fails or returns nothing.
  return getYoutubeDataApiKey() != null && (getApifyToken() != null || getRapidApiKey() != null);
}

/** "PT15M13S" → 913. Returns 0 for anything unparseable. */
export function parseIsoDuration(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/** mm:ss for a citation. */
export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The newest heavily-watched tutorials on the topic.
 *
 * `order=viewCount` inside a `publishedAfter` window is what "latest videos with
 * a lot of views" means in one query — YouTube sorts by views, the window keeps
 * them recent. When the window is empty (a tool that shipped last week, a topic
 * nobody has covered) the caller is told, rather than the window being widened
 * behind Jake's back: a two-year-old click path presented as current is the exact
 * failure this whole feature exists to prevent.
 */
/** One query, one round-trip pair: search for ids, then look those ids up. */
async function searchOnce(query: string, key: string, after: Date): Promise<Candidate[]> {
  const search = new URLSearchParams({
    part: "snippet",
    // "tutorial" is appended here, and stripped out of model-written queries, so
    // it appears exactly once however the query was produced.
    q: `${query} tutorial`,
    type: "video",
    // RELEVANCE, not viewCount. Asking YouTube to sort by views returns whatever
    // is popular near the topic rather than about it — a search for "Blotato"
    // came back with "Claude Design OS" and "1-Person Business", and one for
    // "Claude Code" with two AI-trading videos. So relevance is bought from
    // YouTube, and the view ranking is applied here, over results that are
    // actually on topic.
    order: "relevance",
    publishedAfter: after.toISOString(),
    // Over-fetch: the length filter below discards Shorts and explainers, and
    // those are exactly what ranks highest on views.
    maxResults: "25",
    // English-language, US results. relevanceLanguage only biases the ranking —
    // it let a 58-minute Japanese walkthrough take the top slot — so the language
    // tag is filtered properly below. regionCode is what actually scopes the
    // search to the US.
    relevanceLanguage: "en",
    regionCode: "US",
    key,
  });
  const sr = await fetch(`https://www.googleapis.com/youtube/v3/search?${search}`);
  if (!sr.ok) throw new Error(`YouTube search failed (${sr.status})`);
  const sj = (await sr.json()) as { items?: Array<{ id?: { videoId?: string } }> };
  const ids = (sj.items ?? []).map((i) => i.id?.videoId).filter((v): v is string => !!v);
  if (ids.length === 0) return [];

  const detail = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: ids.join(","),
    key,
  });
  const dr = await fetch(`https://www.googleapis.com/youtube/v3/videos?${detail}`);
  if (!dr.ok) throw new Error(`YouTube lookup failed (${dr.status})`);
  const dj = (await dr.json()) as {
    items?: Array<{
      id: string;
      snippet: {
        title: string;
        description: string;
        channelTitle: string;
        publishedAt: string;
        defaultAudioLanguage?: string;
        defaultLanguage?: string;
      };
      statistics: { viewCount?: string };
      contentDetails: { duration: string };
    }>;
  };

  return (dj.items ?? [])
    .map((v) => ({
      videoId: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      publishedAt: v.snippet.publishedAt.slice(0, 10),
      views: Number(v.statistics.viewCount ?? 0),
      seconds: parseIsoDuration(v.contentDetails.duration),
      url: `https://www.youtube.com/watch?v=${v.id}`,
      lang: v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage,
      haystack: `${v.snippet.title} ${v.snippet.description ?? ""}`,
      foundBy: query,
    }))
    // The three cheap, mechanical rejections. None of them is a judgement call,
    // and each one removes something the selector should never have to read:
    // Shorts and teasers, non-English audio, and income bait.
    .filter((v) => v.seconds >= MIN_SECONDS)
    .filter((v) => isEnglish(v.lang))
    .filter((v) => !MONEY_BAIT.test(v.title));
}

/**
 * The pre-model ranking, kept as the fallback for every path where the selector
 * cannot speak: no `chat` injected, a failed call, an unparseable answer.
 *
 * A video that names the topic in its TITLE is about the topic. One that only
 * mentions it in the description is usually a roundup that lists the tool in
 * passing — real for "Blotato", where three of four description-matches turned
 * out to be videos about something else that mention it. Title matches go
 * first, and descriptions only fill the slots left over.
 */
export function mechanicalRank(cands: Candidate[], count: number): Candidate[] {
  const byViews = (a: { views: number }, b: { views: number }) => b.views - a.views;
  const onTopic = cands.filter((c) => mentionsTopic(c.haystack, c.foundBy));
  const titled = onTopic.filter((c) => mentionsTopic(c.title, c.foundBy)).sort(byViews);
  const rest = onTopic.filter((c) => !mentionsTopic(c.title, c.foundBy)).sort(byViews);
  return [...titled, ...rest].slice(0, count);
}

export async function findTutorialVideos(
  topic: string,
  opts: {
    months?: number;
    count?: number;
    /** The specific angle, where Stage 0 captured one. Shapes both model calls. */
    focus?: string;
    /** The brief, read only to decide whether a developer workflow was asked for. */
    brief?: string;
    /** Injected model client. Without it this behaves exactly as it did before. */
    chat?: ChatFn;
    /** Filled with the queries actually searched, for the run log. */
    sinkQueries?: string[];
  } = {},
): Promise<TutorialVideo[]> {
  const key = getYoutubeDataApiKey();
  if (!key) return [];
  const months = opts.months ?? SEARCH_MONTHS;
  const count = opts.count ?? VIDEO_COUNT;
  // Everything below matches on the NAME, never on the brief it arrived in.
  const fallbackQuery = searchTopic(topic);
  if (!fallbackQuery) return [];
  // Asked-for beats gated: the brief counts too, so "show me the CLI" in a
  // brief lifts the gate the same way a developer topic does.
  const developerOk = wantsDeveloperWorkflow(topic, opts.focus, opts.brief);

  // ── Two or three angles, not one ──
  let queries = [fallbackQuery];
  if (opts.chat) {
    const answer = await opts
      .chat({
        prompt: queriesPrompt(topic, opts.focus, developerOk),
        maxTokens: 600,
        // Naming what to search for is recall, not judgement. Thinking bills as
        // output at 5x input, and this is the one step in the stage that has a
        // guaranteed-correct fallback.
        thinking: false,
        label: "stage1.6-queries",
      })
      .catch(() => "");
    queries = parseQueries(answer, fallbackQuery);
  }
  opts.sinkQueries?.push(...queries);

  const after = new Date();
  after.setMonth(after.getMonth() - months);

  // Deduped by video id: the angles overlap on purpose, and the video that shows
  // up under two of them is usually the one both were reaching for.
  const merged = new Map<string, Candidate>();
  for (const q of queries) {
    for (const c of await searchOnce(q, key, after)) {
      if (!merged.has(c.videoId)) merged.set(c.videoId, c);
    }
  }
  const candidates = [...merged.values()];
  if (candidates.length === 0) return [];

  const strip = ({ haystack, foundBy, ...v }: Candidate): TutorialVideo => v;
  const ranked = mechanicalRank(candidates, count);
  if (!opts.chat) return ranked.map(strip);

  // ── Which of these is actually about the topic ──
  const shortlist = [...candidates].sort((a, b) => b.views - a.views).slice(0, MAX_CANDIDATES);
  const answer = await opts
    .chat({
      prompt: selectionPrompt(topic, shortlist, count, opts.focus, developerOk),
      maxTokens: 2000,
      thinking: true,
      label: "stage1.6-select",
    })
    .catch(() => "");
  const picked = parseSelection(answer, shortlist, count);
  return (picked.length > 0 ? picked : ranked).map(strip);
}

interface TranscriptSegment {
  start?: string | number;
  text?: string;
}

/**
 * One video's transcript, timestamped every ~30 seconds.
 *
 * The stamps are not decoration: every step the extractor reports cites the video
 * and the moment it came from, so Jake can open the tab and check a click path
 * rather than taking the model's word for it.
 */
async function fetchViaApify(video: TutorialVideo): Promise<string | null> {
  const token = getApifyToken();
  if (!token) return null;
  const res = await fetch(
    `${APIFY_BASE}/v2/acts/${TRANSCRIPT_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoUrl: video.url }),
    },
  );
  if (!res.ok) return null;
  const items = (await res.json()) as Array<{ data?: TranscriptSegment[] }>;
  const segments = items?.[0]?.data;
  if (!Array.isArray(segments) || segments.length === 0) return null;
  return formatTranscript(segments);
}

/**
 * Fallback: RapidAPI's yt-api. Used when Apify fails, returns nothing, or has no
 * token — two independent providers, because a transcript that silently comes
 * back empty costs the run its click paths and nobody notices until the script
 * is hedged behind VERIFY markers again.
 *
 * The shape is read defensively on purpose. `/video/info` has been seen to return
 * the caption list under `subtitles`, under `subtitles.subtitles`, and as a bare
 * array; the track itself may carry `url` or `baseUrl`, and the file it points at
 * may be json3, XML timedtext or VTT. Anything unrecognised returns null and the
 * video is skipped rather than throwing the run away.
 */
async function fetchViaRapidApi(video: TutorialVideo): Promise<string | null> {
  const key = getRapidApiKey();
  if (!key) return null;
  const headers = { "x-rapidapi-key": key, "x-rapidapi-host": RAPIDAPI_HOST };

  const info = await fetch(`https://${RAPIDAPI_HOST}/video/info?id=${encodeURIComponent(video.videoId)}`, { headers });
  if (!info.ok) return null;
  const j = (await info.json()) as Record<string, unknown>;

  const tracks = pickSubtitleTracks(j);
  if (tracks.length === 0) return null;
  const track =
    tracks.find((t) => /^en/i.test(String(t.languageCode ?? t.language ?? ""))) ?? tracks[0];
  const url = String(track.url ?? track.baseUrl ?? "");
  if (!url) return null;

  // json3 parses cleanly into timed segments; ask for it where the URL allows.
  const jsonUrl = url.includes("fmt=") ? url : `${url}${url.includes("?") ? "&" : "?"}fmt=json3`;
  const cap = await fetch(jsonUrl);
  if (!cap.ok) return null;
  const body = await cap.text();
  const segments = parseCaptionBody(body);
  return segments.length > 0 ? formatTranscript(segments) : null;
}

/** The caption-track list, wherever this API decided to put it today. */
export function pickSubtitleTracks(payload: Record<string, unknown>): Array<Record<string, string>> {
  const candidates: unknown[] = [
    payload.subtitles,
    (payload.subtitles as Record<string, unknown> | undefined)?.subtitles,
    payload.captions,
    (payload.captions as Record<string, unknown> | undefined)?.captionTracks,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c as Array<Record<string, string>>;
  }
  return [];
}

/** json3, XML timedtext or VTT → timed segments. Unknown formats give []. */
export function parseCaptionBody(body: string): TranscriptSegment[] {
  const text = body.trim();
  if (!text) return [];

  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> };
      return (j.events ?? [])
        .map((e) => ({
          start: (e.tStartMs ?? 0) / 1000,
          text: (e.segs ?? []).map((sg) => sg.utf8 ?? "").join(""),
        }))
        .filter((seg) => seg.text.trim().length > 0);
    } catch {
      return [];
    }
  }

  if (text.startsWith("<")) {
    const out: TranscriptSegment[] = [];
    for (const m of text.matchAll(/<(?:text|p)[^>]*?(?:start|t)="([\d.]+)"[^>]*>([\s\S]*?)<\/(?:text|p)>/gi)) {
      const raw = Number(m[1]);
      out.push({ start: raw > 10000 ? raw / 1000 : raw, text: decodeXml(m[2]) });
    }
    return out.filter((seg) => String(seg.text).trim().length > 0);
  }

  if (/^WEBVTT/i.test(text)) {
    const out: TranscriptSegment[] = [];
    for (const block of text.split(/\n\n+/)) {
      const m = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/.exec(block);
      if (!m) continue;
      const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      const line = block.split("\n").slice(1).join(" ").replace(/<[^>]+>/g, "").trim();
      if (line) out.push({ start, text: line });
    }
    return out;
  }

  return [];
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();
}

/**
 * One video's transcript: Apify first, RapidAPI second. Either provider failing
 * is ordinary — only both failing means this video contributes nothing.
 */
export async function fetchTranscript(video: TutorialVideo): Promise<string | null> {
  try {
    const viaApify = await fetchViaApify(video);
    if (viaApify) return viaApify;
    console.warn(`[scriptgen:videos] apify returned nothing for ${video.videoId}, trying yt-api`);
  } catch (e) {
    console.warn(`[scriptgen:videos] apify failed for ${video.videoId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return await fetchViaRapidApi(video);
  } catch (e) {
    console.warn(`[scriptgen:videos] yt-api failed for ${video.videoId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Pure: segments → readable text with a timestamp every ~30 seconds. */
export function formatTranscript(segments: TranscriptSegment[]): string {
  const out: string[] = [];
  let nextStamp = 0;
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const start = Number(seg.start ?? 0);
    if (start >= nextStamp) {
      out.push(`\n[${stamp(start)}] `);
      nextStamp = start + 30;
    }
    out.push(text, " ");
  }
  return out.join("").replace(/[ \t]+/g, " ").trim();
}

/** The videos that had a transcript, in view order. Failures are skipped, not fatal. */
export async function gatherTutorialTranscripts(
  topic: string,
  opts: {
    months?: number;
    count?: number;
    focus?: string;
    brief?: string;
    chat?: ChatFn;
    sinkQueries?: string[];
  } = {},
): Promise<TranscribedVideo[]> {
  const videos = await findTutorialVideos(topic, opts);
  const out: TranscribedVideo[] = [];
  for (const v of videos) {
    try {
      const transcript = await fetchTranscript(v);
      if (transcript && transcript.length > 400) out.push({ ...v, transcript });
    } catch {
      // A video without captions is a gap in the sheet, not a failed run.
    }
  }
  return out;
}

/** The block handed to the extractor: each transcript under its own heading. */
export function transcriptsBlock(videos: TranscribedVideo[]): string {
  return videos
    .map(
      (v, i) =>
        `### VIDEO ${i + 1} — ${v.title}\n` +
        `Channel: ${v.channel} · Published: ${v.publishedAt} · ${v.views.toLocaleString()} views · ${stamp(v.seconds)} long\n` +
        `URL: ${v.url}\n\n${v.transcript}`,
    )
    .join("\n\n---\n\n");
}
