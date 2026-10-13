/**
 * vidIQ — real monthly YouTube search volume (Jake 2026-10-13: "the keywords
 * data should come from youtube search volume"). YouTube publishes no search
 * volume and has no API for it; vidIQ estimates it (rolling 30 days) and sells
 * it through its MCP server, which this calls with Jake's API key
 * (VIDIQ_API_KEY, Lab Settings → Keyword Research).
 *
 * The MCP server speaks JSON-RPC over HTTP ("streamable HTTP"): initialize →
 * notifications/initialized → tools/call. One `vidiq_keyword_research` call
 * (mode "research") costs ~5 credits and returns the seed plus ~20 related
 * searches, each with:
 *   estimatedMonthlySearch     monthly YouTube searches, worldwide
 *   countryVolume              …of them in `country` (we ask for US)
 *   baselineMonthlySearches30d the month before
 *   searchDemandGrowthPct      this month vs that baseline (the "trending" signal)
 *   competition / overall      vidIQ's 0–100 scores
 * A search under 750/month comes back as 0 with "<750".
 *
 * Credits are scarce (the Free plan has 150 a month), so every seed's result is
 * cached in SQLite for CACHE_DAYS and reused across briefs.
 */
import { db } from "../db/index.js";
import { getVidIqApiKey } from "../settings/postizSecrets.js";

const ENDPOINT = process.env.VIDIQ_MCP_URL || "https://mcp.vidiq.com/mcp";
const CACHE_DAYS = 7;

db.exec(`
CREATE TABLE IF NOT EXISTS vidiq_keyword_cache (
  seed TEXT NOT NULL,
  country TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (seed, country)
);
`);

export interface YtSearchDemand {
  keyword: string;
  /** Monthly YouTube searches worldwide (0 = under 750). */
  monthly: number;
  /** …of them in the country asked for (US), when vidIQ has it. */
  country: number | null;
  /** This month vs the month before, %; null when not measured. */
  growthPct: number | null;
  /** vidIQ competition 0–100 (higher = harder). */
  competition: number | null;
  /** vidIQ overall opportunity 0–100. */
  overall: number | null;
  /** The seed it came from. */
  seed: string;
}

export class VidIqError extends Error {
  constructor(message: string, readonly kind: "no_key" | "credits" | "failed") { super(message); }
}

export const vidIqConfigured = (): boolean => !!getVidIqApiKey();

/** One MCP session: initialize once, then call tools. */
class Session {
  private id: string | null = null;
  private seq = 0;
  constructor(private readonly key: string) {}

  private async post(body: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${this.key}` };
    if (this.id) headers["mcp-session-id"] = this.id;
    const res = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    this.id = res.headers.get("mcp-session-id") || this.id;
    const text = await res.text();
    // SSE ("data: {…}") or plain JSON
    const data = [...text.matchAll(/^data: (.*)$/gm)].map((m) => m[1]).pop() ?? text;
    let json: any = null;
    try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
    return { status: res.status, json };
  }

  async open(): Promise<void> {
    const r = await this.post({ jsonrpc: "2.0", id: ++this.seq, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clipmagic-lab", version: "1.0" } } });
    if (r.status === 401 || r.status === 403) throw new VidIqError("vidIQ refused the API key — check it in the Lab's Settings.", "no_key");
    if (r.status !== 200 || !r.json?.result) throw new VidIqError(`vidIQ didn't connect (HTTP ${r.status}).`, "failed");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await this.post({ jsonrpc: "2.0", id: ++this.seq, method: "tools/call", params: { name, arguments: args } });
    const result = r.json?.result;
    const errText = r.json?.error?.message ?? (result?.isError ? String(result?.content?.[0]?.text ?? "") : "");
    if (errText || r.status !== 200) {
      const msg = errText || `HTTP ${r.status}`;
      throw new VidIqError(/credit|balance|insufficient|quota|limit/i.test(msg) ? `vidIQ is out of credits: ${msg.slice(0, 200)}` : `vidIQ ${name} failed: ${msg.slice(0, 200)}`, /credit|balance|insufficient|quota|limit/i.test(msg) ? "credits" : "failed");
    }
    return result;
  }
}

/** The keyword JSON from a research result (structuredContent, or the JSON after "Keyword data (JSON):"). */
function researchJson(result: any): any {
  if (result?.structuredContent?.seedKeyword) return result.structuredContent;
  const text = String(result?.content?.find((c: any) => c?.type === "text")?.text ?? "");
  const at = text.indexOf("{", text.indexOf("Keyword data (JSON):"));
  if (at < 0) return null;
  try { return JSON.parse(text.slice(at)); } catch { return null; }
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function toRow(k: any, seed: string): YtSearchDemand | null {
  const keyword = typeof k?.keyword === "string" ? k.keyword.trim() : "";
  if (!keyword) return null;
  return {
    keyword,
    monthly: Math.max(0, Math.round(num(k.estimatedMonthlySearch) ?? 0)),
    country: num(k.countryVolume) != null ? Math.round(k.countryVolume) : null,
    growthPct: num(k.searchDemandGrowthPct) != null ? Math.round(k.searchDemandGrowthPct) : null,
    competition: num(k.competition) != null ? Math.round(k.competition) : null,
    overall: num(k.overall) != null ? Math.round(k.overall) : null,
    seed,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function cached(seed: string, country: string): YtSearchDemand[] | null {
  const r = db.prepare(`SELECT rows_json, fetched_at FROM vidiq_keyword_cache WHERE seed = ? AND country = ?`).get(norm(seed), country) as any;
  if (!r || Date.now() - new Date(r.fetched_at).getTime() > CACHE_DAYS * 86_400_000) return null;
  try { return JSON.parse(r.rows_json); } catch { return null; }
}

/**
 * Monthly YouTube search volume for each seed and its related searches,
 * deduplicated (highest volume wins). Cached seeds cost nothing; the rest cost
 * ~5 vidIQ credits each. Stops at the first credit/key error and returns what
 * it has, with the error, so a brief still gets made on partial data.
 */
export async function youtubeSearchDemand(seeds: string[], opts: { country?: string; onProgress?: (msg: string) => void } = {}): Promise<{ rows: YtSearchDemand[]; fetched: number; fromCache: number; error: VidIqError | null }> {
  const country = (opts.country || "US").toUpperCase();
  const key = getVidIqApiKey();
  const all = new Map<string, YtSearchDemand>();
  const add = (rows: YtSearchDemand[]) => { for (const r of rows) { const k = norm(r.keyword); const prev = all.get(k); if (!prev || r.monthly > prev.monthly) all.set(k, r); } };
  let fetched = 0, fromCache = 0;
  let error: VidIqError | null = null;
  let session: Session | null = null;
  const unique = [...new Map(seeds.map((s) => [norm(s), s.trim()])).values()].filter(Boolean);
  for (const [i, seed] of unique.entries()) {
    const hit = cached(seed, country);
    if (hit) { add(hit); fromCache++; continue; }
    if (!key) { error = new VidIqError("No vidIQ API key — add it in the Lab's Settings (Keyword Research).", "no_key"); break; }
    try {
      opts.onProgress?.(`Measuring YouTube searches with vidIQ (${i + 1}/${unique.length}): "${seed}"…`);
      if (!session) { session = new Session(key); await session.open(); }
      const result = await session.call("vidiq_keyword_research", { mode: "research", keyword: seed.slice(0, 150), country, includeRelated: true, topMarketsLimit: 1 });
      const j = researchJson(result);
      if (!j?.seedKeyword) throw new VidIqError(`vidIQ returned no keyword data for "${seed}".`, "failed");
      const rows = [j.seedKeyword, ...(Array.isArray(j.relatedKeywords) ? j.relatedKeywords : [])].map((k: any) => toRow(k, seed)).filter((x): x is YtSearchDemand => !!x);
      db.prepare(`INSERT OR REPLACE INTO vidiq_keyword_cache (seed, country, rows_json, fetched_at) VALUES (?, ?, ?, ?)`).run(norm(seed), country, JSON.stringify(rows), new Date().toISOString());
      add(rows);
      fetched++;
    } catch (e) {
      error = e instanceof VidIqError ? e : new VidIqError(`vidIQ failed: ${(e as Error).message}`, "failed");
      if (error.kind !== "failed") break; // no key / no credits: stop; a one-off failure: try the next seed
    }
  }
  return { rows: [...all.values()].sort((a, b) => b.monthly - a.monthly), fetched, fromCache, error };
}

/** The account's credit balance (free call). */
export async function vidIqBalance(): Promise<{ total: number; plan: string | null; resetsAt: string | null } | null> {
  const key = getVidIqApiKey();
  if (!key) return null;
  const s = new Session(key);
  await s.open();
  const r = await s.call("vidiq_balance", {});
  const sc = r?.structuredContent ?? {};
  return { total: Number(sc.totalCredits ?? 0), plan: r?._meta?.widgetData?.planName ?? null, resetsAt: sc.renewableResetsAt ?? null };
}
