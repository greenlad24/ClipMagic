/**
 * Unit checks for the Auto-Screencast engine. EVERYTHING is injected — no
 * network, no Chromium, no ffmpeg, no DB. We test the four pure/seamed pieces:
 *
 *   - ffmpeg scroll/zoom ARG BUILDERS (bounded crop y-expr, duration, 9:16)
 *   - chooseSynthesis (scroll vs zoom from page height)
 *   - the PLANNER shaping (word-timing alignment, overlap avoidance, clip-length
 *     clamping, drop-on-invalid-URL, alt-URL fallback, max-moments cap)
 *   - the URL validator (status/content-type logic, HEAD→GET fallback)
 *   - the ORCHESTRATION upsert shape + per-item isolation (mocked store/capture)
 *
 * Run: cd lab/server && npx tsx src/scripts/screencast.test.ts
 */
import assert from "node:assert/strict";
import {
  buildScrollArgs,
  buildZoomArgs,
  chooseSynthesis,
  VIDEO_W,
  VIDEO_H,
  FPS,
  type SynthArgs,
} from "../capture/screencast.js";
import {
  planScreencasts,
  parseRawMoments,
  shapeTiming,
  snippetFor,
  buildPlannerPrompt,
  MIN_CLIP_SEC,
  MAX_CLIP_SEC,
  type PlannerWord,
  type RawMoment,
} from "../capture/planner.js";
import { validateUrlReachable } from "../capture/validateUrl.js";
import { autoScreencast, wordsFromSubtitles, buildScreencastLabels } from "../capture/autoScreencast.js";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((e) => {
      console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
      process.exitCode = 1;
    });
}

// A small word grid: one word per 0.5s for 30s.
function grid(n = 60): PlannerWord[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `w${i}`,
    start: i * 0.5,
    end: i * 0.5 + 0.45,
  }));
}

async function main() {
  // ── ffmpeg arg builders ────────────────────────────────────────────────────
  await check("buildScrollArgs: bounded crop y-expr, correct size/fps/duration", () => {
    const a: SynthArgs = { imagePath: "/tmp/x.png", imageHeight: 5400, durationSec: 6, outPath: "/tmp/o.mp4" };
    const args = buildScrollArgs(a);
    const vf = args[args.indexOf("-vf") + 1];
    // crop window is exactly 1080x1920 at x=0
    assert.ok(vf.startsWith(`crop=${VIDEO_W}:${VIDEO_H}:0:`), vf);
    // maxY = 5400-1920 = 3480; the y-expr must clamp with min(maxY, …)
    assert.ok(vf.includes("min(3480"), vf);
    assert.ok(vf.includes("*t/6"), vf);
    assert.ok(vf.includes("format=yuv420p"));
    // duration + fps + codec present
    assert.equal(args[args.indexOf("-t") + 1], "6");
    assert.equal(args[args.indexOf("-r") + 1], String(FPS));
    assert.ok(args.includes("libx264"));
    assert.equal(args[args.length - 1], "/tmp/o.mp4");
  });

  await check("buildScrollArgs: y-expr never exceeds image height (maxY=0 when short)", () => {
    const a: SynthArgs = { imagePath: "/tmp/x.png", imageHeight: VIDEO_H, durationSec: 5, outPath: "/tmp/o.mp4" };
    const vf = buildScrollArgs(a)[buildScrollArgs(a).indexOf("-vf") + 1];
    // image == viewport → maxY 0 → window pinned at top, no overscroll possible
    assert.ok(vf.includes("min(0\\,0*t/5)") || vf.includes("min(0\\,0*t/5"), vf);
  });

  await check("buildZoomArgs: zoompan to 1080x1920 with subtle push", () => {
    const a: SynthArgs = { imagePath: "/tmp/x.png", imageHeight: 1900, durationSec: 5, outPath: "/tmp/o.mp4" };
    const args = buildZoomArgs(a);
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("zoompan="), vf);
    assert.ok(vf.includes(`s=${VIDEO_W}x${VIDEO_H}`), vf);
    assert.ok(vf.includes("min(1.08"), vf); // capped zoom
    assert.ok(vf.includes("format=yuv420p"));
  });

  await check("chooseSynthesis: tall → scroll, short → zoom", () => {
    assert.equal(chooseSynthesis(5400), "scroll");
    assert.equal(chooseSynthesis(VIDEO_H), "zoom"); // no extra height
    assert.equal(chooseSynthesis(VIDEO_H + 50), "zoom"); // below SCROLL_MIN_EXTRA
    assert.equal(chooseSynthesis(VIDEO_H + 500), "scroll");
  });

  // ── planner: parsing + shaping ──────────────────────────────────────────────
  await check("parseRawMoments: coerces + drops non-http/garbage", () => {
    const raw = parseRawMoments(JSON.stringify({
      moments: [
        { startSec: 5, endSec: 9, url: "https://a.com", confidence: 0.9 },
        { startSec: 1, endSec: 2, url: "ftp://nope" },      // non-http → dropped
        { startSec: "x", endSec: 9, url: "https://b.com" }, // bad time → dropped
        { url: "https://c.com" },                            // no times → dropped
      ],
    }));
    assert.equal(raw.length, 1);
    assert.equal(raw[0].url, "https://a.com");
  });

  await check("shapeTiming: clamps to [MIN,MAX] clip and word-aligns", () => {
    const words = grid();
    const m: RawMoment = { startSec: 5.2, endSec: 30, url: "https://a.com", query: "", reason: "", confidence: 1 };
    const t = shapeTiming(m, words, 30)!;
    assert.ok(t, "should fit");
    assert.ok(t.endSec - t.startSec <= MAX_CLIP_SEC + 1e-6);
    assert.ok(t.endSec - t.startSec >= MIN_CLIP_SEC - 1e-6);
    // word-aligned: start sits on a word boundary (0.5 grid)
    assert.ok(Math.abs((t.startSec * 2) - Math.round(t.startSec * 2)) < 1e-6, `start ${t.startSec} not aligned`);
  });

  await check("shapeTiming: returns null when no room before tail buffer", () => {
    const words = grid();
    // duration 4s, head 1 + min clip 3 + tail 1.5 doesn't fit
    const m: RawMoment = { startSec: 3.5, endSec: 4, url: "https://a.com", query: "", reason: "", confidence: 1 };
    assert.equal(shapeTiming(m, words, 4), null);
  });

  await check("snippetFor: returns the spoken words in range", () => {
    const words: PlannerWord[] = [
      { text: "check", start: 5, end: 5.4 },
      { text: "out", start: 5.5, end: 5.8 },
      { text: "Linear", start: 6, end: 6.6 },
      { text: "today", start: 9, end: 9.5 },
    ];
    assert.equal(snippetFor(words, 5, 7), "check out Linear");
  });

  await check("buildPlannerPrompt: embeds duration, transcript, max + word timings", () => {
    const p = buildPlannerPrompt({ transcript: "hello world", words: grid(4), durationSeconds: 30, maxMoments: 2 });
    assert.ok(p.user.includes("30.0s"));
    assert.ok(p.user.includes("at most 2"));
    assert.ok(p.user.includes("hello world"));
    assert.ok(p.user.includes("WORD TIMINGS"));
    assert.ok(p.system.includes("screencast") || p.system.toLowerCase().includes("website"));
  });

  // ── planner: full plan with injected AI + validator ─────────────────────────
  await check("planScreencasts: valid URL → planned with aligned timing + snippet", async () => {
    const words = grid();
    const res = await planScreencasts({
      transcript: "see the MIT study",
      words,
      durationSeconds: 30,
      shots: [],
      askModel: async () => JSON.stringify({ moments: [{ startSec: 6, endSec: 11, url: "https://mit.edu", query: "MIT study", reason: "MIT study", confidence: 0.9 }] }),
      validateUrl: async () => true,
    });
    assert.equal(res.planned.length, 1);
    assert.equal(res.planned[0].url, "https://mit.edu");
    assert.ok(res.planned[0].transcriptSnippet.length > 0);
  });

  await check("planScreencasts: invalid URL with no alt → DROPPED (no fallback)", async () => {
    const res = await planScreencasts({
      transcript: "x", words: grid(), durationSeconds: 30, shots: [],
      askModel: async () => JSON.stringify({ moments: [{ startSec: 6, endSec: 11, url: "https://dead.example", confidence: 0.9 }] }),
      validateUrl: async () => false,
    });
    assert.equal(res.planned.length, 0);
    assert.ok(res.skipped.some(s => /no working page/i.test(s.reason)));
  });

  await check("planScreencasts: primary fails, ALT succeeds → uses alt", async () => {
    const res = await planScreencasts({
      transcript: "x", words: grid(), durationSeconds: 30, shots: [],
      askModel: async () => JSON.stringify({ moments: [{ startSec: 6, endSec: 11, url: "https://bad", altUrl: "https://good", confidence: 0.9 }] }),
      validateUrl: async (u) => u === "https://good",
    });
    assert.equal(res.planned.length, 1);
    assert.equal(res.planned[0].url, "https://good");
  });

  await check("planScreencasts: skips moments overlapping an existing non-TH shot", async () => {
    const res = await planScreencasts({
      transcript: "x", words: grid(), durationSeconds: 30,
      shots: [{ shotType: "B-Roll", startTime: 5, endTime: 12 }],
      askModel: async () => JSON.stringify({ moments: [{ startSec: 6, endSec: 11, url: "https://a.com", confidence: 0.9 }] }),
      validateUrl: async () => true,
    });
    assert.equal(res.planned.length, 0);
    assert.ok(res.skipped.some(s => /overlap/i.test(s.reason)));
  });

  await check("planScreencasts: caps at maxMoments and keeps highest confidence", async () => {
    const res = await planScreencasts({
      transcript: "x", words: grid(), durationSeconds: 60, shots: [], maxMoments: 1,
      askModel: async () => JSON.stringify({ moments: [
        { startSec: 6, endSec: 10, url: "https://lo.com", confidence: 0.3 },
        { startSec: 20, endSec: 24, url: "https://hi.com", confidence: 0.95 },
      ] }),
      validateUrl: async () => true,
    });
    assert.equal(res.planned.length, 1);
    assert.equal(res.planned[0].url, "https://hi.com");
  });

  await check("planScreencasts: two planned moments never overlap each other", async () => {
    const res = await planScreencasts({
      transcript: "x", words: grid(), durationSeconds: 60, shots: [], maxMoments: 3,
      askModel: async () => JSON.stringify({ moments: [
        { startSec: 6, endSec: 12, url: "https://a.com", confidence: 0.9 },
        { startSec: 7, endSec: 13, url: "https://b.com", confidence: 0.8 }, // overlaps a
      ] }),
      validateUrl: async () => true,
    });
    // second overlaps the first kept one → dropped
    assert.equal(res.planned.length, 1);
  });

  // ── URL validator ───────────────────────────────────────────────────────────
  await check("validateUrlReachable: 200 text/html → true (HEAD)", async () => {
    const fetchImpl = async () => ({ status: 200, headers: { get: () => "text/html; charset=utf-8" } }) as any;
    assert.equal(await validateUrlReachable("https://a.com", fetchImpl as any), true);
  });

  await check("validateUrlReachable: 404 → false", async () => {
    const fetchImpl = async () => ({ status: 404, headers: { get: () => "text/html" } }) as any;
    assert.equal(await validateUrlReachable("https://a.com", fetchImpl as any), false);
  });

  await check("validateUrlReachable: non-HTML 200 → false", async () => {
    const fetchImpl = async () => ({ status: 200, headers: { get: () => "application/json" } }) as any;
    assert.equal(await validateUrlReachable("https://a.com", fetchImpl as any), false);
  });

  await check("validateUrlReachable: HEAD throws → GET fallback succeeds", async () => {
    let call = 0;
    const fetchImpl = async (_u: string, opts: any) => {
      call++;
      if (opts.method === "HEAD") throw new Error("405");
      return { status: 200, headers: { get: () => "text/html" } } as any;
    };
    assert.equal(await validateUrlReachable("https://a.com", fetchImpl as any), true);
    assert.equal(call, 2);
  });

  await check("validateUrlReachable: rejects non-http scheme without fetching", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { status: 200, headers: { get: () => "text/html" } } as any; };
    assert.equal(await validateUrlReachable("ftp://a.com", fetchImpl as any), false);
    assert.equal(called, false);
  });

  // ── orchestration: word extraction + label shape ────────────────────────────
  await check("wordsFromSubtitles: flattens event.words[]", () => {
    const json = JSON.stringify([
      { start: 0, end: 1, words: [{ text: "a", start: 0, end: 0.4 }, { text: "b", start: 0.5, end: 0.9 }] },
      { start: 1, end: 2, words: [{ word: "c", start: 1, end: 1.4 }] }, // `word` alias
    ]);
    const w = wordsFromSubtitles(json);
    assert.deepEqual(w.map(x => x.text), ["a", "b", "c"]);
  });

  await check("buildScreencastLabels: render-compatible label keys + merge", () => {
    const labels = JSON.parse(buildScreencastLabels({
      existing: { keepMe: 1, transcriptSnippet: "old" },
      captureUrl: "https://a.com",
      transcriptSnippet: "new",
      retrievalConfidence: 0.8,
    }));
    assert.equal(labels.keepMe, 1);                 // preserves prior edits
    assert.equal(labels.captureType, "browser");
    assert.equal(labels.captureUrl, "https://a.com");
    assert.equal(labels.mediaType, "video");        // render reads this
    assert.equal(labels.showNarratorFirst, true);
    assert.equal(labels.overlayDelaySeconds, 1.0);
    assert.equal(labels.transcriptSnippet, "new");
    assert.equal(labels.retrievalConfidence, 0.8);
  });

  // ── orchestration: upsert + per-item isolation (mocked everything) ──────────
  function mockStore(project: any, shots: any[]) {
    const created: any[] = [];
    const updates: Record<string, any> = {};
    return {
      created, updates,
      store: {
        findProject: async () => project,
        findShots: async () => shots,
        findShot: async (id: string) => shots.find(s => s.id === id) ?? null,
        createShot: async (record: any) => { const r = { id: `new${created.length}`, ...record }; created.push(r); return r; },
        updateShot: async (id: string, record: any) => { updates[id] = { ...(updates[id] ?? {}), ...record }; return record; },
      },
    };
  }

  await check("autoScreencast: captures existing Screencast shot + inserts planned moment", async () => {
    const project = { id: "p1", transcript: "see Linear", durationSeconds: 30, subtitlesJson: JSON.stringify([{ words: [{ text: "see", start: 5, end: 5.4 }, { text: "Linear", start: 6, end: 6.6 }] }]) };
    const shots = [{ id: "s1", shotType: "Screencast", targetUrl: "https://linear.app", captureStatus: "Pending", startTime: 5, endTime: 10 }];
    const { store, created, updates } = mockStore(project, shots);

    const res = await autoScreencast({ projectId: "p1", userId: "u1" }, {
      store,
      askModel: async () => JSON.stringify({ moments: [{ startSec: 15, endSec: 20, url: "https://notion.so", query: "Notion", confidence: 0.9 }] }),
      validateUrl: async () => true,
      capture: async ({ url }) => ({ file: `/out/${encodeURIComponent(url)}.mp4`, outputUrl: `/api/outputs/${encodeURIComponent(url)}.mp4` }),
    });

    assert.equal(res.captured, 2, JSON.stringify(res));
    assert.equal(res.planned, 1);
    assert.equal(res.failed.length, 0);
    // existing shot upserted to Done with a clipUrl + browser labels
    assert.equal(updates["s1"].captureStatus, "Done");
    assert.ok(String(updates["s1"].clipUrl).startsWith("/api/outputs/"));
    assert.equal(JSON.parse(updates["s1"].uiLabelsJson).captureType, "browser");
    // planned moment created as a NEW Screencast shot bound to the project
    assert.equal(created.length, 1);
    assert.equal(created[0].project, "p1");
    assert.equal(created[0].shotType, "Screencast");
    assert.equal(created[0].captureStatus, "Done");
    assert.equal(created[0].startTime, 15);
  });

  await check("autoScreencast: a failing capture isolates to that shot (Error), others continue", async () => {
    const project = { id: "p1", transcript: "x", durationSeconds: 30, subtitlesJson: "[]" };
    const shots = [
      { id: "bad", shotType: "Screencast", targetUrl: "https://bad", captureStatus: "Pending", startTime: 2, endTime: 7 },
      { id: "good", shotType: "Screencast", targetUrl: "https://good", captureStatus: "Pending", startTime: 8, endTime: 13 },
    ];
    const { store, updates } = mockStore(project, shots);
    const res = await autoScreencast({ projectId: "p1" }, {
      store,
      askModel: async () => JSON.stringify({ moments: [] }),
      validateUrl: async () => true,
      capture: async ({ url }) => {
        if (url === "https://bad") throw new Error("navigation timeout");
        return { file: "/o.mp4", outputUrl: "/api/outputs/o.mp4" };
      },
    });
    assert.equal(res.captured, 1);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].shotId, "bad");
    assert.equal(updates["bad"].captureStatus, "Error");
    assert.equal(updates["good"].captureStatus, "Done");
  });

  await check("autoScreencast: skips existing Screencast already Done", async () => {
    const project = { id: "p1", transcript: "x", durationSeconds: 30, subtitlesJson: "[]" };
    const shots = [{ id: "done", shotType: "Screencast", targetUrl: "https://x", captureStatus: "Done", clipUrl: "/api/outputs/x.mp4", startTime: 2, endTime: 7 }];
    const { store } = mockStore(project, shots);
    let captureCalls = 0;
    const res = await autoScreencast({ projectId: "p1" }, {
      store,
      askModel: async () => JSON.stringify({ moments: [] }),
      validateUrl: async () => true,
      capture: async () => { captureCalls++; return { file: "/o.mp4", outputUrl: "/api/outputs/o.mp4" }; },
    });
    assert.equal(captureCalls, 0);
    assert.equal(res.captured, 0);
  });

  console.log(`\n${passed} checks passed`);
}

main();
