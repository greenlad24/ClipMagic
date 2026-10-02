/**
 * Deal Organizer — THE reply drafter for the chat and the Emails page.
 *
 * One door: `draftReplyForThread({ threadId, instructions? })` runs the LIVE
 * agent's own per-thread pipeline in preview mode (agent/run.ts
 * previewDraftForThread): triage → fit → context → writeDraft (Opus 5.5 +
 * the rulebook) → code checks + checker model, one redraft on failure. Same
 * voice, same prices, same signature as the scheduled agent.
 *
 * Nothing is written: no Gmail draft, no agent item, no board move, no Slack.
 * Saving is a separate, explicit step — the existing `sendReply` handler,
 * which only ever creates a Gmail DRAFT (integrations/gmail.ts refuses /send).
 *
 * Cost ≈ $0.10–0.25 per call (Sonnet triage + Opus draft + Opus check, maybe a
 * redraft) — only ever run when Jake clicks / asks.
 */
import { previewDraftForThread, type PreviewDraftResult } from "./agent/run.js";

export type DraftReplyResult = PreviewDraftResult;

/** One draft at a time per thread (a double click must not pay twice). */
const inFlight = new Map<string, Promise<DraftReplyResult>>();

export function draftReplyForThread(input: {
  threadId: string;
  instructions?: string;
  onProgress?: (message: string) => void;
}): Promise<DraftReplyResult> {
  const threadId = String(input.threadId ?? "").trim();
  if (!/^[A-Za-z0-9]+$/.test(threadId)) {
    return Promise.reject(Object.assign(new Error("threadId is required"), { status: 400 }));
  }
  const key = `${threadId}::${(input.instructions ?? "").trim()}`;
  const running = inFlight.get(key);
  if (running) {
    input.onProgress?.("A draft for this thread is already being written — joining it.");
    return running;
  }
  const p = previewDraftForThread({ threadId, instructions: input.instructions, onProgress: input.onProgress })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}
