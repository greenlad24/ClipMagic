/**
 * AI News Stream — HTTP surface.
 *
 *   POST /api/news/<fn>          JSON in, JSON out (behind the Lab sign-in)
 *   POST /api/news/<fn>          for collectNews / buildDeckFromStories the
 *                                response is NDJSON: {"chunk": "<progress>"}
 *                                lines while it runs, then one {"result": …}
 *                                or {"error": "…"} line.
 *   GET  /news-follow/state      PUBLIC — a follower device's read of ONE live
 *                                session (see `followerRouter`).
 *
 * Each handler mirrors one of the app's original functions, with the same
 * inputs, outputs and rules (controller enforcement, server-stamped revisions).
 */
import express, { type Request, type Response } from "express";
import {
  stories,
  decks,
  slides,
  sessions,
  slideStats,
  sourceCache,
  latestOpenSession,
  lastTeleprompterSettings,
  todayDate,
  type SessionRecord,
} from "./db.js";
import { collectNews } from "./collect.js";
import { anthropicConfigured } from "../ai/claude.js";
import { getBraveSearchApiKey, getNewsApiOrgKey, getGNewsApiKey, getDataForSeoCreds } from "../settings/postizSecrets.js";
import { buildDeckFromStories, buildStagesForDeck } from "./deck.js";
import { findSlideVideo as findSlideVideoFor, findDeckVideos as findDeckVideosFor, setSlideVideo as setSlideVideoFor, streamSlideVideo } from "./video.js";
import { Readable } from "node:stream";
import { db } from "../db/index.js";
import {
  deepDives,
  deepDiveSections,
  sectionsOf,
  sectionOut,
  deepDiveOut,
  templateInput,
  reconcile,
  isGenerating,
  normalizeData,
  generateDeepDive as generateDeepDiveV1,
  setSectionVideo,
  SECTION_KINDS,
  NO_VISUAL,
  type SectionKind,
} from "./deepDive.js";
import { assetDir, removeAssets, ASSET_FILE_RE, type Visual } from "./deepDiveVisuals.js";
import { MEDIA_FILE_RE } from "./deepDiveMedia.js";
import { deepDiveFollowerSlides } from "./deepDiveFollow.js";
import { activeForToken, followSessionEnded, followToken, liveKey, rotateFollowToken, setFollowActive as markFollowActive } from "./followChannel.js";
import { generateDeepDiveV2, mediaChoices, editChapter } from "./deepDiveV2.js";
import { startDemoJob, latestDemoJob, liveDemoState, attachDemoToDive } from "./deepDiveDemo.js";

/** v2 dives (format "v2") build the demo-first chapter show; v1 dives keep the slide deck. */
const generateDeepDive = (write: (chunk: string) => void | Promise<void>, input: { id?: string; fresh?: boolean }) =>
  (deepDives.get(String(input?.id ?? ""))?.format === "v2" ? generateDeepDiveV2(write, input) : generateDeepDiveV1(write, input));
import path from "node:path";
import { newsTemplateInput } from "./newsTemplates.js";
import { SHOT_FILE_RE, shotDir } from "./sourceShot.js";

type Handler = (input: any) => Promise<unknown> | unknown;

const bool = (v: unknown) => v === true;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function need(v: string | undefined, name: string): string {
  if (!v) throw Object.assign(new Error(`${name} is required.`), { status: 400 });
  return v;
}

/* ── stories ──────────────────────────────────────────────────────────────── */

const getStories: Handler = (input) => {
  const today = str(input?.date) ?? todayDate();
  const records = stories.where("deck_date = ?", today);
  const sorted = [...records].sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
  const list = sorted.map((r) => {
    let blogSources: { company: string; url: string; title: string; isOfficial: boolean }[] = [];
    let articleSources: { outlet: string; url: string; title: string }[] = [];
    try { blogSources = JSON.parse(r.blogSources || "[]"); } catch {}
    try { articleSources = JSON.parse(r.articleSources || "[]"); } catch {}
    return {
      id: r.id,
      headline: r.headline || "",
      status: r.status || "Unconfirmed",
      compositeScore: r.compositeScore ?? 0,
      majorOutletCount: r.sourceCount ?? 0, // sourceCount stores the major-outlet count
      sourceCount: r.sourceCount ?? 0,
      firstSeenAt: r.firstSeenAt || new Date().toISOString(),
      summary: r.summary || "",
      hasOfficialBlog: r.hasOfficialBlog ?? false,
      blogSources,
      articleSources,
      addedToDeck: r.addedToDeck ?? false,
      deckDate: r.deckDate || today,
      category: r.category || "",
    };
  });
  return {
    stories: list,
    meta: {
      total: list.length,
      verified: list.filter((s) => s.status === "Verified").length,
      likely: list.filter((s) => s.status === "Likely").length,
      unconfirmed: list.filter((s) => s.status === "Unconfirmed" || s.status === "Single Source").length,
      addedToDeck: list.filter((s) => s.addedToDeck).length,
      deckDate: today,
    },
  };
};

/** The teleprompter settings the next show will open with (for the dashboard to show). */
const getTeleprompterSettings: Handler = () => {
  const s = lastTeleprompterSettings();
  return { fontSize: s.tpFontSize, lineHeight: s.tpLineHeight, width: s.tpWidth, speed: s.tpSpeed };
};

const toggleStoryInDeck: Handler = (input) => {
  const storyId = need(str(input?.storyId), "storyId");
  const addedToDeck = bool(input?.addedToDeck);
  stories.update(storyId, { addedToDeck });
  return { success: true, storyId, addedToDeck };
};

const clearCache: Handler = () => ({ success: true, cleared: sourceCache.clear() });

/* ── deck + slides ────────────────────────────────────────────────────────── */

const getSlides: Handler = (input) => {
  const deckId = str(input?.deckId);
  const deck = deckId
    ? decks.get(deckId)
    : decks.where("deck_date = ? ORDER BY created_at DESC LIMIT 1", todayDate())[0];
  if (!deck) return { deck: null, slides: [] };
  const list = slides
    .where("deck_id = ? AND (deleted IS NULL OR deleted = 0)", deck.id)
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  return { deck, slides: list };
};

/**
 * The deck's design template (Jake, 2026-10-06: "the deck itself will look like
 * the deep dive presentation, with all of the templates that I can choose").
 * Design only, so it re-skins a built deck at once — no rebuild. The screens
 * read it with getDeckTemplate (cheap; they poll it).
 */
const deckFor = (deckId?: string) => (deckId
  ? decks.get(deckId)
  : decks.where("deck_date = ? ORDER BY created_at DESC LIMIT 1", todayDate())[0]);

const getDeckTemplate: Handler = (input) => {
  const deck = deckFor(str(input?.deckId));
  return { deckId: deck?.id ?? null, template: deck?.template ?? "" };
};

const setDeckTemplate: Handler = (input) => {
  const deck = deckFor(str(input?.deckId));
  if (!deck) throw Object.assign(new Error("No deck yet — build the presentation first."), { status: 400 });
  const template = newsTemplateInput(input?.template);
  if (template === undefined) throw Object.assign(new Error("Unknown template."), { status: 400 });
  decks.update(deck.id, { template });
  return { deckId: deck.id, template };
};

const updateSlide: Handler = (input) => {
  const slideId = need(str(input?.slideId), "slideId");
  const record: Record<string, unknown> = {};
  if (input.favorited !== undefined) record.favorited = bool(input.favorited);
  if (input.deleted !== undefined) record.deleted = bool(input.deleted);
  if (input.whyItMatters !== undefined) record.whyItMatters = String(input.whyItMatters);
  if (input.keyPoints !== undefined) record.keyPoints = String(input.keyPoints);
  if (input.talkingAngle !== undefined) record.talkingAngle = String(input.talkingAngle);
  if (num(input.suggestedTimeSeconds) !== undefined) record.suggestedTimeSeconds = input.suggestedTimeSeconds;
  if (num(input.position) !== undefined) record.position = input.position;
  const notesChanged = input.whyItMatters !== undefined || input.keyPoints !== undefined || input.talkingAngle !== undefined;
  if (notesChanged) record.notesEditedAt = new Date().toISOString();
  if (Object.keys(record).length > 0) slides.update(slideId, record);
  return { success: true };
};

const reorderSlides: Handler = (input) => {
  const ids: string[] = Array.isArray(input?.slideIds) ? input.slideIds.map(String) : [];
  ids.forEach((id, index) => slides.update(id, { position: index + 1 }));
  return { success: true };
};

/**
 * The on-screen stage (stage.ts) for slides that have none — a deck built
 * before stages existed — keeping its scripts, notes and videos. `force`
 * redoes every slide's stage. Default deck: today's.
 */
const buildSlideStages: Handler = async (input) => {
  const deckId = str(input?.deckId) ?? decks.where("deck_date = ? ORDER BY created_at DESC LIMIT 1", todayDate())[0]?.id;
  if (!deckId) return { built: 0, failed: 0, skipped: 0 };
  return buildStagesForDeck(deckId, bool(input?.force));
};

/* ── official release video (video.ts) ─────────────────────────────────────── */

/** Re-run the search for one slide. */
const findSlideVideo: Handler = async (input) => {
  const { slide, result } = await findSlideVideoFor(need(str(input?.slideId), "slideId"));
  return { slide, videoId: result.videoId, kind: result.kind ?? null, tier: result.tier ?? null, reason: result.reason, checked: result.checked, candidates: result.candidates, quotaUnits: result.units };
};

/** Re-run it for every slide of a deck (default: today's). */
const findDeckVideos: Handler = async (input) => {
  const deckId = str(input?.deckId) ?? decks.where("deck_date = ? ORDER BY created_at DESC LIMIT 1", todayDate())[0]?.id;
  if (!deckId) return { found: 0, checked: 0, units: 0 };
  return findDeckVideosFor(deckId);
};

/** Jake's override: `videoId` = a YouTube id/link, a Vimeo link or a direct .mp4/.webm link; null removes the video. */
const setSlideVideo: Handler = async (input) => {
  const slideId = need(str(input?.slideId), "slideId");
  const v = input?.videoId;
  const slide = await setSlideVideoFor(slideId, typeof v === "string" ? v : null);
  return { success: true, slide };
};

/* ── live session ─────────────────────────────────────────────────────────── */

const startSession: Handler = (input) => {
  const deckId = need(str(input?.deckId), "deckId");
  const controllerId = str(input?.controllerId);
  const serverTime = Date.now();

  const open = latestOpenSession(deckId);
  if (open) {
    // Claim control if no controller is set yet.
    if (controllerId && !open.tpControllerId) sessions.update(open.id, { tpControllerId: controllerId });
    return { sessionId: open.id, isNew: false, serverTime };
  }

  // New session — autoscroll OFF, paused, scroll at top; look and speed carry
  // over from the last show.
  const carried = lastTeleprompterSettings();
  const session = sessions.insert({
    startedAt: new Date().toISOString(),
    deck: deckId,
    currentSlideIndex: 0,
    blackout: false,
    tpPaused: true,
    tpAutoscroll: false,
    tpScrollPct: 0,
    tpSpeed: carried.tpSpeed,
    tpRevision: 0,
    tpAnchorAt: serverTime,
    tpControllerId: controllerId || null,
    tpFontSize: carried.tpFontSize,
    tpLineHeight: carried.tpLineHeight,
    tpWidth: carried.tpWidth,
    tpCountdown: 3,
  });
  return { sessionId: session.id, isNew: true, serverTime };
};

const getSession: Handler = (input) => {
  const serverTime = Date.now();
  const sessionId = str(input?.sessionId);
  if (sessionId) return { session: sessions.get(sessionId) ?? null, serverTime };
  return { session: latestOpenSession(str(input?.deckId)) ?? null, serverTime };
};

const SESSION_FIELDS = [
  ["currentSlideIndex", "num"],
  ["blackout", "bool"],
  ["tpScrollPct", "num"],
  ["tpSpeed", "num"],
  ["tpPaused", "bool"],
  ["tpFontSize", "num"],
  ["tpLineHeight", "num"],
  ["tpWidth", "str"],
  ["tpCountdown", "num"],
  ["tpAutoscroll", "bool"],
  ["tpControllerId", "str"],
  ["mediaView", "str"],
  ["currentBeat", "num"],
] as const;

const updateSession: Handler = (input) => {
  const serverTime = Date.now();
  const sessionId = need(str(input?.sessionId), "sessionId");
  const session = sessions.get(sessionId);
  if (!session) return { success: false, serverTime };

  // Controller enforcement — reject writes from non-controller devices.
  // Exception: tpControllerId claims ("take control") are always allowed.
  const deviceId = str(input?.deviceId);
  const isControlClaim = input?.tpControllerId !== undefined;
  if (!isControlClaim && deviceId && session.tpControllerId && session.tpControllerId !== deviceId) {
    return { success: false, serverTime };
  }

  const record: Record<string, unknown> = {};
  for (const [field, kind] of SESSION_FIELDS) {
    const v = input?.[field];
    if (v === undefined) continue;
    if (kind === "num" && num(v) !== undefined) record[field] = v;
    else if (kind === "bool" && typeof v === "boolean") record[field] = v;
    else if (kind === "str" && typeof v === "string") record[field] = v;
  }
  if (record.mediaView !== undefined && record.mediaView !== "video") record.mediaView = "article";

  // The server stamps every write: monotonic seq + anchor time.
  const newSeq = (typeof session.tpRevision === "number" ? session.tpRevision : 0) + 1;
  record.tpRevision = newSeq;
  record.tpAnchorAt = serverTime;
  record.tpUpdatedAt = String(serverTime);
  if (deviceId) record.tpActorId = deviceId;

  sessions.update(sessionId, record);
  return { success: true, seq: newSeq, serverTime };
};

const endSession: Handler = (input) => {
  const sessionId = need(str(input?.sessionId), "sessionId");
  const session = sessions.get(sessionId);
  if (!session) return { success: false };
  sessions.update(sessionId, { endedAt: new Date().toISOString(), blackout: false });
  // The stable follower link was following this show: it now waits for the next one.
  followSessionEnded(sessionId);
  if (session.deck) {
    decks.update(session.deck, {
      presentedAt: new Date().toISOString(),
      totalDurationSeconds: num(input?.totalDurationSeconds) ?? 0,
    });
  }
  return { success: true };
};

/* ── the stable follower link (followChannel.ts) ─────────────────────────── */

/** The one follower link's token — the same link from the AI News and the Deep Dive presenter. */
const getFollowLink: Handler = () => ({ token: followToken() });
/** A new link; every old one stops working. */
const rotateFollowLink: Handler = () => ({ token: rotateFollowToken() });
/** "I'm presenting this session now": the stable link follows it (the last presenter to act wins). */
const setFollowActive: Handler = (input) => ({ success: markFollowActive(need(str(input?.sessionId), "sessionId")) });

const logSlideStats: Handler = (input) => {
  slideStats.insert({
    recordedAt: new Date().toISOString(),
    slide: need(str(input?.slideId), "slideId"),
    session: need(str(input?.sessionId), "sessionId"),
    timeSpentSeconds: num(input?.timeSpentSeconds) ?? 0,
    navigationOrder: num(input?.navigationOrder) ?? 0,
  });
  return { success: true };
};

/**
 * What the show is actually wired to, read live.
 *
 * ⚠️ THE SETTINGS PAGE USED TO STATE THIS FROM MEMORY, AND IT WAS WRONG. It
 * listed Gemini and a Nitter scraper as connected, with a green tick on each;
 * the app used neither. A status panel that cannot be wrong about a key being
 * missing is the whole point of having one — the first run of this tool
 * produced sixty single-source headlines precisely because nothing on screen
 * said the model was unreachable.
 *
 * Reports presence only. No key value ever leaves the server.
 */
const getConnections: Handler = () => ({
  connections: [
    {
      name: "Claude (clustering · summaries · notes · teleprompter scripts)",
      configured: anthropicConfigured(),
      detail: anthropicConfigured()
        ? "Uses the Lab's own Anthropic credentials — no separate key for this app."
        : "No Anthropic credentials on the server. Every AI stage will fall back to raw headlines.",
    },
    {
      name: "Brave Search (widens discovery · corroborating outlets)",
      configured: Boolean(getBraveSearchApiKey()),
      detail: getBraveSearchApiKey()
        ? "Adds ~40 news queries a run on top of the feeds."
        : "Optional. Without it collection still runs on RSS + Google News, but stories are likelier to stay Single Source. Add BRAVE_SEARCH_API_KEY on the Lab's Settings page.",
    },
    {
      name: "NewsAPI.org (extra outlets)",
      configured: Boolean(getNewsApiOrgKey()),
      detail: getNewsApiOrgKey()
        ? "Searched alongside every other source."
        : "Optional. Adds a search across ~150,000 outlets. Their free plan is 100 requests/day on a 24-hour delay.",
    },
    {
      name: "GNews.io (Google News results via API)",
      configured: Boolean(getGNewsApiKey()),
      detail: getGNewsApiKey()
        ? "Searched alongside every other source."
        : "Optional. Google publishes no news API of its own; GNews resells its results. Free tier is 100 requests/day.",
    },
    {
      name: "DataForSEO (Google News SERP)",
      configured: Boolean(getDataForSeoCreds()),
      detail: getDataForSeoCreds()
        ? "Credentials are set — this runs on the same account as the Keyword tool, so it needs a positive balance to return anything."
        : "Optional. Already shares the Keyword tool's login when one is set.",
    },
    {
      name: "Company newsrooms + publication RSS",
      configured: true,
      detail: "Built in — 19 official blogs and 20 publications, no key needed.",
    },
    {
      name: "Google News topic feeds",
      configured: true,
      detail: "Built in — 16 topic feeds, no key needed. Article links are resolved to the publisher.",
    },
  ],
});

/* ── deep dive (deepDive.ts) ───────────────────────────────────────────────── */

const listDeepDives: Handler = () => {
  const rows = deepDives.where("1 = 1 ORDER BY created_at DESC LIMIT 200").map((d) => reconcile(d)!);
  const counts = new Map(
    (db.prepare(`SELECT deep_dive_id AS id, COUNT(*) AS n FROM news_deep_dive_sections GROUP BY deep_dive_id`).all() as { id: string; n: number }[])
      .map((r) => [r.id, r.n]),
  );
  return { deepDives: rows.map((d) => ({ ...deepDiveOut(d), sectionCount: counts.get(d.id) ?? 0 })) };
};

const getDeepDive: Handler = (input) => {
  const id = need(str(input?.id), "id");
  const d = reconcile(deepDives.get(id));
  if (!d) throw Object.assign(new Error("Deep dive not found."), { status: 404 });
  const dj = d.format === "v2" && d.demoAgent ? latestDemoJob(id) : null;
  return {
    deepDive: deepDiveOut(d), sections: sectionsOf(id).map((r) => sectionOut(r, d.format === "v2")), running: isGenerating(id),
    demoJob: dj ? { id: dj.id, status: dj.status, error: dj.error, finishedAt: dj.finishedAt } : null,
  };
};

const createDeepDive: Handler = (input) => {
  const storyId = str(input?.storyId);
  const story = storyId ? stories.get(storyId) : undefined;
  const topic = (str(input?.topic)?.trim() || story?.headline || "").slice(0, 300);
  if (!topic) throw Object.assign(new Error("Type a topic first."), { status: 400 });
  const d = deepDives.insert({
    topic,
    angle: (str(input?.angle) ?? "").trim().slice(0, 2000),
    story: story?.id,
    title: topic,
    status: "draft",
    // v2 = the demo-first chapter show (Jake, 2026-10-02) — the default for new dives.
    format: input?.format === "v1" ? "" : "v2",
    demoAgent: input?.demoAgent === true ? 1 : 0,
    demoUrl: (str(input?.demoUrl) ?? "").trim().slice(0, 500),
    template: templateInput(input?.template) ?? "",
    updatedAt: new Date().toISOString(),
  });
  return { deepDive: deepDiveOut(d) };
};

const updateDeepDive: Handler = (input) => {
  const id = need(str(input?.id), "id");
  const patch: Record<string, unknown> = {};
  for (const [k, max] of [["title", 120], ["subtitle", 200], ["topic", 300], ["angle", 2000]] as const) {
    const v = str(input?.[k]);
    if (v !== undefined) patch[k] = v.slice(0, max);
  }
  if (typeof input?.demoAgent === "boolean") patch.demoAgent = input.demoAgent ? 1 : 0;
  if (str(input?.demoUrl) !== undefined) patch.demoUrl = String(input.demoUrl).trim().slice(0, 500);
  if (input?.format === "v1" || input?.format === "v2") patch.format = input.format === "v2" ? "v2" : "";
  if (templateInput(input?.template) !== undefined) patch.template = templateInput(input?.template);
  if (Object.keys(patch).length) deepDives.update(id, { ...patch, updatedAt: new Date().toISOString() });
  return { success: true };
};

const deleteDeepDive: Handler = (input) => {
  const id = need(str(input?.id), "id");
  if (isGenerating(id)) throw Object.assign(new Error("Wait for the generation to finish first."), { status: 400 });
  for (const sec of sectionsOf(id)) deepDiveSections.remove(sec.id);
  deepDives.remove(id);
  removeAssets(id);
  return { success: true };
};

const updateDeepDiveSection: Handler = (input) => {
  const sectionId = need(str(input?.sectionId), "sectionId");
  const sec = deepDiveSections.get(sectionId);
  if (!sec) throw Object.assign(new Error("Section not found."), { status: 404 });
  const patch: Record<string, unknown> = {};
  if (str(input?.heading) !== undefined) patch.heading = input.heading.slice(0, 120);
  if (str(input?.eyebrow) !== undefined) patch.eyebrow = input.eyebrow.slice(0, 40);
  if (str(input?.script) !== undefined) patch.script = input.script.slice(0, 20000);
  if (input?.data !== undefined && deepDives.get(sec.deepDive ?? "")?.format !== "v2") {
    const kind = (SECTION_KINDS as readonly string[]).includes(sec.kind ?? "") ? (sec.kind as SectionKind) : "statement";
    patch.dataJson = JSON.stringify(normalizeData(kind, input.data));
  }
  // A visual from the dive's own pool ("" removes it).
  if (str(input?.visualId) !== undefined) {
    if (!input.visualId) patch.visualJson = "";
    else {
      if (NO_VISUAL.has(sec.kind as SectionKind)) throw Object.assign(new Error("This kind of section has no room for a visual."), { status: 400 });
      let pool: Visual[] = [];
      try { pool = JSON.parse(deepDives.get(sec.deepDive ?? "")?.visualsJson || "[]"); } catch { /* none */ }
      const v = pool.find((x) => x.id === input.visualId);
      if (!v) throw Object.assign(new Error("That visual isn't in this deep dive's pool."), { status: 400 });
      patch.visualJson = JSON.stringify(v);
    }
  }
  if (Object.keys(patch).length) {
    deepDiveSections.update(sectionId, patch);
    if (sec.deepDive) deepDives.update(sec.deepDive, { updatedAt: new Date().toISOString() });
  }
  const out = deepDiveSections.get(sectionId)!;
  return { section: sectionOut(out, deepDives.get(out.deepDive ?? "")?.format === "v2") };
};

const deleteDeepDiveSection: Handler = (input) => {
  const sectionId = need(str(input?.sectionId), "sectionId");
  deepDiveSections.remove(sectionId);
  return { success: true };
};

const reorderDeepDiveSections: Handler = (input) => {
  const ids: string[] = Array.isArray(input?.sectionIds) ? input.sectionIds.map(String) : [];
  db.transaction(() => ids.forEach((id, i) => deepDiveSections.update(id, { position: i + 1 })))();
  return { success: true };
};

const setDeepDiveSectionVideo: Handler = (input) => {
  const sectionId = need(str(input?.sectionId), "sectionId");
  const v = input?.video;
  const sec = setSectionVideo(sectionId, typeof v === "string" ? v : null);
  return { section: sec ? sectionOut(sec) : null };
};

/* ── routing ──────────────────────────────────────────────────────────────── */

/** v2 demo agent: record again now (toggle on), run it live from the stage, watch a run. */
const recordDeepDiveDemo: Handler = (input) => ({ jobId: startDemoJob(need(str(input?.id), "id")).id });
const startLiveDeepDiveDemo: Handler = (input) => ({ jobId: startDemoJob(need(str(input?.id), "id"), true).id });
const getLiveDeepDiveDemo: Handler = (input) => liveDemoState(need(str(input?.jobId), "jobId"));
const attachDeepDiveDemo: Handler = async (input) => {
  const id = need(str(input?.id), "id");
  const job = latestDemoJob(id);
  if (!job || job.status !== "done") throw Object.assign(new Error("No finished demo recording for this deep dive yet."), { status: 400 });
  return attachDemoToDive(id, job.id);
};

const HANDLERS: Record<string, Handler> = {
  getDeepDiveMedia: (input) => mediaChoices(need(str(input?.id), "id")),
  editDeepDiveChapter: async (input) => {
    const sectionId = need(str(input?.sectionId), "sectionId");
    await editChapter(sectionId, input?.edit);
    const sec = deepDiveSections.get(sectionId)!;
    return { section: sectionOut(sec, true) };
  },
  recordDeepDiveDemo,
  startLiveDeepDiveDemo,
  getLiveDeepDiveDemo,
  attachDeepDiveDemo,
  getConnections,
  getStories,
  getTeleprompterSettings,
  toggleStoryInDeck,
  clearCache,
  getSlides,
  getDeckTemplate,
  setDeckTemplate,
  updateSlide,
  reorderSlides,
  startSession,
  getSession,
  updateSession,
  endSession,
  getFollowLink,
  rotateFollowLink,
  setFollowActive,
  logSlideStats,
  findSlideVideo,
  findDeckVideos,
  setSlideVideo,
  buildSlideStages,
  listDeepDives,
  getDeepDive,
  createDeepDive,
  updateDeepDive,
  deleteDeepDive,
  updateDeepDiveSection,
  deleteDeepDiveSection,
  reorderDeepDiveSections,
  setDeepDiveSectionVideo,
};

type Streamer = (write: (chunk: string) => void, input: any) => Promise<unknown>;
const STREAMERS: Record<string, Streamer> = {
  collectNews,
  buildDeckFromStories: (write, input) => {
    const template = input?.template === undefined ? undefined : newsTemplateInput(input.template);
    if (input?.template !== undefined && template === undefined) throw Object.assign(new Error("Unknown template."), { status: 400 });
    return buildDeckFromStories(write, { template });
  },
  generateDeepDive,
};

/**
 * One run of each long job at a time. A second click (or a second tab) while
 * collection is running would delete and re-insert today's stories underneath
 * the first run.
 */
const running = new Set<string>();

export const newsRouter = express.Router();

/**
 * A slide's video FILE, streamed through the Lab when its CDN blocks
 * hotlinking. Serves only the URL stored on that slide (see
 * `streamSlideVideo`) — not an open proxy — and sits behind the sign-in like
 * every /api/news route. Range requests pass through so the player can loop.
 */
newsRouter.get("/video-file/:slideId", async (req: Request, res: Response) => {
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  try {
    const out = await streamSlideVideo(String(req.params.slideId), req.headers.range, ac.signal);
    if ("error" in out) { res.status(out.status).json({ error: { message: out.error } }); return; }
    res.status(out.status);
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    if (!out.body) { res.end(); return; }
    Readable.fromWeb(out.body as any).on("error", () => res.destroy()).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: { message: err instanceof Error ? err.message : String(err) } });
    else res.destroy();
  }
});

/**
 * A deep dive's stored visual (screenshot, GIF, video file) — see
 * deepDiveVisuals.ts. Signed-in like every /api/news route; only names the
 * gatherer itself writes are served, so no path can leave the dive's folder.
 */
newsRouter.get("/dd-asset/:dive/:file", (req: Request, res: Response) => {
  const dive = String(req.params.dive);
  const file = String(req.params.file);
  if (!/^[0-9a-f-]{36}$/i.test(dive) || !(ASSET_FILE_RE.test(file) || MEDIA_FILE_RE.test(file))) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, max-age=86400");
  // sendFile answers Range requests (206) itself — the clip player seeks.
  const type = file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".webm") ? "video/webm" : file.endsWith(".gif") ? "image/gif" : "image/jpeg";
  res.sendFile(path.join(assetDir(dive), file), { headers: { "Content-Type": type, "Accept-Ranges": "bytes" } }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

/**
 * A story's captured source page (sourceShot.ts) — the full-screen scroll that
 * opens each story. Signed-in like every /api/news route; only names the
 * capture itself writes are served.
 */
newsRouter.get("/source-shot/:file", (req: Request, res: Response) => {
  const file = String(req.params.file);
  if (!SHOT_FILE_RE.test(file)) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(path.join(shotDir(), file), { headers: { "Content-Type": "image/jpeg" } }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

newsRouter.post("/:fn", express.json({ limit: "2mb" }), async (req: Request, res: Response) => {
  const fn = req.params.fn;
  const streamer = STREAMERS[fn];
  if (streamer) {
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const line = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");
    // Deep dives are one run per dive, not one run overall.
    const key = fn === "generateDeepDive" ? `${fn}:${String(req.body?.id ?? "")}` : fn;
    if (running.has(key)) {
      line({ error: "Already running — wait for the current run to finish." });
      res.end();
      return;
    }
    running.add(key);
    try {
      const result = await streamer((chunk) => line({ chunk }), req.body ?? {});
      line({ result });
    } catch (err) {
      console.error(`[news] ${fn} failed:`, err);
      line({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      running.delete(key);
      res.end();
    }
    return;
  }

  const handler = HANDLERS[fn];
  if (!handler) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `Unknown function ${fn}` } });
    return;
  }
  try {
    res.json(await handler(req.body ?? {}));
  } catch (err: any) {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 500) console.error(`[news] ${fn} failed:`, err);
    res.status(status).json({ error: { code: status === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR", message: err?.message ?? String(err) } });
  }
});

/* ── public follower feed ─────────────────────────────────────────────────── */

/**
 * What a follower device (phone/tablet teleprompter) may read, WITHOUT signing
 * in — the app has always treated the follower link as its own key.
 *
 * Deliberately narrow: ONE session, found by its id (a random UUID, so the link
 * cannot be guessed), and only while it is live. It returns the session's
 * display state and the scripts of that session's own deck — never stories,
 * notes, sources or any other deck — and it is read-only.
 *
 * A Deep Dive's session (Jake, 2026-10-06) reads the same way: its deck id is
 * the dive's id, and it gets that dive's per-section label, beat count and
 * script parts only (deepDiveFollow.ts) — no research, sources or media.
 */
const FOLLOWER_SESSION_FIELDS: (keyof SessionRecord)[] = [
  "id", "currentSlideIndex", "endedAt", "tpRevision", "tpScrollPct", "tpSpeed", "tpPaused",
  "tpFontSize", "tpLineHeight", "tpWidth", "tpCountdown", "tpAutoscroll",
];

export const followerRouter = express.Router();

/**
 * The cue marks + beat titles of each story's script, for the follower page
 * (Jake, 2026-10-07: beat titles in the teleprompter, the story's last cue in
 * its own colour). Computed by THE PRESENTER'S OWN CODE — lab/src/news/daily/
 * stage/cueMarks.ts, bundled to dist/news/cue-marks.js at build time
 * (scripts/build-pipeline.mjs) — so both screens mark the same words. A
 * missing bundle (a dev run without the build) just means no marks: the
 * script still reads, exactly as before.
 */
type CueMarkOut = { start: number; end: number; beat: number; title: string; last: boolean; mark: string };
let cueMarksMod: Promise<{ cueMarks: (slide: unknown, nextTitle: string | null) => CueMarkOut[] } | null> | null = null;
function loadCueMarks() {
  if (!cueMarksMod) {
    const file = new URL("./cue-marks.js", import.meta.url).href;
    cueMarksMod = import(file).catch((e) => {
      console.warn("[news-follow] cue marks unavailable:", (e as Error).message);
      return null;
    });
  }
  return cueMarksMod;
}

followerRouter.get("/state", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  // The stable link (?live=<token>): the server resolves which session is
  // active — the page never names one. Wrong / rotated token → 404 revoked;
  // nothing live → 200 waiting.
  const liveToken = typeof req.query.live === "string" ? req.query.live : "";
  let id = String(req.query.session ?? "");
  if (liveToken) {
    const active = activeForToken(liveToken);
    if (active === undefined) { res.status(404).json({ session: null, revoked: true, serverTime: Date.now() }); return; }
    if (!active) { res.json({ session: null, waiting: true, serverTime: Date.now() }); return; }
    id = active;
  }
  const withSlides = req.query.slides === "1";
  const session = /^[0-9a-f-]{36}$/i.test(id) ? sessions.get(id) : undefined;
  if (!session || session.endedAt) {
    res.status(404).json({ session: null, serverTime: Date.now() });
    return;
  }
  const safe: Record<string, unknown> = {};
  for (const k of FOLLOWER_SESSION_FIELDS) if (session[k] !== undefined) safe[k] = session[k];
  // On the stable link the session id is not handed out — only an opaque key that changes with it.
  if (liveToken) delete safe.id;
  const out: Record<string, unknown> = { session: safe, serverTime: Date.now() };
  if (liveToken) out.liveKey = liveKey(liveToken, session.id);
  // A Deep Dive's live session (its deck id is the dive's id): that dive's
  // scripts per beat, nothing else — see deepDiveFollow.ts.
  const dive = withSlides && session.deck && !decks.get(session.deck) ? deepDiveFollowerSlides(session.deck) : null;
  if (dive) {
    out.kind = "deep-dive";
    out.title = dive.title;
    out.sections = dive.sections;
    out.slides = dive.sections.map((x) => ({ id: x.id, bestSourceName: "", teleprompterScript: x.parts.join("\n\n") }));
  } else if (withSlides && session.deck) {
    const rows = slides
      .where("deck_id = ? AND (deleted IS NULL OR deleted = 0)", session.deck)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    const mod = await loadCueMarks();
    out.slides = rows.map((s, i) => {
      // Only the marks leave the server (positions in the script + the beat titles,
      // which are the slides' on-screen headings) — never the stage, notes or sources.
      let cues: CueMarkOut[] = [];
      try { cues = mod ? mod.cueMarks(s, rows[i + 1]?.topicLabel ?? null) : []; } catch { cues = []; }
      return { id: s.id, bestSourceName: s.bestSourceName ?? "", teleprompterScript: s.teleprompterScript ?? "", cues };
    });
  }
  res.json(out);
});


/**
 * ⚠️ A DEPLOY RESTARTS THE SERVER, AND A DEEP DIVE GENERATING AT THAT MOMENT USED TO
 * FAIL ("Generation was interrupted…", 2026-10-07). On boot, every dive still marked
 * "generating" is started again here — before any request can reconcile it into an
 * error. The pipeline saves each stage as it lands, so this resumes rather than
 * repaying the research. Each start registers itself synchronously.
 */
try {
  for (const d of deepDives.where("status = 'generating'")) {
    console.log(`[news-deepdive] resuming "${d.title || d.topic}" after a restart`);
    void generateDeepDive(() => {}, { id: d.id }).catch((err) => console.warn("[news-deepdive] resume failed:", err?.message ?? err));
  }
} catch (err) {
  console.warn("[news-deepdive] could not check for interrupted deep dives:", err);
}
