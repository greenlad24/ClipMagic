# UI kits: the real app UI for prompt boxes

Jake (2026-10-09): *"The prompt boxes should always look like the actual UI that the narration is prompting (it should
understand how the UI looks 1 to 1 and replicate it in the motion design)."*

A **UI kit** is one app's real interface, captured from the live page and reduced to small HTML/CSS templates:
the composer, its "+" or "/" menu, chips (tool pills and attachments), the "working" state, and the result views (text reply, generated
image, the user's bubble). The motion templates (`prompt_menu`, `prompt_card_3d`, `prompt_result`, …) keep their own
**measured motion** and swap in the kit's **look**, so the box on screen is the app's own UI.

| app | folder | status |
|---|---|---|
| ChatGPT | `chatgpt/` | captured live 2026-10-09 (dark, Chat mode, Jake Dawson's account); options map live 2026-10-10 → `chatgpt/options.json`; see `chatgpt/NOTES.md` |
| Claude (claude.ai) | `claude/` | captured separately (see `ui-kits/claude/NOTES.md`); `claude/options.json` = options from public help pages, UNVERIFIED (no claude.ai login) |

## The rule when there is no kit: the neutral box

`aieditor/uikits.py for_app(app)` returns the app's kit or **None**. None means the template draws the **neutral box**
(the reference clips' own generic, unbranded composer), and the job log says so ("no ui kit for X — neutral box").
**Never another app's UI.** `for_app` never falls back to a different app, and `load()` refuses a kit whose `app`
is not its folder name. `prompt_result` (prompt → real result in the app's result UI) needs a kit **and** a real
result asset; without both it is refused and the honest route is a screencast.

## Options map

`<app>/options.json` lists the app's CURRENT composer options: the + menu, the "/" menu, the model picker, modes and toggles. For each
option it records the composer state it produces (pill, chip, indicator) and whether that was verified live. The prompt_menu
presets (one variation per option) are built from it. An option that is not verified live is marked so; a video must not show it
until it has been checked.

## Format

`<app>/kit.json`, validated by `schemas/uikit.schema.json` and by `uikits.load()` (required fields + privacy screen):

```
{ app, name, hosts[], theme, source: "live DOM", captured{date, url_paths (no ids), theme, viewport}, private_check,
  fonts {"Family": "file.ttf in motion/fonts"}, font_real, tokens {"--x-…": value},
  composer {width, height, css, html, placeholder, prompt_sel, send_sel, fill{…}},          // {{prompt}} {{placeholder}} {{chips_html}} {{state_html}} (+ optional extras)
  menu     {css, html, item_html, items[{label, desc, icon|icon_html}], hover_class, anchor, gap, row_h},   // {{items_html}}; {{icon_html}} {{label}} {{desc}}
  chip     {css, html},                                                                   // {{name}} {{icon_html}} {{kind}}
  working  {css, html, texts, shimmer},                                                   // {{text}}
  result   {text{css, html}, image{css, html}, user{css, html}} }                         // {{text_html}} / {{src}} {{alt}} / {{text}}
```

How the templates use it (`motion/templates/prompt_menu.js buildKit`, `runtime.js fill`):

- `uikits.scene_kit(kit)` inlines `{{file:assets/x.svg}}` and `"icon": "assets/x.svg"`, keeps only fonts that exist in
  `motion/fonts`, and drops `captured`. The result goes into `scene.kit`.
- Every CSS rule is scoped under `.kit-<app>` by a regex that splits selectors on commas. So **never put a comma inside
  `:has()` / `:is()`** (write two rules), and **no `@keyframes`**: renders are seeked frame by frame, so a kit exposes animation as a
  CSS variable the template sets each frame (ChatGPT: `--cg-sweep-x` for the shimmer).
- `{{key}}` fills are escaped unless the key ends in `_html`, and unknown keys become empty. A kit may add optional keys
  (list them in `composer.fill`), as long as an empty value still gives the right default look.
- The composer is laid out at its natural CSS size (`width`/`height`) and scaled to the reference composer's on-screen
  width; `tokens` go on the kit root as CSS variables.
- The menu's `items` are the app's real rows. The template matches the narration's labels to them to pick the real icon.

## How to add an app (step by step)

1. **Scout login.** The app needs a UX Scout profile: `agentrec.scout_for("https://<app>")` must return one (Jake logs
   in once in the Lab's Scout console). With no login, a kit may be captured from the app's **public, logged-out**
   page (an outside, never-logged-in Chrome: `usroute.fresh_profile` + `usroute.outside_chrome_env`). Mark it
   `"source": "public DOM"`, or document the app as not captured.
2. **Account lock.** Wait until `accountlock.busy('<slug>')` is False, then hold
   `accountlock.AccountLock(['<slug>'], 'uikit-capture')` **only while the live browser runs** (a few minutes; capture
   first, analyse offline). Never use the account in parallel with a job. Release it the moment the browser closes.
3. **A COPY of the Scout profile, with the guard on.** Never open the Scout's own profile. `_tools/cap.mjs` is the driver:
   the recorder's Mac Chrome identity (`screencast/macchrome.mjs`) and its click guard (`screencast/clickguard.mjs`), both
   imported and never edited, plus `evaluate` + PNG screenshots, which `agent_rec.mjs` lacks. It also hard-blocks Enter and
   send/delete/rename/share. It runs at the recorder's viewport (1536×864 @ 2560/1536) with `prefers-color-scheme` set to the
   app's recorded theme (RULEBOOK S7). Run:
   `docker run -d --rm --name uikit-cap -v screencast:/app/screencast:ro -v _tools/cap.mjs:/app/uikit/cap.mjs:ro -v <work>:/w -v <profile copy>:/prof aieditor-screencast:0.2 node /app/uikit/cap.mjs /prof`,
   then drop `{"cmd": "open"|"eval"|"shot"|"click"|"type"|"key"|"scroll"|"quit", …}` files into `<work>/q/NNNN.json` and read `NNNN.out.json`.
   `eval` runs `<work>/js/<file>` with `ARG`.
4. **Check the account first.** A profile can hold two accounts: ChatGPT's opened on someone else's.
   Switch to Jake Dawson's through the profile menu (a switch, never a log-out) before capturing anything, and delete any
   shot that shows another account.
5. **What to capture.** Open a fresh chat and capture:
   - the composer empty (placeholder), with typed text (type, **never send**, then clear it), and multi-line
   - the "+" or "/" menu (open, capture **immediately**, because a screenshot can close it; then Escape)
   - a tool pill / attachment chip (only neutral, generated test files)
   - the working state
   - the result views, from an **existing** chat (read-only: scroll; never rename, delete or share)

   For each, take: `js/dump.js` (DOM + computed styles, `display:contents` followed), `js/sprite.js` (icon sprites: resolve every
   `<use href>` into an inline SVG), `js/pngs.js` (image icons), `js/anim.js` / `js/cad.js` (animation keyframes + cadence via
   `getAnimations()`), `js/jsgrep.js` (the app's own UI strings from its bundles, for states you cannot trigger), and
   PNG screenshots cropped to the component plus 24 px.
6. **Build the kit offline.** Write minimal HTML with your own class prefix and CSS from the computed values (colours as
   tokens). Copy only visual attributes; never ids, account, user or conversation attributes. Pick fonts that exist in
   `motion/fonts`. If you add a font, add its OFL licence next to it. Watch variable fonts' `opsz`: ChatGPT needed
   `font-optical-sizing:none` to match the static Inter of the capture.
7. **Privacy check (RULEBOOK C7).** `uikits.privacy_issues(kit)` must be empty, and read every screenshot: no e-mail,
   keys, ids, chat titles, sidebar, or other people's names. Only the display name "Jake Dawson" may appear. Write what you
   verified into `private_check`.
8. **Replica compare.** Render each state standalone in headless Chrome (aieditor-screencast:0.2, same device scale and
   crop as the real screenshot, CSS run through the template's scoping regex). See `_tools/replica-chatgpt.mjs`, an
   example that reads the capture's working dir as `/s`. Then `_tools/compare.py` builds `replica-compare.png`
   (real | replica | diff×3, mean error per state) and `_tools/measure.py` measures boxes and text runs. Iterate until text and
   boxes are within ~1 px. Also render the kit inside the real template once (`motiontemplates.scene(..., kit=)` +
   `motion/render.mjs`).
9. **Files.** `<app>/kit.json`, `assets/*.svg|png`, `screenshot-*.png`, `replica/*.png`, `replica-compare.png`, `NOTES.md`
   (what each part is, the measured behaviours, the compare table, what was not capturable and why). Delete the profile copy
   and the scratch output.

## Where the templates read it

`aieditor/motiontemplates.py check()` decides the kit per overlay (`uikits.for_app(app)`; none → neutral box, logged),
`scene()` puts `uikits.scene_kit(kit)` into the render scene, and the template's `buildKit()` draws it.
