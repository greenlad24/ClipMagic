"""The factory's cloud lane: a DigitalOcean droplet PER JOB, always destroyed afterwards.

Jake 2026-10-08 (plan B, budget ≤ $100/month, DigitalOcean only): this box keeps the Lab,
Postiz and the job folders (on the 500 GiB "factory-media" Volume); every heavy job runs on
a fresh CPU-Optimized droplet (c-32 ≈ $1/h) in SGP1, inside the same VPC, created from the
factory snapshot and deleted the moment the job ends. A powered-off droplet still bills, so
"done" always means DELETED, never stopped.

    request ─▶ worker claims ─▶ run_remote(): create droplet ─▶ push code + job + keys (VPC)
             ─▶ remote `aieditor-worker --once <job> <action>` on the droplet's own disk
             ─▶ pull status/events/log every few seconds (the Lab's progress bars stay live)
             ─▶ pull results ─▶ DESTROY (finally) ─▶ the watchdog destroys anything left over

Safety:
  * Only droplets tagged TAG_JOB / TAG_IMAGE are ever touched. The account holds other
    projects' droplets (weshare, sportz, …) — never list-and-delete without the tag.
  * Every job droplet has a lease file (LEASES/<droplet id>.json) whose heartbeat the
    orchestrating thread refreshes. watchdog() (systemd timer, every 5 min) destroys a tagged
    droplet whose lease is missing or stale, or that outlived max_hours.
  * The token has no block_storage_action scope, so volumes are never attached to job
    droplets: they work on their own disk and results come back over the VPC.
  * Only the keys the editor reads (ANTHROPIC_API_KEY, GROQ_API_KEY) are shipped, mode 0600.
    The Anthropic key a droplet gets is the SEPARATE, spend-limited, revocable droplet key
    (AIEDITOR_DROPLET_ANTHROPIC_KEY in .env), never the org key once that exists — until Jake has
    made it, require_droplet_key (default false) chooses between a warning + the org key and a
    refusal. Key material never appears in a log (droplet_env).
  * Claude API spend: the droplet gets the caps + what was already spent and writes its own ledger
    (<job>/api-ledger.jsonl), merged into the main ledger when the job ends (apiledger.py).
  * One job per logged-in account (accountlock.py): the Scout accounts a job uses are locked on
    this box before its droplet is created and released when it ends.
  * Pricing / visitor views: a tiny US droplet per job (usroute.py) when us_route.enabled; it is
    tagged TAG_US, leased, counted under the server cap and destroyed with the job.
    For screencasts only the matching Scout profiles + a two-table copy of the Scout rows go,
    never the Lab database.
  * The droplet's firewall (ufw, baked into the snapshot) accepts SSH from the VPC only.

EGRESS (Jake 2026-10-08 — his factory job recorded Cloudflare's "Verify you are human" page: Cloudflare
ties a logged-in session to the IP it was made from, this box 139.59.250.178): a droplet's screencast
browsers leave the internet THROUGH this box. bin/aieditor-egress-proxy (systemd
aieditor-egress-proxy.service, unit file next to it) is a stdlib HTTP CONNECT proxy listening ONLY on
the VPC address EGRESS (10.104.0.3:8899; ufw: allow from 10.104.0.0/20 to that port only; it refuses
other clients, ports other than 80/443 and private destinations). run_remote exports
AIEDITOR_EGRESS_PROXY=EGRESS on the droplet → config.EGRESS_PROXY → agent_rec.mjs / vrecord.mjs /
inventory.mjs add --proxy-server (screencast/macchrome.mjs). On this box no proxy is used.

Settings: WORK/factory.json (created with DEFAULTS on first use). The snapshot is rebuilt
automatically when the local Docker images change (manifest of image ids)."""
import json
import os
import shlex
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import config

API = "https://api.digitalocean.com/v2"
EGRESS = os.environ.get("AIEDITOR_FACTORY_EGRESS", "http://10.104.0.3:8899")
SECRETS = Path("/var/lib/docker/volumes/clipmagic_clipmagic-lab-data/_data/postiz-settings.json")
LAB_DATA = Path("/var/lib/docker/volumes/clipmagic_clipmagic-lab-data/_data")
SSH_KEY = Path("/root/.ssh/factory_ed25519")
SSH_KEY_NAME = "clipmagic-factory"
CFG = config.WORK / "factory.json"
LEASES = config.WORK / "factory-leases"
TAG_JOB = "clipmagic-factory-job"
TAG_IMAGE = "clipmagic-factory-image"
TAG_US = "clipmagic-factory-usproxy"       # usroute.py: the per-job US exit for the outside-view Chrome
IMAGES = ("hyperframes-runner:0.8.30", "aieditor-aligner:0.1", "aieditor-screencast:0.2", "aieditor-motion:1")
SHIP_KEYS = ("ANTHROPIC_API_KEY", "GROQ_API_KEY")
DROPLET_KEY = "AIEDITOR_DROPLET_ANTHROPIC_KEY"   # the separate revocable key (Jake creates it in the Console)
LAB_OWNED = ("queue.json", "cancel", "request.json", "plan.edit.json", "joins.edit.json")
LIVE_FILES = ("status.json", "events.jsonl", "log.txt")
HISTORY = config.WORK / "factory-history.jsonl"     # one line per server: job, minutes, $ (the Lab's spend view)
IMAGE_REQUEST = config.WORK / "factory-image.request"   # the Lab asks for a snapshot rebuild
IMAGE_STATE = config.WORK / "factory-image.json"        # {state, started, finished, log[]} for the Lab

DEFAULTS = {
    "enabled": False,               # flipped on once a snapshot exists and the trial passed
    "region": "sgp1",
    "vpc_uuid": "22855d0e-6717-487a-a933-7a159f4afb1f",   # default-sgp1, 10.104.0.0/20 (this box: 10.104.0.3)
    "vpc_range": "10.104.0.0/20",
    "size": "c-32",                 # 32 vCPU / 64 GB, $1/h
    "builder_size": "s-2vcpu-4gb",  # 80 GB disk → the snapshot fits every c-* size
    "base_image": "ubuntu-24-04-x64",
    "snapshot_id": None,
    "snapshot_manifest": None,      # {image: docker image id} baked into snapshot_id
    "actions": ["run", "render", "final", "edit"],   # rebuild/recut are LLM-only → stay here
    "max_parallel": 2,
    "max_hours": 10,                # hard ceiling for one job droplet
    "lease_stale_s": 600,
    "fallback_local": False,        # Jake 2026-10-09: always the factory server — no main-box fallback
    "daily_cap_usd": 20,            # rolling 24 h server spend; over it, jobs wait in the queue
    # Claude API caps (apiledger.py). The daily figure is Jake's decision 1 — suggested $30, PENDING.
    "api_job_cap_usd": {"creative": 8, "cut": 1},
    "api_daily_cap_usd": 30,
    "api_daily_cap_pending_jake": False,   # Jake 2026-10-09 decision 1: $30 per rolling 24 h
    # the droplet's own revocable API key (decision 6): false = warn and ship the org key until it exists
    "require_droplet_key": False,
    "require_droplet_key_pending_jake": True,
    # per-job US exit for pricing / visitor views (usroute.py). Off this round: outside segments are
    # held ("no US route") instead of going out through the Singapore box.
    "us_route": {"enabled": False, "region": "nyc3", "size": "s-1vcpu-512mb-10gb", "port": 8899},
}


# ── settings ────────────────────────────────────────────────────────────────
def settings():
    cur = {}
    try:
        cur = json.loads(CFG.read_text())
    except (OSError, ValueError):
        pass
    out = {**DEFAULTS, **cur}
    if out != cur:
        save_settings(out)
    return out


def save_settings(s):
    tmp = CFG.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=2))
    tmp.replace(CFG)


def enabled_for(action, req=None):
    """request.json "run_on": "auto" (default: the factory when it is on) | "factory" | "box".
    Jake 2026-10-09: "use always the factory server" — with the factory on, heavy work never
    drops to the main box to save money (an overnight test ran a 2 h composite there); "box"
    is honoured only when the factory is switched off. Spend is bounded by daily_cap_usd."""
    run_on = (req or {}).get("run_on", "auto")
    s = settings()
    if not (s["snapshot_id"] and action in s["actions"] and token()):
        return False
    return bool(s["enabled"] or run_on == "factory")


def spent_24h():
    """Server $ in the last 24 h: finished runs (history) + what live servers have cost so far."""
    now = time.time()
    usd = 0.0
    try:
        for line in HISTORY.read_text().splitlines():
            r = json.loads(line)
            if (r.get("ended") or 0) > now - 86400:
                usd += float(r.get("usd") or 0)
    except (OSError, ValueError):
        pass
    for lp in LEASES.glob("*.json") if LEASES.exists() else []:
        try:
            ls = json.loads(lp.read_text())
            usd += max(0.0, now - ls.get("created", now)) / 3600 * _price(ls.get("size", "c-32"))
        except (OSError, ValueError):
            pass
    return usd


def over_daily_cap():
    """Jake 2026-10-09: "a cap of $20 per 24 hours". Over it, factory jobs WAIT in the queue
    (they do not fall back to the main box) until the rolling window frees up."""
    cap = settings().get("daily_cap_usd")
    return bool(cap) and spent_24h() >= float(cap)


def runner(job_dir, **kw):
    """job/runner.json — where this job runs right now, for the Lab's badge. Never pulled over
    by the server's copy (the server has none)."""
    p = Path(job_dir) / "runner.json"
    cur = {}
    try:
        cur = json.loads(p.read_text())
    except (OSError, ValueError):
        pass
    cur.update(kw, updated_at=time.time())
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(cur))
    tmp.replace(p)


# ── DigitalOcean API ────────────────────────────────────────────────────────
def token():
    try:
        return (json.loads(SECRETS.read_text()).get("DO_API_TOKEN") or "").strip()
    except (OSError, ValueError):
        return ""


class DOError(RuntimeError):
    pass


def api(method, path, body=None, ok404=False, tries=4):
    data = json.dumps(body).encode() if body is not None else None
    for i in range(tries):
        req = urllib.request.Request(API + path, data=data, method=method, headers={
            "Authorization": "Bearer " + token(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code == 404 and ok404:
                return None
            msg = e.read().decode("utf-8", "replace")[:300]
            if e.code in (429, 500, 502, 503, 504) and i < tries - 1:
                time.sleep(3 * 2 ** i)
                continue
            raise DOError(f"DigitalOcean {method} {path} → {e.code}: {msg}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            if i < tries - 1:
                time.sleep(3 * 2 ** i)
                continue
            raise DOError(f"DigitalOcean {method} {path} unreachable: {e}") from None


def tagged(tag):
    return api("GET", f"/droplets?tag_name={tag}&per_page=200")["droplets"]


def key_id():
    for k in api("GET", "/account/keys?per_page=200")["ssh_keys"]:
        if k["name"] == SSH_KEY_NAME:
            return k["id"]
    raise DOError(f"SSH key '{SSH_KEY_NAME}' is not in the DigitalOcean account")


def create(name, size, image, tag, user_data=None, region=None, vpc=True, ssh_keys=True):
    s = settings()
    if tag not in (TAG_JOB, TAG_IMAGE, TAG_US):
        raise ValueError(tag)
    body = {"name": name, "region": region or s["region"], "size": size, "image": image,
            "ssh_keys": [key_id()] if ssh_keys else [], "tags": [tag],
            "monitoring": False, "ipv6": False, "backups": False}
    if vpc:
        body["vpc_uuid"] = s["vpc_uuid"]
    if user_data:
        body["user_data"] = user_data
    return api("POST", "/droplets", body)["droplet"]["id"]


def wait_active(did, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = api("GET", f"/droplets/{did}")["droplet"]
        if d["status"] == "active":
            nets = d["networks"]["v4"]
            priv = next((n["ip_address"] for n in nets if n["type"] == "private"), None)
            pub = next((n["ip_address"] for n in nets if n["type"] == "public"), None)
            if priv:
                return priv, pub
        time.sleep(5)
    raise DOError(f"droplet {did} not active after {timeout}s")


def destroy(did):
    """Delete, then confirm it is gone (a failed delete would bill forever)."""
    for i in range(6):
        try:
            api("DELETE", f"/droplets/{did}", ok404=True)
        except DOError:
            pass
        time.sleep(4)
        if api("GET", f"/droplets/{did}", ok404=True) is None:
            (LEASES / f"{did}.json").unlink(missing_ok=True)
            return True
        time.sleep(5 * (i + 1))
    return False


def wait_action(aid, timeout=3600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        a = api("GET", f"/actions/{aid}")["action"]
        if a["status"] == "completed":
            return a
        if a["status"] == "errored":
            raise DOError(f"action {aid} errored")
        time.sleep(10)
    raise DOError(f"action {aid} timed out")


# ── ssh / rsync over the VPC ────────────────────────────────────────────────
SSH_OPTS = ["-i", str(SSH_KEY), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8"]


def ssh(ip, cmd, timeout=600, check=True, input=None):
    r = subprocess.run(["ssh", *SSH_OPTS, f"root@{ip}", cmd], input=input, capture_output=True,
                       timeout=timeout)
    if check and r.returncode != 0:
        raise DOError(f"ssh {cmd[:80]!r} → {r.returncode}: {r.stderr.decode('utf-8', 'replace')[-400:]}")
    return r.stdout.decode("utf-8", "replace")


def rsync(src, dst, *extra, timeout=7200):
    r = subprocess.run(["rsync", "-a", "--partial", "-e", "ssh " + " ".join(shlex.quote(o) for o in SSH_OPTS),
                        *extra, src, dst], capture_output=True, timeout=timeout)
    if r.returncode not in (0, 24):          # 24 = files vanished mid-copy (live logs)
        raise DOError(f"rsync {src} → {dst}: {r.stderr.decode('utf-8', 'replace')[-400:]}")


def wait_ssh(ip, timeout=420):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if "ok" in ssh(ip, "cloud-init status --wait >/dev/null 2>&1; echo ok", timeout=400, check=False):
                return
        except subprocess.TimeoutExpired:
            pass
        time.sleep(5)
    raise DOError(f"no SSH on {ip} after {timeout}s")


# ── leases + watchdog ───────────────────────────────────────────────────────
def lease(did, **kw):
    LEASES.mkdir(parents=True, exist_ok=True)
    p = LEASES / f"{did}.json"
    cur = {}
    try:
        cur = json.loads(p.read_text())
    except (OSError, ValueError):
        pass
    cur.update(kw, droplet=did, heartbeat=time.time())
    cur.setdefault("created", time.time())
    p.write_text(json.dumps(cur))


def watchdog(log=print):
    """Destroy every tagged droplet nobody is holding. Safe to run any time, from cron."""
    if not token():
        return []
    s = settings()
    killed = []
    now = time.time()
    for d in tagged(TAG_JOB) + tagged(TAG_IMAGE) + tagged(TAG_US):
        did = d["id"]
        age = now - _utc(d["created_at"])
        lp = LEASES / f"{did}.json"
        hb = None
        try:
            hb = json.loads(lp.read_text()).get("heartbeat")
        except (OSError, ValueError):
            pass
        ceiling = s["max_hours"] * 3600 if (TAG_JOB in d["tags"] or TAG_US in d["tags"]) else 3 * 3600
        why = None
        if age > ceiling:
            why = f"older than {ceiling / 3600:.0f} h"
        elif hb is None and age > 900:
            why = "no lease"
        elif hb is not None and now - hb > s["lease_stale_s"]:
            why = f"lease stale {int(now - hb)} s"
        if why:
            ok = destroy(did)
            log(f"watchdog: destroyed {d['name']} ({did}) — {why}" + ("" if ok else " — DELETE NOT CONFIRMED"))
            killed.append(did)
    live = {str(d["id"]) for d in tagged(TAG_JOB) + tagged(TAG_IMAGE) + tagged(TAG_US)}
    for lp in LEASES.glob("*.json") if LEASES.exists() else []:
        if lp.stem not in live:
            lp.unlink(missing_ok=True)
    return killed


def _utc(stamp):
    import calendar
    return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))


class Heartbeat:
    """Refreshes a lease while a block runs."""
    def __init__(self, did, **kw):
        self.did, self.kw, self.stop = did, kw, threading.Event()

    def __enter__(self):
        lease(self.did, **self.kw)
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()
        return self

    def _run(self):
        while not self.stop.wait(30):
            try:
                lease(self.did)
            except OSError:
                pass

    def __exit__(self, *a):
        self.stop.set()


# ── the snapshot (docker images + aligner models baked in) ──────────────────
CLOUD_INIT = """#cloud-config
package_update: true
packages: [docker.io, rsync, python3, ufw]
runcmd:
  - systemctl enable --now docker
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow from {vpc} to any port 22 proto tcp
  - ufw --force enable
  - mkdir -p /opt/aieditor-work/jobs /opt/clipmagic/aieditor
"""


def local_manifest():
    out = {}
    for img in IMAGES:
        r = subprocess.run(["docker", "image", "inspect", "-f", "{{.Id}}", img], capture_output=True, text=True)
        out[img] = r.stdout.strip() or None
    return out


def image_current():
    s = settings()
    return bool(s["snapshot_id"]) and s.get("snapshot_manifest") == local_manifest()


def image_state(**kw):
    cur = {}
    try:
        cur = json.loads(IMAGE_STATE.read_text())
    except (OSError, ValueError):
        pass
    cur.update(kw)
    IMAGE_STATE.write_text(json.dumps(cur))


def build_image_tracked():
    """build_image() with its progress in IMAGE_STATE (what the Lab's Rebuild button shows)."""
    lines = []

    def log(msg):
        lines.append(time.strftime("%H:%M:%S ") + msg)
        image_state(log=lines[-40:])
    image_state(state="building", started=time.time(), finished=None, error=None, log=[])
    try:
        sid = build_image(log)
        image_state(state="done", finished=time.time(), snapshot_id=sid)
    except Exception as e:                                # noqa: BLE001
        image_state(state="failed", finished=time.time(), error=str(e)[:500])
        raise


def build_image(log=print):
    """Provision a small builder droplet, load the images + models, snapshot it, destroy it."""
    s = settings()
    man = local_manifest()
    if not all(man.values()):
        raise DOError(f"missing local images: {[k for k, v in man.items() if not v]}")
    name = "factory-image-" + time.strftime("%Y%m%d-%H%M")
    did = create(name, s["builder_size"], s["base_image"], TAG_IMAGE,
                 user_data=CLOUD_INIT.format(vpc=s["vpc_range"]))
    log(f"builder droplet {did} created ({s['builder_size']})")
    try:
        with Heartbeat(did, role="image"):
            ip, _ = wait_active(did)
            wait_ssh(ip)
            ssh(ip, "docker info >/dev/null && ufw status | grep -q active && echo ok")
            log(f"builder {ip} ready (docker + VPC-only ssh)")
            for img in IMAGES:
                t0 = time.time()
                save = subprocess.Popen(["nice", "-n", "15", "docker", "save", img], stdout=subprocess.PIPE)
                load = subprocess.run(["ssh", *SSH_OPTS, f"root@{ip}", "docker load"], stdin=save.stdout,
                                      capture_output=True, timeout=3600)
                save.stdout.close()
                if save.wait() != 0 or load.returncode != 0:
                    raise DOError(f"loading {img} failed: {load.stderr.decode()[-300:]}")
                log(f"  {img} loaded in {time.time() - t0:.0f}s")
            remote_id = ssh(ip, "for i in " + " ".join(IMAGES) + "; do docker image inspect -f '{{.Id}}' $i; done").split()
            if remote_id != [man[i] for i in IMAGES]:
                raise DOError("image ids differ after load")
            for sub in ("models", "sfx", "music"):
                rsync(str(config.WORK / sub) + "/", f"root@{ip}:{config.WORK / sub}/")
            log("  models + sfx + music copied")
            ssh(ip, "cloud-init clean --logs >/dev/null 2>&1; rm -f /root/.ssh/authorized_keys; sync; poweroff", check=False)
            for _ in range(60):
                if api("GET", f"/droplets/{did}")["droplet"]["status"] == "off":
                    break
                time.sleep(5)
            a = api("POST", f"/droplets/{did}/actions", {"type": "snapshot", "name": name})["action"]
            log("  snapshotting…")
            wait_action(a["id"], timeout=5400)
            # the account's snapshot list catches up a little after the action completes
            # (2026-10-08: the per-droplet list was still empty) — look it up by name, with retries
            snaps = []
            for _ in range(12):
                snaps = [x for x in api("GET", "/snapshots?resource_type=droplet&per_page=200")["snapshots"]
                         if x["name"] == name]
                if snaps:
                    break
                time.sleep(10)
            if not snaps:
                raise DOError("snapshot not found after the action completed")
            new_id = snaps[0]["id"]
    finally:
        log(f"builder {did} destroyed" if destroy(did) else f"builder {did} DELETE NOT CONFIRMED")
    old = s.get("snapshot_id")
    s = settings()
    s.update(snapshot_id=new_id, snapshot_manifest=man, snapshot_name=name, snapshot_at=time.time())
    save_settings(s)
    if old and str(old) != str(new_id):
        try:
            api("DELETE", f"/images/{old}", ok404=True)
            log(f"old snapshot {old} deleted")
        except DOError as e:
            log(f"old snapshot {old} not deleted: {e}")
    log(f"snapshot {new_id} ready")
    return new_id


# ── one job on its own droplet ──────────────────────────────────────────────
_slots = threading.Lock()
ACTIVE = {}                         # job id → droplet id (None while creating)


def busy():
    with _slots:
        return len(ACTIVE)


def running(job_id):
    with _slots:
        return job_id in ACTIVE


def scout_slugs(req, job_dir=None):
    """The Scout (logged-in) accounts a job will use — what accountlock.py locks."""
    from . import agentrec
    sites = [s.get("url") for s in req.get("sites") or [] if s.get("url")]
    derived = Path(job_dir) / "sites.json" if job_dir else None
    if not sites and derived and derived.exists():
        sites = [s.get("url") for s in json.loads(derived.read_text()).get("sites", []) if s.get("url")]
    found = [agentrec.scout_for(u) for u in sites]
    slugs = sorted({f["slug"] for f in found if f})
    if not sites and req.get("workflow") == "creative" and not (derived and derived.exists()):
        # no sites given: pre-production derives them from the narration ON the server (the transcript
        # is made there) — so every screencastable logged-in Scout app goes along (aieditor/sites.py;
        # private inboxes never do). A job that already derived them (sites.json) sends only those.
        from . import sites as sites_mod
        slugs = sorted(set(sites_mod.candidate_slugs()))
    return slugs


def _scout_bundle(req, stage_dir, job_dir=None, slugs=None):
    """The Scout profiles + rows a screencast job needs, nothing else."""
    slugs = scout_slugs(req, job_dir) if slugs is None else slugs
    if not slugs:
        return []
    db = stage_dir / "clipmagic.db"
    src = sqlite3.connect(f"file:{LAB_DATA / 'db' / 'clipmagic.db'}?mode=ro", uri=True, timeout=10)
    dst = sqlite3.connect(db)
    for table, col in (("scout_tools", "slug"), ("scout_jobs", "tool_slug")):
        ddl = src.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
        dst.execute(ddl)
        rows = src.execute(f"SELECT * FROM {table} WHERE {col} IN ({','.join('?' * len(slugs))})", slugs).fetchall()
        if rows:
            dst.executemany(f"INSERT INTO {table} VALUES ({','.join('?' * len(rows[0]))})", rows)
    dst.commit()
    dst.close()
    src.close()
    return slugs


def droplet_key_set():
    return bool(config.env_key(DROPLET_KEY))


def droplet_env(log, s=None):
    """The .env text a job droplet gets (KEY=value lines, sent over ssh, mode 0600). The Anthropic
    key is the separate revocable droplet key when it exists; without it require_droplet_key decides
    between a warning + the org key and a refusal. Values are NEVER logged — only which key went."""
    s = s or settings()
    vals = {}
    dk = config.env_key(DROPLET_KEY)
    if dk:
        vals["ANTHROPIC_API_KEY"] = dk
        log("Claude API key for the server: the separate, revocable droplet key")
    elif s.get("require_droplet_key"):
        raise DOError(f"no droplet API key ({DROPLET_KEY} in .env) and require_droplet_key is on — "
                      "the org key is never shipped to a server")
    else:
        org = config.env_key("ANTHROPIC_API_KEY")
        if org:
            vals["ANTHROPIC_API_KEY"] = org
        log(f"WARNING: {DROPLET_KEY} is not set — the server gets the org-wide Claude key "
            "(create a spend-limited droplet key in the Console and add it to .env)")
    for k in SHIP_KEYS:
        if k != "ANTHROPIC_API_KEY" and config.env_key(k):
            vals[k] = config.env_key(k)
    return "".join(f"{k}={v}\n" for k, v in vals.items())


def api_env(jid, workflow):
    """What a job droplet needs to keep the API caps without the main ledger (apiledger.py)."""
    from . import apiledger
    job_cap, day_cap = apiledger.caps(workflow)
    return {"AIEDITOR_API_LEDGER": str(config.JOBS / jid / "api-ledger.jsonl"),
            apiledger.ENV_JOB_CAP: f"{job_cap:.4f}", apiledger.ENV_DAILY_CAP: f"{day_cap:.4f}",
            apiledger.ENV_PRIOR_DAY: f"{apiledger.daily_total():.6f}",
            apiledger.ENV_PRIOR_JOB: f"{apiledger.job_total(jid):.6f}",
            apiledger.ENV_DAY_START: f"{time.time():.0f}"}


def merge_ledger(job_dir, log=print):
    """The droplet's API ledger lines → the main ledger (idempotent: line ids)."""
    from . import apiledger
    src = Path(job_dir) / "api-ledger.jsonl"
    if src.exists():
        n = apiledger.merge(src)
        if n:
            log(f"{n} Claude API call(s) added to the spending ledger")


def run_remote(job_dir, action, log, cancelled):
    """Run `action` for the job on a fresh droplet; returns the remote exit code.
    The job folder ends up exactly as if this box had run it. The droplet is always destroyed."""
    s = settings()
    job_dir = Path(job_dir)
    jid = job_dir.name
    req = json.loads((job_dir / "request.json").read_text())
    did = None
    ip = None
    proxy = None
    t_start = time.time()
    ok_run = False
    from . import accountlock, usroute
    workflow = "creative" if req.get("workflow") == "creative" else "cut"
    # a hand-off job (request.json "handoff", aieditor/handoff.py) records nothing: no Scout login, no US route
    screencasts = action in ("run", "edit") and bool(req.get("sites") or workflow == "creative") and not req.get("handoff")
    # one job per logged-in account: a second job for the same Scout account waits here
    lock = accountlock.AccountLock(scout_slugs(req, job_dir) if screencasts else [], jid)
    if not lock.acquire(wait=True, cancelled=cancelled, log=log):
        raise DOError("cancelled while waiting for a logged-in account another job is using")
    with _slots:
        ACTIVE[jid] = None
    runner(job_dir, kind="factory", state="creating", action=action, size=s["size"], region=s["region"],
           started=t_start, droplet=None, usd=0.0, price_hourly=_price(s["size"]), ended=None)
    try:
        did = create(f"factory-{jid[:40]}-{int(time.time()) % 100000}", s["size"], int(s["snapshot_id"]), TAG_JOB)
        with _slots:
            ACTIVE[jid] = did
        with Heartbeat(did, job=jid, action=action, size=s["size"]):
            log(f"factory server {did} ({s['size']}) creating in {s['region']}…")
            ip, pub = wait_active(did)
            # pricing / visitor views: the job's own US exit, reachable from this server only
            usr = s.get("us_route") or {}
            if usr.get("enabled") and screencasts and workflow == "creative":
                proxy = usroute.create_us_proxy(jid, allow_ip=pub, log=log)
            wait_ssh(ip)
            log(f"factory server up at {ip} after {time.time() - t_start:.0f}s — sending the job")
            runner(job_dir, state="sending", droplet=did, up_after_s=round(time.time() - t_start))
            # code (always the current one: the snapshot only carries images + models)
            rsync(str(config.CODE) + "/", f"root@{ip}:{config.CODE}/", "--delete",
                  "--exclude", "__pycache__", "--exclude", "tests", "--exclude", "node_modules")
            env = droplet_env(log, s)
            ssh(ip, f"umask 077; mkdir -p {config.ENV_FILE.parent}; cat > {config.ENV_FILE}", input=env.encode())
            # the job folder, source video included (VPC: free + fast)
            rsync(str(job_dir), f"root@{ip}:{config.JOBS}/", "--exclude", "cancel", "--exclude", "queue.json",
                  "--exclude", "tmp-*", "--exclude", "api-ledger.jsonl")
            if screencasts:
                with tempfile.TemporaryDirectory(prefix="factory-scout-") as td:
                    slugs = _scout_bundle(req, Path(td), job_dir, slugs=lock.slugs)
                    if slugs:
                        ssh(ip, f"mkdir -p {LAB_DATA / 'db'} {LAB_DATA / 'scout/profiles'}")
                        rsync(str(Path(td) / "clipmagic.db"), f"root@{ip}:{LAB_DATA / 'db'}/")
                        for slug in slugs:
                            rsync(str(LAB_DATA / "scout/profiles" / slug), f"root@{ip}:{LAB_DATA / 'scout/profiles'}/")
                        log(f"screencast logins sent: {', '.join(slugs)}")
            rjob = config.JOBS / jid
            # ";" not "&&": only the worker may go to the background — a backgrounded "a && b &"
            # list keeps ssh's stdout open and the call blocked until the job ENDED (trial 1)
            extra = {"AIEDITOR_FACTORY_SERVER": "1", **api_env(jid, workflow)}
            if proxy:
                extra["AIEDITOR_US_PROXY"] = proxy["url"]
            ssh(ip, "cd {code}; mem=$(awk '/MemTotal/{{print int($2/1048576*0.85)}}' /proc/meminfo); "
                    "export AIEDITOR_CPUSET=0-$(( $(nproc) - 1 )) AIEDITOR_MEMORY=${{mem}}g PYTHONUNBUFFERED=1 "
                    "AIEDITOR_EGRESS_PROXY={egress} {extra}; "
                    "setsid nohup python3 bin/aieditor-worker --once {jid} {action} "
                    "> {work}/remote.log 2>&1 < /dev/null & echo $! > {work}/remote.pid".format(
                        code=config.CODE, jid=shlex.quote(jid), action=shlex.quote(action), work=config.WORK,
                        egress=shlex.quote(EGRESS),
                        extra=" ".join(f"{k}={shlex.quote(v)}" for k, v in extra.items())))
            log(f"job started on the factory server ({time.time() - t_start:.0f}s after the request)")
            runner(job_dir, state="running", running_since=time.time())
            sent_cancel = False
            fails = 0
            while True:
                time.sleep(5)
                if cancelled() and not sent_cancel:
                    ssh(ip, f"touch {rjob}/cancel", check=False)
                    sent_cancel = True
                try:
                    for f in LIVE_FILES:
                        rsync(f"root@{ip}:{rjob}/{f}", str(job_dir) + "/", timeout=120)
                    alive = ssh(ip, f"kill -0 $(cat {config.WORK}/remote.pid) 2>/dev/null && echo yes || echo no",
                                timeout=60).strip()
                    fails = 0
                except (DOError, subprocess.TimeoutExpired):
                    fails += 1
                    if fails > 24:                       # ~3 min unreachable: give up, the job is lost
                        raise DOError("lost contact with the factory server")
                    continue
                runner(job_dir, usd=round((time.time() - t_start) / 3600 * _price(s["size"]), 3))
                if alive == "no":
                    break
                if time.time() - t_start > s["max_hours"] * 3600:
                    raise DOError(f"job exceeded {s['max_hours']} h on the factory server")
            excl = []
            for f in LAB_OWNED:
                excl += ["--exclude", f]
            src_local = job_dir / "source.mp4"
            if src_local.exists():
                excl += ["--exclude", "source.mp4"]
            runner(job_dir, state="pulling")
            rsync(f"root@{ip}:{rjob}/", str(job_dir) + "/", *excl, "--exclude", "tmp-*")
            ok_run = True
            tail = ssh(ip, f"tail -5 {config.WORK}/remote.log", check=False)
            log(f"results back after {time.time() - t_start:.0f}s total")
            return tail
    finally:
        if ip and not ok_run:
            try:                     # a failed job's API calls still count against the caps
                rsync(f"root@{ip}:{config.JOBS / jid}/api-ledger.jsonl", str(job_dir) + "/", timeout=120)
            except (DOError, subprocess.TimeoutExpired, OSError):
                pass
        try:
            merge_ledger(job_dir, log)
        except OSError as e:
            log(f"API ledger merge failed: {e}")
        if proxy:
            usroute.destroy_us_proxy(jid, proxy, log=log)
        lock.release()
        ok = True
        if did:
            ok = destroy(did)
            hours = (time.time() - t_start) / 3600
            log(f"factory server {did} destroyed — {hours * 60:.1f} min ≈ ${hours * _price(s['size']):.2f}"
                if ok else f"factory server {did} DELETE NOT CONFIRMED — the watchdog will retry")
        hours = (time.time() - t_start) / 3600
        usd = round(hours * _price(s["size"]), 3) if did else 0.0
        runner(job_dir, state="done" if ok_run else "failed", destroyed=ok, ended=time.time(), usd=usd)
        try:
            with open(HISTORY, "a") as f:
                f.write(json.dumps({"job": jid, "action": action, "droplet": did, "size": s["size"],
                                    "started": t_start, "ended": time.time(), "minutes": round(hours * 60, 2),
                                    "usd": usd, "ok": ok_run, "destroyed": ok}) + "\n")
        except OSError:
            pass
        with _slots:
            ACTIVE.pop(jid, None)


def _price(size):
    return {"c-32": 1.0, "c-16": 0.5, "c2-32vcpu-64gb": 1.11905, "s-2vcpu-4gb": 0.03571,
            "s-1vcpu-512mb-10gb": 0.00595, "s-1vcpu-1gb": 0.00893}.get(size, 1.0)
