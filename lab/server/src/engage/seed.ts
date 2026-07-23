/**
 * Seed the Engagement Manager's monitored channels.
 *
 * Two sources, each best-effort and independent:
 *   1. YouTube — from the CONNECTED social channels (the same Postiz/PostPeer
 *      channels the Bulk Scheduler posts to): resolve each @handle → YT channel id
 *      + uploads playlist via the Data API, upsert into engage_channels.
 *   2. Meta (Instagram + Facebook) — from the operator's stored long-lived Meta
 *      user token: resolveAccounts() → one FB Page row + one IG row per linked
 *      account, storing each Page's PAGE access token on the channel so the poll
 *      loop can READ its comments.
 *
 * Best-effort PER CHANNEL: a resolve/quota/auth failure logs + skips that channel,
 * never aborting the whole seed. Everything Meta-related is a NO-OP until a token
 * is configured (metaConfigured()).
 */
import { listChannels as listConnectedChannels } from "../postiz/bulkScheduler.js";
import { resolveChannel, YoutubeQuotaError, youtubeConfigured } from "./youtube.js";
import { resolveAccounts, exchangeLongLivedToken, metaConfigured, MetaGraphError, metaErrMsg } from "./metaGraph.js";
import { tiktokConfigured } from "./tiktok.js";
import {
  upsertChannel,
  setChannelAuth,
  setChannelMetaPageId,
  purgeOrphanedInbox,
} from "./db.js";
import { getMetaCreds, updateSettings } from "../settings/postizSecrets.js";
import type { EngageChannel } from "./types.js";

/**
 * Seed BOTH YouTube (from connected channels) and Meta (from the stored token).
 * Never throws. Returns every channel that was seeded/refreshed this run.
 */
export async function seedChannelsFromConnected(): Promise<EngageChannel[]> {
  const seeded: EngageChannel[] = [];
  seeded.push(...(await seedYoutubeChannels()));
  seeded.push(...(await seedMetaChannels()));
  seeded.push(...(await seedTikTokChannels()));
  // The channel list is authoritative: anything ingested for a channel that is
  // no longer configured (e.g. filtered out by ENGAGE_META_CHANNEL_IDS) is
  // another account's content and shouldn't linger in this database.
  const purged = purgeOrphanedInbox();
  if (purged.inbox > 0 || purged.replies > 0) {
    console.log(`[engage] purged ${purged.inbox} orphaned inbox row(s) and ${purged.replies} reply row(s)`);
  }
  return seeded;
}

/**
 * Seed the connected TikTok channel(s) from the same Postiz/PostPeer channels the
 * Bulk Scheduler posts to (platform/identifier 'tiktok', handle in profile/name).
 * externalId = the @handle, since the Apify actor keys on the profile username (not
 * a numeric id). NO-OP until an Apify token is configured (tiktokConfigured()).
 * Best-effort; never throws.
 */
export async function seedTikTokChannels(): Promise<EngageChannel[]> {
  if (!tiktokConfigured()) return [];

  let connected: Awaited<ReturnType<typeof listConnectedChannels>>;
  try {
    connected = await listConnectedChannels();
  } catch (e) {
    console.warn(`[engage] could not list connected channels for TikTok: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const tiktokChannels = connected.filter((c) => c.platform === "tiktok" || c.identifier === "tiktok");
  // PostPeer often exposes only a display NAME (e.g. "Jake Dawson"), not the TikTok
  // @username the Apify actor needs. ENGAGE_TIKTOK_HANDLE overrides it with the real
  // username (or profile URL) so the scraper targets the right account.
  const overrideHandle = (process.env.ENGAGE_TIKTOK_HANDLE || "").trim();
  const seeded: EngageChannel[] = [];
  for (const ch of tiktokChannels) {
    // The override username if set, else the connected account's PostPeer profile/name.
    const rawHandle = overrideHandle || (ch.profile || ch.name || "").trim();
    if (!rawHandle) continue;
    const handle = rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`;
    try {
      const row = upsertChannel({
        platform: "tiktok",
        externalId: handle, // the Apify actor keys on the profile handle.
        handle,
        displayName: ch.name || rawHandle,
        picture: ch.picture ?? null,
      });
      seeded.push(row);
    } catch (e) {
      console.warn(`[engage] failed to seed TikTok channel "${handle}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return seeded;
}

/**
 * Resolve + upsert every connected YouTube channel. Never throws: connected-channel
 * fetch failures and per-channel resolve/quota failures are caught + logged.
 */
export async function seedYoutubeChannels(): Promise<EngageChannel[]> {
  if (!youtubeConfigured()) {
    console.warn("[engage] YouTube seed skipped — YouTube Data API key not configured.");
    return [];
  }

  let connected: Awaited<ReturnType<typeof listConnectedChannels>>;
  try {
    connected = await listConnectedChannels();
  } catch (e) {
    console.warn(`[engage] could not list connected channels: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const youtubeChannels = connected.filter((c) => c.platform === "youtube" || c.identifier === "youtube");
  const seeded: EngageChannel[] = [];

  for (const ch of youtubeChannels) {
    // The connected channel's @handle (Postiz `profile`), or its name as a fallback.
    const handleOrId = (ch.profile || ch.name || "").trim();
    if (!handleOrId) continue;
    try {
      const resolved = await resolveChannel(handleOrId);
      if (!resolved) {
        console.warn(`[engage] could not resolve YouTube channel "${handleOrId}" — skipped.`);
        continue;
      }
      const row = upsertChannel({
        platform: "youtube",
        externalId: resolved.channelId,
        handle: ch.profile ?? null,
        displayName: resolved.title || ch.name || null,
        picture: resolved.thumbnail ?? ch.picture ?? null,
        uploadsPlaylistId: resolved.uploadsPlaylistId ?? null,
      });
      seeded.push(row);
    } catch (e) {
      if (e instanceof YoutubeQuotaError) {
        console.warn("[engage] seed hit YouTube quota — stopping channel resolution for now.");
        break;
      }
      console.warn(`[engage] failed to seed YouTube channel "${handleOrId}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return seeded;
}

/**
 * Resolve + upsert the operator's Meta (Instagram + Facebook) accounts from the
 * stored long-lived user token. One engage_channels row per FB Page (platform
 * 'facebook') and one per linked IG business account (platform 'instagram'),
 * each carrying its FB Page PAGE token (setChannelAuth) so the monitor can READ
 * its comments. Best-effort per account; never throws. NO-OP when Meta isn't
 * configured.
 */
/**
 * Optional allow-list of Meta asset ids to monitor (FB Page ids and/or IG user
 * ids), from env `ENGAGE_META_CHANNEL_IDS` (comma-separated). When set, ONLY
 * those assets are seeded — a token that can see many businesses' pages/IGs is
 * narrowed to the ones the operator actually wants. Empty/unset = seed all
 * (backward compatible). Durable across re-seeds since it's config, not data.
 */
function metaAllowSet(): Set<string> | null {
  const raw = (process.env.ENGAGE_META_CHANNEL_IDS || "").trim();
  if (!raw) return null;
  const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return set.size ? set : null;
}

export async function seedMetaChannels(): Promise<EngageChannel[]> {
  if (!metaConfigured()) return [];

  // Token durability (best-effort): upgrade the stored user token to a fresh
  // long-lived (~60-day) one and persist it, so monitoring keeps working. Needs
  // the app id + secret; any failure is swallowed (we then just use the stored
  // token as-is). Never logs the token.
  await tryRefreshLongLivedToken();

  let accounts: Awaited<ReturnType<typeof resolveAccounts>>;
  try {
    accounts = await resolveAccounts();
  } catch (e) {
    if (e instanceof MetaGraphError && e.isAuth) {
      console.warn("[engage] Meta seed skipped — the stored token needs re-authorization (expired/invalid).");
    } else {
      console.warn(`[engage] could not resolve Meta accounts: ${metaErrMsg(e)}`);
    }
    return [];
  }

  const allow = metaAllowSet();
  const seeded: EngageChannel[] = [];
  for (const account of accounts) {
    const fbAllowed = !allow || allow.has(account.fbPageId);
    const igAllowed = account.ig ? !allow || allow.has(account.ig.userId) : false;
    // Skip accounts where the allow-list matches neither the Page nor the IG.
    if (allow && !fbAllowed && !igAllowed) continue;

    // FB Page channel (only if allowed).
    if (fbAllowed) {
      try {
        const fb = upsertChannel({
          platform: "facebook",
          externalId: account.fbPageId,
          handle: account.fbPageName ?? null,
          displayName: account.fbPageName ?? null,
          picture: account.fbPicture ?? null,
        });
        setChannelAuth(fb.id, account.fbPageToken);
        // The FB conversations edge lives on the Page — here external_id already IS
        // the page id, but store it explicitly so DM monitoring reads uniformly.
        setChannelMetaPageId(fb.id, account.fbPageId);
        seeded.push(fb);
      } catch (e) {
        console.warn(`[engage] failed to seed FB Page ${account.fbPageId}: ${metaErrMsg(e)}`);
      }
    }

    // Linked IG business account (optional, only if allowed) — reads via the SAME FB Page token.
    if (account.ig && igAllowed) {
      try {
        const handle = account.ig.username ? `@${account.ig.username}` : null;
        const ig = upsertChannel({
          platform: "instagram",
          externalId: account.ig.userId,
          handle,
          displayName: account.ig.username ?? null,
          picture: account.ig.picture ?? null,
        });
        setChannelAuth(ig.id, account.fbPageToken);
        // IG conversations also live on the linked FB Page, but the IG channel's
        // external_id is the IG user id — so store the FB Page id for the DM read.
        setChannelMetaPageId(ig.id, account.fbPageId);
        seeded.push(ig);
      } catch (e) {
        console.warn(`[engage] failed to seed IG account ${account.ig.userId}: ${metaErrMsg(e)}`);
      }
    }
  }
  return seeded;
}

/**
 * Best-effort: exchange the stored Meta user token for a fresh long-lived one and
 * persist it (via the write-only secrets store). Silently no-ops when the app
 * id/secret aren't configured or the exchange fails. Never throws, never logs the
 * token. An env-injected token (process.env.META_ACCESS_TOKEN) is left untouched.
 */
async function tryRefreshLongLivedToken(): Promise<void> {
  // Don't clobber an operator-injected env token — only manage the UI-stored one.
  if ((process.env.META_ACCESS_TOKEN || "").trim()) return;
  const creds = getMetaCreds();
  if (!creds || !creds.appId || !creds.appSecret) return;
  try {
    const fresh = await exchangeLongLivedToken(creds.token);
    if (fresh && fresh !== creds.token) {
      updateSettings({ values: { META_ACCESS_TOKEN: fresh } });
    }
  } catch (e) {
    console.warn(`[engage] Meta long-lived token refresh skipped: ${metaErrMsg(e)}`);
  }
}
