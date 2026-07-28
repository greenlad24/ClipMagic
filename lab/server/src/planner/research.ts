/**
 * Stage A — verify the real UI of the products the narration discusses.
 *
 * Without this the planner invents screens from its own knowledge, and an
 * operator following the plan opens the product to find the tab or button
 * doesn't exist. Jake's rule is that a screencast is described from the
 * product's real UI and purpose AND the script, so we establish the UI first.
 *
 * On the first real run this immediately caught a script-level problem: the
 * narration described a product as one thing while the verifiable product was
 * something else, and it flagged a documented navigation path that contradicted
 * what the narration claimed.
 *
 * Uses Anthropic server-side web search — it executes on Anthropic's side, so
 * there is no tool loop to run, but a long search turn can stop with
 * `pause_turn`, which we resume.
 */
import { anthropicRequest } from "./client.js";

const SYSTEM = `You research the software products discussed in a video narration so that a visual planner can write ACCURATE screencast instructions.

An operator will follow those instructions literally: they will open the product and record what you name. If you describe a page, tab, button, or flow that does not exist, they waste a recording session. Accuracy matters more than completeness.

For each product the narration discusses, establish:
- What the product actually is and does.
- Its real URL.
- The concrete screens a viewer would be shown: the landing page, the signup/onboarding flow, the main workspace, and any specific feature the narration names.
- The real names of navigation items, tabs, buttons and controls — as they actually appear.
- The realistic DURATION of each flow when performed for real (signing up, generating something, waiting for a result). The planner needs this to compute speed-ups.

Search the web to verify. Do not rely on memory for UI specifics — products change.

# Your standing relative to the script

The creator fact-checks his scripts against the live product before recording. **His script outranks your findings.** You are gathering supporting detail — real control labels, realistic durations, screens worth showing — not auditing him.

So: report what you can and cannot confirm, plainly, and stop there. Do not tell the planner to follow you over the narration, do not open with a warning about the script, and do not characterise a difference as an error in the script. If the narration describes a screen or path you could not confirm, that is a gap in public documentation — say exactly that, in those terms. Public docs lag real products constantly, and a private beta, a newer build, or a paid tier will not be documented at all.

# Output

Markdown. For each product, a section:

## <Product name> — <url>
**What it is:** one or two sentences.
**Verified screens:**
- <screen name> — what is on it, what the operator would do, roughly how long that takes for real
**Named controls:** the exact labels you could confirm
**NOT FOUND IN PUBLIC DOCS:** anything the narration relies on that you could not confirm. Be explicit and generous here — an honest gap is far more useful than a confident guess. Phrase each as a gap in your sources ("could not find a documented label for X"), never as a claim that the narration is wrong. The planner will still plan the beat as scripted and give the operator a label to confirm on screen.

Cover only products the narration actually discusses. If the narration is generic and names no product, say so plainly and stop.`;

export async function researchProducts(opts: {
  narration: string;
  productUrls?: string[];
  signal?: AbortSignal;
}): Promise<{ markdown: string; searches: number; costUsd: number }> {
  // The narration alone identifies the products; cap it so research stays cheap
  // relative to planning.
  const excerpt = opts.narration.split("\n").slice(0, 400).join("\n");
  const urls = opts.productUrls?.filter(Boolean) ?? [];

  const user = `${
    urls.length
      ? `The creator says these are the relevant product URLs — treat them as authoritative starting points:\n${urls
          .map((u) => `- ${u}`)
          .join("\n")}\n\n`
      : ""
  }Here is the narration:

${excerpt}

Research the products discussed and produce the UI fact sheet.`;

  const messages: any[] = [{ role: "user", content: user }];
  let markdown = "";
  let searches = 0;
  let costUsd = 0;

  for (let guard = 0; guard < 7; guard++) {
    const res = await anthropicRequest({
      body: {
        model: "claude-opus-4-8",
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: SYSTEM,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 24 }],
        messages,
      },
      signal: opts.signal,
    });

    const content: any[] = res.content || [];
    searches += content.filter((b) => b.type === "server_tool_use").length;
    markdown = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    costUsd += res.costUsd;

    // A long server-tool turn pauses rather than failing; re-send to continue.
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content });
      continue;
    }
    break;
  }

  return { markdown, searches, costUsd };
}
