/**
 * Paid versus organic views, from the YouTube Analytics API.
 *
 * THE HARD LIMIT, STATED ONCE: this works for ONE channel — whoever granted
 * consent. There is no public API, at any price, that exposes another channel's
 * paid/organic split, so a teardown of someone else's channel can never have
 * this. The audit falls back to a labelled engagement heuristic there (see
 * analysis.ts `engagementAnomalies`), which reports what it measures and does
 * not pretend to know what anyone spent.
 *
 * WHY IT MATTERS BEYOND REPORTING. Paid views inflate the view count, and every
 * judgement in the audit is built on view counts. A promoted video reads as a
 * packaging win it never was: it scores a high era multiple, enters the outlier
 * set, and the renamer then models new titles on a title that never earned its
 * audience. Scoring on ORGANIC views removes that whole class of wrong
 * conclusion.
 *
 * The OAuth client is deliberately separate from the lab's sign-in client,
 * which holds only "openid email profile". Signing in must never imply the
 * ability to read analytics.
 */
import { getYtAnalyticsOAuth } from "../settings/postizSecrets.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REPORTS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

/** Read-only, analytics-only. The narrowest scope that answers the question. */
export const YT_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

/**
 * YouTube Analytics has no data before this, so it is the widest start date
 * worth asking for. A later channel simply returns nothing for the early years.
 */
const EPOCH_START = "2005-02-14";

export interface PaidViewsResult {
  /** videoId → views that came from advertising. */
  paidByVideo: Map<string, number>;
  /** Total advertised views across the channel in range. */
  totalPaid: number;
  /** The window actually queried. */
  from: string;
  to: string;
}

export function ytAnalyticsConfigured(): boolean {
  const c = getYtAnalyticsOAuth();
  return Boolean(c?.clientId && c?.clientSecret);
}

export function ytAnalyticsConnected(): boolean {
  const c = getYtAnalyticsOAuth();
  return Boolean(c?.clientId && c?.clientSecret && c?.refreshToken);
}

/** Exchange the stored refresh token for a short-lived access token. */
async function accessToken(): Promise<string> {
  const c = getYtAnalyticsOAuth();
  if (!c) throw new Error("YouTube Analytics OAuth client is not configured.");
  if (!c.refreshToken) throw new Error("No channel is connected for analytics.");

  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.access_token) {
    // A revoked grant is the common case and deserves a message that says what
    // to do rather than echoing Google's error code.
    const detail = j?.error === "invalid_grant" ? "the connection was revoked — reconnect the channel" : j?.error_description || j?.error || r.status;
    throw new Error(`Could not refresh YouTube Analytics access: ${detail}`);
  }
  return j.access_token as string;
}

/**
 * Per-video views that came from advertising.
 *
 * `insightTrafficSourceType==ADVERTISING` is YouTube's own classification of
 * views served through ads, so this is a measurement rather than an inference.
 * Videos absent from the result had no advertised views in the window, which is
 * the overwhelmingly common case — the caller should treat "missing" as zero.
 */
export async function fetchPaidViews(
  { from = EPOCH_START, to = new Date().toISOString().slice(0, 10) }: { from?: string; to?: string } = {},
): Promise<PaidViewsResult> {
  const token = await accessToken();
  const params = new URLSearchParams({
    ids: "channel==MINE",
    startDate: from,
    endDate: to,
    metrics: "views",
    dimensions: "video",
    filters: `insightTrafficSourceType==ADVERTISING`,
    sort: "-views",
    maxResults: "200",
  });

  const r = await fetch(`${REPORTS_ENDPOINT}?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`YouTube Analytics error ${r.status}: ${j?.error?.message || "unknown"}`);
  }

  const paidByVideo = new Map<string, number>();
  let totalPaid = 0;
  // Rows are positional against columnHeaders; find the indices rather than
  // assuming an order the API never promised.
  const headers: any[] = Array.isArray(j?.columnHeaders) ? j.columnHeaders : [];
  const vi = headers.findIndex((h) => h?.name === "video");
  const wi = headers.findIndex((h) => h?.name === "views");
  if (vi >= 0 && wi >= 0) {
    for (const row of Array.isArray(j?.rows) ? j.rows : []) {
      const id = String(row[vi] ?? "");
      const views = Number(row[wi]) || 0;
      if (!id || views <= 0) continue;
      paidByVideo.set(id, views);
      totalPaid += views;
    }
  }

  return { paidByVideo, totalPaid, from, to };
}

/**
 * Split a catalogue's views into paid and organic.
 *
 * Returns the ORGANIC view count per video, which is what the audit should
 * score on. Paid views are kept alongside so the report can show the split
 * rather than silently changing the numbers under the operator.
 */
export function applyPaidSplit<T extends { videoId: string; views: number }>(
  videos: T[],
  paidByVideo: Map<string, number>,
): { videoId: string; views: number; paidViews: number; organicViews: number }[] {
  return videos.map((v) => {
    // Clamp: analytics windows and the Data API's lifetime count are gathered at
    // different moments, so paid can exceed the total by a rounding of timing.
    // A negative organic count would be nonsense in every downstream median.
    const paid = Math.min(paidByVideo.get(v.videoId) ?? 0, v.views);
    return { videoId: v.videoId, views: v.views, paidViews: paid, organicViews: Math.max(0, v.views - paid) };
  });
}
