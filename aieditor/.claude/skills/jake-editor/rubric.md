# Scoring rubric — the references are the 100 % mark

Source: REFERENCE-BASELINE §10 (gap review 2026-10-09, refs 2–5 = 100 %), adapted by Jake's ruling R11
(2026-10-09): the D9 pause-profile scoring is removed — natural pauses are never trimmed and never scored.
Machine numbers: `rules.json`. Precedence: Jake rulings > RULEBOOK > TECHNIQUES > rest.

Weights: D1 20 · D2 15 · D3 10 · D4 10 · D5 10 · D6 10 · D7 8 · D8 7 · D9 5 · D10 5 (= 100).

**How to score.**
- Score each dimension on the edit's frames with the measurement shown.
- A dimension = 100 × (events that pass) / (events), minus the listed penalties, floored at 0.
- **Overall = the weighted mean, capped at the lowest dimension + 20.** One broken dimension cannot hide behind good ones.
- Every finding names the rule (RULEBOOK § / technique id / Jake point) and the reference evidence (ref + timestamp or spec file).

| # | dimension (weight) | 100 % = reference (measurable) | measurement | penalties / anchors |
|---|---|---|---|---|
| **D1** | **Content match**: the screen shows what he says (20) | Every named UI element, page or result is the framed subject by word + 0.3 s (C1). Every spoken action has its visible result (C2). 0 seconds of an off-topic page (refs: none found in sampled minutes; §2b). | Beat ledger from the words: for each "named thing" or "action" beat, is the right thing on screen? | −15 per wrong page shown for ≥ 1 s (e.g. Library search for "Sketch", Plus pricing for "templates"); −10 per named thing never shown; dropped planned screencast seconds count as fails. 50 = half the beats right. |
| **D2** | **Sync / timing** (15) | Move start −0.9…0 s before the naming word (inside its clause), landing ≤ +0.3 s. Action result +0.2…+1.4 s after the action word (median +0.7). Screen↔face cuts within 0.6 s of a sentence start for ≥ 80 % of them, picture ~0.1 s ahead. | Offsets per event in seconds | Each event outside its band fails; > 2 s late or any action shown before it is spoken = −10 each. |
| **D3** | **Screen cleanliness / set dressing** (10) | Dark theme for chat apps, fresh chat, sidebar collapsed, empty fields, own content only (§3, RULEBOOK §S). No popups, toasts or suggestion lists. White or loading flashes ≤ 0.7 s (JAKE C5: none). | Per-second scan | −10 per transient UI or foreign-content second; −5 per loading flash; −20 for any credentials, billing or unrelated account page. |
| **D4** | **Waits and generations** (10) | "Generate" → time-skip dissolve 3–8 f at +0.5…+0.8 s to the finished result, framed (G1, G5, G6). The in-progress state is shown only while he talks about the wait (≤ 6 s, G3, G4). No blank waits and no speed-ramps. | Per generation beat | Any visible wait > 6 s or a wait shown with no narration about it = fail; a result not shown = fail. |
| **D5** | **Framing and zoom** (10) | Zoom levels by target class (§4 / F3). Subject centre within 0.06 W / 0.08 H (JAKE F1; refs median 0.05–0.10 W). Time zoomed 62–80 %. Typing at ×1.0. | Per move landing | Each landing outside tolerance fails; whole-canvas design shot (F4) = −10. |
| **D6** | **Camera motion and holds** (10) | 17–25 (≤ 30) motion events per screencast minute. No still stretch > 3 s (refs p50 0.8–1.4 s). Moves 34–48 f on the ref curves, pans for nearby targets, no twitches or whips (M7). | Per screencast minute + per move | Each still > 3 s fails; a minute outside 17–30 events = −10; twitch or whip −5 each. |
| **D7** | **Structure and pacing** (8) | Screencast 72–76 % (≥ 68 %), A-roll 22–27 %, plates ≤ 1.5 % and only in the hook. Screencast spans p50 10–18 s, A-roll blocks p50 5–6.5 s, 3–6 boundaries per minute. | Whole video from blocks + frames | −10 per 5 points of share outside the band; −10 if span or block medians are outside the band. |
| **D8** | **Transitions** (7) | Screen↔face: JAKE 4 f bubble fade + 4 f dissolve (refs 99 % hard, never a scale pop). In-app: hard 1 f with the zoom carried. New world or time skip: 3–8 f dissolve with the zoom held, then a pan or release within 0–6 f. Open TR07, end TR08. | Per boundary | Each wrong type or length fails; a double cut or a 1-frame flash = −10. |
| **D9** | **Narration integrity and A-roll** (5) | 0 spoken words removed that Jake did not approve (JAKE). Natural pauses are NOT scored: they stay as recorded (≤ 0.70 s, RULEBOOK R11), and no finding or remedy may propose a pause cut or a new cut in the narration. Visible A-roll jump cuts (from the approved takes only) about half masked by a ×1.3–1.5 framing change (A2/CUT07, see M1). A-roll push 1–3 %/s capped at ×1.12–1.16, starting at ×1.0. | Word diff vs the approved source + A-roll frames | −10 per unapproved word or sentence deletion; −5 per same-framing jump cut left unmasked when CUT07 is enabled. |
| **D10** | **Overlays and bubble** (5) | 7–9 overlays per video (0.5–0.7 per minute), 3–5 in the first 80 s, ≤ 0.2 per minute mid-video, 3–4 in the outro, all over A-roll, on the gradient, on the word. 0 boxes, arrows or ripples over a screencast. Motion templates (X4–X6): hook only, ≤ 2, beats on their words, prompt boxes in the real app's UI kit (or the logged neutral box), a MO05 result only when REAL. Bubble fixed at (1701.9, 253.7) Ø 358.6, hidden only during a click or type under it (B2). | Per overlay / per bubble event | Overlay on a screencast −10; overlay off its word by > 0.3 s −5; a motion template outside the hook −10; a prompt box in another app's UI or an invented result −20; bubble hidden without a click under it −5 per event. |

**Score anchors for every dimension:**
- **100:** indistinguishable from refs 2–5 at 1 fps and on the strips.
- **80:** a few events slightly outside the bands, nothing a viewer would notice.
- **50:** recurring misses a viewer notices (wrong timing, a wrong page, long holds).
- **20:** the dimension is mostly wrong.
- **0:** absent or contradicting the reference.

## Ship rule (a video that fails it is "held", never shipped quietly)

A video ships only when ALL of these hold:
1. every dimension D1–D10 ≥ `ship.threshold` × 100 (rules.json; default **0.80**, pending Jake decision 2 — 0.80 or 0.90);
2. content (D1) and sync (D2) ≥ 80 whatever the threshold;
3. no critical finding;
4. 0 narration words removed without approval;
5. 0 legible private frames (RULEBOOK C7).

The overall score (weighted mean, capped at the lowest dimension + 20) is reported, but it never overrides
a failed line above. A held video lists its failures in the Lab; the fixed remedy table (code) runs at most
2 automatic rounds and never proposes trimming a pause or adding a cut to the narration (R11).

## Judges

A model judge may pass or hold a video only after calibration: it reproduces the gap review's per-second
human verdicts (880 s) within ±10 points and scores Jake's own reference videos ≥ 95. Motion, sync, framing,
transitions, structure and narration integrity are measured by code; content, cleanliness and waits are
judged (Haiku yes/no per beat → Sonnet on disagreement → Opus confirms flagged items).
