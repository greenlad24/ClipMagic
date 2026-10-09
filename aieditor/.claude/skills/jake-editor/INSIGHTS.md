# What two review rounds taught us about the reference editor (2026-10-08)
Source: v12 independent review, loop rounds 1–2 reviews, technique catalogue corrections, Jake's notes. Each insight is encoded as a precise rule in RULEBOOK.md (section in brackets).

1. Screen shows exactly what is said, when said [C1, C2]. Layout-only scores lie (v12 = 95 while wrong).
2. Demo uses the editor's own brand/content [C4]. 3. App state prepared off camera: empty fields, right brand, logged-out for sign-up [C3, C6].
4. Subject ends dead centre; only real edges clamp [F1]. 5. Frame the container, not a text line [F2]. 6. Gentle zooms 1.2–1.4×, ≤1.65× for one small control [F3].
7. Never the whole design canvas / app chrome [F4]. 8. Bubble fixed; hides only for a click under it [B1, B2].
9. Rarely still: 17–25 motion events/min, holds mostly < 1.5 s, Jake cap 3 s [P1, P2]. 10. Moves start ~0.8 s before the word and land on it [M1].
11. Nearby next target → pan at same zoom [M2]. 12. Moves 34–48 f, peak ≤ 1200 px/s [M1–M3]. 13. No time to move → cut that lands framed [M6].
14. No micro-moves/twitches [M7]. 15. Same app = hard cut; new app/time skip = 3–8 f dissolve, zoom held [T1–T4].
16. Screen↔face: refs hard cut ~99 %; Jake's 4+4 f bubble-first fade [T5]. 17. Loading/typing cut out [T1, K1]. 18. Nothing pops up [C5].
19. Naming the tool → landing page, hold 1–2 s, hero push [L1, L2]. 20. Typing zoomed out, dissolve to the result [K1, K2].
21. Pricing: landing → cut to the Free card only [L3]. 22. Opening punched in, eases out ~1 s [T6]. 23. Ending 1 s fade to true black [T7].
24. A-roll push 1–3 %/s capping 1.12–1.16 [A1]. 25. Same-framing jump cuts alternate 1.3–1.5× [A2]. 26. Text only over A-roll/plates, on the gradient; no boxes/arrows over screencasts [X1, X2].
27. Claims must be measured on frames [§0.3]. 28. Every rule cites a reference timestamp [§0.1].

## Added 2026-10-09 (the factory end-to-end run, gap review items 8/10/11/14/19, Jake's rulings of the day)
29. Natural pauses are never trimmed and no cut is added to the narration; reference numbers never justify one [R11].
30. An improvising agent on camera invents features (@Sketch picker, '/background', 'Updated' badge, a 'Bakery Image Prompt' chat, a Free card inside a Plus account). The plan may only name actions proven 3/3 in the app's playbook; anything else is `needs_primitive`, proven off camera first [playbooks/, schemas/plan.schema.json].
31. Pricing and visitor views come only from a separate never-logged-in Chrome through a US route; never log out of anything [L4, R9, R10]. Private information is always blurred [C7].
