# The self-healing layer (Auto Editor)

Jake, 2026-10-11: *"I want to fix it for all future videos so we don't do these sessions again and it can edit any
kind of video with screencasts at a high level"* — *"this needs to be the one layer that solves all of those issues
from before for all present and future test or real rounds."*

One layer, four failure classes. Each is **detected cheaply before the expensive stage**, **repaired as data** (this
video's playbook / start state / assets / route) or **degraded gracefully** (an approved motion template, logged),
and **pinned by a regression test**.

| class | what | detector (before the expensive stage) | repair |
|---|---|---|---|
| A | app UI drift | `preflight.RecordingPreflight` — every screencast rehearsed off camera before recording, failures clustered; the same reason on ≥ 2 screencasts = systematic | `drift.Repairer` (capped Opus loop: observe / find / count / act, click guard, no generation, never Jake's chats or Library) decides resting UI → `start_state.allow`, new popup → `start_state.dismiss`, moved control → re-onboarded, real problem → nothing accepted; every fix proven on 2 screencasts, else reverted |
| B | asset fidelity | `preflight.audit_asset` (pure code) before any stored picture is reused (`onboard.reuse_ok`) | set aside (renamed, never deleted) → made again by the producer |
| C | onboarding / proof gaps | `preflight.audit_playbook`, the replay rules in `playbook.py` (points / strokes as data, after-reply waits, idempotent mode steps), `onboard_action` (chains, presence proofs, chat rotation, a drifted required step) | data in this video's playbook |
| D | run control | `preflight.headroom` (the Claude cap must fit routing before it starts), route/cap rules, finish mode | wait / held 'API cap' before starting; `preflight.fallbacks` — never a silent drop |

**Where the data lives.** `job/preprod/playbook-<app>.json` (this video's playbook). `start_state.allow` =
`{resting_texts, resting_selectors, resting_popups, walls, reasons, learned[]}`; `start_state.dismiss` = click/key
steps; `outside_view.allow` for the never-logged-in page (its login view is always allowed). The rules that protect
Jake (`screencast/first_frame.py` `SAFE_RX`: his account, Chat mode, empty composer, hidden sidebar, no challenge)
can never be allowed away. The shared skill playbook is only a hint and is never written by a job.

**Reports.** `edit-NN/preflight.json` (results, clusters, repairs + proofs), `edit-NN/fallbacks.json` (every
screencast that fell back, and to what), `warnings.json` → `fallbacks` in finish mode, `preprod/set-aside.jsonl`.
Switch the recording preflight off with `AIEDITOR_PREFLIGHT=0`.

## Weekly canary (per app)

`bin/aieditor-canary enqueue chatgpt` queues a small job (`jobs/canary-chatgpt-<date>`, action `edit`,
`request.canary`) that the worker sends to a factory server (account lock, profile copy, the US route as for any
logged-in job). It exercises one example of each class — **A** the preflight of 3 start states (home, an image chat,
the logged-out US pricing page) with the drift agent; **B** image production in the app's UI (Create image, an edit
with an upload, Remove BG on the picture — at most 3 generations) + the asset audit; **C** a replay of the newest
learned actions (refreshes the 7-day recent-proofs ledger) + the playbook audit; **D** the cap headroom check and
ONE 5-second screencast recording. Capped at $1.50 Claude. It writes `canary-report.json` in its job folder; the Lab's
Video factory panel shows the newest one as a status line.

The timer is shipped **disabled** (`bin/aieditor-canary.service` / `.timer`, Mondays 02:00 UTC). To enable:

```
sudo cp /opt/clipmagic/aieditor/bin/aieditor-canary.service /opt/clipmagic/aieditor/bin/aieditor-canary.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aieditor-canary.timer
systemctl list-timers aieditor-canary.timer      # next run
```
Run one now: `python3 /opt/clipmagic/aieditor/bin/aieditor-canary enqueue chatgpt`.

## Coverage — every past failure → class → detector → repair → test

Regenerate the table: `python3 -c 'from aieditor import preflight; preflight.write_doc()'` (tests/test_selfheal.py
fails when it is out of date, or when a row's test does not exist).

| id | when | class | past failure | detector | repair | test |
|---|---|---|---|---|---|---|
| A-home-suggestions | 2026-10-11 re-run 14 | A | ChatGPT's new home-page suggestions under the composer failed the first frame on every screencast | RecordingPreflight (first frame per start state, clustered: >= 2 screencasts) | drift.Repairer → resting_ui: start_state.allow.resting_texts / resting_selectors (data), proven on 2 | tests/test_selfheal.py::A-home-suggestions |
| A-outside-login-view | 2026-10-11 re-run 14 | A | the logged-out US pricing page (Log in / Sign up) was called a login wall | first_frame.allowed (walls) + beatscript outside start_state | outside_view.allow.walls = login (default) | tests/test_selfheal.py::A-outside-login-view |
| A-safe-rules | standing | A | an allowance must never accept another account, Work mode, a draft, the sidebar or a challenge | first_frame.SAFE_RX | refused by code whatever the agent says | tests/test_selfheal.py::A-safe-rules |
| A-new-popup | class | A | a new popup / banner on the start page | RecordingPreflight cluster | drift.Repairer → dismiss: start_state.dismiss steps (click guard), proven on 2 | tests/test_selfheal.py::A-new-popup |
| A-moved-control | class | A | a playbook control moved / was renamed (no element on every screencast) | RecordingPreflight (dry beats), cluster | drift.Repairer → moved_control → the action re-onboarded | tests/test_selfheal.py::A-moved-control |
| A-real-problem | class | A | a real fault (challenge / another account) must not be accepted | RecordingPreflight cluster | real_problem → nothing accepted; motion-template fallback, logged | tests/test_selfheal.py::A-real-problem |
| A-chat-wont-load | 2026-10-11 02:01 re-run 13 | A | the source chat grew too big: 'Could not load this conversation' on every proof | onboard_action (start_state: no element / could not load) | the next round starts from another chat this job created | tests/test_selfheal.py::A-chat-wont-load |
| A-library | 2026-10-10 23:46 | A | the readiness check opened Jake's own Library | readiness without the Library (AIEDITOR_READINESS_LIBRARY) | the toolbar comes from the proven playbook | tests/test_selfheal.py::A-library |
| B-verbatim | 2026-10-10 22:42 / 23:00 / 23:15 | B | his on-screen prompt was replaced by an internal / rewritten prompt ('a glass') | audit_asset (verbatim) + onboard.onscreen_prompt | set aside → made again with his words verbatim | tests/test_selfheal.py::B-verbatim |
| B-object-list | 2026-10-10 23:00 | B | the manifest's object-list prompt ('…with a glass clearly visible…') was typed | audit_asset (internal / object list) | set aside | tests/test_selfheal.py::B-object-list |
| B-one-line | 2026-10-10 23:15 | B | a newline in a typed prompt sent it early | audit_asset (newline in a prompt) | typed prompts are one line (onboard.verbatim_plus) | tests/test_selfheal.py::B-one-line |
| B-merge-sources | 2026-10-10 23:31 / 23:50 / 00:05 | B | a 3-photo merge was one edit / an invented collage; its sources were never made | audit_asset (a merge with < 2 sources) | set aside → sources made first (source_inputs) | tests/test_selfheal.py::B-merge-sources |
| B-collage | 2026-10-11 00:05 | B | a prompt asked for a fake collage / app interface | audit_asset (chrome words) | set aside | tests/test_selfheal.py::B-collage |
| B-input-result-prompt | 2026-10-10 23:37 | B | an input photo he brings was made with his RESULT prompt | audit_asset (input + on-screen prompt) | set aside | tests/test_fidelity.py::input photo never |
| B-wrong-source | 2026-10-10 23:31 | B | 'restore this old photo' ran on the hot-sauce photo (the prior picture taken as source) | the source step decides (prior picture = hint) | source_inputs | tests/test_fidelity.py::hint |
| B-tool-not-tool | 2026-10-11 00:58 / 01:42 | B | a tool result was a described edit / a new picture, not the app's tool on the source | audit_asset (tool result not via the tool, or no source) | set aside → the tool route | tests/test_selfheal.py::B-tool-not-tool |
| B-overlay-hidden | 2026-10-11 01:42 re-run 12 | B | Remove BG's real cutout in the viewer overlay was misread as a text reply 6x | producer: overlay_close (data per app) | the overlay is closed after the tool's press | tests/test_selfheal.py::B-overlay-hidden |
| B-wrong-tool | 2026-10-11 02:12 re-run 13 | B | 'Resize result: same bottle cutout' picked Remove BG | producer.tool_of (named first) + audit_asset | set aside | tests/test_selfheal.py::B-wrong-tool |
| B-target-clause | 2026-10-11 08:29 re-run 15 | B | the erase brush target was a narration clause ('… and click send') → a need with Send in it | onboard.object_phrase / clean_tool_params | the object only; a proven step reused | tests/test_selfheal.py::B-target-clause |
| B-duplicate-asset | 2026-10-11 00:38 | B | a source the job already had was made again under a new name ('person_photo') | the source step knows every checked picture | reused | tests/test_selfheal.py::B-duplicate-asset |
| C-points-text | 2026-10-11 00:22 re-run 9 | C | the agent's drag points arrived as text: 'drag needs from/to [x, y]' | onboard.norm_points | normalized to numbers | tests/test_selfheal.py::C-points-text |
| C-undeclared-points | 2026-10-11 00:42-01:23 | C | an onboarded drag's points (on the action / undeclared params) were dropped by the replay | audit_playbook (drag without points) | playbook.resolve reads every spelling; neutral centre box | tests/test_selfheal.py::C-undeclared-points |
| C-strokes | 2026-10-11 02:26 re-run 13 | C | stroke tools drew nothing ('Undo never enabled') | audit_playbook (draw without strokes) | stroke data passes the replay; the proof draws one sample stroke | tests/test_selfheal.py::C-strokes |
| C-chained-requires | 2026-10-11 08:12 re-run 14 | C | a tool's later step was proven without the steps that make its control exist | onboard_action(chain=…) | each step requires the tool's earlier steps | tests/test_selfheal.py::C-chained-requires |
| C-confirm-presence | 2026-10-11 02:41 re-run 13 | C | a confirm after a stroke (Sketch's check mark) pressed on an empty canvas | _CONFIRM_RX after a stroke | proven by presence | tests/test_selfheal.py::C-confirm-presence |
| C-no-such-step | 2026-10-11 01:56 re-run 13 | C | Markup has no note box; the guessed step did not exist | onboarding answers 'absent' | a tool text step goes to the app's prompt action | tests/test_selfheal.py::C-no-such-step |
| C-guessed-flow | 2026-10-11 02:21 re-run 13 | C | the Logo template flow was guessed (paste + send) | audit_playbook (tool steps) | tool steps are needs the agent learns live | tests/test_selfheal.py::C-guessed-flow |
| C-after-reply | 2026-10-11 08:38 re-run 15 | C | the Logo name card appears only after ChatGPT's reply: 'pre: no element' on every proof | playbook._poll_pre (busy page) / onboard_action | after_reply (data): the pre check waits up to 30 s | tests/test_selfheal.py::C-after-reply |
| C-then-skip | 2026-10-11 08:38 re-run 15 | C | the Logo flow asks 3 questions (1 of 3) | tool step data | then_skip: the rest are skipped | tests/test_selfheal.py::C-then-skip |
| C-requires-param | 2026-10-11 08:18 re-run 14 | C | a required step that could not be built ("param 'text' is required") crashed pre-production | audit_playbook (requires that cannot be built) | a failed step, never a crash | tests/test_selfheal.py::C-requires-param |
| D-cap-mid-route | 2026-10-11 01:02 / 01:04 re-run 11 | D | the Claude API cap refused calls during routing → 'needs_primitive' / half-routed | headroom (before routing) + llm.refusals during routing | daily → wait; job → held 'API cap' | tests/test_selfheal.py::D-cap-mid-route |
| D-cap-mid-assets | 2026-10-10 22:45 | D | the daily cap hit mid-assets and the job went on recording half-done | preprod.run re-raises BudgetExceeded | the job waits for the window | tests/test_selfheal.py::D-cap-mid-assets |
| D-playbook-crash | 2026-10-11 08:18 re-run 14 | D | a PlaybookError in a tool's requires ended pre-production | producer requires try/except | ui_step_failed (a failed try) | tests/test_selfheal.py::D-playbook-crash |
| D-assets-kept | 2026-10-11 08:18 re-run 14 | D | assets.json was lost when routing stopped | route in try/finally | assets.json written | tests/test_selfheal.py::D-assets-kept |
| D-status-line | 2026-10-11 02:31 / 07:50 | D | the status line froze on the last asset while P2/P4 ran | status per need / round | 'Learning: … (round n/3)' | tests/test_selfheal.py::D-status-line |
| C-draw-no-strokes | 2026-10-11 re-run 15 | C | the Sketch check mark's proof failed 'requires ob_sketch_draw_strokes: draw needs strokes' | playbook.resolve (draw) | no strokes anywhere → one sample stroke | tests/test_selfheal.py::C-draw-no-strokes |
| C-idempotent-mode | 2026-10-11 08:58 re-run 15 (and 2026-10-09) | C | the viewer was ALREADY in Markup mode from the previous proof round; pressing text=Markup again hit the composer's 'Markup' chip / toggled it off → "requires viewer_markup: post: no element Cancel markup" | playbook.already (a click / key step whose post already holds) | the press is skipped, logged 'state already reached' (replay, producer requires) | tests/test_selfheal.py::C-idempotent-mode |
| C-round-leak | 2026-10-11 09:02 re-run 15 | C | proof rounds leaked state: round 1's stroke left Markup mode on and a 'Markup' chip in the composer; round 3 failed "pre: button[aria-label='Remove markup'] still present" | every proof round | teardown (data) + Session.reset (Escape, dismiss steps, the draft's chips) after/before each round; 'still present' → another job chat | tests/test_selfheal.py::C-round-leak |
| D-prereq-failed | 2026-10-11 09:04 re-run 15 | D | a step whose prerequisite (viewer_markup) had already failed spent 3 more rounds + a new chat | onboard.failed_prereq (this run) | one self-repair of the prerequisite; then every dependent step is skipped straight to its fallback, logged | tests/test_selfheal.py::D-prereq-failed |
| A-required-step-drift | 2026-10-11 re-run 15 | A | every Markup-stroke proof failed inside a REQUIRED step: "requires viewer_markup: post: no element button[aria-label='Cancel markup']" (its post assert drifted) | onboard_action: all replays fail inside the same required step | that step re-proven for this video (re-onboarded as data when it no longer replays), then the proof again | tests/test_selfheal.py::A-required-step-drift |
| D-finish-mode | 2026-10-11 07:20 | D | a test run must end in a finished edit | request finish_video | holds → warnings.json; every fallback listed | tests/test_selfheal.py::D-finish-mode |
| D-camera-as-feature | 2026-10-11 08:48 re-run 15 | D | 'Close on the bottle's label' (a beat that only frames, camera.zoom) was routed to P4 as a missing feature | onboard.is_camera_need (FRAMES_RX on the plan-check line) before the C route | D: the edit's zoom on the picture on screen — no feature, no motion graphic | tests/test_selfheal.py::D-camera-as-feature |
| D-silent-drop | class | D | a screencast that fails after preflight + repair was dropped to the presenter silently | fallback_events after record_all | an approved motion template (real result if any), logged | tests/test_selfheal.py::D-silent-drop |
