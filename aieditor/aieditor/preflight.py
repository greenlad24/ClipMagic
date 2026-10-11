"""THE PREFLIGHT + SELF-REPAIR LAYER — one layer for every failure class the 2026-10-10/11 test runs hit (Jake 2026-10-11:
"this needs to be the one layer that solves all of those issues from before for all present and future test or real
rounds"; "I want to fix it for all future videos so we don't do these sessions again and it can edit any kind of video
with screencasts at a high level").

Four failure classes, each (1) DETECTED cheaply before the expensive stage, (2) REPAIRED as data or degraded gracefully
(logged, never silent), (3) PINNED by a regression test — the table is COVERAGE below (docs/SELF-HEALING.md prints it):

  A  app UI drift        first-frame checks, popups / resting UI, moved controls, the logged-out view, a chat that will
                         not load            → RecordingPreflight (off camera, before recording) + drift.Repairer
  B  asset fidelity      wrong prompt / source / look, a fake-UI collage, a tool result not made by the tool, the wrong
                         tool                → audit_asset (before reuse and before recording) → set aside, made again
  C  onboarding / proofs drag / stroke data, undeclared params, chained requires, presence proofs, a step that does
                         not exist, a guessed flow, a control that appears after the app's reply
                                             → audit_playbook (before recording) + the replay rules (playbook.py)
  D  run control         the API cap mid-route, a pre-production crash, a frozen status line, needs_primitive holds
                                             → headroom (before routing) + the route/cap/finish-mode rules

A systematic drift (the same reason on >= 2 screencasts) goes to the drift-repair agent (aieditor/drift.py), which writes
the fix as DATA into THIS video's playbook and proves it on 2 screencasts; a screencast that still fails after preflight
+ repair + the recorder's own retakes falls back to an approved motion template of that step in the app's UI kit (with
the real result when there is one) — listed in fallbacks.json and the finish-mode warnings, never a silent drop.
"""
import copy
import json
import re
import time
from pathlib import Path

CLASSES = {"A": "app UI drift", "B": "asset fidelity", "C": "onboarding / proof gap", "D": "run control"}

# ───────────────────────── the coverage table (every past failure → class → detector → repair → test) ─────────────────────────
# test = "tests/<file>::<token>": the token must appear in that test file (tests/test_selfheal.py checks it), so a row
# without a real test fails the suite.
COVERAGE = [
    # A — app UI drift
    {"id": "A-home-suggestions", "when": "2026-10-11 re-run 14", "cls": "A",
     "failure": "ChatGPT's new home-page suggestions under the composer failed the first frame on every screencast",
     "detector": "RecordingPreflight (first frame per start state, clustered: >= 2 screencasts)",
     "repair": "drift.Repairer → resting_ui: start_state.allow.resting_texts / resting_selectors (data), proven on 2",
     "test": "tests/test_selfheal.py::A-home-suggestions"},
    {"id": "A-outside-login-view", "when": "2026-10-11 re-run 14", "cls": "A",
     "failure": "the logged-out US pricing page (Log in / Sign up) was called a login wall",
     "detector": "first_frame.allowed (walls) + beatscript outside start_state", "repair": "outside_view.allow.walls = login (default)",
     "test": "tests/test_selfheal.py::A-outside-login-view"},
    {"id": "A-safe-rules", "when": "standing", "cls": "A",
     "failure": "an allowance must never accept another account, Work mode, a draft, the sidebar or a challenge",
     "detector": "first_frame.SAFE_RX", "repair": "refused by code whatever the agent says",
     "test": "tests/test_selfheal.py::A-safe-rules"},
    {"id": "A-new-popup", "when": "class", "cls": "A",
     "failure": "a new popup / banner on the start page", "detector": "RecordingPreflight cluster",
     "repair": "drift.Repairer → dismiss: start_state.dismiss steps (click guard), proven on 2",
     "test": "tests/test_selfheal.py::A-new-popup"},
    {"id": "A-moved-control", "when": "class", "cls": "A",
     "failure": "a playbook control moved / was renamed (no element on every screencast)",
     "detector": "RecordingPreflight (dry beats), cluster", "repair": "drift.Repairer → moved_control → the action re-onboarded",
     "test": "tests/test_selfheal.py::A-moved-control"},
    {"id": "A-real-problem", "when": "class", "cls": "A",
     "failure": "a real fault (challenge / another account) must not be accepted",
     "detector": "RecordingPreflight cluster", "repair": "real_problem → nothing accepted; motion-template fallback, logged",
     "test": "tests/test_selfheal.py::A-real-problem"},
    {"id": "A-chat-wont-load", "when": "2026-10-11 02:01 re-run 13", "cls": "A",
     "failure": "the source chat grew too big: 'Could not load this conversation' on every proof",
     "detector": "onboard_action (start_state: no element / could not load)", "repair": "the next round starts from another chat this job created",
     "test": "tests/test_selfheal.py::A-chat-wont-load"},
    {"id": "A-library", "when": "2026-10-10 23:46", "cls": "A",
     "failure": "the readiness check opened Jake's own Library", "detector": "readiness without the Library (AIEDITOR_READINESS_LIBRARY)",
     "repair": "the toolbar comes from the proven playbook", "test": "tests/test_selfheal.py::A-library"},
    # B — asset fidelity
    {"id": "B-verbatim", "when": "2026-10-10 22:42 / 23:00 / 23:15", "cls": "B",
     "failure": "his on-screen prompt was replaced by an internal / rewritten prompt ('a glass')",
     "detector": "audit_asset (verbatim) + onboard.onscreen_prompt", "repair": "set aside → made again with his words verbatim",
     "test": "tests/test_selfheal.py::B-verbatim"},
    {"id": "B-object-list", "when": "2026-10-10 23:00", "cls": "B",
     "failure": "the manifest's object-list prompt ('…with a glass clearly visible…') was typed",
     "detector": "audit_asset (internal / object list)", "repair": "set aside", "test": "tests/test_selfheal.py::B-object-list"},
    {"id": "B-one-line", "when": "2026-10-10 23:15", "cls": "B",
     "failure": "a newline in a typed prompt sent it early", "detector": "audit_asset (newline in a prompt)",
     "repair": "typed prompts are one line (onboard.verbatim_plus)", "test": "tests/test_selfheal.py::B-one-line"},
    {"id": "B-merge-sources", "when": "2026-10-10 23:31 / 23:50 / 00:05", "cls": "B",
     "failure": "a 3-photo merge was one edit / an invented collage; its sources were never made",
     "detector": "audit_asset (a merge with < 2 sources)", "repair": "set aside → sources made first (source_inputs)",
     "test": "tests/test_selfheal.py::B-merge-sources"},
    {"id": "B-collage", "when": "2026-10-11 00:05", "cls": "B",
     "failure": "a prompt asked for a fake collage / app interface", "detector": "audit_asset (chrome words)",
     "repair": "set aside", "test": "tests/test_selfheal.py::B-collage"},
    {"id": "B-input-result-prompt", "when": "2026-10-10 23:37", "cls": "B",
     "failure": "an input photo he brings was made with his RESULT prompt", "detector": "audit_asset (input + on-screen prompt)",
     "repair": "set aside", "test": "tests/test_fidelity.py::input photo never"},
    {"id": "B-wrong-source", "when": "2026-10-10 23:31", "cls": "B",
     "failure": "'restore this old photo' ran on the hot-sauce photo (the prior picture taken as source)",
     "detector": "the source step decides (prior picture = hint)", "repair": "source_inputs",
     "test": "tests/test_fidelity.py::hint"},
    {"id": "B-tool-not-tool", "when": "2026-10-11 00:58 / 01:42", "cls": "B",
     "failure": "a tool result was a described edit / a new picture, not the app's tool on the source",
     "detector": "audit_asset (tool result not via the tool, or no source)", "repair": "set aside → the tool route",
     "test": "tests/test_selfheal.py::B-tool-not-tool"},
    {"id": "B-overlay-hidden", "when": "2026-10-11 01:42 re-run 12", "cls": "B",
     "failure": "Remove BG's real cutout in the viewer overlay was misread as a text reply 6x",
     "detector": "producer: overlay_close (data per app)", "repair": "the overlay is closed after the tool's press",
     "test": "tests/test_selfheal.py::B-overlay-hidden"},
    {"id": "B-wrong-tool", "when": "2026-10-11 02:12 re-run 13", "cls": "B",
     "failure": "'Resize result: same bottle cutout' picked Remove BG", "detector": "producer.tool_of (named first) + audit_asset",
     "repair": "set aside", "test": "tests/test_selfheal.py::B-wrong-tool"},
    {"id": "B-target-clause", "when": "2026-10-11 08:29 re-run 15", "cls": "B",
     "failure": "the erase brush target was a narration clause ('… and click send') → a need with Send in it",
     "detector": "onboard.object_phrase / clean_tool_params", "repair": "the object only; a proven step reused",
     "test": "tests/test_selfheal.py::B-target-clause"},
    {"id": "B-duplicate-asset", "when": "2026-10-11 00:38", "cls": "B",
     "failure": "a source the job already had was made again under a new name ('person_photo')",
     "detector": "the source step knows every checked picture", "repair": "reused", "test": "tests/test_selfheal.py::B-duplicate-asset"},
    # C — onboarding / proof gaps
    {"id": "C-points-text", "when": "2026-10-11 00:22 re-run 9", "cls": "C",
     "failure": "the agent's drag points arrived as text: 'drag needs from/to [x, y]'", "detector": "onboard.norm_points",
     "repair": "normalized to numbers", "test": "tests/test_selfheal.py::C-points-text"},
    {"id": "C-undeclared-points", "when": "2026-10-11 00:42-01:23", "cls": "C",
     "failure": "an onboarded drag's points (on the action / undeclared params) were dropped by the replay",
     "detector": "audit_playbook (drag without points)", "repair": "playbook.resolve reads every spelling; neutral centre box",
     "test": "tests/test_selfheal.py::C-undeclared-points"},
    {"id": "C-strokes", "when": "2026-10-11 02:26 re-run 13", "cls": "C",
     "failure": "stroke tools drew nothing ('Undo never enabled')", "detector": "audit_playbook (draw without strokes)",
     "repair": "stroke data passes the replay; the proof draws one sample stroke", "test": "tests/test_selfheal.py::C-strokes"},
    {"id": "C-chained-requires", "when": "2026-10-11 08:12 re-run 14", "cls": "C",
     "failure": "a tool's later step was proven without the steps that make its control exist",
     "detector": "onboard_action(chain=…)", "repair": "each step requires the tool's earlier steps",
     "test": "tests/test_selfheal.py::C-chained-requires"},
    {"id": "C-confirm-presence", "when": "2026-10-11 02:41 re-run 13", "cls": "C",
     "failure": "a confirm after a stroke (Sketch's check mark) pressed on an empty canvas", "detector": "_CONFIRM_RX after a stroke",
     "repair": "proven by presence", "test": "tests/test_selfheal.py::C-confirm-presence"},
    {"id": "C-no-such-step", "when": "2026-10-11 01:56 re-run 13", "cls": "C",
     "failure": "Markup has no note box; the guessed step did not exist", "detector": "onboarding answers 'absent'",
     "repair": "a tool text step goes to the app's prompt action", "test": "tests/test_selfheal.py::C-no-such-step"},
    {"id": "C-guessed-flow", "when": "2026-10-11 02:21 re-run 13", "cls": "C",
     "failure": "the Logo template flow was guessed (paste + send)", "detector": "audit_playbook (tool steps)",
     "repair": "tool steps are needs the agent learns live", "test": "tests/test_selfheal.py::C-guessed-flow"},
    {"id": "C-after-reply", "when": "2026-10-11 08:38 re-run 15", "cls": "C",
     "failure": "the Logo name card appears only after ChatGPT's reply: 'pre: no element' on every proof",
     "detector": "playbook._poll_pre (busy page) / onboard_action", "repair": "after_reply (data): the pre check waits up to 30 s",
     "test": "tests/test_selfheal.py::C-after-reply"},
    {"id": "C-then-skip", "when": "2026-10-11 08:38 re-run 15", "cls": "C",
     "failure": "the Logo flow asks 3 questions (1 of 3)", "detector": "tool step data", "repair": "then_skip: the rest are skipped",
     "test": "tests/test_selfheal.py::C-then-skip"},
    {"id": "C-requires-param", "when": "2026-10-11 08:18 re-run 14", "cls": "C",
     "failure": "a required step that could not be built (\"param 'text' is required\") crashed pre-production",
     "detector": "audit_playbook (requires that cannot be built)", "repair": "a failed step, never a crash",
     "test": "tests/test_selfheal.py::C-requires-param"},
    # D — run control
    {"id": "D-cap-mid-route", "when": "2026-10-11 01:02 / 01:04 re-run 11", "cls": "D",
     "failure": "the Claude API cap refused calls during routing → 'needs_primitive' / half-routed",
     "detector": "headroom (before routing) + llm.refusals during routing", "repair": "daily → wait; job → held 'API cap'",
     "test": "tests/test_selfheal.py::D-cap-mid-route"},
    {"id": "D-cap-mid-assets", "when": "2026-10-10 22:45", "cls": "D",
     "failure": "the daily cap hit mid-assets and the job went on recording half-done",
     "detector": "preprod.run re-raises BudgetExceeded", "repair": "the job waits for the window", "test": "tests/test_selfheal.py::D-cap-mid-assets"},
    {"id": "D-playbook-crash", "when": "2026-10-11 08:18 re-run 14", "cls": "D",
     "failure": "a PlaybookError in a tool's requires ended pre-production", "detector": "producer requires try/except",
     "repair": "ui_step_failed (a failed try)", "test": "tests/test_selfheal.py::D-playbook-crash"},
    {"id": "D-assets-kept", "when": "2026-10-11 08:18 re-run 14", "cls": "D",
     "failure": "assets.json was lost when routing stopped", "detector": "route in try/finally", "repair": "assets.json written",
     "test": "tests/test_selfheal.py::D-assets-kept"},
    {"id": "D-status-line", "when": "2026-10-11 02:31 / 07:50", "cls": "D",
     "failure": "the status line froze on the last asset while P2/P4 ran", "detector": "status per need / round",
     "repair": "'Learning: … (round n/3)'", "test": "tests/test_selfheal.py::D-status-line"},
    {"id": "C-draw-no-strokes", "when": "2026-10-11 re-run 15", "cls": "C",
     "failure": "the Sketch check mark's proof failed 'requires ob_sketch_draw_strokes: draw needs strokes'",
     "detector": "playbook.resolve (draw)", "repair": "no strokes anywhere → one sample stroke",
     "test": "tests/test_selfheal.py::C-draw-no-strokes"},
    {"id": "C-idempotent-mode", "when": "2026-10-11 08:58 re-run 15 (and 2026-10-09)", "cls": "C",
     "failure": "the viewer was ALREADY in Markup mode from the previous proof round; pressing text=Markup again hit the "
                "composer's 'Markup' chip / toggled it off → \"requires viewer_markup: post: no element Cancel markup\"",
     "detector": "playbook.already (a click / key step whose post already holds)",
     "repair": "the press is skipped, logged 'state already reached' (replay, producer requires)",
     "test": "tests/test_selfheal.py::C-idempotent-mode"},
    {"id": "C-round-leak", "when": "2026-10-11 09:02 re-run 15", "cls": "C",
     "failure": "proof rounds leaked state: round 1's stroke left Markup mode on and a 'Markup' chip in the composer; "
                "round 3 failed \"pre: button[aria-label='Remove markup'] still present\"",
     "detector": "every proof round", "repair": "teardown (data) + Session.reset (Escape, dismiss steps, the draft's chips) "
                                               "after/before each round; 'still present' → another job chat",
     "test": "tests/test_selfheal.py::C-round-leak"},
    {"id": "D-prereq-failed", "when": "2026-10-11 09:04 re-run 15", "cls": "D",
     "failure": "a step whose prerequisite (viewer_markup) had already failed spent 3 more rounds + a new chat",
     "detector": "onboard.failed_prereq (this run)", "repair": "one self-repair of the prerequisite; then every dependent "
                                                               "step is skipped straight to its fallback, logged",
     "test": "tests/test_selfheal.py::D-prereq-failed"},
    {"id": "A-cropped-observation", "when": "2026-10-11 09:07 re-run 15", "cls": "A",
     "failure": "the explorer's 1280x720 observation showed only the top-left of the page (the viewer's Markup toolbar "
                "out of frame) while live.jpg showed all of it — proposals and proofs were blind",
     "detector": "agent_rec ensureViewport on every off-camera observe / state (vp in the reply) + preflight.viewport_problem",
     "repair": "the viewport is re-applied when it drifted; the clip covers the WHOLE layout viewport, downscaled, never cropped",
     "test": "tests/test_selfheal.py::A-cropped-observation"},
    {"id": "A-post-assert-drift", "when": "2026-10-11 09:13 re-run 15", "cls": "A",
     "failure": "viewer_comment / viewer_markup post checks ('Image comment surface', 'Cancel markup') fail from a clean "
                "state while the modes are visibly ON — ChatGPT renamed the elements (3/3 on 2026-10-09)",
     "detector": "reprove_existing: a replay failing only at 'post: no element'",
     "repair": "onboard.repair_post_assert: one vision call on the full frame → a new check, proven absent before / present "
               "after, replayed 3/3, written with repaired_from — never on vision alone",
     "test": "tests/test_selfheal.py::A-post-assert-drift"},
    {"id": "A-required-step-drift", "when": "2026-10-11 re-run 15", "cls": "A",
     "failure": "every Markup-stroke proof failed inside a REQUIRED step: \"requires viewer_markup: post: no element "
                "button[aria-label='Cancel markup']\" (its post assert drifted)",
     "detector": "onboard_action: all replays fail inside the same required step",
     "repair": "that step re-proven for this video (re-onboarded as data when it no longer replays), then the proof again",
     "test": "tests/test_selfheal.py::A-required-step-drift"},
    {"id": "D-finish-mode", "when": "2026-10-11 07:20", "cls": "D",
     "failure": "a test run must end in a finished edit", "detector": "request finish_video",
     "repair": "holds → warnings.json; every fallback listed", "test": "tests/test_selfheal.py::D-finish-mode"},
    {"id": "D-camera-as-feature", "when": "2026-10-11 08:48 re-run 15", "cls": "D",
     "failure": "'Close on the bottle's label' (a beat that only frames, camera.zoom) was routed to P4 as a missing feature",
     "detector": "onboard.is_camera_need (FRAMES_RX on the plan-check line) before the C route",
     "repair": "D: the edit's zoom on the picture on screen — no feature, no motion graphic",
     "test": "tests/test_selfheal.py::D-camera-as-feature"},
    {"id": "D-silent-drop", "when": "class", "cls": "D",
     "failure": "a screencast that fails after preflight + repair was dropped to the presenter silently",
     "detector": "fallback_events after record_all", "repair": "an approved motion template (real result if any), logged",
     "test": "tests/test_selfheal.py::D-silent-drop"},
]


def coverage_markdown():
    rows = ["| id | when | class | past failure | detector | repair | test |", "|---|---|---|---|---|---|---|"]
    for c in COVERAGE:
        rows.append("| " + " | ".join(str(c[k]).replace("|", "/") for k in ("id", "when", "cls", "failure", "detector",
                                                                                "repair", "test")) + " |")
    return "\n".join(rows)


# ───────────────────────── reasons: normalize, classify, cluster ─────────────────────────

def norm_reason(r):
    """A failure reason without its specifics (quoted texts, numbers, chat ids) — the cluster key."""
    t = str(r or "").lower()
    t = re.sub(r"\(\s*'[^']*'\s*\)|'[^']*'|\"[^\"]*\"|“[^”]*”", "'…'", t)
    t = re.sub(r"/c/[\w-]+", "/c/…", t)
    t = re.sub(r"\d+(?:\.\d+)?", "N", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:160]


_A = re.compile(r"first frame|popup|suggestion|menu|wall|login|log in|sidebar|start state|start_state|tooltip|"
                r"could not load|loading|blank|no element|not on the page|light theme|greet|account|work mode|"
                r"unusual activity|challenge", re.I)
_B = re.compile(r"needs_asset|not made off camera|asset|fidelity|verbatim|collage|source picture|look", re.I)
_C = re.compile(r"needs_primitive|no action|drag needs|stroke|undo never|requires|param .* is required|playbookerror|"
                r"not proven|onboard|presence", re.I)
_D = re.compile(r"api cap|budget|daily cap|cancel|timeout|timed out|disk", re.I)


def classify(reason, stage=None):
    r = str(reason or "")
    if stage in ("assets",):
        return "B"
    if stage in ("compile", "playbook"):
        return "C" if not _D.search(r) else "D"
    for k, rx in (("D", _D), ("A", _A), ("C", _C), ("B", _B)):
        if rx.search(r):
            return k
    return "A" if stage in ("first_frame", "beat") else "D"


def cluster(fails):
    """fails: [{seg, stage, reason}] → [{key, cls, stage, reason, reasons, segments, systematic}] (biggest first)."""
    by = {}
    for f in fails:
        key = (f.get("stage") or "", norm_reason(f.get("reason")))
        c = by.setdefault(key, {"key": f"{key[0]}:{key[1]}", "stage": key[0], "cls": classify(f.get("reason"), f.get("stage")),
                                "reason": f.get("reason"), "reasons": [], "segments": []})
        if f.get("reason") not in c["reasons"]:
            c["reasons"].append(f.get("reason"))
        if f.get("seg") not in c["segments"]:
            c["segments"].append(f.get("seg"))
    out = list(by.values())
    for c in out:
        c["systematic"] = len(c["segments"]) >= 2
    return sorted(out, key=lambda c: -len(c["segments"]))


# ───────────────────────── A: the recording preflight (off camera, before recording) ─────────────────────────

def _start_key(seg, pb):
    url = str(seg.get("url") or (pb or {}).get("start_state", {}).get("url") or "")
    kind = "chat" if re.search(r"/c/[\w-]+", url) else re.sub(r"[?#].*$", "", url)
    return (seg.get("app"), seg.get("session") or "logged_in", kind)


class RecordingPreflight:
    """Every screencast of the plan rehearsed OFF CAMERA before recording: its distinct start state opened, set-dressed
    and first-frame checked; its beats played dry (generating presses are dry — results are proven by presence). The
    failures are clustered; a cluster on >= 2 screencasts is a SYSTEMATIC drift → the drift-repair agent → data in
    this video's playbook → proven on 2 screencasts (reverted when it does not hold)."""

    def __init__(self, w, segs, playbooks, assets, words, new_session, *, repairer=None, reonboard=None, save_pb=None,
                 log=print, pixels=True, account=None, cancelled=lambda: False, allowed_chats=(), doodles=None):
        self.w = Path(w)
        self.segs, self.playbooks, self.assets, self.words = segs, dict(playbooks or {}), assets or {"assets": []}, words
        self.new_session, self.repairer, self.reonboard = new_session, repairer, reonboard
        self.save_pb = save_pb or (lambda app, pb: None)
        self.log, self.pixels, self.account, self.cancelled = log, pixels, account, cancelled
        self.allowed_chats = list(allowed_chats or [])
        self.doodles = doodles or []
        self.sessions = {}
        self.only = None                       # the screencast indexes to rehearse (None = all)

    def session(self, app, kind, fresh=False):
        key = (app, kind)
        if fresh and key in self.sessions:
            try:
                self.sessions.pop(key).close()
            except Exception:  # noqa: BLE001
                pass
        if key not in self.sessions:
            self.sessions[key] = self.new_session(app, kind, fresh)
        return self.sessions[key]

    def close(self):
        for s in self.sessions.values():
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass
        self.sessions.clear()

    def check_segment(self, i, seg, pb, beats=True):
        """→ {"ok", "stage", "reasons", "beat", "state"} — one screencast, off camera, nothing recorded or generated."""
        from . import beatscript as B, recorder as R
        if not pb:
            return {"ok": False, "stage": "playbook", "reasons": [f"no playbook for {seg.get('app')!r}"]}
        if not seg.get("beats"):
            return {"ok": False, "stage": "compile", "reasons": ["needs_primitive: the plan names no beats"]}
        try:
            sc = B.compile_segment(seg, self.words, pb, i, assets=self.assets, live_left=1, doodles=self.doodles)
        except B.CompileError as e:
            return {"ok": False, "stage": "compile", "reasons": [f"needs_primitive: {e}"]}
        kind = seg.get("session") or "logged_in"
        sess = self.session(seg.get("app"), kind)
        missing = R.resolve_assets(sc, self.assets, getattr(sess, "workdir", None))
        if missing:
            return {"ok": False, "stage": "assets", "reasons": ["needs_asset: results not made off camera: "
                                                                + ", ".join(sorted(set(map(str, missing))))]}
        try:
            st = R.open_clean(sess, pb, seg, sc.get("start_state"), lambda *a: None, tries=1, account=self.account,
                              pixels=self.pixels, session=kind, accept_resting=False)
        except R.SetupError as e:
            msg = str(e)
            body = msg.split(": ", 1)[1] if msg.startswith(("first frame never clean", "first frame", "wall on open")) else msg
            return {"ok": False, "stage": "first_frame", "reasons": [x.strip() for x in body.split("; ") if x.strip()] or [msg],
                    "wall": getattr(e, "wall", None), "start_state": sc.get("start_state")}
        if not beats:
            return {"ok": True, "stage": "first_frame", "reasons": [], "state": st}
        try:
            R.play_script(sess, sc, record=False, log=lambda *a: None, session=kind)
        except R.Retake as e:
            return {"ok": False, "stage": "beat", "reasons": [re.sub(r"^beat \S+ \([^)]*\) ", "", e.why)], "beat": e.beat,
                    "wall": e.wall, "start_state": sc.get("start_state")}
        return {"ok": True, "stage": "beats", "reasons": []}

    def _fails(self, results):
        out = []
        for i, r in results.items():
            if not r["ok"]:
                for why in r["reasons"]:
                    out.append({"seg": i, "stage": r["stage"], "reason": why})
        return out

    def run(self):
        t0 = time.time()
        results, first = {}, {}
        for i, seg in enumerate(self.segs):
            if self.cancelled():
                raise InterruptedError("cancelled")
            if self.only is not None and i not in self.only:
                continue
            pb = self.playbooks.get(seg.get("app"))
            k = _start_key(seg, pb)
            if k in first and not first[k]["ok"] and first[k]["stage"] == "first_frame":
                results[i] = {**first[k], "inherited": first[k].get("seg")}     # the same start state: the same verdict
                continue
            r = self.check_segment(i, seg, pb)
            r["seg"] = i
            first.setdefault(k, r)
            results[i] = r
        clusters = cluster(self._fails(results))
        repairs = []
        for cl in clusters:
            if not cl["systematic"] or cl["cls"] != "A" or self.repairer is None:
                continue
            rep = self.repair(cl, results)
            repairs.append(rep)
            if rep.get("accepted"):
                for j in cl["segments"]:
                    seg = self.segs[j]
                    results[j] = {**self.check_segment(j, seg, self.playbooks.get(seg.get("app"))), "seg": j,
                                  "after_repair": rep["verdict"]}
        failed = {i: r for i, r in results.items() if not r["ok"]}
        rep_doc = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "took_s": round(time.time() - t0, 1),
                   "segments": {str(i): {k: v for k, v in r.items() if k not in ("state", "start_state")} for i, r in results.items()},
                   "clusters": [{k: v for k, v in c.items()} for c in clusters], "repairs": repairs,
                   "failed": sorted(failed), "systematic_unrepaired": sorted({j for c in clusters if c["systematic"] and c["cls"] == "A"
                                                                               for j in c["segments"] if j in failed})}
        try:
            self.w.mkdir(parents=True, exist_ok=True)
            (self.w / "preflight.json").write_text(json.dumps(rep_doc, indent=1, default=str))
        except OSError:
            pass
        self.log(f"preflight: {len(results) - len(failed)}/{len(results)} screencast(s) rehearse clean; "
                 f"{len(clusters)} failure cluster(s), {sum(1 for c in clusters if c['systematic'])} systematic; "
                 f"{sum(1 for r in repairs if r.get('accepted'))} drift repair(s) accepted")
        return {**rep_doc, "playbooks": self.playbooks}

    def repair(self, cl, results):
        """One systematic drift → the agent's decision → data → proven on 2 screencasts, else reverted."""
        from . import drift, onboard, recorder as R
        segs = cl["segments"]
        seg0 = self.segs[segs[0]]
        app, kind = seg0.get("app"), seg0.get("session") or "logged_in"
        pb = self.playbooks.get(app)
        r0 = results.get(segs[0]) or {}
        ss = r0.get("start_state") or (pb or {}).get("start_state") or {}
        sess = self.session(app, kind)
        try:                                    # the page as the failing check saw it (opened + set-dressed)
            R.open_clean(sess, pb, seg0, ss, lambda *a: None, tries=1, account=self.account, pixels=False, session=kind,
                         accept_resting=False)
        except (R.SetupError, Exception):  # noqa: BLE001 — it fails by definition; the page is there
            pass
        guarded = onboard.Guarded(sess, pb, allowed_chats=self.allowed_chats, allow_generate=False, log=self.log)
        dec = self.repairer.decide(cl, guarded, ss, onboard._pb_summary(pb or {"actions": {}}), guarded=guarded)
        rep = {"cluster": cl["key"], "cls": cl["cls"], "segments": segs, "verdict": dec.get("verdict"), "why": dec.get("why"),
               "usd": dec.get("usd"), "turns": dec.get("turns"), "accepted": False}
        self.log(f"preflight: drift on {len(segs)} screencasts ('{str(cl['reason'])[:100]}') — the repair agent says "
                 f"{dec.get('verdict')}: {str(dec.get('why'))[:160]}")
        new = None
        where = "outside_view" if kind == "outside" else "start_state"
        if dec.get("verdict") in ("resting_ui", "dismiss"):
            new = drift.apply_patch(pb, dec, where=where)
            rep["patch"] = {k: dec.get(k) for k in ("allow", "dismiss") if dec.get(k)}
        elif dec.get("verdict") == "moved_control" and self.reonboard:
            try:
                new = self.reonboard(app, dec["reonboard"], pb)
            except Exception as e:  # noqa: BLE001 — a failed re-onboarding is a real problem
                rep["why"] = f"re-onboarding failed: {e}"
                new = None
            rep["patch"] = {"reonboard": dec.get("reonboard")}
        if new is None:
            return rep
        # PROVE it on 2 of the failing screencasts: neither may fail this cluster's reason any more
        old = self.playbooks.get(app)
        self.playbooks[app] = new
        proofs = []
        for j in segs[:2]:
            r = self.check_segment(j, self.segs[j], new)
            still = (not r["ok"]) and any(norm_reason(x) in [norm_reason(y) for y in cl["reasons"]] for x in r["reasons"])
            proofs.append({"seg": j, "ok": not still, "rest": r["reasons"][:3]})
        rep["proofs"] = proofs
        if all(p["ok"] for p in proofs):
            rep["accepted"] = True
            self.save_pb(app, new)
            self.log(f"preflight: the {dec.get('verdict')} fix is proven on {len(proofs)} screencasts — kept in this "
                     "video's playbook")
        else:
            self.playbooks[app] = old
            rep["why"] = (rep.get("why") or "") + " — not proven on 2 screencasts, reverted"
            self.log(f"preflight: the {dec.get('verdict')} fix did not hold on 2 screencasts — reverted")
        return rep


def viewport_problem(vp):
    """agent_rec's off-camera viewport proof ({w, h, fixed, want: [w, h, scale]}) → a reason or None. Re-run 15: the
    explorer's frames showed only the top-left of the page (the layout viewport was not the recording's) — the
    agent and the proofs were blind to the right / bottom of the screen (the viewer's Markup toolbar)."""
    if not isinstance(vp, dict) or not vp.get("want"):
        return None
    w0, h0 = vp["want"][0], vp["want"][1]
    if vp.get("w") and vp.get("h") and (abs(vp["w"] - w0) > 2 or abs(vp["h"] - h0) > 2):
        return f"viewport {vp['w']}x{vp['h']} is not the recording's {w0}x{h0} (frames would be cropped)"
    return None


# ───────────────────────── B: the asset audit (before reuse / before recording) ─────────────────────────

_OBJECT_LIST = re.compile(r"(?:with an? [\w -]{2,30} clearly visible[, ]*){2,}", re.I)
_INTERNAL = re.compile(r"\bin-app\b|\basset\b|\b[a-z]+_[a-z]+(?:_[a-z]+)*\b|\bthe planner\b|\bresult:", re.I)
_CHROME = re.compile(r"\b(?:screenshot|collage|side[- ]by[- ]side|split[- ]screen|app interface|clean app interface|"
                     r"interface layout|mock-?up|grid of|composite view)\b", re.I)
_MULTI = re.compile(r"\b(?:merge[ds]?|merging|combine[ds]?|combining|blend(?:s|ed)?)\b|\b(?:two|three|four|several)\s+"
                    r"(?:\w+\s+){0,2}(?:photos|images|pictures|sources)\b", re.I)


def _nw(t):
    return " ".join(re.findall(r"[a-z0-9']+", str(t or "").lower()))


def audit_asset(row, script_prompts=(), tool_of=None, tools=None):
    """One produced asset row (assets.json / <id>.produced.json) → [{"rule", "why"}] — what makes it unfit, checked
    by code (no API call). tool_of: desc → the tool the picture is the result of (producer.tool_of)."""
    out = []
    if not isinstance(row, dict) or row.get("status") != "ready":
        return out
    src = row.get("source") or {}
    prompt = str(src.get("prompt") if src.get("prompt") is not None else row.get("prompt") or "")
    desc = str(row.get("desc") or "")
    made = list(row.get("made_from") or [])
    np_ = _nw(prompt)
    # his on-screen words, verbatim (a prompt that is HIS is exempt from the internal-words rule)
    his = [q for q in script_prompts or [] if _nw(q) and _nw(q) in np_]
    is_input = str(row.get("id") or "").endswith("_input") or (row.get("look") == "real" and not made)
    for q in [] if is_input else script_prompts or []:
        nq = _nw(q)
        head = " ".join(nq.split()[:3])
        qs = nq.split()
        kept = sum(1 for x in qs if x in set(np_.split())) / max(1, len(qs))
        # his words REWRITTEN (the planner's 'a single-line prompt naming all objects'): his opening, then less than 70 %
        # of his words. A spoken variant of the same words (chilli / chillies, a / the) is not a rewrite.
        if nq and len(qs) >= 5 and head and head in np_ and nq not in np_ and kept < 0.7:
            out.append({"rule": "verbatim", "why": f"his on-screen prompt '{q[:60]}' is not typed word for word"})
            break
    if "\n" in prompt.strip():
        out.append({"rule": "one_line", "why": "a typed prompt with a newline (a newline can send early)"})
    if _OBJECT_LIST.search(prompt):
        out.append({"rule": "object_list", "why": "the internal object list ('… clearly visible …') was typed"})
    elif not his and prompt and _INTERNAL.search(prompt):
        out.append({"rule": "internal", "why": f"internal words in the typed prompt ('{_INTERNAL.search(prompt).group(0)}')"})
    asked = re.sub(r"(?:^|(?<=[.!?;]))\s*(?:no|without|never|not|avoid)\b[^.!?;]*", " ", prompt, flags=re.I)  # "No … collage panels."
    if asked.strip() and _CHROME.search(asked) and not _CHROME.search(desc):
        out.append({"rule": "collage", "why": f"the prompt asks for '{_CHROME.search(asked).group(0)}' (a fake UI / collage)"})
    if _MULTI.search(desc) and len(made) < 2 and not src.get("reused"):
        out.append({"rule": "merge_sources", "why": f"a merge of several pictures made from {len(made)} source(s)"})
    if is_input and his:
        out.append({"rule": "input_result_prompt", "why": "an input photo he brings was made with his on-screen RESULT prompt"})
    tool = tool_of(desc) if callable(tool_of) else None
    used = src.get("tool")
    if tool or used:
        on_source = ((tools or {}).get(tool or used) or {}).get("on_source", True)
        if tool and used and tool != used:
            out.append({"rule": "wrong_tool", "why": f"made with the {used} tool; its description names {tool}"})
        if src.get("via") != "tool" and not str(src.get("recipe") or "").startswith("produce_edit:") or src.get("fallback"):
            out.append({"rule": "tool_not_tool", "why": f"a {tool or used} result not made by the app's tool ({src.get('route')})"})
        elif on_source and not made:
            out.append({"rule": "tool_no_source", "why": f"a {tool or used} result with no source picture"})
    return out


def set_aside(out, aid, why):
    """The repair for an unfit asset: its side file and picture are moved aside (kept, never deleted) so the next
    routing makes it again. → the new names."""
    out = Path(out)
    ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    moved = []
    for p in (out / "assets" / f"{aid}.produced.json", out / "assets" / f"{aid}.png"):
        if p.exists():
            dst = p.with_name(f"{p.name}.set-aside-{ts}")      # never *.produced.json again (never resurrected)
            p.rename(dst)
            moved.append(dst.name)
    try:
        log_p = out / "set-aside.jsonl"
        with open(log_p, "a") as f:
            f.write(json.dumps({"ts": time.time(), "asset": aid, "why": why, "moved": moved}) + "\n")
    except OSError:
        pass
    return moved


def audit_assets(out, assets, script_prompts=(), tool_of=None, tools=None, log=print, repair=True):
    """Every ready asset of assets.json audited; an unfit one is set aside (repair) and marked so routing remakes it.
    → [{"asset", "problems"}]."""
    found = []
    for a in (assets or {}).get("assets") or []:
        probs = audit_asset(a, script_prompts, tool_of, tools)
        if not probs:
            continue
        found.append({"asset": a.get("id"), "problems": probs})
        log(f"preflight (assets): {a.get('id')} — " + "; ".join(p["why"] for p in probs)[:300]
            + (" — set aside, made again" if repair else ""))
        if repair:
            set_aside(out, a.get("id"), "; ".join(p["rule"] for p in probs))
            a["status"], a["set_aside"] = "set_aside", [p["rule"] for p in probs]
    return found


# ───────────────────────── C: the playbook audit (this video's playbook, before recording) ─────────────────────────

def audit_playbook(pb):
    """This video's playbook → [{"action", "rule", "why", "fixed"}]: proof gaps found by code. Safe ones are fixed as
    data in place (a confirm-after-stroke marked presence-only, a step whose requires cannot be built named)."""
    from . import playbook as PB
    out = []
    acts = (pb or {}).get("actions") or {}
    for aid, a in acts.items():
        k = a.get("kind")
        if k == "drag" and not any(isinstance(a.get(x), (list, dict)) for x in ("rel_from", "from", "points", "rel")) \
                and not any(x in (a.get("params") or {}) for x in ("rel_from", "from")):
            out.append({"action": aid, "rule": "drag_points_data", "why": "a drag whose points are data at use time "
                        "(the replay uses a neutral centre box; the producer passes the located points)", "fixed": False})
        if k == "draw" and not a.get("strokes") and "strokes" not in (a.get("params") or {}):
            out.append({"action": aid, "rule": "draw_strokes_data", "why": "a draw whose strokes are data at use time "
                        "(the proof draws one sample stroke)", "fixed": False})
        for r in a.get("requires") or []:
            if r not in acts:
                out.append({"action": aid, "rule": "requires_unknown", "why": f"requires unknown action {r}", "fixed": False})
                continue
            try:
                PB.resolve(pb, r, {})
            except PB.PlaybookError as e:
                out.append({"action": aid, "rule": "requires_unbuildable", "why": f"requires {r}: {e} (a failed step at "
                            "use time, never a crash)", "fixed": False})
        if a.get("generates") and len([x for x in a.get("replays") or [] if x.get("ok")]) > 1 \
                and "presence" not in str((a.get("video_proof") or {}).get("mode", "")):
            out.append({"action": aid, "rule": "generating_pressed", "why": "a generating step proven by pressing it "
                        "(should be presence)", "fixed": False})
    for name, t in (((pb or {}).get("produce") or {}).get("tools") or {}).items():
        for i, st in enumerate(t.get("steps") or []):
            need = str(st.get("need") or "")
            if need and re.search(r"\b(?:click|press)\b[^.]{0,30}\b(?:send|submit)\b", need, re.I) and not st.get("generates"):
                out.append({"action": f"{name}.{i}", "rule": "need_folds_send", "why": "a step need with a send in it",
                            "fixed": False})
    return out


# ───────────────────────── D: run control (before the expensive stage) ─────────────────────────

def headroom(job, n_needs, per_need_usd=0.6, cap_usd=None, workflow="creative"):
    """Before routing (onboarding + producing ~n needs): raise apiledger.BudgetExceeded NOW when the job / daily cap
    cannot fit the estimate — the job waits (daily) or is held 'API cap' (job) before it starts, never half-routed."""
    from . import apiledger
    est = float(n_needs) * float(per_need_usd)
    if cap_usd is not None:
        est = min(est, float(cap_usd))
    if est <= 0:
        return 0.0
    apiledger.check(job, est, workflow)
    return round(est, 4)


# ───────────────────────── fallback: never a silent drop ─────────────────────────

def _phrases(text, n=2):
    ws = str(text or "").split()
    out = []
    for k in range(0, min(len(ws), 18), 6):
        p = " ".join(ws[k:k + 4]).strip(" ,.;:")
        if len(p) >= 3:
            out.append(p[:60])
        if len(out) >= n:
            break
    return out or [str(text or "")[:40]]


def fallback_event(seg, assets, video, why):
    """A screencast that cannot be recorded → an approved motion template of its step in the app's UI kit (the REAL
    result when there is one), or None (then the presenter shows it — logged as such by the caller).
    → (event | None, note)."""
    from . import director, motiontemplates as MT
    beats = seg.get("beats") or []
    prompt = next((str((b.get("params") or {}).get("text") or "") for b in beats
                   if b.get("action") in ("paste_prompt", "type_prompt", "paste", "type") and (b.get("params") or {}).get("text")), "")
    by = {a.get("id"): a for a in (assets or {}).get("assets") or []}
    res = None
    for b in beats:
        aid = (b.get("params") or {}).get("asset") or b.get("asset_id")
        if aid and (by.get(aid) or {}).get("status") == "ready":
            res = by[aid]
    app = seg.get("app")
    words = [w for w in video.get("words") or [] if seg["t0"] - 0.05 <= w["start"] < seg["t1"]]
    start, end = (words[0]["i"], words[-1]["i"]) if words else (None, None)
    cands = []
    if res is not None and prompt and MT.is_on("prompt_result"):
        cands.append("prompt_result")
    if prompt:
        cands.append(director.p4_template(prompt))
    for tid in cands:
        if not MT.is_on(tid):
            continue
        fields = {"prompt": prompt[:MT.spec(tid)["params"]["prompt"].get("max_chars", 440)], "app": app}
        if tid == "prompt_result":
            fields["result_asset"] = res.get("id")
        else:
            fields["phrases"] = _phrases(prompt, 2 if tid == "prompt_highlight" else 3)
        params, errs = MT.validate_params(tid, fields)
        if errs:
            continue
        lo, hi = MT.spec(tid)["duration_s"]
        t0 = float(seg["t0"])
        t1 = min(max(float(seg["t1"]), t0 + lo), t0 + hi, float(video.get("duration") or 1e9))
        if tid == "prompt_result":
            rv = MT.result_view(res)
            if not rv:
                continue
            params = {**params, "result": rv}
        ev = {"template": tid, "t0": round(t0, 3), "t1": round(t1, 3), "start": start, "end": end, "fields": fields,
              "params": params, "technique": MT.TECHNIQUE[tid], "kit": app,
              "fallback": {"why": str(why)[:300], "screencast_t": [seg["t0"], seg["t1"]], "result_asset": (res or {}).get("id")},
              "why": f"screencast could not be recorded ({str(why)[:120]}) — its step shown with an approved motion template"
                     + (" and the REAL result" if tid == "prompt_result" else "")}
        return ev, f"{tid} ({MT.TECHNIQUE[tid]})" + (f" + the real result {res.get('id')}" if tid == "prompt_result" else "")
    return None, "no approved motion template fits this step (no typed prompt) — the presenter shows it"


def fallbacks(segs, recordings, assets, video, out_dir=None, log=print):
    """Every screencast whose recording is not ok → its fallback event (or a logged presenter fallback). Writes
    <out_dir>/fallbacks.json. → (events, rows)."""
    evs, rows = [], []
    for i, seg in enumerate(segs):
        doc = (recordings or {}).get(i) or (recordings or {}).get(str(i))
        if doc is None or doc.get("status") == "ok":
            continue
        why = f"{doc.get('status')}: {str(doc.get('why') or '')[:200]}"
        ev, note = fallback_event(seg, assets, video, why)
        row = {"screencast": i + 1, "t0": seg.get("t0"), "t1": seg.get("t1"), "why": why, "fallback": note,
               "template": (ev or {}).get("template")}
        rows.append(row)
        if ev:
            evs.append(ev)
        log(f"fallback: screencast {i + 1} ({seg.get('t0'):.1f}–{seg.get('t1'):.1f}s) — {why[:140]} → {note}")
    if out_dir is not None:
        try:
            Path(out_dir).mkdir(parents=True, exist_ok=True)
            (Path(out_dir) / "fallbacks.json").write_text(json.dumps({"fallbacks": rows}, indent=1))
        except OSError:
            pass
    return evs, rows


DOC = """# The self-healing layer (Auto Editor)

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

"""


def write_doc(path=None):
    p = Path(path) if path else Path(__file__).resolve().parent.parent / "docs" / "SELF-HEALING.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(DOC + coverage_markdown() + "\n")
    return p
