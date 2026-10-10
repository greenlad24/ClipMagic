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
  (e) content first: a photo that keeps missing 'napkin' is regenerated up to GEN_REGENS (9) times, then needs_asset → held; the
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
import threading
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
LOCK = threading.Lock()
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
        self.q, self.bodies, self.fixed = {}, [], {}
        self.usage = None                 # fn(body) -> usage dict (sized like the real calls), else a flat default
        self.stop = None                  # fn(body) -> stop_reason override (a truncated reply)

    # answers are filed by WHICH call asks (every call is Opus 5.5 now — Jake 2026-10-09); a section call pops the
    # queue, then falls back to the role's fixed answer (sectioned planning: one call per section)
    def queue(self, role, *answers):
        self.q.setdefault(role, []).extend(answers)

    @staticmethod
    def role(body):
        sysp = body.get("system") or ""
        sysp = sysp if isinstance(sysp, str) else json.dumps(sysp)
        return ("plan" if director.PLAN_SYSTEM[:60] in sysp else
                "overlay" if director.OVERLAY_SYSTEM[:60] in sysp else "vision")

    def __call__(self, body, stream, timeout):
        with LOCK:
            self.bodies.append(body)
            q = self.q.get(self.role(body)) or []
            ans = q.pop(0) if q else self.fixed[self.role(body)]
        ans = ans(body) if callable(ans) else ans
        text = ans if isinstance(ans, str) else json.dumps(ans)
        return {"content": [{"type": "thinking", "thinking": "", "signature": "sig"},
                            {"type": "text", "text": text}],
                "stop_reason": (self.stop(body) if self.stop else None) or "end_turn",
                "usage": self.usage(body) if self.usage else {"input_tokens": 20000, "output_tokens": 4000}}

    def models(self):
        return [b["model"] for b in self.bodies]

    def roles(self):
        return [self.role(b) for b in self.bodies]


FAKE = Fake()
llm.TRANSPORT = FAKE
director.SECTION_WARM_S = 0.0          # no cache-warm pause offline
SECS = director.plan_sections(VIDEO)
NSEC = len(SECS)


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
            if e["code"] == "screen_ref":          # R13/C8: the sentence's uncovered words get their own screencast
                taken = {POS[w["i"]] for s in ans["segments"] for w in WORDS[POS[s["start_word"]]:POS[s["end_word"]] + 1]}
                free = sorted(POS[i] for i in wids if POS[i] not in taken)
                if free:
                    run = [free[0]]
                    for k in free[1:]:
                        if k != run[-1] + 1:
                            break
                        run.append(k)
                    ans["segments"].append({"start_word": WORDS[run[0]]["i"], "end_word": WORDS[run[-1]]["i"], "app": "chatgpt",
                                            "session": "logged_in", "beats": [
                        {"word_id": WORDS[run[0]]["i"], "action": "camera.zoom", "body": "the screen he refers to",
                         "subject": "screen", "text": None, "url": None, "asset_id": None, "live": False,
                         "wait_end_word": None}]})
                    ans["segments"].sort(key=lambda s: POS[s["start_word"]])
                continue
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
    # sectioned: every section's 1st answer fails (the whole recorded answer, clipped to the section by the merge),
    # each re-ask carries ONLY its section's errors, the corrected 2nd answers pass
    check(NSEC >= 5, f"a 15-min narration is planned in ~150 s sections: {NSEC}")
    FAKE.bodies.clear()
    FAKE.fixed["plan"] = lambda body: good if len(body["messages"]) > 1 else rec
    res = director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)")
    first, again = FAKE.bodies[:NSEC], FAKE.bodies[NSEC:]
    bad = set(res["attempts"][0]["sections"])
    check(res["attempts"][0]["errors"] and not res["attempts"][1]["errors"], "fail → patch re-asks → pass")
    check(res["calls"] == NSEC + len(again) and len(again) == len(bad) and 0 < len(bad),
          f"one call per section + one re-ask per section WITH errors: {res['calls']} calls, sections {sorted(bad)}")
    check(not res["held"] and not res["needs_primitive"], "a passing plan is not held")
    b2 = again[0]
    check(len(b2["messages"]) == 3 and b2["messages"][1]["role"] == "assistant"
          and b2["messages"][1]["content"][0]["type"] == "thinking", "re-ask: append-only, the answer's blocks kept")
    re_txt = "\n".join(b["messages"][2]["content"] for b in again)
    check(all("PLAN CHECK FAILED for YOUR SECTION" in b["messages"][2]["content"] and "THIS SECTION ONLY" in b["messages"][2]["content"]
              for b in again), "the re-ask asks for its own section only")
    check("Bakery Image Prompt" in re_txt, "the re-asks list the errors")
    k_of = lambda b: next(s_["n"] for s_ in SECS if f"YOUR SECTION: {s_['n']} of" in b["messages"][0]["content"][1]["text"])
    check(sorted(k_of(b) for b in again) == sorted(bad), "only the sections with errors are re-asked")
    check(all(b["messages"][0] in [f["messages"][0] for f in first] for b in again), "the first turn is unchanged")
    check(all(b["max_tokens"] <= 16000 for b in FAKE.bodies), "section calls fit in 16k output tokens")
    # three failing answers → needs_primitive + held
    FAKE.fixed["plan"] = rec
    res3 = director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)")
    check(len(res3["attempts"]) == 3 and res3["held"] and len(res3["needs_primitive"]) >= len(named),
          f"3 failures → held: {len(res3['attempts'])} rounds, {len(res3['needs_primitive'])} needs_primitive")
    check(all(n.get("why") and "sentence" in n for n in res3["needs_primitive"]), "needs_primitive rows carry the why")
    held = preprod.held_items({"needs_primitive": res3["needs_primitive"]}, {"assets": []})
    check(held and all(h["reason"] == "needs_primitive" for h in held), "held reasons for the worker")
    return good, res


def test_enum():
    proven = {"paste_prompt", "send", "plus_sketch", "open_plus_menu"}
    pb = fixture_pb(proven)
    apps = director.apps_for(SITES, {"chatgpt": pb})
    FAKE.bodies.clear()
    FAKE.queue("plan", {"segments": [], "aroll": [], "plates": [], "needs_primitive": []})
    director.plan_call(VIDEO, apps, FACTS, rulebook="(digest)")
    body = FAKE.bodies[-1]
    blocks = body["messages"][0]["content"]
    check(blocks[0].get("cache_control") == {"type": "ephemeral"} and "cache_control" not in blocks[1]
          and body["system"][0].get("cache_control") == {"type": "ephemeral"},
          "prompt caching: breakpoints on the system and the shared rules block")
    sch = body["output_config"]["format"]["schema"]
    enum = sch["properties"]["segments"]["items"]["properties"]["beats"]["items"]["properties"]["action"]["enum"]
    builtin = set(director.CAMERA_ACTIONS) | set(director.OUTSIDE_ACTIONS)
    check(set(enum) - builtin == proven, f"enum = the proven ids (+ code primitives): {sorted(enum)}")
    unproven = set(pb["actions"]) - proven
    check(not unproven & set(enum), "no unproven id in the enum")
    prompt = "".join(b["text"] for b in body["messages"][0]["content"])
    listed = {ln.split("[")[0].strip(" -") for ln in prompt.splitlines() if ln.startswith("  - ") and " [" in ln}
    check(listed == proven, f"the prompt's closed list = the proven ids: {sorted(listed)}")
    check(body["model"] == config.PLAN_MODEL and body["output_config"]["effort"] == "high", "Opus, effort high")
    check(body["output_config"]["format"]["type"] == "json_schema", "strict JSON (structured outputs)")
    # the real ChatGPT playbook → its PROVEN actions (the 2026-10-09 proving run) + the code primitives
    real = director.apps_for(SITES)
    proven_real = set(playbook.actions("chatgpt", proven_only=True)) if "chatgpt" in real else set()
    check(set(director.action_ids(real)) == builtin | proven_real, "chatgpt.json → its proven ids + camera.zoom / outside.goto")
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
    # generation check: a photo that keeps missing the napkin → every try fails (1 + GEN_REGENS, Jake: up to 10) → needs_asset → held
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
    FAKE.queue("vision", *([{"matches": False, "missing_objects": ["napkin"]}] * (config.GEN_REGENS + 1)),
               {"matches": True, "missing_objects": []})
    try:
        preprod.gen_photo = fake_photo
        res = preprod.build_assets(sl, out, None, 3.0, spacer=preprod.Spacer(45, clock, clock.sleep))
    finally:
        preprod.gen_photo = saved
    a = {x["id"]: x for x in res["assets"]}
    check(a["photo"]["status"] == "needs_asset" and len(a["photo"]["checks"]) == config.GEN_REGENS + 1, f"napkin missing on all {config.GEN_REGENS + 1} tries → needs_asset: {a['photo']}")
    check(len(prompts) == config.GEN_REGENS + 2 and "napkin" in prompts[1] and "It must clearly show napkin" in prompts[2],
          "every regeneration names the missing object (10 photo tries + the second asset)")
    check(a["photo2"]["status"] == "ready" and len(a["photo2"]["checks"]) == 1, "a matching picture passes first time")
    gaps = [b - x for x, b in zip(res["generations_at"], res["generations_at"][1:])]
    check(len(gaps) == config.GEN_REGENS + 1 and all(g >= 45 - 1e-9 for g in gaps), f"generations spaced >= 45 s (fake clock): {gaps}")
    check(len(FAKE.bodies) == config.GEN_REGENS + 2 and all(b["model"] == config.VISION_MODEL for b in FAKE.bodies), "one Opus 5.5 vision call each")
    img = FAKE.bodies[0]["messages"][0]["content"][0]
    check(img["type"] == "image" and "napkin" in FAKE.bodies[0]["messages"][0]["content"][1]["text"], "the check sees the picture")
    check(FAKE.bodies[0]["output_config"]["format"]["schema"] == preprod.GEN_CHECK_SCHEMA, "{matches, missing_objects}")
    held = preprod.held_items({}, res)
    check([h["reason"] for h in held] == ["needs_asset"] and "napkin" in held[0]["detail"], f"needs_asset → held: {held}")
    check(config.GEN_SPACING_S == 45 and config.GEN_REGENS == 9, "defaults: 45 s spacing, 9 regenerations (up to 10 tries, Jake)")


def test_call_count(good):
    q0 = next(w["i"] for w in WORDS if w["word"] == "What" and 836 < w["start"] < 837)
    q1 = next(w["i"] for w in WORDS if w["word"] == "first?" and 837 < w["start"] < 838)
    FAKE.bodies.clear()
    FAKE.fixed["plan"] = good
    FAKE.queue("overlay", {"overlays": [
        {"template": "keyword", "start": 13, "end": 20, "line1": "Drew with a mouse", "line2": "in about 10 seconds",
         "text": None, "items": [], "label": None, "value": None, "prefix": None, "suffix": None, "why": "hook"},
        {"template": "question", "start": q0, "end": q1, "line1": "What are you editing first?", "line2": None,
         "text": None, "items": [], "label": None, "value": None, "prefix": None, "suffix": None, "why": "outro question"}]})
    plan, raw, meta = director.plan(VIDEO, SITES, False, None, facts=FACTS, playbooks=PBS, rulebook="(digest)")
    models = FAKE.models()
    check(FAKE.roles() == ["plan"] * NSEC + ["overlay"] and set(models) == {"claude-opus-5-5"},
          f"1 plan call per section + 1 overlay call, all Opus 5.5 (Jake: all calls on Opus): {FAKE.roles()}")
    check(meta["calls"] == {"plan": NSEC, "overlay": 1} and len(meta["sections"]) == NSEC, f"meta calls {meta['calls']}")
    check(not plan["held"] and plan["segments"] and plan["overlays"], "plan + overlays")
    check(any(e.get("technique") == "TX03" and e.get("why") == "outro question" for e in plan["overlays"]),
          f"the Sonnet question → a TX03 line on the A-roll: {plan['overlays']}")
    check(FAKE.bodies[-1]["output_config"]["format"]["type"] == "json_schema", "the overlay call is strict JSON too")
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


def test_handoff(good):
    """Integration p6 -> p7/p4: the checked plan's schema beats (director.validate "actions") are what the scripted
    recorder compiles and what the take gate expects; the two code primitives compile without a playbook action."""
    from aieditor import beatscript, gates, recorder
    errs, info = director.check_plan(good, VIDEO, APPS, FACTS, SITES)
    check(not errs, "the corrected plan passes")
    segs = info["checked"]["segments"]
    sched = recorder.schema_segments({"segments": segs}, WORDS, PBS)
    for s, x in zip(segs, sched):
        if s.get("actions") is not None:
            check([b["action"] for b in x["beats"]] == [b["action"] for b in s["actions"]],
                  "the recorder compiles the plan call's schema beats, not planfit's G2 ledger rows")
    outs = [x for x in sched if x["session"] == "outside"]
    check(outs and all(x["app"] == "chatgpt" for x in outs), "pricing segments reach the recorder as 'outside'")
    cp = beatscript.compile_plan(sched, WORDS, PBS, assets={"assets": []})
    for x, c in zip(sched, cp["segments"]):
        why = str((c.get("blocked") or {}).get("why") or "")
        check("camera.zoom" not in why and "outside.goto" not in why, f"a code primitive never blocks a segment: {why}")
        if x["session"] == "outside":
            check(not c.get("blocked"), f"the outside segment compiles: {why}")
            check(c["steps"][0]["type"] == "goto" and c["steps"][0]["url"].startswith("https://chatgpt.com/pricing"),
                  f"outside.goto opens the public pricing page first: {c['steps'][:1]}")
            check(all(st["type"] in ("goto", "read") for st in c["steps"]), "the outside view only opens and frames")
            check(c["steps"][0]["url"] in c["url_allow"], "the outside.goto url is allowed for the session")
    # an in-app action in the outside session, or outside.goto in the logged-in one, is needs_primitive (held)
    o = dict(outs[0], beats=[dict(outs[0]["beats"][0], action="send")] + outs[0]["beats"][1:])
    try:
        beatscript.compile_segment(o, WORDS, PB, 0)
        check(False, "an app action in the outside session must not compile")
    except beatscript.NeedsPrimitive:
        check(True, "app action in the outside session -> needs_primitive")
    li = dict(outs[0], session="logged_in")
    try:
        beatscript.compile_segment(li, WORDS, PB, 0)
        check(False, "outside.goto in a logged-in session must not compile")
    except beatscript.NeedsPrimitive:
        check(True, "outside.goto in the logged-in session -> needs_primitive")
    # a compiled camera.zoom beat reaches the reference camera as a target (p3 moves only to a target_box)
    cam = [st for c in cp["segments"] for st in c["steps"] if st.get("camera_only") and st.get("beat")]
    check(cam and all(st["type"] == "read" and not st.get("filler") for st in cam), "camera.zoom -> a camera-only read beat")
    js = (ROOT / "screencast" / "agent_rec.mjs").read_text()
    check("a.camera_only && a.beat && !a.filler ? { target_box: toCap(b) }" in js,
          "agent_rec.mjs logs a compiled camera beat's read with its target_box")
    sys.path.insert(0, str(ROOT / "screencast"))
    import camera as CAM
    W, H = 2560, 1440
    ev = {"type": "read", "t": 1.0, "box": [800, 400, 600, 300], "target_box": [800, 400, 600, 300], "beat": True}
    check(CAM.camera_box(ev, W, H) == [800, 400, 600, 300], "camera.py frames the compiled camera beat")
    check(CAM.camera_box({k: v for k, v in ev.items() if k != "target_box"}, W, H) is None,
          "a plain read (filler hold) still never moves the camera")
    # the take gate's expectations come from the same schema beats
    exp = gates.expectations({"segments": segs}, WORDS)
    for i, s in enumerate(segs):
        if s.get("actions"):
            check(len(exp["segments"][str(i)]) == len([b for b in s["actions"] if b.get("t_word") is not None]),
                  "expect.json beats = the plan call's beats")
    # params the plan call cannot name directly: an enum option is read from the beat's own words
    ra = PB["actions"]["resize_option"]
    check(beatscript.fill_params(ra, {}, {"subject": "ui:Square 1:1", "body": "picks the square"}) == {"shape": "Square 1:1"},
          "resize_option.shape from the subject")
    check("shape" not in beatscript.fill_params(ra, {}, {"subject": "screen", "body": "picks a size"}), "no guess")
    try:
        beatscript._resolve(PB, "resize_option", {})
        check(False, "a missing required param must not crash the compile")
    except beatscript.CompileError:
        check(True, "missing param -> CompileError (blocked, held)")
    # the plan check refuses a paste with no script text and a resize with no option (re-asked, never recorded)
    bad = copy.deepcopy(good)
    seg = next(s for s in bad["segments"] if s["session"] == "logged_in" and s["beats"])
    b0 = seg["beats"][0]
    seg["beats"][0] = dict(b0, action="paste_prompt", text=None)
    errs, _ = director.check_plan(bad, VIDEO, APPS, FACTS, SITES)
    check(any("pastes text" in e["msg"] for e in errs), "paste without its text is a plan-check error")
    seg["beats"][0] = dict(b0, action="resize_option", subject="screen", body="the size menu", text=None)
    errs, _ = director.check_plan(bad, VIDEO, APPS, FACTS, SITES)
    check(any("needs its shape" in e["msg"] for e in errs), "resize without an option is a plan-check error")


# ════════════════════════════ sectioned planning (2026-10-10) ════════════════════════════

def _synth(n_sent, flagged=()):
    """n_sent sentences of 6 words (3.0 s each + 0.3 s pause); flagged ones refer to the screen (R13/C8)."""
    ws, t = [], 0.1
    for k in range(n_sent):
        text = ("As you can see it here." if k in flagged else "We go to the next step.").split()
        for w in text:
            ws.append({"i": len(ws), "word": w, "start": round(t, 3), "end": round(t + 0.4, 3)})
            t += 0.5
        t += 0.3
    return {"title": "synthetic", "duration": round(t, 2), "words": ws}


def _check_sections(video, secs):
    ws = video["words"]
    sents = planfit.sentences(ws)
    ends = {s[-1]["i"] for s in sents}
    flagged = director._screen_runs(ws, sents)
    by_last = {s[-1]["i"]: k for k, s in enumerate(sents)}
    check(secs[0]["p0"] == 0 and secs[-1]["p1"] == len(ws) - 1
          and all(b["p0"] == a["p1"] + 1 for a, b in zip(secs, secs[1:])), "sections cover every word once, in order")
    check(all(s["last"] in ends for s in secs), "every section ends at a sentence end (no sentence is split)")
    for a in secs[:-1]:
        k = by_last[a["last"]]
        check(not (flagged[k] and flagged[k + 1]), f"no boundary inside a screen-reference run (after S{k})")


def test_sectioning():
    _check_sections(VIDEO, SECS)
    lens = [s["t1"] - s["t0"] for s in SECS]
    check(all(119.0 <= x <= 181.0 for x in lens[:-1]) and lens[-1] >= 60.0, f"sections ~120-180 s: {lens}")
    check(director.plan_sections({**VIDEO, "words": WORDS[:200], "duration": WORDS[199]["end"]})[0]["of"] == 1,
          "a short video is one section")
    # a screen-reference run over the whole first window (99-234 s): the cut moves to the end of the run
    v = _synth(300, flagged=set(range(30, 71)))
    secs = director.plan_sections(v)
    _check_sections(v, secs)
    sents = planfit.sentences(v["words"])
    check(secs[0]["last"] == sents[70][-1]["i"], f"the run stays in one section: section 1 ends {secs[0]['t1']} s")
    check(len(secs) >= 5, f"the rest is still sectioned: {[(s['t0'], s['t1']) for s in secs]}")


def _seg(a, b, beats=(), app="chatgpt", session="logged_in"):
    return {"start_word": WORDS[a]["i"], "end_word": WORDS[b]["i"], "app": app, "session": session,
            "beats": [{"word_id": WORDS[k]["i"], "action": "camera.zoom", "body": f"b{k}", "subject": "screen", "text": None,
                       "url": None, "asset_id": None, "live": False, "wait_end_word": None} for k in beats]}


def test_merge():
    L, R = SECS[0], SECS[1]
    hi, lo = L["p1"], R["p0"]
    ans_l = {"segments": [_seg(hi - 30, hi + 20, beats=(hi - 25, hi + 10))],      # runs into the next section
             "aroll": [{"start_word": WORDS[hi - 60]["i"], "end_word": WORDS[hi + 5]["i"], "why": "w"}],
             "plates": [{"start_word": WORDS[2]["i"], "end_word": WORDS[20]["i"], "asset_ids": [], "technique_id": "TX07"}],
             "needs_primitive": []}
    ans_r = {"segments": [_seg(lo, lo + 30, beats=(lo + 5,))], "aroll": [], "plates": [], "needs_primitive": []}
    blank = [None] * NSEC
    m, notes = director.merge_sections(SECS, [ans_l, ans_r] + blank[2:], VIDEO)
    segs = m["segments"]
    check(len(segs) == 1 and segs[0]["start_word"] == WORDS[hi - 30]["i"] and segs[0]["end_word"] == WORDS[lo + 30]["i"],
          f"same app + session on both sides of the boundary → one screencast across it: {[(s['start_word'], s['end_word']) for s in segs]}")
    check([b["word_id"] for b in segs[0]["beats"]] == [WORDS[hi - 25]["i"], WORDS[lo + 5]["i"]],
          "a beat on the neighbour's words is the neighbour's (dropped from the left answer)")
    check(m["aroll"][0]["end_word"] == WORDS[hi]["i"] and len(m["plates"]) == 1 and not notes, "aroll clipped, plate kept")
    check(director.merge_sections(SECS, [ans_l, ans_r] + blank[2:], VIDEO)[0] == m, "the merge is deterministic")
    # the halves disagree (session) → split at the boundary
    ans_r2 = {**ans_r, "segments": [_seg(lo, lo + 30, beats=(lo + 5,), session="outside")]}
    segs = director.merge_sections(SECS, [ans_l, ans_r2] + blank[2:], VIDEO)[0]["segments"]
    check(len(segs) == 2 and segs[0]["end_word"] == WORDS[hi]["i"] and segs[1]["start_word"] == WORDS[lo]["i"],
          "a disagreeing pair is split exactly at the boundary")
    # the right half starts later → no join
    ans_r3 = {**ans_r, "segments": [_seg(lo + 3, lo + 30)]}
    segs = director.merge_sections(SECS, [ans_l, ans_r3] + blank[2:], VIDEO)[0]["segments"]
    check(len(segs) == 2, "a gap at the boundary is never bridged")
    bad = {**ans_r, "segments": [{**_seg(lo, lo + 3), "start_word": 10 ** 7}]}
    _, notes = director.merge_sections(SECS, [None, bad] + blank[2:], VIDEO)
    check(1 in notes and notes[1][0]["code"] == "schema", "a segment with unknown word ids is that section's error")


def _sec_n(body):
    t = body["messages"][0]["content"][1]["text"]
    return next(s_["n"] for s_ in SECS if f"YOUR SECTION: {s_['n']} of" in t)


def test_patch_reask(good):
    # break ONE section: an action no list holds on a beat inside section 3
    k3 = SECS[2]
    bad = copy.deepcopy(good)
    seg = next(s for s in bad["segments"] if s["beats"] and k3["p0"] <= POS[s["beats"][0]["word_id"]] <= k3["p1"]
               and s["session"] == "logged_in")
    seg["beats"][0]["action"] = "no_such_action"
    FAKE.bodies.clear()
    FAKE.fixed["plan"] = lambda body: good if len(body["messages"]) > 1 or _sec_n(body) != 3 else bad
    res = director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)")
    again = FAKE.bodies[NSEC:]
    check(len(again) == 1 and _sec_n(again[0]) == 3, f"only section 3 is re-asked: {[_sec_n(b) for b in again]}")
    txt = again[0]["messages"][2]["content"]
    check("no_such_action" in txt and "SECTION 3 of" in txt, "the re-ask carries section 3's error")
    check(len(again[0]["messages"]) == 3 and not res["held"] and res["calls"] == NSEC + 1, "patched → pass")
    check(res["attempts"][0]["sections"] == {3: res["attempts"][0]["sections"][3]}, f"errors grouped by section: {res['attempts'][0]['sections']}")


def test_truncated(good):
    sec2 = lambda body: _sec_n(body) == 2
    # 1) a reply cut at max_tokens is never parsed, even when its text happens to be valid JSON
    r = llm.Reply(text=json.dumps(good), stop_reason="max_tokens", usage={"output_tokens": 16000}, content=[], usd=0, seconds=0)
    try:
        director.parse_plan_reply(r)
        check(False, "a max_tokens reply must not parse")
    except ValueError as e:
        check("truncated" in str(e), "max_tokens → never a plan")
    FAKE.bodies.clear()
    FAKE.fixed["plan"] = good
    FAKE.stop = lambda body: ("max_tokens" if sec2(body) and body["output_config"]["effort"] == "high" else None)
    try:
        res = director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)")
    finally:
        FAKE.stop = None
    s2 = [b for b in FAKE.bodies if sec2(b)]
    check(len(s2) == 2 and s2[1]["output_config"]["effort"] == "medium"
          and "COMPACT ANSWER" in s2[1]["messages"][-1]["content"][-1]["text"],
          "a truncated section is retried once: medium effort + the compact instruction")
    check(not res["held"] and res["calls"] == NSEC + 1, f"the retry's answer is used: {res['calls']} calls")
    # 2) truncated, then invalid JSON → the section is FAILED (held for its words only), the rest of the plan stands
    FAKE.bodies.clear()
    FAKE.fixed["plan"] = lambda body: '{"segments": [{"start_word": 1 "end_word"' if sec2(body) else good
    FAKE.stop = lambda body: ("max_tokens" if sec2(body) and body["output_config"]["effort"] == "high" else None)
    try:
        res = director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)")
    finally:
        FAKE.stop = None
    st = {s_["n"]: s_ for s_ in res["sections"]}
    check(st[2]["status"] == "failed" and all(st[n]["status"] == "ok" for n in st if n != 2), "section 2 failed, the others ok")
    rows = [n for n in res["needs_primitive"] if n.get("code") == "section_failed"]
    check(res["held"] and len(rows) == 1 and "section 2" in rows[0]["why"], f"held for section 2: {rows}")
    check(all(director.locate(n, SECS, POS) != [1] for n in res["needs_primitive"] if n.get("code") != "section_failed"),
          "section 2's own coverage errors fold into its one row")
    check(not [b for b in FAKE.bodies if sec2(b) and len(b["messages"]) > 1], "a failed section is not re-asked")
    check(res["plan"]["segments"], "the other sections' plan stands")


def test_cache_reuse(good):
    path = TMP / "plan-sections.json"
    FAKE.bodies.clear()
    FAKE.fixed["plan"] = good
    director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)", cache=path)
    n1 = len(FAKE.bodies)
    res = director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)", cache=path)
    check(n1 == NSEC and len(FAKE.bodies) == n1 and not res["held"] and all(s_.get("cached") for s_ in res["sections"]),
          "a rerun reuses every section answer already paid for (no call)")
    doc = json.loads(path.read_text())
    doc["sections"][3]["status"] = "failed"
    path.write_text(json.dumps(doc))
    director.plan_and_check(VIDEO, SITES, FACTS, playbooks=PBS, rulebook="(digest)", cache=path)
    check(len(FAKE.bodies) == n1 + 1 and _sec_n(FAKE.bodies[-1]) == 4, "only the failed section is asked again")


def test_no_second_plan():
    """Pre-production failed before a plan: the job is held (plan_failed) — the graphics stage never plans again."""
    from aieditor import agentrec, longedit
    from aieditor import sites as sites_mod
    d = TMP / "job-noplan"
    (d / "profile" / "Default").mkdir(parents=True)
    v0 = {"title": "t", "duration": VIDEO["duration"], "words": WORDS}
    (d / "edl.json").write_text(json.dumps({"videos": [v0]}))
    (d / "request.json").write_text(json.dumps({"id": "x", "workflow": "creative", "format": "long"}))
    saved = (sites_mod.resolve, agentrec.scout_for, preprod._flow, director.plan)
    try:
        sites_mod.resolve = lambda d_, r_, v_, log=print: ([{"url": "https://chatgpt.com/", "note": ""}], 0.0)
        agentrec.scout_for = lambda url: {"slug": "chatgpt", "profile": str(d / "profile"), "logged_in_at": 1, "report": ""}

        def boom(*a, **k):
            raise json.JSONDecodeError("Expecting ',' delimiter", "{}", 1)
        preprod._flow = boom
        preprod.run(d, adapter=object(), log=lambda m: None)
        g = json.loads((d / "preprod" / "gate.json").read_text())
        check(g["flow"]["status"] == "failed" and [h["reason"] for h in g["held"]] == ["plan_failed"],
              f"pre-production without a plan → held plan_failed: {g.get('held')}")
        director.plan = lambda *a, **k: (_ for _ in ()).throw(AssertionError("a second plan call"))
        note, usd = longedit.plan_and_record(d, 1, v0, [{"url": "https://chatgpt.com/"}], False, 29.97,
                                             lambda m, f: None, lambda: False, lambda m: None)
    finally:
        sites_mod.resolve, agentrec.scout_for, preprod._flow, director.plan = saved
    check(usd == 0.0 and "held" in note and not (d / "edit-01" / "direct.json").exists(), f"no plan in graphics: {note}")
    check("plan_failed" in [r["reason"] for r in longedit.held_reasons(d)], "the graphics stage holds the job instead")
    src = (ROOT / "bin" / "aieditor-worker").read_text()
    check('"plan_failed"' in src, "the worker clears plan_failed when pre-production runs again")


def test_cost_estimate(good, rec):
    """Token sizes like the real 15-min job (test-chatgpt-images-2-5-full-e-10101225-6900: the whole prompt was
    42.8k input tokens = 1.98 chars a token; its whole plan answered 33.7k output tokens): the sectioned plan with a
    patch round over the sections that fail must land at about $2-3 (it cost $9.12 and was held)."""
    seen = set()
    per = lambda txt: int(len(txt) / 1.98)

    def usage(body):
        role = Fake.role(body)
        if role == "overlay":
            return {"input_tokens": per(json.dumps(body["messages"])), "output_tokens": 5000}
        m0 = body["messages"][0]["content"]
        shared = m0[0]["text"] + body["system"][0]["text"] + json.dumps(body["output_config"]["format"]["schema"])
        rest = per(m0[1]["text"]) + sum(per(json.dumps(m["content"])) for m in body["messages"][1:])
        u = {"input_tokens": rest, "output_tokens": 7500 if len(body["messages"]) == 1 else 6000}
        with LOCK:
            hit = shared in seen
            seen.add(shared)
        u["cache_read_input_tokens" if hit else "cache_creation_input_tokens"] = per(shared)
        return u
    FAKE.bodies.clear()
    FAKE.usage = usage
    FAKE.fixed["plan"] = lambda body: good if len(body["messages"]) > 1 else rec
    FAKE.queue("overlay", {"overlays": []})
    try:
        plan, raw, meta = director.plan(VIDEO, SITES, False, None, facts=FACTS, playbooks=PBS, rulebook=director.rulebook_digest())
    finally:
        FAKE.usage = None
    n_re = meta["calls"]["plan"] - NSEC
    print(f"  cost estimate (15-min narration, {NSEC} sections, {n_re} patch re-asks, real token sizes): "
          f"${meta['usd']:.2f} (plan ${sum(s_['usd'] for s_ in meta['sections']):.2f})")
    check(1.5 <= meta["usd"] <= 3.5, f"total plan spend ≈ $2-3: ${meta['usd']}")
    check(all(b["max_tokens"] <= 16000 for b in FAKE.bodies if Fake.role(b) == "plan"), "section ceilings 16k")


def main():
    good, _ = test_failed_plan()
    test_enum()
    test_structure(good)
    test_handoff(good)
    test_overlays()
    test_content_first()
    test_call_count(good)
    test_sectioning()
    test_merge()
    test_patch_reask(good)
    test_truncated(good)
    test_cache_reuse(good)
    test_no_second_plan()
    test_cost_estimate(good, recorded_answer())
    print(f"test_plan_call: {N} checks passed")


if __name__ == "__main__":
    main()
