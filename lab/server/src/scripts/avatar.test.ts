/**
 * Avatar Narrator — the pure logic that decides what gets spent and what gets
 * sent.
 *
 * Three things here are worth pinning down, because getting any of them wrong
 * costs real money or silently breaks a paid render:
 *
 *   • the cost model — the 5-second-per-job minimum is the whole reason fast
 *     mode is not free, and it is easy to drop
 *   • script splitting — a chunk that overshoots the provider's ceiling fails
 *     AFTER we have paid to voice it
 *   • provider result sniffing — these APIs have each moved their output field
 *     at least once, so the extractor has to cope with all the known shapes
 *
 *   node --experimental-strip-types src/scripts/avatar.test.ts
 */
import assert from "node:assert/strict";
import {
  estimateCost,
  estimateScriptSeconds,
  videoCostUsd,
  coerceProvider,
  coerceResolution,
  MIN_BILLED_SECONDS,
  maxJobSeconds,
  coerceTtsProvider,
  TTS_RATE_USD_PER_1K_CHARS,
} from "../avatar/types.js";
import { splitScript } from "../avatar/pipeline.js";
import { normalizeSeed } from "../avatar/providers.js";
import { chunkScript } from "../avatar/tts.js";
import { __test as providerTest } from "../avatar/providers.js";
import { buildPortraitPrompt, buildLookPortraitPrompt, PORTRAIT_RULES, DEFAULT_SCENE_PROMPT } from "../avatar/portrait.js";
import { ROOM_PLATES, buildRoomPortraitPrompt, findRoom, roomPlateFile } from "../avatar/rooms.js";
import { buildCharacterSheetPrompt, buildPlacementPrompt, SHEET_ROWS, SHEET_VIEW_COUNT } from "../avatar/characterSheet.js";
import {
  CAPTURE_MEDIUMS,
  FRAMINGS,
  LOOK_PRESETS,
  NEGATIVE_PROMPT,
  buildScenePrompt,
  buildEditPrompt,
  describeCharacter,
  findMedium,
  findFraming,
  findPreset,
} from "../avatar/look.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log("  ok ", name);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.log("FAIL ", name);
    console.log("      " + String((err as Error).message).split("\n").join("\n      "));
  }
}

/** ~150 words → ~60 seconds at the assumed narration pace. */
const SIXTY_SECONDS = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");

// ── Duration estimation ──────────────────────────────────────────────────────

check("estimates a minute of narration from the word count", () => {
  assert.equal(Math.round(estimateScriptSeconds(SIXTY_SECONDS)), 60);
});

check("an empty script is zero seconds, not NaN", () => {
  assert.equal(estimateScriptSeconds(""), 0);
  assert.equal(estimateScriptSeconds("   \n  "), 0);
});

// ── Cost model ───────────────────────────────────────────────────────────────

check("720p on kie.ai costs $0.06/sec", () => {
  assert.equal(videoCostUsd("kie", "720p", 100), 6);
});

check("a job shorter than the minimum still bills the minimum", () => {
  // 2 seconds of video bills as 5 — this is what makes many small chunks cost
  // more than one long render.
  assert.equal(videoCostUsd("kie", "720p", 2), MIN_BILLED_SECONDS * 0.06);
  assert.equal(videoCostUsd("kie", "720p", 5), videoCostUsd("kie", "720p", 2));
});

check("a continuous minute at 720p lands at ~$3.60", () => {
  const est = estimateCost({ script: SIXTY_SECONDS, provider: "kie", resolution: "720p", tts: "gemini" });
  // Four jobs, not one: kie.ai's InfiniteTalk is sold "up to 15 seconds", so a
  // minute cannot be a single take there however continuous we ask for.
  assert.equal(est.segments, 4);
  assert.ok(Math.abs(est.videoUsd - 3.6) < 0.01, `videoUsd was ${est.videoUsd}`);
  // TTS is a rounding error next to the render — that asymmetry is the premise
  // of the whole tool, so assert it rather than assuming it.
  assert.ok(est.ttsUsd < est.videoUsd / 100, `ttsUsd was ${est.ttsUsd}`);
  assert.ok(Math.abs(est.perMinuteUsd - est.totalUsd) < 0.01);
});

check("fast mode costs more than continuous for the same script", () => {
  const continuous = estimateCost({ script: SIXTY_SECONDS, provider: "kie", resolution: "720p", tts: "gemini" });
  const fast = estimateCost({
    script: SIXTY_SECONDS,
    provider: "kie",
    resolution: "720p",
    tts: "gemini",
    segmentSeconds: 4, // deliberately under the 5s minimum
  });
  assert.ok(fast.segments > continuous.segments);
  assert.ok(fast.videoUsd > continuous.videoUsd, `${fast.videoUsd} should exceed ${continuous.videoUsd}`);
});

// ── Provider job ceilings ────────────────────────────────────────────────────
// The ceiling is not a tuning knob: a job over it is REJECTED, after the
// narration inside it has already been paid for.

check("kie.ai caps a job at 15 seconds, WaveSpeed at 600, Seedance at 30", () => {
  assert.equal(maxJobSeconds("segmind"), 30);
  assert.equal(maxJobSeconds("seedance"), 30);
  assert.equal(maxJobSeconds("kie"), 15);
  assert.equal(maxJobSeconds("wavespeed"), 600);
  assert.equal(maxJobSeconds("selfhost"), 600);
});

// ── Seedance 2.5 ─────────────────────────────────────────────────────────────

check("Segmind is the default engine and 480p the default tier", () => {
  assert.equal(coerceProvider(undefined), "segmind");
  assert.equal(coerceProvider("nonsense"), "segmind");
  assert.equal(coerceProvider("seedance"), "seedance");
  assert.equal(coerceResolution(undefined), "480p");
  assert.equal(coerceResolution("720p"), "720p");
});

check("Segmind undercuts kie.ai on the same model at every tier", () => {
  for (const res of ["480p", "720p"] as const) {
    assert.ok(
      videoCostUsd("segmind", res, 100) < videoCostUsd("seedance", res, 100),
      `segmind should be cheaper at ${res}`,
    );
  }
  // Their published rates: $0.1065/s at 480p, $0.2389/s at 720p.
  assert.ok(Math.abs(videoCostUsd("segmind", "480p", 100) - 10.65) < 1e-9);
  assert.ok(Math.abs(videoCostUsd("segmind", "720p", 100) - 23.89) < 1e-9);
});

check("a 45-second Short on Segmind at 480p lands near $4.79", () => {
  const est = estimateCost({
    script: Array.from({ length: 113 }, () => "word").join(" "),
    provider: "segmind",
    resolution: "480p",
    tts: "gemini",
  });
  assert.equal(est.segments, 2, "45s exceeds the 30s ceiling");
  assert.ok(est.videoUsd > 4.6 && est.videoUsd < 5.0, `videoUsd was ${est.videoUsd}`);
});

check("Seedance bills at the no-video-reference tier", () => {
  // The operator's own pricing page: 63 credits/sec at 720p, 28 at 480p, with
  // credits at a flat $0.005. Quoting the cheaper with-video tier would halve
  // every estimate the UI shows and be wrong every time.
  assert.ok(Math.abs(videoCostUsd("seedance", "720p", 100) - 31.5) < 1e-9);
  assert.ok(Math.abs(videoCostUsd("seedance", "480p", 100) - 14) < 1e-9);
});

check("a 45-second Short on Seedance costs what the pricing page says", () => {
  const est = estimateCost({
    script: Array.from({ length: 113 }, () => "word").join(" "), // ~45s at 150wpm
    provider: "seedance",
    resolution: "720p",
    tts: "gemini",
  });
  assert.equal(est.segments, 2, "45s exceeds the 30s ceiling, so it is two jobs");
  // Both halves clear the 5s minimum, so the bill is simply seconds x rate.
  assert.ok(
    Math.abs(est.videoUsd - est.seconds * 0.315) < 1e-6,
    `videoUsd was ${est.videoUsd} for ${est.seconds}s`,
  );
  assert.ok(est.videoUsd > 14 && est.videoUsd < 14.5, `a 45s Short should land near $14.2, got ${est.videoUsd}`);
});

check("Seedance costs multiples of the lipsync path — the trade is deliberate", () => {
  const script = Array.from({ length: 113 }, () => "word").join(" ");
  const generative = estimateCost({ script, provider: "seedance", resolution: "720p", tts: "gemini" });
  const lipsync = estimateCost({ script, provider: "kie", resolution: "720p", tts: "gemini" });
  assert.ok(generative.videoUsd > lipsync.videoUsd * 4, `${generative.videoUsd} vs ${lipsync.videoUsd}`);
});

check("the same minute is one job on WaveSpeed and four on kie.ai", () => {
  const kie = estimateCost({ script: SIXTY_SECONDS, provider: "kie", resolution: "720p", tts: "gemini" });
  const wave = estimateCost({ script: SIXTY_SECONDS, provider: "wavespeed", resolution: "720p", tts: "gemini" });
  assert.equal(wave.segments, 1);
  assert.equal(kie.segments, 4);
  // ...and it costs the same either way, because every chunk clears the 5s
  // minimum. The difference you pay for is seams, not money.
  assert.ok(Math.abs(kie.videoUsd - wave.videoUsd) < 0.001, `${kie.videoUsd} vs ${wave.videoUsd}`);
});

check("asking for chunks longer than the provider allows is clamped, not obeyed", () => {
  const asked = estimateCost({
    script: SIXTY_SECONDS,
    provider: "kie",
    resolution: "720p",
    tts: "gemini",
    segmentSeconds: 30, // the old "fast mode" default — twice what kie.ai takes
  });
  assert.equal(asked.segments, 4, "30s chunks must collapse to kie.ai's 15s ceiling");
});

check("a sentence longer than the ceiling is broken rather than submitted whole", () => {
  // ~50 words in one unbroken sentence: over kie.ai's 15s (~37 words) ceiling.
  const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ") + ".";
  const parts = splitScript(long, 15, 15);
  assert.ok(parts.length > 1, "expected the over-long sentence to be cut");
  for (const p of parts) {
    assert.ok(estimateScriptSeconds(p) <= 15, `chunk was ${estimateScriptSeconds(p)}s: "${p.slice(0, 40)}…"`);
  }
  assert.equal(parts.join(" ").split(/\s+/).length, long.split(/\s+/).length, "words were lost in the cut");
});

check("clause boundaries are preferred to arbitrary word cuts", () => {
  const script = `${"a ".repeat(30)}, ${"b ".repeat(30)}.`.replace(/\s+/g, " ");
  const parts = splitScript(script, 15, 15);
  assert.ok(parts.length > 1);
  assert.ok(parts[0].trim().endsWith(","), `expected the cut at the comma, got "${parts[0].slice(-20)}"`);
});

check("without a hard limit the old sentence-preserving behaviour is unchanged", () => {
  const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ") + ".";
  assert.equal(splitScript(long, 5).length, 1, "no ceiling means a sentence is never broken");
});

// ── Seed range ───────────────────────────────────────────────────────────────

check("a seed outside kie.ai's documented range is folded into it", () => {
  assert.equal(normalizeSeed(undefined), undefined);
  assert.equal(normalizeSeed(Number.NaN), undefined);
  for (const seed of [0, 42, 9999, 1_000_001, -7, 2 ** 40]) {
    const n = normalizeSeed(seed)!;
    assert.ok(n >= 10000 && n <= 1000000, `${seed} → ${n} is outside 10000–1000000`);
  }
  // Same input, same seed — folding must not cost repeatability.
  assert.equal(normalizeSeed(42), normalizeSeed(42));
});

check("480p on kie.ai is the cheap tier", () => {
  const hi = estimateCost({ script: SIXTY_SECONDS, provider: "kie", resolution: "720p", tts: "gemini" });
  const lo = estimateCost({ script: SIXTY_SECONDS, provider: "kie", resolution: "480p", tts: "gemini" });
  assert.ok(lo.videoUsd < hi.videoUsd / 3);
});

check("self-hosting is an order of magnitude cheaper per minute", () => {
  const hosted = estimateCost({ script: SIXTY_SECONDS, provider: "kie", resolution: "720p", tts: "gemini" });
  const own = estimateCost({ script: SIXTY_SECONDS, provider: "selfhost", resolution: "720p", tts: "gemini" });
  assert.ok(own.videoUsd * 10 < hosted.videoUsd, `${own.videoUsd} vs ${hosted.videoUsd}`);
});

check("an empty script estimates to nothing rather than dividing by zero", () => {
  const est = estimateCost({ script: "", provider: "kie", resolution: "720p", tts: "gemini" });
  assert.equal(est.seconds, 0);
  assert.equal(est.perMinuteUsd, 0);
  assert.ok(Number.isFinite(est.totalUsd));
});

// ── Input coercion ───────────────────────────────────────────────────────────

check("unknown provider/resolution fall back to the safe defaults", () => {
  assert.equal(coerceProvider("nonsense"), "segmind");
  assert.equal(coerceProvider(undefined), "segmind");
  assert.equal(coerceProvider("kie"), "kie");
  assert.equal(coerceProvider("wavespeed"), "wavespeed");
  assert.equal(coerceResolution("4k"), "480p");
  assert.equal(coerceResolution("480p"), "480p");
});

check("an edit prompt spends its words defending the identity of the face", () => {
  const p = buildEditPrompt("make the sweater navy blue", findMedium("daylight-interior"));
  // The expensive failure is an edit that returns a DIFFERENT PERSON: it looks
  // fine alone and only shows up later as a persona whose face drifted.
  assert.ok(/SAME PERSON/.test(p));
  assert.ok(/recognisably the same individual/.test(p));
  assert.ok(/navy blue/.test(p), "the requested change was dropped");
  assert.ok(/ONLY change/.test(p));
  // And the animatability rules still have to survive an edit.
  assert.ok(/MOUTH CLOSED/.test(p));
  assert.ok(/shoulders in frame/.test(p));
  assert.ok(p.includes(NEGATIVE_PROMPT));
});

check("an empty edit instruction is refused before it costs a generation", () => {
  assert.throws(() => buildEditPrompt("   "), /what you want changed/);
});

// ── Voice ────────────────────────────────────────────────────────────────────

check("Segmind is the default voice as well as the default engine", () => {
  // One key covers video and narration; that is the whole argument for paying
  // a reseller margin on ElevenLabs.
  assert.equal(coerceTtsProvider(undefined), "segmind");
  assert.equal(coerceTtsProvider("nonsense"), "segmind");
  assert.equal(coerceTtsProvider("gemini"), "gemini");
  assert.equal(coerceTtsProvider("elevenlabs"), "elevenlabs");
});

check("the resale margin on ElevenLabs is recorded honestly", () => {
  // Segmind resells ElevenLabs at a markup: dearer per character, cheaper in
  // practice below ~130k chars/month because there is no plan quota to buy.
  assert.ok(TTS_RATE_USD_PER_1K_CHARS.segmind > TTS_RATE_USD_PER_1K_CHARS.elevenlabs);
  assert.ok(Math.abs(TTS_RATE_USD_PER_1K_CHARS.segmind - 0.16875) < 1e-9);
  assert.ok(Math.abs(TTS_RATE_USD_PER_1K_CHARS.elevenlabs - 0.0968) < 1e-9);
});

check("voice stays a rounding error against the video bill", () => {
  const script = Array.from({ length: 113 }, () => "word").join(" ");
  const est = estimateCost({ script, provider: "segmind", resolution: "480p", tts: "segmind" });
  // The premise of the whole tool: pick the voice on quality, not on price.
  assert.ok(est.ttsUsd < est.videoUsd / 20, `ttsUsd ${est.ttsUsd} vs videoUsd ${est.videoUsd}`);
});

// ── Script splitting ─────────────────────────────────────────────────────────

check("a short script is one segment", () => {
  assert.deepEqual(splitScript("Hello there.", 30), ["Hello there."]);
});

check("segmentSeconds of 0 never splits", () => {
  assert.equal(splitScript(SIXTY_SECONDS, 0).length, 1);
});

check("splitting keeps every sentence whole", () => {
  const script = "One two three. Four five six. Seven eight nine. Ten eleven twelve.";
  const parts = splitScript(script, 1);
  assert.ok(parts.length > 1, "expected a split");
  for (const p of parts) {
    assert.ok(/[.!?]$/.test(p.trim()), `chunk did not end on a sentence: "${p}"`);
  }
});

check("splitting loses no words", () => {
  const before = SIXTY_SECONDS.split(/\s+/).length;
  const after = splitScript(SIXTY_SECONDS, 10).join(" ").split(/\s+/).length;
  assert.equal(after, before);
});

check("a single over-long sentence still becomes its own chunk", () => {
  const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ") + ".";
  const parts = splitScript(long, 5);
  assert.ok(parts.length >= 1);
  assert.ok(parts.every((p) => p.trim().length > 0), "an empty chunk would submit an empty job");
});

// ── TTS chunking ─────────────────────────────────────────────────────────────

check("TTS chunks stay under the request limit", () => {
  const script = Array.from({ length: 400 }, () => "This is a sentence of narration.").join(" ");
  const chunks = chunkScript(script, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 500, `chunk was ${c.length} chars`);
});

check("TTS chunking drops nothing and emits no blanks", () => {
  const script = "Alpha beta. Gamma delta! Epsilon zeta? Eta theta.";
  const chunks = chunkScript(script, 20);
  assert.ok(chunks.every((c) => c.trim().length > 0));
  const joined = chunks.join(" ").replace(/\s+/g, " ");
  for (const word of ["Alpha", "delta", "Epsilon", "theta"]) {
    assert.ok(joined.includes(word), `lost "${word}"`);
  }
});

check("an empty script produces no TTS requests", () => {
  assert.deepEqual(chunkScript(""), []);
  assert.deepEqual(chunkScript("   "), []);
});

// ── Provider result sniffing ─────────────────────────────────────────────────

const { findVideoUrl } = providerTest;

check("finds the URL in kie.ai's nested resultJson string", () => {
  const payload = {
    state: "success",
    resultJson: JSON.stringify({ resultUrls: ["https://cdn.example.com/out/abc.mp4"] }),
  };
  assert.equal(findVideoUrl(payload), "https://cdn.example.com/out/abc.mp4");
});

check("finds the URL in WaveSpeed's outputs array", () => {
  assert.equal(
    findVideoUrl({ status: "completed", outputs: ["https://d.wavespeed.ai/x/y.mp4"] }),
    "https://d.wavespeed.ai/x/y.mp4",
  );
});

check("finds the URL in a RunPod-style output object", () => {
  assert.equal(
    findVideoUrl({ status: "COMPLETED", output: { video: "https://worker.example.com/r/1.mp4?sig=abc" } }),
    "https://worker.example.com/r/1.mp4?sig=abc",
  );
});

check("ignores non-video URLs so a thumbnail is never mistaken for the render", () => {
  assert.equal(findVideoUrl({ preview: "https://cdn.example.com/thumb.jpg" }), null);
  assert.equal(findVideoUrl({ docs: "https://kie.ai/help" }), null);
});

check("a pending payload yields nothing rather than throwing", () => {
  assert.equal(findVideoUrl({ state: "waiting", data: null }), null);
  assert.equal(findVideoUrl(null), null);
  assert.equal(findVideoUrl({}), null);
});

check("a self-referencing payload terminates", () => {
  const cyclic: any = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(findVideoUrl(cyclic), null);
});

// ── Portrait prompt ──────────────────────────────────────────────────────────

check("the portrait prompt always carries the animatability rules", () => {
  const prompt = buildPortraitPrompt("A woman in her 40s wearing a green jacket");
  assert.ok(prompt.startsWith("A woman in her 40s wearing a green jacket"));
  assert.ok(prompt.includes(PORTRAIT_RULES));
  // The three that matter most: a closed mouth, even light, shoulders in frame.
  assert.ok(/MOUTH CLOSED/.test(prompt));
  // Framing and lighting are no longer universal rules — they come from the
  // FRAMING and the CAPTURE MEDIUM, because what a lipsync engine needs (flat
  // light, no hands) is the opposite of what a generative one wants.
  assert.ok(/shoulders/.test(buildPortraitPrompt('A presenter', findMedium(undefined), findFraming('close'))));
  assert.ok(/no hard shadows/.test(buildPortraitPrompt('A presenter', findMedium(undefined), findFraming('close'))));
  assert.ok(/hands/.test(buildPortraitPrompt('A presenter', findMedium(undefined), findFraming('medium'))));
});

check("an empty description is refused before it costs an image generation", () => {
  assert.throws(() => buildPortraitPrompt("   "), /Describe the presenter/);
});

check("framing decides whether the presenter has hands", () => {
  const medium = buildScenePrompt({ framing: findFraming('medium') });
  const close = buildScenePrompt({ framing: findFraming('close') });
  // Gestures are most of what makes a read look alive — but only an engine that
  // draws the whole person can produce them.
  assert.ok(/hand gestures/.test(medium));
  assert.ok(!/no hand gestures/i.test(medium));
  assert.ok(/No hand gestures/.test(close));
  // Whatever the framing, the tells stay forbidden.
  for (const p of [medium, close]) assert.ok(/background music/.test(p));
});

check("the cinematic studio medium carries real lighting direction", () => {
  const studio = findMedium('youtube-studio');
  assert.equal(studio.id, 'youtube-studio');
  assert.ok(/rim light/.test(studio.spec));
  assert.ok(/key/.test(studio.spec));
  // The point of the set: shaped light, not the flat headshot the lipsync path
  // has to use.
  assert.ok(!/even, frontal/.test(studio.spec));
});

// ── The look ─────────────────────────────────────────────────────────────────
// Naming the capture medium is the single biggest realism lever in the tool: an
// image model with no stated medium blends every style it knows and produces
// the half-CGI face. These pin that it reaches the prompt.

check("the capture medium reaches the portrait prompt", () => {
  const medium = findMedium("phone-natural");
  const prompt = buildPortraitPrompt("A presenter", medium);
  assert.ok(prompt.includes(medium.spec), "the medium spec was dropped");
  assert.ok(/smartphone/.test(prompt));
  // The animatability rules must survive alongside it, not be replaced by it.
  assert.ok(/MOUTH CLOSED/.test(prompt));
});

check("an unknown or missing medium falls back rather than dropping the spec", () => {
  assert.equal(findMedium(undefined).id, CAPTURE_MEDIUMS[0].id);
  assert.equal(findMedium("no-such-medium").id, CAPTURE_MEDIUMS[0].id);
});

check("every prompt carries the negative prompt", () => {
  const prompt = buildPortraitPrompt("A presenter", findMedium("daylight-interior"));
  assert.ok(prompt.includes(NEGATIVE_PROMPT));
  assert.ok(/skin smoothing/.test(prompt), "smoothing is the failure mode that ruins realism");
});

check("a character spec becomes a prompt that keeps its specifics", () => {
  const preset = findPreset("explainer")!;
  const described = describeCharacter(preset.character);
  // Realism lives in the imperfections — if these are dropped the face goes
  // smooth, symmetrical and instantly readable as AI.
  assert.ok(/pores/.test(described));
  assert.ok(/mole/.test(described));
  assert.ok(/flyaway/.test(described));
  assert.ok(/not resembling any real or public figure/.test(described));
});

check("both presets are complete and original", () => {
  assert.ok(LOOK_PRESETS.length >= 2);
  for (const p of LOOK_PRESETS) {
    assert.ok(p.character.skin.trim(), `${p.id} has no skin detail — that is where realism lives`);
    assert.ok(findMedium(p.mediumId).id === p.mediumId, `${p.id} points at a medium that does not exist`);
    assert.ok(p.voice.trim(), `${p.id} has no voice`);
    const prompt = buildLookPortraitPrompt(p.character, findMedium(p.mediumId));
    assert.ok(prompt.includes(PORTRAIT_RULES), `${p.id} lost the animatability rules`);
    assert.ok(prompt.includes(NEGATIVE_PROMPT), `${p.id} lost the negative prompt`);
  }
});

// ── In a real room, not in front of one ──────────────────────────────────────
// The brief these pin: "real in a real environment, not a disconnected avatar
// headshot." A face against a blurred backdrop reads as a cutout however good
// the face is, and two rules in the old prompt were mandating exactly that.

check("the cinematic studio names the actual rig, and its physics suit the brief", () => {
  const m = findMedium("cinematic-studio");
  assert.equal(m.id, "cinematic-studio");
  assert.ok(/FX30/.test(m.spec), "the camera name is the shorthand the model knows");
  assert.ok(/Tamron/.test(m.spec));
  // Super 35 behind an f/2.8 zoom is WHY the room survives — a fast full-frame
  // prime would dissolve it. If someone "upgrades" the glass, the look breaks.
  assert.ok(/Super 35|APS-C/.test(m.spec));
  assert.ok(/f\/2\.8/.test(m.spec));
  assert.ok(!/full-frame prime[^.]*\bat f\/1/.test(m.spec));
});

check("the creator's studio specifies all four cues that put a person IN a room", () => {
  const spec = findMedium("cinematic-studio").spec;
  // Each is here because a model omits it when left to itself, and each one
  // alone is enough to make the result read as a cutout.
  assert.ok(/near foreground/i.test(spec), "no foreground element — the camera is not in the room");
  assert.ok(/reads in layers/i.test(spec), "no depth layers — the background is one plane");
  assert.ok(/window/i.test(spec), "light from nowhere reads as composited");
  assert.ok(/forearms resting on the desk/.test(spec), "nothing the subject touches — they hover in the room");
});

check("the creator's studio is lit by a window and NOTHING else", () => {
  const spec = findMedium("cinematic-studio").spec;
  // Jake rejected the rim light as too much, and the references have none: both
  // are window-lit and separate by tone alone. An earlier revision demanded a
  // bright cool rim, so this asserts the absence rather than trusting it.
  assert.ok(/NO RIM LIGHT/.test(spec), "the rim has to be a NAMED negative — models add one unasked");
  assert.ok(!/bright cool rim light rakes/.test(spec), "the rejected rim light came back");
  assert.ok(/no kicker, no backlight/.test(spec));
  assert.ok(/Separation comes from tone and depth/.test(spec));
  // The grade went with it: the references are muted and low contrast, not the
  // punchy teal-and-amber of the first attempt.
  assert.ok(/LOW CONTRAST/.test(spec));
  assert.ok(/no heavy teal-and-orange/.test(spec));
  assert.ok(!/teal ambient fill/.test(spec));
});

check("nothing in the universal rules forces the disconnected-headshot look", () => {
  // Both of these USED to be in PORTRAIT_RULES, and both defeat an environment:
  // one bans the room outright, the other overrode every medium's own glass.
  assert.ok(!/Nothing behind the head/.test(PORTRAIT_RULES), "the rules banned having a room at all");
  assert.ok(!/85mm/.test(PORTRAIT_RULES), "a fixed lens in the rules contradicts every medium");
  // The medium's lens must be the ONLY lens in the composed prompt.
  const withMedium = buildPortraitPrompt("A presenter", findMedium("cinematic-studio"));
  assert.ok(/Tamron/.test(withMedium));
  assert.ok(!/85mm/.test(withMedium), "the fallback lens leaked in alongside a medium");
  // With no medium there is nothing to name the glass, so the fallback applies.
  assert.ok(/85mm/.test(buildPortraitPrompt("A presenter")));
});

check("the wide framing is additive — it never becomes the silent default", () => {
  const wide = findFraming("environment");
  assert.equal(wide.id, "environment");
  assert.ok(/mid-thigh/.test(wide.spec));
  assert.ok(/fifth of the frame height/.test(wide.spec), "a 9:16 wide shot walks the face out of resolution");
  assert.ok(/no hand is cropped/.test(wide.spec));
  // Appended, not inserted: existing callers that pass no framing must be
  // unaffected, or every persona ever made silently reframes.
  assert.equal(findFraming(undefined).id, "medium");
  assert.equal(FRAMINGS[0].id, "medium");
});

// ── The room is a plate, not a paragraph ─────────────────────────────────────
// Words get you the right KIND of room, a different one each time. Continuity
// across a channel needs the SAME room, which only a reference image delivers.

check("the room prompt pins the set before it describes the person", () => {
  const room = ROOM_PLATES[0];
  const p = buildRoomPortraitPrompt("A 40-year-old man in a grey sweater", room);
  // Order matters: an image model told about a person first will re-render the
  // room around them. The room is fixed before anyone is added to it.
  assert.ok(p.indexOf("THE ROOM IS FIXED") < p.indexOf("WHO TO ADD"), "the person was described before the room was pinned");
  assert.ok(/same camera position/.test(p));
  assert.ok(/do not reveal any more of the room/i.test(p));
  // The lighting clause is the subtle one — a model adding a person LIGHTS
  // them, and the moment it does they stop belonging to the room.
  assert.ok(/THE LIGHT IS FIXED/.test(p));
  assert.ok(/rim light, edge light, kicker or backlight/.test(p));
  assert.ok(/contact shadows/.test(p));
  assert.ok(p.includes(room.placement), "the plate's own placement direction was dropped");
  assert.ok(/MOUTH CLOSED/.test(p), "the still still has to be animatable");
  assert.throws(() => buildRoomPortraitPrompt("  ", room), /Describe the presenter/);
});

check("both rooms exist and say where the presenter sits", () => {
  assert.equal(ROOM_PLATES.length, 4);
  assert.deepEqual(ROOM_PLATES.map((r) => r.id),
    ["studio-front", "studio-front-close", "studio-side", "studio-gear"]);
  for (const r of ROOM_PLATES) {
    assert.ok(r.placement.trim(), `${r.id} does not say where the presenter sits`);
    assert.ok(/\.png$/.test(r.file));
  }
  // The side plate is the one with the computer — the foreground element that
  // does its depth work, so losing it from the direction would flatten the shot.
  assert.ok(/laptop/.test(findRoom("studio-side")!.placement));
  assert.equal(findRoom("nope"), null);
  assert.equal(findRoom(undefined), null);
});

check("a missing plate degrades to no room rather than to a different room", () => {
  // roomPlateFile returns null for an unknown id, and generatePortrait turns a
  // KNOWN id with a missing file into an error instead of quietly generating
  // some other room — which would break continuity invisibly.
  assert.equal(roomPlateFile("nope"), null);
  assert.equal(roomPlateFile(undefined), null);
  assert.equal(roomPlateFile(""), null);
});

check("the room rides with every segment, and the prompt names it as the set", () => {
  const base = {
    imageUrl: "https://example.test/portrait.png",
    audioUrl: "https://example.test/narration.mp3",
    prompt: "A person speaking to camera.",
    resolution: "720p" as const,
    speech: "Hello.",
  };
  // Cited form (Segmind) — order is load-bearing, @Image 1 is the presenter.
  const withRoom = providerTest.generativeSpeechPrompt(
    { ...base, roomUrl: "https://example.test/room.png" }, true,
  );
  assert.ok(/@Image 1/.test(withRoom));
  assert.ok(/@Image 2/.test(withRoom), "the room was attached but never cited");
  assert.ok(/opens and ends in it/.test(withRoom), "start and end of the clip must be pinned to the room");
  assert.ok(/Do not change the room/.test(withRoom));
  // No room: not a dangling reference to a second image that was never sent.
  const without = providerTest.generativeSpeechPrompt(base, true);
  assert.ok(!/@Image 2/.test(without), "cited a room image that is not being sent");
  assert.ok(/@Image 1/.test(without));
});

// ── One persona, twenty angles, any room ─────────────────────────────────────

check("the character sheet asks for one person twenty times, not twenty people", () => {
  const p = buildCharacterSheetPrompt();
  assert.ok(/THE SAME PERSON IN EVERY CELL/.test(p));
  assert.ok(/never a set of similar-looking people/.test(p), "the failure mode has to be named");
  assert.ok(new RegExp(`exactly ${SHEET_VIEW_COUNT} separate views`).test(p));
  assert.equal(SHEET_VIEW_COUNT, 20);
  assert.equal(SHEET_ROWS.length, 4, "5 columns x 4 rows = 20");
  // Mouth closed throughout: a sheet full of open mouths teaches the placement
  // step to produce one, and an open mouth in the source is the lipsync tell.
  assert.ok(/MOUTH CLOSED/.test(p));
  // White seamless, because the room comes from the plate later — a sheet shot
  // in a room drags that room's light into every future placement.
  assert.ok(/pure white seamless studio background/.test(p));
  assert.ok(/do not beautify, slim, de-age/.test(p), "idealising the face loses the persona");
});

check("placement tells the model which image is the face and which is the world", () => {
  const room = findRoom("studio-gear")!;
  const p = buildPlacementPrompt(room.placement);
  // Handed two pictures with no explanation, a model averages them or reads the
  // second as another view of the first. Each has to be given a job.
  assert.ok(/THE FIRST is a character reference sheet/.test(p));
  assert.ok(/THE SECOND is a photograph of an\s+empty room/.test(p));
  assert.ok(/FROM THE FIRST IMAGE take only the person/.test(p));
  assert.ok(/FROM THE SECOND IMAGE take everything else/.test(p));
  // The specific trap: the sheet's white background is the most dominant thing
  // in image 1, and copying it throws the room away.
  assert.ok(/not its white background, not its grid/.test(p));
  assert.ok(p.includes(room.placement), "the room's own placement direction was dropped");
  assert.ok(/rim light, edge light, kicker or backlight/.test(p), "the no-rim rule has to survive placement too");
  assert.ok(/contact shadows/.test(p));
});

check("every room can be placed into, and each says where the person sits", () => {
  assert.equal(ROOM_PLATES.length, 4);
  assert.deepEqual(ROOM_PLATES.map((r) => r.id),
    ["studio-front", "studio-front-close", "studio-side", "studio-gear"]);
  for (const r of ROOM_PLATES) {
    const p = buildPlacementPrompt(r.placement);
    assert.ok(p.includes(r.placement), `${r.id} placement missing from its prompt`);
  }
});

check("a heritage no longer corrupts the sentence that describes the person", () => {
  // Joining [age, heritage, presenting] with "-year-old " produced
  // "36-year-old Black British-year-old man" — in every prompt with a heritage,
  // which is both shipped presets.
  const described = describeCharacter(findPreset("reviewer")!.character);
  assert.ok(/36-year-old Black British man/.test(described), described.slice(0, 120));
  assert.equal((described.match(/-year-old/g) ?? []).length, 1);
  // And the no-heritage path still reads correctly.
  const noHeritage = describeCharacter({ ...findPreset("reviewer")!.character, heritage: undefined });
  assert.ok(/36-year-old man/.test(noHeritage), noHeritage.slice(0, 120));
});

check("the scene prompt asks for micro-expression and forbids the tells", () => {
  const scene = buildScenePrompt();
  assert.ok(/[Mm]icro-expressions/.test(scene));
  assert.ok(/blinking/.test(scene));
  assert.ok(/no camera movement/.test(scene));
  // Left alone these models add exaggerated emotion and a music bed; both are
  // instant giveaways, so they have to be named as negatives.
  assert.ok(/exaggerated/.test(scene));
  assert.ok(/background music/.test(scene));
});

check("the default scene prompt is the built one, so personas inherit the negatives", () => {
  assert.equal(DEFAULT_SCENE_PROMPT, buildScenePrompt());
  assert.ok(/background music/.test(DEFAULT_SCENE_PROMPT));
});

check("extra scene direction is folded in without losing the negatives", () => {
  const scene = buildScenePrompt({ extra: "She glances down at her notes once." });
  assert.ok(/glances down/.test(scene));
  assert.ok(/background music/.test(scene));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
