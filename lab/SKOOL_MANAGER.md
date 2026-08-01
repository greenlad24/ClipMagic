# Skool Manager — the editor dictionary and the rebuild

Everything the tool knows about driving Skool, in one place. Written 2026-07-31
because it had been living only in code comments and database rows, which is not
somewhere you can look.

Skool has **no API at all**. Every read and every write is a headless Chromium
session against the real site.

---

## 1. The dictionary

Jake demonstrated each action once in the teach console; the recordings are in
the `skool_recipes` table. They are **not replayed** — a literal replay encodes
indices that move, one specific target, and the operator's own misclicks. What
follows is what they proved, which is what `skool/actions.ts` implements.

### The handles

| Thing | How to find it |
|---|---|
| Save a page | `button` whose text is **`SAVE`** — uppercase |
| Confirm an attached video | `button` whose text is **`Add`** — a *different* control; it does not save the page |
| Add a page | the course 3-dots menu, item **`Add page`** (`dropdown-item-0`) |
| Video URL field | `data-testid="add-video-input"` — the only usefully-named input |
| Every other input | `data-testid="input-component"` on all of them, so match by **placeholder** (`Course name`, `Course description`, `Name`, `Title`) |
| The 3-dots itself | `button.sc-9634fac0-9`, but *which* one is positional — resolve as "the icon button inside the card named X" |
| Editor-is-open landmark | a div reading `15:44ADDPublishedCANCELSAVE` (the toolbar, run together). A landmark, never a click target |
| "New course" | the last tile on the **last** grid page, a plain `div` |

### The rules that make it survive a reorder

1. **Menu items by TEXT, never by `dropdown-item-N`.** Proof from the recordings
   themselves: `Delete` is `dropdown-item-6` in a page's menu and
   `dropdown-item-3` in a folder's. The index belongs to the menu, not the action.
2. **Find controls by computed `cursor: pointer`, not by tag.** Skool's controls
   are plain divs with click handlers — no `role`, no `<button>`, class names are
   styled-components build hashes. A probe asking for `button, a[href], [role=button]`
   reported this classroom had no admin UI at all, and that was wrong.
3. **Real mouse only** — `page.mouse.click`, never `element.click()`. The menus are
   built on pointer events and a synthetic click does nothing at all. Same for
   hover: `page.mouse.move`, then wait.
4. **Finding a card by title lands on the title, not the card.** The smallest
   element containing the text is a one-line div whose box excludes the thumbnail
   the 3-dots sits on. Climb ancestors until height ≥ 200.
5. **Text matching is exact after normalising.** "Contains" matches half the page —
   Skool runs a card's title, description and progress together into one string.
6. **⌘ is `Control`.** The remote browser is Linux; a literal `Meta+A` does nothing,
   silently.
7. Buttons vary in case (`SAVE` / `Save` / `Add`); deletes need a second confirming click.

### Writing one page, end to end

    open the course 3-dots → "Add page" → title field → add-video-input + "Add"
      → body → SAVE

---

## 2. Reading the classroom

Skool is a Next.js app and ships its whole page state as JSON in `__NEXT_DATA__`,
so **reads need no DOM scraping**. Writes still need the DOM.

Three traps, each of which cost a debug cycle:

- The signed-in user is **`pageProps.self`**, not `currentUser`.
- **Every node in a course tree is a wrapper**: `{course: {...fields}, children: []}`.
  Reading `node.metadata.title` gives a correctly-shaped tree of entirely blank
  units — right count, right depth, no data. Unwrap `node.course` first.
- **`allCourses` is ONE PAGE of 30**, despite the name. A 60-course community read
  as exactly 30 with no error and no truncation flag. The only tell was
  `currentGroup.metadata.numCourses`. The reader now walks `?p=N` and reconciles
  against that count, erroring rather than returning a plausible short list.

**A course tree's root node looks like a lesson.** It sits in `units` with the
course's title and a `content` (the card blurb, 50–150 chars), so any "does this
carry anything?" filter says yes. Counting it as a lesson is off by one per
course — which is exactly how the rebuild once concluded that 58 of 60 courses
still held an unplaced lesson. `isCourseRootUnit` / `unitCarriesContent` in
`skool/classroom.ts` are the single definition; both halves import them.

---

## 3. The plan

`skool_plans` #4, built 2026-07-30: **15 courses, 136 lessons, all 136 authored.**
Six of the courses are Jake's, specified by name and stored in
`skool_settings.required_tracks_json`; the planner designed the other nine around
them and is forbidden to drop or rename them.

The atom is a **unit, not a course**: 55 of the 60 old courses are a single video
in a wrapper, so "course" was never a unit of curriculum here. The 60 empty
modules simply cease to exist — nothing is moved out of them because nothing was
in them.

---

## 4. Running a rebuild

`buildRebuild` (pure, no I/O) turns the plan into an ordered op list:
**15 creates → 136 pages → 60 deletes.** Every op re-reads the live classroom
before acting, so a half-finished run is resumable and a repeat is a no-op rather
than a duplicate.

- **⚠️ DO NOT RUN THE DELETES. Jake removes the old courses himself** (2026-07-31).
  They are still computed, because that is how the plan proves every lesson was
  absorbed, but the tool never executes them.
- **⚠️ One browser, one profile, strictly sequential.** The Lab UI is a competitor,
  not a bystander: with the Skool Manager page open its status poll contends with a
  running write. Measured 2026-07-31 — a page write took 471s and failed on its last
  step while the status call took 187s and reported `loggedIn: false /
  "Browser unavailable"`. **A UI that says logged-out during a run is not evidence
  the session died.** Close the tab before writing.
- Never create an empty page. A page with no video and a body under 200 chars is
  refused, because 60 of this classroom's 123 modules are already a title and
  nothing else, and that is the defect the rebuild exists to fix.

### Driving it

`POST /api/fn/skoolPlanRebuild` and `/api/fn/skoolRunRebuildOp` (`{"opId": "..."}`).
Both are gated by Google sign-in, with a **loopback exemption for three named
endpoints only** (`auth/middleware.ts` → `LOOPBACK_FN_EXACT`) so an in-container
process can drive the run while there is no UI for it. Not the whole `/api/fn`
route: that dispatcher also carries `updatePostizSettings`, which takes write-only
secrets. **When the runner UI lands, that list should shrink back to nothing.**

---

## 5. Cost

The rebuild spends **nothing** — it reads a stored plan and drives a browser. Only
planning and lesson authoring call a model, and those calls carry
`auth: "subscription"`, so they bill Jake's Claude Max plan via
`ANTHROPIC_SUBSCRIPTION_TOKEN` rather than API credits, with no fallback: a missing
or expired token fails the call rather than quietly spending money.
