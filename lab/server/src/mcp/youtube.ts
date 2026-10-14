/**
 * A small PUBLIC MCP server for the YouTube Data API (Jake 2026-10-14: "a small
 * public mcp connection in the server so I can install it in my ChatGPT
 * account — this mcp will call YouTube data API"), mounted outside the Lab's
 * sign-in gate at:
 *
 *   POST https://<lab>/mcp/youtube/<token>      (MCP "streamable HTTP", JSON responses)
 *
 * THE TOKEN IS THE KEY: a 32-byte random secret generated on first start and
 * kept in DATA_DIR/mcp/youtube-token (0600) — or YOUTUBE_MCP_TOKEN in the env.
 * Any other path is a 404. A Bearer header with the same token works too.
 *
 * The YouTube key is server-side only: YOUTUBE_API_KEY (Lab Settings or env),
 * else the Lab's own YOUTUBE_DATA_API_KEY. It never leaves the server.
 *
 * Read-only tools. Guards: 60 requests/minute per IP, and a daily cap of
 * DAILY_UNITS YouTube quota units for this endpoint (the key's whole day is
 * 10,000 and the Lab's own tools use it too). search.list = 100 units, every
 * other call here = 1.
 */
import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getYoutubeApiKeyForMcp } from "../settings/postizSecrets.js";

const API = "https://www.googleapis.com/youtube/v3";
const DAILY_UNITS = Number(process.env.YOUTUBE_MCP_DAILY_UNITS) || 5000;
const PER_MINUTE = 60;
const PROTOCOL = "2025-06-18";

/* ── the secret path ──────────────────────────────────────────────────────── */

const tokenFile = () => path.join(config.dataDir, "mcp", "youtube-token");
export function mcpYoutubeToken(): string {
  const env = (process.env.YOUTUBE_MCP_TOKEN || "").trim();
  if (env.length >= 24) return env;
  try { const t = fs.readFileSync(tokenFile(), "utf8").trim(); if (t.length >= 24) return t; } catch { /* make one */ }
  const t = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), t, { mode: 0o600 });
  return t;
}
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ── guards ───────────────────────────────────────────────────────────────── */

const hits = new Map<string, number[]>();
function rateOk(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length <= PER_MINUTE;
}
let quota = { day: "", used: 0 };
function spend(units: number): void {
  const day = new Date().toISOString().slice(0, 10);
  if (quota.day !== day) quota = { day, used: 0 };
  if (quota.used + units > DAILY_UNITS) throw new Error(`Today's YouTube quota for this connector is used up (${quota.used}/${DAILY_UNITS} units; it resets at midnight Pacific / 07:00 UTC). A search costs 100, everything else 1.`);
  quota.used += units;
}

/* ── YouTube calls ────────────────────────────────────────────────────────── */

async function yt(endpoint: string, params: Record<string, string | number | undefined>, units: number): Promise<any> {
  const key = getYoutubeApiKeyForMcp();
  if (!key) throw new Error("No YouTube API key on the server (YOUTUBE_API_KEY).");
  spend(units);
  const u = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  u.searchParams.set("key", key);
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) {
    const reason = j?.error?.errors?.[0]?.reason ?? "";
    throw new Error(`YouTube API ${r.status}${reason ? ` (${reason})` : ""}: ${String(j?.error?.message ?? "request failed").replace(key, "***").slice(0, 300)}`);
  }
  return j;
}

const VIDEO_ID = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})|^([\w-]{11})$/;
function videoId(s: string): string | null { const m = VIDEO_ID.exec(String(s).trim()); return m ? (m[1] ?? m[2]) : null; }
const isoSecs = (d: string) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || ""); return m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : null; };
const n = (x: unknown) => (x == null ? null : Number(x));
const clamp = (v: unknown, lo: number, hi: number, dflt: number) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : dflt; };

function videoOut(v: any) {
  const secs = isoSecs(v.contentDetails?.duration);
  return {
    id: v.id, url: `https://www.youtube.com/watch?v=${v.id}`,
    title: v.snippet?.title, channel: v.snippet?.channelTitle, channelId: v.snippet?.channelId,
    publishedAt: v.snippet?.publishedAt, durationSeconds: secs, isShort: secs != null ? secs <= 180 : null,
    views: n(v.statistics?.viewCount), likes: n(v.statistics?.likeCount), comments: n(v.statistics?.commentCount),
    tags: (v.snippet?.tags ?? []).slice(0, 20), description: String(v.snippet?.description ?? "").slice(0, 1500),
    thumbnail: v.snippet?.thumbnails?.maxres?.url ?? v.snippet?.thumbnails?.high?.url ?? null,
  };
}

async function videos(ids: string[]) {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await yt("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") }, 1);
    out.push(...(j.items ?? []).map(videoOut));
  }
  return out;
}

async function resolveChannel(ref: string): Promise<string> {
  const s = String(ref ?? "").trim();
  const id = /(UC[\w-]{22})/.exec(s)?.[1];
  if (id) return id;
  const handle = /@([\w.-]+)/.exec(s)?.[1] ?? (/^[\w.-]+$/.test(s) ? s : null);
  if (!handle) throw new Error("Give a channel id (UC…), a @handle or a channel URL.");
  const j = await yt("channels", { part: "id", forHandle: `@${handle}` }, 1);
  const found = j.items?.[0]?.id;
  if (!found) throw new Error(`No channel found for @${handle}.`);
  return found;
}

/* ── tools ────────────────────────────────────────────────────────────────── */

interface Tool { name: string; title: string; description: string; inputSchema: any; run: (a: any) => Promise<unknown> }

const TOOLS: Tool[] = [
  {
    name: "youtube_search",
    title: "Search YouTube",
    description: "Search YouTube for videos (default), channels or playlists. Video results include views, likes, duration and whether it's a Short. Costs 100 quota units — prefer the other tools when you already have an id.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "What to search for" },
      type: { type: "string", enum: ["video", "channel", "playlist"], default: "video" },
      order: { type: "string", enum: ["relevance", "viewCount", "date", "rating"], default: "relevance" },
      maxResults: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      publishedAfter: { type: "string", description: "ISO date, e.g. 2026-01-01T00:00:00Z" },
      regionCode: { type: "string", description: "Two-letter country, e.g. US" },
      videoDuration: { type: "string", enum: ["any", "short", "medium", "long"], description: "short < 4 min, medium 4–20, long > 20" },
    }, required: ["query"] },
    run: async (a) => {
      const type = ["video", "channel", "playlist"].includes(a.type) ? a.type : "video";
      const j = await yt("search", {
        part: "snippet", q: String(a.query ?? "").slice(0, 200), type, maxResults: clamp(a.maxResults, 1, 25, 10),
        order: ["relevance", "viewCount", "date", "rating"].includes(a.order) ? a.order : "relevance",
        publishedAfter: a.publishedAfter, regionCode: a.regionCode, videoDuration: type === "video" ? a.videoDuration : undefined,
      }, 100);
      const items = j.items ?? [];
      if (type === "video") {
        const stats = new Map((await videos(items.map((x: any) => x.id?.videoId).filter(Boolean))).map((v) => [v.id, v]));
        return { totalResults: j.pageInfo?.totalResults ?? null, results: items.map((x: any) => { const v = stats.get(x.id?.videoId); return v ? { ...v, description: v.description.slice(0, 300) } : null; }).filter(Boolean) };
      }
      return { totalResults: j.pageInfo?.totalResults ?? null, results: items.map((x: any) => ({ id: x.id?.channelId ?? x.id?.playlistId, title: x.snippet?.title, channel: x.snippet?.channelTitle, description: x.snippet?.description, publishedAt: x.snippet?.publishedAt })) };
    },
  },
  {
    name: "youtube_video_details",
    title: "Video details",
    description: "Details and stats (views, likes, comments, duration, tags, description) for up to 50 videos, by id or URL. 1 unit per 50 videos.",
    inputSchema: { type: "object", properties: { videos: { type: "array", items: { type: "string" }, description: "Video ids or YouTube URLs", maxItems: 50 } }, required: ["videos"] },
    run: async (a) => {
      const ids = [...new Set((Array.isArray(a.videos) ? a.videos : [a.videos]).map((x: unknown) => videoId(String(x))).filter(Boolean) as string[])].slice(0, 50);
      if (!ids.length) throw new Error("No valid video ids or URLs.");
      return { videos: await videos(ids) };
    },
  },
  {
    name: "youtube_channel",
    title: "Channel details",
    description: "A channel's stats (subscribers, total views, video count), description, country and creation date — by id (UC…), @handle or URL.",
    inputSchema: { type: "object", properties: { channel: { type: "string", description: "Channel id, @handle or URL" } }, required: ["channel"] },
    run: async (a) => {
      const id = await resolveChannel(a.channel);
      const j = await yt("channels", { part: "snippet,statistics,contentDetails", id }, 1);
      const c = j.items?.[0];
      if (!c) throw new Error("Channel not found.");
      return {
        id: c.id, url: `https://www.youtube.com/channel/${c.id}`, title: c.snippet?.title, handle: c.snippet?.customUrl,
        description: String(c.snippet?.description ?? "").slice(0, 1500), country: c.snippet?.country ?? null, createdAt: c.snippet?.publishedAt,
        subscribers: c.statistics?.hiddenSubscriberCount ? null : n(c.statistics?.subscriberCount), views: n(c.statistics?.viewCount), videoCount: n(c.statistics?.videoCount),
      };
    },
  },
  {
    name: "youtube_channel_videos",
    title: "A channel's latest videos",
    description: "A channel's most recent uploads (newest first) with views, likes, duration and Short/long-form. Optionally only long-form or only Shorts.",
    inputSchema: { type: "object", properties: {
      channel: { type: "string", description: "Channel id, @handle or URL" },
      maxResults: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      format: { type: "string", enum: ["all", "long", "shorts"], default: "all" },
    }, required: ["channel"] },
    run: async (a) => {
      const id = await resolveChannel(a.channel);
      const max = clamp(a.maxResults, 1, 50, 20);
      const j = await yt("playlistItems", { part: "contentDetails", playlistId: `UU${id.slice(2)}`, maxResults: 50 }, 1);
      let list = await videos((j.items ?? []).map((x: any) => x.contentDetails?.videoId).filter(Boolean));
      if (a.format === "long") list = list.filter((v) => v.isShort === false);
      if (a.format === "shorts") list = list.filter((v) => v.isShort === true);
      return { channelId: id, videos: list.slice(0, max).map((v) => ({ ...v, description: v.description.slice(0, 300) })) };
    },
  },
  {
    name: "youtube_video_comments",
    title: "Video comments",
    description: "Top-level comments on a video (most relevant or newest), with like counts and reply counts.",
    inputSchema: { type: "object", properties: {
      video: { type: "string", description: "Video id or URL" },
      order: { type: "string", enum: ["relevance", "time"], default: "relevance" },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    }, required: ["video"] },
    run: async (a) => {
      const id = videoId(String(a.video ?? ""));
      if (!id) throw new Error("Not a video id or URL.");
      const j = await yt("commentThreads", { part: "snippet", videoId: id, order: a.order === "time" ? "time" : "relevance", maxResults: clamp(a.maxResults, 1, 100, 50), textFormat: "plainText" }, 1);
      return { videoId: id, comments: (j.items ?? []).map((t: any) => { const c = t.snippet?.topLevelComment?.snippet ?? {}; return { author: c.authorDisplayName, text: String(c.textDisplay ?? "").slice(0, 1000), likes: n(c.likeCount), replies: n(t.snippet?.totalReplyCount), publishedAt: c.publishedAt }; }) };
    },
  },
];

/* ── JSON-RPC ─────────────────────────────────────────────────────────────── */

async function handle(msg: any): Promise<any | null> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  if (id === undefined) return null; // a notification
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "youtube-data", title: "YouTube Data", version: "1.0.0" },
        instructions: "Read-only YouTube Data API tools: search, video details, channel details, a channel's latest videos, comments. youtube_search costs 100 quota units; the rest 1. Prefer ids/URLs over searching when you have them.",
      });
    case "ping": return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const out = await tool.run(msg.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export function youtubeMcpRouter() {
  const r = express.Router();
  const authed = (req: Request) => {
    const t = mcpYoutubeToken();
    const fromPath = String(req.params.token ?? "");
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    return (fromPath && same(fromPath, t)) || (bearer && same(bearer, t));
  };
  r.post("/:token", express.json({ limit: "256kb" }), async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(404).end(); return; }
    if (!rateOk(req.ip ?? "?")) { res.status(429).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests — wait a minute." } }); return; }
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      if (!out.length) { res.status(202).end(); return; }
      res.json(out);
      return;
    }
    const out = await handle(body);
    if (!out) { res.status(202).end(); return; }
    res.json(out);
  });
  // No server-to-client stream and no sessions: GET/DELETE are not offered.
  r.all("/:token", (req: Request, res: Response) => { if (!authed(req)) { res.status(404).end(); return; } res.status(405).set("Allow", "POST").end(); });
  r.all("*", (_req, res) => { res.status(404).end(); });
  return r;
}
