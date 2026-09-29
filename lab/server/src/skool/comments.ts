/**
 * Reading a post's comments — properly this time.
 *
 * ⚠️⚠️ SKOOL HAS A COMMENTS API AND WE WERE SCRAPING THE DOM INSTEAD. Found by
 * watching the network while a post page loaded (2026-08-06):
 *
 *     GET https://api2.skool.com/posts/<postId>/comments?group-id=<groupId>&limit=25
 *
 * It returns `post_tree.children`, each entry `{ post, children }`, and it fixes
 * three things the DOM reader could not:
 *
 *   1. ⚠️ IT CARRIES REAL, STABLE COMMENT IDS. The DOM has NONE — no `id`, no
 *      `data-*`, no permalink; `readPost` fell back to `idx-0`, `idx-1`, which
 *      are POSITIONS. A reply worker deduping on those would answer the wrong
 *      comment the moment somebody else commented and shifted the list, and
 *      would answer the same one twice. Nothing else here matters as much.
 *   2. ⚠️ IT IS COMPLETE. Measured on `/start-here`: 46 declared, 46 returned
 *      (18 top-level + 28 nested), 46 unique ids. The DOM showed 40 and
 *      `readPost` honestly said so — but "40 of 46" means six members were
 *      never going to get an answer.
 *   3. ⚠️ THE BODIES ARE CLEAN. `metadata.content` is the comment itself,
 *      where the DOM ran author, timestamp, body and "1Reply" chrome together
 *      with no separator and needed regex guesswork to pull apart.
 *
 * ⚠️ `limit` IS CAPPED — `limit=100` returns the string "invalid limit: 100",
 * not JSON. 25 is what Skool's own page asks for. `offset` and `skip` are both
 * ignored (verified: each returns the same first id), so if a post ever exceeds
 * 25 TOP-LEVEL comments this reader will be short, and it says so rather than
 * implying it saw everything. Nesting is one level deep (measured max depth 1).
 *
 * ⚠️ THE FETCH RUNS INSIDE THE PAGE, not from node, so it carries the session
 * cookies without this module ever handling them — the same bargain as reading
 * `__NEXT_DATA__`. Reading is over the API; WRITING still drives the real UI.
 */
import { withSkoolPage } from "./browser.js";

export interface SkoolComment {
  /** Skool's own id. Stable, and the only safe dedupe key. */
  id: string;
  /** The comment this one answers. Null for a top-level comment. */
  parentId: string | null;
  /** 0 for top-level, 1 for a reply. Skool allows no deeper. */
  depth: number;
  authorId: string;
  authorName: string;
  authorHandle: string;
  body: string;
  /**
   * The body as the RENDERED PAGE shows it — see `plainBody`.
   *
   * ⚠️ THIS, NOT `body`, IS WHAT THE WRITE PATH LOOKS FOR. Reading is over the
   * API and writing joins on the DOM, and the two disagree about a mention.
   */
  plain: string;
  createdAt: string;
  /** Written by the signed-in account. */
  byMe: boolean;
  /** True when this account has already answered underneath it. */
  answeredByMe: boolean;
}

export interface CommentRead {
  postId: string;
  postTitle: string;
  postBody: string;
  comments: SkoolComment[];
  /** What Skool says the count is, against what we actually got. */
  declared: number;
  /** Set when those two disagree — never silently swallowed. */
  short: string | null;
  error: string | null;
}

const FAIL = (error: string): CommentRead => ({
  postId: "",
  postTitle: "",
  postBody: "",
  comments: [],
  declared: 0,
  short: null,
  error,
});

/** Skool's own page asks for 25 and anything larger is rejected outright. */
const COMMENT_LIMIT = 25;

export async function readComments(communityUrl: string, slug: string): Promise<CommentRead> {
  const base = communityUrl.replace(/\/+$/, "");
  const url = `${base}/${slug}`;

  const raw = await withSkoolPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2500));

    return await page.evaluate(async (limit: number) => {
      const doc: any = (globalThis as any).document;
      const el = doc?.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return { fail: "no-payload" as const };
      let pp: any;
      try {
        pp = JSON.parse(el.textContent)?.props?.pageProps;
      } catch {
        return { fail: "unparseable" as const };
      }
      const post = pp?.postTree?.post;
      const postId = String(post?.id ?? "");
      const groupId = String(pp?.currentGroup?.id ?? "");
      const selfId = String(pp?.self?.id ?? "");
      if (!postId || !groupId) return { fail: "no-ids" as const };

      const api = `https://api2.skool.com/posts/${postId}/comments?group-id=${groupId}&limit=${limit}`;
      let tree: any;
      try {
        const res = await (globalThis as any).fetch(api, { credentials: "include" });
        const text = await res.text();
        if (!res.ok) return { fail: "api-error" as const, detail: `${res.status}: ${text.slice(0, 120)}` };
        tree = JSON.parse(text)?.post_tree;
      } catch (e: any) {
        return { fail: "api-error" as const, detail: String(e?.message ?? e).slice(0, 160) };
      }

      const name = (u: any): string => {
        const m = u?.metadata ?? {};
        const full = [m.first_name ?? u?.first_name, m.last_name ?? u?.last_name].filter(Boolean).join(" ").trim();
        return full || String(u?.name ?? "");
      };

      const flat: any[] = [];
      const walk = (nodes: any[], depth: number, parentId: string | null): void => {
        for (const node of nodes ?? []) {
          const p = node?.post ?? {};
          const uid = String(p.user_id ?? p.user?.id ?? "");
          const kids = node?.children ?? [];
          flat.push({
            id: String(p.id ?? ""),
            parentId,
            depth,
            authorId: uid,
            authorName: name(p.user),
            authorHandle: String(p.user?.name ?? ""),
            body: String(p.metadata?.content ?? ""),
            createdAt: String(p.created_at ?? ""),
            byMe: !!selfId && uid === selfId,
            // Answered = this account wrote one of its direct children. Read off
            // Skool rather than our own log, because the log cannot know about a
            // reply Jake typed himself.
            answeredByMe:
              depth === 0 &&
              !!selfId &&
              kids.some((k: any) => String(k?.post?.user_id ?? k?.post?.user?.id ?? "") === selfId),
          });
          walk(kids, depth + 1, String(p.id ?? ""));
        }
      };
      walk(tree?.children ?? [], 0, null);

      return {
        fail: null,
        postId,
        postTitle: String(post?.metadata?.title ?? ""),
        postBody: String(post?.metadata?.content ?? ""),
        declared: Number(post?.metadata?.comments ?? 0),
        topLevel: (tree?.children ?? []).length,
        comments: flat,
      };
    }, COMMENT_LIMIT);
  });

  if (!raw) return FAIL("The browser could not be reached.");
  if (raw.fail) {
    const why: Record<string, string> = {
      "no-payload": "That post carried no Skool data payload — the session may have been bounced to a login.",
      unparseable: "Skool's data payload did not parse. Its page format may have changed.",
      "no-ids": "Skool's payload had no post id or group id, so the comments API could not be called.",
      "api-error": `Skool's comments API refused: ${(raw as any).detail ?? "no detail"}`,
    };
    return FAIL(why[raw.fail] ?? "Could not read the comments.");
  }

  // ⚠️ `plain` IS ADDED HERE, IN NODE, NOT IN THE PAGE — so the flattening
  // lives in one exported function a test can reach, rather than inside an
  // `evaluate` that only a live browser can run.
  const comments = (raw.comments as SkoolComment[]).map((c) => ({ ...c, plain: plainBody(c.body) }));
  // ⚠️ A COUNT THAT DISAGREES IS REPORTED, NOT PAPERED OVER — and the cause is
  // knowable here, unlike in the DOM reader. Only the TOP-LEVEL list is capped,
  // so a short read means this post has more than `limit` root comments, and
  // `offset`/`skip` do not work to get the rest.
  const short =
    raw.topLevel >= COMMENT_LIMIT || (raw.declared > 0 && comments.length < raw.declared)
      ? `Skool reports ${raw.declared} comment(s) and ${comments.length} were read` +
        (raw.topLevel >= COMMENT_LIMIT
          ? ` — this post is at the ${COMMENT_LIMIT} top-level cap, and Skool ignores offset, so the rest are unreachable this way.`
          : ".")
      : null;

  return {
    postId: raw.postId,
    postTitle: raw.postTitle,
    postBody: raw.postBody,
    comments,
    declared: raw.declared,
    short,
    error: null,
  };
}


/**
 * The comment as the RENDERED PAGE shows it.
 *
 * ⚠️⚠️ THE API'S BODY IS NOT WHAT IS ON THE SCREEN, AND THE WRITE PATH JOINS ON
 * THE SCREEN. A mention arrives from the API as
 * `[@Charles Lewis](obj://user/28e49e43…)` and renders as `@Charles Lewis`, so a
 * snippet cut from the raw body carries a user id that appears NOWHERE in the
 * DOM: `replyToComment` finds no card and the member is never answered.
 * Measured live on `/introduction-2`, 2026-09-26 — the same comment, same id,
 * two dry runs:
 *
 *     raw body       → "No comment on that page contains
 *                       "[@Charles Lewis](obj://user/28e49e43…" — refused.
 *     flattened body → editor opened on the right card, 73 characters pasted.
 *
 * ⚠️ AND IT BITES HARDEST ON EXACTLY THE COMMENTS THIS EXISTS FOR. Skool
 * pre-fills a reply with an @mention of the person being answered, so EVERY
 * comment inside a thread starts with this markup; a top-level comment that
 * happens to tag Jake does too, which is why replies to those were quietly
 * failing before any of the thread work below.
 */
export function plainBody(body: string): string {
  return String(body ?? "")
    // `[@Name](obj://user/<id>)` → `@Name`; `[label](https://…)` → `label`.
    // The label is what Skool renders, for a mention and for a link alike.
    .replace(/\[([^\]\n]{1,300})\]\((?:obj:\/\/[^)\s]+|https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, "$1")
    .trim();
}

/**
 * One top-level comment and everything hanging off it.
 *
 * ⚠️⚠️ A THREAD IS FLAT, AND THAT IS A MEASURED FACT ABOUT SKOOL, NOT A
 * SIMPLIFICATION. Replying to a REPLY does not nest: the new comment lands as
 * another child of the TOP-LEVEL comment. Measured on `/start-here`
 * (2026-09-26), one thread of six, every reply `parent = b9b1c808` — the
 * top-level comment — through three full exchanges:
 *
 *     d0  Terassah   "Hi everyone! 👋 …"
 *     d1  Jake       "@Terassah Thompson Love this intro…"
 *     d1  Terassah   "@Jake Dawson Something so simple…"
 *     d1  Jake       "@Terassah Thompson Don't be embarrassed…"
 *     d1  Terassah   "@Jake Dawson I do remember the we…"
 *     d1  Jake       "@Terassah Thompson That makes tot…"
 *
 * Everything downstream depends on it: who has the last word is a question
 * about SIBLINGS, and a reply that has landed is a new sibling — which is why
 * `answeredByMe` (this account wrote one of my CHILDREN) can only ever answer
 * the question for a top-level comment, and says "no" forever for a reply.
 */
export interface CommentThread {
  root: SkoolComment;
  /** Its replies, oldest first — Skool's own order, which is chronological. */
  replies: SkoolComment[];
}

/** Every thread on the post, in the order Skool returned them. */
export function threadsOf(comments: SkoolComment[]): CommentThread[] {
  const roots = comments.filter((c) => c.depth === 0);
  return roots.map((root) => ({
    root,
    // ⚠️ BY `parentId`, NOT BY DEPTH ALONE. Two threads' replies are
    // indistinguishable by depth, and mixing them up would read somebody
    // else's conversation as this one.
    replies: comments.filter((c) => c.depth > 0 && c.parentId === root.id),
  }));
}

/** The thread one comment belongs to — itself if it is top-level. */
export function threadContaining(comments: SkoolComment[], commentId: string): CommentThread | null {
  return (
    threadsOf(comments).find((t) => t.root.id === commentId || t.replies.some((r) => r.id === commentId)) ?? null
  );
}

/**
 * The comment a reply to `commentId` will be filed under.
 *
 * ⚠️ NOT `commentId` ITSELF WHEN IT IS A REPLY — see `CommentThread`. This is
 * what makes "did my reply land?" answerable on both surfaces: the evidence is
 * a new comment whose parent is this id, never one whose parent is the reply
 * being answered, because Skool does not create those.
 */
export function replyParentOf(comments: SkoolComment[], commentId: string): string {
  return threadContaining(comments, commentId)?.root.id ?? commentId;
}

export interface AnswerOptions {
  /**
   * Other user ids that count as this account.
   *
   * ⚠️⚠️ JAKE HAS TWO ADMIN ACCOUNTS AND BOTH OF THEM ARE CALLED "Jake Dawson".
   * `byMe` only knows the one that is signed in, so a thread the OTHER Jake
   * answered ten minutes ago looks unanswered from here — and the fix for
   * "always answer" must not become "answer everything twice, once per
   * account". Live proof that this is not hypothetical: on `/start-here` the
   * older threads are answered by `dfdf64d9…` and the recent ones by
   * `86f055a8…`, in the same comment list. The caller passes the admin ids
   * (`adminIds()` in engageReplies); absent, only the signed-in account counts.
   */
  usIds?: Iterable<string>;
  /**
   * Only continue conversations this account is already in — never open one.
   *
   * ⚠️ THE SWITCH THAT KEEPS A MEMBER'S POST OUT OF SCOPE. Answering a follow-up
   * under Jake's own comment is finishing something he started; commenting on a
   * thread between two other members under a THIRD member's post is a new
   * outbound behaviour, and this file does not get to arm one. See
   * `ReplyConfig.memberPosts` for the switch that does.
   */
  followUpsOnly?: boolean;
}

/**
 * One thread's worth of somebody waiting on an answer.
 */
export interface Waiting {
  /**
   * The comment to reply to: the LAST thing they said.
   *
   * ⚠️ THE LAST, NOT THE FIRST, AND ONE PER THREAD. Two targets in one thread is
   * two replies to the same conversation, which reads worse than not answering
   * at all — so a run of messages is one target, answered once, the same rule
   * `splitAtLastReply` applies to a DM.
   */
  comment: SkoolComment;
  /** Their unanswered run, oldest first. Usually one comment. */
  run: SkoolComment[];
  /** What was said before the run, oldest first — already known to them. */
  before: SkoolComment[];
  /** True when this account has already spoken in this thread. */
  followUp: boolean;
}

/**
 * Everyone waiting for an answer, one per thread, newest first.
 *
 * ⚠️⚠️ THIS IS THE FIX FOR "IT DOESN'T COMMENT ON A COMMENT" (Jake, 2026-09-26):
 * *"we have a post that someone else wrote, Jake wrote a comment, then that
 * person wrote a comment, then Jake never answered — I want Jake to always
 * answer."* The old filter was one line — `depth === 0 && !byMe &&
 * !answeredByMe` — and every clause of it was wrong for that case at once: the
 * member's answer is at depth 1, the comment above it IS Jake's so the thread
 * looked handled, and `answeredByMe` cannot see a sibling anyway. The whole
 * exchange was invisible to the drafter, which is why nobody answered.
 *
 * ⚠️ THE FILTER IS STILL THE SAFETY, NOT THE PROMPT. A drafter asked "should I
 * reply to this?" will sometimes say yes to its own reply from ten minutes ago.
 * So: anything WE wrote, anything we have already answered, and anything in a
 * thread where we have had the last word never reaches it.
 *
 * ⚠️ IT WORKS ON ORDER, NOT ON CLOCKS. Skool returns a thread chronologically
 * (measured), and "after our last word" is a position — so a comment with an
 * unparseable or clock-skewed timestamp cannot silently sort itself in front of
 * a reply we already sent.
 */
export function waiting(comments: SkoolComment[], opts: AnswerOptions = {}): Waiting[] {
  const us = new Set([...(opts.usIds ?? [])].filter(Boolean));
  const mine = (c: SkoolComment) => c.byMe || us.has(c.authorId);
  const said = (c: SkoolComment) => c.body.trim().length > 0;

  const out: Waiting[] = [];
  for (const { root, replies } of threadsOf(comments)) {
    const line = [root, ...replies];
    // The last thing THIS account said in the thread, root included.
    let ours = -1;
    line.forEach((c, i) => {
      if (mine(c)) ours = i;
    });

    if (ours < 0) {
      // Nobody from here has spoken. The top-level comment is the target, as it
      // always was — and answering it lands inside this thread, so a reply from
      // another member further down is not a second target.
      if (!opts.followUpsOnly && said(root)) out.push({ comment: root, run: [root], before: [], followUp: false });
      continue;
    }

    // ⚠️ EVERYTHING AFTER OUR LAST WORD IS THEIRS BY DEFINITION — `ours` is the
    // LAST index we wrote — so this run needs no second "not us" test, and it
    // is precisely what "Jake never answered" means.
    const run = line.slice(ours + 1).filter(said);
    if (!run.length) continue;
    out.push({ comment: run[run.length - 1], run, before: line.slice(0, ours + 1), followUp: true });
  }

  // Newest first: the same order the old filter used, and the one that matters
  // when a cap cuts the list short.
  return out.sort((a, b) => (a.comment.createdAt < b.comment.createdAt ? 1 : -1));
}

/**
 * The comments worth answering, newest first.
 *
 * Kept as the name the read endpoint and the bench call; `waiting` is the same
 * pass with the thread context a real reply needs.
 */
export function answerable(comments: SkoolComment[], opts: AnswerOptions = {}): SkoolComment[] {
  return waiting(comments, opts).map((w) => w.comment);
}

/**
 * Anything this account said in that thread AFTER the comment being answered.
 *
 * ⚠️⚠️ THE LAST DOOR BEFORE A SECOND REPLY, AND `answeredByMe` CANNOT HOLD IT.
 * That flag asks "did I write a CHILD of this comment", which is unanswerable
 * for a reply — a reply's answer is its SIBLING (see `CommentThread`) — so it
 * reads false forever and every retry would answer the member again. Position
 * in the thread is what actually decides it.
 *
 * ⚠️ AND ANY OF OUR ACCOUNTS COUNTS, NOT JUST THE SIGNED-IN ONE. If Jake
 * answered from his phone, or from his other admin account, the member is
 * answered — which is the outcome. See `AnswerOptions.usIds`.
 */
export function answeredAfter(
  comments: SkoolComment[],
  commentId: string,
  opts: AnswerOptions = {},
): SkoolComment | null {
  const thread = threadContaining(comments, commentId);
  if (!thread) return null;
  const us = new Set([...(opts.usIds ?? [])].filter(Boolean));
  const line = [thread.root, ...thread.replies];
  const idx = line.findIndex((c) => c.id === commentId);
  if (idx < 0) return null;
  return line.slice(idx + 1).find((c) => c.byMe || us.has(c.authorId)) ?? null;
}
