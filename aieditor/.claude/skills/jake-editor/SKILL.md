---
name: jake-editor
description: Jake Dawson's Auto Editor know-how in ONE folder — the RULEBOOK (Jake's rulings + reference rules), the technique catalogue, the lessons, the scoring rubric, the machine numbers (rules.json), the plan/playbook schemas and one proven-action playbook per app. Read by the factory code (aieditor/skill.py, aieditor/playbook.py) and by every prompt that needs the rules; use it whenever planning, recording, judging or repairing an Auto Editor screencast edit.
---

# jake-editor — the editor's rules, numbers and app playbooks

This folder is the single source of truth. There is no other RULEBOOK copy: code and prompts read these
files through `aieditor/skill.py` (`rulebook_text()`, `techniques_text()`, `rubric_text()`, `rules()`,
`playbook(app)`). `AIEDITOR_SKILL_DIR` points the code at another copy (a container sees this folder at
`/a/.claude/skills/jake-editor/`).

## Precedence

**Jake rulings > RULEBOOK > TECHNIQUES > rest.** Jake's rulings are the dated `R…` entries of the RULEBOOK
§11 log and the memory notes they quote; a conflict found is a reviewer ruling written into the RULEBOOK.
rules.json only restates numbers that the RULEBOOK/BASELINE already fix (every group carries `src`); when
they disagree, the RULEBOOK wins and rules.json is the bug.

## Folder map

| File | What it is | Who reads it |
|---|---|---|
| `RULEBOOK.md` | The rules: set dressing (S), content (C1–C7), framing (F), camera moves (M), pacing (P), transitions (T), bubble (B), typing (K), landing/pricing (L1–L4), overlays (X), A-roll (A), rulings log R1–R11, measurement note M1 | the plan call, the judges, the reviewer |
| `TECHNIQUES.md` | Reference technique catalogue (CUT/TR/ZM/PN/HD/SC/CR/BB/TX/HL ids); data twin `aieditor/motion/techniques.json` | the plan call, camera/compose code comments |
| `INSIGHTS.md` | The lessons behind the rules | the offline reviewer/builder |
| `rubric.md` | The D1–D10 scoring rubric (REFERENCE-BASELINE §10, references = 100 %) + the ship rule | the rubric scorer, the judges |
| `rules.json` | Machine numbers (structure, sync, camera, aroll, overlays, narration, coverage, caps, playbooks), each group with `src` | code gates (`skill.rules()`) |
| `schemas/plan.schema.json` | The edit plan: segments → beats (the beat ledger fields), aroll, plates, overlays, `needs_primitive` | the plan call, the plan check, the beat compiler |
| `schemas/playbook.schema.json` | A per-app playbook: start state, set dressing, actions (selectors, pre/post asserts, replays), features, walls, outside_only, private selectors | `aieditor/playbook.py` |
| `playbooks/<app>.json` | One playbook per app (`chatgpt.json` first). An action is usable on camera only when `proven` (replayed 3/3 from a fresh session) | the plan call (closed action list), the recorder |

Production-system background (how the recorder, camera and compose work): `aieditor/screencast/SYSTEM.md`.

## Hard lines (summary; the RULEBOOK has the full text)

- Code records on camera; agents only prepare and repair off camera.
- The plan names only playbook actions; a missing one is `needs_primitive`, never improvised (`rules.json playbooks.allow_unproven = false`).
- Never trim natural pauses or add a cut to the narration (R11).
- Never delete, buy, upgrade, subscribe, publish, share, invite, touch billing or log out (S5, L4, R10); Blue Bottle Coffee is never deleted or renamed, only kept out of frame (C4, R5).
- Pricing/visitor views only in a separate never-logged-in Chrome through a US route (L4, R9, R10); private information is always blurred (C7).
