"""BEAT COMPILER + ELASTIC ASSEMBLER — what is on screen is decided and proven before recording, and WHEN it
appears is calculated by code from Jake's word timings (architecture recommendation §3.3-3.5, step 5).

The old recorder was a live LLM choosing ONE action at a time and its own "at": every fumble, retype, hover
and reload was recorded, presses landed 7-29 s off their word (60 word-matched events of the rejected job:
median +0.23 s, only 25/60 inside -0.2..+1.4 s) and generations ran live for ~3 h in one account.

  1. COMPILER  plan-schema beats (schemas/plan.schema.json) whose action is a PLAYBOOK action id
               (playbooks/<app>.json, proven 3/3) -> one compiled script per segment:
       * the cursor starts moving at word - 0.8 s (band 0.5-0.9, never before the clause start);
       * the press lands on the recorder frame just before the word's own frame (word - 0.05 s on the
         frame grid: -0.033..0 s, inside the reference band -0.15..0 — BASELINE §2b, RULEBOOK C1/C2);
       * a type beat is ONE paste into a cleared field, asserted equal to the script (C3, K1);
       * a result is an asset made OFF CAMERA (assets.json), revealed by a K2 6 f time-skip dissolve at
         word + 0.65 s (BASELINE §2c, sync/G1 r3 5:14.05 +0.59 s); its press is a dry press;
       * at most ONE live generation per video: its in-progress state is held only while Jake talks about
         the wait (wait_talk, 3.5-6 s; sync/G3 r5 6:59.84, sync/G4 r5 5:26.7), then a dissolve on the payoff;
       * no still > 3 s (a camera hold is inserted on the last named target);
       * every beat carries its start_state and an expected end state (text asserts + a 64-bit dHash
         fingerprint filled in by the rehearsal), so ONE beat can be reset and re-recorded on its own.
     An action that is not in the app's playbook (or not proven 3/3) is never improvised: the beat is
     NEEDS_PRIMITIVE and the job is held (no silent drop, no A-roll stand-in).
  2. ELASTIC ASSEMBLER  the take's events (actual press frames) + the words -> a frame map in which ONLY
     motionless frames (pixel frame-diff below a threshold measured on the take, and no cursor travel) are
     dropped or repeated, so each press lands on its word +-1 frame and each result inside +0.2..+1.4 s.
     Too few idle frames = a TIMING failure (remedy: reassemble -> re-record the beat). It re-times the
     SCREEN clip only; the narration audio is never touched (R11: no pause is trimmed, no cut is added).

Legacy free-text intents ("on 'X': do Y", the director before the single plan call) are converted by the
regex ledger ONLY when asked (beats_from_intent: offline acceptance on stored jobs); in factory mode a
segment without plan-schema beats is needs_primitive. Everything here is pure and unit-tested.
"""
import math
import re
import statistics

FPS = 30000 / 1001


def _sync():
    try:
        from . import skill
        return skill.rules().get("sync", {})
    except Exception:  # noqa: BLE001 — the numbers below are the same rules.json values
        return {}


_S = _sync()
CURSOR_LEAD = float(_S.get("cursor_lead_aim_s", 0.8))            # cursor move starts word - 0.8 s
CURSOR_BAND = tuple(_S.get("cursor_lead_s", (0.5, 0.9)))
PRESS_LEAD = 0.05                                                # aim; quantised to the frame grid (press_at)
PRESS_BAND = tuple(_S.get("press_offset_s", (-0.15, 0.0)))
RESULT_BAND = tuple(_S.get("result_after_s", (0.2, 1.4)))
RESULT_TARGET = float(_S.get("result_median_s", 0.7))
K2_AFTER = 0.65                                                  # inside k2_after_word_s 0.5-0.8
K2_FRAMES = 6                                                    # inside k2_dissolve_f 3-8
MAX_STILL = float(_S.get("max_still_s", 3.0))
LIVE_SHOW = tuple(_S.get("live_wait_s", (3.5, 6.0)))
SETTLE_S = 0.12                     # agent_rec.mjs: the cursor rests this long on its target before the press
FULL_SCREEN = (0, 0, 1280, 720)     # a camera beat with no named target frames the whole screen (screenshot px)

PRESS_KINDS = ("click", "type", "paste", "key", "upload", "drag", "draw")
CAMERA = ("camera", "read", "zoom", "hold", "pan", "ease")       # built-in: frames what is there, changes nothing
# the plan call's two code primitives (director.CAMERA_ACTIONS / OUTSIDE_ACTIONS): never playbook actions
CAMERA_PRIMITIVES = ("camera.zoom",)
OUTSIDE_GOTO = "outside.goto"


def is_camera(aid):
    return aid in CAMERA or aid in CAMERA_PRIMITIVES
EDIT_KEYS = re.compile(r"^(?:(?:control|ctrl|meta|cmd|shift)\+)*(?:a|backspace|delete|home|end|arrowleft|arrowright)$", re.I)
NEEDS_PRIMITIVE = "needs_primitive"
NEEDS_ASSET = "needs_asset"


class CompileError(ValueError):
    kind = "compile"

    def __init__(self, msg, beats=None):
        super().__init__(msg)
        self.beats = beats or []


class NeedsPrimitive(CompileError):
    """A beat names an action the app's playbook does not have (or has not proven 3/3): the job is held
    until the onboarding agent adds and proves it off camera — never improvised, never A-roll."""
    kind = NEEDS_PRIMITIVE


# ───────────────────────── words ─────────────────────────

def norm(w):
    w = str(w).lower().replace("@", "at ").replace("’", "'")
    return re.sub(r"[^a-z0-9%' ]", "", w).strip()


def toks(text):
    return [t for t in norm(text).replace("'s", "s").split() if t]


def _eq(a, b):
    a, b = a.replace("'", ""), b.replace("'", "")
    return a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a)))


def clause_start(words, k):
    """Index of the first word of the clause holding words[k]: back to the previous , ; : . ? ! or a
    >= 0.35 s pause (= planfit)."""
    j = k
    while j > 0 and k - j < 25:
        prev = words[j - 1]
        if re.search(r"[,;:.?!]$", prev["word"]) or words[j]["start"] - prev["end"] >= 0.35:
            break
        j -= 1
    return j


def find_cue(words, cue, lo, hi, start_k=0):
    """Index of the word that starts the cue phrase inside [lo, hi] (output seconds), searched in order."""
    ct = toks(cue)
    if not ct:
        return None
    best, best_n = None, 0
    for k in range(start_k, len(words)):
        w = words[k]
        if w["start"] < lo:
            continue
        if w["start"] > hi:
            break
        n, j = 0, k
        for t in ct:
            while j < len(words) and not toks(words[j]["word"]):
                j += 1
            if j < len(words) and any(_eq(t, x) for x in toks(words[j]["word"])):
                n += 1
                j += 1
            else:
                break
        if n > best_n:
            best, best_n = k, n
            if n == len(ct):
                break
    return best if best_n >= max(1, min(2, len(ct))) or (best_n == 1 and len(ct) == 1) else None


# ───────────────────────── timing on the recorder's frame grid ─────────────────────────

def pressed_frame(at, fps=FPS):
    """The first recorded frame that shows a press scheduled at `at` (agent_rec.mjs holdUntil: frames are
    stepped until frame/fps >= at - 1e-6, then the page is pressed)."""
    return max(0, math.ceil(at * fps - 1e-6 * fps - 1e-9))


def press_at(t_rel, fps=FPS):
    """Segment-relative press time for a word starting at t_rel: the frame just before the word's own frame
    (= word - PRESS_LEAD on the frame grid, -0.033..0 s from the word)."""
    k = pressed_frame(t_rel, fps) - 1
    while k > 0 and t_rel - k / fps < 1e-9:
        k -= 1
    k = max(0, k)
    return round(k / fps, 6)


def cursor_plan(t_word_rel, at, floor_rel):
    """(cursor_at, travel_ms, settle_s): the cursor starts at max(floor, word - CURSOR_LEAD) — never before the
    clause start — and arrives SETTLE_S (or a third of a short window) before the press."""
    cur = max(floor_rel, t_word_rel - CURSOR_LEAD, 0.0)
    cur = min(cur, at)
    win = max(0.0, at - cur)
    settle = min(SETTLE_S, win / 3)
    travel = max(0.0, win - settle)
    return round(cur, 6), int(round(travel * 1000)), round(settle, 4)


# ───────────────────────── 1. legacy intents -> plan-schema beats (offline only) ─────────────────────────

GENERATING = re.compile(r"\b(remove ?bg|remove background|square 1:1|portrait 3:4|story 9:16|landscape 4:3|widescreen 16:9)\b", re.I)
SEND = re.compile(r"\b(click (?:the )?send(?: button)?|hit send|click the (?:round )?(?:blue )?arrow|press enter|hit enter|send it)\b", re.I)
COUNTER = re.compile(r"\b(percentage|percent|counter|loading|progress)\b|\d+%", re.I)
SHAPES = (("bottle", "bottle"), ("picnic table", "table"), ("table", "table"), ("sun", "sun"), ("chili", "pepper"),
          ("pepper", "pepper"), ("tree", "tree"), ("cloud", "cloud"), ("house", "house"), ("person", "person"))
PAYOFF = re.compile(r"\b(finished|appears|result|done|dissolve|lands|landed|ready)\b", re.I)


def shape_of(text):
    t = " " + norm(text) + " "
    return next((shape for w, shape in SHAPES if f" {w} " in t or f" {w}s " in t), None)


def parse_intent(intent):
    """Director intent "on 'X': do Y; on 'Z': …" -> [{cue, body}] (+ the preamble before the first cue)."""
    s = str(intent or "")
    pos = [m for m in re.finditer(r"(?:^|[;.]\s*|\s)[Oo]n '", s)]
    out, pre = [], s[:pos[0].start()].strip() if pos else s.strip()
    for k, m in enumerate(pos):
        start = m.end()
        end = pos[k + 1].start() if k + 1 < len(pos) else len(s)
        chunk = s[start:end]
        c = chunk.find("':")
        if c < 0:
            continue
        out.append({"cue": chunk[:c], "body": chunk[c + 2:].strip().rstrip(";").strip()})
    return out, pre


def quoted(body):
    """The scripted text of a typing beat: the quoted string that is pasted / typed."""
    m = re.search(r"(?<![A-Za-z])'(.+?)'(?=\s+(?:pasted|typed|is typed|is pasted|after)\b|\s*(?:[;.]\s*)?$)", body)
    return m.group(1) if m else None


def classify(body, preamble=""):
    b = body.lower()
    q = quoted(body)
    if re.search(r"\bdissolve to\b", b):
        return "reveal", None
    if SEND.search(b):
        return "send", None
    if q is not None and (re.search(r"\b(pasted|typed|type)\b", b) or body.strip().startswith("'") or "pasted" in preamble.lower()):
        return "type", q
    m = re.search(r"\bclick (?:on )?(?:the )?(.+?)(?:\s+(?:tab|button|feature|tool|template))?(?:,|$| so | and | then )", body, re.I)
    if m and GENERATING.search(m.group(1)):
        return "gen_click", None
    if re.search(r"\b(dragged|drag)\b", b):
        return "drag", None
    if re.search(r"\b(drawn|draw|lines under|brush over|brushes over)\b", b):
        return "draw", None
    if re.search(r"\bpin (drops|on)\b|\ba pin\b", b):
        return "click", None
    if re.search(r"\b(attached|upload)\b", b):
        return "upload", None
    if re.search(r"\bcut to https?://", b) or re.search(r"\bgoto https?://", b):
        return "goto", None
    if m:
        return "click", None
    if re.search(r"\bpress (escape|enter)\b", b):
        return "key", None
    return "camera", None


def click_label(body):
    m = re.search(r"\bclick (?:on )?(?:the )?(.+?)(?:\s+(?:tab|button|feature|tool|option))?(?=,|;|\.|$| so | and | then | to )", body, re.I)
    return m.group(1).strip(" '\"") if m else None


def _kind_action(pb, kind):
    return next((aid for aid, a in (pb or {}).get("actions", {}).items() if a.get("kind") == kind), None)


def live_counter_window(seg, words, typed_before):
    """Legacy: the ONE live generation a video may keep is where the narration talks about the progress
    counter ("a percentage counter while it works … 40%, then 65"). -> {"t0", "t1"} of the wait talk
    (clamped to LIVE_SHOW) or None. It needs a prompt typed in this segment before it."""
    ks = [k for k, w in enumerate(words) if seg["t0"] <= w["start"] <= seg["t1"] and COUNTER.search(w["word"])]
    if len(ks) < 2:
        return None
    k_first, k_last = ks[0], ks[-1]
    ws_k = clause_start(words, k_first)
    e = k_last
    while e + 1 < len(words) and not re.search(r"[.?!]$", words[e]["word"]) and words[e + 1]["start"] <= seg["t1"]:
        e += 1
    we, ws = words[e]["end"], words[ws_k]["start"]
    if we - ws > LIVE_SHOW[1]:
        ws_k = next(k for k in range(ws_k, e + 1) if words[k]["start"] >= we - LIVE_SHOW[1])
        ws = words[ws_k]["start"]
    if we - ws < LIVE_SHOW[0]:
        we = ws + LIVE_SHOW[0]
    if not any(t < ws for t in typed_before):
        return None
    return {"t0": round(ws, 3), "t1": round(we, 3), "word_id": ws_k}


def beats_from_intent(seg, words, pb, seg_idx=0):
    """OFFLINE ONLY (stored jobs planned before the single plan call): the director's free-text intent ->
    plan-schema beats with PLAYBOOK action ids. A beat no playbook action covers keeps action
    "unmapped:<kind>" so the compiler reports it as needs_primitive (never improvised)."""
    from . import playbook as PB
    beats, pre = parse_intent(seg.get("intent", ""))
    out, k0 = [], 0
    for n, b in enumerate(beats):
        k = find_cue(words, b["cue"], seg["t0"] - 0.6, seg["t1"] + 0.3, k0)
        if k is None:
            continue
        k0 = k
        c = clause_start(words, k)
        kind, typed = classify(b["body"], pre)
        row = {"id": f"s{seg_idx:02d}b{n:02d}", "seg": seg_idx, "cue": b["cue"], "body": b["body"], "word_id": words[k].get("i", k),
               "word": words[k]["word"], "t_word": words[k]["start"], "clause_start": words[c]["start"], "params": {}}
        text = f"{b['cue']} :: {b['body']}"
        if kind == "type":
            row.update(action=_kind_action(pb, "paste") or "unmapped:type", typed_text=typed)
            row["params"]["text"] = typed
        elif kind == "send":
            row["action"] = "send" if "send" in pb.get("actions", {}) else "unmapped:send"
        elif kind == "reveal":
            row["action"] = _kind_action(pb, "reveal") or "unmapped:reveal"
        elif kind in ("drag", "draw", "upload"):
            row["action"] = _kind_action(pb, kind) or f"unmapped:{kind}"
            if kind == "draw":
                row["subject"] = f"shape:{shape_of(text) or ''}"
        elif kind == "camera":
            lab = None
            m = re.search(r"\b(?:zoom|cursor|hover)\w* (?:on|over|rests on) (?:the )?([A-Z][\w ]{1,30})", b["body"])
            if m:
                lab = m.group(1).strip()
            row.update(action="camera", subject=f"ui:{lab}" if lab else "screen")
        else:                                     # click / gen_click / key / goto: the playbook's own words decide
            m = PB.match_beat(pb, text, "outside" if (seg.get("session") or {}).get("kind") in ("public", "outside") else "logged_in")
            if m.get("status") == "action":
                row["action"] = m["action"]
                lab = click_label(b["body"])
                if lab and "{shape}" in str(pb["actions"][m["action"]].get("selectors")):
                    row["params"]["shape"] = next((s for s in (pb["actions"][m["action"]].get("params", {}).get("shape", {})
                                                               .get("enum") or []) if s.lower().startswith(lab.lower()[:5])), lab)
            elif m.get("status") == "camera" and kind != "click":
                row.update(action="camera", subject="screen")
            else:
                row.update(action=f"unmapped:{kind}", why=m.get("why") or "no playbook action shows this")
        out.append(row)
    # on a drawing surface every later camera beat that names a doodled thing is DRAWN on its word
    if any(r["action"] == _kind_action(pb, "draw") and _kind_action(pb, "draw") for r in out):
        first = next(i for i, r in enumerate(out) if r["action"] == _kind_action(pb, "draw"))
        for r in out[first + 1:]:
            if r["action"] in PRESS_KINDS or (r["action"] in pb.get("actions", {}) and r["action"] != _kind_action(pb, "draw")):
                break
            if r["action"] == "camera" and shape_of(f"{r['cue']} {r['body']}"):
                r.update(action=_kind_action(pb, "draw"), subject=f"shape:{shape_of(r['cue'] + ' ' + r['body'])}")
    # the ONE live generation (legacy: where he talks about the progress counter)
    typed = [r["t_word"] for r in out if r["action"] == _kind_action(pb, "paste")]
    win = live_counter_window(seg, words, typed)
    if win:
        sends = [r for r in out if r["action"] == "send" and r["t_word"] < win["t1"]]
        if sends:
            sends[-1].update(live=True, wait_talk={"t0": win["t0"], "t1": win["t1"]})
        else:
            w = words[win["word_id"]]
            out.append({"id": f"s{seg_idx:02d}live", "seg": seg_idx, "cue": w["word"], "body": "the live send", "action": "send",
                        "word_id": w.get("i", win["word_id"]), "word": w["word"], "t_word": w["start"],
                        "clause_start": win["t0"], "params": {}, "live": True,
                        "wait_talk": {"t0": win["t0"], "t1": win["t1"]}})
            out.sort(key=lambda r: r["t_word"])
    return out


# ───────────────────────── 2. rehearsal / repair steps -> playable list ─────────────────────────

def rehearsal_targets(steps):
    """What a rehearsal (agent-steps.json shape) learnt: per label the selector hint / coordinates that worked.
    Failed steps, edit keys and retypes teach nothing (they are the fumbles that must never be recorded)."""
    t = {"composer": None, "labels": {}}
    for h in steps or []:
        a, ok = h.get("action") or {}, h.get("result") == "ok"
        if not ok:
            continue
        res = h.get("resolved") or {}
        if a.get("type") == "type":
            if res.get("hint"):
                t["composer"] = {"selector": res["hint"]}
            elif t["composer"] is None and a.get("x") is not None:
                t["composer"] = {"x": a["x"], "y": a["y"]}
        if a.get("type") == "drag" and a.get("from") and a.get("to"):
            t.setdefault("drags", []).append({"from": a["from"], "to": a["to"]})
        lab = (res.get("label") or "").strip()
        if lab and a.get("type") in ("click", "dblclick", "hover", "read"):
            t["labels"].setdefault(lab.lower(), {"selector": res.get("hint")} if res.get("hint") else {"target": lab})
    return t


def compile_rehearsal(steps):
    """A rehearsal / an agent's steps cleaned into a playable list (no LLM): failed steps, observe/hover/hold
    fumbles and edit keys dropped, consecutive retypes of the same text collapsed, every type forced to clear
    first and to paste whole (C3) — the seg-03 '@Sketch@Sketch@Sketch' and seg-10 appended prompts."""
    out = []
    for h in steps or []:
        a = dict(h.get("action") or {})
        if h.get("result") != "ok" or not a.get("type"):
            continue
        if a["type"] in ("observe", "hover", "move", "hold"):
            continue
        if a["type"] == "key" and EDIT_KEYS.match(str(a.get("key", ""))):
            continue
        if a["type"] == "type":
            a.update(clear=True, paste=True)
            if out and out[-1]["type"] == "click" and (out[-1].get("ref") == a.get("ref") or out[-1].get("x") == a.get("x")):
                out.pop()
            txt = str(a.get("text") or "")
            k = next((j for j in range(len(out) - 1, -1, -1) if out[j]["type"] == "type" and str(out[j].get("text") or "")
                      and txt.startswith(str(out[j].get("text")))
                      and (out[j].get("text") == txt or str(out[j].get("text")).strip().startswith("/"))
                      and not any(x["type"] == "type" and x.get("enter") for x in out[j:])
                      and not any(x["type"] == "click" and x.get("generates") for x in out[j + 1:])), None)
            if k is not None:
                del out[k:]
        elif a["type"] in ("click", "dblclick") and out and out[-1]["type"] == a["type"] and \
                all(out[-1].get(f) == a.get(f) for f in ("ref", "x", "y", "selector", "target")):
            continue
        out.append(a)
    return out


# ───────────────────────── 3. assets ─────────────────────────

def doodle_strokes(svg):
    """preprod.doodle_svg output -> [[[x, y], ...], ...] (the exact wobbly strokes of the asset)."""
    out = []
    for d in re.findall(r'<path d="([^"]+)"', svg):
        pts = [[float(x), float(y)] for x, y in re.findall(r"(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)", d)]
        if len(pts) >= 2:
            out.append(pts)
    return out


def doodles_from(assets, doodle_svg):
    """Per doodled item of every sketch asset: {"shape", "strokes"} (strokes in the 1024 doodle space)."""
    out = []
    for a in (assets or {}).get("assets", []):
        items = ((a.get("source") or {}).get("doodle") or a.get("doodle") or []) if a.get("kind") == "sketch" else []
        for k, it in enumerate(items):
            out.append({"shape": it.get("shape"), "asset": a.get("id"),
                        "strokes": doodle_strokes(doodle_svg([it], seed=sum(map(ord, a.get("id", ""))) + k))})
    return out


def upload_asset(beat, assets):
    """The assets.json file an upload beat attaches: the asset_id, else the ready photo / element / sketch whose
    id or description shares the most words with the beat."""
    if beat.get("asset_id"):
        return beat["asset_id"]
    bt = set(toks(f"{beat.get('body', '')} {beat.get('cue', '')}")) - {"the", "a", "an", "photo", "image", "with", "new", "chat"}
    best, score = None, 0
    for a in (assets or {}).get("assets", []):
        if a.get("kind") not in ("photo", "element", "sketch") or not a.get("file"):
            continue
        n = len(bt & set(toks(f"{a.get('id', '').replace('_', ' ')} {a.get('desc', '')}")))
        if n > score:
            best, score = a["id"], n
    return best


def asset_for(beat, prev_typed, assets, seg_idx):
    """The assets.json row holding this result (made off camera). A missing one is ADDED as 'needed' so
    pre-production makes it before recording — never generated on camera; the recorder holds the segment
    (needs_asset) until it is ready."""
    rows = assets.setdefault("assets", [])
    aid = beat.get("asset_id") or (str(beat.get("subject"))[6:] if str(beat.get("subject") or "").startswith("asset:") else None)
    if aid and any(a.get("id") == aid for a in rows):
        return aid
    for a in rows:
        src = a.get("source") or {}
        if prev_typed and (src.get("prompt") or a.get("prompt") or "").strip() == prev_typed.strip():
            return a["id"]
    aid = aid or f"seg{seg_idx:02d}-{beat.get('id', 'beat')}-result"
    if not any(a.get("id") == aid for a in rows):
        rows.append({"id": aid, "kind": "app_generation", "status": "needed",
                     "source": {"made_from": [], "prompt": prev_typed, "beat": beat.get("id"),
                                "why": "result revealed with a K2 time-skip (made off camera)"}})
    return aid


def asset_ready(assets, aid):
    a = next((x for x in (assets or {}).get("assets", []) if x.get("id") == aid), None)
    return bool(a) and a.get("status", "ready") not in ("needed", "failed", "missing")


# ───────────────────────── 4. the compiler ─────────────────────────

def _playbook_actions(pb, allow_unproven=None):
    """(all actions, usable ids): usable = proven n/n, unless rules.json playbooks.allow_unproven."""
    acts = (pb or {}).get("actions", {})
    if allow_unproven is None:
        try:
            from . import skill
            allow_unproven = bool(skill.rules().get("playbooks", {}).get("allow_unproven", False))
        except Exception:  # noqa: BLE001
            allow_unproven = False
    return acts, {k for k, a in acts.items() if a.get("proven") or allow_unproven}


def _resolve(pb, aid, params):
    from . import playbook as PB
    try:
        return PB.resolve(pb, aid, params)
    except PB.PlaybookError as e:          # a beat the playbook cannot run as planned: blocked (held), never a crash
        raise CompileError(f"{aid}: {e}") from e


def fill_params(action, params, beat):
    """The plan call names an action, its typed text and url, not every playbook param: a required param with
    an enum (resize_option.shape) is read from the beat's own words (subject / text / body) when exactly
    one option is named there. Anything else stays missing and the compile refuses the beat."""
    out = dict(params or {})
    said = " ".join(str(beat.get(k) or "") for k in ("subject", "typed_text", "body", "cue")).lower()
    for name, spec in ((action or {}).get("params") or {}).items():
        if name in out or not spec.get("enum"):
            continue
        hits = [v for v in spec["enum"] if str(v).lower() in said]
        if len(hits) != 1:
            hits = [v for v in spec["enum"] if re.search(r"\b" + re.escape(str(v).split()[0].lower()) + r"\b", said)]
        if len(hits) == 1:
            out[name] = hits[0]
    return out


def _expected_end(pb, aid, params, beat):
    """The end state a beat must leave: the playbook action's post asserts (params filled) + the beat's must_text."""
    a = (pb or {}).get("actions", {}).get(aid) or {}
    if a.get("generates"):
        # a dry press (result made off camera) or the live send: the result step (K2 reveal / live wait) is the
        # check; the playbook's post assert describes a real press
        return [{"kind": "text", "value": t} for t in beat.get("must_text") or []]
    fill = lambda s: re.sub(r"\{(\w+)\}", lambda m: str((params or {}).get(m.group(1), m.group(0))), s) if isinstance(s, str) else s
    out = [{k: fill(v) for k, v in x.items()} for x in a.get("post", []) or []]
    for t in beat.get("must_text") or []:
        out.append({"kind": "text", "value": t})
    return out


def compile_segment(seg, words, pb, seg_idx=0, assets=None, live_left=1, rehearsal=None, doodles=None,
                    allow_unproven=None, url_allow=None):
    """One plan-schema segment -> {"steps", "beats", "live", "assets", "url_allow", "start_state", ...}.
    Step times are SEGMENT seconds (what agent_rec.mjs "at" means). Raises NeedsPrimitive listing EVERY beat
    whose action the playbook lacks / has not proven, CompileError for an impossible beat."""
    t0 = float(seg["t0"])
    dur = float(seg["t1"]) - t0
    rel = lambda x: round(float(x) - t0, 6)
    acts, usable = _playbook_actions(pb, allow_unproven)
    assets = assets if assets is not None else {"assets": []}
    beats = sorted([dict(b) for b in seg.get("beats") or [] if b.get("t_word") is not None], key=lambda b: b["t_word"])
    if not beats:
        raise NeedsPrimitive(f"segment {seg_idx} has no plan-schema beats (the plan must name playbook actions)", [])
    missing = []
    outside_seg = _session_kind(seg) == "outside"
    for b in beats:
        a = b.get("action")
        if is_camera(a):
            continue
        if a == OUTSIDE_GOTO:
            if not outside_seg:
                missing.append({"beat": b.get("id"), "action": a, "status": "missing", "t_word": b["t_word"],
                                "why": "outside.goto runs only in the never-logged-in outside session (RULEBOOK L4)"})
            elif not (b.get("params") or {}).get("url"):
                raise CompileError(f"{b.get('id')}: outside.goto without a url")
            continue
        if outside_seg:
            # the outside view is a fresh, never-logged-in browser: only the code primitives run there
            missing.append({"beat": b.get("id"), "action": a, "status": "missing", "t_word": b["t_word"],
                            "why": f"'{a}' is an in-app action; the outside session only runs outside.goto + camera.zoom"})
            continue
        if a not in acts:
            missing.append({"beat": b.get("id"), "action": a, "status": "missing", "t_word": b["t_word"],
                            "why": b.get("why") or f"'{a}' is not an action of the {pb.get('app')} playbook"})
        elif a not in usable:
            missing.append({"beat": b.get("id"), "action": a, "status": "unproven", "t_word": b["t_word"],
                            "why": f"'{a}' has not replayed {3}/3 (playbook proven: false)"})
    if missing:
        raise NeedsPrimitive("; ".join(f"{m['beat']}: {m['why']}" for m in missing), missing)

    tg = rehearsal_targets(rehearsal) if rehearsal else {"composer": None, "labels": {}, "drags": []}
    drags = iter(tg.get("drags") or [])
    pool = [dict(d) for d in (doodles or [])]
    steps, out_beats = [], []
    prev_typed, used_live, last_target = None, 0, None
    outside = _session_kind(seg) == "outside"
    # the outside view (never logged in, RULEBOOK L4) has no account / app theme / set dressing to prove
    start_state = {"url": seg.get("url") or (pb.get("start_state") or {}).get("url"),
                   "asserts": [] if outside else list((pb.get("start_state") or {}).get("asserts") or []),
                   "set_dressing": [] if outside else list(pb.get("set_dressing") or []), "fingerprint": None}
    gen_results = []          # (press beat, typed, word_t) awaiting their reveal

    def doodle_for(b):
        want = (str(b.get("subject") or "")[6:] if str(b.get("subject") or "").startswith("shape:") else None) \
            or shape_of(" ".join(str(b.get(k) or "") for k in ("body", "cue")))
        d = next((x for x in pool if want and x.get("shape") == want), None)      # never strokes for another thing
        if d is None:
            return None
        pool.remove(d)
        return d["strokes"]

    for n, b in enumerate(beats):
        aid = b["action"]
        a = acts.get(aid) or {}
        kind = "camera" if is_camera(aid) else "goto" if aid == OUTSIDE_GOTO else a.get("kind")
        tw = rel(b["t_word"])
        cs_abs = b.get("clause_start")
        if cs_abs is None:
            k = next((i for i, w in enumerate(words) if abs(w["start"] - b["t_word"]) < 1e-6), None)
            cs_abs = words[clause_start(words, k)]["start"] if k is not None else b["t_word"]
        cs_abs = min(cs_abs, b["t_word"])
        # the cursor may travel through the silence that LEADS INTO its clause (never while the previous clause
        # is still being said): its floor is the end of the word before the clause start
        kc = next((i for i, w in enumerate(words) if abs(w["start"] - cs_abs) < 1e-6), None)
        lead_in = words[kc - 1]["end"] if kc else None
        floor = max(0.0, rel(lead_in if lead_in is not None and lead_in < cs_abs else cs_abs))
        at = press_at(tw)
        cur, travel, settle = cursor_plan(tw, at, floor)
        params = fill_params(a, b.get("params"), b)
        if kind in ("paste", "type") and b.get("typed_text") and "text" not in params:
            params["text"] = b["typed_text"]
        meta = {"beat": True, "beat_id": b.get("id") or f"b{n:02d}", "ledger": n, "word": b.get("word") or b.get("cue"),
                "word_t": tw, "from": round(min(cur, at), 6), "cursor_at": cur}
        i0 = len(steps)
        live = False
        if kind == "camera":
            sub = str(b.get("subject") or "")
            tgt = sub[3:] if sub.startswith("ui:") and sub[3:] else None
            steps.append({"type": "read", "at": tw, **({"target": tgt} if tgt else {"box": list(FULL_SCREEN)}),
                          "glide": False, "ms": int(MAX_STILL * 1000 * 0.8), **meta, "from": round(max(0.0, min(rel(cs_abs), tw)), 6),
                          "camera_only": True})
        elif kind in ("paste", "type"):
            text = params.get("text")
            if not text:
                raise CompileError(f"{meta['beat_id']}: a type beat without its scripted text")
            st = _resolve(pb, aid, params)[0]
            st.update(paste=True, clear=True, enter=False, at=at, travel_ms=travel, settle_s=settle, **meta,
                      assert_={"field_equals": text})
            steps.append(st)
            prev_typed = text
        elif kind == "upload":
            aid_up = upload_asset({**b, **params}, assets)
            if not aid_up:
                raise CompileError(f"{meta['beat_id']}: upload names no file in assets.json (S1: the file must exist first)")
            st = _resolve(pb, aid, {**params, "files": params.get("files") or []})[0]
            st.update(at=at, asset=aid_up, **meta)
            steps.append(st)
        elif kind == "drag":
            dg = ({"from": params["from"], "to": params["to"]} if params.get("from") and params.get("to")
                  else next(drags, None))
            if dg is None:
                raise CompileError(f"{meta['beat_id']}: a drag beat needs from/to (playbook params or a rehearsed drag)")
            st = _resolve(pb, aid, dg)[0]
            st.pop("from", None)
            st.pop("to", None)
            st.update(drag_from=dg["from"], drag_to=dg["to"], at=at, travel_ms=travel, settle_s=settle, **meta)
            steps.append(st)
        elif kind == "draw":
            strokes = params.get("strokes") or doodle_for(b)
            if not strokes:
                raise CompileError(f"{meta['beat_id']}: a draw beat with no strokes — the sketch asset has no "
                                   f"{shape_of(str(b.get('body')) + ' ' + str(b.get('cue')))} (never a blank canvas on camera)")
            st = _resolve(pb, aid, {**params, "strokes": strokes})[0]
            sel = (a.get("selectors") or [None])[0]
            if sel and "box" not in st:
                st["selector"] = sel
            st.update(space=params.get("space", 1024), at=at, **meta)
            steps.append(st)
        elif kind == "reveal":
            src = gen_results.pop(0) if gen_results else (b, prev_typed, tw)
            rid = asset_for(src[0] if src[0] is not b else b, src[1], assets, seg_idx)
            steps.append({"type": "reveal", "asset": rid, "url": f"$asset_url[{rid}]", "frames": K2_FRAMES,
                          "at": round(tw + K2_AFTER, 6), **meta, "result_of": src[0].get("id"),
                          "assert_": {"present_asset": rid}})
        elif kind == "goto":
            st = {"type": "goto", "url": params["url"]} if aid == OUTSIDE_GOTO else _resolve(pb, aid, params)[0]
            st.update(at=tw, cut=True, **meta)
            steps.append(st)
        elif kind == "wait_for":
            st = _resolve(pb, aid, params)[0]
            st.update(at=tw, **meta)
            steps.append(st)
        elif kind == "scroll":
            st = _resolve(pb, aid, params)[0]
            st.update(at=tw, **meta)
            steps.append(st)
        elif kind in ("click", "key"):
            resolved = _resolve(pb, aid, params)
            st = resolved[-1]
            pre = resolved[:-1]                  # a key typed INTO a field: its focus click goes first
            for p in pre:
                p.update(at=round(max(0.0, at - 0.3), 6), **{k: v for k, v in meta.items() if k != "beat"})
                steps.append(p)
            st.update(at=at, **meta)
            if kind == "click":
                st.update(travel_ms=travel, settle_s=settle, glide=False)
                lab = (tg["labels"].get(str(st.get("target") or "").lower())) if st.get("target") else None
                if lab:
                    st.update(lab)
            if a.get("generates"):
                st["generates"] = True
                wt = b.get("wait_talk") or None
                if b.get("live") and live_left - used_live > 0 and wt and wt.get("t1") is not None:
                    # the ONE live generation: real press on its word, the in-progress state on screen only while he
                    # talks about the wait (3.5-6 s), the finished result never before its payoff word (gap #22)
                    live = True
                    st["live"] = True
                    w0 = max(tw, rel(wt.get("t0", b["t_word"])))
                    w1 = rel(wt["t1"])
                    show = min(LIVE_SHOW[1], max(LIVE_SHOW[0], w1 - w0))
                    payoff = next((rel(w["start"]) for w in words if rel(w["start"]) >= w1 - 1e-6
                                   and w["start"] <= seg["t1"]), w1)
                    payoff = min(max(payoff, w0 + LIVE_SHOW[0]), w0 + LIVE_SHOW[1])
                    steps.append(st)
                    ws = (acts.get("wait_generation") or {}).get("selectors") or ['[data-testid="generated-image-preview"]']
                    steps.append({"type": "wait_for", "selector": ws[0], "text": None, "min": 0, "timeout": 300,
                                  "show": round(show, 3), "until": round(payoff + K2_AFTER, 6), "at": tw, "live": True,
                                  "k2": {"frames": K2_FRAMES}, "ledger": n, "beat_id": meta["beat_id"],
                                  "word_t": round(payoff, 6), "payoff_t": round(payoff, 6)})
                    used_live += 1
                else:
                    # a result made OFF CAMERA: the viewer sees the press on its word (dry), then the K2 reveal
                    st["press"] = False
                    steps.append(st)
                    later = beats[n + 1:]
                    upto = next((k for k, x in enumerate(later) if (acts.get(x.get("action")) or {}).get("kind") in PRESS_KINDS), len(later))
                    if any((acts.get(x.get("action")) or {}).get("kind") == "reveal" for x in later[:upto]):
                        gen_results.append((b, prev_typed, tw))
                    else:
                        rid = asset_for(b, prev_typed, assets, seg_idx)
                        steps.append({"type": "reveal", "asset": rid, "url": f"$asset_url[{rid}]", "frames": K2_FRAMES,
                                      "at": round(tw + K2_AFTER, 6), **{**meta, "beat": False}, "result_of": meta["beat_id"],
                                      "assert_": {"present_asset": rid}})
            else:
                steps.append(st)
        else:  # pragma: no cover — playbook.validate refuses other kinds
            raise CompileError(f"{meta['beat_id']}: unknown action kind {kind}")
        last_target = steps[-1].get("target") or steps[-1].get("selector") or last_target
        for s in steps[i0:]:
            s.setdefault("beat_id", meta["beat_id"])
            if "assert_" in s:
                s["assert"] = s.pop("assert_")
            s["playbook"] = s.get("playbook") or ("camera" if is_camera(aid) else aid if aid == OUTSIDE_GOTO
                                                  else f"{pb.get('app')}:{aid}")
        out_beats.append({"id": meta["beat_id"], "n": n, "action": aid, "kind": kind, "word": meta["word"], "t_word": tw,
                          "at": steps[i0]["at"] if len(steps) > i0 else tw, "from": meta["from"], "live": live,
                          "steps": list(range(i0, len(steps))),
                          "end_state": {"asserts": _expected_end(pb, aid, params, b), "fingerprint": None}})
    # no still > 3 s: a camera hold on the last named target fills a long quiet gap (never on a live wait)
    steps.sort(key=lambda s: s.get("at", 1e9))
    fill = []
    timed = [s for s in steps if s.get("at") is not None]
    if timed and timed[0]["at"] > MAX_STILL:          # the opening frame held before the first beat
        timed = [{"at": 0.0, "beat_id": timed[0].get("beat_id")}] + timed
    live_spans = [(s["at"], s["until"]) for s in steps if s.get("type") == "wait_for" and s.get("live")]
    for s, y in zip(timed, [x["at"] for x in timed[1:]] + [dur]):
        x = s["at"]
        if y - x > MAX_STILL and not any(a0 - 0.01 <= x <= a1 + 0.01 for a0, a1 in live_spans):
            m = math.ceil((y - x) / (MAX_STILL * 0.9)) - 1
            for k in range(1, m + 1):
                fill.append({"type": "read", "at": round(x + k * (y - x) / (m + 1), 4), "box": list(FULL_SCREEN), "glide": False,
                             "ms": int(MAX_STILL * 1000 * 0.8), "camera_only": True, "filler": True, "beat": False,
                             "beat_id": s.get("beat_id"), "playbook": "camera"})
    steps = sorted(steps + fill, key=lambda s: s.get("at", 1e9))
    # the step indices of each beat after sorting
    for ob in out_beats:
        ob["steps"] = [i for i, s in enumerate(steps) if s.get("beat_id") == ob["id"]]
    for k, ob in enumerate(out_beats):
        ob["start_state"] = start_state if k == 0 else {"after": out_beats[k - 1]["id"],
                                                         "asserts": out_beats[k - 1]["end_state"]["asserts"],
                                                         "fingerprint": None}
    validate_script(steps)
    return {"seg": seg_idx, "t0": t0, "t1": float(seg["t1"]), "app": pb.get("app"), "session": _session_kind(seg),
            "steps": steps, "beats": out_beats, "live": used_live, "assets": assets, "start_state": start_state,
            "url_allow": url_allow or [u for u in [seg.get("url")]
                                       + [(b.get("params") or {}).get("url") for b in beats if b.get("action") == OUTSIDE_GOTO]
                                       + ["https://" + h + "/" for h in pb.get("hosts", [])] if u]}


def _session_kind(seg):
    s = seg.get("session")
    k = s.get("kind") if isinstance(s, dict) else s
    return "outside" if k in ("outside", "public", "visitor") else "logged_in"


def compile_plan(segments, words, playbooks, assets=None, rehearsals=None, doodles=None, allow_unproven=None):
    """Whole video: <= 1 live generation in total, every other result from assets.json. A segment that does
    not compile is NOT recorded: blocked[i] = {"kind": needs_primitive | compile, "why", "beats"}."""
    assets = assets if assets is not None else {"assets": []}
    out, live_left = [], 1
    for i, seg in enumerate(segments):
        pb = playbooks.get(seg.get("app")) if isinstance(playbooks, dict) and "actions" not in playbooks else playbooks
        try:
            if not pb:
                raise NeedsPrimitive(f"segment {i}: no playbook for app {seg.get('app')!r}", [])
            sc = compile_segment(seg, words, pb, i, assets=assets, live_left=live_left,
                                 rehearsal=(rehearsals or {}).get(i), allow_unproven=allow_unproven,
                                 doodles=doodles.get(i) if isinstance(doodles, dict) else doodles)
        except CompileError as e:
            sc = {"seg": i, "t0": seg["t0"], "t1": seg["t1"], "steps": [], "beats": [], "live": 0,
                  "blocked": {"kind": e.kind, "why": str(e), "beats": e.beats}}
        live_left -= sc["live"]
        out.append(sc)
    return {"segments": out, "assets": assets, "live_sends": sum(s["live"] for s in out),
            "blocked": {s["seg"]: s["blocked"] for s in out if s.get("blocked")}}


def validate_script(steps):
    """Hard rules of a compiled script (a violation is a compiler bug, never recorded)."""
    for s in steps:
        if s["type"] == "type" and not (s.get("clear") and s.get("paste")):
            raise CompileError(f"type without clear/paste: {s.get('text')!r} (C3: the field is empty, text pasted whole)")
        if s["type"] == "hold" and s.get("s", 0) > MAX_STILL:
            raise CompileError(f"hold {s['s']} s > {MAX_STILL} s")
        if s["type"] == "read" and s.get("ms", 0) > MAX_STILL * 1000:
            raise CompileError(f"read {s['ms']} ms > {MAX_STILL} s")
        if s["type"] == "key" and EDIT_KEYS.match(str(s.get("key", ""))):
            raise CompileError(f"edit key {s['key']} in a compiled script (fields are cleared by the type beat)")
        if s.get("beat") and s["type"] in PRESS_KINDS and s.get("from") is not None and s["from"] > s["at"] + 1e-4:
            raise CompileError(f"a move after its own press ({s.get('beat_id')})")
    types = [s.get("text") for s in steps if s["type"] == "type"]
    for a, b in zip(types, types[1:]):
        if a == b:
            raise CompileError(f"retype of {a!r}")
    if sum(1 for s in steps if s.get("live") and s["type"] == "wait_for") > 1:
        raise CompileError("more than one live generation in a segment")
    return True


def clamp_action(a):
    """Recorder-side cap for any action: no still > 3 s."""
    a = dict(a)
    if a.get("type") == "hold":
        a["s"] = min(float(a.get("s", 1) or 1), MAX_STILL)
    if a.get("type") in ("read", "highlight") and a.get("ms") is not None:
        a["ms"] = min(float(a["ms"]), MAX_STILL * 1000)
    if a.get("after") is not None:
        a["after"] = min(float(a["after"]), MAX_STILL)
    return a


def press_offsets(compiled):
    """Each named press's offset from its word (seconds): pressed frame time - word."""
    out = []
    for sc in compiled["segments"] if "segments" in compiled else [compiled]:
        for s in sc["steps"]:
            if s.get("beat") and s["type"] in ("click", "type", "drag", "draw", "key", "upload") and s.get("word_t") is not None:
                out.append(round(pressed_frame(s["at"]) / FPS - s["word_t"], 4))
    return out


def summary(vals):
    return {"n": len(vals), "median": round(statistics.median(vals), 3) if vals else None,
            "in_band": sum(1 for v in vals if PRESS_BAND[0] - 1e-9 <= v <= PRESS_BAND[1] + 1e-9)}


# ───────────────────────── 5. fingerprints (expected end state) ─────────────────────────

def dhash(gray, w, h):
    """64-bit difference hash of a grayscale image (row-major list, w x h): 9x8 area means, a bit per
    left<right pair. -> 16 hex chars. agent_rec.mjs computes the same on its state shot."""
    cells = []
    for r in range(8):
        y0, y1 = r * h // 8, max(r * h // 8 + 1, (r + 1) * h // 8)
        row = []
        for c in range(9):
            x0, x1 = c * w // 9, max(c * w // 9 + 1, (c + 1) * w // 9)
            s = n = 0
            for y in range(y0, min(y1, h)):
                base = y * w
                for x in range(x0, min(x1, w)):
                    s += gray[base + x]
                    n += 1
            row.append(s / max(1, n))
        cells.append(row)
    bits = 0
    for row in cells:
        for c in range(8):
            bits = (bits << 1) | (1 if row[c] < row[c + 1] else 0)
    return f"{bits:016x}"


def hamming(a, b):
    if not a or not b:
        return 64
    return bin(int(a, 16) ^ int(b, 16)).count("1")


FP_MAX_DIST = 10             # same screen state: <= 10 of 64 bits differ (cursor, a caret, a clock)


def same_state(a, b, max_dist=FP_MAX_DIST):
    return a is None or b is None or hamming(a, b) <= max_dist


# ───────────────────────── 6. the elastic assembler ─────────────────────────

MOTION_THR = 0.6             # mean |frame - previous| on a 160x90 gray thumbnail (0-255) below this = motionless
CURSOR_STILL_PX = 0.5        # and the recorded cursor did not move


def idle_frames(motion, cursor=None, thr=MOTION_THR):
    """idle[i]: frame i looks like frame i-1 (pixel diff below thr and no cursor travel). Frame 0 never idle."""
    n = len(motion)
    idle = [False] * n
    for i in range(1, n):
        ok = motion[i] is not None and motion[i] < thr
        if ok and cursor is not None and i < len(cursor) and cursor[i] is not None and cursor[i - 1] is not None:
            ok = math.hypot(cursor[i][0] - cursor[i - 1][0], cursor[i][1] - cursor[i - 1][1]) <= CURSOR_STILL_PX
        idle[i] = ok
    return idle


def _spread(cands, k):
    """k picks from candidate frames, spread evenly, latest first when k < len (the rest before a late press)."""
    if k <= 0 or not cands:
        return []
    if k >= len(cands):
        return list(cands)
    step = len(cands) / k
    return sorted(cands[len(cands) - 1 - int(j * step)] for j in range(k))


def elastic_map(motion, anchors, out_frames, cursor=None, thr=MOTION_THR, fps=FPS, tol_f=1):
    """The time map of a take.

      motion   per source frame: mean abs diff to the previous frame (measured on the take)
      anchors  [{"src": source frame of the press / result, "want": output frame, "kind": "press"|"result",
                 "lo"/"hi": output-frame band (results), "beat"}]
      out_frames  output length in frames (the segment's screen time)

    -> {"frames": [source frame per output frame], "dropped": [...], "duplicated": [...], "anchors": [...],
        "ok": bool, "failures": [...], "trimmed_tail": n, "held_tail": n}. Only idle frames (idle_frames) are
    ever dropped or repeated; motion is never cut or frozen. A press that cannot reach its word +-tol_f frames
    (or a result its band) with the idle frames available is a TIMING failure."""
    n_src = len(motion)
    idle = idle_frames(motion, cursor, thr)
    anchors = sorted([dict(a) for a in anchors if a.get("src") is not None and 0 < int(a["src"]) < n_src],
                     key=lambda a: int(a["src"]))
    frames, dropped, dup, report, failures = [], [], [], [], []
    s0 = 0
    o0 = 0
    for a in anchors:
        s1 = int(a["src"])
        if s1 <= s0:
            continue
        natural = o0 + (s1 - s0)
        if a.get("kind") == "result" and a.get("lo") is not None:
            want = min(max(natural, int(a["lo"])), int(a["hi"]))
        else:
            want = int(a["want"])
        want = max(want, o0 + 1)
        need = (want - o0) - (s1 - s0)
        span = list(range(s0 + 1, s1))           # s0 (the previous anchor) and s1 (this anchor) are kept
        cands = [i for i in span if idle[i]]
        drop_set, reps = set(), {}
        if need < 0:
            pick = _spread(cands, -need)
            drop_set = set(pick)
            dropped += pick
        elif need > 0:
            pool = cands or ([s0] if s0 > 0 and idle[s0] else [])
            if pool:
                for j in range(need):
                    f = pool[len(pool) - 1 - (j % len(pool))]
                    reps[f] = reps.get(f, 0) + 1
                dup += [f for f, r in reps.items() for _ in range(r)]
        for i in range(s0, s1):
            if i in drop_set:
                continue
            frames.append(i)
            frames += [i] * reps.get(i, 0)
        got = len(frames)
        ok = abs(got - int(a["want"])) <= tol_f if a.get("kind") != "result" or a.get("lo") is None \
            else int(a["lo"]) <= got <= int(a["hi"])
        row = {"beat": a.get("beat"), "kind": a.get("kind", "press"), "src": s1, "want": int(a["want"]), "got": got, "ok": ok}
        report.append(row)
        if not ok:
            failures.append({"dim": "D2", "kind": "late" if got > want else "on_word", "beat": a.get("beat"),
                             "t": round(got / fps, 3), "why": f"{row['kind']} at frame {got}, wanted {want} "
                             f"({(got - want) / fps:+.2f} s): not enough motionless frames to re-time"})
        s0, o0 = s1, got
    # the tail keeps the segment's screen length
    tail = list(range(s0, n_src))
    need = (out_frames - o0) - len(tail)
    trimmed = held = 0
    if need < 0:
        cands = [i for i in tail[1:] if idle[i]]
        pick = set(_spread(cands, min(-need, len(cands))))
        dropped += sorted(pick)
        tail = [i for i in tail if i not in pick]
    elif need > 0:
        cands = [i for i in tail if idle[i]] or ([tail[-1]] if tail and idle[tail[-1]] else [])
        if cands:
            reps = {}
            for j in range(need):
                f = cands[len(cands) - 1 - (j % len(cands))]
                reps[f] = reps.get(f, 0) + 1
            dup += [f for f, r in reps.items() for _ in range(r)]
            tail = [x for i in tail for x in [i] * (1 + reps.get(i, 0))]
    frames += tail
    if len(frames) > out_frames:
        trimmed = len(frames) - out_frames         # recorded past the segment end (end "until" = dur + 0.5 s)
        frames = frames[:out_frames]
    elif len(frames) < out_frames:
        held = out_frames - len(frames)            # the recording stopped early: the last frame holds (reported)
        frames += [frames[-1] if frames else 0] * held
    return {"frames": frames, "dropped": sorted(dropped), "duplicated": sorted(dup), "anchors": report,
            "ok": not failures, "failures": failures, "trimmed_tail": trimmed, "held_tail": held,
            "reachable": round(sum(1 for r in report if r["ok"]) / len(report), 3) if report else 1.0}


def anchors_from(events, fps=FPS, script=None):
    """Recorded events -> elastic anchors. A press (click / type / drag / draw / upload / key with a beat's
    word_t) wants its word's frame; a K2 reveal (nav with k2) and a live wait's dissolve (wait with until) want
    the result band word +0.2..+1.4 s (the K2 aim +0.65 s when it is outside)."""
    out = []
    for e in sorted(events or [], key=lambda e: e.get("t", 0)):
        wt = e.get("word_t")
        if wt is None:
            continue
        if e.get("type") in ("click", "dblclick", "type", "drag", "draw", "upload", "key") and e.get("beat") is not False:
            p = e.get("press", e.get("t"))
            out.append({"src": int(round(p * fps)), "want": int(round(wt * fps)), "kind": "press", "beat": e.get("beat_id") or e.get("ledger")})
        elif (e.get("type") == "nav" and e.get("k2")) or (e.get("type") == "wait" and e.get("until") is not None):
            out.append({"src": int(round(e["t"] * fps)), "want": int(round((wt + K2_AFTER) * fps)), "kind": "result",
                        "lo": int(math.ceil((wt + RESULT_BAND[0]) * fps)), "hi": int(math.floor((wt + RESULT_BAND[1]) * fps)),
                        "beat": e.get("beat_id") or e.get("ledger")})
    return out


def remap_time(t, frames, fps=FPS):
    """A source second -> the output second of the first output frame showing it (or the nearest later one)."""
    k = int(round(t * fps))
    for j, f in enumerate(frames):
        if f >= k:
            return round(j / fps, 4)
    return round(len(frames) / fps, 4)


def retime_events(ev, frames, fps=FPS):
    """events.json re-timed onto the output clock (events, cursor samples, walls); keeps the original as
    "recorded" so a re-assembly starts from the take."""
    import copy
    out = copy.deepcopy(ev)
    for e in out.get("events", []):
        for k in ("t", "end", "press"):
            if isinstance(e.get(k), (int, float)):
                e[k] = remap_time(e[k], frames, fps)
    cur = {int(round(c[0] * fps)): c for c in ev.get("cursor", [])}
    out["cursor"] = [[round(j / fps, 4), *cur[f][1:]] for j, f in enumerate(frames) if f in cur]
    for w in out.get("walls", []):
        if isinstance(w.get("t"), (int, float)):
            w["t"] = remap_time(w["t"], frames, fps)
    out["end"] = round(len(frames) / fps, 4)
    return out
