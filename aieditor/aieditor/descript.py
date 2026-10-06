"""Download the source video behind a Descript share link.

Measured 2026-10-04 on Jake's raw projects:
  * the page's `descript:video` meta is api.descript.com/v2/published_projects/<id>/download
  * it answers 429 {"message":"preparing download, retry later"} for several minutes
    (Descript builds the file on demand), then 302 -> a remux proxy on
    media.descriptusercontent.com that STREAMS the MP4 (resume with Range works)
  * `descript:transcript` / subtitles.vtt can be 404 (NoSuchKey) — never rely on them

⚠️ The URL is operator input, so every hop is checked against an allow-list before
it is fetched (this droplet's metadata service answers on 169.254.169.254).
"""
import html
import json
import re
import subprocess
import time
import urllib.parse
import urllib.request

SHARE_RE = re.compile(r"^https://share\.descript\.com/view/([A-Za-z0-9_-]{6,64})/?$")
ALLOWED = ("share.descript.com", "api.descript.com", "media.descriptusercontent.com")
UA = {"User-Agent": "aieditor/1"}


class DescriptError(Exception):
    pass


def _allowed(url):
    u = urllib.parse.urlparse(url)
    host = (u.hostname or "").lower()
    return u.scheme == "https" and u.port in (None, 443) and (
        host in ALLOWED or host == "storage.googleapis.com" or host.endswith(".storage.googleapis.com"))


def share_id(url):
    m = SHARE_RE.match((url or "").strip())
    if not m:
        raise DescriptError("Paste a Descript share link like https://share.descript.com/view/AbC123xyz")
    return m.group(1)


def read_page(url):
    sid = share_id(url)
    req = urllib.request.Request(f"https://share.descript.com/view/{sid}", headers=UA)
    page = urllib.request.urlopen(req, timeout=60).read(8 * 1024 * 1024).decode("utf-8", "replace")
    meta = {}
    for tag in re.findall(r"<meta\s+[^>]*>", page, re.I):
        attrs = dict(re.findall(r'([a-zA-Z:_-]+)\s*=\s*"([^"]*)"', tag))
        key = attrs.get("property") or attrs.get("name")
        if key and "content" in attrs:
            meta.setdefault(key, html.unescape(attrs["content"]))
    durs = [float(d) for d in re.findall(r'"duration"\s*:\s*([0-9]+(?:\.[0-9]+)?)', page)]
    title = re.sub(r"\s+-\s+Descript$", "", meta.get("descript:title") or meta.get("og:title") or "").strip()
    video = meta.get("descript:video")
    if not video or not _allowed(video):
        raise DescriptError("That share page has no downloadable video. In Descript, publish it with "
                            "'Allow download' on, then paste the link again.")
    return {
        "share_id": sid,
        "title": title or sid,
        "width": int(meta.get("og:video:width") or 0) or None,
        "height": int(meta.get("og:video:height") or 0) or None,
        "duration": max(durs) if durs else None,
    }, video


def _probe(url):
    """(status, location, total bytes) of a 1-byte ranged GET, without following redirects."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-0"})
    try:
        with opener.open(req, timeout=60) as r:
            total = (r.headers.get("Content-Range") or "").rpartition("/")[2]
            return r.status, None, int(total) if total.isdigit() else None
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Location"), None


def _resolve(url, max_hops=6):
    """Follow the redirect chain ourselves, checking every hop against the allow-list.
    Measured chain: api.descript.com -> media.descriptusercontent.com (remux)
    -> storage.googleapis.com (206, Content-Range gives the full size)."""
    for _ in range(max_hops):
        status, loc, total = _probe(url)
        if status in (301, 302, 303, 307, 308) and loc:
            nxt = urllib.parse.urljoin(url, loc)
            if not _allowed(nxt):
                raise DescriptError(f"Descript redirected to an unexpected host: {urllib.parse.urlparse(nxt).hostname}")
            url = nxt
            continue
        return status, url, total
    raise DescriptError("Too many redirects on the Descript download")


def download(share_url, dest, progress=lambda msg, frac=None: None, cancelled=lambda: False, max_wait=3600):
    """Fetch the share's video to `dest` (resumable). Returns the page facts."""
    facts, video = read_page(share_url)
    t0 = time.time()
    while True:
        if cancelled():
            raise DescriptError("cancelled")
        status, target, total = _resolve(video)
        if status in (200, 206):
            break
        if status == 429 and time.time() - t0 < max_wait:
            progress(f"Descript is preparing the download ({int(time.time() - t0)}s)…")
            time.sleep(20)
            facts, video = read_page(share_url)      # the signed link can rotate
            continue
        raise DescriptError(f"Descript answered HTTP {status} for the video download")
    for attempt in range(6):
        if cancelled():
            raise DescriptError("cancelled")
        gb = f" ({total / 1e9:.1f} GB)" if total else ""
        progress(f"Downloading the video from Descript{gb}…")
        # --max-redirs 0: every hop was already checked in _resolve; a new one is refused
        # polled, not blocking: the page shows the bytes as they land (an 11 GB download
        # sat at "0 %" for 10+ minutes) and Cancel stops curl mid-download
        p = subprocess.Popen(["curl", "-sS", "--fail", "--proto", "=https", "--max-redirs", "0",
                              "-C", "-", "-o", str(dest), "--retry", "3", "--max-time", "21600", target])
        while p.poll() is None:
            if cancelled():
                p.kill()
                p.wait()
                raise DescriptError("cancelled")
            have = dest.stat().st_size if dest.exists() else 0
            if total:
                progress(f"Downloading the video from Descript ({have / 1e9:.1f} of {total / 1e9:.1f} GB)…", have / total)
            time.sleep(2)
        have = dest.stat().st_size if dest.exists() else 0
        if p.returncode == 0 and have > 1_000_000 and (total is None or have == total):
            return facts
        if total and have > total:                   # a bad resume: start over
            dest.unlink()
        time.sleep(10)
        status, target, total = _resolve(video)      # re-sign the link before retrying
    raise DescriptError("The download from Descript kept failing; try again in a few minutes")


if __name__ == "__main__":
    import sys
    print(json.dumps(read_page(sys.argv[1])[0], indent=1))
