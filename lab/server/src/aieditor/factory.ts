/**
 * Auto Editor — the VIDEO FACTORY panel: one DigitalOcean server per heavy job, deleted
 * the moment the job ends (host side: aieditor/aieditor/cloud.py + bin/aieditor-factory).
 *
 * ⚠️ READ-MOSTLY CONTROL PLANE, like control.ts. The Lab never creates or destroys a
 * server. It reads the files the host writes and writes exactly two things:
 *   factory.json             the user-facing settings (on/off, size, parallel, fallback) —
 *                            atomically, every other key preserved
 *   factory-image.request    an empty file: "rebuild the server image" (a host timer
 *                            picks it up within 5 minutes)
 * The DigitalOcean token is used for ONE read: the droplets tagged clipmagic-factory-job /
 * clipmagic-factory-image, so the panel shows what DigitalOcean really bills (and a server
 * the host lost track of). Untagged droplets belong to other projects and are never asked for.
 *
 * Pure node (no npm imports) so scripts/aieditor-factory.test.ts runs with strip-types.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const root = () => process.env.AIEDITOR_WORK || "/aieditor-work";
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export const TAG_JOB = "clipmagic-factory-job";
export const TAG_IMAGE = "clipmagic-factory-image";
/** $/h — mirrors cloud._price (DigitalOcean list prices). */
export const PRICE_HOURLY: Record<string, number> = {
  "c-32": 1.0, "c-16": 0.5, "c2-32vcpu-64gb": 1.11905, "s-2vcpu-4gb": 0.03571,
};
export const SIZES = [
  { id: "c-16", vcpu: 16, ramGb: 32, usdHour: 0.5 },
  { id: "c-32", vcpu: 32, ramGb: 64, usdHour: 1.0 },
] as const;
/** The 500 GiB factory-media Volume, billed whether or not a server runs. */
export const VOLUME_USD_MONTH = 50;
export const BUDGET_USD_MONTH = 100;
/** a tagged droplet younger than this may just not have its lease file yet */
const LEFTOVER_GRACE_S = 300;

const priceOf = (size: unknown) => PRICE_HOURLY[String(size)] ?? 1.0;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, obj: unknown) {
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, file);
}

export interface FactoryHistoryRow {
  job: string; action: string; droplet: number | null; size: string;
  started: number; ended: number; minutes: number; usd: number; ok: boolean; destroyed: boolean;
}

export interface DoDroplet { id: number; name: string; size: string; status: string; created: string; tags: string[] }

export interface FactoryDeps {
  /** the DigitalOcean token, or null — server-side only, never returned */
  token?: () => string | null;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// ── DigitalOcean: the tagged droplets only, cached so a 5 s poll is not 5 s of API calls ──
let doCache: { at: number; key: string; list: DoDroplet[] | null; error: string | null } | null = null;

async function taggedDroplets(token: string, fetchImpl: typeof fetch, nowMs: number) {
  const key = token.slice(-6);
  if (doCache && doCache.key === key && nowMs - doCache.at < 30_000) return doCache;
  const list: DoDroplet[] = [];
  let error: string | null = null;
  for (const tag of [TAG_JOB, TAG_IMAGE]) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      let res: Response;
      try {
        res = await fetchImpl(`https://api.digitalocean.com/v2/droplets?tag_name=${tag}&per_page=200`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        error = `DigitalOcean answered ${res.status}`;
        continue;
      }
      const body = (await res.json()) as { droplets?: any[] };
      for (const d of body.droplets ?? []) {
        const tags: string[] = Array.isArray(d?.tags) ? d.tags : [];
        // belt and braces: only ever show what carries our tag
        if (!tags.includes(tag)) continue;
        if (list.some((x) => x.id === d.id)) continue;
        list.push({
          id: Number(d.id), name: String(d.name ?? ""), size: String(d.size_slug ?? d.size?.slug ?? ""),
          status: String(d.status ?? ""), created: String(d.created_at ?? ""), tags,
        });
      }
    } catch (e) {
      error = e instanceof Error && e.name === "AbortError" ? "DigitalOcean did not answer in time" : "DigitalOcean unreachable";
    }
  }
  doCache = { at: nowMs, key, list: error && list.length === 0 ? null : list, error };
  return doCache;
}

/** Test hook: forget the cached DigitalOcean listing. */
export function resetDoCache() {
  doCache = null;
}

async function readHistory(): Promise<FactoryHistoryRow[]> {
  let text = "";
  try {
    text = await fsp.readFile(path.join(root(), "factory-history.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: FactoryHistoryRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") out.push(r);
    } catch { /* a torn line */ }
  }
  return out;
}

async function jobTitle(id: unknown): Promise<string | null> {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  const req = await readJson<any>(path.join(root(), "jobs", id, "request.json"));
  if (req?.title) return String(req.title);
  const src = await readJson<any>(path.join(root(), "jobs", id, "source.json"));
  return src?.title ? String(src.title) : null;
}

export async function getFactory(deps: FactoryDeps = {}) {
  const now = (deps.now ?? Date.now)() / 1000;
  const r = root();
  const cfg = (await readJson<Record<string, any>>(path.join(r, "factory.json"))) ?? {};
  const token = deps.token?.() ?? null;

  // ── live servers: the lease files the host keeps heart-beating ──
  let leaseNames: string[] = [];
  try {
    leaseNames = (await fsp.readdir(path.join(r, "factory-leases"))).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    leaseNames = [];
  }
  const live = [];
  for (const f of leaseNames) {
    const l = await readJson<any>(path.join(r, "factory-leases", f));
    if (!l) continue;
    const droplet = Number(l.droplet ?? f.replace(/\.json$/, ""));
    const created = Number(l.created) || null;
    const elapsedS = created ? Math.max(0, now - created) : 0;
    const size = l.size ? String(l.size) : l.role === "image" ? String(cfg.builder_size ?? "s-2vcpu-4gb") : String(cfg.size ?? "c-32");
    const job = typeof l.job === "string" ? l.job : null;
    const runner = job && ID_RE.test(job) ? await readJson<any>(path.join(r, "jobs", job, "runner.json")) : null;
    live.push({
      droplet,
      job,
      title: job ? (await jobTitle(job)) ?? job : l.role === "image" ? "Server image build" : null,
      action: l.action ? String(l.action) : l.role === "image" ? "image" : null,
      role: l.role ? String(l.role) : "job",
      size,
      state: runner?.state ? String(runner.state) : null,
      created,
      heartbeat: Number(l.heartbeat) || null,
      /** heartbeat older than 2 min: the host may have lost the server (its watchdog deletes it at 10) */
      stale: !!l.heartbeat && now - Number(l.heartbeat) > 120,
      elapsedMin: round(elapsedS / 60, 1),
      estUsd: round((elapsedS / 3600) * priceOf(size), 3),
      priceHourly: priceOf(size),
    });
  }
  live.sort((a, b) => (a.created ?? 0) - (b.created ?? 0));

  // ── history + this calendar month (UTC: what DigitalOcean bills) ──
  const rows = await readHistory();
  const d = new Date(now * 1000);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const monthRows = rows.filter((x) => Number(x.started) >= monthStart);
  const serverUsd = round(monthRows.reduce((a, x) => a + (Number(x.usd) || 0), 0), 3);
  const liveUsd = round(live.reduce((a, x) => a + x.estUsd, 0), 3);
  const history = [];
  for (const x of rows.slice(-30).reverse()) {
    history.push({ ...x, title: (await jobTitle(x.job)) ?? x.job });
  }

  // ── what DigitalOcean itself reports (optional) ──
  let doTagged: (DoDroplet & { leftover: boolean })[] | null = null;
  let doError: string | null = null;
  if (token) {
    const got = await taggedDroplets(token, deps.fetchImpl ?? fetch, now * 1000);
    doError = got.error;
    if (got.list) {
      const leased = new Set(live.map((x) => x.droplet));
      doTagged = got.list.map((x) => {
        const age = now - Date.parse(x.created) / 1000;
        return { ...x, leftover: !leased.has(x.id) && !(age < LEFTOVER_GRACE_S) };
      });
    }
  }

  const image = await readJson<any>(path.join(r, "factory-image.json"));
  let requested = false;
  try {
    await fsp.access(path.join(r, "factory-image.request"));
    requested = true;
  } catch {
    requested = false;
  }
  const hb = await readJson<any>(path.join(r, "worker-heartbeat.json"));

  const { snapshot_manifest: _m, vpc_uuid: _v, vpc_range: _vr, ...settings } = cfg;
  return {
    settings: {
      ...settings,
      enabled: !!cfg.enabled,
      size: String(cfg.size ?? "c-32"),
      maxParallel: Number(cfg.max_parallel ?? 2),
      maxHours: Number(cfg.max_hours ?? 10),
      fallbackLocal: cfg.fallback_local !== false,
      region: String(cfg.region ?? "sgp1"),
    },
    sizes: SIZES,
    tokenSet: !!token,
    snapshot: {
      id: cfg.snapshot_id ?? null,
      name: cfg.snapshot_name ?? null,
      builtAt: Number(cfg.snapshot_at) || null,
    },
    image: image
      ? {
        state: image.state ?? null, started: image.started ?? null, finished: image.finished ?? null,
        error: image.error ?? null, log: Array.isArray(image.log) ? image.log.slice(-40) : [], requested,
      }
      : { state: null, started: null, finished: null, error: null, log: [], requested },
    live,
    doTagged,
    doError,
    history,
    month: {
      serverUsd,
      liveUsd,
      runs: monthRows.length,
      minutes: round(monthRows.reduce((a, x) => a + (Number(x.minutes) || 0), 0), 1),
      volumeUsd: VOLUME_USD_MONTH,
      budgetUsd: BUDGET_USD_MONTH,
    },
    worker: {
      alive: !!hb?.at && now - Number(hb.at) < 30,
      seenAt: Number(hb?.at) || null,
      factoryJobs: typeof hb?.factory_jobs === "number" ? hb.factory_jobs : null,
    },
  };
}

export interface FactorySettingsInput {
  enabled?: unknown; size?: unknown; maxParallel?: unknown; fallbackLocal?: unknown;
}

/** Validates the panel's subset and merges it into factory.json (every other key kept). */
export async function saveFactorySettings(input: FactorySettingsInput, deps: FactoryDeps = {}) {
  const file = path.join(root(), "factory.json");
  const cur = (await readJson<Record<string, any>>(file)) ?? {};
  const next: Record<string, any> = { ...cur };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("enabled must be true or false.");
    if (input.enabled && !cur.snapshot_id) throw new Error("Build the server image first — there is nothing to start a server from.");
    next.enabled = input.enabled;
  }
  if (input.size !== undefined) {
    if (!SIZES.some((s) => s.id === input.size)) throw new Error("Server size must be c-16 or c-32.");
    next.size = input.size;
  }
  if (input.maxParallel !== undefined) {
    const n = Number(input.maxParallel);
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error("Parallel servers must be 1–4.");
    next.max_parallel = n;
  }
  if (input.fallbackLocal !== undefined) {
    if (typeof input.fallbackLocal !== "boolean") throw new Error("fallbackLocal must be true or false.");
    next.fallback_local = input.fallbackLocal;
  }
  await writeJson(file, next);
  return getFactory(deps);
}

/** "Rebuild server image": drop the request file the host timer looks for. */
export async function requestImageRebuild() {
  const r = root();
  const state = await readJson<any>(path.join(r, "factory-image.json"));
  if (state?.state === "building") return { requested: false, state: "building", message: "A build is already running." };
  await fsp.writeFile(path.join(r, "factory-image.request"), "");
  return { requested: true, state: "requested", message: "Requested — the host starts it within 5 minutes." };
}
