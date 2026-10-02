/**
 * Deal Organizer — HTTP surface.
 *
 *   POST /api/deals/<fn>    JSON in, JSON out (behind the Lab sign-in)
 *
 * `<fn>` is the original Zite endpoint name (getDeals, updateDeal, …); each
 * handler mirrors that endpoint's inputs, outputs and logic. Errors come back
 * as `{ error: { code, message } }` with 400 (bad input / BAD_REQUEST),
 * 404 (NOT_FOUND) or 500.
 *
 * STREAMERS answer with NDJSON, like news/routes.ts: `{"chunk": X}` lines,
 * then `{"result": Y}` or `{"error": {"message"}}`. One run per function at a
 * time. A function in both maps (scanGmail) is served by its streamer.
 *
 *   handlers.ts            — Phase 1: stages, deals, production, comments, actions
 *   handlers2.ts           — Gmail sync, threads, companies, scanner, replies, chat, analytics
 *   integrations/handlers  — Gmail / YouTube / Slack connection status + tests
 *   agent/handlers         — the sponsorship email agent
 *   handlersAnalytics      — analytics metrics, deal fields, stage history
 *   handlersInbox          — Emails inbox views, chat assistant, on-demand drafts
 *   handlersFiles          — deal ↔ threads (many-to-many), files & document links per deal
 */
import express, { type Request, type Response } from "express";
import { HANDLERS } from "./handlers.js";
import { HANDLERS2, STREAMERS } from "./handlers2.js";
import { importDealOrganizerData } from "./import.js";
import { INTEGRATION_HANDLERS } from "./integrations/handlers.js";
import { AGENT_HANDLERS, AGENT_STREAMERS } from "./agent/handlers.js";
import { HANDLERS_ANALYTICS } from "./handlersAnalytics.js";
import { HANDLERS_INBOX, STREAMERS_INBOX, STREAMERS_INBOX_CONCURRENT } from "./handlersInbox.js";
import { HANDLERS_FILES } from "./handlersFiles.js";
import { runAsManualSend } from "./integrations/gmail.js";

type Handler = (input: any) => Promise<unknown> | unknown;
type Streamer = (input: any, emit: (chunk: unknown) => void) => Promise<unknown>;

const ALL_HANDLERS: Record<string, Handler> = {
  ...HANDLERS,
  ...HANDLERS2,
  ...INTEGRATION_HANDLERS,
  ...AGENT_HANDLERS,
  ...HANDLERS_ANALYTICS,
  ...HANDLERS_INBOX,
  ...HANDLERS_FILES,
  /** One-shot import of the Zite export. Refuses once deals exist (no force over HTTP). */
  importZiteData: () => importDealOrganizerData(),
};

const ALL_STREAMERS: Record<string, Streamer> = { ...STREAMERS, ...AGENT_STREAMERS, ...STREAMERS_INBOX };
/** Streamers with their own finer-grained locks (chat: per session; drafts: per thread). */
const CONCURRENT = new Set<string>(STREAMERS_INBOX_CONCURRENT);

/**
 * The only calls that may SEND email: a Send button Jake clicked (mode "send"
 * on the first two). Everything else — the scheduler, the agent, follow-ups,
 * the chat assistant — runs outside runAsManualSend(), so gmail.ts refuses
 * any send from it (Jake 2026-10-02: drafting is the rule for automation).
 */
const MANUAL_SEND_HANDLERS = new Set(["sendReply", "sendFollowUp", "sendGmailDraft"]);

const CODES: Record<number, string> = { 400: "BAD_REQUEST", 404: "NOT_FOUND" };
const running = new Set<string>();

export const dealsRouter = express.Router();

dealsRouter.post("/:fn", express.json({ limit: "5mb" }), async (req: Request, res: Response) => {
  const fn = req.params.fn;

  const streamer = Object.prototype.hasOwnProperty.call(ALL_STREAMERS, fn) ? ALL_STREAMERS[fn] : undefined;
  if (streamer) {
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const line = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");
    const exclusive = !CONCURRENT.has(fn);
    if (exclusive && running.has(fn)) {
      line({ error: { code: "BUSY", message: "Already running — wait for the current run to finish." } });
      res.end();
      return;
    }
    if (exclusive) running.add(fn);
    try {
      const result = await streamer(req.body ?? {}, (chunk) => line({ chunk }));
      line({ result });
    } catch (err: any) {
      console.error(`[deals] ${fn} failed:`, err);
      line({ error: { code: "INTERNAL_ERROR", message: err?.message ?? String(err) } });
    } finally {
      if (exclusive) running.delete(fn);
      res.end();
    }
    return;
  }

  const handler = Object.prototype.hasOwnProperty.call(ALL_HANDLERS, fn) ? ALL_HANDLERS[fn] : undefined;
  if (!handler) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `Unknown function ${fn}` } });
    return;
  }
  try {
    const body = req.body ?? {};
    res.json(await (MANUAL_SEND_HANDLERS.has(fn) ? runAsManualSend(fn, () => handler(body)) : handler(body)));
  } catch (err: any) {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 500) console.error(`[deals] ${fn} failed:`, err);
    res.status(status).json({ error: { code: CODES[status] ?? "INTERNAL_ERROR", message: err?.message ?? String(err) } });
  }
});
