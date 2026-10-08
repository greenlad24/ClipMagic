"""Persistent agentrec.Session daemon (one browser, off camera) for pre-production probes.
  python -m aieditor.sessiond serve <workdir> <site_url> [--dark]     (background)
  python -m aieditor.sessiond send <workdir> '<json msg>' [filter]   prints the reply
Observe screenshots are moved to <workdir>/shots/NNN.jpg. The Scout profile is COPIED by Session.
"""
import json
import os
import shutil
import socket
import sys
from pathlib import Path

from . import agentrec


def serve(wd, site, dark):
    sock = str(wd / "ctl.sock")
    src = agentrec.scout_for(site)
    if not src:
        raise SystemExit(f"no UX Scout profile for {site}")
    s = agentrec.Session(wd, src["profile"], dark=dark)
    (wd / "shots").mkdir(exist_ok=True)
    try:
        os.unlink(sock)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(sock)
    srv.listen(1)
    n = 0
    while True:
        c, _ = srv.accept()
        data = b""
        while not data.endswith(b"\n"):
            data += c.recv(65536)
        msg = json.loads(data)
        try:
            r = s.send(msg)
        except Exception as e:  # noqa: BLE001
            r = {"ok": False, "error": str(e)}
        if str(r.get("shot", "")).startswith("/w/"):
            n += 1
            p = wd / r["shot"][3:]
            dst = wd / "shots" / f"{n:03d}.jpg"
            if p.exists():
                shutil.move(p, dst)
            r["shot"] = str(dst)
        c.sendall((json.dumps(r) + "\n").encode())
        c.close()
        if msg.get("cmd") == "quit":
            s.p.wait(timeout=60)
            break


def send(wd, msg, flt=None):
    c = socket.socket(socket.AF_UNIX)
    c.connect(str(wd / "ctl.sock"))
    c.sendall((msg.strip() + "\n").encode())
    data = b""
    while not data.endswith(b"\n"):
        ch = c.recv(1 << 20)
        if not ch:
            break
        data += ch
    r = json.loads(data)
    if "items" in r:
        if flt:
            r["items"] = [i for i in r["items"] if flt == "*" or flt.lower() in i["text"].lower()]
        else:
            r["items"] = r["items"][:80]
    return r


if __name__ == "__main__":
    cmd, wd = sys.argv[1], Path(sys.argv[2]).resolve()
    if cmd == "serve":
        serve(wd, sys.argv[3], "--dark" in sys.argv)
    else:
        print(json.dumps(send(wd, sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None))[:12000])
