/**
 * Who is in the community, and who has just joined.
 *
 * Same happy discovery as the feed and the classroom: the Members page ships
 * its list as JSON in `__NEXT_DATA__`, under `pageProps.users`, so reading it
 * needs no DOM at all. Each entry carries the person's display name, their
 * HANDLE (`claudia-garcia-3172` — the thing Skool's @mention autocomplete
 * actually matches on), and a nested `member` record whose `approvedAt` is the
 * moment they were let into THIS community.
 *
 * ⚠️ `approvedAt` IS ON `user.member`, NOT ON THE USER. `user.createdAt` is when
 * the person made a Skool ACCOUNT — Claudia's reads 2024-08-29 while she joined
 * this community on 2026-08-27, twenty-three months later. Sorting by the outer
 * date would rank the community's newest arrivals by how long they have used
 * Skool, which is not a mistake anything downstream could notice: the list would
 * still be full of real members with real names.
 *
 * ⚠️ THE PAGE ORDER IS NOT PROMISED TO BE JOIN ORDER. It looked like it on the
 * day this was written, which is exactly the kind of coincidence that turns into
 * a wrong answer the week someone rejoins. So every page is read and the sort is
 * done here, on the field that means what we need it to mean.
 */
import { withSkoolPage } from "./browser.js";
import { db } from "../db/index.js";

export interface SkoolMember {
  /** Skool's user id — stable across a name change, so this is the ledger key. */
  userId: string;
  /**
   * The @handle, e.g. `claudia-garcia-3172`.
   *
   * ⚠️ THIS IS THE MENTION QUERY, NOT THE DISPLAY NAME. Measured live
   * 2026-08-27: typing `@denise-fer` into the composer returns exactly one
   * candidate, because the autocomplete matches handles as well as names. A
   * first name does not have that property — two Claudias would both come back
   * and the popup's first entry is the one Enter commits.
   */
  handle: string;
  firstName: string;
  /** "Claudia Garcia" — what the committed mention chip reads as on the page. */
  displayName: string;
  /** When they were approved into THIS community, epoch ms. 0 when unknown. */
  joinedAt: number;
}

export interface MemberRead {
  members: SkoolMember[];
  pagesRead: number;
  error: string | null;
}

function membersUrl(communityUrl: string, pageNo: number): string {
  const base = communityUrl.replace(/\/+$/, "");
  return pageNo > 1 ? `${base}/-/members?p=${pageNo}` : `${base}/-/members`;
}

/** Skool's timestamps are ISO strings here. Anything unparseable is 0, not NaN. */
function epoch(iso: unknown): number {
  const t = Date.parse(String(iso ?? ""));
  return Number.isNaN(t) ? 0 : t;
}

async function readMembersPage(communityUrl: string, pageNo: number): Promise<MemberRead> {
  const fail = (error: string): MemberRead => ({ members: [], pagesRead: 0, error });

  const raw = await withSkoolPage(async (page) => {
    await page.goto(membersUrl(communityUrl, pageNo), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2500));

    return await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const el = doc?.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return { fail: "no-payload" as const, users: [] };
      let data: any;
      try {
        data = JSON.parse(el.textContent);
      } catch {
        return { fail: "unparseable" as const, users: [] };
      }
      const pp = data?.props?.pageProps;
      if (!pp) return { fail: "no-pageprops" as const, users: [] };
      if (!Array.isArray(pp.users)) return { fail: "no-users" as const, users: [] };

      return {
        fail: null,
        users: pp.users.map((u: any) => ({
          userId: String(u?.id ?? ""),
          handle: String(u?.name ?? ""),
          firstName: String(u?.firstName ?? ""),
          lastName: String(u?.lastName ?? ""),
          // The community membership, not the Skool account. See the header.
          approvedAt: String(u?.member?.approvedAt ?? ""),
          role: String(u?.member?.role ?? ""),
        })),
      };
    });
  });

  if (!raw) return fail("The browser could not be reached.");
  if (raw.fail) {
    const why: Record<string, string> = {
      "no-payload": "The members page carried no Skool data payload — the session may have been bounced to a login.",
      unparseable: "Skool's members payload did not parse. Its page format may have changed.",
      "no-pageprops": "Skool's members payload had no page props. Its page format may have changed.",
      "no-users": "Skool's members payload carried no member list — check the community URL.",
    };
    return fail(why[raw.fail] ?? "Could not read the members page.");
  }

  return {
    pagesRead: 1,
    error: null,
    members: raw.users
      .filter((u: any) => u.userId && u.handle)
      .map((u: any) => ({
        userId: u.userId,
        handle: u.handle,
        firstName: u.firstName,
        displayName: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.handle,
        joinedAt: epoch(u.approvedAt),
      })),
  };
}

/**
 * Every member, newest joiner first.
 *
 * `maxPages` is a stop rather than a target, exactly as on `readFeed`: at ~30 a
 * page a 71-member community is three, and whatever it stops at is reported
 * instead of implied. Each page is a full navigation of the shared browser, so
 * this is not free — callers that only want the last week's arrivals still pay
 * for the whole walk, which is why `newMembers` memoises nothing and is called
 * once per posting day rather than once per tick.
 */
export async function readMembers(communityUrl: string, maxPages = 4): Promise<MemberRead> {
  const seen = new Set<string>();
  const members: SkoolMember[] = [];
  let pagesRead = 0;

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const page = await readMembersPage(communityUrl, pageNo);
    if (page.error) {
      // A failure on page one is a failure; later it still returns what it has,
      // flagged. A short answer that says it is short beats no answer.
      if (pageNo === 1) return page;
      return { members, pagesRead, error: page.error };
    }
    pagesRead++;
    const before = members.length;
    for (const m of page.members) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      members.push(m);
    }
    // A page that added nobody is the end of the list. Skool keeps serving the
    // last page rather than 404ing past it, so "the page loaded" is not a stop
    // condition and walking to `maxPages` regardless would cost three needless
    // navigations on a small community.
    if (members.length === before) break;
  }

  members.sort((a, b) => b.joinedAt - a.joinedAt);
  return { members, pagesRead, error: null };
}

/* ────────────────────────── the welcome ledger ────────────────────────── */

/**
 * Everyone the agent has already said hello to, so nobody is welcomed twice.
 *
 * ⚠️ A LEDGER, NOT A DATE WINDOW, AND THE WINDOW ALONE WOULD NOT DO. The ask
 * post runs weekly and looks back seven days, so a member who joined an hour
 * before last Thursday's post is inside BOTH windows — they would be tagged
 * again seven days later, which reads as the agent not knowing who it has
 * spoken to. The window decides who is new; this decides who is unmet.
 */
export function welcomedUserIds(): Set<string> {
  const rows = db.prepare("SELECT user_id FROM skool_welcomed_members").all() as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}

/**
 * Record a welcome — called when the post LANDS, never when it drafts.
 *
 * The same rule as `recordAnnounced` for videos, for the same reason: a slot
 * that drafts and then fails to publish must not burn the greeting. Burning it
 * at draft time would mean the retry welcomes nobody and the members it named
 * are never greeted at all, silently, because nothing distinguishes "already
 * welcomed" from "welcomed by us, ten minutes ago, in a post that never went".
 */
export function recordWelcomed(members: SkoolMember[], slotKey: string): void {
  if (!members.length) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO skool_welcomed_members (user_id, handle, display_name, slot_key, welcomed_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const m of members) stmt.run(m.userId, m.handle, m.displayName, slotKey, now);
}

export interface NewMemberRead {
  members: SkoolMember[];
  /** Why the list is empty or short — shown rather than swallowed. */
  detail: string;
  error: string | null;
}

/**
 * Who joined recently and has not been greeted yet.
 *
 * ⚠️ AN EMPTY LIST IS A NORMAL WEEK, NOT A FAULT. A community can go seven days
 * without a new member, and the ask post still has to go out — so every caller
 * here treats "nobody new" as a post that opens with the question instead of a
 * welcome, never as a reason to skip the day.
 *
 * `limit` exists because the greeting is a line of a post, not a roll call:
 * eleven chips before the first word is a wall, and the people at the end of it
 * are decoration. The overflow is deliberately NOT deferred to next week — they
 * are recorded as welcomed either way, because a member greeted three weeks
 * after joining is worse than one not greeted at all.
 */
export async function newMembers(
  communityUrl: string,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<NewMemberRead> {
  const sinceDays = opts.sinceDays ?? 7;
  const limit = opts.limit ?? 5;
  const cutoff = Date.now() - sinceDays * 24 * 3600_000;

  const read = await readMembers(communityUrl);
  if (read.error && !read.members.length) return { members: [], detail: "", error: read.error };

  const welcomed = welcomedUserIds();
  const recent = read.members.filter((m) => m.joinedAt >= cutoff);
  const fresh = recent.filter((m) => !welcomed.has(m.userId));
  const picked = fresh.slice(0, limit);

  const detail =
    `${read.members.length} member(s) read over ${read.pagesRead} page(s); ` +
    `${recent.length} joined in the last ${sinceDays} days, ${fresh.length} of them not yet welcomed` +
    (fresh.length > picked.length ? `, taking the ${picked.length} newest` : "");

  return { members: picked, detail, error: read.error };
}
