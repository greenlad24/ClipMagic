/**
 * Deal Organizer — Slack.
 *
 * Where the agent talks to Jake (rulebook #8, #27, #40, #44, #46, #72):
 * conflict questions, "ask before going lower", standout service providers,
 * links it needs, reputation/legal flags. It posts, and reads the replies in
 * its own threads so it can learn the answer. It also reads the top-level
 * messages of its OWN channel (conversations.history) so Jake can teach it a
 * rule there ("rule: …", agent/teach.ts). It never reads anything else.
 *
 * A bot token (xoxb-…) from a Slack app Jake installs in his workspace. The
 * target is a user id (U…/W… → a DM from the bot) or a channel id (C…/G…).
 * Allow-listed methods only.
 */
import { getDealsSlack } from "../../settings/postizSecrets.js";

const ALLOWED_METHODS = new Set(["auth.test", "conversations.open", "chat.postMessage", "conversations.replies", "conversations.history"]);

export function slackStatus(): { configured: boolean; hasTarget: boolean } {
  const s = getDealsSlack();
  return { configured: Boolean(s.botToken), hasTarget: Boolean(s.target) };
}

async function slackCall(method: string, body: Record<string, unknown>, token?: string): Promise<any> {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`Refused: Slack method ${method} is not allowed.`);
  const botToken = token ?? getDealsSlack().botToken;
  if (!botToken) throw new Error("Slack is not connected. Paste the bot token on the Deal Organizer connections page.");
  const read = method === "conversations.replies" || method === "conversations.history";
  const url = `https://slack.com/api/${method}${read ? `?${new URLSearchParams(body as any)}` : ""}`;
  const r = await fetch(url, {
    method: read ? "GET" : "POST",
    headers: { authorization: `Bearer ${botToken}`, ...(read ? {} : { "content-type": "application/json; charset=utf-8" }) },
    body: read ? undefined : JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j?.ok) {
    const err: Error & { retryAfterSec?: number } = new Error(`Slack ${method} failed: ${j?.error || r.status}`);
    // Rate limited (HTTP 429 / "ratelimited"): surface Retry-After so pollers can back off.
    if (r.status === 429 || j?.error === "ratelimited") err.retryAfterSec = Number(r.headers.get("retry-after")) || 60;
    throw err;
  }
  return j;
}

/** Who the token belongs to — used to check a pasted token before saving it. */
export const slackWhoAmI = (token?: string) => slackCall("auth.test", {}, token);

export async function resolveChannel(): Promise<string> {
  const { target } = getDealsSlack();
  if (!target) throw new Error("No Slack destination set. Add your Slack member ID or a channel ID.");
  if (/^[UW]/.test(target)) return (await slackCall("conversations.open", { users: target })).channel.id;
  return target;
}

/** Post a message (optionally into an existing thread). Returns { channel, ts } to track the thread. */
export async function slackPost(text: string, threadTs?: string, inChannel?: string): Promise<{ channel: string; ts: string }> {
  const channel = inChannel || (await resolveChannel());
  const j = await slackCall("chat.postMessage", { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false });
  return { channel: j.channel, ts: j.ts };
}

/** Replies in one of the agent's own threads — how it learns Jake's answer. */
/** `editedTs`: Slack's `edited.ts` when the reply was edited (the text is already the edited version; deleted replies are simply absent). */
export async function slackThreadReplies(channel: string, ts: string): Promise<Array<{ user?: string; text: string; ts: string; bot: boolean; editedTs: string | null }>> {
  const j = await slackCall("conversations.replies", { channel, ts, limit: "100" });
  return (j.messages ?? []).slice(1).map((m: any) => ({ user: m.user, text: m.text ?? "", ts: m.ts, bot: Boolean(m.bot_id), editedTs: m.edited?.ts ?? null }));
}

/**
 * Top-level messages in the agent's own channel newer than `oldest` (oldest
 * first) — how Jake teaches it a rule in Slack (agent/teach.ts).
 */
export async function slackChannelHistory(channel: string, oldest: string): Promise<Array<{ user?: string; text: string; ts: string; bot: boolean; subtype: string | null; editedTs: string | null; replyCount: number }>> {
  const j = await slackCall("conversations.history", { channel, oldest, limit: "100", inclusive: "false" });
  return (j.messages ?? []).map((m: any) => ({
    user: m.user, text: m.text ?? "", ts: m.ts, bot: Boolean(m.bot_id), subtype: m.subtype ?? null, editedTs: m.edited?.ts ?? null, replyCount: Number(m.reply_count ?? 0),
  })).reverse();
}

/** A thread's first message plus its replies (one call) — for threads the agent did NOT start (Jake's "rule:" posts). */
export async function slackThread(channel: string, ts: string): Promise<{
  head: { text: string; ts: string; editedTs: string | null } | null;
  replies: Array<{ user?: string; text: string; ts: string; bot: boolean; editedTs: string | null }>;
}> {
  const j = await slackCall("conversations.replies", { channel, ts, limit: "100" });
  const msgs: any[] = j.messages ?? [];
  const h = msgs.find((m) => m.ts === ts);
  return {
    head: h ? { text: h.text ?? "", ts: h.ts, editedTs: h.edited?.ts ?? null } : null,
    replies: msgs.filter((m) => m.ts !== ts).map((m) => ({ user: m.user, text: m.text ?? "", ts: m.ts, bot: Boolean(m.bot_id), editedTs: m.edited?.ts ?? null })),
  };
}
