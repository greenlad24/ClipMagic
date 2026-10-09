"""The outside view + per-job US route (usroute.py) and the recorder gate in longedit.plan_and_record:
fake DigitalOcean client, fake plan, no docker, no browser, no Claude call. WORK is a scratch folder."""
import json
import os
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="p1-usroute-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
for k in ("AIEDITOR_US_PROXY", "AIEDITOR_ON_CAMERA_AGENT", "AIEDITOR_FACTORY_SERVER"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import agentrec, cloud, config, director, graphics_long, longedit, usroute  # noqa: E402

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


# ── a fake DigitalOcean client ──
class FakeDO:
    TAG_US = cloud.TAG_US
    HISTORY = TMP / "history.jsonl"

    def __init__(self, fail_active=False):
        self.created, self.destroyed, self.fail_active = [], [], fail_active

    def create(self, name, size, image, tag, user_data=None, region=None, vpc=True, ssh_keys=True):
        self.created.append({"name": name, "size": size, "tag": tag, "region": region, "vpc": vpc,
                             "ssh_keys": ssh_keys, "user_data": user_data})
        return 900 + len(self.created)

    def wait_active(self, did):
        if self.fail_active:
            raise cloud.DOError("never active")
        return "10.0.0.9", "203.0.113.50"

    def destroy(self, did):
        self.destroyed.append(did)
        return True

    def _price(self, size):
        return cloud._price(size)

    class Heartbeat:
        def __init__(self, did, **kw):
            self.did = did

        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass


do = FakeDO()
try:
    with usroute.us_proxy("job-1", "198.51.100.7", client=do, log=lambda m: None) as px:
        check(px["url"] == "http://203.0.113.50:8899" and px["region"] == "nyc3", f"proxy: {px}")
        raise RuntimeError("the job failed")
except RuntimeError:
    pass
check(len(do.created) == 1 and do.destroyed == [901], "create/destroy paired even when the job raises")
c = do.created[0]
check(c["tag"] == cloud.TAG_US and c["region"] == "nyc3" and c["vpc"] is False and c["ssh_keys"] is False, f"US droplet: {c}")
check(c["size"] == "s-1vcpu-512mb-10gb" and cloud._price(c["size"]) < 0.01, "the smallest size, priced for the cap")
ud = c["user_data"]
check("ufw allow from 198.51.100.7 to any port 8899" in ud and "ufw default deny incoming" in ud,
      "the proxy is reachable from the job server only")
import base64  # noqa: E402
blob = base64.b64decode(ud.split("content: ")[1].split("\n")[0]).decode()
check('ALLOW_CLIENTS = [ipaddress.ip_network("198.51.100.7/32")]' in blob and "PORTS = {80, 443}" in blob,
      "the proxy's own allow-list is the job server")
hist = [json.loads(x) for x in FakeDO.HISTORY.read_text().splitlines()]
check(hist and hist[-1]["action"] == "us-proxy" and hist[-1]["droplet"] == 901, "its minutes go into the server spend history")
bad = FakeDO(fail_active=True)
try:
    usroute.create_us_proxy("job-2", "198.51.100.7", client=bad, log=lambda m: None)
    check(False, "a proxy that never comes up raises")
except cloud.DOError:
    pass
check(bad.destroyed == [901], "…and is destroyed before the error leaves (no orphan)")
try:
    usroute.create_us_proxy("job-3", None, client=FakeDO(), log=lambda m: None)
    check(False, "no job IP → refused")
except RuntimeError:
    pass
check("tagged(TAG_US)" in (ROOT / "aieditor" / "cloud.py").read_text().split("def watchdog")[1][:900],
      "the watchdog also sweeps US proxies")

# the outside-view Chrome
env = usroute.outside_chrome_env({"url": "http://203.0.113.50:8899"})
prof = Path(env["AGENT_PROFILE_DIR"])
check(prof.is_dir() and not any(prof.iterdir()), "a fresh, EMPTY profile")
check(env["TZ"] == env["AGENT_TZ"] == "America/New_York", "New York time")
check(env["AGENT_LANG"] == "en-US" and env["LANG"].startswith("en_US"), "US English")
check(env["AGENT_PROXY"] == "http://203.0.113.50:8899" and env["AGENT_SESSION"] == "outside", "through the US proxy")
used = TMP / "used-profile"
(used / "Default").mkdir(parents=True)
for p in (used, usroute.SCOUT_PROFILES / "chatgpt"):
    try:
        usroute.outside_chrome_env("http://x:1", p)
        check(False, f"refused {p}")
    except RuntimeError:
        pass
try:
    usroute.outside_chrome_env(None)
    check(False, "no route → no outside env")
except RuntimeError as e:
    check(str(e) == usroute.NO_ROUTE, "no US route")
check(usroute.settings()["enabled"] is False, "us_route is off by default this round")

# ── longedit.plan_and_record on a fake plan: one logged-in segment + one outside (pricing) segment ──
d = TMP / "job"
d.mkdir()
(d / "edl.json").write_text("{}")
ws = [{"i": i, "word": f"w{i}", "start": i * 0.5, "end": i * 0.5 + 0.4} for i in range(60)]
v = {"title": "t", "duration": 30.0, "words": ws}
seg_in = {"t0": 1.0, "t1": 9.0, "url": "https://chatgpt.com/", "intent": "make the logo", "start": 2, "end": 18}
seg_out = {"t0": 12.0, "t1": 18.0, "url": "https://chatgpt.com/pricing", "intent": "the free plan", "start": 24, "end": 36,
           "session": {"kind": "public", "locale": "en-US", "timezone": "America/New_York", "currency": "USD", "egress": "US"}}
plan = {"segments": [seg_in, seg_out], "overlays": [], "dropped": [], "beats": []}
calls = {"record": 0, "session": 0, "docker": [], "plan": 0}


def boom(*a, **k):
    calls["record"] += 1
    raise AssertionError("the on-camera agent must not record")


class NoSession:
    def __init__(self, *a, **k):
        calls["session"] += 1
        raise AssertionError("no logged-in browser may start")


saved = (agentrec.scout_for, agentrec.known_pages, agentrec.record_segment, agentrec.Session, director.plan,
         director.validate, director.write_script, graphics_long.render, longedit._docker, usroute.route_for_job)
try:
    agentrec.scout_for = lambda url: ({"slug": "chatgpt", "profile": str(TMP / "prof"), "report": "", "logged_in_at": 1}
                                      if "chatgpt.com" in url else None)
    agentrec.known_pages = lambda profile, limit=25: []
    agentrec.record_segment = boom
    agentrec.Session = NoSession

    def fake_plan(video, sites, sponsored, knowledge, facts=None):
        calls["plan"] += 1
        return plan, {"segments": []}, {"usd": 0.0}
    director.plan = fake_plan
    director.validate = lambda raw, video, sites, facts=None: plan
    graphics_long.render = lambda w, ov, video, fps, tag="gfx", cancelled=None: []
    longedit._docker = lambda args, mounts, cancelled, name="x", cpus=None, tz="", env=None: calls["docker"].append((args, env))
    usroute.route_for_job = lambda: None                              # us_route disabled: no proxy
    logs = []
    check(config.recorder() == {"mode": "scripted", "on_camera_agent": False}, "recorder: scripted, agent off")
    os.environ["AIEDITOR_ON_CAMERA_AGENT"] = "1"
    check(config.recorder(factory=True)["on_camera_agent"] is False, "factory mode ignores the env override")
    os.environ.pop("AIEDITOR_ON_CAMERA_AGENT")
    summary, usd = longedit.plan_and_record(d, 1, v, [{"url": "https://chatgpt.com/", "note": ""}], False, 30,
                                            lambda m, f: None, lambda: False, logs.append)
    check(calls["record"] == 0 and calls["session"] == 0, "no on-camera agent call, no logged-in browser")
    check(calls["docker"] == [], f"nothing recorded (no browser left this box): {calls['docker']}")
    r0 = json.loads((d / "edit-01" / "seg-00" / "recording.json").read_text())
    check(r0["status"] == "needs_scripted_recorder", f"logged-in segment waits for the scripted recorder: {r0}")
    r1 = json.loads((d / "edit-01" / "seg-01" / "recording.json").read_text())
    check(r1["status"] == "no_us_route", f"outside segment is not recorded without a US route: {r1}")
    held = longedit.held_reasons(d)
    check({h["reason"] for h in held} == {"needs_scripted_recorder", "no US route"}, f"held reasons: {held}")
    check(any("job is held" in m for m in logs) and "2 held" in summary, f"logged as warnings: {summary}")

    # with a US route: the outside segment records in the fresh outside Chrome through it
    for sub in ("seg-01",):
        for f in (d / "edit-01" / sub).glob("*"):
            f.unlink()
    longedit.clear_held(d)
    usroute.route_for_job = lambda: "http://203.0.113.50:8899"

    def fake_docker(args, mounts, cancelled, name="x", cpus=None, tz="", env=None):
        calls["docker"].append((args, env))
        sd = Path(mounts[1][0])
        if "inventory.mjs" in args[1]:
            (sd / "inventory.json").write_text("{}")
            (sd / "inventory.jpg").write_bytes(b"x")
        else:
            (sd / "rec").mkdir(exist_ok=True)
            (sd / "rec" / "events.json").write_text("{}")
    longedit._docker = fake_docker
    director.write_script = lambda seg, video, inv, jpg: ({"steps": [{"goto": seg["url"]}, {"begin": True}]}, {"usd": 0.0})
    longedit.plan_and_record(d, 1, v, [{"url": "https://chatgpt.com/", "note": ""}], False, 30,
                             lambda m, f: None, lambda: False, logs.append)
    check(len(calls["docker"]) == 2, f"inventory + recorder for the outside segment only: {len(calls['docker'])}")
    for args, env in calls["docker"]:
        check(env and env["AGENT_PROXY"] == "http://203.0.113.50:8899" and env["TZ"] == "America/New_York"
              and env["AGENT_SESSION"] == "outside" and env["AGENT_PROFILE_DIR"] == "/s/outside-profile",
              f"outside env on {args[1]}: {env}")
    sc = json.loads((d / "edit-01" / "seg-01" / "script.json").read_text())
    check(sc["session"] == "outside" and sc["profileDir"] == "/s/outside-profile", "vrecord runs the outside session")
    check({h["reason"] for h in longedit.held_reasons(d)} == {"needs_scripted_recorder"}, "only the logged-in one is held")
finally:
    (agentrec.scout_for, agentrec.known_pages, agentrec.record_segment, agentrec.Session, director.plan,
     director.validate, director.write_script, graphics_long.render, longedit._docker, usroute.route_for_job) = saved

# the worker ends a held job with that message (until p4 renders "held")
wk = (ROOT / "bin" / "aieditor-worker").read_text()
check("raise Held(held)" in wk and "held_reasons=exc.reasons" in wk, "the worker stops a held job before compose")
src = (ROOT / "aieditor" / "cloud.py").read_text()
check("usroute.create_us_proxy(jid, allow_ip=pub" in src and "usroute.destroy_us_proxy(jid, proxy" in src
      and 'extra["AIEDITOR_US_PROXY"]' in src, "run_remote creates/destroys the US proxy and hands its URL to the job")
print(f"test_usroute: {n} checks passed")
