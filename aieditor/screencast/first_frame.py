"""FIRST-FRAME GATE (gap list G3 #21/#25/#30/#32/#37/#39/#40; RULEBOOK §S S3/S4/S7, §1 C4/C5).

A screencast's frame 1 is the clean, loaded screen it is about to use (CUT05 r3 1:29.85 / r5 4:48.3,
128 reference entries checked: never a spinner, never a foreign page; refs open in Chat on a fresh
chat with the history sidebar collapsed — r5 6:01/6:31, kwysV2smgfY m04). The recorder checks the
set-dressed state TWICE before it starts a take:

  1. DOM facts (agent_rec.mjs {"cmd":"state"}): account name, h1 greeting, sidebar, composer draft,
     open popups / tooltips / suggestion lists, mean luminance, blank screen;
  2. PIXELS of the frame that will be frame 1 (this file, inside the screencast image: cv2 + tesseract):
     black / loading, Work mode, a greeting to another person, an open history sidebar, a suggestion list.

Any failure → the set-up is redone and nothing is recorded (agentrec.open_clean). verdict() is pure
(no cv2) so the rules are unit-tested on the host:

    python3 first_frame.py <frame.jpg> [--account Jake]   → {"ok": bool, "fail": [...], "facts": {...}}
"""
import json
import re
import subprocess
import sys

WORK_MODE = re.compile(r"what should we work on|work with chatgpt|see what work can do", re.I)
GREET = re.compile(r"\b(?:Hey|Hi|Hello|Welcome back|How can I help|Good (?:morning|afternoon|evening))[,!]?\s+"
                   r"([A-Z][a-z]{2,})\b")
POPUP = re.compile(r"recent chats|search chats|find emails i can unsubscribe|find the latest docs|"
                   r"summarize recent|prep me for my next|keep editing|discard changes|thinking effort|"
                   r"ask questions and explore ideas|see what work can do", re.I)
LOADING = re.compile(r"^\s*$")
SIDEBAR_WORDS = ("new chat", "scheduled", "library", "plugins", "explore", "projects", "recents")
SIDEBAR_LINES = 6            # ≥ 6 text lines in the left 3-20 % of the frame = the history sidebar is open
BRIGHT_MIN = 0.0015          # < 0.15 % of pixels brighter than lum 60 = a black / loading screen
DIM_MIN = 0.004              # < 0.4 % lit AND (almost) no readable words = a loading screen


def verdict(facts, account="Jake"):
    """facts: any of
         text           OCR / DOM text of the whole frame
         left_text      text of the left 22 % (sidebar zone)
         sidebar_lines  text lines counted in the sidebar zone (pixels)
         bright_share   share of pixels brighter than lum 60
         dom            {account, h1:[..], sidebar:bool, draft:str, popups:int, tooltips:int, blank:bool,
                         loading:bool, mode:"chat"|"work"|None, dark:bool}
       → (ok, [reasons])."""
    fail = []
    acc = (account or "").strip().lower()
    text = " ".join(str(facts.get("text") or "").split())
    left = " ".join(str(facts.get("left_text") or "").split()).lower()
    bs = facts.get("bright_share")
    words = re.findall(r"[A-Za-z]{3,}", text)
    if bs is not None and (bs < BRIGHT_MIN or (bs < DIM_MIN and len(words) < 3)):
        fail.append(f"black/loading screen ({bs:.4f} of pixels lit, {len(words)} words)")
    if WORK_MODE.search(text):
        fail.append(f"Work mode ('{WORK_MODE.search(text).group(0)}') — RULEBOOK S7: Chat mode from the start")
    for g in GREET.finditer(text):
        if acc and g.group(1).lower() != acc:
            fail.append(f"greeting to {g.group(1)}, not {account} (C4: only Jake's own account)")
    m = POPUP.search(text)
    if m:
        fail.append(f"popup / suggestion list on screen ('{m.group(0)}') — S3")
    n = facts.get("sidebar_lines")
    hits = [w for w in SIDEBAR_WORDS if w in left]
    if (n is not None and n >= SIDEBAR_LINES) or len(hits) >= 3:
        fail.append(f"history sidebar open ({n} text lines; {', '.join(hits)}) — S4/S7: hidden, never deleted")
    d = facts.get("dom") or {}
    if d:
        who = (d.get("account") or "").strip()
        if acc and who and who.lower() != acc:
            fail.append(f"account {who}, not {account} (C4)")
        if acc and not who and d.get("require_account", True):
            fail.append("account name not readable — cannot prove it is Jake's account")
        for h in d.get("h1") or []:
            if WORK_MODE.search(h):
                fail.append(f"Work mode h1 '{h}'")
            g = GREET.search(h)
            if g and acc and g.group(1).lower() != acc:
                fail.append(f"h1 greets {g.group(1)}, not {account}")
        if d.get("mode") == "work":
            fail.append("Work mode selected")
        if d.get("sidebar"):
            fail.append("history sidebar open (DOM)")
        if (d.get("draft") or "").strip():
            fail.append(f"composer not empty: {d['draft'][:60]!r} (C3)")
        if d.get("attachments"):
            fail.append(f"{d['attachments']} attachment(s) left in the composer (S3)")
        if d.get("popups"):
            fail.append(f"{d['popups']} popup/menu/suggestion list open (S3)")
        if d.get("tooltips"):
            fail.append(f"{d['tooltips']} tooltip(s) open (C5)")
        if d.get("blank") or d.get("loading"):
            fail.append("blank or loading screen (C5: frame 1 is the loaded screen)")
        if d.get("dark") is False:
            fail.append("light theme (S7: ChatGPT is recorded dark)")
        if d.get("wall"):
            fail.append(f"wall: {d['wall']}")
    # dedupe, keep order
    seen, out = set(), []
    for f in fail:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return not out, out


def account_of(start_state, default="Jake"):
    """The first name the frame must greet / show: the playbook start_state's account assert ('Jake Dawson')."""
    for a in (start_state or {}).get("asserts") or []:
        if a.get("kind") == "account" and a.get("value"):
            return str(a["value"]).split()[0]
    return default


def start_state_fails(facts, start_state):
    """The app playbook's start_state asserts (p2 schema) on the frame's DOM / OCR text and theme.
    Selector asserts are checked in the page by the recorder ({"cmd": "assert"}), not here."""
    fail = []
    d = facts.get("dom") or {}
    text = " ".join([str(facts.get("text") or ""), str(d.get("text") or ""), " ".join(d.get("h1") or [])])
    low = text.lower()
    for a in (start_state or {}).get("asserts") or []:
        k, v = a.get("kind"), str(a.get("value") or "")
        if k == "theme":
            dark = d.get("dark")
            if dark is not None and (dark is True) != (v == "dark"):
                fail.append(f"start state: theme is not {v}")
        elif k == "absent" and v and v.lower() in low:
            fail.append(f"start state: '{v}' is on screen ({a.get('why', '')})".rstrip(" ()"))
        elif k == "text" and v and not a.get("selector") and v.lower() not in low:
            fail.append(f"start state: '{v}' is not on screen")
        elif k == "account" and v and (d.get("account") or "") and str(d["account"]).split()[0].lower() != v.split()[0].lower():
            fail.append(f"start state: account {d['account']}, not {v}")
    return fail


def verdict_for(facts, start_state=None, account=None):
    """verdict() with the account from the playbook start_state + its asserts."""
    acc = account or account_of(start_state)
    ok, why = verdict(facts, acc)
    why = why + [f for f in start_state_fails(facts, start_state) if f not in why]
    return not why, why


# ───────────────────────── pixels (screencast image only) ─────────────────────────

def _ocr(g):
    import cv2
    if g.mean() < 110:
        g = 255 - g
    ok, png = cv2.imencode(".png", g)
    r = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "11", "-l", "eng"], input=png.tobytes(),
                       capture_output=True, timeout=120)
    return r.stdout.decode("utf-8", "replace")


def text_lines(col):
    """Count text lines in a 1-D 'row has bright pixels' profile (runs of ≥ 1 row, gaps ≥ 3 rows)."""
    n, run, gap = 0, False, 99
    for v in col:
        if v:
            if not run and gap >= 3:
                n += 1
            run, gap = True, 0
        else:
            run = False
            gap += 1
    return n


def facts_of(path):
    import cv2
    img = cv2.imread(str(path))
    if img is None:
        raise FileNotFoundError(path)
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = g.shape
    if w != 1280:
        g = cv2.resize(g, (1280, int(h * 1280 / w)), interpolation=cv2.INTER_AREA if w > 1280 else cv2.INTER_CUBIC)
        h, w = g.shape
    bright = float((g > 60).mean())
    # the sidebar zone: x 3-20 %, below the app header (y 8-95 %): rows that hold light text
    zone = g[int(0.08 * h):int(0.95 * h), int(0.03 * w):int(0.20 * w)]
    rows = [(r > 80).sum() >= 3 for r in zone]
    lines = text_lines(rows)
    big = cv2.resize(g, (1920, int(h * 1920 / w)), interpolation=cv2.INTER_CUBIC)
    text = _ocr(big)
    left = _ocr(big[:, : int(0.22 * big.shape[1])])
    return {"text": text, "left_text": left, "sidebar_lines": lines, "bright_share": round(bright, 5)}


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("frames", nargs="+")
    ap.add_argument("--account", default="Jake")
    a = ap.parse_args()
    out = {}
    for f in a.frames:
        fx = facts_of(f)
        ok, why = verdict(fx, a.account)
        out[f] = {"ok": ok, "fail": why, "facts": {k: (v if k not in ("text", "left_text") else " ".join(str(v).split())[:400])
                                                    for k, v in fx.items()}}
    json.dump(out if len(a.frames) > 1 else out[a.frames[0]], sys.stdout, indent=1)


if __name__ == "__main__":
    main()
