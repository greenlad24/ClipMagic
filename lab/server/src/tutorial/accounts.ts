/**
 * Tutorial Studio's SEPARATE posting identity.
 *
 * The Bulk Scheduler posts as one Postiz/PostPeer account; this posts as
 * another. The separation is credentials, not a filter: every call here builds
 * a client with STUDIO_POSTIZ_API_KEY, so it authenticates as that account and
 * the other group's channels are not merely hidden — they are not reachable.
 * There is deliberately NO fallback to the default key: with the studio key
 * unset this reports "not configured" rather than quietly posting a batch to
 * the wrong identity.
 *
 * The write guard in postiz/client.ts still applies (create-only; no edits or
 * deletes, and protected channels stay protected whichever account is used).
 */
import { createPostizClient, PostizApiError, type PostizIntegration } from "../postiz/client.js";
import { getStudioPostizApiKey, getStudioPostPeerApiKey } from "../settings/postizSecrets.js";
import { createPostPeerClient } from "../postiz/postpeerClient.js";
import { buildProviderSettings } from "../postiz/providerSettings.js";
import { call as sidecarCall, TutorialUnavailable } from "./client.js";

export interface StudioChannel {
  id: string;
  name: string;
  platform: string;
  picture?: string;
  disabled: boolean;
  /** Which provider this channel came from. */
  provider: "postiz" | "postpeer";
  /** False when this backend cannot publish to it yet (see postpeer note). */
  postable: boolean;
}

export function studioPostizConfigured(): boolean {
  return Boolean(getStudioPostizApiKey());
}

export function studioPostPeerConfigured(): boolean {
  return Boolean(getStudioPostPeerApiKey());
}

function client() {
  const apiKey = getStudioPostizApiKey();
  if (!apiKey) {
    throw new PostizApiError(
      "No Studio Postiz API key — add it in Settings (Tutorial Studio accounts) so this batch " +
        "posts to its own accounts and not the Bulk Scheduler's.",
      0,
    );
  }
  return createPostizClient({ apiKey });
}

/**
 * The studio group's channels. PostPeer accounts are listed for visibility but
 * marked unpostable: PostPeer is an external SaaS that must FETCH the media, and
 * a Tutorial Studio reel lives inside the sidecar behind the auth gate with no
 * public URL. Posting those needs the reel exported to a public render URL
 * first — not wired yet, and saying so beats a runtime failure mid-batch.
 */
export async function listStudioChannels(): Promise<StudioChannel[]> {
  const out: StudioChannel[] = [];
  if (studioPostizConfigured()) {
    const integrations: PostizIntegration[] = await client().listIntegrations();
    for (const i of integrations) {
      out.push({
        id: i.id,
        name: i.name,
        platform: i.identifier,
        picture: i.picture,
        disabled: Boolean(i.disabled),
        provider: "postiz",
        postable: !i.disabled,
      });
    }
  }
  if (studioPostPeerConfigured()) {
    try {
      const accounts = await createPostPeerClient({
        apiKey: getStudioPostPeerApiKey() || undefined,
      }).listAccounts();
      for (const a of accounts) {
        out.push({
          id: a.id,
          name: a.name || a.username || a.id,
          platform: a.platform || "tiktok",
          picture: a.picture,
          disabled: false,
          provider: "postpeer",
          postable: false,
        });
      }
    } catch {
      /* listing PostPeer is best-effort; Postiz is the posting path */
    }
  }
  return out;
}

/** Pull a finished reel out of the sidecar as bytes, for upload. */
async function fetchReel(jobId: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await sidecarCall(`/api/jobs/${encodeURIComponent(jobId)}/reel.mp4`);
  } catch (err) {
    throw err instanceof TutorialUnavailable
      ? err
      : new Error("Could not reach Tutorial Studio to fetch the reel.");
  }
  if (!res.ok) throw new Error("That job has no finished reel to post.");
  return Buffer.from(await res.arrayBuffer());
}

export interface PostReelInput {
  jobId: string;
  channelIds: string[];
  /** Caption/content for every selected channel. */
  content: string;
  /** ISO datetime to schedule for; omitted posts as soon as Postiz picks it up. */
  when?: string;
  /** YouTube/TikTok title, where the provider takes one. */
  title?: string;
}

/**
 * Upload one finished reel to the studio Postiz account and schedule it to the
 * given channels. Returns Postiz's raw response — its shape varies by version
 * and nothing here depends on it.
 */
export async function postReel(input: PostReelInput): Promise<unknown> {
  const c = client();
  const channels = input.channelIds.filter(Boolean);
  if (!channels.length) throw new Error("Pick at least one channel to post to.");

  const bytes = await fetchReel(input.jobId);
  const upload = await c.upload(bytes, `${input.jobId}.mp4`, "video/mp4");

  // Postiz requires `date` even for an immediate post, and `settings.__type` per
  // channel — hence the platform lookup rather than a bare integration id.
  const byId = new Map((await listStudioChannels()).map((ch) => [ch.id, ch]));
  return c.createPost({
    type: input.when ? "schedule" : "now",
    date: input.when || new Date().toISOString(),
    posts: channels.map((id) => ({
      integration: { id },
      value: [{ content: input.content, image: [{ id: upload.id, path: upload.path }] }],
      settings: buildProviderSettings(byId.get(id)?.platform || "generic", {
        title: input.title,
      }),
    })),
  });
}
