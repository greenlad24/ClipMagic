# Claude (claude.ai) UI kit — notes

**Source: from reference, verify against live.** This kit was built on 2026-10-09 from Jake's motion5 reference clip. That clip is a screen capture of a YouTube tutorial showing claude.ai's dark new-chat page with a long prompt being typed. The YouTube player chrome was cropped away; see `motion/reference-specs/prompt_highlight.md`.

It was not captured live:
- `aieditor.agentrec.scout_for("https://claude.ai")` returns None. The Lab has UX Scout logins for notion, linearity, gmail, openai-com and chatgpt, not for claude.ai.
- No account lock was taken and no browser session was opened.

When a Scout login for claude.ai exists, recapture live: AccountLock([slug], "uikit-claude"), agentrec.Session on a COPY of the profile, dark=True, click guard on, no sending or deleting. Then replace the numbers below with computed styles.

## What is in the kit
- **composer**: the new-chat prompt box.
  - Prompt text block `.cl-prompt` (16 px Inter, weight 440, −0.27 px tracking, 24 px lines).
  - Bottom row: "+" (`assets/plus.svg`), the model label (`kit.model_label`, "Opus 5.5 High") with `assets/chevron.svg`, and the orange send button `.cl-send` (`assets/arrow-up.svg`).
  - `{{chips_html}}` and `{{state_html}}` slots for other templates.
- **greeting**: the spark logo (`assets/spark.svg`, 12 rounded rays, #D77F60) plus the serif greeting. **Default "Evening, Jake"**; never another person's name.
  - Source Serif 4 at 30.6 px. Its baseline sits 39.3 px above the composer top.
- **suggestions**: the chip row under the composer (Create / Write / Career chat / Claude’s choice). Measured widths; 14.4 px below the composer. OPTIONAL — prompt_highlight hides it by default (Jake 2026-10-10: "no need for the elements beneath the chatbox").
- **working / result: not captured.** The reference never shows them. They are null, so MO05 prompt → result can't use Claude until a live capture adds them.
- **message.json** (written by the long_prompt_scroll agent, merged by the lead): the chat message view. It is not part of this file.

## Measurements
All measured at the reference's end view, where 1 css px = 1.805 screen px.

| part | value |
|---|---|
| composer | 727 × (text + 59) css px, radius 20, 1 px border #32322F, fill #292926 |
| text padding | 12.75 top / 18 left / 24 right (text width 683; every reference line wraps at the same word) |
| bottom row | 32 tall, 4.8 below the text, 12 above the bottom edge |
| send | 32 × 32, radius 6.5, #D26C4D, 15 px white arrow |
| model label | Inter 11.7 px #BBBBB7, right edge 151.2 from the outer right; chevron 9 × 4.6, centre 106.4 from the outer right |
| chips | 26 tall, radius 6.5, fill #292926, text Inter 11.6 px #C1C0BB, padding-left 12, gap 6.4 |
| page | #20201D |

## Fonts
- The prompt and UI are in the system sans (SF Pro on the reference Mac), substituted with **Inter**. Tracking was tuned so the line widths match within 2–3 px.
- The greeting is Anthropic's serif, substituted with **Source Serif 4**. Added to `motion/fonts/SourceSerif4.ttf` with `OFL-SourceSerif4.txt`, downloaded from github.com/google/fonts.

## Colours
The colours are as the YouTube encode shows them. Live claude.ai dark is slightly lighter (page ≈ #262624, surface ≈ #30302E). A live capture should replace them.

## Replica check
`replica-compare.png` compares the real composer (reference end view, name blurred) with this kit, plus a red/cyan overlay. Static positions match within ≤ 1.5 px, the line wraps are identical, and the highlight edges are within 3 px. `screenshot-replica-composer.png` is the replica alone.

## Privacy (RULEBOOK C7)
- The only name in the kit is Jake's display name in the greeting default.
- There is no e-mail, avatar, org name, chat history or account id.
- The reference greeting's first name is blurred in every reference image we produce and appears in no file.
- `uikits.load("claude")` passes the private-text check.
