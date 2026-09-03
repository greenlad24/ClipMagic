You are doing the FINAL review pass on a complete Jake Dawson YouTube script before it's finalized. Voice: the smart, curious friend at the bar.

Run the assembled script against this checklist. Where it fails, FIX it in place (rewrite the offending lines) — keep everything that already works. Then report what you changed.

## STAGE 7 — REVIEW CHECKLIST

Before finalizing the full script:

**Priorities:**
- [ ] Short hook?
- [ ] Short intro?
- [ ] Large meat part with verified, current, step-by-step data?
- [ ] Honest thoughts included?
- [ ] Short call to action?
- [ ] Whole script readable by a 14-year-old?

**Voice & persona:**
- [ ] No punch-sideways (no competitor / other-YouTuber / "better than X" references)?
- [ ] No punch-down (no "if you've been doing this wrong")?
- [ ] Humor at self or situation, never at viewer?
- [ ] At most one story-shrapnel line (from `story-shrapnel-bank.md`)?
- [ ] No credential monologue anywhere?
- [ ] Welcome line ("Hey everyone, welcome back to the channel, I'm Jake Dawson, and let's dive right in.") at the END of the hook?

**Craft:**
- [ ] Does the hook grab attention with drama / strong opening?
- [ ] Is the premise clear in the first 60 seconds?
- [ ] Does every section deliver one clear thing?
- [ ] Does it demo the tool, not just describe it?
- [ ] Is the Skool plug natural?

---

## CONTENT RULES (non-negotiable)

- **NO income claims** — no "$X/month," no "make money," no financial promises
- **Broad audience** — solopreneurs + small business owners. Universal use cases whenever possible.
- **"Exact prompts" format** — show the literal prompt, not just the concept. This is what gets views.
- **Honest pros & cons** — Jake's brand is trust. Never oversell a tool.
- **No competitor mentions, ever** — no "better than [tool X]," no "unlike other [thing]." Talk about what *this* does.

---

## ALSO CHECK — the rule amendments, which override anything above that contradicts them

These came from Jake's audits of real generated scripts he then edited by hand. Each names the rule it enforces.

- **No credential in the opener.** One short line max, landing during the video, never at the top, never a monologue. (Rule 4.)
- **No banned word survives, in any form.** "caveat"/"caveats" (say "one thing to know" or "the catch"), "clever", "neat", "genuinely", "real deal", "which" (split the sentence or use "that"), "whether" (say "if"). Singular or plural, they get rewritten — not softened, removed. Also "Picture …" as an opener (Jake says "Imagine …"). (Rule 8.)
- **Is the tool called by its NAME after the hook** — never "this thing" / "the thing" once it's been named? (Rule 8. Fix by naming the tool, or the concrete noun: "the website", "the page".)
- **The open after the hook is lean — it does NOT re-run the hook.** No roadmap-of-the-video preview, no second welcome or second credential, no separate "who this is for" list restating the audience the hook already named, and the tool's job explained ONCE, not three times. If a viewer could skip the whole stretch between the hook and the first real thing and miss nothing, cut it down until they couldn't. (Rule 9.)
- **No section-announcements** ("let's talk money, this is the part everyone wants to know about") and no self-narrated honesty ("my real take, said once") — cut the label, keep the content. (Rule 10.)
- **The newest figure won, and none of the bookkeeping leaked.** (Rule 11.) Four things to catch: the script using an older figure where the fact sheet has a newer one (swap it — newer always wins); a figure the fact sheet listed under OLDER — SAY HOW OLD spoken flat, as if it were today's (don't cut it, date it — "last published price was $10, back in early 2025"); a verification date read out loud as if it were dialogue — "twenty euros a month, verified September 2026" — that's a note to the writer, not a line to record (cut the parenthetical, keep the fact, unless the date itself is the point); and any hedge that dates the SPEAKER instead of the fact — "as of my last update", "at the time of writing", "I believe it's currently" (say it plainly or cut it).
- No company-name drops.

Respond as STRICT JSON only (no markdown):
{
  "revisedScript": string,   // the full corrected script, ready to record
  "changes": [string],       // bullet list of what you fixed and why
  "checklist": {             // pass/fail per key item
    "shortHook": boolean, "largeMeat": boolean, "fourteenYearOld": boolean,
    "noPunchSideways": boolean, "noPunchDown": boolean, "welcomeAtHookEnd": boolean,
    "noIncomeClaims": boolean, "demosNotDescribes": boolean,
    "leanOpen": boolean,            // open after the hook doesn't re-run the hook (rule 9)
    "noSectionAnnouncement": boolean, // no "let's talk money…" / "my real take, said once" (rule 10)
    "toolNamedNotVague": boolean,   // tool called by name after the hook, not "this thing" (rule 8)
    "noStaleFacts": boolean         // newest figure used where one exists, older ones spoken with their age, no verification dates read aloud (rule 11)
  }
}

FULL ASSEMBLED SCRIPT:
[PASTE FULL SCRIPT]
