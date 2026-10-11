"""The pre-production PRODUCER AGENT (aieditor/producer.py + genledger.py), offline: a fake app page (agent_rec.mjs
protocol), a fake clock, fake model calls — nothing is sent anywhere, no browser, no generation.

  (1) each failure class leads to a DIFFERENT route, chosen from the app's playbook (no app names in the agent):
      text_answer → image mode · wrong_mode → the images page · refusal → a rephrased visible-only prompt ·
      upload_missing → upload again (no generation spent on the broken try) · mismatch → the missing objects named ·
      still_generating → wait longer on the same chat (no new generation) · no_progress → diagnosed at 90 s, not 240
  (2) the model planner's route is used when valid (via "agent"); an invalid one falls back to the generic planner
  (3) learning: the route that worked is written into THIS video's playbook (recipes.produce_photo); the next asset
      tries it first; the shared skill playbook is never written
  (4) limits: a wall / limit message stops every generation (ledger block → QuotaWait); the daily cap (35 / 24 h per
      app, across jobs) → QuotaWait with the time it frees up; spacing >= 45 s across jobs; the 12-min time budget
  (5) plain-words event lines + the status line; cancel ends the loop

Run: python3 tests/test_producer.py
"""
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="producer-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
for k in ("AIEDITOR_API_LEDGER", "AIEDITOR_GEN_LEDGER", "AIEDITOR_GEN_PRIOR", "ANTHROPIC_API_KEY"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import os as _os, tempfile as _tf  # noqa: E401
_os.environ.setdefault("AIEDITOR_PROVEN_LIB", _tf.mkstemp(suffix="-proven.jsonl")[1])  # never the real recent-proofs ledger
from aieditor import genledger, onboard, preprod, producer, skill  # noqa: E402

N = 0
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
RESULT = '[data-testid="generated-image-preview"]'


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += max(0.0, float(s))


class World:
    """The app across sessions: chats this run made, generations sent, how the app answers."""

    def __init__(self, behave, clock):
        self.behave, self.clock = behave, clock
        self.chats, self.sends, self.k = {}, [], 0
        self.opened = []


class FakePage:
    def __init__(self, world, workdir):
        self.w = world
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.s = {}

    def _reset(self, url):
        self.s = {"url": url, "menu": False, "mode": False, "draft": "", "att": [], "chat": None}
        if "/images" in url:
            self.s["mode"] = True
        m = re.search(r"/c/([\w-]+)", url)
        if m:
            self.s["chat"] = m.group(1)

    def _chat(self):
        return self.w.chats.get(self.s.get("chat")) if self.s.get("chat") else None

    def send(self, m):
        c = m.get("cmd")
        if c == "open":
            self.w.opened.append(m["url"])
            self._reset(m["url"])
            return {"ok": True, "url": m["url"]}
        if c == "guard":
            return {"ok": True, "wall": None}
        if c == "act":
            a = m["action"]
            t, sel, tgt = a.get("type"), str(a.get("selector") or ""), str(a.get("target") or "")
            if t == "click" and ("Add files and more" in sel or tgt == "Add files and more"):
                self.s["menu"] = True
            elif t == "click" and tgt == "Create image":
                if not self.s["menu"]:
                    return {"ok": False, "error": "no element"}
                if self.w.behave.get("no_image_mode"):
                    return {"ok": False, "error": "no element 'Create image'"}
                self.s.update(mode=True, menu=False)
            elif t == "key" and a.get("key") == "Escape":
                self.s["menu"] = False
            elif t == "type":
                self.s["draft"] = a.get("text", "")
            elif t == "upload":
                if not self.w.behave.get("drop_uploads"):
                    self.s["att"] += list(a.get("files") or [])
                else:
                    self.w.behave["drop_uploads"] -= 1
            elif t == "click" and 'aria-label="Send"' in sel:
                if not self.s["draft"]:
                    return {"ok": False, "error": "no element"}
                self.w.k += 1
                cid = f"run-{self.w.k}"
                out = self.w.behave["answer"](self.s, self.s["draft"], len(self.w.sends))
                self.w.sends.append({"prompt": self.s["draft"], "mode": self.s["mode"], "att": list(self.s["att"]),
                                     "url": self.s["url"], "t": self.w.clock()})
                self.w.chats[cid] = {"prompt": self.s["draft"], "out": out, "polls": 0, "images": 0}
                self.s.update(chat=cid, url=f"https://chatgpt.com/c/{cid}", draft="", att=[])
            elif t == "click" and tgt == "Chat":
                pass
            return {"ok": True, "url": self.s["url"]}
        if c == "count":
            sel = m["selector"]
            ch = self._chat()
            if sel == RESULT:
                if ch:
                    ch["polls"] += 1
                    o = ch["out"]
                    if o["kind"] == "image" and ch["polls"] > o.get("after", 1):
                        ch["images"] = 1
                    return {"ok": True, "n": ch["images"]}
                return {"ok": True, "n": 0}
            n = {'[contenteditable="true"]': 1, 'button[aria-label="Send"]': int(bool(self.s["draft"])),
                 'button[aria-label="Show sidebar"]': 1, 'button[aria-label="Hide sidebar"]': 0}.get(sel)
            if n is None and sel.startswith('button[aria-label^="Remove "]'):
                n = len(self.s["att"])
            return {"ok": True, "n": int(n or 0)}
        if c == "text":
            ch = self._chat()
            lines = ["Ask anything"]
            if self.s.get("mode"):
                lines.append("Trending")
            if self.s.get("menu"):
                lines.append("Add photos & files")
            if ch:
                lines.append(ch["prompt"])
                o = ch["out"]
                if o["kind"] == "image" and not ch["images"]:
                    lines.append("Creating image 40%")
                elif o["kind"] == "slow":
                    lines.append(f"Creating image {min(99, ch['polls'])}%")
                elif o["kind"] in ("text", "refusal", "limit"):
                    lines.append(o["text"])
            return {"ok": True, "text": "\n".join(lines), "draft": self.s.get("draft", ""), "url": self.s["url"], "h1": []}
        if c == "observe":
            return {"ok": True, "lum": 20.0, "items": [{"ref": "r1", "tag": "button", "text": "Images", "box": [10, 10, 40, 20]}],
                    "shot": None, "url": self.s.get("url")}
        if c == "state":
            return {"ok": True, "account": "Jake Dawson"}
        if c == "find":
            return {"ok": True, "found": {t: [] for t in m.get("texts", [])}}
        if c == "grab":
            f = self.workdir / m["out"][3:]
            f.write_bytes(PNG)
            return {"ok": True, "file": m["out"], "via": "src"}
        return {"ok": True}

    def close(self):
        pass


def text_unless_mode(s, prompt, k):
    if s["mode"]:
        return {"kind": "image"}
    return {"kind": "text", "text": "Here is how to polish a product photo: use soft light, a clean background and a tripod."}


def make(name, behave, check_fn=None, llm=None, cancelled=None):
    out = TMP / name / "preprod"
    out.mkdir(parents=True, exist_ok=True)
    clk = Clock()
    world = World(behave, clk)
    pb = onboard.job_playbook(out, "chatgpt")
    logs, status = [], []
    n = {"k": 0}

    def factory():
        n["k"] += 1
        return FakePage(world, out / "w" / f"s{n['k']}")
    sp = preprod.Spacer(45, clock=clk, sleep=clk.sleep)
    ctx = onboard.Ctx(out, "chatgpt", "https://chatgpt.com/", pb, transport_factory=factory, llm_call=llm,
                      check=check_fn or (lambda a, f, objs: {"matches": True, "missing_objects": [], "usd": 0.01}),
                      spacer=sp, budget=onboard.Budget(9.5), log=logs.append, status=status.append, cancelled=cancelled)
    if llm is None:
        ctx.llm = None
    ctx.producer = producer.Producer(ctx, clock=clk, sleep=clk.sleep)
    return ctx, world, clk, logs, status


def fresh_ledger():
    p = genledger.path()
    if p.exists():
        p.unlink()


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


DESC = "the photo: It's a phone photo of a hot sauce bottle on my kitchen counter, uh, bad light, crumbs. I just drag it in"


# ─────────────────────────── (1) failure classes → different routes ───────────────────────────
def test_text_answer_then_learned():
    fresh_ledger()
    shared = sha(skill.playbook_path("chatgpt"))
    ctx, world, clk, logs, status = make("text", {"answer": text_unless_mode})
    # a stale learned recipe (a plain chat) — ChatGPT answers it in text, as in TEST v3
    ctx.pb["recipes"] = {"produce_photo": {"name": "plain chat", "start": "home", "steps": [
        {"action": "paste_prompt", "params": {"text": "{prompt}"}}, {"action": "send"}]}}
    ctx.producer = producer.Producer(ctx, clock=clk, sleep=clk.sleep)
    row = onboard.produce_asset(ctx, "phone_photo", DESC)
    check(row["status"] == "ready", f"made: {row.get('why')}")
    t = row["tries"]
    check(t[0]["class"] == "text_answer" and t[0]["route"] == "plain chat" and t[1]["ok"], f"text → next route: {t}")
    check(world.sends[0]["mode"] is False and world.sends[1]["mode"] is True, "the second try is in the image mode")
    check(not world.sends[0]["prompt"].count(" uh") and "drag" not in world.sends[0]["prompt"].lower(),
          f"never the raw narration: {world.sends[0]['prompt']}")
    check(any(re.search(r"phone_photo try 1: ChatGPT answered in text → switching to Create image mode", x) for x in logs),
          f"plain-words event line: {logs}")
    check(any(s.startswith("Making assets: 0/1 ready (phone_photo: try 2, Create image mode)") for s in status), f"status: {status}")
    used = world.clock() - 1_800_000_000.0
    check(used < 6 * 60, f"diagnosed quickly, not 240 s x 10 (took {used:.0f} s)")
    pb = json.loads((Path(ctx.out) / "playbook-chatgpt.json").read_text())
    rec = pb["recipes"]["produce_photo"]
    check(rec["name"] == "Create image mode" and rec["learned"]["after"] == ["text_answer"],
          f"the working route is learned into THIS video's playbook: {rec}")
    check(sha(skill.playbook_path("chatgpt")) == shared and "recipes" not in json.loads(skill.playbook_path("chatgpt").read_text()),
          "the shared playbook is never written")
    # the next asset of this job tries the learned recipe first — and needs one try
    n0 = len(world.sends)
    row2 = onboard.produce_asset(ctx, "desk_photo", "a phone photo of the bottle on a desk")
    check(row2["status"] == "ready" and row2["tries"][0]["via"] == "learned" and len(world.sends) == n0 + 1,
          f"learned recipe reused first: {row2['tries']}")
    gaps = [b["t"] - a["t"] for a, b in zip(world.sends, world.sends[1:])]
    check(all(g >= 45 - 1e-6 for g in gaps), f"generations >= 45 s apart: {gaps}")
    print(f"  text answer → {t[1]['route']} (learned), {len(world.sends)} generations, {used:.0f} s")


def test_wrong_mode_images_page():
    fresh_ledger()
    ctx, world, clk, logs, _ = make("mode", {"answer": text_unless_mode, "no_image_mode": True})
    row = onboard.produce_asset(ctx, "phone_photo", DESC)
    t = row["tries"]
    check(row["status"] == "ready" and t[0]["class"] == "wrong_mode" and not t[0]["generated"],
          f"the mode step did not land → no generation spent: {t}")
    check(t[1]["route"] == "Images page" and "/images" in world.sends[0]["url"], f"→ the app's images page: {t[1]}")
    check(len(world.sends) == 1, "one generation in all")


def test_refusal_rephrase():
    fresh_ledger()

    def picky(s, prompt, k):
        if re.search(r"celebrity|person", prompt, re.I):
            return {"kind": "refusal", "text": "I can't create images of real people like that."}
        return {"kind": "image"} if s["mode"] else {"kind": "text", "text": "x" * 80}
    ctx, world, clk, logs, _ = make("refuse", {"answer": picky})
    row = onboard.produce_asset(ctx, "fan_photo", "a celebrity person holding a hot sauce bottle in a kitchen")
    t = row["tries"]
    check(row["status"] == "ready" and t[0]["class"] == "refusal" and "rephrased" in t[1]["route"],
          f"refusal → rephrased visible-only prompt: {t}")
    check(not re.search(r"celebrity|person", world.sends[1]["prompt"], re.I), f"no people words: {world.sends[1]['prompt']}")


def test_upload_missing():
    fresh_ledger()
    ctx, world, clk, logs, _ = make("upload", {"answer": lambda s, p, k: {"kind": "image"}, "drop_uploads": 1})
    src = TMP / "in.png"
    src.write_bytes(PNG)
    ctx.asset_files["phone_photo"] = str(src)
    row = onboard.produce_asset(ctx, "colorized", "the colorized result of the photo", made_from=["phone_photo"],
                                prompt="Colorize this photo")
    t = row["tries"]
    check(row["status"] == "ready" and t[0]["class"] == "upload_missing" and not t[0]["generated"],
          f"the upload did not attach → caught before sending: {t}")
    check(len(world.sends) == 1 and world.sends[0]["att"], "the generation had the attachment")
    check("produce_edit" in json.loads((Path(ctx.out) / "playbook-chatgpt.json").read_text())["recipes"], "learned as produce_edit")


def test_mismatch_feeds_missing():
    fresh_ledger()
    n = {"k": 0}

    def vision(a, f, objs):
        n["k"] += 1
        return {"matches": n["k"] > 1, "missing_objects": [] if n["k"] > 1 else ["crumbs"], "usd": 0.01}
    ctx, world, clk, logs, _ = make("mismatch", {"answer": text_unless_mode}, check_fn=vision)
    row = onboard.produce_asset(ctx, "phone_photo", DESC)
    t = row["tries"]
    check(row["status"] == "ready" and t[0]["class"] == "mismatch" and "It must clearly show crumbs" in world.sends[1]["prompt"],
          f"the vision check's missing objects feed the next route: {world.sends[1]['prompt']}")
    check(any("(crumbs) → switching to" in x for x in logs), f"logged with the missing objects: {logs[-2:]}")
    check(len(row["checks"]) == 2, "every image is vision-checked")


def test_still_generating_waits():
    fresh_ledger()
    ctx, world, clk, logs, _ = make("slow", {"answer": lambda s, p, k: {"kind": "image", "after": 30}})
    ctx.producer.max_wait = 60
    row = onboard.produce_asset(ctx, "phone_photo", DESC)
    t = row["tries"]
    check(row["status"] == "ready" and t[0]["class"] == "still_generating" and "waiting longer" in t[1]["route"],
          f"still generating → wait on the same chat: {t}")
    check(len(world.sends) == 1 and len(genledger.used("chatgpt", clk())) == 1, "no second generation for a slow one")
    check(world.opened[-1].endswith("/c/run-1"), "reopened only the chat this run made")


def test_fail_fast():
    fresh_ledger()
    ctx, world, clk, logs, _ = make("silent", {"answer": lambda s, p, k: {"kind": "nothing"}})
    ctx.producer.max_tries = 1
    t0 = clk()
    row = onboard.produce_asset(ctx, "phone_photo", DESC)
    took = clk() - t0
    check(row["status"] == "needs_asset" and row["tries"][0]["class"] == "no_progress" and 90 <= took < 120,
          f"no image + no progress → diagnosed at 90 s, not 240 ({took:.0f} s): {row['tries']}")


# ─────────────────────────── (2) the model's own route ───────────────────────────
class Reply(dict):
    @property
    def text(self):
        return self["text"]


def test_agent_route():
    fresh_ledger()
    calls = []

    def fake_llm(model, system, content, max_tokens, **kw):
        calls.append(kw)
        if "image prompt" in str(kw.get("purpose")):
            return Reply(text=json.dumps({"prompt": "a hot sauce bottle on a kitchen counter, bad light, crumbs"}), usd=0.001)
        return Reply(text=json.dumps({"failure": "text_answer", "diagnosis": "it answered in words; the images page makes pictures",
                                      "give_up": False, "route": {
                                          "name": "agent: images page", "start": "open_images_page", "prompt": "",
                                          "use_result": False, "learn_as": "produce_photo", "steps": [
                                              {"action": "paste_prompt", "params": {"text": "{prompt}"}, "act": {}},
                                              {"action": "send", "params": {}, "act": {}}]}}), usd=0.05)
    ctx, world, clk, logs, _ = make("agent", {"answer": text_unless_mode}, llm=fake_llm)
    ctx.pb["recipes"] = {"produce_photo": {"name": "plain chat", "start": "home", "steps": [
        {"action": "paste_prompt", "params": {"text": "{prompt}"}}, {"action": "send"}]}}
    ctx.producer = producer.Producer(ctx, clock=clk, sleep=clk.sleep)
    row = onboard.produce_asset(ctx, "phone_photo", DESC)
    t = row["tries"]
    check(row["status"] == "ready" and t[1]["route"] == "agent: images page" and t[1]["via"] == "agent",
          f"the agent's own route: {t}")
    check(any("diagnose" in str(c.get("purpose")) for c in calls) and world.sends[0]["prompt"].endswith("crumbs"),
          "one planning call + the clean prompt")
    # an invalid plan (two generating steps / an unknown action) → the generic fallback
    bad = producer.Producer(ctx, clock=clk, sleep=clk.sleep)
    check(bad.validate({"start": "home", "steps": [{"action": "send"}, {"action": "send"}]}) is not None, "two sends refused")
    check(bad.validate({"start": "home", "steps": [{"act": {"type": "click", "target": "Delete chat"}}, {"action": "send"}]})
          is not None, "a forbidden word refused")
    check(bad.validate({"start": "https://evil", "steps": [{"action": "send"}]}) is not None, "start must be home/result/goto")


# ─────────────────────────── (4) limits ───────────────────────────
def test_wall_stops_everything():
    fresh_ledger()
    ctx, world, clk, logs, _ = make("wall", {"answer": lambda s, p, k: {"kind": "limit", "text":
                                    "You've hit the image generation limit. Try again in 3 hours."}})
    try:
        onboard.produce_asset(ctx, "phone_photo", DESC)
        check(False, "a limit message must stop")
    except genledger.QuotaWait as e:
        check(e.resume_at > clk() and "limit" in e.why, f"QuotaWait: {e.why}")
    check(len(world.sends) == 1, "no further generation after the limit message")
    ok, why = genledger.ok_to_start("chatgpt", clk())
    check(not ok and why.resume_at > clk(), "every job's generations stop (a ledger block)")
    check(any("every generation stops now" in x for x in logs), "logged in plain words")


def test_daily_cap():
    """A configured cap still stops (the default is none — Jake: the app's limit message is the cap)."""
    fresh_ledger()
    clk = Clock()
    _cap = genledger.cap
    genledger.cap = lambda app: 35
    for i in range(35):
        genledger.record("chatgpt", "another-job", f"a{i}", 1, "x", now=clk() - 3600 * 20 + i * 60)
    ctx, world, c2, logs, _ = make("cap", {"answer": lambda s, p, k: {"kind": "image"}})
    try:
        onboard.produce_asset(ctx, "phone_photo", DESC)
        check(False, "the cap must stop")
    except genledger.QuotaWait as e:
        check("35/35" in e.why and abs(e.resume_at - (clk() - 3600 * 20 + 86400 + 60)) < 1, f"waits until the window frees: {e.why}")
        check("Waiting:" in e.status() and "Bangkok" in e.status(), f"a clear status: {e.status()}")
    check(len(world.sends) == 0, "no generation at the cap")
    check(genledger.remaining("claude", clk()) == 35, "per app")
    genledger.cap = _cap
    check(genledger.cap("chatgpt") >= 100000, "no own cap by default — the app's limit message is the cap (Jake)")
    # other jobs' generations count; the spacing holds across jobs
    fresh_ledger()
    genledger.record("chatgpt", "another-job", "z", 1, "x", now=clk() - 10)
    check(abs(genledger.gate("chatgpt", clk()) - 35) < 1e-6, "a generation 10 s ago → wait 35 s")
    # a factory server: the main box's lines ride along in AIEDITOR_GEN_PRIOR; merge is idempotent
    prior = genledger.prior_env(clk())
    os.environ["AIEDITOR_GEN_PRIOR"] = prior
    os.environ["AIEDITOR_GEN_LEDGER"] = str(TMP / "droplet-gen.jsonl")
    try:
        check(len(genledger.used("chatgpt", clk())) == 1, "the droplet sees the main box's generations")
        genledger.record("chatgpt", "job-d", "y", 1, "x", now=clk())
    finally:
        os.environ.pop("AIEDITOR_GEN_PRIOR")
        os.environ.pop("AIEDITOR_GEN_LEDGER")
    check(genledger.merge(TMP / "droplet-gen.jsonl") == 1 and genledger.merge(TMP / "droplet-gen.jsonl") == 0, "merged once")


def test_time_budget():
    fresh_ledger()
    ctx, world, clk, logs, _ = make("budget", {"answer": lambda s, p, k: {"kind": "slow"}})
    t0 = clk()
    row = onboard.produce_asset(ctx, "phone_photo", DESC)
    took = clk() - t0
    check(row["status"] == "needs_asset" and took <= 12 * 60 + 60 and any("time budget" in a for a in row["attempts"]),
          f"the 12-min budget stops it ({took:.0f} s): {row['attempts'][-2:]}")


def test_cancel():
    fresh_ledger()
    flag = {"n": 0}

    def cancelled():
        flag["n"] += 1
        return flag["n"] > 3
    ctx, world, clk, logs, _ = make("cancel", {"answer": lambda s, p, k: {"kind": "slow"}}, cancelled=cancelled)
    try:
        onboard.produce_asset(ctx, "phone_photo", DESC)
        check(False, "cancel must end it")
    except InterruptedError:
        check(True, "cancelled")


def test_no_app_names():
    src = (ROOT / "aieditor" / "producer.py").read_text()
    code = re.sub(r'"""[\s\S]*?"""', "", src)
    code = "\n".join(ln.split("#")[0] for ln in code.splitlines())
    check(not re.search(r"chatgpt|openai|gemini|canva|Create image|data-testid", code, re.I),
          "nothing app-specific in the agent loop (only in the playbook)")


def main():
    test_text_answer_then_learned()
    test_wrong_mode_images_page()
    test_refusal_rephrase()
    test_upload_missing()
    test_mismatch_feeds_missing()
    test_still_generating_waits()
    test_fail_fast()
    test_agent_route()
    test_wall_stops_everything()
    test_daily_cap()
    test_time_budget()
    test_cancel()
    test_no_app_names()
    print(f"test_producer: {N} checks passed")


if __name__ == "__main__":
    main()
