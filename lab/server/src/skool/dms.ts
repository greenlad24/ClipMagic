/**
 * Direct messages: reading them over Skool's API, answering them through the UI.
 *
 * ⚠️⚠️ THE STANDING NOTE THAT DMs COULD NOT BE VERIFIED WAS WRONG, and it was
 * wrong in the direction that stops work. It said the panel "renders nothing to
 * read" and that a real DM would have to exist first. Both are false, measured
 * 2026-08-06: this account has real threads, one of them a member asking a
 * direct question, and the panel renders a full conversation UI. The earlier
 * conclusion came from an HTML dump truncated at 40,000 characters — the panel
 * was past the cut — plus `self.metadata.unreadChats` being 0, which means
 * "nothing UNREAD", not "no threads".
 *
 * The surface, found by recording what the page fetches rather than by reading
 * its markup (`skoolProbe` with `captureRequests`):
 *
 *     GET /self/chat-channels?offset=0&limit=30&last=true&unread-only=false
 *     GET /channels/<channelId>/messages?before=N&after=N&msg=<lastMessageId>
 *
 * ⚠️ THE SECOND PREFIX IS `/channels/`, NOT `/chat-channels/`. Three hand-written
 * guesses at the obvious path returned 404 before the recorder was pointed at
 * the panel; the endpoint is not derivable from the one beside it.
 *
 * ⚠️⚠️ THERE IS NO SEND BUTTON. The composer is a plain `<textarea>` and the
 * only controls beside it are "Chat actions" and "Add emoji" — so ENTER SENDS.
 * That single fact drives the whole writer:
 *
 *   - A newline in the text is not formatting, it is a SEND. A drafted DM
 *     containing a blank line between paragraphs would go out as three separate
 *     messages, the first of them a fragment. Line breaks must be Shift+Enter.
 *   - There is no button to check for `disabled`, so there is no cheap signal
 *     that Skool considers the message ready — the read-back is the only proof.
 *   - There is no undo and no confirm step. The keystroke IS the publish.
 *
 * ⚠️ AND AN UNSENT DRAFT PERSISTS. Measured: text left in a thread's composer
 * survived navigating to a different page and was still there on the next open,
 * so "navigate away to discard it" — which this file used to claim — is false.
 * Anything typed and not sent has to be deleted deliberately (`clearComposer`).
 *
 * ⚠️ AND MULTI-LINE DMs ARE REAL: an existing reply in this account's own
 * history is one message containing several paragraphs and three links. So
 * refusing newlines outright would refuse the shape Jake actually writes in.
 * They are typed as Shift+Enter instead.
 */
import { withSkoolPage } from "./browser.js";

/** Skool's own page asks for 30 threads. */
const CHANNEL_LIMIT = 30;

/** How many messages back to read in a thread. */
const MESSAGE_WINDOW = 35;

const settle = (ms = 800): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DmMessage {
  id: string;
  /** The message text. Skool stores it markdown-ish, links in [x](y) form. */
  body: string;
  /** True when this account sent it. */
  byMe: boolean;
  createdAt: string;
}

export interface DmChannel {
  id: string;
  /** The other person in the thread. */
  memberId: string;
  memberName: string;
  memberFirstName: string;
  /** Their bio, when Skool ships one — useful context for an answer. */
  memberBio: string;
  lastMessageId: string;
  lastMessageAt: string;
  lastMessageBody: string;
  /** True when the last thing said was theirs, so the ball is in our court. */
  lastFromThem: boolean;
  unread: number;
}

export interface ChannelRead {
  selfId: string;
  channels: DmChannel[];
  error: string | null;
}

/**
 * Every DM thread this account is in.
 *
 * ⚠️ THE FETCH RUNS INSIDE THE PAGE so it carries the session cookies without
 * this module ever handling them — the same bargain as reading `__NEXT_DATA__`,
 * and the same one `comments.ts` makes.
 */
export async function readChannels(communityUrl: string): Promise<ChannelRead> {
  const raw = await withSkoolPage(async (page) => {
    const url = communityUrl.replace(/\/+$/, "");
    // Only navigate when we are not already there: Skool is a Next.js SPA and a
    // second `goto` to the identical URL never commits, so `domcontentloaded`
    // never fires and the call hangs for its full timeout. That is the bug that
    // made the very first publish fail.
    const here = String(page.url() ?? "").split("#")[0].replace(/\/+$/, "");
    if (here !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await settle(2500);
    }

    return await page.evaluate(async (limit: number) => {
      const doc: any = (globalThis as any).document;
      const g: any = globalThis;
      const el = doc?.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return { fail: "no-payload" as const };
      let selfId = "";
      try {
        selfId = String(JSON.parse(el.textContent)?.props?.pageProps?.self?.id ?? "");
      } catch {
        return { fail: "unparseable" as const };
      }
      if (!selfId) return { fail: "no-self" as const };

      // ⚠️⚠️ THIS PAGINATES, AND THE FIRST VERSION DID NOT — IT RETURNED EXACTLY
      // 30 THREADS AGAINST A LIMIT OF 30, which is the classic shape of a
      // truncated read reporting itself as a complete one. Measured: offset 0,
      // 30 and 60 each return a different first id, so this account has well
      // over thirty conversations and a DM worker reading one page would never
      // see the rest of them.
      //
      // ⚠️ AND `offset` WORKS HERE EVEN THOUGH IT IS IGNORED BY THE COMMENTS
      // API on the same host — so neither behaviour can be assumed from the
      // other. Both were checked by asking for two pages and comparing ids.
      const all: any[] = [];
      const seenIds = new Set<string>();
      for (let offset = 0; offset < 600; offset += limit) {
        let page: any[];
        try {
          const res = await g.fetch(
            `https://api2.skool.com/self/chat-channels?offset=${offset}&limit=${limit}&last=true&unread-only=false`,
            { credentials: "include" },
          );
          const text = await res.text();
          if (!res.ok) return { fail: "api-error" as const, detail: `${res.status}: ${text.slice(0, 120)}` };
          page = JSON.parse(text)?.channels ?? [];
        } catch (e: any) {
          return { fail: "api-error" as const, detail: String(e?.message ?? e).slice(0, 160) };
        }
        if (!page.length) break;
        // Converge on ids rather than trusting the page count: a server that
        // clamps a large offset would otherwise loop forever on the last page.
        let added = 0;
        for (const c of page) {
          const id = String(c?.id ?? "");
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          all.push(c);
          added += 1;
        }
        if (added === 0 || page.length < limit) break;
      }
      return { fail: null, selfId, channels: all };
    }, CHANNEL_LIMIT);
  });

  if (!raw) return { selfId: "", channels: [], error: "The browser could not be reached." };
  if (raw.fail) {
    const why: Record<string, string> = {
      "no-payload": "The community page carried no Skool payload — the session may have been bounced to a login.",
      unparseable: "Skool's data payload did not parse. Its page format may have changed.",
      "no-self": "Skool's payload had no signed-in user, so DMs could not be read.",
      "api-error": `Skool's chat API refused: ${(raw as any).detail ?? "no detail"}`,
    };
    return { selfId: "", channels: [], error: why[raw.fail] ?? "Could not read the DM threads." };
  }

  const selfId = String(raw.selfId);
  const channels: DmChannel[] = (raw.channels as any[]).map((c: any) => {
    const u = c?.user ?? {};
    const last = c?.last_message ?? {};
    const lm = last?.metadata ?? {};
    const first = String(u.first_name ?? "").trim();
    return {
      id: String(c?.id ?? ""),
      memberId: String(u.id ?? ""),
      memberName: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || String(u.name ?? ""),
      memberFirstName: first,
      memberBio: String(u?.metadata?.bio ?? "").trim(),
      lastMessageId: String(c?.last_message_id ?? last?.id ?? ""),
      lastMessageAt: String(c?.last_message_at ?? ""),
      lastMessageBody: String(lm.content ?? ""),
      // ⚠️ DECIDED BY WHO SENT IT, NOT BY THE UNREAD FLAG. A thread we have
      // opened reads as 0 unread while still being unanswered, and an agent
      // keyed on unread would silently never reply to any of them.
      lastFromThem: !!String(lm.src ?? "") && String(lm.src) !== selfId,
      unread: Number(c?.metadata?.num_unread ?? 0),
    };
  });

  return { selfId, channels, error: null };
}

/**
 * Threads where the other person spoke last AND an answer would still make
 * sense, newest first.
 *
 * ⚠️⚠️ "THEY SPOKE LAST" IS NOT THE SAME AS "THEY ARE WAITING", AND THE LIVE
 * DATA MAKES THE POINT BETTER THAN ANY ARGUMENT. Of the seven threads on this
 * account whose last word was the member's, the most recent is from January and
 * the rest run back to 2024 — and they include a lone "👍", a "thank you jake",
 * and "Of course! I appreciate all of the value…". Those are conversations
 * ENDING politely, not questions going unanswered. An agent that treated the
 * raw list as a work queue would open with an unprompted reply to a thumbs-up
 * sent sixteen months ago, to seven real people, in Jake's name.
 *
 * So two structural filters, before any model is asked anything:
 *
 *   1. AGE. A reply to a months-old message is not late, it is strange. The
 *      cutoff is a parameter because "how stale is too stale" is a judgement,
 *      but it is never absent.
 *   2. SUBSTANCE. A closing pleasantry is not a question. Measured against the
 *      real tail: emoji-only and short thanks are what actually sits there.
 *
 * Neither filter can tell an answered question from an unanswered one on its
 * own — that is the drafter's job — but both keep the obviously-wrong out of
 * its hands entirely, which is the same bargain `answerable()` makes for
 * comments: the filter is the safety, not the prompt.
 */
export function needingReply(channels: DmChannel[], opts: { maxAgeDays?: number } = {}): DmChannel[] {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return channels
    .filter((c) => {
      if (!c.lastFromThem) return false;
      const body = c.lastMessageBody.trim();
      if (!body) return false;
      const at = Date.parse(c.lastMessageAt);
      // An unparseable date is treated as too old rather than as fresh: the
      // safe default for "should I message this person" is no.
      if (!Number.isFinite(at) || at < cutoff) return false;
      // Strip emoji and punctuation; what is left is the actual words.
      const words = body
        .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .trim();
      if (words.length < 12) return false;
      // A pure sign-off, however long it is padded out.
      if (/^(thanks?|thank you|ok|okay|cool|great|awesome|got it|will do|appreciate it)\b/i.test(words) && words.length < 40) {
        return false;
      }
      return true;
    })
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
}

export interface MessageRead {
  messages: DmMessage[];
  error: string | null;
}

/** One conversation, oldest first. */
export async function readMessages(communityUrl: string, channel: DmChannel): Promise<MessageRead> {
  const read = await withSkoolPage(async (page) => {
    const url = communityUrl.replace(/\/+$/, "");
    const here = String(page.url() ?? "").split("#")[0].replace(/\/+$/, "");
    if (here !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await settle(2000);
    }
    return await page.evaluate(
      async ({ id, msg, win }: { id: string; msg: string; win: number }) => {
        const doc: any = (globalThis as any).document;
        const g: any = globalThis;
        let selfId = "";
        try {
          selfId = String(JSON.parse(doc.getElementById("__NEXT_DATA__").textContent)?.props?.pageProps?.self?.id ?? "");
        } catch {
          return { fail: "unparseable" as const };
        }
        try {
          const res = await g.fetch(
            `https://api2.skool.com/channels/${id}/messages?before=${win}&after=${win}&msg=${msg}`,
            { credentials: "include" },
          );
          const text = await res.text();
          if (!res.ok) return { fail: "api-error" as const, detail: `${res.status}: ${text.slice(0, 120)}` };
          return { fail: null, selfId, messages: JSON.parse(text)?.messages ?? [] };
        } catch (e: any) {
          return { fail: "api-error" as const, detail: String(e?.message ?? e).slice(0, 160) };
        }
      },
      { id: channel.id, msg: channel.lastMessageId, win: MESSAGE_WINDOW },
    );
  });

  if (!read) return { messages: [], error: "The browser could not be reached." };
  if (read.fail) {
    return {
      messages: [],
      error:
        read.fail === "api-error"
          ? `Skool's chat API refused: ${(read as any).detail ?? "no detail"}`
          : "Skool's data payload did not parse.",
    };
  }

  const selfId = String(read.selfId);
  const messages: DmMessage[] = (read.messages as any[])
    .map((m: any) => ({
      id: String(m?.id ?? ""),
      body: String(m?.metadata?.content ?? ""),
      byMe: String(m?.metadata?.src ?? "") === selfId,
      createdAt: String(m?.created_at ?? ""),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  return { messages, error: null };
}

export interface SendResult {
  ok: boolean;
  detail: string;
  messageId: string | null;
}

/**
 * Empty the DM composer for one member, with real keystrokes.
 *
 * ⚠️ SELECT-ALL AND DELETE, NOT `value = ""`. The box is a React-controlled
 * `<textarea>`, so assigning to `value` updates the DOM and not the component's
 * state: the text reappears on the next render and Skool still believes the
 * draft exists. Pressing the keys a person would press is the only version that
 * leaves both in agreement.
 */
async function clearComposer(firstName: string): Promise<boolean> {
  const done = await withSkoolPage(async (page) => {
    const spot = await page.evaluate((first: string) => {
      const doc: any = (globalThis as any).document;
      const wanted = `message ${first}`.toLowerCase();
      const box = (Array.from(doc.querySelectorAll("textarea")) as any[]).find((t) => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && String(t.getAttribute("placeholder") || "").trim().toLowerCase() === wanted;
      });
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, firstName);
    if (!spot) return false;

    await page.mouse.click(spot.x, spot.y, { delay: 40 });
    await settle(200);
    try {
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      // ⚠️ BACKSPACE, NOT ENTER-ANYTHING. The send key is one row away and this
      // runs with a member's thread open and a full message selected.
      await page.keyboard.press("Backspace");
    } catch {
      return false;
    }
    await settle(300);

    return await page.evaluate((first: string) => {
      const doc: any = (globalThis as any).document;
      const wanted = `message ${first}`.toLowerCase();
      const box = (Array.from(doc.querySelectorAll("textarea")) as any[]).find(
        (t) => String(t.getAttribute("placeholder") || "").trim().toLowerCase() === wanted,
      );
      return !!box && String(box.value ?? "").trim().length === 0;
    }, firstName);
  });
  return done === true;
}

/**
 * Open the DM panel and the thread for one member.
 *
 * Extracted because clearing a stale draft has to get to the same composer that
 * sending does, and a second copy of this would be a second thing to keep true.
 */
async function openThread(input: { communityUrl: string; channel: DmChannel }): Promise<{
  ok: boolean;
  detail: string;
  matchedOn: string;
}> {
  // Open the panel, then the thread. Two clicks, because the thread list does
  // not exist until the panel is open.
  const opened = await withSkoolPage(async (page) => {
    const url = input.communityUrl.replace(/\/+$/, "");
    const here = String(page.url() ?? "").split("#")[0].replace(/\/+$/, "");
    if (here !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await settle(2500);
    }

    // ⚠️⚠️ THE CHATS BUTTON IS A TOGGLE, AND CLICKING IT BLIND CLOSES THE PANEL.
    // Caught live: after one action left the panel open, the next run clicked
    // "Open chats" again, shut it, and then reported that the member had no
    // thread — with the diagnostic sample showing the community feed instead of
    // a chat list. The failure names the wrong cause ("no thread for X") and the
    // fix is not to click harder, so this asks whether the panel is already up.
    //
    // The tell is the panel's own "Search users" box, which exists nowhere else.
    const panel = await page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const vis = (e: any): boolean => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // ⚠️ THE PANEL HAS TWO FACES AND ONLY ONE OF THEM HAS A SEARCH BOX. The
      // first version tested for "Search users" alone, which is the THREAD LIST
      // view; once a conversation is open that box is gone, so a second run read
      // the panel as closed, toggled it shut, and reported the member as having
      // no thread. Both views count as open — the conversation's composer is the
      // other tell.
      const searchBox = (Array.from(doc.querySelectorAll("input")) as any[]).some(
        (i) => vis(i) && String(i.getAttribute("placeholder") || "").trim().toLowerCase() === "search users",
      );
      const composerOpen = (Array.from(doc.querySelectorAll("textarea")) as any[]).some(
        (t) => vis(t) && /^message\s/i.test(String(t.getAttribute("placeholder") || "").trim()),
      );
      if (searchBox || composerOpen) return { open: true, x: 0, y: 0 };
      const btn = (Array.from(doc.querySelectorAll('button[aria-label="Open chats"]')) as any[]).find(vis);
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { open: false, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!panel) return { ok: false, why: "no-chat-button" };
    if (!panel.open) await page.mouse.click(panel.x, panel.y, { delay: 40 });

    // ⚠️ IF THIS MEMBER'S CONVERSATION IS ALREADY OPEN, DO NOT CLICK ANYTHING.
    // Measured as a 1-in-3 flake: with the thread already showing, the name
    // still matched — on the conversation HEADER rather than a list row — and
    // clicking it re-rendered the panel out from under the composer, so the very
    // next step reported "the composer vanished while typing". It failed safe,
    // but an autonomous worker cannot run at a two-thirds success rate. The
    // cheapest fix is not to perform a click that has nothing left to do.
    const already = await page.evaluate((first: string) => {
      const doc: any = (globalThis as any).document;
      const wanted = `message ${first}`.toLowerCase();
      return (Array.from(doc.querySelectorAll("textarea")) as any[]).some((t) => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && String(t.getAttribute("placeholder") || "").trim().toLowerCase() === wanted;
      });
    }, input.channel.memberFirstName);
    if (already) return { ok: true, matchedOn: "already open" };
    // ⚠️ THE LIST IS FETCHED, NOT RENDERED WITH THE PAGE. Opening the panel
    // fires `/self/chat-channels` and the rows appear when it answers, so a
    // short wait here does not fail loudly — it finds no thread and reports the
    // member as having no conversation. Measured: 4s was not enough and 7s was.
    await settle(7000);

    // The thread, by the member's name in the list.
    const thread = await page.evaluate(
      ({ full, first }: { full: string; first: string }) => {
        const doc: any = (globalThis as any).document;
        const vis = (e: any): boolean => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const find = (needle: string): any[] => {
          const wanted = needle.trim().toLowerCase();
          if (!wanted) return [];
          return (Array.from(doc.querySelectorAll("*")) as any[]).filter(
            (e) => vis(e) && String(e.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(wanted),
          );
        };
        // Full name first — it is the more selective of the two. Skool's rows
        // have been seen carrying only part of a name, so the first name is the
        // fallback rather than the primary; identity is CONFIRMED afterwards by
        // the composer's "Message <First>" placeholder either way.
        let hits = find(full);
        let matchedOn = "full name";
        if (!hits.length) {
          hits = find(first);
          matchedOn = "first name";
        }
        if (!hits.length) {
          // Report what the list DOES say, so a miss is a measurement rather
          // than a dead end.
          const rows = (Array.from(doc.querySelectorAll("*")) as any[])
            .filter((e) => vis(e))
            .map((e) => String(e.textContent || "").replace(/\s+/g, " ").trim())
            .filter((t) => t.length > 8 && t.length < 90);
          return { found: false, sample: [...new Set(rows)].slice(-12) };
        }
        // Smallest containing element — every ancestor up to <body> contains it too.
        hits.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        const el = hits[0];
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { found: true, matchedOn, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      { full: input.channel.memberName, first: input.channel.memberFirstName },
    );
    if (!thread?.found) return { ok: false, why: "no-thread", sample: (thread as any)?.sample ?? [] };
    await page.mouse.click((thread as any).x, (thread as any).y, { delay: 40 });
    await settle(4000);
    return { ok: true, matchedOn: (thread as any).matchedOn };
  });

  if (!opened?.ok) {
    const why: Record<string, string> = {
      "no-chat-button": 'No "Open chats" button is on the page, so the DM panel could not be opened.',
      "no-thread":
        `No thread for ${input.channel.memberName} is in the chat list, so nothing was typed. ` +
        `The list showed: ${JSON.stringify((opened as any)?.sample ?? [])}`,
    };
    return { ok: false, detail: why[String(opened?.why)] ?? "The DM panel could not be opened.", matchedOn: "" };
  }
  return { ok: true, detail: "", matchedOn: String((opened as any).matchedOn ?? "name") };
}

/**
 * Send one DM, by driving the panel the way a person does.
 *
 * ⚠️ THE PLACEHOLDER IS THE GUARD THAT WE ARE IN THE RIGHT CONVERSATION. The
 * composer reads "Message Shmae" — the correspondent's first name — so before a
 * single key is pressed this checks that the open thread belongs to the member
 * we meant. Threads are opened by clicking a name in a list, and a list that
 * reordered between the read and the click would otherwise send a member's
 * answer to a stranger, with no button to un-press.
 */
export async function sendDm(input: {
  communityUrl: string;
  channel: DmChannel;
  text: string;
  /** Do everything except the Enter that sends. */
  dryRun?: boolean;
  /**
   * Empty this thread's composer and stop.
   *
   * ⚠️ THERE HAS TO BE A WAY OUT OF THE GUARD. An unsent draft blocks every
   * later send to that member — correctly, since appending to somebody's
   * half-written message is the thing being prevented — but with no way to
   * clear one, a single interrupted run would lock that conversation for good.
   * Deliberate and separate, so clearing is never a side effect of sending.
   */
  clearDraft?: boolean;
}): Promise<SendResult> {
  const text = input.text.trim();
  if (input.clearDraft) {
    const opened = await openThread(input);
    if (!opened.ok) return { ok: false, detail: opened.detail, messageId: null };
    const cleared = await clearComposer(input.channel.memberFirstName);
    return {
      ok: cleared,
      detail: cleared
        ? `Emptied the composer in ${input.channel.memberName}'s thread. Nothing was sent.`
        : `Could not empty the composer in ${input.channel.memberName}'s thread.`,
      messageId: null,
    };
  }
  if (text.length < 5) return { ok: false, detail: `The message is only ${text.length} characters — not sending that.`, messageId: null };
  if (!input.channel.memberFirstName) {
    return {
      ok: false,
      detail: "That thread has no first name on it, so the composer's placeholder cannot be checked. Refusing to type into an unidentified conversation.",
      messageId: null,
    };
  }

  const log: string[] = [];
  const step = (s: string): void => {
    log.push(s);
  };

  const opened = await openThread(input);
  if (!opened.ok) return { ok: false, detail: opened.detail, messageId: null };
  step(`Opened the thread with ${input.channel.memberName} (matched on ${opened.matchedOn})`);

  // ⚠️ CONFIRM THE COMPOSER BELONGS TO THIS PERSON BEFORE TYPING.
  const composer = await withSkoolPage(async (page) =>
    page.evaluate((first: string) => {
      const doc: any = (globalThis as any).document;
      const boxes = (Array.from(doc.querySelectorAll("textarea")) as any[]).filter((t) => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const wanted = `message ${first}`.toLowerCase();
      const mine = boxes.find((t) => String(t.getAttribute("placeholder") || "").trim().toLowerCase() === wanted);
      if (!mine) {
        return {
          ok: false,
          placeholders: boxes.map((t) => String(t.getAttribute("placeholder") || "")).slice(0, 5),
        };
      }
      mine.scrollIntoView({ block: "center" });
      const r = mine.getBoundingClientRect();
      return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), existing: String(mine.value ?? "") };
    }, input.channel.memberFirstName),
  );

  if (!composer?.ok) {
    return {
      ok: false,
      detail:
        `The open conversation is not ${input.channel.memberName}'s: no composer is placeholdered ` +
        `"Message ${input.channel.memberFirstName}". Found ${JSON.stringify((composer as any)?.placeholders ?? [])}. ` +
        `Refusing to type — this is how a member's answer reaches a stranger.`,
      messageId: null,
    };
  }
  // A half-typed message already in the box would be sent along with ours.
  if (String((composer as any).existing ?? "").trim().length > 0) {
    return {
      ok: false,
      detail: `The composer already holds text ("${String((composer as any).existing).slice(0, 40)}…"), which is an unsent draft. Refusing to add to it.`,
      messageId: null,
    };
  }
  step(`Composer confirmed as "Message ${input.channel.memberFirstName}", and empty`);

  // Read the thread now, so the read-back can tell OUR message from what was
  // already there. Done before typing, because after Enter it is too late.
  const before = await readMessages(input.communityUrl, input.channel);
  if (before.error) return { ok: false, detail: `Could not read the thread first, so nothing was sent: ${before.error}`, messageId: null };
  const seen = new Set(before.messages.map((m) => m.id));

  const typed = await withSkoolPage(async (page) => {
    await page.mouse.click((composer as any).x, (composer as any).y, { delay: 40 });
    await settle(300);
    // ⚠️ LINE BREAKS ARE SHIFT+ENTER, BECAUSE A BARE ENTER IS THE SEND. Typing
    // the string wholesale would fire the message at the first blank line and
    // then send each following paragraph as its own message — the first of them
    // a fragment, all of them public to that member and unrecallable.
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 8 });
      if (i < lines.length - 1) {
        await page.keyboard.down("Shift");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Shift");
      }
    }
    await settle(400);
    // What actually landed in the box, so a partial type is caught before Enter.
    return await page.evaluate((first: string) => {
      const doc: any = (globalThis as any).document;
      const wanted = `message ${first}`.toLowerCase();
      const box = (Array.from(doc.querySelectorAll("textarea")) as any[]).find(
        (t) => String(t.getAttribute("placeholder") || "").trim().toLowerCase() === wanted,
      );
      return box ? String(box.value ?? "") : null;
    }, input.channel.memberFirstName);
  });

  if (typed === null) return { ok: false, detail: "The composer vanished while typing, so nothing was sent.", messageId: null };
  const landedChars = String(typed).replace(/\s+/g, " ").trim().length;
  const wantChars = text.replace(/\s+/g, " ").trim().length;
  if (landedChars < wantChars * 0.9) {
    return {
      ok: false,
      detail: `Only ${landedChars} of ${wantChars} characters reached the composer, so the message is incomplete. Enter was NOT pressed.`,
      messageId: null,
    };
  }
  step(`Typed ${landedChars} characters (${text.split("\n").length} line(s))`);

  if (input.dryRun) {
    // ⚠️⚠️ A DRY RUN MUST CLEAR UP AFTER ITSELF, AND THE FIRST VERSION DID NOT.
    // It claimed the text "stays in the box until the panel is closed or the
    // session is relaunched" — measured, and false: the draft SURVIVED
    // navigating to another page entirely and was still there on the next open.
    // Skool persists an unsent composer per thread.
    //
    // That is worse than untidy. The empty-composer guard above is what stops
    // this agent appending to somebody's half-written message, so a dry run
    // that leaves its own text behind arms that guard against the next REAL
    // send to the same member — the rehearsal quietly blocks the performance.
    const cleared = await clearComposer(input.channel.memberFirstName);
    return {
      ok: true,
      detail:
        `${log.join(" → ")} → DRY RUN: Enter was NOT pressed and nothing was sent. ` +
        (cleared
          ? "The composer was emptied afterwards."
          : "⚠ The composer could NOT be emptied — clear it by hand before sending to this member, or the guard will refuse."),
      messageId: null,
    };
  }

  await withSkoolPage(async (page) => {
    try {
      await page.keyboard.press("Enter");
    } catch {
      /* the read-back decides */
    }
  });
  step("Pressed Enter");
  await settle(3000);

  // ⚠️ THE ONLY EVIDENCE THAT COUNTS: a new message from us in that thread.
  const after = await readMessages(input.communityUrl, input.channel);
  if (after.error) {
    return { ok: false, detail: `${log.join(" → ")} → Sent, but the thread could not be re-read, so it is UNCONFIRMED: ${after.error}`, messageId: null };
  }
  const landed = after.messages.find((m) => m.byMe && !seen.has(m.id));
  if (!landed) {
    return {
      ok: false,
      detail:
        `${log.join(" → ")} → Enter was pressed and no new message from this account is in the thread. ` +
        `Treat it as not sent — but check the conversation before retrying, because one that landed late would duplicate.`,
      messageId: null,
    };
  }
  return {
    ok: true,
    detail: `${log.join(" → ")} → Read back: ${landed.body.trim().length} characters to ${input.channel.memberName}.`,
    messageId: landed.id,
  };
}
