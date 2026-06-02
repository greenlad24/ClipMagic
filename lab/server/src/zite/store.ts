import { nanoid } from "nanoid";
import { db } from "../db/index.js";

/**
 * Zite-compatible document store.
 *
 * The original ClipMagic endpoints (exported from Zite) read and write records
 * with arbitrary camelCase fields via a data SDK (Projects/Shots/MusicTracks/
 * PromoVideos). Rather than force every field into rigid columns, each
 * collection is stored as a JSON document keyed by id, with a couple of indexed
 * columns for the filters the app actually uses (user, project). This lets the
 * ported endpoint logic run essentially unchanged.
 */

export type Collection = "projects" | "shots" | "musicTracks" | "promoVideos" | "users" | "narrationCuts";

const TABLE: Record<Collection, string> = {
  projects: "z_projects",
  shots: "z_shots",
  musicTracks: "z_music_tracks",
  promoVideos: "z_promo_videos",
  users: "z_users",
  narrationCuts: "z_narration_cuts",
};

db.exec(`
CREATE TABLE IF NOT EXISTS z_projects (
  id TEXT PRIMARY KEY, user_id TEXT, doc TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS z_shots (
  id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT, doc TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS z_music_tracks (
  id TEXT PRIMARY KEY, user_id TEXT, doc TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS z_promo_videos (
  id TEXT PRIMARY KEY, user_id TEXT, doc TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS z_users (
  id TEXT PRIMARY KEY, user_id TEXT, doc TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS z_narration_cuts (
  id TEXT PRIMARY KEY, user_id TEXT, doc TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_z_shots_project ON z_shots(project_id);
CREATE INDEX IF NOT EXISTS idx_z_projects_user ON z_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_z_narration_cuts_user ON z_narration_cuts(user_id);
`);

export type Record_ = { id: string; createdAt?: string; [k: string]: unknown };

export interface FindAllArgs {
  filters?: Record<string, unknown>;
  limit?: number;
}

/** Columns we index per collection so common filters hit an index. */
function indexedCols(col: Collection, record: Record_): { user_id: string | null; project_id?: string | null } {
  const user_id = (record.user as string) ?? null;
  if (col === "shots") {
    const project_id = (record.project as string) ?? null;
    return { user_id, project_id };
  }
  return { user_id };
}

function rowToRecord(row: { doc: string }): Record_ {
  return JSON.parse(row.doc) as Record_;
}

/** Apply remaining equality filters (beyond the indexed ones) in JS. */
function matchesFilters(rec: Record_, filters: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined) continue;
    if (rec[k] !== v) return false;
  }
  return true;
}

export function makeCollection(col: Collection) {
  const table = TABLE[col];

  return {
    async findOne(args: { id: string }): Promise<Record_ | null> {
      const row = db.prepare(`SELECT doc FROM ${table} WHERE id = ?`).get(args.id) as
        | { doc: string }
        | undefined;
      return row ? rowToRecord(row) : null;
    },

    async findAll(args: FindAllArgs = {}): Promise<{ records: Record_[] }> {
      const filters = args.filters ?? {};
      // Use indexed columns where possible.
      const where: string[] = [];
      const params: unknown[] = [];
      if (col === "shots" && "project" in filters) {
        where.push("project_id = ?");
        params.push(filters.project);
      }
      if ("user" in filters) {
        where.push("user_id = ?");
        params.push(filters.user);
      }
      const sql = `SELECT doc FROM ${table}${where.length ? " WHERE " + where.join(" AND ") : ""}`;
      const rows = db.prepare(sql).all(...params) as { doc: string }[];
      let records = rows.map(rowToRecord);
      // Apply any non-indexed equality filters in JS (e.g. analysisStatus).
      const residual = { ...filters };
      delete residual.user;
      if (col === "shots") delete residual.project;
      if (Object.keys(residual).length) records = records.filter((r) => matchesFilters(r, residual));
      if (args.limit && records.length > args.limit) records = records.slice(0, args.limit);
      return { records };
    },

    async create(args: { record: Record<string, unknown> }): Promise<Record_> {
      const id = (args.record.id as string) || nanoid();
      const createdAt = (args.record.createdAt as string) || new Date().toISOString();
      const record: Record_ = { ...args.record, id, createdAt };
      const cols = indexedCols(col, record);
      db.prepare(
        `INSERT INTO ${table} (id, user_id, ${col === "shots" ? "project_id, " : ""}doc, created_at)
         VALUES (?, ?, ${col === "shots" ? "?, " : ""}?, ?)`
      ).run(
        id,
        cols.user_id,
        ...(col === "shots" ? [cols.project_id ?? null] : []),
        JSON.stringify(record),
        Date.now()
      );
      return record;
    },

    async bulkCreate(args: { records: Record<string, unknown>[] }): Promise<{ records: Record_[] }> {
      const out: Record_[] = [];
      const tx = db.transaction(() => {
        for (const r of args.records) {
          // reuse create synchronously
          const id = (r.id as string) || nanoid();
          const createdAt = (r.createdAt as string) || new Date().toISOString();
          const record: Record_ = { ...r, id, createdAt };
          const cols = indexedCols(col, record);
          db.prepare(
            `INSERT INTO ${table} (id, user_id, ${col === "shots" ? "project_id, " : ""}doc, created_at)
             VALUES (?, ?, ${col === "shots" ? "?, " : ""}?, ?)`
          ).run(
            id,
            cols.user_id,
            ...(col === "shots" ? [cols.project_id ?? null] : []),
            JSON.stringify(record),
            Date.now()
          );
          out.push(record);
        }
      });
      tx();
      return { records: out };
    },

    async update(args: { id: string; record: Record<string, unknown> }): Promise<Record_> {
      const row = db.prepare(`SELECT doc FROM ${table} WHERE id = ?`).get(args.id) as
        | { doc: string }
        | undefined;
      if (!row) throw new Error(`${col} record not found: ${args.id}`);
      const merged: Record_ = { ...rowToRecord(row), ...args.record, id: args.id };
      const cols = indexedCols(col, merged);
      if (col === "shots") {
        db.prepare(`UPDATE ${table} SET doc = ?, user_id = ?, project_id = ? WHERE id = ?`).run(
          JSON.stringify(merged),
          cols.user_id,
          cols.project_id ?? null,
          args.id
        );
      } else {
        db.prepare(`UPDATE ${table} SET doc = ?, user_id = ? WHERE id = ?`).run(
          JSON.stringify(merged),
          cols.user_id,
          args.id
        );
      }
      return merged;
    },

    async delete(args: { id: string }): Promise<{ id: string }> {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(args.id);
      return { id: args.id };
    },
  };
}

export const Projects = makeCollection("projects");
export const Shots = makeCollection("shots");
export const MusicTracks = makeCollection("musicTracks");
export const PromoVideos = makeCollection("promoVideos");
export const Users = makeCollection("users");
export const NarrationCuts = makeCollection("narrationCuts");

/** A Zite-style typed error the endpoints throw. */
export class ZiteError extends Error {
  code: string;
  constructor(args: { code: string; message: string }) {
    super(args.message);
    this.code = args.code;
    this.name = "ZiteError";
  }
}
