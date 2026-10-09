"""The OUTSIDE VIEW: pricing pages and visitor views, seen the way a US visitor sees them
(RULEBOOK L4, R9, R10; architecture recommendation §3 "Tiny US droplet for each job", §3.6).

Two rules this module enforces:
  1. Pricing / visitor views are never shown from the logged-in browser (clickguard refuses them there)
     and never from the Singapore box: they come from a SEPARATE, never-logged-in Chrome with a fresh
     empty profile, en-US, America/New_York, whose traffic leaves through a US IP.
  2. That US IP is a tiny droplet made for ONE job and destroyed with it: create_us_proxy / destroy_us_proxy
     (paired by us_proxy(), also when the job raises). It runs a CONNECT proxy that only the job's
     server may reach (ufw + the proxy's own client allow-list), is tagged/leased like every factory
     droplet (the watchdog removes a leftover) and its minutes count under the $20 / 24 h server cap.

With us_route.enabled = false (the default this round) no proxy exists: longedit holds outside
segments with the reason "no US route" instead of recording them through Singapore.
"""
import base64
import contextlib
import json
import os
import tempfile
import time
from pathlib import Path

from . import cloud, config

TZ = "America/New_York"
LOCALE = "en-US"
NO_ROUTE = "no US route"
PROXY_SRC = config.CODE / "bin" / "aieditor-egress-proxy"
SCOUT_PROFILES = Path("/var/lib/docker/volumes/clipmagic_clipmagic-lab-data/_data/scout/profiles")


def settings():
    return {"enabled": False, "region": "nyc3", "size": "s-1vcpu-512mb-10gb", "port": 8899,
            **(cloud.settings().get("us_route") or {})}


def enabled():
    return bool(settings().get("enabled"))


def cloud_init(allow_ip, port):
    """A CONNECT proxy (the main box's stdlib egress proxy, re-pointed) that accepts ONLY the job server."""
    src = PROXY_SRC.read_text()
    src = src.replace('ALLOW_CLIENTS = [ipaddress.ip_network("10.104.0.0/20"), ipaddress.ip_network("127.0.0.0/8")]',
                      f'ALLOW_CLIENTS = [ipaddress.ip_network("{allow_ip}/32")]')
    if f'"{allow_ip}/32"' not in src:
        raise RuntimeError("the egress proxy's client allow-list could not be re-pointed")
    b64 = base64.b64encode(src.encode()).decode()
    return f"""#cloud-config
package_update: false
write_files:
  - path: /usr/local/bin/us-proxy
    permissions: '0755'
    encoding: b64
    content: {b64}
runcmd:
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow from {allow_ip} to any port {int(port)} proto tcp
  - ufw --force enable
  - setsid nohup python3 /usr/local/bin/us-proxy --host 0.0.0.0 --port {int(port)} > /var/log/us-proxy.log 2>&1 &
"""


def create_us_proxy(job, allow_ip, client=cloud, log=print):
    """The job's US exit → {"id", "ip", "url", "region", "size"}. A droplet that does not come up is
    destroyed before the error leaves here (no orphan, ever)."""
    s = settings()
    if not allow_ip:
        raise RuntimeError("the job server has no public IP to allow on the US proxy")
    name = f"usproxy-{str(job)[:40]}-{int(time.time()) % 100000}"
    did = client.create(name, s["size"], "ubuntu-24-04-x64", client.TAG_US, user_data=cloud_init(allow_ip, s["port"]),
                        region=s["region"], vpc=False, ssh_keys=False)
    # a lease kept fresh while the job runs: the watchdog removes the proxy if this box loses it
    hb = client.Heartbeat(did, job=job, role="us-proxy", size=s["size"])
    try:
        hb.__enter__()
        _, pub = client.wait_active(did)
        if not pub:
            raise RuntimeError("US proxy droplet has no public IP")
    except BaseException:
        hb.__exit__(None, None, None)
        client.destroy(did)
        raise
    log(f"US route: proxy {did} in {s['region']} ({s['size']}) for this job — reachable from the job server only")
    return {"id": did, "ip": pub, "url": f"http://{pub}:{int(s['port'])}", "region": s["region"],
            "size": s["size"], "created": time.time(), "_hb": hb}


def destroy_us_proxy(job, proxy, client=cloud, log=print):
    if not proxy:
        return True
    if proxy.get("_hb"):
        proxy["_hb"].__exit__(None, None, None)
    ok = client.destroy(proxy["id"])
    hours = (time.time() - proxy.get("created", time.time())) / 3600
    usd = round(hours * client._price(proxy.get("size", "")), 4)
    log(f"US route: proxy {proxy['id']} destroyed (≈ ${usd:.3f})" if ok else
        f"US route: proxy {proxy['id']} DELETE NOT CONFIRMED — the watchdog will retry")
    try:                                    # counted under the $20 / 24 h server cap (cloud.spent_24h)
        with open(client.HISTORY, "a") as f:
            f.write(json.dumps({"job": job, "action": "us-proxy", "droplet": proxy["id"], "size": proxy.get("size"),
                                "started": proxy.get("created"), "ended": time.time(),
                                "minutes": round(hours * 60, 2), "usd": usd, "ok": True, "destroyed": ok}) + "\n")
    except (OSError, AttributeError):
        pass
    return ok


@contextlib.contextmanager
def us_proxy(job, allow_ip, client=cloud, log=print):
    """create … destroy, paired even when the job raises."""
    proxy = create_us_proxy(job, allow_ip, client=client, log=log)
    try:
        yield proxy
    finally:
        destroy_us_proxy(job, proxy, client=client, log=log)


# ── the outside-view Chrome ─────────────────────────────────────────────────
def is_scout_profile(path):
    p = Path(path).resolve()
    try:
        p.relative_to(SCOUT_PROFILES.resolve())
        return True
    except ValueError:
        return "scout/profiles" in str(p)


def fresh_profile(parent=None):
    """A NEW, EMPTY profile directory (never a copy of a Scout profile)."""
    if parent:
        Path(parent).mkdir(parents=True, exist_ok=True)
    d = Path(tempfile.mkdtemp(prefix="outside-profile-", dir=str(parent) if parent else None))
    if is_scout_profile(d) or any(d.iterdir()):
        raise RuntimeError(f"not a fresh empty profile: {d}")
    return d


def outside_chrome_env(proxy, profile_dir=None):
    """Env for vrecord.mjs / inventory.mjs (macchrome.mjs) in the outside view: a never-logged-in Chrome,
    a fresh empty profile, US English, New York time, out through the job's US proxy."""
    url = proxy["url"] if isinstance(proxy, dict) else proxy
    if not url:
        raise RuntimeError(NO_ROUTE)
    prof = Path(profile_dir) if profile_dir else fresh_profile()
    if is_scout_profile(prof) or (prof.exists() and any(prof.iterdir())):
        raise RuntimeError(f"the outside view needs a fresh empty profile, not {prof}")
    return {"AGENT_SESSION": "outside", "AGENT_PROFILE_KIND": "outside", "AGENT_PROFILE_DIR": str(prof),
            "AGENT_PROXY": url, "AGENT_TZ": TZ, "TZ": TZ, "AGENT_LANG": LOCALE,
            "LANG": "en_US.UTF-8", "LANGUAGE": "en_US:en", "LC_ALL": "en_US.UTF-8"}


def route_for_job():
    """The US proxy URL this job may use (cloud.run_remote exports it on the job server), or None."""
    return config.US_PROXY or os.environ.get("AIEDITOR_US_PROXY") or None
