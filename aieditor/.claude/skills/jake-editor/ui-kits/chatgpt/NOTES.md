# ChatGPT UI kit: capture notes

Captured 2026-10-09 21:02 to 21:19 UTC from the live chatgpt.com in **dark theme** (RULEBOOK S7), in **Chat** mode, logged
in as **Jake Dawson (Plus)**. Every px in `kit.json` is a CSS px at the recorder's own viewport (1536×864 CSS,
device scale 2560/1536 = 1.667, Google Chrome 155 with the Mac identity from `screencast/macchrome.mjs`).

## What is in the kit

| part | what it is | live source |
|---|---|---|
| `composer` | the "Ask ChatGPT" box. 768 wide; single-line 52 tall, radius 26; multi-line 102 tall, radius 28; with attachments 246 tall. Parts: + button, text, model label "Instant" + chevron, mic, and voice (blue) / send (blue arrow) | `/` new chat, DOM + computed styles |
| `menu` | the "+" menu: 13 real rows (label + grey description + real icon). Surface #303030, 1 px rgba(255,255,255,.15) border, radius 20, padding 8, rows 36 tall (padding 6/8, radius 12, gap 12), first row highlighted rgba(255,255,255,.1) | opened from the + button |
| `chip` | `kind` skill/tool = the inline **blue tool pill** ("Create image", 500 weight, rgb(83,130,205), 20 px icon) that picking a menu tool puts at the start of the text line; `kind` image = 122×122 tile; `kind` file = 160×122 tile (doc icon + name, 12 px) | picked "Create image"; attached a canvas test image + a test `brief.txt` |
| `working` | the app's **shimmer status** text (dim rgba(175,175,175,.55) + a bright rgba(255,255,255,.75) window that sweeps over it) | "Waiting for your answer" rendered live; animation read with `getAnimations()` |
| `result.user` | the user's bubble: #173e76, text #f6fafe, padding 10/16, radius 22, max 70 % of the column, right-aligned; copy/share/edit icons under it | existing chat (read-only) |
| `result.text` | the assistant's plain markdown text (16/26 px, #ededed, no bubble) + the action bar (copy, like, dislike, share, retry, read aloud, more; 32 px buttons, #afafaf) | existing chat "Logo Concept Questions" (read-only) |
| `result.image` | a generated image: 480 wide (any aspect), radius 16, 80 px bottom fade with the **Edit** pill (14 px, 500, white, blur 12) and the share button, action bar 28 px below | existing chat "Create Apple Image" (read-only) |
| `tokens` | all colours as `--cg-*` variables (the template puts `kit.tokens` on the kit root) | computed styles |
| `assets/` | 30 icons: the composer/result SVGs resolved from ChatGPT's own sprite (`/cdn/assets/icons-*.svg`) or inline SVGs, plus the 7 app icons the menu shows as PNG (downscaled to 48 px) | DOM |

## Fonts

ChatGPT asks for `-apple-system-body, ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, …`, which is **SF Pro**
on a Mac. The capture browser aliases SF to **Inter** (`screencast/image/fonts-mac.conf`), so the screenshots are Inter, and
Inter is also the closest free (OFL) match to SF Pro. The kit maps `"Inter": "Inter.ttf"` (already in `motion/fonts`, no
font added). **Trap:** `motion/fonts/Inter.ttf` is the *variable* Inter, which has an `opsz` axis (14 to 32). Chrome's
automatic optical sizing makes it about 1 % narrower than the static Inter the browser used, which was enough to re-wrap the bubble
text. Every kit root therefore sets `font-optical-sizing:none` (the default instance is opsz 14, the text cut).

## Behaviours measured (use them in the motion)

- **Single-line vs multi-line.** While typing burst by burst, the DOM reported single-line until the text was wider than
  the 520 px field (68 characters here). Every *settled* screenshot with text, even "Hi", showed the multi-line layout
  (text on its own row, then + and the tools on a second row). The kit defaults to single-line (stable for motion). Pass
  `layout_class: "is-multiline"` for the settled look. A pill or attachment switches it to multi-line by itself.
- **Voice vs send.** With an empty draft, the right-most button is the blue **voice** button. As soon as there is text or an
  attachment, it becomes the blue **send arrow** (CSS `:has`, automatic).
- **"+" menu placement.** On the new-chat screen it opens **below** the composer: 4 px gap, same 768 width, left edges
  aligned, at most 378 tall (about 10 rows, the rest scroll). The thread variant, where the composer is at the bottom and the
  menu opens above, was not captured.
- **Shimmer.** The window (mask 0 → 20 → 30 → 50 %) moves from translateX -50 % to 125 % in **1.0 s** with `steps(48)`. It
  restarts every **~3.95 s** and rests at -50 % (invisible) in between. The kit has no CSS animation, because renders are
  seeked frame by frame: the template sets `--cg-sweep-x` per frame (see `working.shimmer`).
- **Working texts.** These are the app's own strings from its JS bundle: `Thinking` (thinkingShimmer.default), `Creating image` /
  `Creating images` (shown beside a **Skip** button while images generate), `Waiting for your answer`. Only the last one was
  rendered live. Seeing the others needs a send, which this capture never does.

## Replica check

`replica/<state>.png` shows the kit rendered standalone in headless Chrome (aieditor-screencast:0.2) at the same size and device
scale as the screenshot, with the CSS run through the prompt_menu template's own scoping regex. `replica-compare.png`
puts them side by side as **real | replica | diff×3**:

| state | mean abs diff (0-255) | px with diff > 40 |
|---|---|---|
| composer (empty) | 0.75 | 0.68 % |
| composer typed "Hi" (settled, multi-line) | 0.38 | 0.28 % |
| composer multi-line prompt | 3.3 | 1.25 % |
| composer pill + prompt | 3.17 | 1.39 % |
| composer with image + file tiles | 1.18 | 0.31 % |
| "+" menu | 4.95 | 3.67 % |
| result: bubble + generated image + action bar | 2.71 | 1.23 % |
| result: bubble + text + shimmer status | 4.85 | 3.95 % |

Measured positions: text runs start and end within 0 to 1.2 px of the real ones. The bubble box is identical (537×253 at the same
y). The image-result action bar is within 0.6 px, and menu rows within 0.6 px. The residual diff is glyph anti-aliasing
(sub-pixel x) and the live text caret.
`replica-working-sweep.png` shows the shimmer at four `--cg-sweep-x` values; no live mid-sweep frame exists to compare against.

A prompt_menu render with this kit (template engine, aieditor-motion:1) was also checked: icons, descriptions, the hover
row, the blue send button and the final "Create image" pill all draw.

## Not captured / limits

- The **thinking / creating-image states live** (needs a send, forbidden here). The wording is from the bundle and the look from the
  same shimmer component.
- The **stop button** that replaces send while a reply streams (needs a send).
- The **"+" menu opening upward** in a thread, and the menu's scrolled rows 11 to 13 (they are in `items`, but there is no
  screenshot of them).
- **Hover** looks other than the first-row highlight. The attachment's remove "x" is opacity 0 until hover (documented in
  `chip.remove_x`, not drawn).
- The **light theme** (Jake records ChatGPT dark).

## Privacy (RULEBOOK C7)

See `kit.json` → `private_check`. In short: the profile opened on a second account, which was switched to
Jake's before any capture, and that first page shot was deleted. No e-mail, ids, chat titles or other names are in the kit
or the screenshots (all screenshots are cropped to the chat column). Nothing was sent, deleted, renamed or shared. The account lock was held for 17 min.
