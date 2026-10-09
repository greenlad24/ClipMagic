"""Multi-region factory servers (cloud.py, Jake 2026-10-09: "I always want a 32-core" / "Use another
region when Singapore is out"): region choice, snapshot copies, public-IP SSH + the away cloud-init,
the egress tunnel for logged-in screencasts (or the SGP1-only wait), and the watchdog across regions.
A fake DigitalOcean API, fake ssh/rsync: nothing is created anywhere. WORK is a scratch folder."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="p1-regions-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
for k in ("AIEDITOR_API_LEDGER", "AIEDITOR_US_PROXY", "AIEDITOR_FACTORY_SERVER"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import cloud, config  # noqa: E402

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


check(str(cloud.CFG).startswith(str(TMP)), "the test settings are a scratch file")
_real_sleep = time.sleep
time.sleep = lambda *_: None                     # the fakes answer at once
SID = "5551"
MAIN = "139.59.250.178"


class FakeDO:
    """Routes cloud.api(method, path, body) like DigitalOcean would."""

    def __init__(self, c32=("lon1", "nyc1", "sfo2"), c2=(), image_regions=("sgp1",), action_steps=2):
        self.sizes = [{"slug": "c-32", "available": True, "regions": list(c32), "disk": 400, "vcpus": 32,
                       "memory": 65536, "price_hourly": 1.0},
                      {"slug": "c2-32vcpu-64gb", "available": True, "regions": list(c2), "disk": 800, "vcpus": 32,
                       "memory": 65536, "price_hourly": 1.11905},
                      {"slug": "s-8vcpu-32gb-amd", "available": True, "regions": ["sgp1"], "disk": 400, "vcpus": 8,
                       "memory": 32768, "price_hourly": 0.5}]
        self.image_regions = list(image_regions)
        self.calls, self.actions, self.droplets, self.deleted = [], {}, {}, []
        self.action_steps = action_steps

    def __call__(self, method, path, body=None, ok404=False, tries=4):
        self.calls.append((method, path, body))
        if path.startswith("/sizes"):
            return {"sizes": self.sizes}
        if method == "GET" and path.startswith("/images/"):
            return {"image": {"id": int(path.split("/")[2]), "regions": list(self.image_regions), "size_gigabytes": 14.5}}
        if method == "POST" and path.startswith("/images/") and path.endswith("/actions"):
            aid = 700 + len(self.actions)
            self.actions[aid] = {"region": body["region"], "polls": 0}
            return {"action": {"id": aid, "status": "in-progress"}}
        if method == "GET" and path.startswith("/actions/"):
            a = self.actions[int(path.split("/")[2])]
            a["polls"] += 1
            if a["polls"] > self.action_steps:
                self.image_regions.append(a["region"])
                return {"action": {"status": "completed"}}
            return {"action": {"status": "in-progress"}}
        if method == "GET" and path.startswith("/droplets?tag_name="):
            tag = path.split("=")[1].split("&")[0]
            return {"droplets": [d for d in self.droplets.values() if tag in d["tags"]]}
        if method == "DELETE" and path.startswith("/droplets/"):
            did = int(path.split("/")[2])
            self.deleted.append(did)
            self.droplets.pop(did, None)
            return {}
        if method == "GET" and path.startswith("/droplets/"):
            did = int(path.split("/")[2])
            return {"droplet": self.droplets[did]} if did in self.droplets else None
        if method == "GET" and path.startswith("/account/keys"):
            return {"ssh_keys": [{"name": cloud.SSH_KEY_NAME, "id": 42}]}
        if method == "POST" and path == "/droplets":
            did = 9000 + len(self.droplets) + len(self.deleted)
            self.droplets[did] = {"id": did, "name": body["name"], "tags": body["tags"], "status": "active",
                                  "region": {"slug": body["region"]}, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                  "networks": {"v4": [{"type": "public", "ip_address": "203.0.113.9"},
                                                      {"type": "private", "ip_address": "10.104.0.77" if body.get("vpc_uuid") else "10.131.0.5"}]},
                                  "_body": body}
            return {"droplet": {"id": did}}
        raise AssertionError(f"unexpected DO call {method} {path}")


def fresh_settings(**kw):
    cloud.CFG.unlink(missing_ok=True)
    s = cloud.settings()
    s.update(snapshot_id=SID, enabled=True, require_droplet_key=True, **kw)
    cloud.save_settings(s)
    cloud._CAP.clear()
    return cloud.settings()


# ── 1. region choice ──
s = fresh_settings()
check(cloud.region_order(s)[:4] == ["sgp1", "blr1", "syd1", "lon1"] and cloud.region_order(s)[-1] == "tor1",
      f"default order: {cloud.region_order(s)}")
cloud.api = FakeDO(c32=("sgp1", "lon1"))
check(cloud.pick_placement(s, log=lambda m: None) == ("sgp1", "c-32", 1.0), "SGP1 first when it has a c-32")
cloud.api = FakeDO(c32=(), c2=("sgp1",))
check(cloud.pick_placement(s, log=lambda m: None)[:2] == ("sgp1", "c2-32vcpu-64gb"), "…or a c2-32 in SGP1")
cloud.api = FakeDO(c32=("nyc1", "lon1", "sfo2"))
logs = []
check(cloud.pick_placement(s, log=logs.append)[:2] == ("lon1", "c-32"), "SGP1 out → the nearest region in the order")
check(any("no 32-core server in sgp1" in m and "lon1" in m for m in logs), f"the choice is logged: {logs}")
cloud.api = FakeDO(c32=("blr1", "lon1"))
s = fresh_settings(image_regions={"lon1": {"snapshot_id": SID, "state": "available"}})
check(cloud.pick_placement(s, log=lambda m: None)[0] == "lon1", "a region already holding the snapshot beats a nearer one that must copy it")
s = fresh_settings(image_regions={"lon1": {"snapshot_id": "old", "state": "available"}})
check(cloud.pick_placement(s, log=lambda m: None)[0] == "blr1", "an OLD snapshot's copy does not count")
s = fresh_settings(region_order=["sgp1", "lon1", "blr1"])
check(cloud.pick_placement(s, log=lambda m: None)[0] == "lon1", "the configured order is honoured")
s = fresh_settings()
cloud.api = FakeDO(c32=("ams2",))
try:
    cloud.pick_placement(s, log=lambda m: None)
    check(False, "a region outside the order is never used")
except cloud.DOError as e:
    check("no factory-size server" in str(e), str(e))
cloud.api = FakeDO(c32=("lon1",))
try:
    cloud.pick_placement(s, home_only=True, log=lambda m: None)
    check(False, "home_only refuses away regions")
except cloud.DOError as e:
    check("waits for Singapore" in str(e), str(e))
check(cloud.SIZE_FALLBACKS == ["c-32", "c2-32vcpu-64gb"], "only 32-core sizes")
cloud.api = FakeDO(c32=(), c2=())
check(not cloud.capacity_ok({}, "final"), "no 32-core anywhere → jobs wait")
cloud._CAP.clear()
cloud.api = FakeDO(c32=("lon1",))
check(cloud.capacity_ok({}, "final"), "a 32-core in lon1 → a cut/final/render job can go")

# ── 2. the snapshot in another region ──
s = fresh_settings()
do = FakeDO(c32=("lon1",), action_steps=3)
cloud.api = do
prog = []
check(cloud.ensure_snapshot("lon1", log=lambda m: None, progress=prog.append), "copied")
posts = [c for c in do.calls if c[0] == "POST" and "/images/" in c[1]]
check(len(posts) == 1 and posts[0][2] == {"type": "transfer", "region": "lon1"}, f"one transfer action: {posts}")
check(len(prog) == 3 and all(p.startswith("copying the server image to lon1… ~") and p.endswith(" min") for p in prog),
      f"a waiting job sees the copy: {prog}")
rec = cloud.settings()["image_regions"]["lon1"]
check(rec["state"] == "available" and rec["snapshot_id"] == SID, f"recorded in factory.json: {rec}")
before = len(do.calls)
check(cloud.ensure_snapshot("lon1", log=lambda m: None) and len(do.calls) == before, "a second job: no API call at all")
check(cloud.ensure_snapshot("sgp1") and len(do.calls) == before, "home never copies")
# a copy started by an earlier process (worker restart) is waited for, not started twice
s = fresh_settings(image_regions={"nyc1": {"snapshot_id": SID, "state": "transferring", "action_id": 700,
                                           "started": time.time() - 120}})
do = FakeDO()
do.actions[700] = {"region": "nyc1", "polls": 0}
cloud.api = do
cloud.ensure_snapshot("nyc1", log=lambda m: None)
check(not [c for c in do.calls if c[0] == "POST"], "the running copy is reused")
check(cloud.settings()["image_regions"]["nyc1"]["state"] == "available", "…and marked available")
# the image is already there (DO says so) though factory.json did not know
s = fresh_settings()
do = FakeDO(image_regions=("sgp1", "fra1"))
cloud.api = do
cloud.ensure_snapshot("fra1", log=lambda m: None)
check(not [c for c in do.calls if c[0] == "POST"] and cloud.snapshot_in(cloud.settings(), "fra1"), "already there → recorded, no copy")
# an errored copy fails the wait (the job fails, nothing is created)
class ErrDO(FakeDO):
    def __call__(self, method, path, body=None, **kw):
        if method == "GET" and path.startswith("/actions/"):
            self.calls.append((method, path, body))
            return {"action": {"status": "errored"}}
        return super().__call__(method, path, body, **kw)


cloud.api = ErrDO()
try:
    cloud.ensure_snapshot("ams3", log=lambda m: None)
    check(False, "an errored copy raises")
except cloud.DOError as e:
    check("ams3" in str(e) and cloud.settings()["image_regions"]["ams3"]["state"] == "failed", str(e))
# a rebuilt snapshot: old copies go stale, copies to the used/pre-warmed regions start at once
s = fresh_settings(image_regions={"lon1": {"snapshot_id": SID, "state": "available"}}, regions_used=["sfo2"],
                   prewarm_regions=["nyc1"])
do = FakeDO()
cloud.api = do
s["snapshot_id"] = "6662"
cloud.save_settings(s)
cloud.copy_new_snapshot("6662", log=lambda m: None)
regs = cloud.settings()["image_regions"]
started = sorted(c[2]["region"] for c in do.calls if c[0] == "POST")
check(started == ["lon1", "nyc1", "sfo2"], f"the new snapshot goes to every region used before: {started}")
check(all(regs[r]["state"] == "transferring" and regs[r]["snapshot_id"] == "6662" for r in started), f"{regs}")
check(regs["sgp1"]["snapshot_id"] == "6662" and not cloud.snapshot_in(cloud.settings(), "lon1"),
      "until the copy lands, lon1 does not count as ready")
# the watchdog's tick marks finished copies available
for a in do.actions.values():
    a["polls"] = 99
cloud.poll_transfers(log=lambda m: None)
check(cloud.snapshot_in(cloud.settings(), "lon1"), "poll_transfers marks finished copies")
src = (ROOT / "aieditor" / "cloud.py").read_text()
check('s.get("snapshot_manifest") == local_manifest()' in src and "copy_new_snapshot(new_id, log)" in src,
      "image_current still compares the manifest; a rebuild copies the new snapshot on")

# ── 3. user_data away from home ──
s = fresh_settings()
ud = cloud.away_user_data(s)
allows = [ln for ln in ud.splitlines() if "ufw allow" in ln]
check(allows == [f"  - ufw allow from {MAIN} to any port 22 proto tcp"], f"SSH from the main box only: {allows}")
check("ufw delete allow from 10.104.0.0/20 to any port 22 proto tcp" in ud and "ufw default deny incoming" in ud,
      "the snapshot's VPC rule is removed; everything else inbound is denied")
udt = cloud.away_user_data(s, tunnel=True)
allows_t = [ln for ln in udt.splitlines() if "ufw allow" in ln]
check(len(allows_t) == 2 and "allow in on docker0 to 172.17.0.1 port 8899" in allows_t[1],
      f"tunnel: only the server's own containers may reach the tunnel port: {allows_t}")
check("GatewayPorts clientspecified" in udt, "sshd may bind the reverse tunnel on docker0")


# ── 4. run_remote end to end: public IP, tunnel, refusal, wait mode ──
class FakePopen:
    made = []

    def __init__(self, cmd, **kw):
        self.cmd, self.pid, self.rc = cmd, 4242 + len(FakePopen.made), None
        FakePopen.made.append(self)

    def poll(self):
        return self.rc

    def terminate(self):
        self.rc = -15

    def wait(self, t=None):
        return self.rc

    def kill(self):
        self.rc = -9


class TestTunnel(cloud.Tunnel):
    def __init__(self, ip, egress=cloud.EGRESS, log=print, popen=None, on_start=None):
        super().__init__(ip, egress, log=log, popen=FakePopen, on_start=on_start)


cloud.Tunnel = TestTunnel
cloud.droplet_key = lambda: "sk-droplet-test"
cloud.scout_slugs = lambda req, job_dir=None: []
SSH_HOSTS, RSYNC, CMDS = [], [], []
EGRESS_SEEN = {"ip": MAIN}


def fake_ssh(ip, cmd, timeout=600, check=True, input=None):
    SSH_HOSTS.append(ip)
    CMDS.append(cmd)
    if "cloud-init status" in cmd:
        return "ok\n"
    if "kill -0" in cmd:
        return "no\n"
    if "cdn-cgi/trace" in cmd:
        return f"fl=1\nip={EGRESS_SEEN['ip']}\nts=1\n"
    return ""


def fake_rsync(src, dst, *extra, timeout=7200):
    RSYNC.append((src, dst))


cloud.ssh, cloud.rsync = fake_ssh, fake_rsync


def new_job(name, req):
    d = config.JOBS / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "request.json").write_text(json.dumps(req))
    (d / "status.json").write_text(json.dumps({"state": "running"}))
    return d


def reset():
    SSH_HOSTS.clear()
    RSYNC.clear()
    CMDS.clear()
    FakePopen.made.clear()


# a cut job away from home: public IP for everything, no tunnel
s = fresh_settings(image_regions={"lon1": {"snapshot_id": SID, "state": "available"}})
do = FakeDO(c32=("lon1",), image_regions=("sgp1", "lon1"))
cloud.api = do
reset()
jd = new_job("cut-away", {"workflow": "cut"})
logs = []
cloud.run_remote(jd, "final", logs.append, lambda: False)
body = [c[2] for c in do.calls if c[:2] == ("POST", "/droplets")][0]
check(body["region"] == "lon1" and "vpc_uuid" not in body and body["size"] == "c-32", f"created in lon1, no VPC: {body}")
check(f"ufw allow from {MAIN} to any port 22" in body["user_data"] and "docker0" not in body["user_data"],
      "the away cloud-init: SSH from the main box only (no tunnel port for a job that records nothing)")
check(set(SSH_HOSTS) == {"203.0.113.9"}, f"ssh only to the PUBLIC IP: {set(SSH_HOSTS)}")
hosts = {x.split(":")[0] for pair in RSYNC for x in pair if x.startswith("root@")}
check(hosts == {"root@203.0.113.9"}, f"rsync only to the public IP: {hosts}")
check(not FakePopen.made, "no tunnel for a job without logged-in screencasts")
start_cmd = next(c for c in CMDS if "--once" in c)
check("AIEDITOR_EGRESS_PROXY=http://10.104.0.3:8899" in start_cmd, "an away job without a tunnel keeps the (unreachable) VPC proxy: fail closed")
r = json.loads((jd / "runner.json").read_text())
check(r["region"] == "lon1" and r["state"] == "done" and r["destroyed"] is True, f"runner.json: {r}")
check(any(m.startswith("region: lon1") for m in logs), f"region in the job log: {logs[:3]}")
hist = [json.loads(x) for x in cloud.HISTORY.read_text().splitlines()]
check(hist[-1]["region"] == "lon1" and hist[-1]["destroyed"], "history (the $20/24 h cap) records it")
check(not do.droplets and len(do.deleted) == 1, "destroyed")
check(cloud.settings()["regions_used"] == ["lon1"], "lon1 remembered for snapshot rebuilds")
check(not list(cloud.LEASES.glob("*.json")), "the lease is gone with the server")

# the same job at home: VPC + private IP, no user_data
s = fresh_settings()
do = FakeDO(c32=("sgp1", "lon1"))
cloud.api = do
reset()
cloud.run_remote(new_job("cut-home", {"workflow": "cut"}), "final", lambda m: None, lambda: False)
body = [c[2] for c in do.calls if c[:2] == ("POST", "/droplets")][0]
check(body["region"] == "sgp1" and body.get("vpc_uuid") and "user_data" not in body, "home: the VPC as before")
check(set(SSH_HOSTS) == {"10.104.0.77"}, "home: ssh over the private IP")

# a job whose snapshot copy is needed: progress in runner.json, then the server
s = fresh_settings()
do = FakeDO(c32=("blr1",), action_steps=2)
cloud.api = do
reset()
notes = []
real_runner = cloud.runner


def spy_runner(job_dir, **kw):
    if kw.get("state") == "copying-image":
        notes.append(kw.get("note"))
    real_runner(job_dir, **kw)


cloud.runner = spy_runner
jd = new_job("copy-first", {"workflow": "cut"})
cloud.run_remote(jd, "render", lambda m: None, lambda: False)
cloud.runner = real_runner
check(notes and notes[0].startswith("copying the server image to blr1… ~"), f"badge note while copying: {notes}")
order = [c[1] for c in do.calls if c[0] == "POST"]
check(order.index(f"/images/{SID}/actions") < order.index("/droplets"), "copy first, then create")
check(json.loads((jd / "runner.json").read_text())["note"] is None, "the note is cleared once the server is made")

# a cancelled job while copying: no server is created
s = fresh_settings()
do = FakeDO(c32=("blr1",), action_steps=50)
cloud.api = do
try:
    cloud.run_remote(new_job("copy-cancel", {"workflow": "cut"}), "render", lambda m: None, lambda: True)
    check(False, "cancel while copying raises")
except cloud.DOError:
    check(not [c for c in do.calls if c[:2] == ("POST", "/droplets")], "cancelled while copying → nothing created")

# a LOGGED-IN screencast job away from home (default "tunnel"): egress through the main box
s = fresh_settings(image_regions={"lon1": {"snapshot_id": SID, "state": "available"}})
do = FakeDO(c32=("lon1",), image_regions=("sgp1", "lon1"))
cloud.api = do
reset()
logs = []
cloud.run_remote(new_job("creative-away", {"workflow": "creative"}), "run", logs.append, lambda: False)
body = [c[2] for c in do.calls if c[:2] == ("POST", "/droplets")][0]
check("docker0" in body["user_data"], "the tunnel port is opened to the server's own containers only")
check(len(FakePopen.made) == 1, "one tunnel")
t = FakePopen.made[0]
check(t.cmd[0] == "ssh" and "-R" in t.cmd and t.cmd[t.cmd.index("-R") + 1] == "172.17.0.1:8899:10.104.0.3:8899"
      and t.cmd[-1] == "root@203.0.113.9" and "ExitOnForwardFailure=yes" in t.cmd, f"reverse tunnel: {t.cmd}")
start_cmd = next(c for c in CMDS if "--once" in c)
check("AIEDITOR_EGRESS_PROXY=http://172.17.0.1:8899" in start_cmd, "the job's browsers use the tunnel")
check(t.rc == -15, "the tunnel is closed when the job ends")
check(any("leave as 139.59.250.178" in m for m in logs), "the egress IP is verified before the job starts")
check(not do.droplets, "destroyed")

# …and refused if the tunnel would NOT leave as the main box
EGRESS_SEEN["ip"] = "203.0.113.9"
s = fresh_settings(image_regions={"lon1": {"snapshot_id": SID, "state": "available"}})
do = FakeDO(c32=("lon1",), image_regions=("sgp1", "lon1"))
cloud.api = do
reset()
try:
    cloud.run_remote(new_job("creative-leak", {"workflow": "creative"}), "run", lambda m: None, lambda: False)
    check(False, "a wrong egress IP refuses the job")
except cloud.DOError as e:
    check("does not leave as" in str(e), str(e))
check(not any("--once" in c for c in CMDS), "nothing was started on the server")
check(not do.droplets and FakePopen.made[0].rc == -15, "server destroyed, tunnel closed")
EGRESS_SEEN["ip"] = MAIN

# logged_in_away = "wait": logged-in jobs wait for SGP1, others go anywhere
s = fresh_settings(logged_in_away="wait")
do = FakeDO(c32=("lon1",))
cloud.api = do
check(not cloud.capacity_ok({"workflow": "creative"}, "run"), "a logged-in job waits (stays queued) with SGP1 out")
check(cloud.capacity_ok({"workflow": "creative", "handoff": {"x": 1}}, "run"), "a hand-off job records nothing → any region")
check(cloud.capacity_ok({"workflow": "creative"}, "final"), "the creative job's final render → any region")
check(cloud.capacity_ok({"workflow": "cut"}, "run"), "a cut → any region")
try:
    cloud.run_remote(new_job("creative-wait", {"workflow": "creative"}), "run", lambda m: None, lambda: False)
    check(False, "run_remote refuses too")
except cloud.DOError as e:
    check("Singapore" in str(e) and not do.droplets and not cloud.ACTIVE, f"refused, nothing created, slot freed: {e}")
wk = (ROOT / "bin" / "aieditor-worker").read_text()
check("cloud.capacity_ok(req, action)" in wk, "the worker asks per job")

# ── 5. the watchdog across regions ──
s = fresh_settings()
do = FakeDO()
cloud.api = do
now = time.time()
stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 3600))
for did, region, tag in ((1, "sgp1", cloud.TAG_JOB), (2, "lon1", cloud.TAG_JOB), (3, "nyc1", cloud.TAG_JOB),
                         (4, "sfo2", cloud.TAG_US), (5, "lon1", "someone-else")):
    do.droplets[did] = {"id": did, "name": f"d{did}", "tags": [tag], "region": {"slug": region}, "created_at": stamp}
cloud.LEASES.mkdir(parents=True, exist_ok=True)
leftover = subprocess.Popen(["bash", "-c", 'exec -a ssh python3 -c "import time; time.sleep(120)" -N -R x root@203.0.113.66'])
(cloud.LEASES / "1.json").write_text(json.dumps({"heartbeat": now, "created": now}))                 # held
(cloud.LEASES / "2.json").write_text(json.dumps({"heartbeat": now - 3000, "created": now - 3600,      # stale + tunnel
                                                 "ip": "203.0.113.66", "tunnel_pid": leftover.pid}))
(cloud.LEASES / "4.json").write_text(json.dumps({"heartbeat": now, "created": now}))                 # held US proxy
(cloud.LEASES / "77.json").write_text(json.dumps({"heartbeat": now}))                                # droplet gone
for _ in range(100):          # until bash has exec'd into the fake "ssh"
    if Path(f"/proc/{leftover.pid}/cmdline").read_bytes().startswith(b"ssh\0"):
        break
    _real_sleep(0.05)
wlog = []
killed = cloud.watchdog(wlog.append)
check(sorted(killed) == [2, 3], f"stale lon1 + lease-less nyc1 destroyed, held sgp1 + US kept: {killed}")
check(5 in do.droplets, "another project's droplet is never touched, whatever its region")
try:
    leftover.wait(10)
    check(leftover.returncode is not None, "the dead job's egress tunnel is closed")
except subprocess.TimeoutExpired:
    leftover.kill()
    check(False, f"the leftover tunnel was not closed: {wlog} {Path(f'/proc/{leftover.pid}/cmdline').read_bytes()!r}")
check(not (cloud.LEASES / "77.json").exists() and (cloud.LEASES / "1.json").exists(), "orphan lease swept, live lease kept")
innocent = subprocess.Popen(["sleep", "30"])
check(not cloud._kill_tunnel({"tunnel_pid": innocent.pid, "ip": "203.0.113.66"}), "a pid that is not our ssh -R is never killed")
innocent.kill()
check("tagged(TAG_JOB) + tagged(TAG_IMAGE) + tagged(TAG_US)" in src.split("def watchdog")[1][:1500],
      "the watchdog lists tags (every region), not a region")
print(f"test_regions: {n} checks passed")
