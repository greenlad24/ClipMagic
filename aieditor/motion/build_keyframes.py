"""Builds keyframes.json — the reference video's ANIMATION keyframes, design-free.

Jake 2026-10-05: "save mostly the animation keyframes - we might change the design later".
So this library holds only motion: frame offsets, durations, easing curves, travel,
per-frame tables, staggers, exits, camera-cut rules. Colours/fonts/glass are a separate,
swappable style (aieditor/recipes.py STYLE). Units: 24 fps frames from the element's first
visible frame unless an entry says otherwise; px are at the reference's 1080p and should be
scaled by the element's own size (em of its font, or its box) when a design changes.

Sources: the frame-by-frame measurement specs in reference-specs/ (copied from
/opt/aieditor-work/reference/specs/, measured 2026-10-04 on gVPZU1btFA8) — pulled out
verbatim by key so nothing is retyped — plus VERIFIED entries from replica tests, which
override a spec where they disagree.  Run: python3 build_keyframes.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPECS = HERE / "reference-specs"


def spec(name, path):
    v = json.loads((SPECS / f"{name}.json").read_text())
    for p in path.split("/"):
        v = v[p]
    return {"source": f"reference-specs/{name}.json#{path}", "keyframes": v}


VERIFIED = {
    "keyword_rise": {
        "what": "keyword text (SAVE THE / BUDGET): fade + rise, line 2 +2 f",
        "opacity": {"start": 0.5, "dur": 7.40, "ease": [0.368, 0.101, 0.493, 0.937]},
        "translateY_em": {"start": 0.5, "dur": 7.53, "from": 0.337, "to": 0, "ease": [0.236, 0.62, 0.455, 0.97]},
        "motion_blur": "360° shutter (σ = travel per frame / √12)",
        "line_stagger_f": 2, "hold": "pixel-static", "exit": "hard cut, usually on a camera cut",
        "speech": "text leads the spoken word by 140–300 ms",
        "replica": "A SAVE THE BUDGET f965–1006: ≤0.016 opacity, ≤0.7 px every frame (2026-10-04)",
    },
    "dropin": {
        "what": "R1 floating drop-in (numbers/labels beside the presenter)",
        "opacity": {"start": -2, "dur": 9, "ease": [0.50, 0, 0.40, 1]},
        "translateY_px": {"start": -2, "dur": 9, "from": -15.4, "to": 0, "ease": [0.40, 0.40, 0.30, 1],
                          "scale_rule": "FIXED travel, independent of font size (98 px = $250 and 59 px lines both drop 15.4 px, replica-verified); scale only with output resolution (px at 1080p)"},
        "blur_sigma_px": {"start": -2, "dur": 6, "from": 4, "to": 0, "ease": [0.40, 0.40, 0.30, 1]},
        "gradient_line_fade_lead_f": 1,
        "gradient_line_note": "a pink/gradient line's FADE starts 1 f earlier (drop unchanged): 5/5 lines measured "
                              "(= $250, $1,000, $100, HOOK RATE, CPL — 36–71 % ink visible at k+1 vs ~0 % for white timing). "
                              "If a redesign drops the gradient, re-check whether the lead belongs to 'hero' lines or to the gradient.",
        "stagger": "speech-triggered, no fixed stagger (13–59 f measured)",
        "exit_fade_3f": [1.0, 0.748, 0.30, 0.049, 0.0],
        "replica": "E 5 VIDEOS × $50 = $250 f8760–8919: white lines ≤0.05 opacity, ≤0.4 px; gradient line shape ≤0.4 px from k+3 (2026-10-05)",
    },
    "word_rise": {
        "what": "title/list words (chapter card AD FORMAT #1 / CALLOUT DIAGRAM): spec word_rise_reveal tables",
        "stagger": "words +1.5 f (AD 0, FORMAT +1.5, #1 +3); line 2 first word +3 f after line 1's — spec CONFIRMED by shape measurement",
        "rise": "30 px fixed for 76 px and 117 px words alike",
        "gradient_word_fade_lead_f": 1.5,
        "underline_start_f": 2.5,
        "underline_note": "the spec put the underline at card-cut+6 (= first word +5.8); measured rise aligns at first word +2.5 (−3.3 f)",
        "replica": "white words ≤0.03 progress / ≤1 px rise every frame; pink words rise identical, clear-ink fraction within ~0.07 with the 1.5 f lead (2026-10-05)",
    },
    "cards": {
        "what": "floating cards: portal swing-open (7:44) + pink-reveal rise (3:29) — tables in measured.card_portal_open / card_pink_reveal_rise",
        "portal_replica": "both cards from ONE averaged table: width/top ≤2 px, slab centre ≤6 px (near-side lean), pink amount within 0.06 every frame",
        "callout_replica": "box ≤1 px, opacity ≤0.03; pink clears on the same frames (~0.1 high mid-way — depends on the assumed pink, style)",
        "corrections_vs_spec": "pink is ~0.72 max on portal cards (not solid); callout fades in over 5 f at full pink; the callout also grows ~2 %",
    },
    "prompt_bar": {
        "what": "ChatGPT-style composer over the presenter (P5 9:13)",
        "typing": "linear 1.706 chars/f from k+0.87 (fit over 63 frames: rms 0.77, max 1.9 chars); glyphs fade ~1.5 f, no caret; "
                  "showcase bars (P1/P3) type the whole prompt in 28 f",
        "entrance_overlay": "opacity .27 .49 .75 1 (k..k+3)", "wrap": "bar grows one line over 6 f when the next line starts (bottom +12 px)",
        "replica": "line 2 starts f13306 and typing ends f13335.7 vs measured 13306 / 13334; within ~1 char every frame (2026-10-05)",
    },
    "count_up": {
        "ease": [0.65, 0, 0.35, 1], "rounding": "Math.round, en-US grouping",
        "replica": "REACH 1,200→48,000 over 33 f: 33/33 values exact; days 01→14 21/22 (tests/motion_count_test.mjs)",
    },
}

LIBRARY = {
    "about": __doc__.strip().splitlines()[0],
    "fps": 24,
    "verified": VERIFIED,
    "text": {
        "keyword_variants": spec("keyword-text", "recipe"),
        "keyword_related": spec("keyword-text", "related_variants"),
        "titles_lists": spec("titles-lists", "recipes"),
        "glow_background_loop": spec("titles-lists", "recipes_glow_background"),
    },
    "numbers": {
        "recipes": spec("data-cards", "recipe"),
        "counters": spec("data-cards", "counters"),
        "rise_tables": spec("data-cards", "entrance_tables_rise"),
        "dropin_tables": spec("data-cards", "entrance_tables_floating_dropin"),
        "exits": spec("data-cards", "exits"),
        "scene_active_ad_card": spec("data-cards", "A_active_ad_card_scene"),
        "scene_ad_comparison": spec("data-cards", "B_ad_comparison_scene"),
        "scene_funnel": spec("data-cards", "C_funnel_scene"),
    },
    "pills_cards": spec("pills-cards", "recipes_24fps"),
    "prompt_bars": {
        "typing": spec("prompt-camera-sfx", "A_prompt_bars/typing_summary"),
        "instances": spec("prompt-camera-sfx", "A_prompt_bars/instances"),
    },
    "camera": {k: spec("prompt-camera-sfx", f"B_camera/{k}") for k in
               ["framings", "digital_punch_ins", "transitions", "pattern", "cuts_vs_speech", "shot_length_stats_s"]},
    "sound": {k: spec("prompt-camera-sfx", f"C_sfx_mix/{k}") for k in ["levels", "entrance_sfx", "sfx_summary"]},
}

sysf = HERE / "screencast_system.json"      # the screencast SYSTEM (screencast/SYSTEM.md)
if sysf.exists():
    LIBRARY["screencast"] = json.loads(sysf.read_text())

extra = HERE / "keyframes_measured.json"   # replica-measured tables (e.g. the LINK pill)
if extra.exists():
    LIBRARY["measured"] = json.loads(extra.read_text())

# the motion TEMPLATES (2026-10-09, Jake's four+one reference clips; specs reference-specs/<id>.md): each template's
# measured keyframes live beside its renderer as templates/<id>.kf.json (seconds relative to the beats, travel in
# the element's own units); merged here so the whole motion library stays one file
tk = {p.name[:-len(".kf.json")]: json.loads(p.read_text()) for p in sorted((HERE / "templates").glob("*.kf.json"))}
if tk:
    LIBRARY["templates"] = tk

(HERE / "keyframes.json").write_text(json.dumps(LIBRARY, indent=1, ensure_ascii=False))
print("keyframes.json:", ", ".join(LIBRARY))
