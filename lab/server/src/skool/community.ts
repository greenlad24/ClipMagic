/**
 * Read the COMMUNITY half of Skool — the feed, a single post with its comments,
 * and whether any DMs are waiting.
 *
 * Same happy discovery as the classroom (`classroom.ts`): the feed ships as JSON
 * in `__NEXT_DATA__`, so reading it needs no DOM at all. Two shape traps carried
 * over, and one that is new:
 *
 *   1. ⚠️ EVERY ENTRY IS A `{ post: {...} }` WRAPPER, exactly like course units.
 *      Reading `entry.metadata.content` gives a correctly-shaped list of
 *      entirely blank posts — right count, no data — which looks like an empty
 *      community rather than a parsing bug. Unwrap `entry.post` first.
 *   2. ⚠️ THE FEED IS PAGINATED AND `postTrees` IS ONE PAGE. The classroom's
 *      `allCourses` told the same lie and a 60-course classroom read as exactly
 *      30 with nothing in the payload to suggest anything was missing. So this
 *      walks `?p=N` until a page adds nothing new, and reports how far it got
 *      rather than implying it saw everything.
 *   3. ⚠️ COMMENT BODIES ARE NOT IN THE PAYLOAD. The post page carries
 *      `postTree` (SINGULAR — `postTrees`, `post`, `comments` and `currentPost`
 *      are all absent there), and its `metadata.comments` is a COUNT. The
 *      comment text only exists in the DOM, so that one read is a DOM read,
 *      deliberately and with the reasons written down at `readPostComments`.
 */
import { withSkoolPage } from "./browser.js";

/**
 * The community's own post categories.
 *
 * ⚠️ THIS IS NOT A FALLBACK FOR A RARE CASE — IT IS THE ONLY SOURCE. The feed
 * payload does not carry the category list at all (`currentGroup.labels` was a
 * wrong guess and returns nothing), so `SkoolFeed.categories` is measured EMPTY
 * every time. Anything that treats the feed as the primary and this as the
 * unlikely backup has it exactly backwards.
 *
 * Observed live 2026-08-05, kept in the order Skool lists them because that
 * order is what a member sees.
 */
export const SKOOL_CATEGORIES = [
  "Intro",
  "YouTube Resources",
  "Announcements",
  "General Discussion",
  "Dev Discussion",
  "Your Journey",
  "Hiring/For Hire",
  "Community Resources",
];

export interface SkoolPost {
  id: string;
  /** The URL slug — `…/ai-automations-for-sales/<slug>`. */
  slug: string;
  title: string;
  body: string;
  category: string | null;
  authorName: string | null;
  /** Whether this post was written by the signed-in account. */
  byMe: boolean;
  commentCount: number;
  likeCount: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkoolFeed {
  posts: SkoolPost[];
  /** The signed-in identity, as Skool itself reports it. */
  account: { id: string; handle: string; name: string; unreadChats: number } | null;
  /** Category names offered by this community, in the order Skool lists them. */
  categories: string[];
  pagesRead: number;
  error: string | null;
}

export function communityFeedUrl(communityUrl: string, page = 1): string {
  const base = communityUrl.replace(/\/+$/, "");
  return page <= 1 ? base : `${base}?p=${page}`;
}

/** Strip a Skool post body down to plain text for prompting and for matching. */
export function plainTextFromPost(body: string): string {
  return String(body ?? "")
    // Markdown links are `[label](url)` — keep the label AND the url, because a
    // post's links are half its value and a lesson link is the thing the agent
    // most needs to see it has already shared.
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\r/g, "")
    .trim();
}

interface FeedPageRead {
  posts: SkoolPost[];
  account: SkoolFeed["account"];
  categories: string[];
  error: string | null;
}

async function readFeedPage(communityUrl: string, pageNo: number): Promise<FeedPageRead> {
  const url = communityFeedUrl(communityUrl, pageNo);
  const fail = (error: string): FeedPageRead => ({ posts: [], account: null, categories: [], error });

  const raw = await withSkoolPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2500));

    return await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc?.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return { fail: "no-payload" as const };
      let data: any;
      try {
        data = JSON.parse(el.textContent);
      } catch {
        return { fail: "unparseable" as const };
      }
      const pp = data?.props?.pageProps;
      if (!pp) return { fail: "no-pageprops" as const };
      if (!Array.isArray(pp.postTrees)) return { fail: "no-posts" as const };

      const self = pp.self ?? {};
      const selfId = String(self.id ?? "");

      return {
        fail: null,
        account: selfId
          ? {
              id: selfId,
              handle: String(self.name ?? ""),
              name: [self.firstName, self.lastName].filter(Boolean).join(" ").trim() || String(self.name ?? ""),
              unreadChats: Number(self.metadata?.unreadChats ?? 0),
            }
          : null,
        // Category names live on the group, not the posts. Needed because a post
        // cannot be published without choosing one.
        categories: Array.isArray(pp.currentGroup?.labels)
          ? pp.currentGroup.labels.map((l: any) => String(l?.name ?? l?.metadata?.name ?? "")).filter(Boolean)
          : [],
        posts: pp.postTrees.map((entry: any) => {
          // ⚠️ THE WRAPPER. `entry.post` or every field below reads blank.
          const p = entry?.post ?? {};
          const m = p.metadata ?? {};
          const author = p.user ?? entry?.user ?? {};
          return {
            id: String(p.id ?? ""),
            slug: String(p.name ?? ""),
            title: String(m.title ?? ""),
            body: String(m.content ?? ""),
            // The feed renders a category chip per post, but the payload does
            // not obviously carry it. Left null rather than guessed at: a wrong
            // category is worse than a missing one, since it decides where a
            // reply-in-kind would be filed.
            category: null,
            authorName:
              [author.firstName, author.lastName].filter(Boolean).join(" ").trim() || author.name || null,
            authorId: String(author.id ?? ""),
            commentCount: Number(m.comments ?? 0),
            likeCount: Number(m.upvotes ?? 0),
            pinned: Number(m.pinned ?? 0) > 0,
            createdAt: String(p.createdAt ?? ""),
            updatedAt: String(p.updatedAt ?? ""),
          };
        }),
      };
    });
  });

  if (!raw) return fail("The browser could not be reached.");
  if (raw.fail) {
    const why: Record<string, string> = {
      "no-payload": "That page carried no Skool data payload — the session may have been bounced to a login.",
      unparseable: "Skool's data payload did not parse. Its page format may have changed.",
      "no-pageprops": "Skool's data payload had no page props. Its page format may have changed.",
      "no-posts": "Skool's data payload carried no post list — check the community URL.",
    };
    return fail(why[raw.fail] ?? "Could not read the feed.");
  }

  const selfId = raw.account?.id ?? "";
  return {
    account: raw.account,
    categories: raw.categories,
    error: null,
    posts: raw.posts.map((p: any) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      body: p.body,
      category: p.category,
      authorName: p.authorName,
      byMe: !!selfId && p.authorId === selfId,
      commentCount: p.commentCount,
      likeCount: p.likeCount,
      pinned: p.pinned,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  };
}

/**
 * Read the feed, walking pages until one adds nothing new.
 *
 * `maxPages` is a stop, not a target: the community is 9 pages today and an
 * agent that only ever needs "what have I posted lately" should not pay for all
 * of them. Whatever it stops at is REPORTED (`pagesRead`) rather than implied.
 */
export async function readFeed(communityUrl: string, maxPages = 3): Promise<SkoolFeed> {
  const seen = new Set<string>();
  const posts: SkoolPost[] = [];
  let account: SkoolFeed["account"] = null;
  let categories: string[] = [];
  let pagesRead = 0;

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const page = await readFeedPage(communityUrl, pageNo);
    if (page.error) {
      // A failure on page 1 is a failure. A failure later still returns what was
      // read, flagged — a short answer that says it is short beats none.
      if (pageNo === 1) return { posts: [], account: null, categories: [], pagesRead: 0, error: page.error };
      return { posts, account, categories, pagesRead, error: `Stopped after page ${pagesRead}: ${page.error}` };
    }
    account = account ?? page.account;
    if (!categories.length) categories = page.categories;
    pagesRead = pageNo;

    // ⚠️ DEDUPE ON THE SLUG, NOT THE ID. A pinned post is listed TWICE on page
    // one — once in the pinned slot and once in the stream — under two
    // different ids and the same slug. Deduping on id let "🔥 Start here! 🔥"
    // through twice, which would have taught the drafter that a subject was
    // posted about more often than it was.
    // ⚠️ THE `seen` SET HAS TO GROW *DURING* THE FILTER, NOT AFTER IT. Adding
    // the slugs in a second loop dedupes across pages and NOT within one — and
    // the duplicate this exists to catch is on a single page, in the pinned
    // slot and the stream at once. Measured 2026-08-20: the pinned post came
    // back twice from page one, which is exactly what the comment above says
    // must not happen.
    const fresh: SkoolPost[] = [];
    for (const p of page.posts) {
      if (!p.slug || seen.has(p.slug)) continue;
      seen.add(p.slug);
      fresh.push(p);
      posts.push(p);
    }
    // A page that adds nothing new is the end of the feed — the same
    // convergence test the classroom reader uses.
    if (!fresh.length) break;
  }

  return { posts, account, categories, pagesRead, error: null };
}

export interface SkoolComment {
  /** Skool's own id where the DOM exposes it; otherwise a positional fallback. */
  id: string;
  authorName: string;
  body: string;
  /** True when the signed-in account wrote it — never reply to yourself. */
  byMe: boolean;
  /** Depth 0 is a top-level comment; deeper ones are replies to a comment. */
  depth: number;
}

export interface SkoolPostDetail {
  post: SkoolPost | null;
  comments: SkoolComment[];
  error: string | null;
}

/**
 * Read one post and its comments.
 *
 * ⚠️ THE COMMENTS HALF IS A DOM READ AND THAT IS NOT A PREFERENCE. The post
 * page's payload carries `postTree` (singular) whose `metadata.comments` is a
 * count; the bodies are not in it under any key that exists. Everything this
 * project has learned about DOM reads therefore applies: it can silently match
 * the wrong element, so this anchors on the comment's own container and reports
 * `error` rather than an empty list when the structure is not found — an empty
 * comment list and an unreadable one must never look the same.
 */
export async function readPost(communityUrl: string, slug: string): Promise<SkoolPostDetail> {
  const base = communityUrl.replace(/\/+$/, "");
  const url = `${base}/${slug}`;

  const raw = await withSkoolPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 3000));

    return await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc?.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return { fail: "no-payload" as const };
      let data: any;
      try {
        data = JSON.parse(el.textContent);
      } catch {
        return { fail: "unparseable" as const };
      }
      const pp = data?.props?.pageProps;
      const tree = pp?.postTree;
      if (!tree?.post) return { fail: "no-post" as const };

      const p = tree.post;
      const m = p.metadata ?? {};
      const self = pp.self ?? {};
      const selfId = String(self.id ?? "");
      const author = p.user ?? {};

      // Comments: find the elements that carry a "Reply" button and climb to the
      // block that also holds an author link. Anchoring on Reply is deliberate —
      // it is the one control that exists once per comment and nowhere else on
      // the page, so it cannot drift onto a sidebar card the way a class can.
      const replyButtons = Array.from(doc.querySelectorAll("button")).filter(
        (b: any) => (b.textContent || "").trim().toLowerCase() === "reply",
      ) as any[];

      const comments = replyButtons.map((btn: any, i: number) => {
        let node: any = btn;
        let authorLink: any = null;
        for (let hop = 0; hop < 8 && node; hop++) {
          node = node.parentElement;
          if (!node) break;
          const links = Array.from(node.querySelectorAll("a")) as any[];
          // The author link is the first one whose text is a plain name — not a
          // count, not an @mention, not a URL.
          authorLink =
            links.find((a: any) => {
              const t = (a.textContent || "").trim();
              return t && !/^@/.test(t) && !/^\d+$/.test(t) && !/^https?:/.test(t) && t.length < 60;
            }) ?? null;
          if (authorLink) break;
        }
        const container = node;
        const text = container ? String(container.textContent || "") : "";
        const authorName = authorLink ? String(authorLink.textContent || "").trim() : "";
        return {
          id: String(container?.getAttribute?.("data-comment-id") || container?.id || `idx-${i}`),
          authorName,
          raw: text,
          depth: 0,
        };
      });

      return {
        fail: null,
        selfName: [self.firstName, self.lastName].filter(Boolean).join(" ").trim() || String(self.name ?? ""),
        post: {
          id: String(p.id ?? ""),
          slug: String(p.name ?? ""),
          title: String(m.title ?? ""),
          body: String(m.content ?? ""),
          authorName: [author.firstName, author.lastName].filter(Boolean).join(" ").trim() || null,
          byMe: !!selfId && String(author.id ?? "") === selfId,
          commentCount: Number(m.comments ?? 0),
          likeCount: Number(m.upvotes ?? 0),
          pinned: Number(m.pinned ?? 0) > 0,
          createdAt: String(p.createdAt ?? ""),
          updatedAt: String(p.updatedAt ?? ""),
        },
        comments,
        replyButtonCount: replyButtons.length,
      };
    });
  });

  if (!raw) return { post: null, comments: [], error: "The browser could not be reached." };
  if (raw.fail) {
    const why: Record<string, string> = {
      "no-payload": "That post carried no Skool data payload — the session may have been bounced to a login.",
      unparseable: "Skool's data payload did not parse. Its page format may have changed.",
      "no-post": "Skool's payload had no `postTree`, so that post could not be read.",
    };
    return { post: null, comments: [], error: why[raw.fail] ?? "Could not read the post." };
  }

  const post: SkoolPost = { ...raw.post, category: null } as SkoolPost;

  // ⚠️ A COUNT THAT DISAGREES WITH THE DOM IS REPORTED, NOT PAPERED OVER. Skool
  // paginates long comment threads, and "46 comments, 8 readable" is a fact the
  // caller needs — a reply worker that believes it has seen every comment will
  // silently never answer the rest.
  const comments: SkoolComment[] = raw.comments.map((c: any) => ({
    id: c.id,
    authorName: c.authorName,
    body: stripAuthorChrome(c.raw, c.authorName),
    byMe: !!raw.selfName && c.authorName === raw.selfName,
    depth: c.depth,
  }));

  const short =
    post.commentCount > comments.length
      ? `Skool reports ${post.commentCount} comment(s) but only ${comments.length} are on this page — the rest are paginated.`
      : null;

  return { post, comments, error: short };
}

/**
 * A comment's container text runs the author, a timestamp, the body and the
 * Reply/like chrome together — Skool renders no separator. Trimming the known
 * chrome is best-effort by design: whatever survives is the body plus noise,
 * which a model can read, whereas an over-clever regex that eats a real
 * sentence cannot be noticed downstream.
 */
function stripAuthorChrome(raw: string, authorName: string): string {
  let out = String(raw ?? "");
  if (authorName) out = out.split(authorName).join(" ");
  return (
    out
      // Skool's timestamp renders as "• Oct '24" or "• 3d", glued to the body
      // with no separator. Observed live, not guessed.
      .replace(/•\s*[A-Z][a-z]{2}\s*'\d{2}/g, " ")
      .replace(/•\s*\d+[dhwmy]\b/g, " ")
      // The trailing chrome is a like count run into the word Reply — "1Reply",
      // or just "Reply" when nobody liked it.
      .replace(/\d*\s*\bReply\b/g, " ")
      .replace(/^\s*•\s*/, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/**
 * How many DMs are waiting.
 *
 * ⚠️ THIS IS THE CHEAP SIGNAL AND IT IS ON EVERY PAGE: `self.metadata.unreadChats`
 * comes back with any group page load, so the DM poller never has to open the
 * chat panel to learn there is nothing to do. Opening it is a real browser
 * interaction on the one shared profile; this is a payload read.
 */
export async function unreadChatCount(communityUrl: string): Promise<number | null> {
  const raw = await withSkoolPage(async (page) => {
    await page.goto(communityFeedUrl(communityUrl, 1), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2000));
    return await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc?.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return null;
      try {
        const pp = JSON.parse(el.textContent)?.props?.pageProps;
        const n = pp?.self?.metadata?.unreadChats;
        return n === undefined || n === null ? null : Number(n);
      } catch {
        return null;
      }
    });
  });
  return raw ?? null;
}
