/**
 * Engagement Manager — direct messages through the logged-in browser.
 *
 * WHY THIS EXISTS. The Graph API cannot see an Instagram message REQUEST, and
 * @jakedawsonshorts follows nobody, so every DM the account will ever receive
 * arrives as a request: invisible to the API, and therefore invisible to the
 * whole monitor. Instagram's own settings confirm there is no way out of it —
 * "Who can send you message requests" offers Everyone / Your followers / No one
 * and nothing that delivers a stranger straight to the inbox. Verified in Jake's
 * own account, 2026-08-18.
 *
 * The browser has no such blindness. It is signed in as him, so it sees exactly
 * what he sees, and a message typed into the web UI is not subject to the Send
 * API's 24-hour window either — that window is a platform POLICY on the API, not
 * a rule about people typing in Instagram.
 *
 * WHAT THIS IS NOT. It is not a replacement for the API. Reading and replying
 * through a real browser is slower, fragile against DOM churn, and sits in the
 * ToS grey area Jake accepted in July. So the API stays FIRST wherever it works
 * (see senders.ts) and this is the fallback — the path for things the API
 * genuinely cannot reach: pending requests, and messages older than a day.
 *
 * ⚠️ ACCEPTING A REQUEST IS A REAL, VISIBLE ACT. Instagram tells the sender
 * nothing while a request merely sits there — its own words are "they won't know
 * you've seen it until you accept" — but accepting lets them message and call
 * him from then on. So acceptance is deliberate and separate from reading, and
 * reading NEVER accepts as a side effect.
 *
 * SELECTOR STATUS (probed read-only against Jake's live logged-in session,
 * 2026-08-18):
 *   - request rows: `div[role="button"]` in the left list, innerText
 *     "<name> | <preview> | · | 5d". NOT anchors — there is no href to read, so
 *     a row has to be clicked to learn its thread id.
 *   - request thread: opens at /direct/t/<threadId>/, carries the message text
 *     and exactly three buttons — Accept, Delete, Block — and NO composer. The
 *     composer does not exist until the request is accepted.
 *   - message text: `div[dir="auto"]` / `span[dir="auto"]` leaves inside the
 *     scrollable conversation pane. Meta nests these, so only leaves count or
 *     every message is read twice.
 *   - COMPOSER + SEND: UNVERIFIED. Neither could be probed, because an accepted
 *     conversation is required to see them and the only request in the account
 *     is a cold sales pitch not worth accepting to test against. The selectors
 *     below are written from the same accessibility-first rules as senders.ts
 *     and MUST be confirmed against a real accepted thread before dry-run comes
 *     off. sendInstagramDm reports "could not find the composer" rather than
 *     clicking something hopeful.
 */
import { sleep, randInt, typeHuman, waitForAny, withPage } from "./browser.js";
import type { InboxItem } from "./types.js";

/** A pending Instagram message request, as read off the web UI. */
export interface BrowserRequest {
  /** Instagram's thread id, from /direct/t/<id>/ — stable, and our dedup anchor. */
  threadId: string;
  /** Display name shown on the row ("Geo Youakim"). */
  senderName: string | null;
  /** @handle, read from the thread header when it renders one. */
  senderHandle: string | null;
  /** Every message in the request, oldest first. */
  messages: { text: string; index: number }[];
  /** The row's relative age label ("5d", "2h") — Instagram shows nothing better. */
  ageLabel: string | null;
  permalink: string;
}

/** Bounded so a spam wave can't turn one poll into a thousand page loads. */
const MAX_REQUESTS_PER_POLL = 10;

const REQUESTS_URL = "https://www.instagram.com/direct/requests/";

/**
 * Rows in the requests list that are chrome, not conversations. Matched on the
 * row's leading text so a real sender named "Delete" can't be swallowed.
 */
const NON_ROW_LABELS = [/^hidden requests/i, /^delete \d+/i, /^decide who can message you/i];

/** Lines inside a thread that belong to its header/footer, not the conversation. */
function isChromeLine(line: string, senderName: string | null, senderHandle: string | null): boolean {
  const l = line.trim();
  if (!l) return true;
  if (senderName && l === senderName) return true;
  if (senderHandle && (l === senderHandle || l === `${senderHandle} · Instagram`)) return true;
  return (
    /^view profile$/i.test(l) ||
    /^accept message request/i.test(l) ||
    /^if you accept/i.test(l) ||
    /^(accept|delete|block)$/i.test(l) ||
    // Instagram's message timestamps: "Wed 4:01 PM", "12 Aug", "Yesterday 9:14 AM".
    /^(mon|tue|wed|thu|fri|sat|sun|today|yesterday)\b/i.test(l) ||
    /^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(l) ||
    /^\d{1,2} \w{3}( \d{4})?$/i.test(l)
  );
}

/**
 * Read the pending Instagram message requests, WITHOUT accepting any of them.
 *
 * Rows carry no href, so each one has to be clicked to learn its thread id — and
 * the list re-renders underneath us on every navigation, so we return to the
 * list and re-find the row by index each time rather than holding a stale handle.
 *
 * Returns [] on any failure. This runs inside the monitor loop, which must never
 * be taken down by a DOM change.
 */
export async function readInstagramRequests(limit = MAX_REQUESTS_PER_POLL): Promise<BrowserRequest[]> {
  const out = await withPage<BrowserRequest[]>("instagram", async (page) => {
    const found: BrowserRequest[] = [];

    const rowCount = async (): Promise<number> => {
      await page.goto(REQUESTS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(randInt(4_000, 6_500));
      return await page.evaluate((skip: string[]) => {
        const doc: any = (globalThis as any).document;
        const re = skip.map((x) => new RegExp(x, "i"));
        const rows = [...doc.querySelectorAll('div[role="button"]')].filter((el: any) => {
          const t = (el.innerText ?? "").trim();
          return t.length > 0 && !re.some((r) => r.test(t));
        });
        return rows.length;
      }, NON_ROW_LABELS.map((r) => r.source));
    };

    const total = Math.min(await rowCount(), Math.max(1, limit));

    for (let i = 0; i < total; i++) {
      // Back to the list every time: opening a thread replaces the DOM.
      if (i > 0) await rowCount();

      const rowText: string | null = await page.evaluate(
        (idx: number, skip: string[]) => {
          const doc: any = (globalThis as any).document;
          const re = skip.map((x) => new RegExp(x, "i"));
          const rows = [...doc.querySelectorAll('div[role="button"]')].filter((el: any) => {
            const t = (el.innerText ?? "").trim();
            return t.length > 0 && !re.some((r) => r.test(t));
          });
          const row: any = rows[idx];
          if (!row) return null;
          const text: string = row.innerText ?? "";
          row.click();
          return text;
        },
        i,
        NON_ROW_LABELS.map((r) => r.source),
      );
      if (!rowText) continue;

      await sleep(randInt(3_500, 5_500));

      const detail = await page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        const loc: any = (globalThis as any).location;
        const m = String(loc.pathname).match(/\/direct\/t\/(\d+)/);
        // The conversation pane is the one that actually scrolls.
        const pane: any = [...doc.querySelectorAll("div")].find(
          (d: any) => d.scrollHeight > d.clientHeight + 50 && d.clientHeight > 200,
        );
        const scope: any = pane ?? doc.body;
        // Meta nests dir="auto" inside dir="auto"; only leaves are real lines.
        const lines: string[] = [...scope.querySelectorAll('div[dir="auto"], span[dir="auto"]')]
          .filter((el: any) => !el.querySelector('div[dir="auto"], span[dir="auto"]'))
          .map((el: any) => (el.innerText ?? "").trim())
          .filter(Boolean);
        const handle = lines.find((l) => /·\s*Instagram$/.test(l))?.replace(/\s*·\s*Instagram$/, "") ?? null;
        return { threadId: m ? m[1] : null, lines, handle };
      });

      if (!detail.threadId) continue;

      // The row reads "<name> | <preview…> | · | 5d"; the name is the first line
      // and the age the last, which is all Instagram gives us.
      const rowLines = rowText.split("\n").map((l) => l.trim()).filter(Boolean);
      const senderName = rowLines[0] ?? null;
      const ageLabel = rowLines.length ? rowLines[rowLines.length - 1] : null;

      const messages = detail.lines
        .filter((l: string) => !isChromeLine(l, senderName, detail.handle))
        .map((text: string, index: number) => ({ text, index }));

      found.push({
        threadId: detail.threadId,
        senderName,
        senderHandle: detail.handle,
        messages,
        ageLabel: ageLabel && /^\d+[smhdw]$/i.test(ageLabel) ? ageLabel : null,
        permalink: `https://www.instagram.com/direct/t/${detail.threadId}/`,
      });
    }

    return found;
  });
  return out ?? [];
}

/**
 * Accept one pending request, so the sender lands in the normal inbox — which is
 * also what makes the conversation visible to the Graph API from then on.
 *
 * This is the one function here that changes something the sender can see, so it
 * is never called as a side effect of reading. The button is matched on its exact
 * visible text among the three the request screen offers (Accept / Delete /
 * Block): a fuzzy match next to a Delete button is not a risk worth taking.
 */
export async function acceptInstagramRequest(threadId: string): Promise<{ ok: boolean; error: string | null }> {
  const out = await withPage<{ ok: boolean; error: string | null }>("instagram", async (page) => {
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(randInt(4_000, 6_000));

    const clicked = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const btn: any = [...doc.querySelectorAll('button,[role="button"]')].find(
        (b: any) => ((b.innerText ?? "") as string).trim().toLowerCase() === "accept",
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) return { ok: false, error: "No Accept button on that thread — already accepted, or it was withdrawn." };

    await sleep(randInt(3_000, 5_000));
    // Accepting swaps the Accept/Delete/Block row for a real composer. That, not
    // the click landing, is what tells us it actually went through.
    const composer = await waitForAny(page, IG_COMPOSER_SELECTORS, 15_000);
    return composer
      ? { ok: true, error: null }
      : { ok: false, error: "Clicked Accept but no composer appeared — the request may not have been accepted." };
  });
  return out ?? { ok: false, error: "Browser unavailable." };
}

/**
 * Instagram DM composer, most specific first. UNVERIFIED — see the header. The
 * comment composer on a reel is a real <textarea> labelled "Add a comment…", and
 * the DM box is expected to be the same shape with a message placeholder, but
 * nobody has seen it in this account because there is no accepted conversation.
 */
const IG_COMPOSER_SELECTORS = [
  'textarea[placeholder*="Message" i]',
  'div[role="textbox"][contenteditable="true"][aria-label*="Message" i]',
  'div[contenteditable="true"][aria-label*="Message" i]',
  'textarea[aria-label*="Message" i]',
  // Last resort: a DM thread has exactly one editable box, unlike a Page feed.
  'div[role="textbox"][contenteditable="true"]',
];

/**
 * Send a DM into a conversation by thread id, optionally accepting it first.
 *
 * ACCEPTANCE IS GATED ON THE REPLY DECISION, not on the message existing. By the
 * time this is called, replyGen has already read the message against Jake's own
 * style guide and decided it deserves an answer — and his guide's spam rule is
 * what throws out the cold pitches. So the bot only ever accepts people it is
 * about to answer, and a "$400k in 72 hours" DM is declined and left sitting in
 * requests exactly as it should be. That is the whole reason acceptance lives
 * here at send time rather than in the monitor: the monitor cannot tell spam from
 * a customer, and the reply generator already does.
 *
 * A dry run never accepts. Accepting is real and visible to the sender, so it is
 * not something a rehearsal should do.
 */
export async function sendInstagramDm(
  threadId: string,
  text: string,
  opts: { dryRun: boolean; acceptPending?: boolean },
): Promise<{ ok: boolean; error: string | null; dryRun: boolean; accepted?: boolean }> {
  const out = await withPage<{ ok: boolean; error: string | null; dryRun: boolean }>("instagram", async (page) => {
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(randInt(4_000, 6_000));

    const pending = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      return [...doc.querySelectorAll('button,[role="button"]')].some(
        (b: any) => ((b.innerText ?? "") as string).trim().toLowerCase() === "accept",
      );
    });
    let accepted = false;
    if (pending) {
      if (!opts.acceptPending) {
        return {
          ok: false,
          dryRun: opts.dryRun,
          error: "That conversation is still a pending request — accept it before replying.",
        };
      }
      if (opts.dryRun) {
        return {
          ok: false,
          dryRun: true,
          error: "DRY RUN — would have accepted this message request and replied. Set ENGAGE_REPLY_DRY_RUN=false to do it.",
        };
      }
      const ok = await page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        const btn: any = [...doc.querySelectorAll('button,[role="button"]')].find(
          (b: any) => ((b.innerText ?? "") as string).trim().toLowerCase() === "accept",
        );
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!ok) {
        return { ok: false, dryRun: false, error: "Could not find the Accept button on that request." };
      }
      accepted = true;
      // Accepting swaps Accept/Delete/Block for the composer; that swap is the
      // proof it went through, so the composer wait below doubles as the check.
      await sleep(randInt(3_000, 5_000));
    }

    const composer = await waitForAny(page, IG_COMPOSER_SELECTORS, 20_000);
    if (!composer) {
      return {
        ok: false,
        dryRun: opts.dryRun,
        accepted,
        error: accepted
          ? "Accepted the request but no composer appeared — the reply was not sent."
          : "Could not find the message composer (layout changed, or signed out).",
      };
    }

    try {
      await page.click(composer);
    } catch (e) {
      return { ok: false, dryRun: opts.dryRun, error: `Could not focus the composer: ${e instanceof Error ? e.message : String(e)}` };
    }
    await sleep(randInt(400, 1_200));
    await typeHuman(page, text);
    await sleep(randInt(600, 1_600));

    if (opts.dryRun) {
      return {
        ok: false,
        dryRun: true,
        error: "DRY RUN — typed the message but did not send it. Set ENGAGE_REPLY_DRY_RUN=false to send.",
      };
    }

    try {
      await page.keyboard.press("Enter");
    } catch (e) {
      return { ok: false, dryRun: false, error: `Could not send: ${e instanceof Error ? e.message : String(e)}` };
    }

    // The composer emptying is the only portable proof it left: Instagram gives
    // no message id back to the DOM.
    await sleep(randInt(2_500, 4_500));
    const stillThere = await page.evaluate((sel: string) => {
      const doc: any = (globalThis as any).document;
      const el: any = doc.querySelector(sel);
      return ((el?.value ?? el?.textContent ?? "") as string).trim().length > 0;
    }, composer);

    return stillThere
      ? { ok: false, dryRun: false, accepted, error: "Sent but the composer still holds the text — it probably did not go." }
      : { ok: true, dryRun: false, accepted, error: null };
  });
  return out ?? { ok: false, error: "Browser unavailable.", dryRun: opts.dryRun };
}

/**
 * A stable dedup key for a browser-read message. Instagram exposes no message id
 * in the DOM, so the key is the thread plus the message's own text — which is
 * what makes re-reading the same request on the next poll a no-op instead of a
 * duplicate. Two identical messages in one thread collapse to one row; that is
 * the right trade against a duplicate every ten minutes forever.
 */
export function browserDedupKey(threadId: string, text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return `ig-dm:${threadId}:${(h >>> 0).toString(36)}`;
}

/** Map a browser-read request into inbox rows (oldest message is the thread root). */
export function requestToInboxItems(
  req: BrowserRequest,
  channelId: string,
): Omit<InboxItem, "id" | "ingestedAt" | "replyState">[] {
  return req.messages.map((m, idx) => ({
    channelId,
    platform: "instagram" as const,
    kind: "dm" as const,
    dedupKey: browserDedupKey(req.threadId, m.text),
    threadId: req.threadId,
    parentId: idx === 0 ? null : req.threadId,
    targetRef: req.threadId,
    targetTitle: `DM · ${req.senderName ?? req.senderHandle ?? "Unknown"}`,
    authorName: req.senderName,
    authorHandle: req.senderHandle,
    // No page-scoped id exists for a request — the API cannot see it at all, so
    // there is nobody to address a Send API call to. The browser is the only way
    // to answer these, and it addresses the THREAD, not a person id.
    authorId: null,
    text: m.text,
    permalink: req.permalink,
    // Instagram's list shows "5d", never a timestamp. Guessing an epoch from that
    // would put a fake precision on it that the 24-hour window logic then trusts.
    postedAt: null,
    source: "browser-scrape" as const,
  }));
}
