/**
 * ONE STABLE FOLLOWER LINK (Jake, 2026-10-07: "If I'm on ai news presentation
 * — the follower link should show the current ai news presentation text I'm
 * in. If I switch to deep dive presentation — the same follower link should
 * show the deep dive text I'm seeing on my screen.").
 *
 * A single "channel": a random secret TOKEN (the credential, like a session id
 * is for the old ?session= links) and the channel's ACTIVE live session — the
 * one the last presenter page to act is showing (AI News /notes or the Deep
 * Dive presenter; they call `setFollowActive`, signed in). The public follower
 * page on `?live=<token>` reads and syncs ONLY that session:
 *   · `/news-follow/state?live=<token>` resolves it server-side (routes.ts);
 *   · a socket with `{ live: token }` is joined to the active session's room
 *     server-side (liveSync.ts) — the follower never needs a session id;
 *   · a socket with `{ live: token, channel: 1 }` gets `live-session` whenever
 *     the active session changes (an opaque key + kind, or null = waiting), so
 *     the follower switches AI News ⇄ Deep Dive without a reload;
 *   · on a switch the server also drops every live-token session socket still
 *     in the old session's room, so a follower can never keep listening to a
 *     session that is no longer the active one.
 * `rotateFollowLink` replaces the token: old links get `live-revoked` and are
 * disconnected, and their state reads 404.
 *
 * Old `?session=<id>` links work exactly as before (they never touch this).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../db/index.js";
import { sessions, decks } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS news_follow_channel (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  active_session TEXT,
  updated_at INTEGER
);
`);

interface Row { token: string; active_session: string | null }

const newToken = (): string => randomBytes(18).toString("base64url");

function row(): Row {
  const r = db.prepare("SELECT token, active_session FROM news_follow_channel WHERE id = 1").get() as Row | undefined;
  if (r) return r;
  const token = newToken();
  db.prepare("INSERT INTO news_follow_channel (id, token, active_session, updated_at) VALUES (1, ?, NULL, ?)").run(token, Date.now());
  return { token, active_session: null };
}

/** What the socket layer does when the channel changes (set by liveSync.ts). */
export interface ChannelNotifier {
  /** The active session changed (or went away): tell the channel's followers, drop stale session sockets. */
  switched(token: string, info: LiveInfo | null): void;
  /** The token was replaced: tell and disconnect everyone on the old one. */
  revoked(oldToken: string): void;
}
let notifier: ChannelNotifier | null = null;
export const setChannelNotifier = (n: ChannelNotifier): void => { notifier = n; };

export interface LiveInfo {
  /** Opaque: changes when the active session changes. Not the session id. */
  key: string;
  kind: "news" | "deep-dive";
}

const live = (sessionId: string | null | undefined): string | null => {
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  return s && !s.endedAt ? s.id : null;
};

export const liveKey = (token: string, sessionId: string): string =>
  createHash("sha256").update(`${token}:${sessionId}`).digest("base64url").slice(0, 16);

const kindOf = (sessionId: string): "news" | "deep-dive" => {
  const s = sessions.get(sessionId);
  return s?.deck && decks.get(s.deck) ? "news" : "deep-dive";
};

export function infoFor(token: string, sessionId: string | null): LiveInfo | null {
  return sessionId ? { key: liveKey(token, sessionId), kind: kindOf(sessionId) } : null;
}

/** The stable link's token (created on first use). Signed-in callers only. */
export const followToken = (): string => row().token;

/** A new token; every old link stops working at once. */
export function rotateFollowToken(): string {
  const old = row().token;
  const token = newToken();
  db.prepare("UPDATE news_follow_channel SET token = ?, updated_at = ? WHERE id = 1").run(token, Date.now());
  notifier?.revoked(old);
  return token;
}

/** A presenter showing `sessionId` acted: it becomes what the stable link follows (the last one wins). */
export function setFollowActive(sessionId: string): boolean {
  if (!live(sessionId)) return false;
  const r = row();
  if (r.active_session === sessionId) return true;
  db.prepare("UPDATE news_follow_channel SET active_session = ?, updated_at = ? WHERE id = 1").run(sessionId, Date.now());
  notifier?.switched(r.token, infoFor(r.token, sessionId));
  return true;
}

/** A session ended: if it was the active one, followers go to "waiting". */
export function followSessionEnded(sessionId: string): void {
  const r = row();
  if (r.active_session !== sessionId) return;
  db.prepare("UPDATE news_follow_channel SET active_session = NULL, updated_at = ? WHERE id = 1").run(Date.now());
  notifier?.switched(r.token, null);
}

/**
 * The public read: `undefined` = not a valid link (wrong or rotated token);
 * `null` = valid, nothing live right now; else the active, live session id.
 */
export function activeForToken(token: unknown): string | null | undefined {
  if (typeof token !== "string" || !token || token.length > 64) return undefined;
  const r = row();
  const a = Buffer.from(token), b = Buffer.from(r.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return live(r.active_session);
}
