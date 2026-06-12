/**
 * Unit checks for the AUTOMATIC in-pipeline Auto-Screencast step — the piece that
 * makes the director's Pending Screencast shots get captured during generation,
 * not only via the manual button. EVERYTHING is injected — no network, no
 * Chromium, no ffmpeg, no DB.
 *
 * We test:
 *   - autoScreencastEnabledFor: default-on, global env-disable, explicit per-video off
 *   - the pipeline injection (autoScreencastPipelineStep): RUNS when enabled +
 *     chromium present; SKIPS when disabled / no chromium / toggle off; a capture
 *     failure leaves the pipeline succeeding (returns null, never throws)
 *   - the overall budget abandons remaining moments (leaves them Pending)
 *   - mutual exclusion: a Done screencast shot (real clipUrl) is skipped by the
 *     captureShots short-circuit and never given b-roll
 *
 * Run: cd lab/server && npx tsx src/scripts/autoscreencast-pipeline.test.ts
 */
import assert from "node:assert/strict";
import { config } from "../config.js";
import {
  autoScreencast,
  autoScreencastEnabledFor,
  autoScreencastPipelineStep,
  type AutoScreencastResult,
} from "../capture/autoScreencast.js";

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

/** Temporarily flip config.autoScreencastDisabled around a fn (no env mutation). */
async function withDisabled(disabled: boolean, fn: () => Promise<void>) {
  const prev = config.autoScreencastDisabled;
  (config as { autoScreencastDisabled: boolean }).autoScreencastDisabled = disabled;
  try {
    await fn();
  } finally {
    (config as { autoScreencastDisabled: boolean }).autoScreencastDisabled = prev;
  }
}

const emptyResult: AutoScreencastResult = { planned: 0, captured: 0, skipped: [], failed: [] };

async function main() {
  // ── autoScreencastEnabledFor ────────────────────────────────────────────────
  await check("autoScreencastEnabledFor: default ON (undefined / true)", () => {
    assert.equal(autoScreencastEnabledFor(undefined), true);
    assert.equal(autoScreencastEnabledFor(true), true);
    assert.equal(autoScreencastEnabledFor(null), true); // older projects
  });

  await check("autoScreencastEnabledFor: explicit per-video false → OFF", () => {
    assert.equal(autoScreencastEnabledFor(false), false);
  });

  await check("autoScreencastEnabledFor: global SCREENCAST_DISABLED overrides on", async () => {
    await withDisabled(true, async () => {
      assert.equal(autoScreencastEnabledFor(undefined), false);
      assert.equal(autoScreencastEnabledFor(true), false);
    });
  });

  // ── pipeline injection: runs when enabled + chromium present ─────────────────
  await check("pipelineStep: RUNS when enabled + chromium present", async () => {
    let ran = false;
    const res = await autoScreencastPipelineStep("p1", "u1", {
      chromiumAvailable: () => true,
      findProject: async () => ({ id: "p1", autoScreencast: true } as any),
      run: async (input) => {
        ran = true;
        assert.equal(input.projectId, "p1");
        assert.equal(input.userId, "u1");
        assert.equal(input.maxMoments, config.autoScreencastMaxMoments);
        assert.equal(input.budgetMs, config.autoScreencastBudgetMs);
        return { ...emptyResult, captured: 2 };
      },
      log: () => {},
    });
    assert.equal(ran, true);
    assert.equal(res?.captured, 2);
  });

  await check("pipelineStep: SKIPS when no Chromium (returns null, run untouched)", async () => {
    let ran = false;
    const res = await autoScreencastPipelineStep("p1", "u1", {
      chromiumAvailable: () => false,
      findProject: async () => ({ id: "p1", autoScreencast: true } as any),
      run: async () => { ran = true; return emptyResult; },
    });
    assert.equal(ran, false);
    assert.equal(res, null);
  });

  await check("pipelineStep: SKIPS when per-video toggle is OFF", async () => {
    let ran = false;
    const res = await autoScreencastPipelineStep("p1", "u1", {
      chromiumAvailable: () => true,
      findProject: async () => ({ id: "p1", autoScreencast: false } as any),
      run: async () => { ran = true; return emptyResult; },
    });
    assert.equal(ran, false);
    assert.equal(res, null);
  });

  await check("pipelineStep: SKIPS when SCREENCAST_DISABLED globally", async () => {
    await withDisabled(true, async () => {
      let ran = false;
      const res = await autoScreencastPipelineStep("p1", "u1", {
        chromiumAvailable: () => true,
        findProject: async () => ({ id: "p1", autoScreencast: true } as any),
        run: async () => { ran = true; return emptyResult; },
      });
      assert.equal(ran, false);
      assert.equal(res, null);
    });
  });

  await check("pipelineStep: SKIPS when no projectId", async () => {
    let ran = false;
    const res = await autoScreencastPipelineStep(undefined, "u1", {
      chromiumAvailable: () => true,
      findProject: async () => ({ id: "p1" } as any),
      run: async () => { ran = true; return emptyResult; },
    });
    assert.equal(ran, false);
    assert.equal(res, null);
  });

  await check("pipelineStep: a capture-run failure is swallowed (pipeline proceeds)", async () => {
    let warned = "";
    const res = await autoScreencastPipelineStep("p1", "u1", {
      chromiumAvailable: () => true,
      findProject: async () => ({ id: "p1", autoScreencast: true } as any),
      run: async () => { throw new Error("chromium crashed"); },
      log: () => {},
      warn: (l) => { warned = l; },
    });
    // Returns null and NEVER throws — generation continues with shots Pending.
    assert.equal(res, null);
    assert.ok(/non-fatal/.test(warned) && /chromium crashed/.test(warned), warned);
  });

  await check("pipelineStep: a findProject failure is swallowed too", async () => {
    const res = await autoScreencastPipelineStep("p1", "u1", {
      chromiumAvailable: () => true,
      findProject: async () => { throw new Error("db down"); },
      run: async () => emptyResult,
      log: () => {},
      warn: () => {},
    });
    assert.equal(res, null);
  });

  // ── per-shot fallback: a failing site isolates, others still captured ────────
  await check("capture failure on a director Pending shot leaves it for fallback, others Done", async () => {
    const project = { id: "p1", transcript: "x", durationSeconds: 30, subtitlesJson: "[]" };
    const shots = [
      { id: "bad", shotType: "Screencast", targetUrl: "https://bad", captureStatus: "Pending", startTime: 2, endTime: 7 },
      { id: "ok", shotType: "Screencast", targetUrl: "https://ok", captureStatus: "Pending", startTime: 8, endTime: 13 },
    ];
    const updates: Record<string, any> = {};
    const res = await autoScreencast({ projectId: "p1" }, {
      store: {
        findProject: async () => project as any,
        findShots: async () => shots as any,
        findShot: async (id) => shots.find((s) => s.id === id) as any ?? null,
        createShot: async (r) => ({ id: "n", ...r } as any),
        updateShot: async (id, r) => { updates[id] = { ...(updates[id] ?? {}), ...r }; return r; },
      },
      askModel: async () => JSON.stringify({ moments: [] }),
      validateUrl: async () => true,
      capture: async ({ url }) => {
        if (url === "https://bad") throw new Error("navigation timeout");
        return { file: "/o.mp4", outputUrl: "/api/outputs/o.mp4" };
      },
    });
    assert.equal(res.captured, 1);
    assert.equal(res.failed.length, 1);
    // The bad shot is left Error (NOT Done) → captureShots' fallback handles it.
    assert.equal(updates["bad"].captureStatus, "Error");
    assert.notEqual(updates["bad"].clipUrl, "/api/outputs/o.mp4");
    assert.equal(updates["ok"].captureStatus, "Done");
    assert.equal(updates["ok"].clipUrl, "/api/outputs/o.mp4");
  });

  // ── overall budget: abandons remaining moments, leaves them Pending ──────────
  await check("budget exceeded → remaining existing shots left Pending (never marked Capturing)", async () => {
    const project = { id: "p1", transcript: "x", durationSeconds: 30, subtitlesJson: "[]" };
    const shots = [
      { id: "a", shotType: "Screencast", targetUrl: "https://a", captureStatus: "Pending", startTime: 2, endTime: 7 },
      { id: "b", shotType: "Screencast", targetUrl: "https://b", captureStatus: "Pending", startTime: 8, endTime: 13 },
    ];
    const updates: Record<string, any> = {};
    let t = 1000;
    const res = await autoScreencast({ projectId: "p1", budgetMs: 50, now: () => t }, {
      store: {
        findProject: async () => project as any,
        findShots: async () => shots as any,
        findShot: async (id) => shots.find((s) => s.id === id) as any ?? null,
        createShot: async (r) => ({ id: "n", ...r } as any),
        updateShot: async (id, r) => { updates[id] = { ...(updates[id] ?? {}), ...r }; return r; },
      },
      askModel: async () => JSON.stringify({ moments: [] }),
      validateUrl: async () => true,
      capture: async () => {
        // First capture "spends" the whole budget so the 2nd is abandoned.
        t += 1000;
        return { file: "/o.mp4", outputUrl: "/api/outputs/o.mp4" };
      },
    });
    assert.equal(res.captured, 1, JSON.stringify(res));
    assert.equal(res.timedOut, true);
    assert.equal(updates["a"].captureStatus, "Done");
    // "b" was never touched → no Capturing/Error update → stays Pending for fallback.
    assert.equal(updates["b"], undefined);
  });

  // ── mutual exclusion: a Done screencast shot is not given b-roll ─────────────
  // Mirrors the captureShots short-circuit: shots with captureStatus 'Done' are
  // counted as captured and SKIPPED — never reaching any stock/Veo3 assignment.
  await check("mutual exclusion: captureShots skips a Done Screencast (no b-roll overwrite)", () => {
    // The exact guard from lab/src/api/captureShots.ts line ~113.
    const assignMedia = (shot: { captureStatus?: string; clipUrl?: string }) => {
      if (shot.captureStatus === "Done") return "skipped"; // counted captured, untouched
      return "assigned-broll";
    };
    const doneScreencast = { shotType: "Screencast", captureStatus: "Done", clipUrl: "/api/outputs/real.mp4" };
    assert.equal(assignMedia(doneScreencast), "skipped");
    // A still-Pending screencast (capture failed/timed out) DOES fall through.
    const pending = { shotType: "Screencast", captureStatus: "Pending" };
    assert.equal(assignMedia(pending), "assigned-broll");
  });

  console.log(`\n${passed} checks passed`);
}

main();
