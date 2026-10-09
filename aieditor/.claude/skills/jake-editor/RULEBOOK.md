# Auto Editor screencast RULEBOOK (v1, 2026-10-08)

See also INSIGHTS.md (the 28 lessons behind these rules).

Written and owned by the reviewing session. The builder follows it literally; the reviewer judges against it.
Every rule has: **trigger → required result (numbers + tolerance) → source → how it is verified on the rendered frames.**
All pixel values are at the 1920×1080 OUTPUT frame. `f` = frames at 29.97 fps. "Word time" = the narration word's start in output time (aligned.json mapped through edl.json).

## 0. Precedence and stop condition
1. Jake's own rulings (memory `auto-editor-screencast-review-1`, `auto-editor-self-review-loop`) > this rulebook > TECHNIQUES.md/techniques.json (reference-derived) > anything else. A conflict found = a reviewer ruling, written here.
2. A round PASSES only when every event in the reviewer's event ledger matches its rule (trigger + numbers within tolerance). "Mostly" is a fail.
3. A builder claim counts only with a measured number from the frames (verify.json). Recorder logs are never evidence.

## S. Set dressing (before ANY recording) — Jake 2026-10-08
Before the first recorded frame, an agent works hands-on in the demoed software (UX Scout logged-in profile copy) so the project looks neat and professional on camera:
| # | Rule | Verify |
|---|---|---|
| S1 | Results/designs are arranged in a tidy, evenly spaced, centred group in the order the narration names them (e.g. one row or 2×N grid), mid-canvas, nothing overlapping | reviewer: first canvas frame — even gaps (±10 %), order = narration order |
| S2 | Items the narration names have clean, readable names (no "Untitled", no test junk); the right document/view/brand is open and selected | page title / selection detection |
| S3 | Fields and drafts are empty, panels and pop-ups closed, notifications dismissed | first-frame check (C3, C5) |
| S4 | Unwanted/foreign items stay out of every shown view (e.g. Blue Bottle Coffee — never deleted or renamed, only kept out of frame: different view, filter, sort, scroll position) | C4 |
| S5 | Allowed: moving, sorting, renaming new items, creating/generating new items, changing views. Forbidden: deleting, buying, publishing, sharing, inviting, billing/security changes, renaming/deleting pre-existing items Jake didn't create for the demo | set-dressing log |
| S6 | Every change is logged (what, where, before→after) in set_dressing.json for the reviewer | file exists |
| S7 | App theme per Jake: **ChatGPT screencasts are recorded in DARK theme** (recorder AGENT_DARK=1 / dark=True); ChatGPT opens in "Chat" mode (not "Work") for the image tutorial; start each recording in a fresh chat with the sidebar's old chats out of frame (never deleted) | first-frame check |

## 1. Content: the screen shows what he says, when he says it
| # | Trigger | Required | Verify |
|---|---|---|---|
| C1 | He names a thing on screen (UI element, design, page, result) | That exact thing is visible, legible and the framed subject at the word: its box centre within the framing tolerance (F1) by **word time + 0.30 s**, and it stays framed at least until the word ends | per-beat target box (from expect.json + frame detection) vs frame centre at word end |
| C2 | He describes an action ("click", "type", "open", "select", "pick") | The action happens on screen with its visible result (menu opens, selection handles appear, picker opens, text changes) — the press within **±0.15 s of the action word**; a hover is NOT an action | frame diff around the word: UI state change present; selection handles / open menu detected |
| C3 | Any text he types/pastes | The field is EMPTY on the first recorded frame of the typing beat (cleared off camera); the final text equals the scripted text exactly; no leftover drafts | OCR-free: field crop at first frame = empty-field template; final crop matches the scripted string render |
| C4 | Any moment | No foreign brand/content in frame: **"Blue Bottle Coffee" (brand, document, Recents thumbnail, brand-menu entry) must never be visible** — Jake forbids deleting/renaming it, so it is kept out by framing, cuts, scrolling or view choice | template/colour match of the Blue Bottle assets + text crops on every 4th frame; 0 hits |
| C5 | Any moment | No transient UI on screen: pop-ups, toasts, "Reading the site…", spinners, suggestion lists, flashes of a parent menu, half-drawn layouts, blank/loading canvases | frame-to-frame layout jump detector + spinner/toast templates; any 1-frame layout jump = fail |
| C6 | "sign up", "you'll land on the signup page", "log in" from a logged-out viewpoint | Recorded in a separate LOGGED-OUT profile showing the real auth page | page fingerprint |
| C7 | PRIVATE INFORMATION IS ALWAYS BLURRED (Jake 2026-10-09): email addresses, passwords and password fields, API keys/tokens/secrets (incl. "sk-…", bearer tokens, webhook URLs with keys), phone numbers, payment/card details, street addresses, account IDs, invoice/billing details, and other people's names/avatars/chats. Detected automatically on every recorded frame (DOM: input[type=password|email], known selectors; plus OCR patterns for emails, keys, phone numbers) and covered with a strong gaussian blur that tracks the element through zoom/pan for its whole time on screen. If an item cannot be located reliably, blur the whole region or cut the beat. Jake's own display name "Jake Dawson" is NOT private (ruled 2026-10-08) — his email address IS. QA fails any frame where such text is legible. |

## 2. Framing
| # | Rule | Numbers | Verify |
|---|---|---|---|
| F1 | Every move/cut ENDS with the subject centre-middle (Jake rule 1) | subject box centre within **0.06 of frame width horizontally and 0.08 of frame height vertically** of (0.5, 0.5); exception only where the target touches a REAL capture edge (page edge, docked sidebar/top bar) — then clamp, nothing else. A scrollable canvas edge is NOT a real edge: move the canvas off camera instead | target box from detection at the end of each move |
| F2 | The "subject" box is the CONTAINER being talked about (card, paragraph block, panel, menu, artboard group), not a text line inside it | container detection, not text-line detection | reviewer compares chosen box with the container |
| F3 | Zoom level by target type (ref-measured, Jake overrides marked) | single small control/CTA **×1.50–1.65** (ZM02); input/prompt box **×1.35–1.47** but TYPING stays ×1.00 (Jake rule 10); side panel/settings **×1.25–1.30**; card/design/result **×1.19–1.30**; text block he reads **×1.30–1.35**; row/list **×1.40–1.43**; landing hero **×1.25–1.37** after a 1–2 s hold at ×1.00; Free pricing card: framed by the card box at **×1.45–1.65** | measured scale per frame |
| F4 | Never the whole canvas / app chrome on a design canvas (Jake rule 4) | on design-canvas shots scale ≥ 1.19 at every frame after the first 31 f of the video; NO zoom-out below the group framing; dissolves into a canvas arrive already framed | measured scale + chrome detector |
| F5 | The bubble never forces framing (Jake) | the framing ignores the bubble; a centred subject partly under it is acceptable | — |

## 3. Camera moves
| # | Move | Required | Source |
|---|---|---|---|
| M1 | Zoom-in to a target | duration **34–48 f** (deep zoom ZM02 45–58 f); curve cubic-bezier(.31,.10,.22,1) on log-zoom; starts **0.5–0.9 s before the naming word but never before the start of the clause that names it**; lands by word + 0.30 s | ZM01–ZM08 |
| M2 | Pan at constant zoom (next nearby target) | used instead of zoom-out→zoom-in when the next target fits at the same zoom; zoom ratio 0.95–1.01; **D = 24 + 0.035·distance_px f (26–56 f)**; curve (.33,.02,.27,.96); **peak speed ≤ 1200 px/s** | PN01–PN05 |
| M3 | Zoom-out / release | ratio 0.76–0.90, **D 34–40 f**, curve (.33,0,.31,.93); full release lands exactly on ×1.00; never on design canvases (F4); never right before a cut to A-roll | ZM11 |
| M4 | Quick zoom on a navigating click | **×1.07–1.15 over 9–20 f landing ON the press**, then the page change (cut) | ZM12, CUT02, Jake rule 11 |
| M5 | Slow centred push (gap filler) | translation < 30 px, **×1.06–1.26 over 24–46 f**, inward only | ZM10, Jake rule 2 |
| M6 | Too little time | if the time between the previous framing's landing and the next word is shorter than the move's minimum duration (+0.3 s), DO NOT squeeze: use a cut that lands already framed (CUT06/CUT03) | reviewer ruling R1 |
| M7 | Forbidden | moves shorter than their band; any move < ×1.05 AND < 60 px ("twitch"); outward drifts; whips (peak > 1200 px/s); wandering paths (a move must head straight for its target) | rounds 1–2 |

## 4. Holds and pacing
| # | Rule | Numbers |
|---|---|---|
| P1 | No pixel-still stretch longer than **3.0 s** inside a screencast (Jake rule 2) — fill with M5 or the next beat | measured |
| P2 | Motion events (moves + cuts + dissolves) **17–30 per minute of screencast** | ref 17–25, Jake cap 30 |
| P3 | Time zoomed (scale > 1.05) **62–80 %** of screencast time | refs ~62 % |
| P4 | Screencast spans and A-roll blocks follow the plan; a span shorter than 2.5 s is not created | |

## 5. Cuts and transitions
| # | Trigger | Required |
|---|---|---|
| T1 | Same app/page, later state (typing done, list loaded, menu open) | hard cut, 1 f, zoom carried (CUT01) |
| T2 | Click that changes page in the same app | M4 then hard cut (CUT02) |
| T3 | Chain of menu/onboarding steps | hard cuts on each word, ×1.00, 3–6 cuts in 5–8 s (CUT03) |
| T4 | Change of app/site/project or a time skip | dissolve **3–8 f (default 5) linear, zoom held** (TR01/TR02); within 0–6 f followed by a pan (PN05, 32–37 f) or a release — never a release on a design canvas |
| T5 | Screencast ↔ full-screen narration (both directions) | **Jake's override of TR05: bubble fade 4 f, then screen dissolve 4 f**, "so fast it isn't noticed"; the A-roll picture shows NO scale change on its first frames (scale constant ±0.5 % across the transition); cut point on a sentence start, picture ~0.1 s ahead of the voice |
| T6 | Video start | opens punched in **×1.36–1.55 easing to ×1.00 over ~31 f**, curve (0.089,0.443,0.126,0.834) (TR07); never a pixel-still first second |
| T7 | Video end | **30 f near-linear fade to black + ≥ 3 true-black frames**, starting after the last word ends (TR08) |
| T8 | Forbidden | double cuts (a cut followed by a correcting jump < 10 f later); one-frame flashes of another state; cuts landing mis-framed |

## 6. Facecam bubble
| # | Rule |
|---|---|
| B1 | Fixed position and size on every screencast frame: centre (1701.9, 253.7), outer Ø 358.6 (ring), video radius 172.3 — never moved or scaled |
| B2 | Hidden ONLY while a click/type/drag/select acts on an element whose box intersects the disc (centre (1701.9,253.7), radius 179.3) in OUTPUT coordinates after the camera transform. Fade-out 6–8 f ending at the press; fade-in 11 f after the action's visible result. Reads, hovers and framing never hide it |
| B3 | At screencast ↔ narration changes the bubble fades first (T5) |

## 7. Typing, clicks, scrolls
| # | Rule |
|---|---|
| K1 | Typing is shown at ×1.00, no re-framing during typing; a whole domain/prompt is pasted at once (CUT01) with nothing popping up (C5) |
| K2 | After "hands you designs"/a generation: dissolve (T4) straight to the result, already framed (F4); no click on the designs |
| K3 | Scroll only to reach the one thing named next; native wheel; never a scroll into black/unpainted regions (SC01, Jake rule 9) |
| K4 | Clicks press on the action word (C2); the cursor arrives along a straight-ish path; no visible click effects beyond the app's own (CR01) |

## 8. Reveal, landing and pricing
| # | Rule |
|---|---|
| L1 | Naming the tool ("this tool called X") → its landing page (or full-screen narration), arriving within word + 0.30 s (Jake rule 3) |
| L2 | Landing pages: hold ×1.00 for 1–2 s with the logo fully in frame, then the hero push (F3, M1); pan to the CTA he clicks next if any (ZM07) |
| L3 | Pricing (Jake rule 7): landing page unzoomed first, then a hard cut straight onto the Free card framed by its box (F2/F3), centred, not under the bubble; no other prices visible |
| L4 | Prices on screen are ALWAYS in US dollars, and pricing is ALWAYS shown from OUTSIDE the account (Jake 2026-10-09): a SEPARATE, fresh Chrome browser that was never logged in (its own empty profile, no Scout profile copy, no cookies — never the logged-in browser; NEVER log out of a logged-in browser or session to get a logged-out view) going out through a US location (US egress/VPN), en-US locale, US timezone — the product's public pricing page. Never show pricing, plan, upgrade or billing screens from inside the logged-in account (its currency follows the account's country, and it is the account's billing data). If the public page still shows another currency, re-record via the US route or cut that beat to A-roll. A pricing/upgrade modal that pops up uninvited inside the account is closed off camera and never shown. |

## 9. Text overlays
| # | Rule |
|---|---|
| X1 | Text overlays only over A-roll or full-screen plates — never over a screencast; no boxes, arrows, spotlights or click ripples over screencasts |
| X2 | Every text overlay sits on the full-width black→transparent gradient: alpha = 0.63·clip((y/H − 0.15)/0.85)^1.23, fade in 22 f, out 8 f, kept on across back-to-back titles (Jake rule 6) |
| X3 | Title/subscribe/link/social animations as in the existing ref-2 specs (they were judged correct by Jake) |

## 10. A-roll
| # | Rule |
|---|---|
| A1 | Each A-roll block starts at ×1.00 and pushes linearly at **1–3 % per second**, capping at ×1.12–1.16 then holding (AR01) |
| A2 | A take change inside an A-roll block that keeps the same framing gets a punch-in alternation of ×1.3–1.5 about the face (CUT07, refs 3–5); no jump cut with identical framing within 1 s of a transition |
| A3 | No scale pop at A-roll entries (T5) |

## 11. Reviewer rulings log (append-only)
- R1 (round 1): fast list beats use cut chains that land framed, not pans (M6).
- R2 (round 1): canvas groups are placed mid-capture off camera; only real edges clamp (F1).
- R3 (round 1): cold open uses T6.
- R4 (round 1): Jake's T5 numbers override TR05's 10 f + 8 f.
- R5 (2026-10-08, Jake): the Blue Bottle Coffee brand/document must NOT be deleted or renamed; keep it out of frame (C4).
- R6 (round 2): builder claims require frame-measured evidence (§0.3); six round-2 claims were false.
- R7 (2026-10-09, Jake): "that can appear only in dollars (so you need to show always the pricing using a VPN from the US)" → L4. Trigger: the creative edit showed ChatGPT's "Upgrade your plan" modal in Thai baht (฿699 / ฿3,350) at 46–51 s.
- R8 (2026-10-09, Jake): "all private information like emails, passwords, private apis, should be blurred on screen" → C7.
- R9 (2026-10-09, Jake): "For pricing - don't use the logged in account - look at it from the outside (on a US browser)" → L4 rewritten: pricing = logged-out US browser only.
- R10 (2026-10-09, Jake): "That should be in another chrome browser - never log out from a logged in browser" → L4: outside views (pricing, landing pages as a visitor) use a separate never-logged-in Chrome; logging out of any logged-in browser/session is forbidden (it would also kill the saved Scout login).
- R11 (2026-10-09, Jake): "G1 trims pauses - I don't want that at all" → Natural pauses are never trimmed and no cut is added to Jake's narration (Jake 2026-10-09); long-form keeps pauses <= 0.70 s as recorded (edl.LONG_PAUSE_KEEP = 0.70, rules.json narration.pause_keep / never_trim). No reference number (pause profile, jump-cut count, span length) is ever a reason to cut narration; the rubric does not score pauses.

## 12. Measurement notes (kept from the retired second copy that lived next to SYSTEM.md; merged here 2026-10-09)
- M1 (measurement note — not the §3 M1 camera move; **conflicts with A2; reviewer to re-confirm**). Originally "R7 (2026-10-08)" of the live copy: A-roll re-measured on refs 2–5: ORB+RANSAC similarity scale on every 2nd non-screencast frame, 9 006 presenter frames): push rate p50 1.98 / 2.55 / 2.62 / 1.85 %/s, cap p50 ×1.12 / 1.14 / 1.13 / 1.10, camera moving 77–84 % of presenter time; scale ratio across 106 presenter→presenter jump cuts p10–p90 0.97–1.01, only 3 changed ≥ 8 % → CUT07 alternation dropped (A2); TR07 opening identical in all 4 refs (≈ ×1.5 → 1.0 in ~1 s); AR02 outro punch ×1.22–1.23 (r3 13:11, r4 13:17, r5 15:01). Until the reviewer re-confirms, A2 (CUT07 on) wins and the switch is rules.json `aroll.cut07.enabled`; CUT07 only reframes existing cuts and never adds a cut to the narration (R11).
