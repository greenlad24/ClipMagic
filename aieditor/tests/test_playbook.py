"""App playbooks (aieditor/playbook.py + skill playbooks/chatgpt.json, recommendation §3.1 / step 4).

  · chatgpt.json validates; every action is proven:false with a source → actions(proven_only) is empty
  · the replay harness: a fake session ok 3/3 proves an action and records 3 replays; 2/3 leaves it unproven
  · load rejects an action labelled 'Log out' / 'Upgrade' (click guard) — 'Remove BG' is fine
  · outside_only: chatgpt.com/#pricing and /pricing only from the never-logged-in US Chrome (L4)
  · the failed end-to-end job's beats (SCRATCH copy of its direct.json): '@Sketch picked', '/background',
    '/new BG', 'Updated', the logged-in Free card and the invented 'Bakery Image Prompt' chat map to NO action
    (needs_primitive candidates); '+ -> Sketch' maps to an action
  · the plan schema's beat fields are a superset of the G2 beat ledger
  · AIEDITOR_DOCKER_TESTS=1: the harness replays paste / click / key 3/3 on a local static fixture page in a
    short-lived run of the screencast image (network none: no live site is ever opened)

Run: python3 tests/test_playbook.py            (AIEDITOR_DOCKER_TESTS=1 for the docker part, ~5 min)
"""
import copy
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import config, planfit, playbook, skill  # noqa: E402

N = 0
JOB = Path("/opt/aieditor-work/jobs/factory-end-to-end-test-mac-rec-10082332-63de")   # the failed run — READ ONLY
FIXTURE = ROOT / "tests" / "fixtures" / "playbook" / "fixture_page.html"


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


class FakeDom:
    """A tiny model of the fixture page: composer draft, '+' menu, Sketch canvas. Speaks the
    RecorderSession surface (open / act / check / close)."""

    def __init__(self, broken=False):
        self.broken = broken          # a session where the '+' button does nothing (an app change, a wall…)
        self.closed = False

    def open(self, url):
        self.menu, self.draft, self.canvas = False, "", False
        return True, None

    def act(self, s):
        tgt = s.get("selector") or s.get("target") or ""
        if s["type"] == "type":
            self.draft = s["text"]
        elif s["type"] == "click" and "Add files and more" in tgt:
            self.menu = self.menu if self.broken else not self.menu
        elif s["type"] == "click" and tgt == "Sketch":
            if not self.menu:
                return False, "no element Sketch"
            self.menu, self.canvas = False, True
        elif s["type"] == "key":
            if s["key"] == "Escape":
                self.menu = False
        else:
            return False, f"fake: {s}"
        return True, None

    def text(self):
        return "What's on your mind today?\n+\n" + ("Add photos & files\nCreate image\nSketch\n" if self.menu else "") + self.draft

    def check(self, a):
        k = a["kind"]
        if k == "selector":
            ok = a["selector"] in ('[contenteditable="true"]',) or (a["selector"] == "canvas" and self.canvas)
        elif k == "text" and a.get("selector"):
            ok = self.draft == a["value"]
        elif k == "text":
            ok = a["value"] in self.text()
        elif k == "absent":
            ok = a.get("value", "\0") not in self.text()
        else:
            ok = False
        return ok, None if ok else f"fake check failed: {a}"

    def close(self):
        self.closed = True


def fixture_playbook(url):
    """The real chatgpt playbook, re-pointed at a fixture page (start state = the composer is there)."""
    pb = playbook.playbook_copy("chatgpt")
    pb["start_state"] = {"url": url, "asserts": [{"kind": "selector", "selector": '[contenteditable="true"]'}]}
    pb["actions"]["close_menus"]["requires"] = ["open_plus_menu"]      # Escape must close an OPEN menu
    return pb


def test_load_and_proven():
    pb = playbook.load("chatgpt")
    check(pb["app"] == "chatgpt" and pb["hosts"] == ["chatgpt.com"], "chatgpt playbook loads")
    check(playbook.validate({k: v for k, v in pb.items() if not k.startswith("_")}) == [], "validates")
    check(all(a["proven"] is False and a["source"].strip() for a in pb["actions"].values()), "every action unproven + source")
    check(playbook.actions("chatgpt", proven_only=True) == {}, "nothing proven yet → empty closed list")
    check(len(playbook.actions("chatgpt", proven_only=False)) == len(pb["actions"]) >= 20, "all actions without the filter")
    f = pb["features"]
    check(f["at_sketch"]["exists"] is False and f["at_sketch"]["honest_route"] == "plus_sketch", "@Sketch: no picker, '+ -> Sketch'")
    check(all(x in f["slash_background"]["fact"] for x in ("Add custom GPT", "Dictate", "Feedback", "Model", "Work in a project")),
          "'/' menu items")
    check(f["tb_sketch"]["exists"] is False and f["tb_templates"]["exists"] is False, "Sketch/Templates not on the toolbar")
    check(f["updated_label"]["exists"] is False, "no 'Updated' badge")
    check(f["pricing_in_app"]["honest_route"].startswith("outside:"), "pricing only from outside")
    check(pb["private_selectors"] and pb["walls"], "private selectors + walls")
    # resolve
    st = playbook.resolve(pb, "paste_prompt", {"text": "a cup of coffee"})
    check(st[0]["type"] == "type" and st[0]["paste"] is True and st[0]["text"] == "a cup of coffee"
          and st[0]["selector"] == '[contenteditable="true"]' and st[0]["alt"] == [{"selector": "#prompt-textarea"}], f"paste {st}")
    check(playbook.resolve(pb, "send")[0] == {"type": "click", "selector": 'button[data-testid="send-button"]',
                                              "playbook": "chatgpt:send"}, "send selector from G3 CHATGPT_SEND")
    check(playbook.resolve(pb, "plus_sketch")[0]["target"] == "Sketch", "text= selector → target label")
    check([s["key"] for s in playbook.resolve(pb, "clear_composer")] == ["Meta+a", "Backspace"], "key defaults")
    check(playbook.resolve(pb, "slash_menu")[1] == {"type": "key", "key": "/", "playbook": "chatgpt:slash_menu"}, "slash key")
    check(playbook.resolve(pb, "resize_option", {"shape": "Story 9:16"})[0]["target"] == "Story 9:16", "param fill")
    for bad, args in (("paste_prompt", {}), ("resize_option", {"shape": "Circle"}), ("at_sketch", {})):
        try:
            playbook.resolve(pb, bad, args)
            check(False, f"resolve {bad} {args} must fail")
        except playbook.PlaybookError:
            check(True, "")


def test_replay_fake():
    tmp = Path(tempfile.mkdtemp(prefix="pb-"))
    try:
        pb = fixture_playbook("file:///fixture")
        path = tmp / "chatgpt.json"
        playbook.save(pb, path)
        made = []

        def ok_factory():
            made.append(FakeDom())
            return made[-1]
        r = playbook.replay(ok_factory, playbook.load(path), "paste_prompt", params={"text": "Hello"}, save_to=path)
        check(r["ok"] == 3 and r["n"] == 3 and r["proven"] is True, f"3/3 proves: {r}")
        check(len(made) == 3 and all(s.closed for s in made), "three FRESH sessions, each closed")
        stored = json.loads(path.read_text())["actions"]["paste_prompt"]
        check(stored["proven"] is True and len(stored["replays"]) == 3 and all(x["ok"] for x in stored["replays"]),
              "proven + 3 replays written back")
        check(list(playbook.actions(playbook.load(path), proven_only=True)) == ["paste_prompt"], "now on the closed list")
        # 2/3: the second session's '+' does nothing
        k = iter([False, True, False])
        r = playbook.replay(lambda: FakeDom(broken=next(k)), playbook.load(path), "open_plus_menu", save_to=path)
        stored = json.loads(path.read_text())["actions"]["open_plus_menu"]
        check(r["ok"] == 2 and r["proven"] is False and stored["proven"] is False and len(stored["replays"]) == 3,
              f"2/3 stays unproven: {r}")
        check(stored["replays"][1]["ok"] is False and "post" in stored["replays"][1]["why"], "the failed replay says why")
        # a proven action that later fails a replay round loses 'proven'
        r = playbook.replay(lambda: FakeDom(broken=True), playbook.load(path), "plus_sketch", save_to=path)
        check(r["proven"] is False and "requires open_plus_menu" not in (r["replays"][0]["why"] or "x"), f"{r}")
        r2 = playbook.replay(lambda: FakeDom(), playbook.load(path), "plus_sketch", save_to=path)
        check(r2["proven"] is True, "requires → pre → action → post (canvas)")
        r3 = playbook.replay(lambda: FakeDom(), playbook.load(path), "close_menus", save_to=path)
        check(r3["proven"] is True, "key Escape closes the menu 3/3")
        # a crashing session is a failed replay, not a crashed harness
        r = playbook.replay(lambda: (_ for _ in ()).throw(RuntimeError("boom")), playbook.load(path), "close_menus")
        check(r["ok"] == 0 and not r["proven"], "session error = failed replay")
        # generating actions are not replayed blindly
        try:
            playbook.replay(ok_factory, playbook.load(path), "send")
            check(False, "send must need allow_generate")
        except playbook.PlaybookError:
            check(True, "")
        # the skill's own playbook file was not touched
        check(all(a["proven"] is False for a in skill.playbook("chatgpt")["actions"].values()), "chatgpt.json untouched")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_guard_and_outside():
    tmp = Path(tempfile.mkdtemp(prefix="pb-"))
    try:
        base = playbook.playbook_copy("chatgpt")
        base.pop("_path", None)
        for label, url in (("Log out", None), ("Upgrade", None), ("Upgrade to Plus", None), ("Delete chat", None),
                           ("Open settings", "https://chatgpt.com/logout"), ("Manage", "https://x.com/billing")):
            pb = copy.deepcopy(base)
            a = {"kind": "goto" if url else "click", "label": label, "proven": False, "source": "test"}
            a.update({"url": url} if url else {"selectors": [f"text={label}"]})
            pb["actions"]["bad"] = a
            p = tmp / "bad.json"
            p.write_text(json.dumps(pb))
            try:
                playbook.load(p)
                check(False, f"{label} / {url} must be rejected")
            except playbook.PlaybookError as e:
                check("actions.bad" in str(e), f"rejected with the action named: {e}")
        # a hidden label behind a text= selector is caught too
        pb = copy.deepcopy(base)
        pb["actions"]["sneaky"] = {"kind": "click", "label": "Menu item", "selectors": ["text=Log out"], "proven": False, "source": "t"}
        (tmp / "s.json").write_text(json.dumps(pb))
        try:
            playbook.load(tmp / "s.json")
            check(False, "text=Log out must be rejected")
        except playbook.PlaybookError:
            check(True, "")
        # the shared p1 rules file adds words; no false positive on real ChatGPT labels
        shared = tmp / "clickguard.rules.json"
        shared.write_text(json.dumps({"deny": {"labels": ["Archive"], "urls": [r"/archive\b"]}}))
        pb = copy.deepcopy(base)
        pb["actions"]["arch"] = {"kind": "click", "label": "Archive", "selectors": ["text=Archive"], "proven": False, "source": "t"}
        (tmp / "a.json").write_text(json.dumps(pb))
        try:
            playbook.load(tmp / "a.json", guard_path=shared)
            check(False, "shared rule must apply")
        except playbook.PlaybookError:
            check(True, "")
        check(playbook.load("chatgpt", guard_path=shared)["app"] == "chatgpt", "Remove BG / Send / Sketch pass the guard")
        # validation errors
        pb = copy.deepcopy(base)
        pb["actions"]["x"] = {"kind": "teleport", "label": "x", "proven": "yes"}
        pb["features"]["y"] = {"exists": False, "honest_route": "nope"}
        errs = playbook.validate(pb)
        check(any("kind" in e for e in errs) and any("proven" in e for e in errs) and any("source" in e for e in errs)
              and any("honest_route" in e for e in errs), f"validator errors: {errs}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    for url in ("chatgpt.com/#pricing", "https://chatgpt.com/#pricing", "https://chatgpt.com/pricing", "https://chatgpt.com/?x=1#pricing"):
        check(playbook.outside_only("chatgpt", url), f"outside_only {url}")
    for url in ("https://chatgpt.com/", "https://chatgpt.com/images", "https://chatgpt.com/library?tab=images"):
        check(not playbook.outside_only("chatgpt", url), f"inside ok {url}")


def test_failed_job_beats():
    src = JOB / "edit-01" / "direct.json"
    if not src.exists():
        print("test_playbook: failed-job fixture missing — beat mapping skipped")
        return
    tmp = Path(tempfile.mkdtemp(prefix="pb-direct-"))
    try:
        scratch = tmp / "direct.json"
        shutil.copyfile(src, scratch)                          # never read the job in place
        d = json.loads(scratch.read_text())
        beats = []
        for s in d["plan"]["segments"]:
            _, bs = planfit.parse_intent(s["intent"])
            beats += [f"{b['cue']} :: {b['body']}" for b in bs]
        check(len(beats) > 100, f"beats parsed: {len(beats)}")

        def beat(cue):
            hits = [b for b in beats if b.lower().startswith(cue.lower() + " ::")]
            check(hits, f"beat '{cue}' in direct.json")
            return hits[0]
        invented = {
            "@Sketch picked": (beat("at Sketch"), "at_sketch"),
            "/background": (beat("background skill"), "slash_background"),
            "Updated": (beat("updated"), "updated_label"),
            "logged-in Free card": (beat("daily cap for free users"), "pricing_in_app"),
            "logged-in Free card (2)": (beat("free plan"), "pricing_in_app"),
            "Bakery Image Prompt chat": (beat("What if I told you"), "named_old_chat"),
            # the narration of gap item 19 (the plan never wrote it as a beat — it was dropped)
            "/new BG": ("You could just type forward slash new BG and then type just the detail.", "slash_background"),
        }
        for name, (text, feat) in invented.items():
            m = playbook.match_beat("chatgpt", text, "logged_in")
            check(m["action"] is None and m["status"] == "missing" and m["feature"] == feat, f"{name} → no action: {m}")
        check("Bakery Image Prompt" in invented["Bakery Image Prompt chat"][0] and "@Sketch" in invented["@Sketch picked"][0], "")
        cands = playbook.unknown([t for t, _ in invented.values()], "chatgpt", "logged_in")
        check(len(cands) == len(invented) and all(c["sentence"] and c["why"] for c in cands), "all are needs_primitive candidates")
        check(cands[0]["proposed"] == {"action": "plus_sketch"}, f"@Sketch's honest route: {cands[0]}")
        check(cands[3]["proposed"] == {"session": "outside", "url": "https://chatgpt.com/pricing"}, f"pricing route: {cands[3]}")
        out = playbook.match_beat("chatgpt", beat("free on every plan"), "logged_in")
        check(out["status"] == "outside" and out["proposed"]["session"] == "outside", f"/pricing logged in → outside: {out}")
        # the honest routes map to actions
        for text, aid in (("+ -> Sketch", "plus_sketch"), ("click '+' then 'Sketch'", "plus_sketch"),
                          (beat("hit send"), "send"), (beat("type the prompt"), "paste_prompt"),
                          (beat("typing a forward slash"), "slash_menu"), (beat("click on templates"), "open_images_page")):
            m = playbook.match_beat("chatgpt", text)
            check(m["status"] == "action" and m["action"] == aid, f"{text[:50]} → {aid}: {m}")
        check(playbook.unknown(["+ -> Sketch", beat("the glass")]) == [], "actions and camera beats are not candidates")
        check(src.stat().st_mtime == src.stat().st_mtime and json.loads(src.read_text()) == d, "job artifact unchanged")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_plan_schema():
    sch = skill.schema("plan")
    beat = set(sch["$defs"]["beat"]["properties"])
    g2 = {"seg", "cue", "body", "action", "technique_id", "typed_text", "must_text", "route", "why", "cue_score",
          "word_id", "t_word", "clause_start", "clause_word_id", "subject", "result_assertion"}
    check(g2 <= beat, f"beat ⊇ G2 ledger: missing {g2 - beat}")
    spec = {"id", "word_id", "t_word", "clause_start", "action", "params", "subject", "technique_id", "must_text",
            "typed_text", "result_assertion", "asset_id", "live", "wait_talk"}
    check(spec <= beat, f"spec beat fields: missing {spec - beat}")
    seg = sch["properties"]["segments"]["items"]
    check(set(seg["properties"]) >= {"t0", "t1", "app", "session", "start_state", "beats"}
          and seg["properties"]["session"]["enum"] == ["logged_in", "outside"], "segment fields")
    check(set(sch["properties"]) >= {"segments", "aroll", "plates", "overlays", "needs_primitive"}, "plan parts")
    np_ = set(sch["properties"]["needs_primitive"]["items"]["properties"])
    check(np_ >= {"sentence", "word_ids", "why", "proposed"}, "needs_primitive fields")
    ps = skill.schema("playbook")
    check(set(ps["$defs"]["action"]["properties"]["kind"]["enum"]) == playbook.KINDS, "playbook kinds == validator kinds")
    check(set(ps["$defs"]["assert"]["properties"]["kind"]["enum"]) == playbook.ASSERT_KINDS, "assert kinds")
    check({"private_selectors", "outside_only", "walls", "set_dressing", "features"} <= set(ps["properties"]), "playbook parts")


class DockerRec:
    """agent_rec.mjs in a short-lived run of the screencast image: network none, the fixture page
    mounted read-only, no profile (no account, no cookies)."""

    def __init__(self, work):
        self.name = f"aieditor-pbtest-{os.getpid()}-{len(os.listdir(work))}"
        w = Path(tempfile.mkdtemp(dir=work))
        self.p = subprocess.Popen(
            ["docker", "run", "-i", "--rm", "--name", self.name, "--network", "none", "--shm-size", "1g",
             "-v", f"{ROOT / 'screencast'}:/app/screencast:ro", "-v", f"{ROOT / 'motion'}:/app/motion:ro",
             "-v", f"{FIXTURE.parent}:/f:ro", "-v", f"{w}:/w", config.SC_IMAGE, "node", "/app/screencast/agent_rec.mjs", "/w"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        r, _, _ = select.select([self.p.stdout], [], [], 180)
        line = self.p.stdout.readline() if r else ""
        if not line:
            raise RuntimeError("recorder did not answer")
        return json.loads(line)

    def close(self):
        try:
            self.p.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
            self.p.stdin.flush()
            self.p.wait(timeout=60)
        except Exception:  # noqa: BLE001
            subprocess.run(["docker", "kill", self.name], capture_output=True)


def test_docker_fixture():
    if os.environ.get("AIEDITOR_DOCKER_TESTS") != "1":
        print("test_playbook: docker fixture replay skipped (AIEDITOR_DOCKER_TESTS=1 runs it)")
        return
    work = Path(tempfile.mkdtemp(prefix="pb-docker-"))
    try:
        pb = fixture_playbook("file:///f/fixture_page.html")
        for aid, params, kind in (("paste_prompt", {"text": "Turn this rough sketch into a realistic photo"}, "paste"),
                                  ("open_plus_menu", None, "click"), ("close_menus", None, "key")):
            check(pb["actions"][aid]["kind"] == kind, f"{aid} is a {kind}")
            r = playbook.replay(lambda: playbook.RecorderSession(DockerRec(work)), pb, aid, params=params)
            print(f"  docker replay {aid}: {r['ok']}/{r['n']} {[x['why'] for x in r['replays'] if not x['ok']]}")
            check(r["ok"] == 3 and r["proven"], f"{aid} 3/3 on the fixture page: {r}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    test_load_and_proven()
    test_replay_fake()
    test_guard_and_outside()
    test_failed_job_beats()
    test_plan_schema()
    test_docker_fixture()
    print(f"test_playbook: {N} checks passed")


if __name__ == "__main__":
    main()
