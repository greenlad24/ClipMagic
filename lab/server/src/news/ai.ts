/**
 * AI News Stream — the one model call every stage goes through.
 *
 * ⚠️ THIS USED TO BE MiniMax, AND THE SWAP IS THE POINT. The app was ported
 * verbatim, MiniMax and all, and then sat unusable: its key was never set, so
 * clustering, summaries, notes and scripts all silently fell back. A run
 * produced sixty "stories" that were raw headlines, every one marked Single
 * Source, with SEO filler ("The 5 best Kanban tools in 2026") ranked above Meta
 * hiring MongoDB's CEO. Jake's instruction was to use what the Lab already has
 * rather than add another key, and the Lab already has Anthropic configured and
 * billed.
 *
 * So the provider changes and NOTHING ELSE DOES. Same prompts, same
 * temperatures, same expectations of the text that comes back — every caller
 * still hands over a prompt and gets a string.
 *
 * ⚠️ THE TIER IS THE COST DECISION AND IT IS NOT UNIFORM. Clustering sends
 * 250 headlines a batch and asks for up to 16k tokens back, several times a
 * run; the teleprompter script is 200 words that Jake reads on air. Pricing
 * them the same would mean either paying director rates to deduplicate
 * headlines or reading a Haiku script to camera. Each call site names its own.
 */
import { claudeTextForPurpose } from "../ai/claude.js";
import type { CallPurpose } from "../ai/runAccounting.js";

export type NewsTier = "fast" | "research" | "director";

/**
 * One completion. Returns plain text — several callers slice JSON out of it
 * themselves, which is why this is the text path and not the JSON one.
 *
 * Failure is THROWN, not swallowed: the callers already wrap this in try/catch
 * and fall back to headlines, and a silent empty string here is exactly how the
 * app came to look like it was working when it was not.
 */
export async function callNewsModel(
  prompt: string,
  purpose: CallPurpose,
  tier: NewsTier = "research",
): Promise<string> {
  const text = await claudeTextForPurpose({
    tier,
    purpose,
    // The app's prompts are self-contained instructions written for a single
    // user turn, so the system prompt stays out of their way.
    system:
      "You are the research and writing engine behind a daily AI news show. Follow the instructions in the message exactly, including any requested output format.",
    messages: [{ role: "user", content: prompt }],
  });
  return (text ?? "").trim();
}
