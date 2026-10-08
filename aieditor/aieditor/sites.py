"""WHAT CAN BE SCREENCAST — auto-derived sites for a creative edit whose request.json has no "sites".

Jake 2026-10-08 (creative test): "the test only have text animations and nothing else (zooms,
screencast etc.)" — the creative workflow only screencast request.json "sites", and nothing derived
them from the narration. This module reads the narration (+ the script when given) and returns the
apps/pages being talked about, restricted to:

  (a) apps with a LOGGED-IN UX Scout profile (agentrec.scout_for: scout_tools.logged_in_at set and a
      profile dir) — recorded inside the real app by the agent recorder, and
  (b) PUBLIC pages that need no login (a tool's own landing page, verified with one GET that ends on
      a 200 page that is not a login/sign-up page) — recorded by the scripted recorder.

Never chosen: private inboxes/chats (PRIVATE_SLUGS — what is on screen there is Jake's private mail),
sign-up/checkout/billing/account pages. The safety rules for what the recorder may DO stay in
agentrec.SYSTEM (never delete/buy/publish/share/invite/billing/security; RULEBOOK C4 Blue Bottle).

    derive(words, script=None, title=None, ask=director-call) -> {"sites": [...], "why": [...], "usd": x}
"""
import json
import re
import sqlite3
import urllib.error
import urllib.request

from . import agentrec

# apps whose screen is someone's private data — never auto-picked (gmail = Jake's inbox)
PRIVATE_SLUGS = {"gmail", "outlook", "whatsapp", "messages", "slack"}
PRIVATE_DOMAINS = {"gmail.com", "google.com", "outlook.com", "live.com", "whatsapp.com", "slack.com"}
BAD_PATH = re.compile(r"/(login|log-in|signin|sign-in|signup|sign-up|register|auth|oauth2?|checkout|billing|"
                      r"account|settings|pricing/checkout|cart)\b|//(auth|accounts|login|id)\.", re.I)
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36")      # the Lab console's identity (BROWSER_UA)
MAX_SITES = 4


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def scout_tools():
    """Logged-in Scout tools that may be screencast: [{slug, name, home_url, domain, profile}]."""
    out = []
    try:
        db = sqlite3.connect(f"file:{agentrec.LAB_DATA / 'db' / 'clipmagic.db'}?mode=ro", uri=True, timeout=10)
        rows = db.execute("SELECT slug, name, home_url, logged_in_at FROM scout_tools").fetchall()
        db.close()
    except sqlite3.Error:
        return []
    for slug, name, home, logged in rows:
        if not logged or not home or slug in PRIVATE_SLUGS:
            continue
        dom = agentrec._domain(home)
        if dom in PRIVATE_DOMAINS or not (agentrec.SCOUT_PROFILES / slug).is_dir():
            continue
        out.append({"slug": slug, "name": name or slug, "home_url": home, "domain": dom,
                    "profile": str(agentrec.SCOUT_PROFILES / slug)})
    return out


def _aliases(tool):
    """Spoken forms of a tool: its name, slug and domain root ("Linearity", "linearity", "chat gpt")."""
    root = tool["domain"].split(".")[0]
    al = {_norm(tool["name"]), _norm(tool["slug"]), _norm(root)}
    return {a for a in al if len(a) >= 4}


def mentions(words, tool, script=None):
    """How often the narration (and script) names the tool. Multi-word names are matched on the
    joined text ("chat gpt" == "chatgpt")."""
    al = _aliases(tool)
    toks = [_norm(w.get("word", w.get("w", ""))) for w in words]
    n = 0
    for k in range(len(toks)):
        for span in (1, 2, 3):
            if "".join(toks[k:k + span]) in al:
                n += 1
                break
    if script:
        st = [_norm(x) for x in re.split(r"\s+", script)]
        n += sum(1 for k in range(len(st)) if any("".join(st[k:k + s]) in al for s in (1, 2)))
    return n


def landing_url(tool):
    """The public landing page for a Scout tool (its home_url is often the login/register page)."""
    return f"https://www.{tool['domain']}/" if tool["domain"].count(".") == 1 else f"https://{tool['domain']}/"


def check_public(url, timeout=12):
    """A page that needs no login: one GET ends on a 200 that is not a login/sign-up/checkout page."""
    if not re.match(r"^https://[a-z0-9.-]+\.[a-z]{2,}(/|$)", url or "", re.I) or BAD_PATH.search(url):
        return False, "not a plain https page"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*;q=0.8",
                                               "Accept-Language": "en-US,en;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            final = r.geturl()
            body = r.read(200000).decode("utf-8", "replace").lower()
            if r.status != 200:
                return False, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — DNS, TLS, timeout: not usable
        return False, type(e).__name__
    if BAD_PATH.search(final):
        return False, f"redirects to {final}"
    if "just a moment" in body[:5000] and "cloudflare" in body:
        return False, "bot wall"
    return True, final


ASK = """You pick what a YouTube tutorial's edit can SCREENCAST. Below is the narration (and the
script if any). List the software tools / websites the speaker TALKS ABOUT or DEMONSTRATES (not
ones merely compared in passing), most-talked-about first, with each one's official PUBLIC landing
page URL (the marketing home, https, no login/sign-up/pricing/checkout path). At most 4.
Return ONLY JSON: {"tools": [{"name": "...", "url": "https://...", "why": "<8 words>"}]}"""


def _ask_claude(text):
    from . import director
    raw, meta = director.call([{"type": "text", "text": text}], ASK, max_tokens=3000, effort="low")
    return raw, meta.get("usd", 0.0)


def derive(words, script=None, title=None, ask=True, check=check_public, tools=None, log=print):
    """→ {"sites": [{"url", "note", "scout"?, "derived": True}], "why": [...], "usd": float}.
    Logged-in Scout apps the narration names come first (recorded in the real app); then public
    landing pages of other tools it talks about (verified reachable without a login)."""
    tools = scout_tools() if tools is None else tools
    ask = _ask_claude if ask is True else ask
    why, sites, usd = [], [], 0.0
    counts = sorted(((mentions(words, t, script), t) for t in tools), key=lambda x: -x[0])
    for n, t in counts:
        if n <= 0:
            continue
        sites.append({"url": landing_url(t), "note": f"{t['name']}: landing page + the logged-in app "
                      f"(UX Scout profile '{t['slug']}')", "scout": t["slug"], "derived": True, "mentions": n})
        why.append(f"{t['name']}: named {n}× and logged in through the UX Scout ({t['slug']})")
    if ask:
        text = " ".join(w.get("word", w.get("w", "")) for w in words)
        body = f"TITLE: {title or ''}\n\nNARRATION:\n{text[:60000]}\n\nSCRIPT:\n{(script or '(none)')[:20000]}"
        try:
            raw, usd = ask(body)
        except Exception as e:  # noqa: BLE001 — the factory keeps going with what it has
            raw = {}
            why.append(f"tool lookup failed ({type(e).__name__}: {str(e)[:80]}) — logged-in apps only")
        have = {agentrec._domain(s["url"]) for s in sites}
        for t in (raw or {}).get("tools", [])[:6]:
            url = str(t.get("url", "")).strip()
            dom = agentrec._domain(url) if url else ""
            if not dom or dom in have or dom in PRIVATE_DOMAINS:
                continue
            if mentions(words, {"name": t.get("name", ""), "slug": "", "domain": dom}, script) <= 0:
                why.append(f"{t.get('name')}: not named in the narration — skipped")
                continue
            ok, note = check(url)
            if not ok:
                why.append(f"{t.get('name')} ({url}): no public page usable without a login ({note}) — skipped")
                continue
            sites.append({"url": url, "note": f"{t.get('name', dom)}: public page only (no login) — "
                          f"{t.get('why', '')}".strip(" —"), "derived": True, "public": True})
            have.add(dom)
            why.append(f"{t.get('name')}: public page {url} (no login needed)")
    sites = sites[:MAX_SITES]
    return {"sites": sites, "why": why, "usd": round(usd, 4)}


def resolve(job_dir, req, video, log=print, **kw):
    """The sites a job's edit may screencast: request.json "sites" when given, else derived once
    from the narration and cached in sites.json (the plan's input; reused on every later run)."""
    from pathlib import Path
    p = Path(job_dir) / "sites.json"
    if req.get("sites"):
        return list(req["sites"]), 0.0
    if p.exists():
        return json.loads(p.read_text()).get("sites", []), 0.0
    doc = derive(video["words"], req.get("script"), req.get("title") or video.get("title"), log=log, **kw)
    p.write_text(json.dumps(doc, indent=1))
    for line in doc["why"]:
        log(f"sites: {line}")
    if doc["sites"]:
        log("screencast sites derived from the narration: " + ", ".join(s["url"] for s in doc["sites"]))
    else:
        log("NO screencast possible: the narration names no logged-in Scout app and no public tool page — "
            "this edit is A-roll + overlays only")
    return doc["sites"], doc["usd"]


def candidate_slugs():
    """Scout profiles a creative job with no sites may need (shipped to a factory server before the
    narration is transcribed there)."""
    return [t["slug"] for t in scout_tools()]
