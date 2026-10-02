# Deal Organizer — Lab port (2026-09-30)

Port of the Zite app "Deal Pipeline Kanban" (UI name **Deal Organizer**), source in
`/data/imports/dealorg/apps/deal-pipeline-kanban/src/`. Phase 1 = the original
screens and behaviour; phase 2 (below) fixed the spec's frontend bug list (§7).

## Layout
```
routes.tsx            dealOrganizerRoutes — one line in App.tsx: {dealOrganizerRoutes}
DealOrganizerRoot     ThemeProvider → StageLabelsProvider → AppLayout (orange hover sidebar + mobile tab bar)
  /deal-organizer               pages/HomePage       AI chat, modes A–D   (was /home)
  /deal-organizer/deals[/:id]   pages/DealsPage      kanban + full-screen deal workspace
  /deal-organizer/deadlines     pages/DeadlinesPage  production pipeline
  /deal-organizer/emails        pages/EmailsPage
  /deal-organizer/analytics     pages/AnalyticsPage
  /deal-organizer/agent         pages/AgentPage      NEW — sponsorship email agent
  /deal-organizer/settings      pages/SettingsPage   incl. components/ConnectionsSection
  /deal-organizer/connections   SettingsPage scrolled to Connections (Gmail OAuth returns here)
api.ts / apiTypes.ts  call(fn) → POST /api/deals/<fn>; streamingCall for NDJSON. apiTypes.ts is
                      GENERATED from the original endpoints' zod schemas (same names/shapes).
auth.ts               /api/auth/me instead of zitejs/auth
theme.css, mobile.css the original index.css / mobile.css, scoped (see Theme)
ui/                   original shadcn primitives + stand-ins for libraries the Lab lacks
```

## Theme
Zite's own look (orange #FF7420, original light/dark hex palette, stage colours).
**Dark by default**; the toggle is kept (localStorage `deal-organizer-theme`, try/catch).
Tokens are keyed on classes the root puts on `<html>` while mounted —
`:root.dealorg` (light) and `:root.dealorg.dealorg-dark` — so portalled dialogs,
sheets and menus match, and the rest of the Lab is untouched after leaving.
The Lab keeps `class="dark"` on `<html>` permanently, so the original's few
`dark:` utilities were rewritten as `[.dealorg-dark_&]:` (they were inert in Zite).

## Never sends email
`sendReply` / `sendFollowUp` save Gmail DRAFTS server-side and return
`{ draftId, gmailUrl, savedAsDraft }`. Every Send button reads "Save as Gmail draft";
success shows a toast with "Open in Gmail" (`lib/draftToast.ts`).

## Stand-ins (packages not installed in the Lab)
| Original | Here |
|---|---|
| framer-motion | `ui/motion.tsx` — CSS-transition enter/animate/hover; no exit, height:auto or layoutId animation |
| recharts | `ui/charts.tsx` — SVG subset (Bar/Composed/Line charts, axes, grid, tooltip, legend) |
| react-markdown + remark-gfm + @tailwindcss/typography | `ui/markdown.tsx` + `ui/markdown.css` |
| @radix-ui/react-popover, -tooltip, -dropdown-menu | `ui/floating.tsx` (re-exported as popover/tooltip/dropdown-menu) |
| @radix-ui/react-scroll-area | `ui/scroll-area.tsx` — native overflow |
| zitejs/upload | `zite-file-upload-sdk` (the Lab's upload shim) |
| zitejs/auth | `auth.ts` |

## Bug-fix pass (2026-09-30) — where things live now
| Concern | Module |
|---|---|
| Kanban DnD, mouse (HTML5, per-column drop targets) + touch (long-press, ghost, edge auto-scroll) | `lib/boardDnd.ts` (`useBoardDnd`), used by DealsPage + DeadlinesPage via `KanbanColumn dnd=` |
| ⌘K / Ctrl+K → page search | `lib/useSearchHotkey.ts` |
| Esc only closes the TOP overlay (merge modal over workspace) | `lib/escapeLayer.ts` (`useEscapeLayer`) |
| Deadlines: FREE TEXT (inline, as typed) + parsed-date chip; server parses to `deadline_date` | `components/DeadlineEditor.tsx`, `lib/deadline.ts`; server `deadlineParse.ts` |
| Money in the deal's currency | `lib/currency.ts` |
| Archive + Undo toast | `lib/archive.ts` |
| Card + to-dos fill themselves from the email thread(s) | server `dealAutofill.ts` (via `dealFields.ts`) |
| Attachment download + PDF preview (Files & threads, Links & Media, viewer) | `lib/attachments.ts` |
| Deal "Files & threads" (all related threads' files, doc links, thread links; 📎 board badge) | `components/DealFilesSection.tsx`, `apiFiles.ts` (server `dealFiles.ts` / `handlersFiles.ts`) |
| ONE Gmail sync (server job; "Sync now"; last/next indicator; reload on finish) | `context/SyncContext.tsx`, `components/SyncControls.tsx` (`getSyncStatus` / `runSyncNow`) |
| Live stage helpers (`allStageKeys`, `isProductionStage`, `resolveStageKey`) | `context/StageLabelsContext.tsx` |

Rules: every field edit in the deal workspace goes through `DealDrawer.handleFieldUpdate`
(one write; a stage change sets `in_production` like a board move). No page starts a Gmail
scan/sync or AI extraction on load. Toasts: the Lab's one `<Toaster>` is restyled by
`theme.css` while `:root.dealorg` is set (a second Toaster would double every toast).
To-dos have no delete endpoint, so the UI offers done/undo only.

## Files & threads (2026-09-30)
A deal owns MANY threads (`deals_deal_threads`, matched_by source | manual | contact |
domain+brand | platform; unlinks go to `deals_deal_thread_exclusions`). Resolved in SQL on
read — never a Gmail call on open; only "Check Gmail for missing files" reads Gmail
(≤1 threads.list + ≤10 threads.get). Brand guard: a thread whose brand differs from the
deal's (agencies pitch many brands) is never auto-attached. The Emails page's
`linkThreadToDeal` writes the same table. `LinksMediaSection` now only shows links from the
deal's own notes/comments/to-dos.


## Card autofill + free-text deadlines (2026-09-30)
Jake: "I prefer free text [for deadlines] that is analyzed by AI after" and "I never want
to manually add details to cards — all of it should be automatic based on the email thread".

- **Deadline** = free text, saved exactly as typed (`deal.deadline`). The server parses it
  into `deal.deadline_date` (YYYY-MM-DD; `deadline_parsed_from` = the text it came from):
  rules first (`server/src/deals/deadlineParse.ts`), a fast-tier Claude call only when
  ambiguous, anchored to today in Asia/Bangkok. Pages sort / group / count down on the
  date (`lib/deadline.ts dealDeadlineYmd`), and show the text as the label. A deadline is
  a "by" date: bare month → last day, early → 10th, mid → 15th, late → last day.
- **Card fields** (deadline, next steps, key details, contact info, opportunity/about when
  empty, value + currency) and the **to-do list** are kept current by the same Sonnet call
  that fills the analytics fields, in the central sync: every deal whose thread(s) got a new
  email (or changed stage) is re-read (≤ 40 a run). "from email · <date>" marks a field the
  autofill wrote; a to-do it added/ticked says "from email".
- **Human edits win**: a field saved through `updateDeal` is `fields_source[key] = "human"`
  and never rewritten; a to-do status Jake sets (`status_by = 'human'`) is never changed.
- No "Add default to-dos" / "Generate" buttons and no "+ Add …" prompts: everything stays
  editable, nothing asks.
