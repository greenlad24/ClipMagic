/**
 * Meta (Instagram + Facebook) read-only ingestion for the Engagement Manager.
 *
 * Everything here READS comments via the Meta Graph API using a stored long-lived
 * Meta USER token (getMetaCreds) — we never write/reply. It mirrors the shape of
 * engage/youtube.ts: an injectable FetchFn (so the mappers are testable against a
 * captured response), its own MetaGraphError, and pure InboxItem mappers.
 *
 * Everything is a NO-OP when Meta isn't configured — the callers guard on
 * metaConfigured() and the getters throw a clear error if a credential is missing,
 * so nothing runs until the operator pastes a token.
 *
 * TOKEN MODEL:
 *   - The stored META_ACCESS_TOKEN is a long-lived USER token. resolveAccounts()
 *     uses it to list the user's FB Pages + each Page's PAGE token. All per-Page /
 *     per-IG reads (comments, stats) use that PAGE token (stored on the channel by
 *     the seeder), which is long-lived as long as the user token was.
 *   - exchangeLongLivedToken() upgrades a freshly-pasted short-lived user token to
 *     a ~60-day one (best-effort; needs app id + secret).
 *
 * PAGING is bounded everywhere (MAX_COMMENTS_PER_TARGET) so a viral post/media
 * can't make one cycle unbounded.
 */
import { getMetaCreds } from "../settings/postizSecrets.js";
import type { InboxItem } from "./types.js";
import type { FetchFn } from "../thumbnails/youtube.js";

export type { FetchFn } from "../thumbnails/youtube.js";

const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com/v21.0";

/** Max comments (incl. replies) we page under ONE post/media — bounds a viral thread. */
const MAX_COMMENTS_PER_TARGET = 200;
/** Max paging hops per target (defence-in-depth alongside the count cap). */
const MAX_PAGES_PER_TARGET = 25;

/**
 * A Graph API error. `isAuth` is true for OAuth/expired-token errors (code 190 /
 * type OAuthException) so the monitor can flag a channel needs-reauth instead of
 * treating it as a transient failure. Tokens are NEVER included in the message.
 */
export class MetaGraphError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly isAuth: boolean;
  constructor(message: string, opts: { status?: number; code?: number | null; isAuth?: boolean } = {}) {
    super(message);
    this.name = "MetaGraphError";
    this.status = opts.status ?? 0;
    this.code = opts.code ?? null;
    this.isAuth = opts.isAuth ?? false;
  }
}

/** True when the current Meta config is present (a user token is stored). */
export function metaConfigured(): boolean {
  return getMetaCreds() != null;
}

/** Resolve the injectable fetch (real fetch wrapped to the narrow FetchFn shape). */
function resolveFetch(fetchImpl?: FetchFn): FetchFn {
  return (
    fetchImpl ??
    (async (u) => {
      const r = await fetch(u);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    })
  );
}

/**
 * True ONLY for a genuinely invalid/expired access token (needs re-auth).
 * Meta returns type "OAuthException" for many PERMISSION errors too — code 10
 * ("requires X permission / Page Public Content Access"), 100, 200, 3, 803 —
 * which are NOT expired tokens and must not trigger a "reconnect your token"
 * banner. Only the real token-invalid codes count as auth failures.
 */
const AUTH_ERROR_CODES = new Set([190, 102, 458, 459, 460, 463, 464, 467, 492]);
function isAuthError(json: any, status: number): boolean {
  const err = json?.error;
  const code = typeof err?.code === "number" ? err.code : null;
  if (code !== null) return AUTH_ERROR_CODES.has(code);
  return status === 401;
}

/**
 * GET + parse a Graph API URL. Throws MetaGraphError (with isAuth set for OAuth /
 * 190 failures) on any error; the token is never echoed into the message.
 */
async function graphGet(url: string, doFetch: FetchFn): Promise<any> {
  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(url);
  } catch (e) {
    throw new MetaGraphError(`Could not reach the Meta Graph API: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const code = typeof json?.error?.code === "number" ? json.error.code : null;
    throw new MetaGraphError(`Meta Graph API error: ${msg}`, {
      status: res.status,
      code,
      isAuth: isAuthError(json, res.status),
    });
  }
  return json;
}

/** Build a `${base}/path?fields=…&access_token=…` URL (token appended, never logged). */
function graphUrl(pathAndQuery: string, token: string): string {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  return `${GRAPH_BASE}/${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`;
}

// ── token durability ──────────────────────────────────────────────────────────

/**
 * Exchange a short-lived user token for a long-lived (~60-day) one via
 * /oauth/access_token?grant_type=fb_exchange_token. Needs the app id + secret.
 * Best-effort: returns the new token, or throws MetaGraphError. The caller decides
 * whether to persist it. Never logs the token.
 */
export async function exchangeLongLivedToken(shortToken: string, fetchImpl?: FetchFn): Promise<string> {
  const creds = getMetaCreds();
  if (!creds) throw new MetaGraphError("Meta is not configured.");
  if (!creds.appId || !creds.appSecret) {
    throw new MetaGraphError("Meta app id/secret not configured — cannot exchange for a long-lived token.");
  }
  const doFetch = resolveFetch(fetchImpl);
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: creds.appId,
    client_secret: creds.appSecret,
    fb_exchange_token: shortToken,
  });
  const json = await graphGet(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`, doFetch);
  const token = typeof json?.access_token === "string" ? json.access_token : "";
  if (!token) throw new MetaGraphError("Meta token exchange returned no access_token.");
  return token;
}

// ── account resolution ──────────────────────────────────────────────────────────

/** An optional Instagram business account linked to a FB Page. */
export interface MetaInstagramAccount {
  userId: string;
  username: string | null;
  followers: number | null;
  picture: string | null;
}

/** A resolved FB Page (+ its optional linked IG business account) with its PAGE token. */
export interface MetaAccount {
  fbPageId: string;
  fbPageName: string | null;
  /**
   * The Page access token — used for all per-Page/IG reads. NEVER expose/log.
   * `null` marks an un-pollable Page (e.g. a client_page whose token we couldn't
   * obtain); the monitor skips channels without a stored token. IG info (if any) is
   * still carried so the operator can see the account.
   */
  fbPageToken: string | null;
  fbFanCount: number | null;
  fbPicture: string | null;
  ig?: MetaInstagramAccount;
}

/** Max Business portfolios we enumerate under /me/businesses (bounds a big list). */
const MAX_BUSINESSES = 10;

/** Fields requested for any Page (personal or business-owned), incl. its linked IG. */
const PAGE_FIELDS =
  "id,name,access_token,fan_count,picture{url},instagram_business_account{id,username,followers_count,profile_picture_url}";

/** Map one Graph Page resource → MetaAccount (folds in the linked IG account). */
function mapPageResource(page: any): MetaAccount | null {
  const fbPageId = typeof page?.id === "string" ? page.id : null;
  if (!fbPageId) return null;
  const account: MetaAccount = {
    fbPageId,
    fbPageName: typeof page?.name === "string" ? page.name : null,
    fbPageToken: typeof page?.access_token === "string" && page.access_token ? page.access_token : null,
    fbFanCount: typeof page?.fan_count === "number" ? page.fan_count : null,
    fbPicture: typeof page?.picture?.data?.url === "string" ? page.picture.data.url : null,
  };
  const ig = mapIgResource(page?.instagram_business_account);
  if (ig) account.ig = ig;
  return account;
}

/** Map an instagram_business_account expansion → MetaInstagramAccount (or null). */
function mapIgResource(ig: any): MetaInstagramAccount | null {
  const userId = typeof ig?.id === "string" ? ig.id : null;
  if (!userId) return null;
  return {
    userId,
    username: typeof ig?.username === "string" ? ig.username : null,
    followers: typeof ig?.followers_count === "number" ? ig.followers_count : null,
    picture: typeof ig?.profile_picture_url === "string" ? ig.profile_picture_url : null,
  };
}

/**
 * Personal / classic-role Pages via /me/accounts (with each Page's linked IG folded
 * in). A top-level auth failure here THROWS MetaGraphError(isAuth) so the caller can
 * flag needs-reauth — this is the genuinely-fatal path.
 */
async function fetchPersonalPages(userToken: string, doFetch: FetchFn): Promise<MetaAccount[]> {
  const json = await graphGet(graphUrl(`me/accounts?fields=${PAGE_FIELDS}&limit=100`, userToken), doFetch);
  const pages: any[] = Array.isArray(json?.data) ? json.data : [];
  return pages.map(mapPageResource).filter((a): a is MetaAccount => a != null);
}

/**
 * Business-portfolio-owned Pages via /me/businesses → /{businessId}/owned_pages and
 * /client_pages. Best-effort: if /me/businesses errors because the token lacks the
 * `business_management` scope (or for any other reason), we log a one-line warning
 * and return [] so the caller degrades to personal Pages only (never throws). A
 * per-business owned_pages/client_pages failure is likewise logged and skipped.
 */
async function fetchBusinessPages(userToken: string, doFetch: FetchFn): Promise<MetaAccount[]> {
  let businesses: any[];
  try {
    const bizJson = await graphGet(
      graphUrl(`me/businesses?fields=id,name&limit=${MAX_BUSINESSES}`, userToken),
      doFetch,
    );
    businesses = Array.isArray(bizJson?.data) ? bizJson.data : [];
  } catch (e) {
    // Most commonly the token lacks `business_management` (code 100/200). NON-fatal:
    // we just can't see Business-portfolio-owned Pages — degrade to personal Pages.
    console.warn(
      `[engage] Meta Business-portfolio discovery skipped (Pages/IG owned by a Business portfolio won't be found) — ` +
        `${metaErrMsg(e)}. Grant the "business_management" permission on the Meta token to include them.`,
    );
    return [];
  }

  const out: MetaAccount[] = [];
  for (const biz of businesses.slice(0, MAX_BUSINESSES)) {
    const bizId = typeof biz?.id === "string" ? biz.id : null;
    if (!bizId) continue;
    for (const edge of ["owned_pages", "client_pages"] as const) {
      try {
        const json = await graphGet(graphUrl(`${bizId}/${edge}?fields=${PAGE_FIELDS}&limit=100`, userToken), doFetch);
        const pages: any[] = Array.isArray(json?.data) ? json.data : [];
        for (const p of pages) {
          const acct = mapPageResource(p);
          if (acct) out.push(acct);
        }
      } catch (e) {
        // A single edge failing shouldn't lose the other pages — log and carry on.
        console.warn(`[engage] Meta ${edge} lookup for business ${bizId} failed: ${metaErrMsg(e)}`);
      }
    }
  }
  return out;
}

/**
 * Dedupe Pages by fbPageId, preferring the richer entry: one WITH a page token
 * and/or a linked IG wins. The loser's token/IG/metadata are merged in when the
 * winner lacks them, so we never drop an access_token or IG account.
 */
function mergePages(all: MetaAccount[]): MetaAccount[] {
  const score = (x: MetaAccount) => (x.fbPageToken ? 2 : 0) + (x.ig ? 1 : 0);
  const byId = new Map<string, MetaAccount>();
  for (const acct of all) {
    const existing = byId.get(acct.fbPageId);
    if (!existing) {
      byId.set(acct.fbPageId, acct);
      continue;
    }
    const winner = score(acct) > score(existing) ? acct : existing;
    const loser = winner === existing ? acct : existing;
    if (!winner.fbPageToken && loser.fbPageToken) winner.fbPageToken = loser.fbPageToken;
    if (!winner.ig && loser.ig) winner.ig = loser.ig;
    if (winner.fbPageName == null && loser.fbPageName != null) winner.fbPageName = loser.fbPageName;
    if (winner.fbFanCount == null && loser.fbFanCount != null) winner.fbFanCount = loser.fbFanCount;
    if (winner.fbPicture == null && loser.fbPicture != null) winner.fbPicture = loser.fbPicture;
    byId.set(acct.fbPageId, winner);
  }
  return [...byId.values()];
}

/**
 * Best-effort backfill for a Page missing its access_token (some client_pages omit
 * it): GET /{pageId}?fields=access_token,instagram_business_account{...} with the
 * USER token. Sets the token if returned; fills IG if we didn't already have it.
 * Any failure is logged — the Page is kept (un-pollable), never dropped.
 */
async function backfillPageToken(account: MetaAccount, userToken: string, doFetch: FetchFn): Promise<void> {
  try {
    const json = await graphGet(
      graphUrl(
        `${account.fbPageId}?fields=access_token,instagram_business_account{id,username,followers_count,profile_picture_url}`,
        userToken,
      ),
      doFetch,
    );
    if (typeof json?.access_token === "string" && json.access_token) account.fbPageToken = json.access_token;
    if (!account.ig) {
      const ig = mapIgResource(json?.instagram_business_account);
      if (ig) account.ig = ig;
    }
  } catch (e) {
    console.warn(`[engage] token backfill for FB Page ${account.fbPageId} failed (page kept, un-pollable): ${metaErrMsg(e)}`);
  }
}

/**
 * Resolve the operator's FB Pages (+ each Page's linked IG business account) using
 * the stored long-lived USER token, from TWO sources merged together:
 *   1. Personal / classic-role Pages via /me/accounts.
 *   2. Business-portfolio-owned Pages via /me/businesses → owned_pages + client_pages
 *      (needs the `business_management` scope; missing scope degrades gracefully to
 *      source 1 only — logged, not thrown).
 * Results are deduped by page id (preferring the entry with a token/IG) and any Page
 * still missing a token is backfilled best-effort. A top-level /me/accounts auth
 * failure DOES throw MetaGraphError(isAuth) so the caller can flag needs-reauth;
 * everything else is best-effort.
 */
export async function resolveAccounts(fetchImpl?: FetchFn): Promise<MetaAccount[]> {
  const creds = getMetaCreds();
  if (!creds) throw new MetaGraphError("Meta is not configured.");
  const doFetch = resolveFetch(fetchImpl);

  // 1) Personal Pages — a genuine auth failure here throws (needs-reauth signal).
  const personalPages = await fetchPersonalPages(creds.token, doFetch);

  // 2) Business-portfolio-owned Pages — best-effort; degrades to personal-only.
  const businessPages = await fetchBusinessPages(creds.token, doFetch);

  // 3) Merge + dedupe by page id (prefer entries that have a token and/or IG).
  const merged = mergePages([...personalPages, ...businessPages]);

  // 4) Backfill any Page still missing a token (best-effort; kept even if it fails).
  for (const account of merged) {
    if (!account.fbPageToken) await backfillPageToken(account, creds.token, doFetch);
  }

  return merged;
}

// ── Facebook comments ───────────────────────────────────────────────────────────

/** Clean a caption/message into a short target title (single line, capped). */
function snippet(text: string | null | undefined, max = 120): string | null {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

type MappedItem = Omit<InboxItem, "id" | "ingestedAt" | "replyState">;

/** Map one FB comment resource → InboxItem fields. threadId/parentId set by caller. */
function mapFacebookComment(
  comment: any,
  ctx: { channelId: string; postId: string; postTitle: string | null; threadId: string; parentId: string | null; postPermalink: string | null },
): MappedItem | null {
  const id = typeof comment?.id === "string" ? comment.id : null;
  if (!id) return null;
  const postedRaw = typeof comment?.created_time === "string" ? Date.parse(comment.created_time) : NaN;
  const permalink =
    ctx.postPermalink ? `${ctx.postPermalink}?comment_id=${encodeURIComponent(id)}` : `https://www.facebook.com/${id}`;
  return {
    channelId: ctx.channelId,
    platform: "facebook",
    kind: "comment",
    dedupKey: id,
    threadId: ctx.threadId,
    parentId: ctx.parentId,
    targetRef: ctx.postId,
    targetTitle: ctx.postTitle,
    authorName: typeof comment?.from?.name === "string" ? comment.from.name : null,
    authorHandle: typeof comment?.from?.name === "string" ? comment.from.name : null,
    authorId: typeof comment?.from?.id === "string" ? comment.from.id : null,
    text: typeof comment?.message === "string" ? comment.message : "",
    permalink,
    postedAt: Number.isFinite(postedRaw) ? postedRaw : null,
    source: "api",
  };
}

/**
 * Pure: map a FB post's /comments response (with nested `comments{…}` replies) into
 * InboxItems — each top-level comment (threadId = its id, parentId = null) plus its
 * nested replies (threadId = top-level id, parentId = top-level id). Exported for tests.
 */
export function parseFacebookComments(
  json: any,
  ctx: { channelId: string; postId: string; postTitle: string | null; postPermalink: string | null },
): MappedItem[] {
  const items: any[] = Array.isArray(json?.data) ? json.data : [];
  const out: MappedItem[] = [];
  for (const top of items) {
    const topId = typeof top?.id === "string" ? top.id : null;
    if (!topId) continue;
    const topItem = mapFacebookComment(top, { ...ctx, threadId: topId, parentId: null });
    if (topItem) out.push(topItem);
    const replies: any[] = Array.isArray(top?.comments?.data) ? top.comments.data : [];
    for (const reply of replies) {
      const r = mapFacebookComment(reply, { ...ctx, threadId: topId, parentId: topId });
      if (r) out.push(r);
    }
  }
  return out;
}

/** Comment fields fetched per FB post (top-level + one level of nested replies). */
const FB_COMMENT_FIELDS =
  "id,message,from{id,name},created_time,like_count,parent{id},comments{id,message,from{id,name},created_time,like_count,parent{id}}";

/**
 * Fetch recent FB Page posts and their comments (+ nested replies), mapped to
 * InboxItems. `limit` bounds recent posts scanned; comments per post are paged via
 * paging.next but capped at MAX_COMMENTS_PER_TARGET. Uses the PAGE token. Throws
 * MetaGraphError (isAuth for expired tokens) so the monitor can flag re-auth.
 */
export async function fetchFacebookComments(
  pageId: string,
  pageToken: string,
  limit = 10,
  fetchImpl?: FetchFn,
): Promise<MappedItem[]> {
  if (!pageId || !pageToken) return [];
  const doFetch = resolveFetch(fetchImpl);
  const postsCap = Math.max(1, Math.min(50, limit));
  const postsJson = await graphGet(
    graphUrl(`${pageId}/posts?fields=id,message,permalink_url&limit=${postsCap}`, pageToken),
    doFetch,
  );
  const posts: any[] = Array.isArray(postsJson?.data) ? postsJson.data : [];
  const out: MappedItem[] = [];

  for (const post of posts) {
    const postId = typeof post?.id === "string" ? post.id : null;
    if (!postId) continue;
    const ctx = {
      channelId: "", // placeholder — the monitor stamps the real channel id before insert.
      postId,
      postTitle: snippet(post?.message),
      postPermalink: typeof post?.permalink_url === "string" ? post.permalink_url : null,
    };
    let url: string | null = graphUrl(
      `${postId}/comments?fields=${FB_COMMENT_FIELDS}&order=reverse_chronological&limit=50`,
      pageToken,
    );
    let count = 0;
    let hops = 0;
    while (url && count < MAX_COMMENTS_PER_TARGET && hops < MAX_PAGES_PER_TARGET) {
      const json: any = await graphGet(url, doFetch);
      const mapped = parseFacebookComments(json, ctx as any);
      for (const m of mapped) {
        out.push(m);
        count++;
        if (count >= MAX_COMMENTS_PER_TARGET) break;
      }
      url = typeof json?.paging?.next === "string" ? json.paging.next : null;
      hops++;
    }
  }
  return out;
}

// ── Instagram comments ──────────────────────────────────────────────────────────

/** Map one IG comment resource → InboxItem fields. threadId/parentId set by caller. */
function mapInstagramComment(
  comment: any,
  ctx: { channelId: string; mediaId: string; mediaTitle: string | null; mediaPermalink: string | null; threadId: string; parentId: string | null },
): MappedItem | null {
  const id = typeof comment?.id === "string" ? comment.id : null;
  if (!id) return null;
  const postedRaw = typeof comment?.timestamp === "string" ? Date.parse(comment.timestamp) : NaN;
  return {
    channelId: ctx.channelId,
    platform: "instagram",
    kind: "comment",
    dedupKey: id,
    threadId: ctx.threadId,
    parentId: ctx.parentId,
    targetRef: ctx.mediaId,
    targetTitle: ctx.mediaTitle,
    authorName: typeof comment?.username === "string" ? comment.username : null,
    authorHandle: typeof comment?.username === "string" ? comment.username : null,
    authorId: null, // IG comment `from` requires extra perms; username is the stable handle.
    text: typeof comment?.text === "string" ? comment.text : "",
    permalink: ctx.mediaPermalink,
    postedAt: Number.isFinite(postedRaw) ? postedRaw : null,
    source: "api",
  };
}

/**
 * Pure: map an IG media's /comments response (with nested `replies{…}`) into
 * InboxItems — each top-level comment (threadId = its id, parentId = null) plus its
 * replies (parentId = top-level id). Exported for tests.
 */
export function parseInstagramComments(
  json: any,
  ctx: { channelId: string; mediaId: string; mediaTitle: string | null; mediaPermalink: string | null },
): MappedItem[] {
  const items: any[] = Array.isArray(json?.data) ? json.data : [];
  const out: MappedItem[] = [];
  for (const top of items) {
    const topId = typeof top?.id === "string" ? top.id : null;
    if (!topId) continue;
    const topItem = mapInstagramComment(top, { ...ctx, threadId: topId, parentId: null });
    if (topItem) out.push(topItem);
    const replies: any[] = Array.isArray(top?.replies?.data) ? top.replies.data : [];
    for (const reply of replies) {
      const r = mapInstagramComment(reply, { ...ctx, threadId: topId, parentId: topId });
      if (r) out.push(r);
    }
  }
  return out;
}

/** Comment fields fetched per IG media (top-level + one level of replies). */
const IG_COMMENT_FIELDS =
  "id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}";

/**
 * Fetch recent IG media and their comments (+ replies), mapped to InboxItems.
 * `limit` bounds recent media scanned; comments per media paged via paging.next but
 * capped at MAX_COMMENTS_PER_TARGET. Uses the PAGE token. Throws MetaGraphError
 * (isAuth for expired tokens).
 */
export async function fetchInstagramComments(
  igUserId: string,
  pageToken: string,
  limit = 10,
  fetchImpl?: FetchFn,
): Promise<MappedItem[]> {
  if (!igUserId || !pageToken) return [];
  const doFetch = resolveFetch(fetchImpl);
  const mediaCap = Math.max(1, Math.min(50, limit));
  const mediaJson = await graphGet(
    graphUrl(`${igUserId}/media?fields=id,caption,permalink&limit=${mediaCap}`, pageToken),
    doFetch,
  );
  const media: any[] = Array.isArray(mediaJson?.data) ? mediaJson.data : [];
  const out: MappedItem[] = [];

  for (const m of media) {
    const mediaId = typeof m?.id === "string" ? m.id : null;
    if (!mediaId) continue;
    const ctx = {
      channelId: "", // placeholder — the monitor stamps the real channel id before insert.
      mediaId,
      mediaTitle: snippet(m?.caption),
      mediaPermalink: typeof m?.permalink === "string" ? m.permalink : null,
    };
    let url: string | null = graphUrl(`${mediaId}/comments?fields=${IG_COMMENT_FIELDS}&limit=50`, pageToken);
    let count = 0;
    let hops = 0;
    while (url && count < MAX_COMMENTS_PER_TARGET && hops < MAX_PAGES_PER_TARGET) {
      const json: any = await graphGet(url, doFetch);
      const mapped = parseInstagramComments(json, ctx as any);
      for (const item of mapped) {
        out.push(item);
        count++;
        if (count >= MAX_COMMENTS_PER_TARGET) break;
      }
      url = typeof json?.paging?.next === "string" ? json.paging.next : null;
      hops++;
    }
  }
  return out;
}

// ── direct messages (Instagram Direct + Facebook Messenger) ──────────────────────
//
// Read-only DM ingestion. Conversations live on the FB Page (for BOTH Messenger and
// the linked IG account), so both reads use the Page id + the FB PAGE token already
// stored on the channel. This needs the messaging permissions on the token
// (`pages_messaging` for Messenger, `instagram_manage_messages` for IG Direct);
// WITHOUT them the Graph API returns a permission error (code #10/#200, NON-auth —
// see isAuthError) which the callers catch and skip, so DM monitoring is simply
// inert until the operator grants the scopes. A whole conversation maps to ONE inbox
// thread: threadId = conversation id; the OLDEST message is the root (parentId null)
// and every later message is a reply (parentId = conversation id).

/** Max conversations paged per Meta channel per cycle (bounds a busy inbox). */
const MAX_DM_CONVERSATIONS = 25;
/** Max messages mapped per conversation (bounds a long chat). */
const MAX_DM_MESSAGES = 50;

/** Fields fetched per conversation: recent messages inline with their sender. */
const DM_FIELDS =
  "id,updated_time,participants,messages.limit(25){id,from{id,name,username},message,created_time}";

/** Pick the OTHER participant's display name (the one that isn't the Page/IG self). */
function otherParticipantName(participants: any[], selfIds: Set<string>): string | null {
  const named = (p: any): string | null =>
    typeof p?.name === "string" ? p.name : typeof p?.username === "string" ? p.username : null;
  // Prefer a participant whose id is NOT us; fall back to the first participant.
  const other = participants.find((p) => p?.id != null && !selfIds.has(String(p.id)));
  return named(other) ?? (participants.length ? named(participants[0]) : null);
}

/**
 * Pure: map a /{pageId}/conversations response into InboxItems (kind 'dm'). Each
 * conversation → one thread (threadId = conversation id); its messages are sorted
 * oldest→newest, the earliest becomes the root (parentId null) and the rest replies
 * (parentId = conversation id). Jake's OWN outgoing messages (from == self) are
 * included so the exchange reads naturally. Exported for tests.
 */
export function parseMetaDMs(
  json: any,
  ctx: { channelId: string; platform: "facebook" | "instagram"; selfIds: Set<string> },
): MappedItem[] {
  const conversations: any[] = Array.isArray(json?.data) ? json.data : [];
  const out: MappedItem[] = [];
  for (const conv of conversations.slice(0, MAX_DM_CONVERSATIONS)) {
    const convId = typeof conv?.id === "string" ? conv.id : null;
    if (!convId) continue;

    const participants: any[] = Array.isArray(conv?.participants?.data) ? conv.participants.data : [];
    const otherName = otherParticipantName(participants, ctx.selfIds);
    const targetTitle = `DM · ${otherName ?? "Unknown"}`;

    const messages: any[] = Array.isArray(conv?.messages?.data) ? conv.messages.data : [];
    const sorted = messages
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ m, t: typeof m?.created_time === "string" ? Date.parse(m.created_time) : NaN }))
      .sort((a, b) => (Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0))
      .slice(0, MAX_DM_MESSAGES);

    sorted.forEach(({ m, t }, idx) => {
      const id = m.id as string;
      out.push({
        channelId: ctx.channelId,
        platform: ctx.platform,
        kind: "dm",
        dedupKey: id,
        threadId: convId,
        // Earliest message is the thread root; every later message hangs off it.
        parentId: idx === 0 ? null : convId,
        targetRef: convId,
        targetTitle,
        authorName: typeof m?.from?.name === "string" ? m.from.name : null,
        authorHandle:
          typeof m?.from?.username === "string"
            ? m.from.username
            : typeof m?.from?.name === "string"
              ? m.from.name
              : null,
        authorId: typeof m?.from?.id === "string" ? m.from.id : null,
        text: typeof m?.message === "string" ? m.message : "",
        permalink: null,
        postedAt: Number.isFinite(t) ? t : null,
        source: "api",
      });
    });
  }
  return out;
}

/**
 * Fetch recent Facebook Messenger conversations for a Page and map their messages to
 * InboxItems (kind 'dm'). Uses the PAGE token. `limit` bounds conversations scanned
 * (capped MAX_DM_CONVERSATIONS). Requires `pages_messaging`; a missing-permission
 * error throws a NON-auth MetaGraphError (the caller logs once + skips). A genuinely
 * expired token throws MetaGraphError(isAuth) so the monitor can flag re-auth.
 */
export async function fetchFacebookDMs(
  pageId: string,
  pageToken: string,
  limit = MAX_DM_CONVERSATIONS,
  fetchImpl?: FetchFn,
): Promise<MappedItem[]> {
  if (!pageId || !pageToken) return [];
  const doFetch = resolveFetch(fetchImpl);
  const cap = Math.max(1, Math.min(MAX_DM_CONVERSATIONS, limit));
  const json = await graphGet(
    // Default platform for the conversations edge is messenger.
    graphUrl(`${pageId}/conversations?fields=${DM_FIELDS}&limit=${cap}`, pageToken),
    doFetch,
  );
  return parseMetaDMs(json, { channelId: "", platform: "facebook", selfIds: new Set([pageId]) });
}

/**
 * Fetch recent Instagram Direct conversations for a Page's linked IG account (same
 * conversations edge with `platform=instagram`) and map their messages to InboxItems
 * (kind 'dm'). Uses the PAGE token. Requires `instagram_manage_messages`; a missing-
 * permission error throws a NON-auth MetaGraphError (the caller logs once + skips).
 * An expired token throws MetaGraphError(isAuth) so the monitor can flag re-auth.
 */
export async function fetchInstagramDMs(
  pageId: string,
  pageToken: string,
  limit = MAX_DM_CONVERSATIONS,
  fetchImpl?: FetchFn,
): Promise<MappedItem[]> {
  if (!pageId || !pageToken) return [];
  const doFetch = resolveFetch(fetchImpl);
  const cap = Math.max(1, Math.min(MAX_DM_CONVERSATIONS, limit));
  const json = await graphGet(
    graphUrl(`${pageId}/conversations?platform=instagram&fields=${DM_FIELDS}&limit=${cap}`, pageToken),
    doFetch,
  );
  return parseMetaDMs(json, { channelId: "", platform: "instagram", selfIds: new Set([pageId]) });
}

// ── sending a direct message ────────────────────────────────────────────────────
//
// Replying to a DM is NOT the comment API. It's the Send API: POST to the PAGE's
// /messages edge, addressed to the recipient's page-scoped id — the same endpoint
// for Facebook Messenger and for Instagram Direct (Instagram messaging runs
// through the linked Page). The operator's token already carries both scopes
// (`pages_messaging`, `instagram_manage_messages`).
//
// THE 24-HOUR WINDOW is the thing to know here. Standard messaging only permits a
// reply within 24 hours of the person's last message; after that Meta rejects the
// send (#10) and the only ways through are a message tag or the Human Agent
// feature (7 days, needs App Review). An autonomous replier that polls slowly can
// therefore miss its chance entirely, which is why the sender checks the age
// itself and says so plainly rather than letting it look like a bug.

/** Meta's standard messaging window: 24h from the person's last message. */
export const DM_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Send a direct message from a Page: POST /{page-id}/messages.
 *
 * `recipientId` is the sender's page-scoped id as it arrived on the inbound
 * message (PSID for Messenger, IGSID for Instagram Direct) — NOT their public
 * username, which the Send API won't accept. `messaging_type=RESPONSE` declares
 * this as an answer to their message, which is what keeps it inside the standard
 * 24-hour window.
 *
 * Returns Meta's message id when it reports one.
 */
export async function sendDirectMessage(
  pageId: string,
  recipientId: string,
  text: string,
  pageToken: string,
  fetchImpl?: FetchFn,
): Promise<string | null> {
  const doFetch = resolveFetch(fetchImpl);
  const json = await graphPost(
    `${pageId}/messages`,
    {
      recipient: JSON.stringify({ id: recipientId }),
      message: JSON.stringify({ text }),
      messaging_type: "RESPONSE",
    },
    pageToken,
    doFetch,
  );
  return typeof json?.message_id === "string" ? json.message_id : null;
}

// ── engagement stats (fans/followers · comments · likes) ─────────────────────────

/** A channel's engagement snapshot (counts only; the DB stamps updatedAt). */
export interface MetaEngagementStats {
  audience: number | null;
  comments: number | null;
  likes: number | null;
}

/**
 * FB Page stats: audience = fan_count; comments = Σ recent post comment counts;
 * likes = Σ recent post like/reaction counts. One /posts call with summary fields.
 * Throws MetaGraphError (isAuth for expired tokens).
 */
export async function fetchFacebookStats(
  pageId: string,
  pageToken: string,
  limit = 10,
  fetchImpl?: FetchFn,
): Promise<MetaEngagementStats> {
  if (!pageId || !pageToken) return { audience: null, comments: null, likes: null };
  const doFetch = resolveFetch(fetchImpl);
  const cap = Math.max(1, Math.min(50, limit));

  const pageJson = await graphGet(graphUrl(`${pageId}?fields=fan_count`, pageToken), doFetch);
  const audience = typeof pageJson?.fan_count === "number" ? pageJson.fan_count : null;

  const postsJson = await graphGet(
    graphUrl(
      `${pageId}/posts?fields=comments.summary(true).limit(0),likes.summary(true).limit(0),reactions.summary(true).limit(0)&limit=${cap}`,
      pageToken,
    ),
    doFetch,
  );
  const posts: any[] = Array.isArray(postsJson?.data) ? postsJson.data : [];
  let comments: number | null = null;
  let likes: number | null = null;
  if (posts.length > 0) {
    comments = 0;
    likes = 0;
    for (const p of posts) {
      const c = p?.comments?.summary?.total_count;
      if (typeof c === "number") comments += c;
      // Prefer reactions (all reaction types); fall back to likes.
      const react = p?.reactions?.summary?.total_count;
      const like = p?.likes?.summary?.total_count;
      if (typeof react === "number") likes += react;
      else if (typeof like === "number") likes += like;
    }
  }
  return { audience, comments, likes };
}

/**
 * IG account stats: audience = followers_count; comments = Σ recent media
 * comments_count; likes = Σ recent media like_count. Throws MetaGraphError
 * (isAuth for expired tokens).
 */
export async function fetchInstagramStats(
  igUserId: string,
  pageToken: string,
  limit = 10,
  fetchImpl?: FetchFn,
): Promise<MetaEngagementStats> {
  if (!igUserId || !pageToken) return { audience: null, comments: null, likes: null };
  const doFetch = resolveFetch(fetchImpl);
  const cap = Math.max(1, Math.min(50, limit));

  const userJson = await graphGet(graphUrl(`${igUserId}?fields=followers_count`, pageToken), doFetch);
  const audience = typeof userJson?.followers_count === "number" ? userJson.followers_count : null;

  const mediaJson = await graphGet(
    graphUrl(`${igUserId}/media?fields=comments_count,like_count&limit=${cap}`, pageToken),
    doFetch,
  );
  const media: any[] = Array.isArray(mediaJson?.data) ? mediaJson.data : [];
  let comments: number | null = null;
  let likes: number | null = null;
  if (media.length > 0) {
    comments = 0;
    likes = 0;
    for (const m of media) {
      if (typeof m?.comments_count === "number") comments += m.comments_count;
      if (typeof m?.like_count === "number") likes += m.like_count;
    }
  }
  return { audience, comments, likes };
}

/** Narrow an unknown error to a message (never surfaces a token). */
export function metaErrMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── replying (Phase 3: API-first, browser only as fallback) ──────────────────

/**
 * POST a form-encoded body to the Graph API. Mirrors graphGet's error handling:
 * throws MetaGraphError with `code` set, so callers can tell a MISSING PERMISSION
 * (which should fall back to the browser) from a bad request (which shouldn't).
 * The token goes in the body, never the URL, so it can't leak via a redirect or
 * an access log.
 */
async function graphPost(path: string, params: Record<string, string>, token: string, doFetch: FetchFn): Promise<any> {
  const body = new URLSearchParams({ ...params, access_token: token });
  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(`${GRAPH_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    } as any);
  } catch (e) {
    throw new MetaGraphError(`Could not reach the Meta Graph API: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const code = typeof json?.error?.code === "number" ? json.error.code : null;
    throw new MetaGraphError(`Meta Graph API error: ${msg}`, {
      status: res.status,
      code,
      isAuth: isAuthError(json, res.status),
    });
  }
  return json;
}

/**
 * Graph error codes that mean "this token isn't allowed to do that" rather than
 * "that request was wrong". Only these are worth failing over to the browser
 * for — retrying a malformed request in a browser just fails differently.
 *   200 / 10  — permission denied (missing scope, e.g. pages_manage_engagement)
 *   3         — capability not enabled for the app
 *   * OAuthException with no code — treated as permission-ish, conservatively
 */
export function isPermissionError(e: unknown): boolean {
  if (!(e instanceof MetaGraphError)) return false;
  return e.code === 200 || e.code === 10 || e.code === 3;
}

/**
 * Reply to an Instagram comment: POST /{ig-comment-id}/replies.
 *
 * IMPORTANT: Instagram only supports ONE level of threading, so a reply must be
 * created on the TOP-LEVEL comment. Pass the thread's root id (InboxItem.threadId)
 * — posting to a reply's own id fails.
 *
 * Needs the `instagram_manage_comments` scope, which the operator's token
 * already carries. Returns the new comment's id.
 */
export async function replyToInstagramComment(
  topLevelCommentId: string,
  message: string,
  token: string,
  fetchImpl?: FetchFn,
): Promise<string | null> {
  const doFetch = resolveFetch(fetchImpl);
  const json = await graphPost(`${topLevelCommentId}/replies`, { message }, token, doFetch);
  return typeof json?.id === "string" ? json.id : null;
}

/**
 * Reply to a Facebook comment: POST /{fb-comment-id}/comments. Unlike Instagram,
 * Facebook accepts a reply on any comment, so the specific comment id is right.
 *
 * Needs `pages_manage_engagement` on the PAGE token. The operator's token does
 * NOT currently carry it, so this is expected to fail with a permission error
 * until the token is re-authorized — at which point the caller falls back to
 * the browser rather than dropping the reply.
 */
export async function replyToFacebookComment(
  commentId: string,
  message: string,
  pageToken: string,
  fetchImpl?: FetchFn,
): Promise<string | null> {
  const doFetch = resolveFetch(fetchImpl);
  const json = await graphPost(`${commentId}/comments`, { message }, pageToken, doFetch);
  return typeof json?.id === "string" ? json.id : null;
}
