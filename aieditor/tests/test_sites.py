"""Site derivation for creative edits (aieditor/sites.py) + the excerpt timeline (edl.passthrough).

  · a logged-in Scout app the narration names → a site recorded in the real app
  · a private inbox (gmail) is never picked, a tool that is not named is never picked
  · a public tool page is kept only when it opens without a login (check stubbed)
  · nothing nameable → no sites (the edit is A-roll + overlays, and the log says so)
  · request.json "excerpt" keeps only those source ranges, edges moved into pauses

Run: python3 tests/test_sites.py
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import edl, sites  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def words_of(text, t=0.0, step=0.4):
    out = []
    for w in text.split():
        out.append({"word": w, "start": round(t, 3), "end": round(t + 0.3, 3)})
        t += step
    return out


TOOLS = [{"slug": "linearity", "name": "Linearity", "home_url": "https://auth.linearity.io/register",
          "domain": "linearity.io", "profile": "/x/linearity"},
         {"slug": "chatgpt", "name": "ChatGPT", "home_url": "https://chatgpt.com/", "domain": "chatgpt.com",
          "profile": "/x/chatgpt"}]


def main():
    ws = words_of("Today I will show you this tool called Linearity. Linearity makes a whole campaign "
                  "and then we polish the copy in Canva.")
    # 1 the logged-in app the narration names
    doc = sites.derive(ws, tools=TOOLS, ask=None)
    check([s["scout"] for s in doc["sites"]] == ["linearity"], f"Linearity picked, ChatGPT not: {doc}")
    check(doc["sites"][0]["url"] == "https://www.linearity.io/", f"landing page, not the register page: {doc['sites'][0]}")
    check(doc["sites"][0]["mentions"] == 2, "two mentions counted")
    # "chat gpt" spoken as two words still matches ChatGPT
    d2 = sites.derive(words_of("open chat gpt and ask it"), tools=TOOLS, ask=None)
    check([s["scout"] for s in d2["sites"]] == ["chatgpt"], f"two-word name matched: {d2}")
    # 2 public pages: named + reachable → kept; not named → skipped; behind a login → skipped
    asked = []

    def ask(text):
        asked.append(text)
        return {"tools": [{"name": "Canva", "url": "https://www.canva.com/", "why": "polish the copy"},
                          {"name": "Figma", "url": "https://www.figma.com/", "why": "never said"},
                          {"name": "Linearity", "url": "https://www.linearity.io/", "why": "dup"}]}, 0.02
    doc = sites.derive(ws, tools=TOOLS, ask=ask, check=lambda u: (True, u))
    urls = [s["url"] for s in doc["sites"]]
    check(urls == ["https://www.linearity.io/", "https://www.canva.com/"], f"public Canva added, Figma not named: {urls}")
    check(doc["sites"][1].get("public") and not doc["sites"][1].get("scout"), "Canva is public-only")
    check(abs(doc["usd"] - 0.02) < 1e-9 and "Linearity" in asked[0], "the narration was sent once, cost counted")
    doc = sites.derive(ws, tools=TOOLS, ask=ask, check=lambda u: (False, "redirects to login"))
    check([s["url"] for s in doc["sites"]] == ["https://www.linearity.io/"] and any("no public page" in w for w in doc["why"]),
          f"a page behind a login is skipped: {doc}")
    # a failing lookup never stops the factory
    doc = sites.derive(ws, tools=TOOLS, ask=lambda t: 1 / 0)
    check(len(doc["sites"]) == 1 and any("lookup failed" in w for w in doc["why"]), "lookup error → logged-in apps only")
    # 3 private apps are filtered out of the candidates
    check(sites.check_public("https://example.com/login")[0] is False, "login path is never public")
    check(sites.check_public("http://example.com/")[0] is False, "only https")
    check("gmail" in sites.PRIVATE_SLUGS, "gmail is private")
    # 4 nothing → no sites, and resolve() caches + logs it
    with tempfile.TemporaryDirectory() as td:
        lines = []
        orig = sites.scout_tools
        sites.scout_tools = lambda: TOOLS
        sites._ask_claude = lambda text: ({"tools": []}, 0.0)
        try:
            got, usd = sites.resolve(td, {"title": "x"}, {"words": words_of("hello and welcome back")}, log=lines.append)
            check(got == [] and any("A-roll + overlays only" in x for x in lines), f"no site → logged: {lines}")
            check(json.loads((Path(td) / "sites.json").read_text())["sites"] == [], "cached")
            got, _ = sites.resolve(td, {"sites": [{"url": "https://a.io/"}]}, {"words": []})
            check(got == [{"url": "https://a.io/"}], "request sites win")
        finally:
            sites.scout_tools = orig
    # 5 excerpt timeline
    flat = [{"i": k, "w": w["word"], "s": w["start"], "e": w["end"]} for k, w in enumerate(words_of(" ".join(["word"] * 50)))]
    by_id = {w["i"]: w for w in flat}
    v = edl.passthrough(flat, by_id, 20.0, 30.0, "T", excerpt=[[1.05, 4.1], [10.0, 12.0]])
    check(v["cuts"] == 1 and len(v["pieces"]) == 2, f"two ranges → two pieces: {v['cuts']}")
    a0, b0 = v["excerpt"][0]
    check(a0 <= 1.05 and not any(w["s"] < a0 < w["e"] or w["s"] < b0 < w["e"] for w in flat), f"edges in pauses: {v['excerpt']}")
    check(all(w["start"] >= 0 for w in v["words"]) and v["duration"] < 6.5, f"output words re-timed: {v['duration']}")
    full = edl.passthrough(flat, by_id, 20.0, 30.0, "T")
    check(full["cuts"] == 0 and "excerpt" not in full, "no excerpt → whole timeline")
    print(f"test_sites: {N} checks passed")


if __name__ == "__main__":
    main()
