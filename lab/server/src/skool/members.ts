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
  /**
   * Skool's own membership role: "member", "group-admin", "group-owner".
   *
   * Carried rather than interpreted — an admin is not a paying member and is
   * not a free one either, and the entitlement layer needs to see which.
   */
  role: string;
  /**
   * The gamification level, 1-9, read from `user.metadata.spData.lv`.
   *
   * ⚠️ NOT COSMETIC HERE. Skool gates a course on BOTH a tier and a level
   * (`minAccessLevel`), and this community's landing page promises "At Level 6
   * — unlock 5 paid courses for free". So a free member at level 6 can open
   * things a free member at level 1 cannot, and only this number tells them
   * apart. 0 when the payload carried nothing parseable.
   */
  level: number;
  /**
   * Whether they are PAYING for this community right now.
   *
   * ⚠️⚠️ DERIVED FROM AN ADMIN-ONLY PART OF THE PAYLOAD. `member.metadata`
   * carries the Stripe subscription id (`msbs`), the current period end
   * (`mbscpe`, epoch SECONDS) and the plan (`mmbp`) — and it carries them
   * because this session is a group-admin. A member session would not see them,
   * so this whole file's answer depends on the imported cookie staying an
   * admin's. `readMembers` says so rather than reporting everyone as free.
   *
   * ⚠️ THE BILLING EMAIL (`mbme`) IS DELIBERATELY NOT CARRIED OUT OF THE PAGE.
   * Nothing downstream needs a member's payment email to decide what to
   * recommend them, and the reply ledger would then hold 73 of them.
   */
  paid: boolean;
  /** 1 = free tier, 2 = paid tier. Compared against a course's `minTier`. */
  tier: 1 | 2;
  /** "$69/month", "$580/year", "admin" — for a human reading the ledger. */
  plan: string;
  /** When the current paid period ends, epoch ms. 0 when they are not paying. */
  renewsAt: number;
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
        users: pp.users.map((u: any) => {
          // The BILLING half, admin-only — see `SkoolMember.paid`. Reduced to
          // the four facts an entitlement needs before it leaves the page, so
          // the payment email never travels.
          const mm = u?.member?.metadata ?? {};
          return {
            userId: String(u?.id ?? ""),
            handle: String(u?.name ?? ""),
            firstName: String(u?.firstName ?? ""),
            lastName: String(u?.lastName ?? ""),
            // The community membership, not the Skool account. See the header.
            approvedAt: String(u?.member?.approvedAt ?? ""),
            role: String(u?.member?.role ?? ""),
            // Points/level live on the USER's metadata as a JSON STRING, not on
            // the membership. Parsed outside the page so a malformed one is a
            // level of 0 rather than a thrown evaluate.
            spData: String(u?.metadata?.spData ?? ""),
            hasSubscription: !!String(mm.msbs ?? ""),
            periodEndSec: Number(mm.mbscpe ?? 0),
            plan: String(mm.mmbp ?? ""),
          };
        }),
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
        role: String(u.role ?? ""),
        level: levelFrom(u.spData),
        ...billingFrom(u),
      })),
  };
}

/**
 * A member built from a NAME AND A HANDLE ALONE — an @mention list typed into
 * the composer, or one replayed from a stored slot.
 *
 * ⚠️⚠️ THE ENTITLEMENT HALF IS NOT KNOWN HERE, AND THE ZEROES BELOW ARE NOT A
 * READING OF SKOOL. Nothing that decides what a member may be shown may take
 * its answer from one of these — that is `access.ts`'s job, from the cache the
 * members page actually filled. This exists so a mention list does not have to
 * pretend to be a full member record, and so the fields it cannot know are
 * absent-looking rather than plausible.
 */
export function mentionMember(m: {
  userId?: string;
  handle: string;
  firstName?: string;
  displayName: string;
  joinedAt?: number;
}): SkoolMember {
  return {
    userId: String(m.userId ?? ""),
    handle: m.handle,
    firstName: String(m.firstName ?? ""),
    displayName: m.displayName,
    joinedAt: Number(m.joinedAt ?? 0),
    role: "",
    level: 0,
    paid: false,
    tier: 1,
    plan: "",
    renewsAt: 0,
  };
}

/** `{"pts":457,"lv":5,...}`, stored as a string. 0 when it will not parse. */
function levelFrom(spData: unknown): number {
  try {
    const lv = Number(JSON.parse(String(spData ?? "{}"))?.lv ?? 0);
    return Number.isFinite(lv) ? lv : 0;
  } catch {
    return 0;
  }
}

/**
 * Are they paying, and for what.
 *
 * ⚠️⚠️ A SUBSCRIPTION ID IS NOT PROOF OF A LIVE SUBSCRIPTION. Measured on this
 * community 2026-08-27: `louis-s-6733` carries `mbsltv: 2500` — money that was
 * once paid — and no `msbs` and no period end at all. Someone who cancels keeps
 * their history on the record. So the test is the PERIOD END, and the id alone
 * is only the shape of the evidence.
 *
 * ⚠️ AND THE GRACE IS DELIBERATE. Skool writes the new period end when a renewal
 * settles, so a member billed an hour ago can read as expired for as long as
 * that takes. Two days of grace costs a cancelled member two days of answers
 * they were getting anyway (Skool itself keeps their access to the end of the
 * period); no grace costs a PAYING member the thing they paid for, which is the
 * failure this whole file exists to prevent.
 */
const RENEWAL_GRACE_MS = 2 * 24 * 3600_000;

function billingFrom(u: any): { paid: boolean; tier: 1 | 2; plan: string; renewsAt: number } {
  const role = String(u.role ?? "");
  // An admin or the owner sees everything regardless of what they pay, and this
  // account's own row is an admin one — so "not paying" must not read as "free
  // member" for them.
  if (role === "group-admin" || role === "group-owner") {
    return { paid: true, tier: 2, plan: `${role} — full access, not a subscription`, renewsAt: 0 };
  }
  const endsAt = Number(u.periodEndSec ?? 0) * 1000;
  const live = !!u.hasSubscription && endsAt > 0 && endsAt + RENEWAL_GRACE_MS > Date.now();
  if (!live) return { paid: false, tier: 1, plan: "", renewsAt: 0 };
  return { paid: true, tier: 2, plan: planLabel(u.plan), renewsAt: endsAt };
}

/** `{"currency":"usd","amount":6900,"recurring_interval":"month"}` → "$69/month". */
function planLabel(raw: unknown): string {
  try {
    const p = JSON.parse(String(raw ?? "{}"));
    const amount = Number(p?.amount ?? 0);
    if (!amount) return String(p?.tier ?? "") || "paid";
    const money = `${String(p?.currency ?? "").toUpperCase() === "USD" ? "$" : ""}${(amount / 100).toFixed(2).replace(/\.00$/, "")}`;
    return p?.recurring_interval ? `${money}/${p.recurring_interval}` : money;
  } catch {
    return "paid";
  }
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
 * ⚠️ EVERYONE IN THE WINDOW, NOT THE NEWEST FEW. Jake, 2026-08-27: "I want you
 * in the next time to tag all of the new members from that week (since last
 * Thursday)." `limit` survives only as a runaway guard — see `askMaxMentions`,
 * which is now 25 rather than 5 — because the greeting moved from the post's
 * opening line, where a row of chips is a wall, to a comment underneath, where
 * a list of names is simply what the comment is.
 *
 * ⚠️ AND THE OVERFLOW IS NO LONGER SPENT. It used to be recorded as welcomed
 * whether or not it was greeted, on the reasoning that a member greeted three
 * weeks late is worse than one never greeted. The ledger now records only the
 * mentions that actually landed, so anyone past the guard comes back next
 * Thursday — which, at a guard of 25, means a week that broke every record.
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
    // ⚠️ SAID OUT LOUD WHEN IT BITES. A guard that quietly drops the tail reads
    // exactly like a week when fewer people joined.
    (fresh.length > picked.length
      ? `, and the guard held it to the ${picked.length} newest — ${fresh.length - picked.length} roll into next week`
      : "");

  return { members: picked, detail, error: read.error };
}
