import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { asyncHandler } from "../middleware.js";

/**
 * Project / Shot / Music CRUD — the self-hosted replacement for the Zite
 * "Projects", "Shots" and "MusicTracks" tables and their endpoints. Columns the
 * timeline/render path queries are first-class; the rest of each record is kept
 * in a JSON `data` blob so the schema stays stable as the UI evolves.
 */
const router = Router();
const now = () => Date.now();

// ── Projects ─────────────────────────────────────────────────────────────────
const projectFields = [
  "title", "status", "context_hint", "narration_url", "output_url", "accent_color",
  "duration_seconds", "transcript", "music_track_id", "music_volume",
  "beat_structure_json", "director_json", "validation_errors", "audio_url",
  "video_chunks_json", "subtitles_json", "animation_map_json",
] as const;

const projectSchema = z
  .object({
    title: z.string().optional(),
    status: z.string().optional(),
    context_hint: z.string().nullable().optional(),
    narration_url: z.string().nullable().optional(),
    output_url: z.string().nullable().optional(),
    accent_color: z.string().nullable().optional(),
    duration_seconds: z.number().nullable().optional(),
    transcript: z.string().nullable().optional(),
    music_track_id: z.string().nullable().optional(),
    music_volume: z.number().nullable().optional(),
    beat_structure_json: z.string().nullable().optional(),
    director_json: z.string().nullable().optional(),
    validation_errors: z.string().nullable().optional(),
    audio_url: z.string().nullable().optional(),
    video_chunks_json: z.string().nullable().optional(),
    subtitles_json: z.string().nullable().optional(),
    animation_map_json: z.string().nullable().optional(),
  })
  .passthrough();

router.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
  res.json({ projects: rows });
});

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = projectSchema.parse(req.body ?? {});
    const id = nanoid();
    const t = now();
    db.prepare(
      "INSERT INTO projects (id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)"
    ).run(id, body.title ?? "", body.status ?? "Uploading", t, t);
    applyProjectUpdate(id, body);
    res.json({ id, project: getProject(id) });
  })
);

router.get("/:id", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const shots = db.prepare("SELECT * FROM shots WHERE project_id = ? ORDER BY idx ASC").all(req.params.id);
  res.json({ project: p, shots });
});

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!getProject(req.params.id)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    applyProjectUpdate(req.params.id, projectSchema.parse(req.body ?? {}));
    res.json({ project: getProject(req.params.id) });
  })
);

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

function getProject(id: string) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function applyProjectUpdate(id: string, body: Record<string, unknown>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of projectFields) {
    if (f in body && body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(body[f]);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(now(), id);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

// ── Shots ────────────────────────────────────────────────────────────────────
const shotSchema = z.object({
  id: z.string().optional(),
  idx: z.number().optional(),
  startTime: z.number().nullable().optional(),
  endTime: z.number().nullable().optional(),
  shotType: z.string().nullable().optional(),
  clipUrl: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
}).passthrough();

/** Replace the full shot list for a project (bulk save from the timeline). */
router.put(
  "/:id/shots",
  asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    if (!getProject(projectId)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const shots = z.array(shotSchema).parse(req.body?.shots ?? []);
    const t = now();
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM shots WHERE project_id = ?").run(projectId);
      const ins = db.prepare(
        `INSERT INTO shots (id, project_id, idx, start_time, end_time, shot_type, clip_url, caption, data, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      shots.forEach((s, i) => {
        ins.run(
          s.id ?? nanoid(),
          projectId,
          s.idx ?? i,
          s.startTime ?? null,
          s.endTime ?? null,
          s.shotType ?? null,
          s.clipUrl ?? null,
          s.caption ?? null,
          JSON.stringify(s),
          t,
          t
        );
      });
    });
    tx();
    const saved = db.prepare("SELECT * FROM shots WHERE project_id = ? ORDER BY idx ASC").all(projectId);
    res.json({ shots: saved });
  })
);

// ── Music tracks ─────────────────────────────────────────────────────────────
router.get("/music/all", (_req, res) => {
  res.json({ tracks: db.prepare("SELECT * FROM music_tracks ORDER BY created_at DESC").all() });
});

router.post(
  "/music",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string(),
        url: z.string(),
        bpm: z.number().optional(),
        volume: z.number().optional(),
      })
      .parse(req.body);
    const id = nanoid();
    db.prepare(
      "INSERT INTO music_tracks (id, name, url, bpm, volume, created_at) VALUES (?,?,?,?,?,?)"
    ).run(id, body.name, body.url, body.bpm ?? null, body.volume ?? 0.18, now());
    res.json({ id });
  })
);

router.delete("/music/:id", (req, res) => {
  db.prepare("DELETE FROM music_tracks WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

export default router;
