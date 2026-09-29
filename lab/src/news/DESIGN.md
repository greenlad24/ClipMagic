# AI News Stream — dashboard design (2026-09-28)

## Why it changed
The old dashboard was one long page: header buttons → a log → filters → a
stories list → (far below) a "Presentation" section → a fixed bottom bar that
duplicated half of the header. The daily path (collect → pick → build → go
live) was only discoverable by scrolling, the deck sat under 65 stories, and
drag-to-reorder did not work on an iPad.

## Research, in short
- **Newsroom rundown tools** (iNEWS/ENPS, Cuez, Rundown Studio): a *story
  pool / wire* beside an *ordered rundown*; you move stories from one to the
  other and edit the rundown in place. Both visible at once.
- **Content pipelines / CI UIs**: a numbered stage strip with per-stage status
  and the single next action highlighted; logs are collapsed until needed.
- **Presentation builders** (reveal.js, Pitch, Gamma): the deck is an ordered
  list of sections; "present" is a separate full-screen surface opened from the
  editor, not a page inside it.

Chosen for a solo creator doing a daily live show: stage strip on top, wire +
rundown side by side, presenting stays on its own routes.

## Information architecture
```
NewsShell (top bar)        The Lab / AI News Stream · [mode tabs] ········ Settings · email · sign out
└─ Mode: Daily Show        /news-gatherer/dashboard           (src/news/daily/)
   ├─ Show header          "Daily Show — <Bangkok date>"
   ├─ WorkflowBar          1 Collect news → 2 Pick stories → 3 Build deck → 4 Go live
   │                       (status per step, that step's action, exactly one step marked "next")
   ├─ StoriesPane "News"   collection log · filters · story list
   └─ RundownPane "Selections" build log · ordered slides · Go live card (Start show + other screens)
   └─ SlidePreviewDialog   audience view (light, as on the real screen) + presenter notes
Settings                   /news-gatherer/settings            (same shell)
Presentation surfaces      /news-gatherer/present/{notes,teleprompter,display,audience}
                           — NOT in the shell, untouched, keep their own light palette (useNewsTheme)
```
Wide (≥1024px): the two panes sit side by side and scroll independently under
a fixed header. Narrow (iPad portrait, phone): panes become tabs
(`?pane=stories|rundown`), steps become compact rows, and a sticky bottom bar
carries Build/Rebuild + Start show.

## Styling decision (Jake, 2026-09-28)
The back-office pages (dashboard + Settings) now use **the Lab's dark tokens**
(`src/index.css`, yellow primary) like every other Lab tool, instead of the
app's light palette. The presentation pages are unchanged and still call
`useNewsTheme()` (light `:root.news-theme`). The slide preview renders the
audience card inside `.news-audience-preview` (`daily/audience-preview.css`),
a scoped copy of the light palette on the saved audience background colour,
so the preview still shows what the audience will see. `theme.css` and
`useNewsTheme.ts` were not modified.

## Component map
| File | Role |
|---|---|
| `shell/modes.ts` | Registry of product modes (tabs in the top bar). One entry today. |
| `shell/NewsShell.tsx` | Top bar, mode tabs, Settings link, sign-out, auth gate, tab title. |
| `daily/useDailyShow.ts` | All Daily Show state + every API call (stories, collect, clear cache, toggle, build, slides, star, remove/undo, reorder, start session). |
| `daily/DailyShowPage.tsx` | Layout: header, WorkflowBar, panes, narrow tabs + bottom bar, preview dialog. |
| `daily/WorkflowBar.tsx` | The four steps. |
| `daily/StoriesPane.tsx` / `StoryItem.tsx` | Wire: log, filters, stories, sources. `StoryItem` has an `actions` slot for other modes' per-story actions. |
| `daily/RundownPane.tsx` / `RundownItem.tsx` | Deck: build log, slides, reorder, Go live card. |
| `daily/NotesEditor.tsx` | Presenter-notes form (inline and in the dialog). |
| `daily/SlidePreviewDialog.tsx` | Preview + notes edit. |
| `daily/RunLog.tsx` | Streamed log for collect and build. |
| `components/ArticleView.tsx`, `TweetView.tsx` | Shared with the presentation pages; unchanged. |

Removed (only the old dashboard used them): `components/NavHeader, StoryCard,
SlideRow, SlidePreviewModal, LogsPanel, CollectionProgress, EditNotesInline`.

## Where Deep Dive plugs in (future, NOT built)
"Deep Dive" = pick one topic → generate an animated, scroll/arrow-key driven
presentation website. Adding it is additive:
1. **Mode tab** — append `{ id: 'deep-dive', label: 'Deep Dive', path: '/news-gatherer/deep-dive', icon }`
   to `shell/modes.ts`. The shell renders it; nothing else in the shell changes.
2. **Routes** (App.tsx) — `/news-gatherer/deep-dive` (list + "new deep dive"),
   `/news-gatherer/deep-dive/:id` (outline/section editor, inside `NewsShell`),
   and a full-screen `/news-gatherer/deep-dive/:id/present` *outside* the shell
   (like `present/*`): one section per viewport, ↑/↓ + wheel/scroll-snap step
   between sections, animations per section.
3. **Code** — `src/news/deepdive/` with its own `useDeepDive` hook, pages and
   components, mirroring `src/news/daily/`. Reuse `RunLog` for the generation
   stream (import from `daily/` or lift it to `src/news/components/`).
4. **Entry from the Daily Show** — pass an `actions` element to `StoryItem`
   ("Deep dive" → navigate to `/news-gatherer/deep-dive?story=<id>`), so a
   story from today's wire can seed a deep dive. Topics can also be typed in.
5. **Server** — new handlers in `server/src/news/routes.ts`
   (`createDeepDive`, `getDeepDive(s)`, streamed `generateDeepDive`) and a
   `news_deep_dives` (+ sections) table in `db.ts`, same NDJSON progress
   contract as collect/build.
6. **Shared state** — none needed between modes; each mode owns its hook. The
   only shared things are the shell, auth, the API client and the theme tokens.

## Inventory → new location
| Old element | New location |
|---|---|
| NavHeader: title, News Desk link, Settings icon, sign-out | NewsShell: breadcrumb, "Daily Show" mode tab, Settings, sign-out (+ email) |
| "News Desk — <date>" + counts line | Show header date; counts in step 1 status; selected count in step 2 |
| Refresh / Collecting… | Step 1 "Refresh" ("Collect news" when empty) |
| Clear & Re-collect | Step 1 ghost button (icon-only below xl, tooltip) |
| Collection logs panel (toggle, clear, %, done/error, bar) | StoriesPane `RunLog` "Collection log" (+ last line in header, bar visible while collapsed) |
| Filters All/Verified/Likely/Rumors with counts | StoriesPane chips (+ new "Selected") |
| "Verified = 3+ major outlets" hint | StoriesPane, right of chips (xl) |
| Stories skeleton / "No stories for today yet" + Collect / "No X stories yet" | StoriesPane, same states |
| StoryCard: status badge, score, age, headline, summary, outlets, official blog, Add/In deck, expand sources (blog/major/other links) | StoryItem, same content; toggle reads Add/Added; source count next to chevron |
| Presentation header: N slides · est. min | RundownPane header + step 3 status |
| Start presentation (header) / Start show (bottom bar) | Step 4 "Start show", Go live card, narrow bottom bar |
| Build presentation / Rebuild deck / Building… | Step 3, RundownPane empty state, narrow bottom bar |
| Build logs panel | RundownPane `RunLog` "Build log" |
| SlideRow: drag reorder, number, star, title, meta, Article/Tweet badge, Preview, Edit notes (inline), remove | RundownItem: same, + ↑/↓ buttons (touch), title click = preview, Undo on remove |
| SlidePreviewModal: audience view, presenter notes, Edit notes | SlidePreviewDialog, audience view in its real light palette |
| EditNotesInline (why/points/angle/secs, Save) | NotesEditor (+ Cancel) |
| Sticky bottom bar | Narrow screens only (wide has it in the step bar) |
| (not linked before) Teleprompter / Audience / Display | Go live card → "Other screens" (open in new tab) |
| Keyboard shortcuts | None existed on the dashboard; none added (dialog closes on Esc) |
