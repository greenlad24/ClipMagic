"""Long-form DIRECTOR: the whole edit plan for a 16:9 narration video — which spans become
SCREENCASTS (recorded by code, camera-zoomed, presenter in the bubble), what each screencast BEAT does
on which word, and which A-roll moments carry text/CTA graphics.

Architecture recommendation step 3 (code on camera, single model calls for decisions):
  plan_call      ONE Opus call (effort high, strict JSON = the plan schema with a CLOSED action list:
                 each app's PROVEN playbook actions + two code primitives, camera.zoom and outside.goto)
                 from the words, the sentences, the playbooks, the produced assets and the reference bands
  check_plan     checkpoint 1 (code): schema, proven actions only, assets exist, every sentence that names
                 a tool / UI step has a beat or a why, pricing / visitor views only in the 'outside'
                 session, planfit.fit's reference bands (spans, share, boundaries, hook plate, instruction
                 stretches). Errors are re-asked at most config.PLAN_REASKS times; whatever is still wrong
                 becomes needs_primitive and the job is HELD (no A-roll substitution — decision 5 default)
  overlay_plan   ONE Sonnet call for the A-roll text overlays, then planfit.overlays_fit (the budget and
                 the outro set)
  validate       the checked plan in the recorder's segment form (planfit.fit), re-run on every job run
The old two-call planning (preprod.shot_prompt + director.plan) is gone; write_script stays for the
non-factory scripted recorder of public sites (factory beats are compiled from the plan, package p7).
"""
import base64
import json
import re
import time

from . import config, events, llm, planfit, playbook, skill

MODEL = config.TAKES_MODEL                 # director.call (write_script, tests)
PLAN_MODEL = config.PLAN_MODEL
OVERLAY_MODEL = config.OVERLAY_MODEL
PRIORITY = {"link": 2, "subscribe": 2, "lower_title": 2, "socials": 2}
LEAD_S = 0.2

OVERLAYS = """OVERLAY TEMPLATES (on the A-roll only — never while a screencast is on):
- lower_title: white text, lower centre, 1-2 short lines (<= 5 words each). For the intro ("Hey everyone / welcome back to the channel", "I'm Jake Dawson") and a section's opening line. fields: line1, line2 (may be "").
- link: the "Link in the description" caption — ONLY when the speaker points to a link/description. fields: text (default "Link in the description").
- subscribe: the animated SUBSCRIBE → SUBSCRIBED button — ONLY when the speaker asks to subscribe. fields: {}.
- socials: TikTok + Instagram icons — ONLY when the speaker mentions following on those. fields: {}.
- keyword: 1-2 lines of a punchy phrase the speaker SAYS (line1 white, line2 accent). For the hook and real punchlines only. fields: line1, line2.
- list: 2-4 short items the speaker enumerates (each 1-4 words), anchored on the first item. fields: items.
- number: a figure the speaker SAYS. fields: label, value, prefix, suffix.
- question: (a lower_title line, TX03) the viewer question of the outro ("What are you editing first?"), the
  whole question. fields: line1."""

def facts_block(facts):
    """What pre-production measured (readiness features) and produced (assets) — the only things a
    beat may ask the screen for (gap list G2)."""
    if facts is None or facts.empty:
        return ""
    out = ["APP FACTS (measured on screen in Jake's account before planning — a beat may NEVER ask for a "
           "feature marked MISSING; use the honest route given, or leave those words to the presenter):"]
    for f in facts.features:
        alt = f.get("alternative") or {}
        route = alt.get("how") or ({"public": f"the PUBLIC page {alt.get('url')} (we record it in a separate "
                                              "never-logged-in US browser)"}.get(alt.get("route")))
        out.append(f"- {f['id']} ({f.get('label')}): {'exists' if f.get('exists') else 'MISSING'}"
                   + (f" — {f['note']}" if f.get("note") and not f.get("exists") else "")
                   + (f" → instead: {route}" if route and not f.get("exists") else ""))
    out.append("PRODUCED ASSETS (the only pictures/files that exist; every object you name in a picture must be "
               "in one of them; never name a chat, document or picture that is not here):")
    for a in facts.assets:
        out.append(f"- {a.get('id')} [{a.get('kind')}, {a.get('status')}]: {a.get('desc', '')}"
                   + (f" — prompt: {str(a.get('prompt') or (a.get('source') or {}).get('prompt') or '')[:240]}"
                      if (a.get('prompt') or (a.get('source') or {}).get('prompt')) else ""))
    return "\n".join(out) + "\n"


def call(content, system, max_tokens=24000, effort="high"):
    """One director call through llm.py (the API ledger + caps). → (JSON object, meta)."""
    t0 = time.time()
    total = 0.0
    msgs = [{"role": "user", "content": content}]
    # Factory rule: retry, don't fail. A malformed answer (2026-10-08: "Expecting ',' delimiter"
    # sank a creative job at graphics) gets one more call that asks for strictly valid JSON.
    for attempt in (1, 2):
        r = llm.messages(MODEL, system, None, max_tokens, effort=effort, msgs=msgs,
                         purpose=f"Claude director ({effort} effort)" + (" — retry for valid JSON" if attempt == 2 else ""))
        text = r["text"]
        total += r["usd"]
        m = re.search(r"\{.*\}", text, re.S)
        try:
            if not m:
                raise ValueError("no JSON object in the answer")
            return json.loads(m.group(0)), {"usd": round(total, 4), "seconds": round(time.time() - t0)}
        except ValueError as e:                       # json.JSONDecodeError is a ValueError
            if attempt == 2:
                raise RuntimeError(f"Claude returned invalid JSON twice: {e}") from None
            events.emit("log", f"director answer was not valid JSON ({e}) — asking again", level="warn")
            msgs = [{"role": "user", "content": content},
                    {"role": "assistant", "content": text or "(empty)"},
                    {"role": "user", "content": f"That was not valid JSON ({e}). Reply with the "
                     "complete answer again as ONE valid JSON object only — no prose, no code fence, "
                     "every string escaped."}]


def validate(plan, video, sites, facts=None):
    """The director's answer → a plan the edit can honestly record. Word ids and hosts are checked
    here; planfit then resolves every "on 'X'" beat to its word (the beat ledger), rewrites or routes
    each beat the account / produced assets cannot show (facts = readiness + assets from
    pre-production), adds the hook plate and re-cuts the screencast into the reference span
    structure (REFERENCE-BASELINE §1: spans p50 10-18 s, max 30 s, A-roll beats 5-7 s, 72-76 %)."""
    ids = {w["i"]: w for w in video["words"]}
    order = [w["i"] for w in video["words"]]
    pos = {i: n for n, i in enumerate(order)}
    dur = video["duration"]
    hosts = [".".join(re.sub(r"^https?://(www\.)?", "", s["url"]).split("/")[0].split(".")[-2:]) for s in sites]
    facts = facts if facts is not None else planfit.Facts()
    raw_segs, dropped = [], []
    for s in sorted(plan.get("segments", []), key=lambda s: pos.get(s.get("start"), 1e9)):
        a, b = s.get("start"), s.get("end")
        why = None
        if a not in ids or b not in ids or pos[b] < pos[a]:
            why = "word ids not in this cut"
        elif not any(h and h in str(s.get("url", "")) for h in hosts) and s.get("session_name") != "outside":
            why = "url is not one of the job's sites"
        elif raw_segs and pos[a] <= pos[raw_segs[-1]["end"]]:
            why = "overlaps the previous screencast"
        if why:
            dropped.append({**s, "dropped": why})
            continue
        raw_segs.append(s)
    fitted = planfit.fit(raw_segs, video, facts, aroll_why=plan.get("aroll_why"),
                         site_url=sites[0]["url"] if sites else None)
    fitted_src = dict(enumerate(fitted["sources"]))
    dropped += [{"start": None, "end": None, "dropped": f"beat seg-{d['seg']:02d} '{d['cue']}': {d['dropped']}"}
                for d in fitted["dropped"]]
    segs = []
    for s in fitted["segments"]:
        if s["t1"] - s["t0"] < planfit.MIN_SPAN:
            dropped.append({**s, "dropped": "shorter than 2.5 s"})
            continue
        if segs and 0.05 < s["t0"] - segs[-1]["t1"] < planfit.MIN_GAP:
            segs[-1]["t1"] = s["t0"]               # < 3 s of A-roll is a flash: the screens join instead
        segs.append(s)
    # the raw segments' sessions / schema beats (the single plan call) ride along to the fitted pieces
    for s in segs:
        src = fitted_src.get(s.get("part_of"))
        if not src:
            continue
        if src.get("session_name") == "outside" and not s.get("session"):
            s["session"] = dict(OUTSIDE_SESSION)
        if src.get("actions") is not None:
            s["actions"] = [b for b in src["actions"] if b.get("t_word") is not None
                            and s["t0"] - 0.05 <= b["t_word"] < s["t1"]]
            s["app"] = src.get("app")
    ovs, odrop = validate_overlays(plan.get("overlays", []), video, segs)
    dropped += odrop
    fit_o = planfit.overlays_fit(ovs, video, segs)
    dropped += fit_o["dropped"]
    return {"segments": segs, "overlays": fit_o["overlays"], "dropped": dropped, "plates": fitted["plates"],
            "beats": fitted["beats"], "objects": fitted["objects"], "aroll_actions": fitted["aroll_actions"],
            "structure": fitted["structure"], "overlay_budget": fit_o["budget"]}


def validate_overlays(overlays, video, segs):
    """Word ids, templates, no screencast under it, one at a time (the presenter's moments win)."""
    ids = {w["i"]: w for w in video["words"]}
    order = [w["i"] for w in video["words"]]
    pos = {i: n for n, i in enumerate(order)}
    dropped = []
    ovs, last_end = [], -1e9
    for ev in sorted(overlays, key=lambda e: pos.get(e.get("start"), 1e9)):
        a, b, t = ev.get("start"), ev.get("end"), ev.get("template")
        why = None
        if t not in ("lower_title", "link", "subscribe", "socials", "keyword", "list", "number"):
            why = f"unknown template {t}"
        elif a not in ids or b not in ids or pos[b] < pos[a]:
            why = "word ids not in this cut"
        if why is None:
            t0 = max(0.0, ids[a]["start"] - LEAD_S)
            t1 = min(max(ids[b]["end"] + 0.1, t0 + 1.5), t0 + (6.0 if t in ("list", "subscribe", "socials") else 4.5))
            span = [ids[i] for i in order[pos[a]:pos[b] + 1]]
            hit = lambda *ks: next((w for w in span if re.sub(r"[^a-z]", "", w["word"].lower()) in ks), None)
            if t == "link" and hit("link", "links"):
                t0, t1 = hit("link", "links")["start"] - 0.05, hit("link", "links")["start"] + 2.35
            elif t == "subscribe" and hit("subscribe", "subscribed"):
                w_ = hit("subscribe", "subscribed")
                t0, t1 = max(0.0, w_["start"] - 2.45), max(w_["end"] + 2.3, t1)
            for s in segs:                            # a screencast edge clips the overlay's A-roll part
                if s["t0"] - 0.2 < t1 and t0 < s["t1"] + 0.2:
                    if s["t0"] <= t0 and t1 - (s["t1"] + 0.2) >= 1.5:
                        t0 = s["t1"] + 0.2
                    elif s["t1"] >= t1 and (s["t0"] - 0.2) - t0 >= 1.5:
                        t1 = s["t0"] - 0.2
            if any(s["t0"] - 0.2 < t1 and t0 < s["t1"] + 0.2 for s in segs):
                why = "overlaps a screencast"
            elif t0 < last_end + 0.6:
                # the presenter's own moments win over a decorative keyword/list/number
                prev = ovs[-1] if ovs else None
                if prev and PRIORITY.get(t, 0) > PRIORITY.get(prev["template"], 0):
                    dropped.append({**ovs.pop(), "dropped": f"gave way to {t}"})
                    last_end = ovs[-1]["t1"] if ovs else -1e9
                    if t0 < last_end + 0.6:
                        why = "overlaps the previous overlay"
                else:
                    why = "overlaps the previous overlay"
        if why:
            dropped.append({**ev, "dropped": why})
            continue
        ovs.append({**ev, "t0": round(t0, 3), "t1": round(t1, 3)})
        last_end = t1
    return ovs, dropped



def plan(video, sites, sponsored, knowledge=None, facts=None, playbooks=None, rulebook=None):
    """The whole decision: the plan call + check (re-asks) and the overlay call. → (plan, raw, meta) where plan
    is validate()'s recorder form + "needs_primitive" / "held" / "plan_check", raw is what validate re-reads on
    every run (segments + their schema beats, aroll whys, overlays)."""
    res = plan_and_check(video, sites, facts, sponsored, knowledge, playbooks, rulebook)
    raw = res["raw"] or {"segments": [], "aroll_why": [], "plates": [], "overlays": []}
    segs = (res["checked"] or {}).get("segments", [])
    ovs, r2 = overlay_plan(video, segs, sponsored)
    raw = {**raw, "overlays": ovs}
    out = validate(raw, video, sites, facts)
    out.update(needs_primitive=res["needs_primitive"], held=res["held"], schema_plan=res["plan"],
               plan_check={"attempts": [{"answer": a["answer"], "errors": [e["msg"] for e in a["errors"]]}
                                        for a in res["attempts"]], "apps": res["apps"], "action_ids": res["action_ids"]})
    meta = {"usd": round(res["usd"] + r2["usd"], 4), "seconds": res["seconds"] + round(r2["seconds"]),
            "calls": {PLAN_MODEL: res["calls"], OVERLAY_MODEL: 1}}
    return out, raw, meta


# ════════════════════════════ the single plan call (recommendation step 3) ════════════════════════════

CAMERA_ACTIONS = ("camera.zoom",)            # gates.CAMERA_ACTIONS: ".zoom" = a camera-only beat
OUTSIDE_ACTIONS = ("outside.goto",)
BUILTIN = {
    "camera.zoom": "no click, no typing: the camera frames 'subject' (ui:<exact label> | asset:<asset id> | screen), "
                   "which is ALREADY on screen (put there by an earlier beat or the segment's start state)",
    "outside.goto": "session 'outside' only: open the PUBLIC page in 'url' in the separate never-logged-in en-US Chrome "
                    "through the US route (RULEBOOK L4/R9/R10) — pricing and visitor views",
}
SESSIONS = ("logged_in", "outside")
PLAN_SYSTEM = """You are the edit planner of Jake Dawson's automated YouTube editing factory (AI tools for business
owners). Code records every screencast: it can only perform the actions in each app's CLOSED action list, so a
beat may only name one of those action ids. You never invent a control, a chat, a page, a menu item or a
picture: when a sentence needs something no listed action or produced asset can show, put it in
needs_primitive (with the honest route if one exists) or leave it on the presenter with a why. Answer with the
JSON plan only."""
JAKE_RULES = """JAKE'S SCREENCAST RULES (his reviews, they override anything below):
- THE OPENING: the first minute shows THE RESULT of the video. If the first 40 s point at a thing ("look at
  this", "on the left/right"), plan NO screencast over those words: put a plate there (plates, the produced
  assets it shows); the first two minutes are MOSTLY screencast, A-roll only for the welcome/name, the
  subscribe ask and the link line.
- REVEAL THE TOOL: naming the tool → its landing page unzoomed, or the presenter. Never a random app page.
- NO PURPOSELESS PAGES: every beat shows exactly what the words say, the moment he says it (the beat's word
  is the word that NAMES the thing or the ACTION word). Never a home page as a way through.
- PRICING (RULEBOOK L3/L4): only from the PUBLIC pricing page in the 'outside' session (outside.goto),
  top unzoomed, then a cut to the named plan card (camera.zoom). Never the in-account upgrade/billing view.
- CLEAN SCREENS: prompts and addresses are pasted whole; no pop-ups left open; no unnecessary scroll.
- CONSTANT MOTION: about one beat every 3-5 s inside a screencast; every beat is one of the listed actions.
- The presenter's own moments stay A-ROLL: welcome/intro, subscribe ask, "link in the description",
  follow-me and the sign-off."""

_PLAN_SECTIONS = ("## S.", "## 1.", "## 4.", "## 5.", "## 7.", "## 8.")


def rulebook_digest(text=None, sections=_PLAN_SECTIONS, limit=16000):
    """The RULEBOOK sections a plan decides on (set dressing, content, pacing, cuts, typing, pricing)."""
    text = text if text is not None else skill.rulebook_text()
    out, keep = [], False
    for line in text.splitlines():
        if line.startswith("## "):
            keep = line.startswith(sections)
        if keep:
            out.append(line)
    return "\n".join(out)[:limit] or text[:limit]


def _host(url):
    return re.sub(r"^https?://(www\.)?", "", str(url or "")).split("/")[0].lower()


def apps_for(sites, playbooks=None):
    """{app: {"pb": playbook | None, "actions": {id: action} PROVEN only (rules.json playbooks.allow_unproven),
    "url": start url, "hosts": [...]}} for the job's sites. A site with no playbook is a 'web:<host>' app: only
    the code primitives (camera.zoom, outside.goto). playbooks = {app: playbook dict} (tests), default = the
    skill folder's playbooks."""
    if playbooks is None:
        playbooks = {}
        for a in skill.playbooks():
            try:
                playbooks[a] = playbook.load(a)
            except Exception as e:  # noqa: BLE001 — a broken playbook is no playbook (logged)
                events.emit("log", f"playbook {a} not usable: {e}", level="warn")
    apps = {}
    for s in sites or []:
        h = _host(s["url"])
        pb = next((p for p in playbooks.values() if any(h == x or h.endswith("." + x) for x in p.get("hosts", []))), None)
        if pb:
            aid = pb["app"]
            if aid not in apps:
                apps[aid] = {"pb": pb, "actions": playbook.actions(pb), "url": pb.get("start_state", {}).get("url") or s["url"],
                             "hosts": list(pb.get("hosts", []))}
        else:
            apps.setdefault(f"web:{h}", {"pb": None, "actions": {}, "url": s["url"], "hosts": [h]})
    return apps


def action_ids(apps):
    """The closed action list of the plan schema: every app's proven ids + the code primitives."""
    ids = sorted({a for x in apps.values() for a in x["actions"]})
    return ids + [a for a in (*CAMERA_ACTIONS, *OUTSIDE_ACTIONS) if a not in ids]


def _nul(t):
    return {"anyOf": [{"type": t}, {"type": "null"}]}


def _obj(props, required=None):
    return {"type": "object", "additionalProperties": False, "properties": props,
            "required": list(required if required is not None else props)}


def plan_schema(apps):
    """The call-time JSON schema (structured outputs): plan.schema.json's segments / aroll / plates /
    needs_primitive in word ids, with the action ENUM = the closed list (code fills times + ids)."""
    beat = _obj({"word_id": {"type": "integer"}, "action": {"type": "string", "enum": action_ids(apps)},
                 "body": {"type": "string"}, "subject": {"type": "string"}, "text": _nul("string"),
                 "url": _nul("string"), "asset_id": _nul("string"), "live": {"type": "boolean"},
                 "wait_end_word": _nul("integer")})
    seg = _obj({"start_word": {"type": "integer"}, "end_word": {"type": "integer"},
                "app": {"type": "string", "enum": sorted(apps) or ["none"]},
                "session": {"type": "string", "enum": list(SESSIONS)}, "beats": {"type": "array", "items": beat}})
    span = {"start_word": {"type": "integer"}, "end_word": {"type": "integer"}}
    return _obj({
        "segments": {"type": "array", "items": seg},
        "aroll": {"type": "array", "items": _obj({**span, "why": {"type": "string"}})},
        "plates": {"type": "array", "items": _obj({**span, "asset_ids": {"type": "array", "items": {"type": "string"}},
                                                   "technique_id": {"type": "string"}})},
        "needs_primitive": {"type": "array", "items": _obj({"sentence": {"type": "string"},
                                                            "word_ids": {"type": "array", "items": {"type": "integer"}},
                                                            "why": {"type": "string"}, "proposed": _nul("string")})},
    })


def _act_line(aid, a):
    p = ", ".join(f"{k}" for k in (a.get("params") or {})) if isinstance(a.get("params"), dict) else ""
    gen = " — STARTS A GENERATION (shown as press + dissolve to the result made off camera)" if a.get("generates") else ""
    return f"  - {aid} [{a.get('kind')}]: {a.get('label', '')}" + (f" (params: {p})" if p else "") + gen


def apps_block(apps):
    out = []
    for aid, x in apps.items():
        pb = x["pb"] or {}
        out.append(f"APP {aid} — start page {x['url']}")
        out.append("  CLOSED ACTION LIST (proven: each replayed 3/3 from a fresh session; a beat may name ONLY these "
                   "or the code primitives below):")
        out += [_act_line(k, a) for k, a in x["actions"].items()] or ["  (none proven yet — every UI step of this app "
                                                                      "goes to needs_primitive)"]
        miss = [(k, f) for k, f in (pb.get("features") or {}).items() if not f.get("exists")]
        if miss:
            out.append("  DOES NOT EXIST in this app/account (never show it; honest route where given):")
            out += [f"  - {k}: {f.get('fact')}" + (f" → honest route: {f['honest_route']}" if f.get("honest_route") else "")
                    for k, f in miss]
        if pb.get("outside_only"):
            out.append("  OUTSIDE ONLY (session 'outside' + outside.goto): " + "; ".join(pb["outside_only"]))
    out.append("CODE PRIMITIVES (every app):")
    out += [f"  - {k}: {v}" for k, v in BUILTIN.items()]
    return "\n".join(out)


def sentences_block(video):
    out = []
    for k, s in enumerate(planfit.sentences(video["words"])):
        out.append(f"S{k} [{s[0]['i']}-{s[-1]['i']}] {s[0]['start']:.1f}-{s[-1]['end']:.1f}: "
                   + " ".join(w["word"] for w in s))
    return "\n".join(out)


def plan_prompt(video, apps, facts=None, sponsored=False, knowledge=None, rulebook=None):
    rules = skill.rules()
    st, sy = rules.get("structure", {}), rules.get("sync", {})
    words = " ".join(f'{w["i"]}:{w["word"]}@{w["start"]:.1f}' for w in video["words"])
    walk = ("APP WALKTHROUGH (UX Scout report — context only; it never adds an action):\n" + knowledge[:8000] + "\n") \
        if knowledge else ""
    return f"""{JAKE_RULES}

RULEBOOK (the planning sections; Jake's rulings > RULEBOOK > techniques):
{rulebook if rulebook is not None else rulebook_digest()}

REFERENCE BANDS (Jake's references = the 100 % mark; skill rules.json):
- structure: screencast share {st.get('screencast_share')} of the runtime; screencast spans p50 {st.get('span_p50_s')} s,
  never over {st.get('span_max_s')} s; A-roll beats {st.get('aroll_p50_s')} s; {st.get('boundaries_per_min')} screen<->face
  boundaries per minute; plates <= {st.get('plates_max_frac')} of the runtime and only in the first {st.get('plates_only_first_s')} s.
- sync: the beat's word is the naming / action word; the press lands {sy.get('press_offset_s')} s from it, the result
  {sy.get('result_after_s')} s after it; a generation is a press on its word + a dissolve to the result made off
  camera, unless he talks about the wait (then live=true and wait_end_word = the last word about the wait).
- every stretch >= 8 s where he tells the viewer to upload/click/type/drag/select/open is a screencast, or give its
  why in "aroll".

{apps_block(apps)}

{facts_block(facts) if facts is not None else ""}
{walk}
THE PLAN — JSON (word ids from the transcript):
- segments: start_word / end_word (a screencast covers those words), app, session ('outside' only for
  pricing / visitor views), beats in word order: word_id (inside the segment), action (one id from the closed
  list), body (what the viewer sees, plain words — name only real labels and produced assets), subject
  (ui:<exact label> | asset:<asset id> | screen), text (the exact text pasted/typed, else null), url (outside.goto
  / goto, else null), asset_id (a produced asset this beat uploads/reveals/frames, else null), live, wait_end_word.
- aroll: the presenter stretches that name a tool or a UI step, with the reason they are not shown.
- plates: the hook plate (first 40 s), asset_ids from the produced assets, technique_id TX07 or TX09.
- needs_primitive: each sentence that needs an action no list holds (sentence, word_ids, why, proposed route).
- no overlays here (a separate call places them).
{"SPONSORED video: no claims beyond what is said." if sponsored else ""}

SENTENCES (S<k> [first id-last id] seconds: text):
{sentences_block(video)}

TRANSCRIPT (id:word@seconds) — "{video.get('title', '')}", {video['duration']:.1f} s:
{words}"""


def _json_answer(text):
    try:
        return json.loads(text)
    except ValueError:
        m = re.search(r"\{.*\}", text or "", re.S)
        if not m:
            raise
        return json.loads(m.group(0))


PLAN_MAX_TOKENS = 64000


def plan_call(video, apps, facts=None, sponsored=False, knowledge=None, rulebook=None, msgs=None):
    """THE plan call: one Opus request, effort high, the answer constrained to plan_schema(apps).
    msgs = the whole conversation for a re-ask (append-only). → (answer dict, reply)."""
    if msgs is None:
        msgs = [{"role": "user", "content": plan_prompt(video, apps, facts, sponsored, knowledge, rulebook)}]
    n = sum(1 for m in msgs if m["role"] == "user")
    tag = f" — re-ask {n - 1}" if n > 1 else ""
    # 2026-10-09: a 15-min narration spent all 32k output tokens (thinking + plan) and returned no answer,
    # so the hand-off job failed on an empty reply. Room for a long plan, streamed; if the ceiling is
    # still hit, one retry at medium effort (less thinking, same schema) instead of failing the job.
    r = llm.messages(PLAN_MODEL, PLAN_SYSTEM, None, PLAN_MAX_TOKENS, effort="high", msgs=msgs, schema=plan_schema(apps),
                     stage="preprod.plan", purpose="Claude plan call (high effort)" + tag, stream=True)
    if r.get("stop_reason") == "max_tokens" or not (r.text or "").strip():
        events.emit("log", f"plan call hit its {PLAN_MAX_TOKENS}-token ceiling without a full answer — "
                    "retrying once at medium effort", level="warn")
        r2 = llm.messages(PLAN_MODEL, PLAN_SYSTEM, None, PLAN_MAX_TOKENS, effort="medium", msgs=msgs,
                          schema=plan_schema(apps), stage="preprod.plan", stream=True,
                          purpose="Claude plan call (medium effort, after the token ceiling)" + tag)
        r2["usd"] = round(float(r2.get("usd") or 0) + float(r.get("usd") or 0), 5)
        r = r2
    return _json_answer(r.text), r


# ── checkpoint 1: the plan check (code) ──

def _schema_errors(obj, sch, path="plan", root=None, skip_enum=("action",)):
    """A small JSON-schema check (type, required, additionalProperties, enum, items, anyOf, $ref)."""
    root = root or sch
    if "$ref" in sch:
        sch = root["$defs"][sch["$ref"].split("/")[-1]]
    if "anyOf" in sch:
        errs = [_schema_errors(obj, s, path, root, skip_enum) for s in sch["anyOf"]]
        return [] if any(not e for e in errs) else errs[0]
    t = sch.get("type")
    types = {"object": dict, "array": list, "string": str, "integer": int, "number": (int, float), "boolean": bool,
             "null": type(None)}
    ts = t if isinstance(t, list) else [t] if t else []
    if ts and not any(isinstance(obj, types[x]) and not (x in ("integer", "number") and isinstance(obj, bool)) for x in ts):
        return [f"{path}: expected {t}, got {type(obj).__name__}"]
    if "enum" in sch and obj not in sch["enum"] and path.rsplit(".", 1)[-1] not in skip_enum:
        return [f"{path}: {obj!r} is not one of {sch['enum']}"]
    out = []
    if isinstance(obj, dict):
        for k in sch.get("required", []):
            if k not in obj:
                out.append(f"{path}: missing '{k}'")
        props = sch.get("properties", {})
        for k, v in obj.items():
            if k in props:
                out += _schema_errors(v, props[k], f"{path}.{k}", root, skip_enum)
            elif sch.get("additionalProperties") is False:
                out.append(f"{path}: unexpected '{k}'")
    if isinstance(obj, list) and "items" in sch:
        for n, x in enumerate(obj):
            out += _schema_errors(x, sch["items"], f"{path}[{n}]", root, skip_enum)
    return out


def _cue(ws, k):
    """The narration words a beat sits on, as an "on '<cue>'" the ledger resolves exactly."""
    out = []
    for w in ws[k:k + 3]:
        t = re.sub(r"[\"'‘’“”;:]", "", str(w["word"])).strip()
        if t:
            out.append(t)
        if re.search(r"[.?!,]$", str(w["word"])):
            break
    return " ".join(out).strip(",.?!") or str(ws[k]["word"])


def _clean_body(b):
    b = str(b or "").replace(";", ",")
    return planfit.CUE_RE.sub(lambda m: m.group(0).rstrip().rstrip(":") + " — ", b)


def normalize(ans, video):
    """The model's answer (word ids) → the plan schema form (plan.schema.json: times from the words, beat ids,
    clause starts, params) — the recorder / beat compiler input."""
    ws = video["words"]
    pos = {w["i"]: n for n, w in enumerate(ws)}
    t = lambda i, end=False: ws[pos[i]]["end" if end else "start"] if i in pos else None
    segs, n = [], 0
    for s in ans.get("segments", []):
        beats = []
        for b in sorted(s.get("beats", []), key=lambda b: pos.get(b.get("word_id"), 1e9)):
            k = pos.get(b.get("word_id"))
            c = planfit.clause_start(ws, k) if k is not None else None
            n += 1
            beats.append({"id": f"b{n:03d}", "word_id": b.get("word_id"), "t_word": t(b.get("word_id")),
                          "clause_start": ws[c]["start"] if c is not None else None,
                          "clause_word_id": ws[c]["i"] if c is not None else None,
                          "action": b.get("action"), "params": {k2: b[k2] for k2 in ("text", "url") if b.get(k2)},
                          "subject": b.get("subject") or "screen", "asset_id": b.get("asset_id"),
                          "typed_text": b.get("text"), "body": b.get("body", ""), "live": bool(b.get("live")),
                          "wait_talk": ({"t0": t(b["word_id"]), "t1": t(b["wait_end_word"], True)}
                                        if b.get("wait_end_word") in pos and k is not None else None),
                          "cue": _cue(ws, k) if k is not None else None})
        segs.append({"t0": t(s.get("start_word")), "t1": t(s.get("end_word"), True), "start_word": s.get("start_word"),
                     "end_word": s.get("end_word"), "app": s.get("app"), "session": s.get("session"), "beats": beats})
    span = lambda x: {"t0": t(x.get("start_word")), "t1": t(x.get("end_word"), True), "start_word": x.get("start_word"),
                      "end_word": x.get("end_word")}
    return {"segments": segs, "aroll": [{**span(x), "why": x.get("why")} for x in ans.get("aroll", [])],
            "plates": [{**span(x), "asset_ids": x.get("asset_ids", []), "technique_id": x.get("technique_id")}
                       for x in ans.get("plates", [])],
            "needs_primitive": [dict(x) for x in ans.get("needs_primitive", [])]}


OUTSIDE_SESSION = {"kind": "public", "locale": "en-US", "timezone": "America/New_York", "currency": "USD", "egress": "US"}


def to_raw(plan, apps, video):
    """The normalized plan → the director's raw form planfit.fit / validate read ({start, end, url, intent}
    with "on '<cue>': <body>" beats); each raw segment carries its session and its schema beats."""
    segs = []
    for s in plan["segments"]:
        app = apps.get(s.get("app")) or {}
        url = next((b["params"]["url"] for b in s["beats"] if b["action"] in OUTSIDE_ACTIONS and b["params"].get("url")),
                   None) if s.get("session") == "outside" else None
        intent = "; ".join(f"on '{b['cue']}': " + _clean_body(" ".join(
            x for x in (b["body"], f"'{b['typed_text']}' is pasted" if b.get("typed_text") else "",
                        b["params"].get("url") or "") if x)) for b in s["beats"] if b.get("cue"))
        segs.append({"start": s["start_word"], "end": s["end_word"], "url": url or app.get("url", ""), "intent": intent,
                     "app": s.get("app"), "session_name": s.get("session"), "actions": s["beats"]})
    return {"segments": segs, "aroll_why": [{"start": x["start_word"], "end": x["end_word"], "why": x["why"]}
                                            for x in plan["aroll"] if x.get("why")],
            "plates": plan["plates"], "overlays": []}


def _sentence_of(sents, wid):
    return next((s for s in sents if any(w["i"] == wid for w in s)), None)


def _err(code, msg, sent=None, word_ids=None, proposed=None):
    return {"code": code, "msg": msg, "sentence": " ".join(w["word"] for w in sent) if sent else None,
            "word_ids": list(word_ids if word_ids is not None else ([w["i"] for w in sent] if sent else [])),
            "proposed": proposed}


def check_plan(ans, video, apps, facts=None, sites=()):
    """Checkpoint 1. → (errors, info) — errors [{code, msg, sentence, word_ids, proposed}], info {"plan": the
    normalized plan, "raw": to_raw, "checked": validate() output}. Pure code, no call."""
    facts = facts if facts is not None else planfit.Facts()
    errs = [_err("schema", m) for m in _schema_errors(ans, plan_schema(apps))]
    if errs:
        return errs, {"plan": None, "raw": None, "checked": None}
    ws = video["words"]
    pos = {w["i"]: n for n, w in enumerate(ws)}
    sents = planfit.sentences(ws)
    plan = normalize(ans, video)
    assets = {a.get("id"): a for a in facts.assets}
    usable = {a.get("id") for a in facts.usable_assets()}
    last_end = -1
    for si, s in enumerate(plan["segments"]):
        a, b = pos.get(s["start_word"]), pos.get(s["end_word"])
        if a is None or b is None or b < a:
            errs.append(_err("schema", f"segment {si}: word ids {s['start_word']}-{s['end_word']} are not in this "
                                       "narration (start <= end)"))
            continue
        if a <= last_end:
            errs.append(_err("schema", f"segment {si} ({s['t0']:.1f}-{s['t1']:.1f} s) overlaps the previous screencast"))
        last_end = b
        app = apps.get(s["app"])
        if app is None:
            errs.append(_err("schema", f"segment {si}: app '{s['app']}' is not one of the job's apps {sorted(apps)}"))
            continue
        allowed = set(app["actions"]) | set(CAMERA_ACTIONS) | (set(OUTSIDE_ACTIONS) if s["session"] == "outside" else set())
        for bt in s["beats"]:
            k = pos.get(bt["word_id"])
            sent = _sentence_of(sents, bt["word_id"])
            where = f"beat at {bt['t_word']:.1f} s on '{bt['cue']}'" if bt["t_word"] is not None else f"beat {bt['id']}"
            if k is None or not a <= k <= b:
                errs.append(_err("schema", f"{where}: word {bt['word_id']} is outside its segment "
                                           f"({s['start_word']}-{s['end_word']})", sent))
                continue
            act = bt["action"]
            if act not in allowed:
                if s["session"] == "outside" and act in app["actions"]:
                    why = (f"'{act}' in the 'outside' session: the never-logged-in browser only opens public pages "
                           "(outside.goto) and frames them (camera.zoom)")
                elif act in OUTSIDE_ACTIONS:
                    why = "outside.goto only runs in the 'outside' session (the never-logged-in US browser, RULEBOOK L4)"
                else:
                    known = (app["pb"] or {}).get("actions", {})
                    why = (f"'{act}' is not a proven action of {s['app']} (" + ("unproven: it has not replayed 3/3"
                           if act in known else "no such action") + ") — needs_primitive, never an improvised step")
                errs.append(_err("action", f"{where}: {why}", sent, proposed={"needs_primitive": act}))
            ids = [x for x in (bt.get("asset_id"), bt["subject"][6:] if str(bt["subject"]).startswith("asset:") else None) if x]
            for x in ids:
                if x not in assets:
                    errs.append(_err("asset", f"{where}: asset '{x}' was not produced (produced: {sorted(assets)})", sent))
                elif x not in usable:
                    errs.append(_err("asset", f"{where}: asset '{x}' is {assets[x].get('status')} — not usable", sent))
            pa = ((app["pb"] or {}).get("actions") or {}).get(act) or {}
            if pa.get("kind") in ("paste", "type") and not bt.get("typed_text"):
                errs.append(_err("schema", f"{where}: '{act}' pastes text on camera — give the exact text in 'text' "
                                           "(the recorder pastes exactly the script)", sent))
            from . import beatscript
            filled = beatscript.fill_params(pa, bt["params"], bt)
            for pn, spec in (pa.get("params") or {}).items():
                if spec.get("required") and spec.get("enum") and pn not in filled:
                    errs.append(_err("schema", f"{where}: '{act}' needs its {pn} — name exactly one of "
                                               f"{spec['enum']} in subject (ui:<option>)", sent))
            text = " ".join(x for x in (bt["body"], bt.get("typed_text") or "", bt["params"].get("url") or "") if x)
            if app["pb"] is not None:
                m = playbook.match_beat(app["pb"], text, s["session"])
                if m["status"] == "missing":
                    errs.append(_err("missing", f"{where}: '{bt['body'][:140]}' — {m['feature']}: {m['why']}", sent,
                                     proposed=m.get("proposed")))
                elif m["status"] == "outside":
                    errs.append(_err("session", f"{where}: '{bt['body'][:140]}' — {m['why']}: the segment must be "
                                                "session 'outside' (pricing / visitor views, RULEBOOK L4)", sent,
                                     proposed=m.get("proposed")))
                elif m["status"] == "unknown" and act in CAMERA_ACTIONS:
                    errs.append(_err("action", f"{where}: '{bt['body'][:140]}' describes a UI step but the beat only "
                                               "frames (camera.zoom): name its proven action or move it to "
                                               "needs_primitive", sent))
            for nm in planfit.NAMED_CONTENT_RE.finditer(bt["body"]):
                name = nm.group(1) or nm.group(4)
                if not facts.known_name(name):
                    errs.append(_err("invented", f"{where}: the '{name}' {nm.group(2) or nm.group(3)} is not known to "
                                                 "exist (no produced asset, no page) — never invented", sent))
            if act in OUTSIDE_ACTIONS:
                u = bt["params"].get("url") or ""
                pb = app["pb"]
                ok = u.startswith("http") and (any(h in _host(u) for h in app["hosts"]) or
                                               (pb is not None and playbook.outside_only(pb, u)))
                if not ok:
                    errs.append(_err("session", f"{where}: outside.goto needs a public url of {s['app']} (got '{u}')", sent))
    for x in plan["plates"]:
        for aid in x.get("asset_ids", []):
            if aid not in usable:
                errs.append(_err("asset", f"plate {x['t0']}-{x['t1']} s: asset '{aid}' was not produced"))
    raw = to_raw(plan, apps, video)
    checked = validate(raw, video, list(sites) or [{"url": x["url"]} for x in apps.values()], facts)
    # the fit: what the ledger refused (a rewrite to the honest route is fine), the reference bands, the hook
    # plate, the instruction stretches
    for r in checked["beats"]:
        if r["route"] in ("aroll", "drop") and not str(r.get("why") or "").startswith("its sentence became"):
            sent = _sentence_of(sents, r.get("word_id"))
            errs.append(_err("ledger", f"beat at {r.get('t_word') or 0:.1f} s on '{r['cue']}': {r['why']}", sent))
    for s in plan["segments"]:
        for bt in s["beats"]:
            if bt["action"] in CAMERA_ACTIONS or bt["t_word"] is None:
                continue
            if not any(c["t0"] - 0.05 <= bt["t_word"] < c["t1"] for c in checked["segments"]):
                errs.append(_err("lost", f"beat at {bt['t_word']:.1f} s on '{bt['cue']}' ({bt['action']}) is not on screen "
                                         "after the span structure (its screencast is too short or became an A-roll "
                                         "beat): give it a longer segment (whole sentences, >= 2.5 s)",
                                 _sentence_of(sents, bt["word_id"])))
    st = checked["structure"]
    if video["duration"] >= planfit.LONG_STRUCTURE_S:
        bands = [("span_max", st["span_max"] <= planfit.SPAN_MAX, f"<= {planfit.SPAN_MAX} s"),
                 ("span_p50", planfit.SPAN_P50[0] <= st["span_p50"] <= planfit.SPAN_P50[1], f"{planfit.SPAN_P50} s"),
                 ("share", planfit.SHARE[0] <= st["share"] <= planfit.SHARE[1], f"{planfit.SHARE}"),
                 ("bounds_per_min", planfit.BOUNDS_PER_MIN[0] <= st["bounds_per_min"] <= planfit.BOUNDS_PER_MIN[1],
                  f"{planfit.BOUNDS_PER_MIN}"),
                 ("aroll_p50", st["aroll_blocks"] == 0 or planfit.AROLL_BEAT[0] <= st["aroll_p50"] <= planfit.AROLL_BEAT[1],
                  f"{planfit.AROLL_BEAT} s")]
        for name, ok, band in bands:
            if not ok:
                errs.append(_err("structure", f"structure {name} = {st[name]} is outside the reference band {band} "
                                              "(REFERENCE-BASELINE §1): plan more / fewer / shorter screencast spans"))
    for p in checked["plates"]:
        if p.get("missing"):
            errs.append(_err("plate", f"hook plate {p['t0']}-{p['t1']} s: {p['missing'][0]}"))
    for x in checked["aroll_actions"]:
        if x.get("segment") is None and not any(a.get("why") for a in raw["aroll_why"]
                                                if pos.get(a["start"], 1e9) <= pos.get(x["end"], -1)
                                                and pos.get(a["end"], -1) >= pos.get(x["start"], 1e9)):
            errs.append(_err("instruction", f"instruction stretch {x['t0']:.1f}-{x['t1']:.1f} s (\"{x['words'][:160]}\") "
                                            "has no screencast and no why", word_ids=[x["start"], x["end"]]))
    # every sentence that names a tool / UI step: a beat, a screencast over it or an explicit why; a sentence that
    # names something the app does NOT have: its honest route as a beat, or the presenter's why
    beats_at = {}
    for s in plan["segments"]:
        for bt in s["beats"]:
            beats_at.setdefault(bt["word_id"], []).append((bt["action"], s["session"]))
    whys = [(x["t0"], x["t1"]) for x in plan["aroll"] if x.get("why") and x["t0"] is not None] + \
        [(ws[pos[min(n["word_ids"])]]["start"], ws[pos[max(n["word_ids"])]]["end"])
         for n in plan["needs_primitive"] if n.get("word_ids") and all(i in pos for i in n["word_ids"])]
    spans = [(s["t0"], s["t1"]) for s in plan["segments"] if s["t0"] is not None] + \
        [(s["t0"], s["t1"]) for s in checked["segments"]]
    feats = [(fid, f) for x in apps.values() for fid, f in ((x["pb"] or {}).get("features") or {}).items()
             if not f.get("exists")]
    for s in sents:
        txt = " ".join(w["word"] for w in s)
        if planfit.PRESENTER_RE.search(txt):
            continue
        t0, t1 = s[0]["start"], s[-1]["end"]
        acts = [a for w in s for a in beats_at.get(w["i"], [])]
        has_why = any(a < t1 and t0 < b for a, b in whys)
        in_span = any(max(0.0, min(b, t1) - max(a, t0)) >= 0.5 * max(0.01, t1 - t0) for a, b in spans)
        named = [(fid, f) for fid, f in feats if any(re.search(p, txt, re.I) for p in f.get("patterns", []))]
        if named and not has_why:
            fid, f = named[0]
            hr = f.get("honest_route") or ""
            honest = (any(sess == "outside" for _, sess in acts) if hr.startswith("outside:")
                      else bool(hr) and any(a == hr for a, _ in acts))
            if not honest:
                errs.append(_err("coverage", f"he names {fid} at {t0:.1f} s (\"{txt[:160]}\") — {f.get('fact', fid)}: "
                                             + (f"show the honest route ({hr}) on these words" if hr else "nothing can show "
                                                "it") + ", or give the presenter's why", s,
                                 proposed=hr or None))
        elif planfit.ACTION_RE.search(txt) and not (acts or has_why or in_span):
            errs.append(_err("coverage", f"a UI step at {t0:.1f}-{t1:.1f} s (\"{txt[:160]}\") has no beat and no why", s))
    seen, out = set(), []
    for e in errs:
        if e["msg"] not in seen:
            seen.add(e["msg"])
            out.append(e)
    return out, {"plan": plan, "raw": raw, "checked": checked}


def reask_text(errors, attempt, max_attempts):
    return (f"PLAN CHECK FAILED (answer {attempt} of {max_attempts}). Fix every error below and return the COMPLETE "
            "corrected plan in the same JSON form. Never invent an action, a control, a chat or a picture: where no "
            "proven action or produced asset can show a sentence, put it in needs_primitive (with the honest route) or "
            "leave it on the presenter with a why in \"aroll\".\n" + "\n".join(f"- [{e['code']}] {e['msg']}" for e in errors))


def as_needs_primitive(errors):
    """Errors still open after the last re-ask → needs_primitive rows (plan.schema.json shape)."""
    return [{"sentence": e.get("sentence") or e["msg"][:200], "word_ids": e.get("word_ids") or [],
             "why": e["msg"], "proposed": e.get("proposed"), "code": e["code"]} for e in errors]


def plan_and_check(video, sites, facts=None, sponsored=False, knowledge=None, playbooks=None, rulebook=None,
                   max_reasks=None):
    """The single plan call + checkpoint 1: ask, check, re-ask with the error list (<= config.PLAN_REASKS
    times). → {"answer", "plan", "raw", "checked", "attempts", "needs_primitive", "held", "calls", "usd", "seconds"}.
    held = something is still missing (needs_primitive): the job stops with the list — never A-roll filler."""
    max_reasks = config.PLAN_REASKS if max_reasks is None else max_reasks
    apps = apps_for(sites, playbooks)
    t0 = time.time()
    msgs = [{"role": "user", "content": plan_prompt(video, apps, facts, sponsored, knowledge, rulebook)}]
    attempts, usd, info, errs, ans = [], 0.0, {}, [], {}
    for n in range(max_reasks + 1):
        ans, r = plan_call(video, apps, facts, msgs=msgs)
        usd += r["usd"]
        errs, info = check_plan(ans, video, apps, facts, sites)
        attempts.append({"answer": n + 1, "errors": errs, "usd": r["usd"]})
        events.emit("log", f"plan check {n + 1}/{max_reasks + 1}: " + (f"{len(errs)} error(s)" if errs else "pass"),
                    level="warn" if errs else "info")
        if not errs:
            break
        if n < max_reasks:
            msgs = msgs + [{"role": "assistant", "content": r["content"] or [{"type": "text", "text": r.text}]},
                           {"role": "user", "content": reask_text(errs, n + 1, max_reasks + 1)}]
    needs = list((info.get("plan") or {}).get("needs_primitive") or []) + as_needs_primitive(errs)
    return {"answer": ans, "plan": info.get("plan"), "raw": info.get("raw"), "checked": info.get("checked"),
            "attempts": attempts, "needs_primitive": needs, "held": bool(needs), "apps": sorted(apps),
            "action_ids": action_ids(apps), "calls": len(attempts), "usd": round(usd, 4),
            "seconds": round(time.time() - t0)}


# ════════════════════════════ the overlay plan (one Sonnet call) ════════════════════════════

OVERLAY_SYSTEM = """You place the text overlays of Jake Dawson's YouTube tutorial: on the A-roll (his face) only, on
the words that say them, within the reference budget. Answer with the JSON overlay list only."""
OVERLAY_TEMPLATES = ("lower_title", "link", "subscribe", "socials", "keyword", "list", "number", "question")


def overlay_schema():
    s = lambda: _nul("string")
    return _obj({"overlays": {"type": "array", "items": _obj({
        "template": {"type": "string", "enum": list(OVERLAY_TEMPLATES)}, "start": {"type": "integer"},
        "end": {"type": "integer"}, "line1": s(), "line2": s(), "text": s(),
        "items": {"type": "array", "items": {"type": "string"}}, "label": s(), "value": s(), "prefix": s(),
        "suffix": s(), "why": {"type": "string"}})}})


def overlay_prompt(video, segments, sponsored=False):
    ov = skill.rules().get("overlays", {})
    words = " ".join(f'{w["i"]}:{w["word"]}@{w["start"]:.1f}' for w in video["words"])
    screens = "; ".join(f"{s['t0']:.1f}-{s['t1']:.1f}" for s in segments) or "(none)"
    return f"""{OVERLAYS}

BUDGET (Jake's references, BASELINE §5): {ov.get('total')} overlays in the whole video; {ov.get('first_80s')} in the first
80 s; mid-video ONLY link / like / question lines at <= {ov.get('mid_max_per_min')} per minute (no keyword / list cards
mid-video); the outro (last 60 s) gets {ov.get('outro')}: the viewer question as a "question" line (TX03), the
subscribe / notification-bell ask as "subscribe" (TX05), the follow-me as "socials", the link line as "link".
Overlays sit on the A-roll only: NEVER while a screencast is on (screencasts at {screens}).
Rules: one at a time, 1.5-4.5 s, >= 0.6 s apart; the text is what he says; start/end = word ids.
{"SPONSORED video: no claims beyond what is said." if sponsored else ""}

TRANSCRIPT (id:word@seconds) — "{video.get('title', '')}", {video['duration']:.1f} s:
{words}"""


def _fields(o):
    t = o.get("template")
    if t in ("lower_title", "keyword", "question"):
        return {"line1": o.get("line1") or "", "line2": "" if t == "question" else (o.get("line2") or "")}
    if t == "link":
        return {"text": o.get("text") or "Link in the description"}
    if t == "list":
        return {"items": list(o.get("items") or [])[:4]}
    if t == "number":
        v = o.get("value")
        try:
            v = float(v) if "." in str(v) else int(str(v).replace(",", ""))
        except (TypeError, ValueError):
            pass
        return {"label": o.get("label") or "", "value": v, "prefix": o.get("prefix") or "", "suffix": o.get("suffix") or ""}
    return {}


def overlay_plan(video, segments, sponsored=False):
    """ONE Sonnet call → the raw overlay list ({template, start, end, fields, why}; a question = a TX03
    lower_title line). validate() checks the words and screencasts, planfit.overlays_fit the budget."""
    r = llm.messages(OVERLAY_MODEL, OVERLAY_SYSTEM, overlay_prompt(video, segments, sponsored), 8000, effort="medium",
                     schema=overlay_schema(), stage="preprod.overlays", purpose="Claude overlay plan (Sonnet)")
    ans = _json_answer(r.text)
    out = []
    for o in ans.get("overlays", []):
        q = o.get("template") == "question"
        out.append({"template": "lower_title" if q else o.get("template"), "start": o.get("start"), "end": o.get("end"),
                    "fields": _fields(o), "why": o.get("why", ""), **({"technique": "TX03"} if q else {})})
    return out, r


# ── recording scripts ─────────────────────────────────────────────────────────
SCRIPT_SYSTEM = """You direct a screen recording for a YouTube tutorial. You write the exact browser
steps a recorder will perform, timed against the narration. Use ONLY targets that exist in the page
inventory you are given (match their visible text exactly or by a distinctive part). Return ONLY JSON."""

STEP_DOC = """STEP TYPES (CSS px of a 1920x1080 desktop):
- {"begin": true}  — REQUIRED once, right after the first page has loaded: the segment's t=0.
- {"goto": "<url>", "settle": 2500}
- {"move": {"text": "..."}}  /  {"hover": {"text": "..."}}
- {"click": {"text": "...", "exact": false}, "navigates": true|false}
- {"type": {"target": {"text": "<placeholder or label>"}, "text": "...", "cps": 14}}
- {"scroll": {"by": <px, + = down>, "ms": 900}}
- {"read": {"text": "..."}, "ms": 2000}   — no action; the camera frames this text while it is talked about
- {"highlight": {"text": "..."}, "ms": 1800} — a marker highlight over this text (use for a phrase the speaker reads out)
- any step may carry "at": <seconds after begin> = when its ACTION should land (the click/the read starts),
  and "optional": true (skip if the target is missing).
Targets: {"text": "..."} or {"selector": "..."} (CSS) — prefer text from the inventory."""


def script_prompt(seg, video, inventory):
    ws = [w for w in video["words"] if seg["t0"] - 0.01 <= w["start"] <= seg["t1"]]
    said = " ".join(f'{w["word"]}@{w["start"] - seg["t0"]:.1f}' for w in ws)
    inv = "\n".join(f'- {i["tag"]} "{i["text"]}" at {i["box"]}{"" if i.get("above_fold") else " (below the fold)"}'
                    for i in inventory["items"][:140])
    return f"""{STEP_DOC}

SEGMENT: {seg['t1'] - seg['t0']:.1f} s of screencast. What the viewer should see: {seg['intent']}
Start page: {seg['url']}

NARRATION during the segment (word@seconds after begin):
{said}

PAGE INVENTORY of the start page ("{inventory.get('title', '')}", page height {inventory.get('height')} px):
{inv}

Write steps that:
- begin with goto (the start page), then {{"begin": true}};
- make each action land on the words that describe it (use "at"); something visible should change
  every 3-6 s (a read, a scroll, a hover, a highlight) — the camera zooms to every target, so pick
  targets that matter;
- fill the whole {seg['t1'] - seg['t0']:.1f} s (the last step may be a read that holds);
- never log in, submit forms, buy, or type personal data; navigation to public pages is fine;
- scroll sparingly: animated marketing pages often scroll into empty or black sections (their
  effects are switched off while recording). Prefer reads, hovers and clicks on what the inventory
  shows above the fold; scroll only to reach a listed element below the fold, then read it.
Return {{"steps": [...]}}"""


def write_script(seg, video, inventory, screenshot_jpg=None):
    content = [{"type": "text", "text": script_prompt(seg, video, inventory)}]
    if screenshot_jpg:
        content.insert(0, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                       "data": base64.b64encode(screenshot_jpg).decode()}})
    raw, meta = call(content, SCRIPT_SYSTEM, max_tokens=12000, effort="medium")
    steps = raw.get("steps", [])
    if not any(s.get("begin") for s in steps):
        k = next((n for n, s in enumerate(steps) if s.get("goto")), -1)
        steps.insert(k + 1, {"begin": True})
    for s in steps:                        # a missing target must never kill the recording
        if any(k in s for k in ("move", "hover", "click", "read", "highlight", "type")):
            s.setdefault("optional", True)
    return {"steps": steps, "tail": 1500}, meta
