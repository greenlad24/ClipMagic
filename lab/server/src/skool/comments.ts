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

  const comments = raw.comments as SkoolComment[];
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
 * The comments worth answering, in the order they should be answered.
 *
 * ⚠️ THE FILTER IS THE SAFETY, NOT THE PROMPT. A drafter asked "should I reply
 * to this?" will sometimes say yes to its own reply from ten minutes ago. So
 * anything this account wrote, and anything it has already answered, never
 * reaches the drafter at all.
 */
export function answerable(comments: SkoolComment[]): SkoolComment[] {
  return comments
    .filter((c) => c.depth === 0 && !c.byMe && !c.answeredByMe && c.body.trim().length > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
