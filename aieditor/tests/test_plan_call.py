"""The single plan call + checkpoint 1 + the overlay plan + content first (package p6; recommendation step 3,
§3 single calls, §3.2 content first, §4 checkpoint 1). A fake transport: nothing is sent anywhere, no video job,
no browser. The failed end-to-end job (factory-end-to-end-test-mac-rec-10082332-63de) is only used through
tests/fixtures/p6/failed_job.json.gz, built from SCRATCH COPIES of its edl.json / edit-01/direct.json /
edit-01/overlays.json (tests/fixtures/p6/make_fixture.py).

  (a) the failed job's plan, converted to the schema with its invented beats, fails the plan check with errors
      naming @Sketch's picker, the '/background' skill, '/new BG', 'Updated', the logged-in Free card and the
      'Bakery Image Prompt' chat; the re-ask carries the errors; the corrected 2nd answer passes; three failing
      answers end in needs_primitive + held
  (b) the call's action enum = the proven ids of a fixture playbook (+ the two code primitives); unproven absent
  (c) the checked plan keeps the G2 structure: span max <= 30 s, median 10-18 s, share 72-76 %, 3-6
      boundaries/min, A-roll beats 5-7 s, a hook plate in 0-14.7 s, 671.4-688.5 s gets a segment or a why
  (d) overlays_fit on the failed job's 11 overlays: 7-9, <= 0.2/min mid-video, TX03 on the outro question
      (836-843 s), TX05 on 'notification bell' (859.19-859.81 s)
  (e) content first: a photo that keeps missing 'napkin' is regenerated twice, then needs_asset → held; the
      generations are spaced (fake clock); the narrated objects map to assets or are reported
  (f) one Opus plan call + one Sonnet overlay call per plan; preprod.shot_prompt is gone; ledger stage names

Run: python3 tests/test_plan_call.py
"""
import copy
import gzip
import json
import os
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="p6-plan-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")                  # never the live /opt/aieditor-work
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
for k in ("AIEDITOR_API_LEDGER", "AIEDITOR_API_JOB_CAP_USD", "AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_PRIOR_24H_USD",
          "AIEDITOR_API_PRIOR_JOB_USD", "AIEDITOR_API_PRIOR_AT", "ANTHROPIC_API_KEY"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import apiledger, config, director, llm, planfit, playbook, preprod, skill  # noqa: E402

N = 0
FX = ROOT / "tests" / "fixtures" / "p6" / "failed_job.json.gz"


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


# ── the fixture (scratch copies of the failed job) ──
F = json.load(gzip.open(FX, "rt"))
WORDS = [{"i": n, "word": w, "start": s, "end": e} for n, (w, s, e) in enumerate(F["words"])]
VIDEO = {"title": F["title"], "duration": F["duration"], "words": WORDS}
POS = {w["i"]: n for n, w in enumerate(WORDS)}
SITES = F["sites"]
FACTS = planfit.Facts(F["readiness"], F["assets"])


def fixture_pb(proven=None):
    """The ChatGPT playbook as a fixture: every action proven (or only `proven`)."""
    pb = copy.deepcopy(skill.playbook("chatgpt"))
    for aid, a in pb["actions"].items():
        a["proven"] = proven is None or aid in proven
    return pb


PB = fixture_pb()
PBS = {"chatgpt": PB}
APPS = director.apps_for(SITES, PBS)


# ── a fake Messages transport: answers per model, every body kept ──
class Fake:
    def __init__(self):
        self.q, self.bodies = {}, []

    def queue(self, model, *answers):
        self.q.setdefault(model, []).extend(answers)

    def __call__(self, body, stream, timeout):
        self.bodies.append(body)
        ans = self.q[body["model"]].pop(0)
        ans = ans(body) if callable(ans) else ans
        return {"content": [{"type": "thinking", "thinking": "", "signature": "sig"},
                            {"type": "text", "text": json.dumps(ans)}], "stop_reason": "end_turn",
                "usage": {"input_tokens": 20000, "output_tokens": 4000}}

    def models(self):
        return [b["model"] for b in self.bodies]


FAKE = Fake()
llm.TRANSPORT = FAKE


# ── (a) the failed job's plan as a recorded schema answer (its invented beats included) ──
def recorded_answer():
    segs = []
    for s in F["raw"]["segments"]:
        pre, beats = planfit.parse_intent(s["intent"])
        lo, hi = max(0, POS[s["start"]] - 6), min(len(WORDS), POS[s["end"]] + 8)
        after, out = lo - 1, []
        for b in beats:
            k, _ = planfit.resolve_cue(b["cue"], WORDS, lo, hi, after)
            if k is None:
                continue
            after = k
            k = min(max(k, POS[s["start"]]), POS[s["end"]])
            m = playbook.match_beat(PB, f"{b['cue']} :: {b['body']}")
            typed = planfit.classify(b["body"], pre)[2]
            urls = planfit.URL_RE.findall(b["body"])
            out.append({"word_id": WORDS[k]["i"], "action": m["action"] if m["status"] == "action" else "camera.zoom",
                        "body": b["body"], "subject": "screen", "text": typed, "url": urls[0] if urls else None,
                        "asset_id": None, "live": False, "wait_end_word": None})
        segs.append({"start_word": s["start"], "end_word": s["end"], "app": "chatgpt", "session": "logged_in", "beats": out})
    return {"segments": segs, "aroll": [], "plates": [], "needs_primitive": []}


def _sentence_ids(wid):
    s = next(s for s in planfit.sentences(WORDS) if any(w["i"] == wid for w in s))
    return s[0]["i"], s[-1]["i"]


def corrected_answer(ans):
    """What an honest re-answer does with the check's errors: invented beats dropped, the presenter's why for what
    no proven action can show, pricing moved to its own 'outside' segment (outside.goto + camera.zoom)."""
    ans = copy.deepcopy(ans)
    for _ in range(8):
        errs, _info = director.check_plan(ans, VIDEO, APPS, FACTS, SITES)
        if not errs:
            return ans
        outside = set()
        for e in errs:
            wids = set(e["word_ids"])
            prop = e.get("proposed")
            if e["code"] == "session" or (isinstance(prop, dict) and prop.get("session") == "outside"):
                outside |= wids
                continue
            for s in ans["segments"]:
                s["beats"] = [b for b in s["beats"] if b["word_id"] not in wids]
            if wids:
                ans["aroll"].append({"start_word": min(wids), "end_word": max(wids),
                                     "why": "no proven action can show this — the presenter says it: " + e["msg"][:160]})
        if outside:
            new = []
            for s in ans["segments"]:
                ob = [b for b in s["beats"] if b["word_id"] in outside]
                if not ob:
                    new.append(s)
                    continue
                a0 = _sentence_ids(ob[0]["word_id"])[0]
                a1 = _sentence_ids(ob[-1]["word_id"])[1]
                url = next((b["url"] for b in ob if b.get("url")), "https://chatgpt.com/pricing")
                left = {**s, "end_word": WORDS[POS[a0] - 1]["i"], "beats": [b for b in s["beats"] if POS[b["word_id"]] < POS[a0]]}
                right = {**s, "start_word": WORDS[POS[a1] + 1]["i"],
                         "beats": [b for b in s["beats"] if POS[b["word_id"]] > POS[a1]]}
                mid = {"start_word": a0, "end_word": a1, "app": "chatgpt", "session": "outside", "beats": [
                    {"word_id": ob[0]["word_id"], "action": "outside.goto", "body": "the public pricing page, top unzoomed",
                     "subject": "screen", "text": None, "url": url, "asset_id": None, "live": False, "wait_end_word": None}] + [
                    {"word_id": b["word_id"], "action": "camera.zoom", "body": "zoom on the Free plan card",
                     "subject": "ui:Free", "text": None, "url": None, "asset_id": None, "live": False, "wait_end_word": None}
                    for b in ob[1:]]}
                new += [x for x in (left, mid, right) if POS[x["start_word"]] <= POS[x["end_word"]]]
            ans["segments"] = new
    raise AssertionError(f"the corrected answer still fails: {[e['msg'][:120] for e in errs]}")


def test_failed_plan():
    rec = recorded_answer()
    errs, info = director.check_plan(rec, VIDEO, APPS, FACTS, SITES)
    text = "\n".join(e["msg"] for e in errs)
    named = {"@Sketch picker": "@Sketch" in text and "no picker" in text,
             "/background": "slash_background" in text and "background skill" in text,
             "/new BG": "new BG" in text,
             "Updated": "'Updated'" in text,
             "logged-in Free card": "Free plan card" in text and "pricing_in_app" in text,
             "Bakery Image Prompt chat": "'Bakery Image Prompt' chat" in text}
    check(all(named.values()), f"the check names every invented beat: {named}")
    check(any(e["code"] == "session" and "outside" in e["msg"] for e in errs), "logged-in /pricing → session 'outside'")
    good = corrected_answer(rec)
    # 1st answer fails, the re-ask carries the errors, the 2nd (corrected) answer passes
    FAKE.bodies.clear()
    FAKE.queue(config.PLAN_MODEL, rec, good)
    res = director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)")
    check(res["calls"] == 2 and not res["attempts"][1]["errors"] and res["attempts"][0]["errors"], "fail → re-ask → pass")
    check(not res["held"] and not res["needs_primitive"], "a passing plan is not held")
    b2 = FAKE.bodies[1]
    check(len(b2["messages"]) == 3 and b2["messages"][1]["role"] == "assistant"
          and b2["messages"][1]["content"][0]["type"] == "thinking", "re-ask: append-only, the answer's blocks kept")
    check("PLAN CHECK FAILED" in b2["messages"][2]["content"] and "Bakery Image Prompt" in b2["messages"][2]["content"],
          "the re-ask lists the errors")
    check(b2["messages"][0] == FAKE.bodies[0]["messages"][0], "the first turn is unchanged")
    # three failing answers → needs_primitive + held
    FAKE.queue(config.PLAN_MODEL, rec, rec, rec)
    res3 = director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)")
    check(res3["calls"] == 3 and res3["held"] and len(res3["needs_primitive"]) >= len(named),
          f"3 failures → held: {res3['calls']} calls, {len(res3['needs_primitive'])} needs_primitive")
    check(all(n.get("why") and "sentence" in n for n in res3["needs_primitive"]), "needs_primitive rows carry the why")
    held = preprod.held_items({"needs_primitive": res3["needs_primitive"]}, {"assets": []})
    check(held and all(h["reason"] == "needs_primitive" for h in held), "held reasons for the worker")
    return good, res


def test_enum():
    proven = {"paste_prompt", "send", "plus_sketch", "open_plus_menu"}
    pb = fixture_pb(proven)
    apps = director.apps_for(SITES, {"chatgpt": pb})
    FAKE.bodies.clear()
    FAKE.queue(config.PLAN_MODEL, {"segments": [], "aroll": [], "plates": [], "needs_primitive": []})
    director.plan_call(VIDEO, apps, FACTS, rulebook="(digest)")
    body = FAKE.bodies[-1]
    sch = body["output_config"]["format"]["schema"]
    enum = sch["properties"]["segments"]["items"]["properties"]["beats"]["items"]["properties"]["action"]["enum"]
    builtin = set(director.CAMERA_ACTIONS) | set(director.OUTSIDE_ACTIONS)
    check(set(enum) - builtin == proven, f"enum = the proven ids (+ code primitives): {sorted(enum)}")
    unproven = set(pb["actions"]) - proven
    check(not unproven & set(enum), "no unproven id in the enum")
    prompt = body["messages"][0]["content"]
    listed = {ln.split("[")[0].strip(" -") for ln in prompt.splitlines() if ln.startswith("  - ") and " [" in ln}
    check(listed == proven, f"the prompt's closed list = the proven ids: {sorted(listed)}")
    check(body["model"] == config.PLAN_MODEL and body["output_config"]["effort"] == "high", "Opus, effort high")
    check(body["output_config"]["format"]["type"] == "json_schema", "strict JSON (structured outputs)")
    # the real ChatGPT playbook proves nothing yet → only the code primitives
    real = director.apps_for(SITES)
    check(set(director.action_ids(real)) == builtin, "chatgpt.json (proven:false) → only camera.zoom / outside.goto")
    # an unproven action in an answer fails the check (an answer made without the enum, e.g. a recorded one)
    ans = {"segments": [{"start_word": 46, "end_word": 80, "app": "chatgpt", "session": "logged_in", "beats": [
        {"word_id": 50, "action": "viewer_erase", "body": "click Erase", "subject": "ui:Erase", "text": None, "url": None,
         "asset_id": None, "live": False, "wait_end_word": None}]}], "aroll": [], "plates": [], "needs_primitive": []}
    errs, _ = director.check_plan(ans, VIDEO, apps, FACTS, SITES)
    check(any(e["code"] == "action" and "unproven" in e["msg"] for e in errs), "an unproven action is refused")


def test_structure(good):
    errs, info = director.check_plan(good, VIDEO, APPS, FACTS, SITES)
    check(not errs, f"the corrected plan passes: {[e['msg'][:100] for e in errs]}")
    c = info["checked"]
    st = c["structure"]
    check(st["span_max"] <= 30.0, f"span max {st['span_max']}")
    check(10.0 <= st["span_p50"] <= 18.0, f"span median {st['span_p50']}")
    check(0.72 <= st["share"] <= 0.76, f"share {st['share']}")
    check(3.0 <= st["bounds_per_min"] <= 6.0, f"boundaries/min {st['bounds_per_min']}")
    check(5.0 <= st["aroll_p50"] <= 7.0, f"A-roll beats {st['aroll_p50']}")
    pl = c["plates"]
    check(len(pl) == 1 and pl[0]["t0"] < 1.0 and pl[0]["t1"] <= 14.7 and pl[0]["assets"], f"hook plate in 0-14.7 s: {pl}")
    seg = any(s["t0"] < 688.5 and 671.4 < s["t1"] for s in c["segments"])
    why = any(x["t0"] < 688.5 and 671.4 < x["t1"] and x.get("why") for x in info["plan"]["aroll"])
    check(seg or why, "671.4-688.5 s gets a segment or a why")
    out = [s for s in c["segments"] if (s.get("session") or {}).get("kind") == "public"]
    check(out and all(s["session"]["locale"] == "en-US" and s["session"]["egress"] == "US" for s in out),
          "the pricing segment records in the outside session (en-US, US route)")
    check(all(a["action"] in ("outside.goto", "camera.zoom") for s in out for a in s.get("actions", [])),
          "the outside session only opens and frames")
    acts = [a for s in c["segments"] for a in s.get("actions", [])]
    check(acts and all(a["action"] in director.action_ids(APPS) for a in acts), "every recorded beat is a closed-list action")
    check(all(s["t0"] - 0.05 <= a["t_word"] < s["t1"] for s in c["segments"] for a in s.get("actions", [])),
          "schema beats ride with the fitted segment that shows them")
    for s in c["segments"]:
        check(s["t1"] - s["t0"] >= 2.5, "no span under 2.5 s")
    sch = skill.schema("plan")
    errs = director._schema_errors(info["plan"], sch)
    check(not errs, f"the normalized plan matches plan.schema.json: {errs[:3]}")


def test_overlays():
    ov = F["overlays"]
    check(len(ov) == 11, "the failed job placed 11 overlays")
    r = planfit.overlays_fit(ov, VIDEO, F["plan_segments"])
    kept = r["overlays"]
    check(7 <= len(kept) <= 9, f"7-9 overlays: {len(kept)}")
    check(r["budget"]["mid_per_min"] <= 0.2 and all(planfit.overlay_kind(e) in planfit.OV_MID_KINDS for e in kept
                                                    if 80 <= e["t0"] < VIDEO["duration"] - 60), f"mid-video: {r['budget']}")
    check(3 <= r["budget"]["first"] <= 5 and 3 <= r["budget"]["outro"] <= 4, f"first 80 s / outro: {r['budget']}")
    tx03 = [e for e in kept if e.get("technique") == "TX03"]
    check(tx03 and tx03[0]["t0"] <= 836.45 and tx03[0]["t1"] >= 842.08 and "What are you editing first?" in tx03[0]["fields"]["line1"],
          f"TX03 on the outro question 836-843: {tx03}")
    tx05 = [e for e in kept if e["template"] == "subscribe" and e["t0"] > VIDEO["duration"] - 60]
    check(tx05 and tx05[0]["t0"] <= 859.19 and tx05[0]["t1"] >= 859.81, f"TX05 on 'notification bell': {tx05}")
    check({e["template"] for e in r["dropped"]} <= {"keyword", "list"} and len(r["dropped"]) == 4,
          f"the mid-video keyword/list cards are the ones dropped: {[(e['template'], e['t0']) for e in r['dropped']]}")
    check(r["ok"], "the budget holds")
    check(all(b["t0"] - a["t1"] >= 0.6 - 1e-6 for a, b in zip(kept, kept[1:])), ">= 0.6 s between overlays")
    # the same through validate (the Sonnet overlay plan path): a 20 s test keeps its overlays
    short = {"title": "t", "duration": 20.0, "words": WORDS[:40]}
    check(planfit.overlays_fit(ov[:2], short)["overlays"] == [dict(e) for e in ov[:2]], "short tests are untouched")


class Clock:
    def __init__(self):
        self.t = 1000.0
        self.slept = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def test_content_first():
    job = type("J", (), {})()
    texts = []
    for s in planfit.sentences(WORDS):
        texts.append({"s": len(texts), "ids": [w["i"] for w in s], "t0": s[0]["start"], "t1": s[-1]["end"],
                      "text": " ".join(w["word"] for w in s)})
    job.sents = texts
    man = preprod.asset_manifest(job)
    ids = {a["id"]: a for a in man["assets"]}
    check({"phone_photo", "sketch", "sketch_photo"} <= set(ids), f"the manifest: {sorted(ids)}")
    rows = {}
    for o in man["objects"]:
        rows.setdefault(o["object"], []).append(o)
    for obj in ("napkin", "sun", "picnic table", "chili pepper", "label", "phone photo", "sketch"):
        r = rows.get(obj)
        check(r and all(x.get("asset") in ids or x["status"] == "missing" for x in r),
              f"'{obj}' maps to an asset or is reported: {r}")
    sk = ids["sketch"]
    check({d["shape"] for d in sk["doodle"]} >= {"sun", "table", "pepper"}, f"the drawn objects are in the doodle: {sk['doodle']}")
    gen = ids["sketch_photo"]["prompt"].lower()
    check("napkin" in gen or "napkin" in ids["phone_photo"].get("prompt", "").lower(), "the napkin is in a generated picture")
    # generation check: a photo that keeps missing the napkin → 2 regenerations → needs_asset → held
    out = TMP / "assets-run"
    out.mkdir()
    sl = {"shots": [{"id": "N1", "needs": ["photo"]}], "assets": [
        {"id": "photo", "kind": "photo", "desc": "phone photo of a hot sauce bottle", "prompt": "a hot sauce bottle with a napkin"},
        {"id": "photo2", "kind": "photo", "desc": "the bottle on a table", "prompt": "a bottle on a picnic table"}],
          "objects": [{"object": "napkin", "asset": "photo", "status": "added"},
                      {"object": "picnic table", "asset": "photo2", "status": "added"}]}
    prompts, saved = [], preprod.gen_photo
    clock = Clock()

    def fake_photo(prompt, dst, **kw):
        prompts.append(prompt)
        Path(dst).write_bytes(b"\x89PNG fake")
        return 0.06
    FAKE.bodies.clear()
    FAKE.queue(config.VISION_MODEL, *([{"matches": False, "missing_objects": ["napkin"]}] * 3),
               {"matches": True, "missing_objects": []})
    try:
        preprod.gen_photo = fake_photo
        res = preprod.build_assets(sl, out, None, 3.0, spacer=preprod.Spacer(45, clock, clock.sleep))
    finally:
        preprod.gen_photo = saved
    a = {x["id"]: x for x in res["assets"]}
    check(a["photo"]["status"] == "needs_asset" and len(a["photo"]["checks"]) == 3, f"napkin missing 3× → needs_asset: {a['photo']}")
    check(len(prompts) == 4 and "napkin" in prompts[1] and "It must clearly show napkin" in prompts[2],
          "2 regenerations name the missing object")
    check(a["photo2"]["status"] == "ready" and len(a["photo2"]["checks"]) == 1, "a matching picture passes first time")
    gaps = [b - x for x, b in zip(res["generations_at"], res["generations_at"][1:])]
    check(len(gaps) == 3 and all(g >= 45 - 1e-9 for g in gaps), f"generations spaced >= 45 s (fake clock): {gaps}")
    check(len(FAKE.bodies) == 4 and all(b["model"] == config.VISION_MODEL for b in FAKE.bodies), "one Sonnet vision call each")
    img = FAKE.bodies[0]["messages"][0]["content"][0]
    check(img["type"] == "image" and "napkin" in FAKE.bodies[0]["messages"][0]["content"][1]["text"], "the check sees the picture")
    check(FAKE.bodies[0]["output_config"]["format"]["schema"] == preprod.GEN_CHECK_SCHEMA, "{matches, missing_objects}")
    held = preprod.held_items({}, res)
    check([h["reason"] for h in held] == ["needs_asset"] and "napkin" in held[0]["detail"], f"needs_asset → held: {held}")
    check(config.GEN_SPACING_S == 45 and config.GEN_REGENS == 2, "defaults: 45 s spacing, 2 regenerations")


def test_call_count(good):
    q0 = next(w["i"] for w in WORDS if w["word"] == "What" and 836 < w["start"] < 837)
    q1 = next(w["i"] for w in WORDS if w["word"] == "first?" and 837 < w["start"] < 838)
    FAKE.bodies.clear()
    FAKE.queue(config.PLAN_MODEL, good)
    FAKE.queue(config.OVERLAY_MODEL, {"overlays": [
        {"template": "keyword", "start": 13, "end": 20, "line1": "Drew with a mouse", "line2": "in about 10 seconds",
         "text": None, "items": [], "label": None, "value": None, "prefix": None, "suffix": None, "why": "hook"},
        {"template": "question", "start": q0, "end": q1, "line1": "What are you editing first?", "line2": None,
         "text": None, "items": [], "label": None, "value": None, "prefix": None, "suffix": None, "why": "outro question"}]})
    plan, raw, meta = director.plan(VIDEO, SITES, False, None, facts=FACTS, playbooks=PBS, rulebook="(digest)")
    models = FAKE.models()
    check(models == [config.PLAN_MODEL, config.OVERLAY_MODEL], f"1 Opus + 1 Sonnet per plan: {models}")
    check(meta["calls"] == {config.PLAN_MODEL: 1, config.OVERLAY_MODEL: 1}, f"meta calls {meta['calls']}")
    check(not plan["held"] and plan["segments"] and plan["overlays"], "plan + overlays")
    check(any(e.get("technique") == "TX03" and e.get("why") == "outro question" for e in plan["overlays"]),
          f"the Sonnet question → a TX03 line on the A-roll: {plan['overlays']}")
    check(FAKE.bodies[1]["output_config"]["format"]["type"] == "json_schema", "the overlay call is strict JSON too")
    check(not hasattr(preprod, "shot_prompt") and not hasattr(preprod, "SHOT_SYSTEM"), "preprod.shot_prompt is gone")
    src = (ROOT / "aieditor" / "preprod.py").read_text()
    check("director.call(" not in src, "pre-production makes no free-form director call")
    rows = apiledger.rows()
    stages = {r["stage"] for r in rows}
    check({"preprod.plan", "preprod.overlays", "preprod.gencheck"} <= stages, f"ledger stage names: {stages}")
    check(all(r["model"] in (config.PLAN_MODEL, config.OVERLAY_MODEL, config.VISION_MODEL) for r in rows), "priced models")
    # the cached raw re-validates to the same plan (longedit re-validates every run)
    again = director.validate(raw, VIDEO, SITES, FACTS)
    check([s["t0"] for s in again["segments"]] == [s["t0"] for s in plan["segments"]]
          and again["overlays"] == plan["overlays"], "validate(raw) is stable")


def main():
    good, _ = test_failed_plan()
    test_enum()
    test_structure(good)
    test_overlays()
    test_content_first()
    test_call_count(good)
    print(f"test_plan_call: {N} checks passed")


if __name__ == "__main__":
    main()
