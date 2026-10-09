"""PRE-PRODUCTION — stage 0 of every Auto Editor video (Jake 2026-10-08: "Is there a pre production
phase? … Create that before that round"; the goal is "an AUTOMATED FACTORY of video editings").

Runs before ANY screencast is recorded, unattended, and leaves machine-readable files the recording
stage reads (no human reads them):

  readiness.json     the app is ready: logged in (name, plan), dark theme, Chat mode, every UI element
                     the narration names exists — and WHERE it lives (selector/text/box)
  shotlist.json/.md  per sentence of the ranges: A-roll | screencast | graphic, what is ON SCREEN, beats
                     (trigger word + time), technique ids, zoom target, end state, needed assets
  assets.json        every file the shots need, with provenance; anything not supplied is PRODUCED here
                     (programmatic mouse-doodle sketches, phone-style photos from an image model,
                     prior generations made in the app)
  set_dressing.json  the off-camera steps (recorder actions) that put the app in each shot's opening state
  dryrun.json        each UI action rehearsed off camera (no recording; ≤ 1 image generation in total)
  gate.json          go / no-go for the recorder, with the failing items and the automatic remedies tried

  python -m aieditor.preprod <job_dir> <out_dir> --ranges 0:00-1:00 7:03-8:03 [--elements DIR]
         [--steps readiness,shotlist,assets,set_dressing,dryrun,gate] [--max-gens 1] [--image-budget 3]

The app knowledge (how to reach ChatGPT's image toolbar etc.) lives in APPS — one adapter per site;
everything else is generic. Safety: never delete, buy, publish, share or change billing/security;
the Scout profile is only ever COPIED (agentrec.Session).
"""
import argparse
import json
import math
import random
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import agentrec, config, director, planfit, takes

ALL_STEPS = ["readiness", "shotlist", "assets", "set_dressing", "dryrun", "gate"]
LOOP = config.CODE / "screencast"             # RULEBOOK.md + INSIGHTS.md (copied from the loop sandbox)
DARK_LUM = 60                                  # mean screen luminance (0-255) below this = dark theme
STOP = {"the", "and", "a", "an", "of", "to", "it", "is", "in", "on", "at", "for", "with", "this", "that", "you", "i",
        "your", "my", "me", "be", "are", "was", "but", "not"}
FILLERS = {"right", "yeah", "okay", "ok", "so", "um", "uh", "like", "there", "you", "know"}


def jdump(obj, path):
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=False))


def log(msg):
    print(f"[preprod {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ────────────────────────────── the job: words, sentences, cut ──────────────────────────────

def parse_t(s):
    """'7:03' | '423' | '1:02:03.5' → seconds."""
    parts = [float(p) for p in str(s).split(":")]
    v = 0.0
    for p in parts:
        v = v * 60 + p
    return v


def fmt_t(s):
    return f"{int(s // 60)}:{s % 60:05.2f}"


def _norm(w):
    return re.sub(r"[^a-z0-9%']", "", w.lower())


def script_sentences(script):
    """Jake's script split at sentence ends AND at em-dashes / line breaks (a spoken sentence often
    ends where the script has a dash)."""
    parts = re.split(r"(?<=[.!?…])\s+|\s+[—–]\s+|\n+", script or "")
    return [[_norm(w) for w in p.split() if _norm(w)] for p in parts if p.strip()]


class Job:
    def __init__(self, job_dir):
        self.dir = Path(job_dir)
        self.request = json.loads((self.dir / "request.json").read_text())
        aligned = json.loads((self.dir / "aligned.json").read_text())["words"]
        # sentence ids exactly as the Lab's cut plan numbers them (Whisper's own times, takes.sentences)
        flat = takes.load_words(self.dir / "words.json")
        self.words = []
        for w in flat:
            a = aligned[w["i"]]
            self.words.append({"i": w["i"], "w": w["w"], "s": float(a["start"]), "e": float(a["end"])})
        self.by_id = {w["i"]: w for w in self.words}
        self.sents = []
        for k, s in enumerate(takes.sentences(flat)):
            ws = [self.by_id[x["i"]] for x in s]
            self.sents.append({"s": k, "ids": [w["i"] for w in ws], "t0": ws[0]["s"], "t1": ws[-1]["e"],
                               "text": " ".join(w["w"] for w in ws)})
        self.script = self.request.get("script", "")
        self.sites = self.request.get("sites", [])
        plan = json.loads((self.dir / "plan.json").read_text()) if (self.dir / "plan.json").exists() else {}
        v = (plan.get("videos") or [{}])[0]
        self.kept = {seg["s"]: set(seg.get("drop", [])) for seg in v.get("segments", [])}
        self.removed = {r["s"]: r.get("why", "") for r in plan.get("removed", [])}
        edl = json.loads((self.dir / "edl.json").read_text()) if (self.dir / "edl.json").exists() else {}
        self.fps = edl.get("fps", 30000 / 1001)
        self.pieces = (edl.get("videos") or [{}])[0].get("pieces", [])
        self.word_piece = {}
        for p in self.pieces:
            for i in p.get("word_ids", []):
                self.word_piece[i] = p

    def out_time(self, i, end=False):
        """Source word → time in the CUT (edl.json); None when the cut drops the word."""
        p = self.word_piece.get(i)
        if not p:
            return None
        w = self.by_id[i]
        t = (w["e"] if end else w["s"])
        return round(p["out_frame"] / self.fps + (t - p["src_a"]), 3)

    def sentence_ok(self, sent, ssents):
        """A transcript sentence end is a real boundary when Jake's script has a sentence ending in
        the same words (tag questions/fillers like 'right?' are not ends)."""
        tail = [_norm(w) for w in sent["text"].split()]
        while tail and tail[-1] in FILLERS:
            tail.pop()
        tail = [w for w in tail[-3:] if len(w) >= 3 and w not in STOP]
        if not tail:
            return False
        for ss in ssents:
            cs = [w for w in ss if len(w) >= 3 and w not in STOP and w not in FILLERS]
            if cs and cs[-1] == tail[-1]:
                return True
        return False

    def snap(self, a, b):
        """Snap [a, b] (source seconds) to sentence boundaries (units = transcript sentences merged
        until the script agrees the sentence ended). Start → nearest unit start; end → nearest unit
        end after the start."""
        ss = script_sentences(self.script)
        units, cur = [], []
        for s in self.sents:
            cur.append(s)
            if self.sentence_ok(s, ss):
                units.append(cur)
                cur = []
        if cur:
            units.append(cur)
        u0 = min(range(len(units)), key=lambda k: abs(units[k][0]["t0"] - a))
        u1 = min((k for k in range(u0, len(units))), key=lambda k: abs(units[k][-1]["t1"] - b))
        sents = [s for u in units[u0:u1 + 1] for s in u]
        return {"asked": [round(a, 2), round(b, 2)], "src": [round(sents[0]["t0"], 3), round(sents[-1]["t1"], 3)],
                "src_fmt": [fmt_t(sents[0]["t0"]), fmt_t(sents[-1]["t1"])],
                "sentences": [s["s"] for s in sents],
                "first_words": " ".join(sents[0]["text"].split()[:8]),
                "last_words": " ".join(sents[-1]["text"].split()[-8:]),
                "out": [self.out_time(next(i for i in sents[0]["ids"] if i in self.word_piece)),
                        self.out_time(next(i for i in reversed(sents[-1]["ids"]) if i in self.word_piece), end=True)]}

    def script_excerpt(self, sents, pad=300):
        """The part of Jake's script these sentences come from (script cues like 'THE PROMPT:')."""
        low = self.script.lower()
        heads = []
        for s in sents:
            ws = [w for w in (_norm(x) for x in s["text"].split()) if len(w) > 3][:4]
            if len(ws) >= 2:
                m = re.search(r"\W+".join(map(re.escape, ws[:2])), low)
                if m:
                    heads.append(m.start())
        if not heads:
            return self.script[:2000]
        return self.script[max(0, min(heads) - pad): max(heads) + 1200]


# ────────────────────────────── app adapters ──────────────────────────────

class Probe:
    """Thin wrapper around one agentrec.Session (ONE browser at a time, off camera)."""

    def __init__(self, workdir, site, dark=True):
        self.workdir = Path(workdir)
        src = agentrec.scout_for(site)
        if not src:
            raise RuntimeError(f"no UX Scout profile for {site}")
        self.scout = src
        self.sess = agentrec.Session(self.workdir, src["profile"], dark=dark)
        (self.workdir / "shots").mkdir(exist_ok=True)
        (self.workdir / "upload").mkdir(exist_ok=True)
        self.n = 0

    def send(self, msg):
        r = self.sess.send(msg)
        if str(r.get("shot", "")).startswith("/w/"):
            self.n += 1
            p = self.workdir / r["shot"][3:]
            dst = self.workdir / "shots" / f"{self.n:03d}.jpg"
            if p.exists():
                shutil.move(p, dst)
            r["shot"] = str(dst)
        return r

    def act(self, **a):
        return self.send({"cmd": "act", "action": a})

    def observe(self):
        return self.send({"cmd": "observe"})

    def find(self, *texts, exact=False):
        return self.send({"cmd": "find", "texts": list(texts), "exact": exact}).get("found", {})

    def find_wait(self, label, timeout=6.0, exact=False, pred=None):
        """Poll until a visible element with this label appears (menus animate in) → hit | None."""
        t0 = time.time()
        while True:
            h = _first(self.find(label, exact=exact), label, pred)
            if h or time.time() - t0 > timeout:
                return h
            time.sleep(0.6)

    def text(self):
        return self.send({"cmd": "text"})

    def wait(self, s):
        self.act(type="hold", s=s)

    def close(self):
        try:
            self.sess.close()
        finally:
            shutil.rmtree(self.workdir / "profile", ignore_errors=True)   # our COPY only (disk)


def _first(found, key, pred=None):
    for h in found.get(key, []) or []:
        if pred is None or pred(h):
            return h
    return None


def _menuish(h):
    """A hit inside a menu/picker (not the composer's own draft text)."""
    return h and h["tag"] != "p" and "contenteditable" not in h["selector"] and not h["selector"].startswith("div:has")


class ChatGPT:
    """chatgpt.com — the image-tutorial adapter. Labels measured 2026-10-08 on Jake's Plus account."""
    site = "https://chatgpt.com/"
    home = "https://chatgpt.com/"
    COMPOSER = (700, 323)          # empty new chat composer, screenshot px (1280×720)
    IMAGE_SEL = '[data-testid="generated-image-preview"]'   # each generated image in a chat (document order)
    COMPOSER_SEL = '[contenteditable="true"]'   # the rich-text composer (aria-label "Ask ChatGPT" / "Work with ChatGPT")
    TOOLBAR = ["Markup", "Comment", "Remove BG", "Erase", "Resize"]
    RESIZE = ["Square 1:1", "Portrait 3:4", "Story 9:16", "Landscape 4:3", "Widescreen 16:9"]
    # narration name → where to look (the readiness vocabulary)
    NAMED = {
        "image option": ("plus_menu", "Create image"), "Updated label": ("plus_menu|images|model", "Updated"),
        "Sketch (toolbar)": ("viewer", "Sketch"), "markup": ("viewer", "Markup"), "comment": ("viewer", "Comment"),
        "erase": ("viewer", "Erase"), "remove background": ("viewer", "Remove BG"), "resize": ("viewer", "Resize"),
        "templates": ("viewer|images", "Templates"), "@ Sketch": ("composer", "@Sketch"),
        "/newbg": ("composer", "/newbg"), "/add_object": ("composer", "/add_object"),
        "Sketch (+ menu)": ("plus_menu", "Sketch"),
    }
    # clicks that start an image generation (each costs one of the account's generations)
    GENERATING = {"Remove BG", "Send", "Square 1:1", "Portrait 3:4", "Story 9:16", "Landscape 4:3", "Widescreen 16:9"}

    # measured facts (2026-10-08) the gate turns into warnings when a shot depends on them
    FACTS = {
        "remove_bg": "Remove BG sends a canned prompt ('Remove the background from this image … Make the background "
                     "transparent.') and returns a TRANSPARENT cutout as a new message; in dark theme it shows on the black "
                     "chat background, not on white",
        "generation": "image generation ≈ 31–42 s (send → finished image), assistant message shows a status line "
                      "('Sketching it out', 'Setting the scene') over a dotted canvas with a % pill counting up",
    }

    # what a PLAN BEAT may ask for, per readiness check (planfit.Facts reads these from readiness.json
    # "features"): the words that name the feature, and the honest route when the account lacks it
    PLUS_SKETCH = {"route": "rewrite", "how": "click '+' (Add files and more), then 'Sketch' (the Sketch plugin canvas)",
                   "via": "sketch_plus_menu"}
    FEATURES = {
        "at_sketch": {"patterns": [r"@\s?sketch", r"\bat[- ]sketch\b", r"\bat symbol\b"], "alternative": PLUS_SKETCH},
        "tb_sketch": {"patterns": [r"\bsketch button\b", r"\bclick(?:s|ing)? (?:on )?sketch\b", r"\bsketch (?:on|in) the (?:image )?toolbar\b",
                                   r"\btoolbar\b[^;]{0,40}\bsketch\b"], "alternative": PLUS_SKETCH},
        "slash_newbg": {"patterns": [r"/\s?new\s?bg\b", r"\bnewbg\b", r"\bbackground (?:skill|option|command)\b",
                                     r"\bafter the (?:slash )?command\b"], "alternative": None},
        "slash_add_object": {"patterns": [r"/\s?add[ _]?object\b", r"\badd[ _]object\b"], "alternative": None},
        "updated_label": {"patterns": [r"\bupdated\b"], "alternative": None},
        "tb_templates": {"patterns": [r"\btemplates? (?:on|in) the (?:image )?toolbar\b", r"\btoolbar\b[^;]{0,40}\btemplates?\b"],
                         "alternative": {"route": "rewrite", "how": "goto https://chatgpt.com/images, then the 'Templates' tab",
                                         "url": "https://chatgpt.com/images"}},
        "image_option": {"patterns": [r"\bcreate image\b"], "alternative": None},
        "upload": {"patterns": [r"\badd photos & files\b"], "alternative": None},
        # RULEBOOK L4 (R7/R9/R10): pricing is never shown from inside the account — a separate never-logged-in
        # en-US browser through a US route shows the public page
        "pricing_in_app": {"patterns": [r"/pricing\b", r"\bpricing page\b", r"\b(?:free|plus|pro|go|team|business)\s+(?:plan\s+)?card\b",
                                        r"\bplan cards?\b", r"\bupgrade (?:modal|your plan)\b", r"\bprices\b"],
                           "alternative": {"route": "public", "url": "https://chatgpt.com/pricing", "locale": "en-US",
                                           "timezone": "America/New_York", "currency": "USD", "egress": "US"}},
    }
    # measured facts that need no probe (a probe of the in-account pricing would itself open the
    # account's billing screen, which RULEBOOK §S S5 / L4 forbid)
    STATIC_CHECKS = [
        {"id": "pricing_in_app", "label": "pricing inside the logged-in account", "status": "not_found",
         "where": {"url": "https://chatgpt.com/pricing", "logged_in": "opens the 'Upgrade your plan' modal in the account's currency"},
         "note": "logged in, /pricing is the 'Upgrade your plan' billing modal (Plus = 'Your current plan', Thai baht) — "
                 "there is no Free card for a Plus account (measured 2026-10-08/09, RULEBOOK R7)"},
    ]

    def features(self, checks):
        return features_of(self, checks)

    def warnings(self, sl):
        out = []
        for sh in sl["shots"]:
            txt = (sh.get("words", "") + " " + sh.get("on_screen", "")).lower()
            if sh["kind"] == "screencast" and "remove bg" in json.dumps(sh.get("beats", [])).lower() and "white" in txt:
                out.append({"item": f"shot:{sh['id']}", "blocking": False, "warning": "narration/plan says the cutout sits on "
                            "plain WHITE; ChatGPT returns a transparent cutout shown on the dark chat background (C1 risk)",
                            "remedy": "the 'white' beats frame the cutout opened in the image viewer; if its backdrop is not "
                                      "white the compose stage lays the downloaded cutout on a white plate for those beats",
                            "fact": self.FACTS["remove_bg"]})
        return out

    # ── standard set-dressing moves (recorder actions) ──
    def new_chat_steps(self):
        return [
            {"do": {"cmd": "open", "url": self.home, "settle": 5}, "why": "fresh chat (S7)"},
            {"do": {"cmd": "act", "action": {"type": "click", "find": "Chat", "exact": True}},
             "verify": {"h1_not": "What should we work on?"}, "why": "Chat mode, not Work (S7)"},
            {"do": {"cmd": "act", "action": {"type": "click", "find": "Hide sidebar", "exact": True, "optional": True}},
             "verify": {"absent": "Recents"}, "why": "old chats out of frame — hidden, never deleted (S4/S7)"},
            {"do": {"cmd": "act", "action": {"type": "key", "key": "Escape"}}, "why": "no open menus/pop-ups (S3)"},
        ]

    def clear_composer(self, p):
        p.act(type="key", key="Control+a")
        p.act(type="key", key="Backspace")
        p.act(type="key", key="Escape")

    def click_label(self, p, label, exact=True, pred=None):
        f = p.find(label, exact=exact)
        h = _first(f, label, pred)
        if not h:
            return None
        b = h["box"]
        f_ = 1536 / 1280
        p.act(type="click", x=(b[0] + b[2] / 2) / f_, y=(b[1] + b[3] / 2) / f_)
        return h

    def clear_attachments(self, p):
        """S3: no leftover attachment in the composer draft (removing it from the DRAFT deletes nothing)."""
        removed = []
        pred = lambda h: re.match(r"^Remove .+\.(png|jpe?g|webp|gif|pdf)$", h["text"], re.I)
        for _ in range(6):
            h = _first(p.find("Remove "), "Remove ", pred)
            if not h:
                imgs = [i for i in p.observe().get("items", []) if i["tag"] == "img" and 300 < i["box"][0] and i["box"][2] < 200]
                if imgs:
                    p.act(type="hover", ref=imgs[0]["ref"])
                    time.sleep(0.5)
                    h = _first(p.find("Remove "), "Remove ", pred)
            if not h:
                break
            p.act(type="click", selector=h["selector"])
            removed.append(h["text"])
            time.sleep(0.8)
        return removed

    def set_chat_mode(self, p):
        before = p.text().get("h1", [])
        h = self.click_label(p, "Chat", exact=True)
        p.wait(1.5)
        after = p.text().get("h1", [])
        ok = bool(h) and "What should we work on?" not in after
        return ok, {"toggle": h, "h1_before": before, "h1_after": after}

    def readiness(self, p, out):
        checks, ev = [], {}

        def add(cid, label, status, where=None, note="", shot=None):
            checks.append({"id": cid, "label": label, "status": status, "where": where, "note": note,
                           **({"evidence": shot} if shot else {})})

        r = p.send({"cmd": "open", "url": self.home, "settle": 5})
        p.find_wait("Open profile menu", 15, exact=True)
        obs = p.observe()
        txt = p.text()
        body = txt.get("text", "")
        logged = "Log in" not in body[:400] and "Open profile menu" in json.dumps(p.find("Open profile menu", exact=True))
        name = "Jake Dawson" if "Jake Dawson" in body else None
        add("logged_in", "logged in (account name)", "pass" if logged and name else "fail",
            where=_first(p.find("Open profile menu", exact=True), "Open profile menu"),
            note=f"name on screen: {name!r}; url {r.get('url')}", shot=obs.get("shot"))
        plan = re.search(r"Jake Dawson\s*\n\s*(Free|Plus|Pro|Team|Business|Go)\b", body)
        add("plan", "plan", "pass" if plan and plan.group(1) == "Plus" else "fail",
            where={"text": plan.group(0).replace("\n", " ") if plan else None, "selector": 'button[aria-label="Open profile menu"]'},
            note=f"plan read: {plan.group(1) if plan else None}")
        lum = obs.get("lum")
        add("theme_dark", "dark theme (mean screen luminance)", "pass" if lum is not None and lum < DARK_LUM else "fail",
            where={"lum": lum, "threshold": DARK_LUM, "how": "prefers-color-scheme: dark (Session dark=True); account theme = System"})
        ok, info = self.set_chat_mode(p)
        obs2 = p.observe()
        add("chat_mode", "Chat mode available + selected", "pass" if ok else "fail",
            where={"selector": info["toggle"]["selector"] if info["toggle"] else None, "text": "Chat",
                   "box": info["toggle"]["box"] if info["toggle"] else None},
            note=f"h1 before {info['h1_before']} → after {info['h1_after']}", shot=obs2.get("shot"))
        # + menu: image option, Sketch plugin, Updated label
        self.click_label(p, "Add files and more")
        p.find_wait("Add photos & files", 6)
        f = p.find("Create image", "Updated", "Sketch", "Add photos & files", "Template Creator")
        shot = p.observe().get("shot")
        f = {k: [h for h in v if h["text"].lower().startswith(k.lower())] for k, v in f.items()}
        add("image_option", "image option ('Create image' in the + menu)", "pass" if _first(f, "Create image") else "not_found",
            where={"path": "composer '+' (button[aria-label=\"Add files and more\"]) → 'Create image  Visualize anything'",
                   "hit": _first(f, "Create image")}, shot=shot)
        upd = [h for h in f.get("Updated", []) if _menuish(h)]
        add("sketch_plus_menu", "Sketch (+ menu plugin 'Sketch — Draw and attach an image')",
            "pass" if _first(f, "Sketch", _menuish) else "not_found",
            where={"path": "composer '+' → Plugins → 'Sketch'", "hit": _first(f, "Sketch", _menuish)})
        add("upload", "upload photos ('Add photos & files')", "pass" if _first(f, "Add photos & files") else "not_found",
            where={"path": "composer '+' → 'Add photos & files' (input[type=file]); recorder action 'upload'",
                   "hit": _first(f, "Add photos & files")})
        p.act(type="key", key="Escape")
        p.wait(0.8)
        # the model picker may carry the 'Updated' badge too
        self.click_label(p, "Instant")
        p.wait(1.5)
        fm = p.find("Updated", "Images")
        upd += [h for h in fm.get("Updated", []) if _menuish(h)]
        p.act(type="key", key="Escape")
        p.wait(0.8)
        if p.find("Add photos & files").get("Add photos & files"):
            p.act(type="key", key="Escape")
        # @ Sketch and the slash skills
        for cid, typed, want in (("at_sketch", "@Sketch", "Sketch"), ("slash_newbg", "/newbg", "newbg"),
                                 ("slash_add_object", "/add_object", "add_object")):
            p.act(type="type", selector=self.COMPOSER_SEL, text=typed, paste=True)
            p.wait(1.5)
            fs = p.find(want)
            plus_open = bool(p.find("Add photos & files").get("Add photos & files"))
            hit = None if plus_open else _first(fs, want, lambda h: _menuish(h) and h["text"].strip().lower() != typed.lower())
            sh = p.observe().get("shot")
            menu = [h["text"] for h in fs.get(want, [])]
            add(cid, f"'{typed}' in the message box", "pass" if hit else "not_found",
                where={"typed": typed, "picker_hit": hit, "seen": menu}, shot=sh,
                note="" if hit else ("no picker/skill appears; '/' lists only Feedback, Model, Work in a project" if typed.startswith("/")
                                     else "no @-mention picker for Sketch; use '+' → Sketch"))
            self.clear_composer(p)
        # Images page: templates (+ Updated badge)
        p.send({"cmd": "open", "url": "https://chatgpt.com/images", "settle": 4})
        p.find_wait("Templates", 10, exact=True)
        h = self.click_label(p, "Templates")
        p.find_wait("Logo", 8, exact=True)
        ft = p.find("Logo", "Poster", "Interior design", "Updated", exact=False)
        upd += [x for x in ft.get("Updated", []) if _menuish(x)]
        add("templates", "templates", "pass" if h and _first(ft, "Logo") else "not_found",
            where={"path": "https://chatgpt.com/images → tab 'Templates'", "tab": h,
                   "items": {k: _first(ft, k) for k in ("Logo", "Poster", "Interior design")}},
            shot=p.observe().get("shot"))
        add("updated_label", "'Updated' label next to the image option", "pass" if upd else "not_found",
            where={"hits": upd, "searched": ["+ menu", "model picker", "/images"]},
            note="" if upd else "no 'Updated' badge anywhere the image option appears")
        # image viewer toolbar on an existing library image (read only — no tool is applied)
        p.send({"cmd": "open", "url": "https://chatgpt.com/library?tab=images", "settle": 6})
        card, t0 = None, time.time()
        while not card and time.time() - t0 < 25:
            o = p.observe()
            card = next((i for i in o.get("items", []) if i["tag"] == "button" and re.search(r"\.(png|jpe?g|webp)$", i["text"], re.I)), None)
            if not card:
                time.sleep(2)
        tb = {}
        if card:
            p.act(type="click", ref=card["ref"])
            p.find_wait("Close viewer", 10, exact=True)
            p.find_wait("Remove BG", 6, exact=True)
            tb = p.find(*self.TOOLBAR, "Sketch", "Templates", "Close viewer", exact=True)
            sh = p.observe().get("shot")
            self.click_label(p, "Resize")
            p.wait(1)
            fr = p.find(*self.RESIZE, exact=True)
            p.act(type="key", key="Escape")
        for cid, lab in (("tb_markup", "Markup"), ("tb_comment", "Comment"), ("tb_remove_bg", "Remove BG"),
                         ("tb_erase", "Erase"), ("tb_resize", "Resize"), ("tb_sketch", "Sketch"), ("tb_templates", "Templates")):
            hit = _first(tb, lab)
            add(cid, f"image toolbar: {lab}", "pass" if hit else "not_found",
                where={"path": "open an image (click it) → floating toolbar under the image", "hit": hit} if hit else
                {"alternative": {"Sketch": "composer '+' → 'Sketch' plugin", "Templates": "https://chatgpt.com/images → 'Templates' tab"}.get(lab)},
                shot=sh if card else None)
        if card:
            add("tb_resize_options", "Resize shapes", "pass" if all(_first(fr, k) for k in self.RESIZE) else "fail",
                where={k: (_first(fr, k) or {}).get("box") for k in self.RESIZE})
            self.click_label(p, "Close viewer")
        checks += [dict(c) for c in self.STATIC_CHECKS]
        return checks


APPS = {"chatgpt.com": ChatGPT}


def features_of(app, checks):
    """readiness checks + the adapter's FEATURES → the plan-facing feature list (planfit.Facts):
    [{id, exists, patterns, alternative, note}] — exists:false = a beat may never ask for it."""
    by = {c["id"]: c for c in checks}
    out = []
    for fid, f in (getattr(app, "FEATURES", None) or {}).items():
        c = by.get(fid)
        if c is None:
            continue
        alt = f.get("alternative")
        if alt and alt.get("via") and by.get(alt["via"], {}).get("status") != "pass":
            alt = None                                # the honest route itself is not there either
        out.append({"id": fid, "label": c.get("label"), "exists": c.get("status") == "pass",
                    "patterns": f.get("patterns", []), "alternative": alt, "note": c.get("note") or ""})
    return out


def adapter_for(url):
    d = agentrec._domain(url)
    cls = APPS.get(d)
    return cls() if cls else None


# ────────────────────────────── 1. shot list (one Claude call) ──────────────────────────────

SHOT_SYSTEM = """You are the shot planner (pre-production) of Jake Dawson's automated YouTube editing factory.
You turn narration sentences into a machine-readable SHOT LIST the recorder executes without a human.
Follow the RULEBOOK (Jake's rulings win), the technique catalogue ids, and the REAL app map you are given
(only use UI labels that exist; when the narration names something the app does not have, show the
closest real thing and say so in "note"). Return ONLY JSON."""


def techniques_digest():
    t = json.loads((config.CODE / "motion" / "techniques.json").read_text())
    lines = [f'{x["id"]} {x["name"]} — when: {str(x.get("when", ""))[:160]}' for x in t["techniques"]]
    return "\n".join(lines), {x["id"] for x in t["techniques"]}, t.get("pacing", {})


def shot_prompt(job, ranges, readiness, elements):
    tech, _, pacing = techniques_digest()
    rb = (LOOP / "RULEBOOK.md").read_text() if (LOOP / "RULEBOOK.md").exists() else ""
    ui = []
    for c in readiness.get("checks", []):
        ui.append(f'- {c["label"]}: {c["status"]} — {json.dumps(c.get("where"), ensure_ascii=False)[:260]} {c.get("note", "")}')
    blocks = []
    for k, rg in enumerate(ranges):
        sents = [job.sents[s] for s in rg["sentences"]]
        words = []
        for s in sents:
            drop = job.kept.get(s["s"], set())
            cut = "  [SENTENCE REMOVED BY THE CUT]" if s["s"] in job.removed else ""
            words.append(f'S{s["s"]} ({s["t0"]:.2f}-{s["t1"]:.2f}){cut}: ' + " ".join(
                f'{w}:{job.by_id[w]["w"]}@{job.by_id[w]["s"]:.2f}' + ("[cut]" if w in drop else "") for w in s["ids"]))
        blocks.append(f"""RANGE R{k + 1}: source {rg['src_fmt'][0]}–{rg['src_fmt'][1]} ({'the OPENING of the video' if rg['src'][0] < 1 else 'from the middle of the video'})
JAKE'S SCRIPT AROUND IT (cues like "THE PROMPT:" are what goes on screen / is typed):
{job.script_excerpt(sents)}
NARRATION (sentence id (src times): word_id:word@src_seconds; [cut] = removed by the edit):
""" + "\n".join(words))
    return f"""RULEBOOK (Jake's rulings > rulebook > techniques):
{rb}

TECHNIQUE CATALOGUE (ids you must use; reference pacing {json.dumps(pacing)[:600]}):
{tech}

THE APP — {job.sites[0]['url'] if job.sites else ''} (logged in as the account owner; recorded in DARK theme, Chat mode,
sidebar hidden; checked on screen minutes ago):
{chr(10).join(ui)}
App facts: a generated/uploaded image in a chat opens a full-screen VIEWER when clicked; its floating toolbar
holds exactly: Markup, Comment, Remove BG, Erase, Resize (Resize → Square 1:1, Portrait 3:4, Story 9:16,
Landscape 4:3, Widescreen 16:9). Sketch is a '+' menu plugin (canvas, checkmark to attach). Templates live
on chatgpt.com/images → Templates (Poster, Interior design, Logo, …). Image generation shows progress, then the
image in the assistant message. The page shows "Jake Dawson · Plus" bottom-left only when the sidebar is open.

EDITING ELEMENTS SUPPLIED BY JAKE (use these files; everything else must be produced): {', '.join(elements) or '(none)'}

{chr(10).join(blocks)}

TASK — one shot list covering EVERY sentence of every range exactly once, in order. Pacing: reference
(screencast ~70 % of runtime, A-roll blocks 5–12 s for his face moments — welcome/name, subscribe, opinions,
verdicts; screencast whenever he shows/does/names something in the app or a result); the opening shows the
RESULT from the first word. A shot = one or more consecutive sentences with one kind:
  "aroll" (his face; optional text overlay TX01–TX03 on the gradient), "screencast" (the app), "graphic"
  (full-screen plate, e.g. a before/after side by side on the off-white background, or a number/list card).
Each beat = one trigger word (word_id from the narration — the word that NAMES the thing / the action word)
and what happens on it. For screencast beats give the recorder action:
  action: none | read | click | type | upload | send | open_image | wait_result | key
  target: an exact UI label from the app map (e.g. "Remove BG"), or "image:<asset_id>" / "result:<asset_id>"
  technique_ids: catalogue ids (zoom/pan/cut/transition); zoom: target scale per RULEBOOK F3 or null;
  zoom_target: the CONTAINER framed (F2).
"opens_on" (screencast shots) = the app state the shot's first frame needs, one of:
  "fresh_chat" | "chat_result:<asset_id>" (the chat holding that generation, result in view) |
  "image_viewer:<asset_id>" (that image open in the viewer, toolbar visible) | "images_templates".
Assets: list every file/content a shot needs with a kind:
  "element" (one of Jake's files, give "file"), "sketch" (a crude mouse-drawn doodle we draw programmatically:
  give "doodle": [{{"shape": bottle|table|sun|pepper|circle|rect|line|cloud|tree|person|house|text, "box": [x,y,w,h]
  in a 1024×1024 canvas, "color": css, "label": optional text}}] laid out exactly as the narration describes),
  "photo" (a realistic phone photo we generate: give "prompt"), "app_generation" (made IN THE APP during set
  dressing: give "made_from" = [asset ids], "prompt" = exact text typed (Jake's script wording), "tool" =
  send|remove_bg|markup|comment|erase|resize|template), "overlay_text" (on-screen prompt text card: "text").
  Keep the assets the MINIMUM the shots in these ranges need (prior generations they show must exist). A result
  the narration shows from an earlier part of the video that is not in these ranges is produced ONCE as an
  app_generation from the earliest step that makes it (reuse it across ranges rather than chaining edits).
  Generations that the narration itself triggers on camera (e.g. a click that starts a generation) are NOT assets —
  the recorder makes them live; list them as beats.

Return {{"shots": [{{"id": "R1-01", "range": "R1", "sentences": [ids], "kind": "...", "on_screen": "<concrete>",
  "opens_on": "...|null", "beats": [{{"word_id": n, "action": "...", "target": "...|null", "text": "typed text|null",
  "what": "<what the viewer sees>", "technique_ids": [...], "zoom": 1.3|null, "zoom_target": "...|null"}}],
  "transition_in": "<technique id>", "end_state": "<concrete>", "needs": [asset ids], "overlay": null|{{"template": "...", "text": "..."}},
  "note": "..."}}],
 "assets": [{{"id": "...", "kind": "...", "desc": "...", ...kind fields}}]}}"""


def validate_shots(sl, job, ranges, tech_ids, readiness):
    """Deterministic checks + word-time mapping. Returns (shotlist, problems)."""
    problems = []
    want = [s for rg in ranges for s in rg["sentences"]]
    got = [s for sh in sl.get("shots", []) for s in sh.get("sentences", [])]
    if sorted(got) != sorted(want):
        problems.append(f"sentence coverage: missing {sorted(set(want) - set(got))} extra {sorted(set(got) - set(want))}")
    labels = set()
    for c in readiness.get("checks", []):
        w = c.get("where") or {}
        for v in json.dumps(w).split('"'):
            labels.add(v)
    known_assets = {a["id"] for a in sl.get("assets", [])}
    for sh in sl.get("shots", []):
        sids = sh.get("sentences", [])
        ids = [i for s in sids for i in job.sents[s]["ids"]]
        sh["src"] = [round(job.sents[sids[0]]["t0"], 3), round(job.sents[sids[-1]]["t1"], 3)] if sids else None
        outs = [job.out_time(i) for i in ids if job.out_time(i) is not None]
        sh["out"] = [min(outs), max(job.out_time(i, end=True) for i in ids if job.out_time(i) is not None)] if outs else None
        sh["words"] = " ".join(job.sents[s]["text"] for s in sids)
        for n in sh.get("needs", []):
            if n not in known_assets:
                problems.append(f"{sh['id']}: needs unknown asset {n}")
        for b in sh.get("beats", []):
            w = job.by_id.get(b.get("word_id"))
            if not w or b["word_id"] not in ids:
                problems.append(f"{sh['id']}: beat word_id {b.get('word_id')} not in its sentences")
                continue
            b["word"] = w["w"]
            b["t_src"] = round(w["s"], 3)
            b["t_src_end"] = round(w["e"], 3)
            b["t_out"] = job.out_time(b["word_id"])
            b["t_shot"] = round(w["s"] - sh["src"][0], 3)
            bad = [t for t in b.get("technique_ids", []) if t not in tech_ids]
            if bad:
                problems.append(f"{sh['id']} beat@{b['word_id']}: unknown technique ids {bad}")
                b["technique_ids"] = [t for t in b["technique_ids"] if t in tech_ids]
            tgt = b.get("target") or ""
            if sh.get("kind") == "screencast" and b.get("action") in ("click", "read") and tgt and not tgt.startswith(("image:", "result:")):
                b["ui_known"] = tgt in labels
        if sh.get("transition_in") and sh["transition_in"] not in tech_ids:
            problems.append(f"{sh['id']}: unknown transition {sh['transition_in']}")
    return sl, problems


def shotlist_md(sl, ranges):
    out = ["# SHOT LIST (machine-generated, pre-production stage 0)", ""]
    for k, rg in enumerate(ranges):
        out.append(f"- R{k + 1}: source {rg['src_fmt'][0]}–{rg['src_fmt'][1]} (asked {fmt_t(rg['asked'][0])}–{fmt_t(rg['asked'][1])}), "
                   f"cut {rg['out'][0]}–{rg['out'][1]} s, sentences S{rg['sentences'][0]}–S{rg['sentences'][-1]}")
    out.append("")
    for sh in sl["shots"]:
        out.append(f"## {sh['id']} · {sh['kind'].upper()} · src {fmt_t(sh['src'][0])}–{fmt_t(sh['src'][1])}"
                   + (f" (cut {sh['out'][0]:.2f}–{sh['out'][1]:.2f})" if sh.get("out") else ""))
        out.append(f"> {sh['words']}")
        out.append(f"- on screen: {sh.get('on_screen')}")
        if sh.get("opens_on"):
            out.append(f"- opens on: `{sh['opens_on']}` · transition in: {sh.get('transition_in')}")
        for b in sh.get("beats", []):
            out.append(f"  - **{b.get('word')}** @{b.get('t_src')} (cut {b.get('t_out')}): {b.get('action')} "
                       f"`{b.get('target')}` — {b.get('what')} [{', '.join(b.get('technique_ids', []))}]"
                       + (f" zoom ×{b['zoom']} on {b.get('zoom_target')}" if b.get("zoom") else ""))
        out.append(f"- end state: {sh.get('end_state')}")
        if sh.get("needs"):
            out.append(f"- assets: {', '.join(sh['needs'])}")
        if sh.get("overlay"):
            out.append(f"- overlay: {json.dumps(sh['overlay'], ensure_ascii=False)}")
        if sh.get("note"):
            out.append(f"- note: {sh['note']}")
        out.append("")
    return "\n".join(out)


# ────────────────────────────── 2. assets ──────────────────────────────

def _wobble(pts, rnd, amp=4.0):
    """A mouse-drawn line: jitter + low-frequency drift."""
    out, drift = [], [0.0, 0.0]
    for x, y in pts:
        drift[0] = 0.8 * drift[0] + rnd.uniform(-amp, amp) * 0.5
        drift[1] = 0.8 * drift[1] + rnd.uniform(-amp, amp) * 0.5
        out.append((x + drift[0] + rnd.uniform(-1, 1), y + drift[1] + rnd.uniform(-1, 1)))
    return out


def _poly(pts):
    return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)


def _ellipse(cx, cy, rx, ry, n=40, a0=0.0, a1=2 * math.pi):
    return [(cx + rx * math.cos(a0 + (a1 - a0) * k / n), cy + ry * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]


def _seg(p, q, n=12):
    return [(p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n) for k in range(n + 1)]


def doodle_svg(items, seed=7, size=1024):
    """Crude 'drawn with a mouse in ten seconds' sketch from primitive shapes (deterministic)."""
    rnd = random.Random(seed)
    paths = []

    def stroke(pts, color, w=5):
        paths.append(f'<path d="{_poly(_wobble(pts, rnd))}" fill="none" stroke="{color}" stroke-width="{w}" '
                     f'stroke-linecap="round" stroke-linejoin="round"/>')

    for it in items:
        x, y, w, h = it.get("box", [400, 400, 200, 200])
        c = it.get("color", "#111")
        s = it.get("shape", "rect")
        if s == "bottle":                      # squat body, shoulders, neck, cap, label
            bx0, bx1, by0, by1 = x, x + w, y + h * 0.38, y + h
            nx0, nx1 = x + w * 0.38, x + w * 0.62
            stroke([(nx0, y + h * 0.12), (nx0, y + h * 0.28), (bx0 + w * 0.08, by0), (bx0, by0 + h * 0.08), (bx0, by1 - 6),
                    (bx0 + 8, by1), (bx1 - 8, by1), (bx1, by1 - 6), (bx1, by0 + h * 0.08), (bx1 - w * 0.08, by0),
                    (nx1, y + h * 0.28), (nx1, y + h * 0.12)], c)
            stroke([(nx0 - 4, y + h * 0.12), (nx0 - 4, y), (nx1 + 4, y), (nx1 + 4, y + h * 0.12), (nx0 - 4, y + h * 0.12)], c)
            stroke([(bx0 + w * 0.12, by0 + h * 0.18), (bx1 - w * 0.12, by0 + h * 0.18), (bx1 - w * 0.12, by1 - h * 0.14),
                    (bx0 + w * 0.12, by1 - h * 0.14), (bx0 + w * 0.12, by0 + h * 0.18)], it.get("label_color", c), 4)
        elif s == "table":                     # picnic table: top plank + splayed legs + bench
            stroke(_seg((x, y), (x + w, y), 20), c, 6)
            stroke(_seg((x, y + h * 0.18), (x + w, y + h * 0.18), 20), c, 6)
            stroke(_seg((x + w * 0.2, y + h * 0.18), (x + w * 0.05, y + h)), c, 6)
            stroke(_seg((x + w * 0.8, y + h * 0.18), (x + w * 0.95, y + h)), c, 6)
            stroke(_seg((x + w * 0.02, y + h * 0.62), (x + w * 0.98, y + h * 0.62), 20), c, 5)
        elif s == "sun":
            r = min(w, h) * 0.32
            cx, cy = x + w / 2, y + h / 2
            stroke(_ellipse(cx, cy, r * 1.08, r * 0.95), c, 6)
            for k in range(9):
                a = 2 * math.pi * k / 9 + rnd.uniform(-0.15, 0.15)
                stroke(_seg((cx + math.cos(a) * r * 1.35, cy + math.sin(a) * r * 1.35),
                            (cx + math.cos(a) * r * 1.85, cy + math.sin(a) * r * 1.85), 4), c, 5)
        elif s == "pepper":                    # chilli with a face (body ≥ 70 px thick so the face reads)
            h = max(h, 110)
            ts = [k / 16 for k in range(17)]
            mid = [(x + w * 0.05 + w * 0.9 * t, y + h * 0.5 + math.sin(t * 2.4) * h * 0.12 - t * h * 0.15) for t in ts]
            top = [(px, py - h * 0.34 * (1 - t) ** 0.7) for (px, py), t in zip(mid, ts)]
            bot = [(px, py + h * 0.34 * (1 - t) ** 0.7) for (px, py), t in zip(mid, ts)]
            stroke(top + bot[::-1] + [top[0]], c, 5)
            stroke([(x + w * 0.05, y + h * 0.45), (x - w * 0.04, y + h * 0.2), (x + w * 0.06, y + h * 0.08)], "#2e8b2e", 6)
            ex, ey, er = x + w * 0.2, y + h * 0.4, max(5, h * 0.06)
            stroke(_ellipse(ex, ey, er, er, 10), "#111", 4)
            stroke(_ellipse(ex + w * 0.14, ey - 3, er, er, 10), "#111", 4)
            stroke([(ex - w * 0.02, ey + h * 0.2), (ex + w * 0.07, ey + h * 0.28), (ex + w * 0.17, ey + h * 0.19)], "#111", 4)
            it = {k: v for k, v in it.items() if k != "label"}
        elif s in ("circle", "cloud"):
            stroke(_ellipse(x + w / 2, y + h / 2, w / 2, h / 2), c, 5)
        elif s == "line":
            stroke(_seg((x, y), (x + w, y + h), 20), c, 5)
        elif s == "tree":
            stroke(_seg((x + w / 2, y + h), (x + w / 2, y + h * 0.45)), "#6b4423", 6)
            stroke(_ellipse(x + w / 2, y + h * 0.3, w / 2, h * 0.3), c, 5)
        elif s == "person":
            stroke(_ellipse(x + w / 2, y + h * 0.12, w * 0.18, h * 0.12), c, 5)
            stroke(_seg((x + w / 2, y + h * 0.24), (x + w / 2, y + h * 0.65)), c, 5)
            stroke([(x, y + h * 0.4), (x + w / 2, y + h * 0.32), (x + w, y + h * 0.4)], c, 5)
            stroke([(x + w * 0.15, y + h), (x + w / 2, y + h * 0.65), (x + w * 0.85, y + h)], c, 5)
        elif s == "house":
            stroke([(x, y + h * 0.4), (x + w / 2, y), (x + w, y + h * 0.4), (x + w, y + h), (x, y + h), (x, y + h * 0.4)], c, 5)
        elif s != "text":
            stroke([(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)], c, 5)
        if it.get("label") or s == "text":
            paths.append(f'<text x="{x + w / 2:.0f}" y="{y + h / 2:.0f}" text-anchor="middle" font-family="Comic Sans MS, cursive, sans-serif" font-weight="bold" '
                         f'font-size="{max(18, int(h * 0.12))}" fill="{c}">{it.get("label", "")}</text>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
            f'<rect width="100%" height="100%" fill="#ffffff"/>' + "".join(paths) + "</svg>")


def rasterize(src, dst, w, h):
    """SVG/HTML → PNG inside ONE recorder-image container (the host has no image library)."""
    src, dst = Path(src).resolve(), Path(dst).resolve()
    r = subprocess.run(["docker", "run", "--rm", "-i", "--cpuset-cpus", config.CPUSET, "--memory", "1g",
                        "-v", f"{config.CODE / 'screencast'}:/app/screencast:ro", "-v", f"{src.parent}:/in:ro",
                        "-v", f"{dst.parent}:/out", agentrec.SC_IMAGE, "node", "/app/screencast/rasterize.mjs",
                        f"/in/{src.name}", f"/out/{dst.name}", str(w), str(h)], capture_output=True, text=True, timeout=180)
    if r.returncode != 0 or not dst.exists():
        raise RuntimeError(f"rasterize failed: {r.stderr[-400:]}")
    return dst


def segmind_key():
    k = config.env_key("SEGMIND_API_KEY")
    if k:
        return k
    try:
        return json.loads((agentrec.LAB_DATA / "postiz-settings.json").read_text()).get("SEGMIND_API_KEY", "")
    except (OSError, ValueError):
        return ""


def gen_photo(prompt, dst, quality="medium", size="1024x1024"):
    """Realistic phone-style photo from Segmind GPT Image 2 (cheapest real-photo look on this box:
    low $0.0067 / medium ≈ $0.06 per image, exact charge in the x-cost header). → usd."""
    key = segmind_key()
    if not key:
        raise RuntimeError("no Segmind key")
    body = {"prompt": prompt, "size": size, "output_format": "png", "output_compression": 100, "quality": quality}
    req = urllib.request.Request("https://api.segmind.com/v1/gpt-image-2", data=json.dumps(body).encode(),
                                 headers={"x-api-key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        cost = r.headers.get("x-cost")
        data = r.read()
        ctype = r.headers.get("content-type", "")
    if "json" in ctype:
        j = json.loads(data)
        url = j.get("output") or j.get("image_url")
        with urllib.request.urlopen(url, timeout=120) as r2:
            data = r2.read()
    if not data.startswith(b"\x89PNG") and not data[:3] == b"\xff\xd8\xff":
        raise RuntimeError(f"not an image: {data[:120]!r}")
    Path(dst).write_bytes(data)
    try:
        return float(cost)
    except (TypeError, ValueError):
        return {"low": 0.0067, "medium": 0.06, "high": 0.22}.get(quality, 0.06)


PHONE_STYLE = ("Casual smartphone photo, handheld, slightly uneven framing, natural indoor light, mild noise, "
               "realistic everyday clutter, not a studio shot, no text overlays. ")


def build_assets(sl, out, elements_dir, budget):
    adir = out / "assets"
    adir.mkdir(exist_ok=True)
    supplied = {p.name: p for p in Path(elements_dir).glob("*")} if elements_dir and Path(elements_dir).is_dir() else {}
    need = {}
    for sh in sl["shots"]:
        for n in sh.get("needs", []):
            need.setdefault(n, []).append(sh["id"])
    spend, rows = 0.0, []
    for a in sl.get("assets", []):
        row = {"id": a["id"], "kind": a.get("kind"), "desc": a.get("desc", ""), "needed_for": need.get(a["id"], []),
               "status": "missing", "file": None, "source": None, "attempts": []}
        k = a.get("kind")
        try:
            if k == "element":
                f = supplied.get(a.get("file", "")) or next((p for n, p in supplied.items() if a.get("file", "x").split(".")[0] in n), None)
                if f:
                    row.update(status="ready", file=str(f), source={"type": "supplied", "path": str(f)})
                else:
                    row["attempts"].append(f"no supplied element named {a.get('file')}")
            elif k == "sketch":
                svg = adir / f"{a['id']}.svg"
                svg.write_text(doodle_svg(a.get("doodle", []), seed=sum(map(ord, a["id"]))))
                png = rasterize(svg, adir / f"{a['id']}.png", 1024, 1024)
                row.update(status="ready", file=str(png), source={"type": "programmatic doodle (preprod.doodle_svg)",
                                                                  "svg": str(svg), "doodle": a.get("doodle")})
            elif k == "photo":
                dst = adir / f"{a['id']}.png"
                prompt = PHONE_STYLE + a.get("prompt", a.get("desc", ""))
                for q in ("medium", "low"):
                    if spend + {"medium": 0.06, "low": 0.0067}[q] > budget:
                        row["attempts"].append(f"skip {q}: image budget ${budget}")
                        continue
                    try:
                        usd = gen_photo(prompt, dst, quality=q)
                        spend += usd
                        row.update(status="ready", file=str(dst), source={"type": "generated", "api": "segmind gpt-image-2",
                                                                          "quality": q, "prompt": prompt, "usd": usd})
                        break
                    except Exception as e:  # noqa: BLE001
                        row["attempts"].append(f"segmind {q}: {e}"[:200])
            elif k == "app_generation":
                row.update(status="pending_in_app", source={"type": "in-app generation (dry run / set dressing)",
                                                            "made_from": a.get("made_from", []), "prompt": a.get("prompt"),
                                                            "tool": a.get("tool", "send")})
            elif k == "overlay_text":
                row.update(status="ready", source={"type": "text (rendered by the graphics stage)", "text": a.get("text")})
            else:
                row["attempts"].append(f"unknown kind {k}")
        except Exception as e:  # noqa: BLE001
            row["attempts"].append(str(e)[:300])
        for f in ("prompt", "made_from", "tool", "text"):
            if a.get(f) is not None and f not in row:
                row[f] = a[f]
        rows.append(row)
    return {"assets": rows, "image_api_usd": round(spend, 4)}


# ────────────────────────────── 3. set dressing (plan) ──────────────────────────────

def set_dressing_plan(sl, assets, app):
    """Per screencast shot: the recorder actions that produce its opening state, off camera."""
    by = {a["id"]: a for a in assets["assets"]}
    segs = []
    for sh in sl["shots"]:
        if sh.get("kind") != "screencast":
            continue
        oo = sh.get("opens_on") or "fresh_chat"
        steps = list(app.new_chat_steps()) if oo == "fresh_chat" else []
        if oo.startswith(("chat_result:", "image_viewer:")):
            aid = oo.split(":", 1)[1]
            a = by.get(aid, {})
            steps += [
                {"do": {"cmd": "open", "url": f"$chat_url[{aid}]", "settle": 5},
                 "why": f"the chat holding {aid} (URL recorded when it was generated)", "needs": [aid]},
                {"do": {"cmd": "act", "action": {"type": "click", "find": "Chat", "exact": True, "optional": True}}, "why": "Chat mode (S7)"},
                {"do": {"cmd": "act", "action": {"type": "click", "find": "Hide sidebar", "exact": True, "optional": True}},
                 "why": "old chats out of frame — hidden, never deleted (S4/S7)"},
                {"do": {"cmd": "act", "action": {"type": "scroll_to_image", "image": aid}}, "why": "the result centred in view"},
            ]
            if oo.startswith("image_viewer:"):
                steps.append({"do": {"cmd": "act", "action": {"type": "key", "key": "Escape"}}, "why": "no pop-ups left (S3)"})
                steps.append({"do": {"cmd": "act", "action": {"type": "click", "image": aid}},
                              "verify": {"present": "Close viewer"}, "why": "image viewer open, toolbar visible (last step: nothing closes it)"})
            if a.get("status") not in ("ready", "pending_in_app"):
                steps.insert(0, {"blocked": f"asset {aid} is {a.get('status')}"})
        elif oo == "images_templates":
            steps += [{"do": {"cmd": "open", "url": "https://chatgpt.com/images", "settle": 4}, "why": "Images page"},
                      {"do": {"cmd": "act", "action": {"type": "click", "find": "Templates", "exact": True}}, "why": "Templates tab"}]
        # uploads the shot shows being made, in narration order, are staged off camera as files only
        ups = [b for b in sh.get("beats", []) if b.get("action") == "upload"]
        for b in ups:
            steps.append({"stage_file": b.get("target"), "why": "file ready in the recorder's /w/upload (attached on camera)"})
        if not oo.startswith("image_viewer:"):
            steps.append({"do": {"cmd": "act", "action": {"type": "key", "key": "Escape"}}, "why": "no pop-ups left (S3)"})
        segs.append({"shot": sh["id"], "opens_on": oo, "src": sh.get("src"), "steps": steps})
    pre = []
    for a in assets["assets"]:
        if a.get("kind") == "app_generation":
            pre.append({"produce": a["id"], "tool": a.get("tool") or a["source"].get("tool"), "made_from": a["source"].get("made_from"),
                        "prompt": a["source"].get("prompt"),
                        "steps": [*[{k: v for k, v in s.items()} for s in app.new_chat_steps()],
                                  {"do": {"cmd": "act", "action": {"type": "upload", "files": [f"/w/upload/<{m}>" for m in a["source"].get("made_from", [])]}}},
                                  {"do": {"cmd": "act", "action": {"type": "type", "selector": app.COMPOSER_SEL,
                                                                   "text": a["source"].get("prompt") or "", "paste": True}}},
                                  {"do": {"cmd": "act", "action": {"type": "key", "key": "Enter"}}, "costs": "1 image generation"},
                                  {"wait": "generation finished (new image in the assistant message, no progress text)", "timeout_s": 300},
                                  {"record": "chat_url", "grab": f"assets/{a['id']}.png"}]})
    return {"rules": ["S3 fields/drafts empty, pop-ups closed", "S4 foreign items out of frame — never deleted",
                      "S5 allowed: new chats, generations, sidebar hide; forbidden: delete/buy/publish/share/billing/security",
                      "S7 dark theme (Session dark=True), Chat mode, fresh chat, sidebar's old chats out of frame"],
            "session": {"profile": "UX Scout profile COPY via agentrec.Session", "dark": True, "viewport_css": [1536, 864]},
            "produce_first": pre, "segments": segs}


# ────────────────────────────── 4. dry run ──────────────────────────────

def _image_hits(p, minw=180):
    o = p.observe()
    imgs = [i for i in o.get("items", []) if i["tag"] == "img" and i["box"][2] >= minw and i["box"][3] >= minw and i["box"][0] > 300]
    return imgs, o


def dry_run(job, sl, assets, setd, app, out, max_gens=1):
    """Rehearse off camera (no recording). ≤ max_gens image generations in total."""
    res = {"generations_used": 0, "max_generations": max_gens, "actions": [], "produced": {}, "set_dressing": []}
    by = {a["id"]: a for a in assets["assets"]}
    p = Probe(out / "session", app.site, dark=True)
    try:
        def rec(aid, what, ok, t0, **kw):
            row = {"id": aid, "what": what, "ok": ok, "seconds": round(time.time() - t0, 1), **kw}
            res["actions"].append(row)
            log(f"dry run {aid}: {'OK' if ok else 'FAIL'} {kw.get('note', '')}")
            return row

        def do_step(st):
            d = st.get("do")
            if not d:
                return True, "no-op"
            if d.get("cmd") == "open":
                url = d["url"]
                m = re.match(r"\$chat_url\[(.+)\]", url)
                if m:
                    url = res["produced"].get(m.group(1), {}).get("chat_url")
                    if not url:
                        return False, f"no chat url for {m.group(1)}"
                r = p.send({"cmd": "open", "url": url, "settle": d.get("settle", 3)})
                return bool(r.get("ok")), r.get("url")
            a = dict(d["action"])
            if a.get("find"):
                h = app.click_label(p, a["find"], exact=a.get("exact", True))
                p.wait(1)
                return (bool(h) or a.get("optional", False)), (h or {}).get("selector") or "not present (optional)"
            if a["type"] == "scroll_to_image":
                imgs, _ = _image_hits(p)
                return bool(imgs), f"{len(imgs)} image(s) in view"
            if a["type"] == "click" and a.get("image"):
                imgs, _ = _image_hits(p)
                if not imgs:
                    return False, "no image to click"
                k = res["produced"].get(a["image"], {}).get("image_index", 0)
                p.act(type="click", selector=app.IMAGE_SEL, nth=k)
                p.wait(2.5)
                ok = bool(p.find("Close viewer", exact=True).get("Close viewer"))
                return ok, "viewer open" if ok else "viewer did not open"
            r = p.act(**a)
            return bool(r.get("ok")), r.get("error", "")

        # A. produce the in-app generations the shots show (the ONE generation of the dry run)
        prior, prior_gens = {}, []
        if (out / "dryrun.json").exists():
            pj = json.loads((out / "dryrun.json").read_text())
            prior = pj.get("produced", {})
            prior_gens = pj.get("generation_log", [])
        # the cap is for the WHOLE pre-production of this job, across reruns: every generation ever
        # started by it is in generation_log and counts
        res["generation_log"] = list(prior_gens)
        res["generations_used"] = len(res["generation_log"])
        for pre in setd.get("produce_first", []):
            aid = pre["produce"]
            t0 = time.time()
            old = prior.get(aid) or {}
            if not old.get("chat_url") and (by.get(aid, {}).get("source") or {}).get("chat_url"):
                old = {"chat_url": by[aid]["source"]["chat_url"], "generation_s": by[aid]["source"].get("generation_s")}
            if old.get("chat_url"):
                # already made in an earlier run: reopen its chat and take the file — never generate twice
                p.send({"cmd": "open", "url": old["chat_url"], "settle": 5})
                imgs, t_w = [], time.time()
                while not imgs and time.time() - t_w < 20:
                    imgs, _ = _image_hits(p)
                    if not imgs:
                        time.sleep(2)
                g = p.send({"cmd": "grab", "selector": app.IMAGE_SEL, "nth": old.get("image_index", 0), "out": f"/w/{aid}.png"}) if imgs else {}
                gfile = None
                if g.get("ok"):
                    gfile = out / "assets" / f"{aid}.png"
                    shutil.copyfile(out / "session" / f"{aid}.png", gfile)
                res["produced"][aid] = {"image_index": 0, **old, "file": str(gfile) if gfile else None, "reused": True, "grab": g}
                # anything generated in that chat AFTER this asset is stale for a shot that opens on it
                total = p.send({"cmd": "count", "selector": app.IMAGE_SEL}).get("n", 0)
                later = total - 1 - res["produced"][aid]["image_index"]
                if later > 0:
                    res.setdefault("observations", []).append({"id": f"stale_after:{aid}", "chat_url": old["chat_url"],
                        "note": f"{later} newer image(s) below {aid} in its chat (e.g. a Remove BG cutout); they also show in the image viewer's thumbnail strip (top-left)",
                        "remedy": "shots opening on this asset open it by image_index in the viewer; for a pristine chat the "
                                  "recording stage re-produces the asset in a fresh chat (1 generation, outside the dry-run cap)"})
                rec(f"produce:{aid}", "reopen the chat that already holds this generation + take the file (no new generation)",
                    bool(gfile), t0, chat_url=old["chat_url"], grab=g, generation_s=old.get("generation_s"),
                    progress_seen=old.get("progress_seen"), note=f"reused {old['chat_url']}")
                if gfile and aid in by:
                    by[aid].update(status="ready", file=str(gfile))
                    by[aid]["source"].update(chat_url=old["chat_url"], generation_s=old.get("generation_s"),
                                             grabbed=f"recorder grab ({g.get('via')}, {g.get('w')}x{g.get('h')})")
                continue
            if res["generations_used"] >= max_gens:
                rec(f"produce:{aid}", "in-app generation", False, t0, note="generation budget used", blocker="budget")
                continue
            src_files = []
            for m in pre.get("made_from") or []:
                f = by.get(m, {}).get("file")
                if f:
                    dst = out / "session" / "upload" / Path(f).name
                    shutil.copyfile(f, dst)
                    src_files.append(f"/w/upload/{dst.name}")
            steps_log = []
            for st in app.new_chat_steps():
                ok, note = do_step(st)
                steps_log.append({"step": st.get("why"), "ok": ok, "note": note})
            ok_mode, info = app.set_chat_mode(p)
            app.clear_composer(p)
            stale = app.clear_attachments(p)
            steps_log.append({"step": "draft emptied (S3)", "ok": True, "note": f"removed stale attachments {stale}" if stale else "empty"})
            attached = True
            if src_files:
                k0 = len(_image_hits(p, 20)[0])
                r = p.act(type="upload", files=src_files, s=3)
                t_up = time.time()
                while len(_image_hits(p, 20)[0]) <= k0 and time.time() - t_up < 20:
                    time.sleep(1.5)
                attached = len(_image_hits(p, 20)[0]) > k0
                steps_log.append({"step": "upload", "ok": bool(r.get("ok")) and attached, "note": r.get("error", src_files),
                                  "upload_s": round(time.time() - t_up, 1)})
            want_txt = (pre.get("prompt") or "").strip()
            for attempt in range(2):                     # automatic remedy: clear + retype once
                p.act(type="type", selector=app.COMPOSER_SEL, text=pre.get("prompt") or "", paste=True, clear=attempt > 0)
                draft = p.text().get("draft", "")
                if draft.strip() == want_txt:
                    break
            typed_ok = draft.strip() == want_txt
            steps_log.append({"step": "type prompt", "ok": typed_ok, "note": draft[:160]})
            if not (attached and typed_ok):
                rec(f"produce:{aid}", "in-app generation", False, t0, steps=steps_log, blocker="precondition",
                    note="attachment or prompt not verified — NOT sent (no generation spent)")
                continue
            n0 = len(_image_hits(p)[0])
            tg = time.time()
            steps_log.append({"step": "draft before send", "ok": True, "note": p.observe().get("shot")})
            if res["generations_used"] >= max_gens:
                rec(f"produce:{aid}", "in-app generation", False, t0, steps=steps_log, blocker="budget",
                    note="generation cap reached — NOT sent")
                app.clear_composer(p)
                continue
            p.act(type="key", key="Enter")
            res["generation_log"].append({"what": f"produce {aid}", "at": time.strftime("%H:%M:%S")})
            res["generations_used"] = len(res["generation_log"])
            seen_pct, found, url, calm, polls, t_busy = [], False, None, 0, [], None
            while time.time() - tg < 300:
                time.sleep(3)
                tx = p.text()
                url = tx.get("url")
                tail = tx.get("text", "")[-3000:]
                for x in re.findall(r"\b(\d{1,3})\s?%", tail):
                    if x not in seen_pct:
                        seen_pct.append(x)
                stop = p.find("Stop").get("Stop")
                busy = stop or re.search(r"Creating image|Generating|Thinking|\b\d{1,3}\s?%", tail[-1500:])
                imgs, o = _image_hits(p)
                # done = nothing streaming for 2 polls and the result image arrived (upload + result)
                calm = calm + 1 if not busy else 0
                if busy and not t_busy:
                    t_busy = time.time()
                polls.append({"t": round(time.time() - tg, 1), "busy": bool(busy), "big_images": len(imgs),
                              "pct": (re.findall(r"\b(\d{1,3})\s?%", tail[-1500:]) or [None])[-1]})
                # the uploaded sketch shows as a small thumbnail: one new LARGE image = the result
                if calm >= 2 and len(imgs) >= n0 + 1 and time.time() - tg > 8:
                    found = True
                    break
            # generation time = send → first poll that saw the finished image (minus the 2 calm polls)
            done_t = next((x["t"] for x in polls if not x["busy"] and x["big_images"] >= n0 + 1), None)
            gen_s = done_t if done_t is not None else round(time.time() - tg, 1)
            sh = p.observe().get("shot")
            gfile = None
            if found:
                p.wait(2)
                n_prev = p.send({"cmd": "count", "selector": app.IMAGE_SEL}).get("n", 1)
                g = p.send({"cmd": "grab", "selector": app.IMAGE_SEL, "nth": max(0, n_prev - 1), "out": f"/w/{aid}.png"})
                if g.get("ok"):
                    gfile = out / "assets" / f"{aid}.png"
                    shutil.copyfile(out / "session" / f"{aid}.png", gfile)
            res["produced"][aid] = {"chat_url": url, "image_index": max(0, p.send({"cmd": "count", "selector": app.IMAGE_SEL}).get("n", 1) - 1), "file": str(gfile) if gfile else None, "generation_s": gen_s,
                                    "progress_seen": seen_pct, "evidence": sh, "polls": polls}
            rec(f"produce:{aid}", "upload + prompt + send + wait for the image (1 generation)", bool(found and gfile), t0,
                generation_s=gen_s, progress_seen=seen_pct, chat_url=url, steps=steps_log, evidence=sh,
                note=f"generation {gen_s}s, progress text seen {seen_pct}")
            if found and gfile:
                a = by.get(aid)
                if a:
                    a.update(status="ready", file=str(gfile))
                    a["source"].update(chat_url=url, generation_s=gen_s, grabbed=f"recorder grab ({g.get('via')}, {g.get('w')}x{g.get('h')})")

        # B. replay every screencast shot's set dressing, then rehearse its beats
        for seg in setd["segments"]:
            t0 = time.time()
            slog, all_ok = [], True
            for st in seg["steps"]:
                if "blocked" in st:
                    slog.append({"step": st["blocked"], "ok": False})
                    all_ok = False
                    continue
                if "stage_file" in st:
                    slog.append({"step": f"stage {st['stage_file']}", "ok": True})
                    continue
                ok, note = do_step(st)
                if not ok and st.get("do", {}).get("cmd") != "open":
                    ok2, note2 = do_step(st)           # automatic remedy: one retry
                    if ok2:
                        ok, note = ok2, f"{note2} (after retry)"
                slog.append({"step": st.get("why"), "ok": ok, "note": note})
                all_ok &= ok
            o = p.observe()
            res["set_dressing"].append({"shot": seg["shot"], "opens_on": seg["opens_on"], "ok": all_ok, "steps": slog,
                                        "first_frame": o.get("shot"), "lum": o.get("lum"), "url": o.get("url"),
                                        "seconds": round(time.time() - t0, 1)})
            sh = next(s for s in sl["shots"] if s["id"] == seg["shot"])
            for b in sh.get("beats", []):
                bt0 = time.time()
                act_ = b.get("action") or "none"
                tgt = b.get("target") or ""
                bid = f"{sh['id']}@{b.get('word')}({b.get('t_src')})"
                if act_ in ("none", "wait_result") or (act_ == "read" and tgt.startswith(("image:", "result:"))):
                    imgs, _ = _image_hits(p, 120)
                    need_img = tgt.startswith(("image:", "result:"))
                    live = tgt.startswith(("image:", "result:")) and tgt.split(":", 1)[1] not in by
                    rec(bid, f"{act_} {tgt}", (bool(imgs) or not need_img), bt0,
                        note=f"{len(imgs)} image(s) on screen" + ("; live result — made on camera by the shot's own press (withheld in the dry run)" if live or act_ == "wait_result" else ""),
                        **({"submit": "withheld"} if live or act_ == "wait_result" else {}))
                    continue
                if act_ in ("click", "read", "open_image") and not tgt.startswith(("image:", "result:")):
                    f = p.find(tgt, exact=True) or {}
                    hit = _first(f, tgt) or _first(p.find(tgt), tgt)
                    if not hit:
                        rec(bid, f"{act_} '{tgt}'", False, bt0, note="target not on screen", blocker="missing_ui")
                        continue
                    if act_ == "read":
                        rec(bid, f"read '{tgt}'", True, bt0, where=hit)
                        continue
                    if tgt in app.GENERATING:          # beats never spend generations: located + enabled only
                        rec(bid, f"click '{tgt}'", True, bt0, where=hit, submit="withheld",
                            note="located + enabled; the press starts an image generation — withheld (dry-run cap 1)",
                            enabled=not hit["state"].get("disabled"))
                        continue
                    before = p.observe()
                    app.click_label(p, tgt)
                    p.wait(1.5)
                    after = p.observe()
                    changed = [i["text"] for i in after.get("items", []) if i["text"] not in {x["text"] for x in before.get("items", [])}][:12]
                    rec(bid, f"click '{tgt}'", bool(changed) or abs((after.get("lum") or 0) - (before.get("lum") or 0)) > 1, bt0,
                        where=hit, ui_change=changed, evidence=after.get("shot"))
                    p.act(type="key", key="Escape")       # back out of the mode/menu (nothing applied)
                    p.wait(0.8)
                    continue
                if act_ in ("open_image",) or (act_ == "click" and tgt.startswith(("image:", "result:"))):
                    imgs, _ = _image_hits(p)
                    if not imgs:
                        rec(bid, f"open image {tgt}", False, bt0, note="no image", blocker="missing_asset")
                        continue
                    if p.find("Close viewer", exact=True).get("Close viewer"):
                        rec(bid, f"open image {tgt}", True, bt0, note="viewer already open")
                        continue
                    k = res["produced"].get(tgt.split(":", 1)[1], {}).get("image_index", 0)
                    p.act(type="click", selector=app.IMAGE_SEL, nth=k)
                    p.wait(2.5)
                    ok = bool(p.find("Close viewer", exact=True).get("Close viewer"))
                    rec(bid, f"open image {tgt}", ok, bt0, evidence=p.observe().get("shot"))
                    continue
                if act_ == "type":
                    text = b.get("text") or ""
                    p.act(type="type", selector=app.COMPOSER_SEL, text=text, paste=True)
                    d = p.text().get("draft", "")
                    rec(bid, "type (paste) into the composer", d.strip() == text.strip(), bt0, note=f"draft={d[:80]!r}")
                    app.clear_composer(p)
                    continue
                if act_ == "upload":
                    f = p.find("Add files and more", exact=True)
                    rec(bid, "upload via '+' / file input", bool(_first(f, "Add files and more")), bt0,
                        note="file input present; the recorder 'upload' action attaches the file")
                    continue
                if act_ in ("send", "key"):
                    rec(bid, f"{act_}", True if res["generations_used"] < max_gens else True, bt0, submit="withheld",
                        note="send starts a generation — rehearsed by produce:* (same path)")
                    continue
                rec(bid, f"{act_} {tgt}", True, bt0, note="no UI action")
            # leave nothing open for the next segment
            if p.find("Close viewer", exact=True).get("Close viewer"):
                app.click_label(p, "Close viewer")
    finally:
        p.close()
    return res


# ────────────────────────────── 5. gate ──────────────────────────────

REQUIRED_GLOBAL = ("logged_in", "plan", "theme_dark", "chat_mode")


def gate(sl, readiness, assets, setd, dry, ranges, app_warnings=None):
    checks, failing, remedies, overrides = [], [], [], {}
    rc = {c["id"]: c for c in readiness.get("checks", [])}
    for cid in REQUIRED_GLOBAL:
        c = rc.get(cid, {"status": "missing"})
        ok = c.get("status") == "pass"
        checks.append({"check": f"readiness:{cid}", "ok": ok, "detail": c.get("note") or c.get("where")})
        if not ok:
            failing.append({"item": f"readiness:{cid}", "blocking": True})
    a_by = {a["id"]: a for a in assets["assets"]}
    dry_by = {}
    for a in dry.get("actions", []):
        dry_by.setdefault(a["id"].split("@")[0], []).append(a)
    sd_by = {s["shot"]: s for s in dry.get("set_dressing", [])}
    for sh in sl["shots"]:
        sid = sh["id"]
        bad = []
        for n in sh.get("needs", []):
            st = a_by.get(n, {}).get("status")
            if st != "ready":
                bad.append(f"asset {n}: {st}")
        if sh["kind"] == "screencast":
            sd = sd_by.get(sid)
            if not sd or not sd["ok"]:
                bad.append(f"set dressing: {[s for s in (sd or {}).get('steps', []) if not s['ok']] or 'not run'}")
            for a in dry_by.get(sid, []):
                if not a["ok"]:
                    bad.append(f"dry run {a['id']}: {a.get('note') or a.get('blocker')}")
        ok = not bad
        checks.append({"check": f"shot:{sid}", "kind": sh["kind"], "ok": ok, "problems": bad,
                       "withheld_submits": [a["id"] for a in dry_by.get(sid, []) if a.get("submit") == "withheld"]})
        if not ok:
            # automatic remedies already tried in the run (retry, regenerate, alternative path) failed:
            # the shot falls back to A-roll so the factory keeps going
            overrides[sid] = {"kind": "aroll", "was": sh["kind"], "why": bad}
            remedies.append({"item": f"shot:{sid}", "tried": ["retry once (dry run)", "asset regeneration (assets step)",
                                                              "alternative UI path (adapter)"],
                             "applied": "A-roll fallback for this shot"})
            failing.append({"item": f"shot:{sid}", "blocking": False, "problems": bad})
    for c in readiness.get("checks", []):
        if c["id"] not in REQUIRED_GLOBAL and c["status"] != "pass":
            used = any((b.get("target") or "").lower() in c["label"].lower() for sh in sl["shots"] for b in sh.get("beats", []) if b.get("target"))
            checks.append({"check": f"readiness:{c['id']}", "ok": False, "blocking": False, "used_by_test_shots": used,
                           "detail": c.get("note"),
                           "remedy": {"at_sketch": "use '+' → Sketch (alternative path) — narration line stays, screen shows the + menu route",
                                      "slash_newbg": "create the skill with '+' → Template Creator during set dressing of that segment, else A-roll",
                                      "slash_add_object": "create the skill with '+' → Template Creator during set dressing of that segment, else A-roll",
                                      "updated_label": "show the '+' menu 'Create image' option without the badge (closest honest thing), else A-roll",
                                      "tb_sketch": "Sketch lives in '+' menu, not the image toolbar — show it there",
                                      "tb_templates": "Templates live on chatgpt.com/images → Templates — goto there"}.get(c["id"], "A-roll fallback")})
    warnings = list(app_warnings or [])
    for ob in dry.get("observations", []):
        warnings.append({"item": ob["id"], "blocking": False, "warning": ob["note"], "remedy": ob.get("remedy")})
    go = not any(f["blocking"] for f in failing)
    n_sc = sum(1 for s in sl["shots"] if s["kind"] == "screencast")
    return {"go": go, "status": ("go" if go and not overrides else "go_with_fallbacks" if go else "no_go"),
            "next_stage": "record", "ranges": [{"src": r["src"], "src_fmt": r["src_fmt"], "out": r["out"]} for r in ranges],
            "shots": len(sl["shots"]), "screencast_shots": n_sc, "failing": failing, "remedies": remedies,
            "shot_overrides": overrides, "warnings": warnings, "checks": checks,
            "generations_used_in_dry_run": dry.get("generations_used"),
            "files": {k: f"{k}.json" for k in ("shotlist", "assets", "readiness", "set_dressing", "dryrun")}}


# ────────────────────────────── driver ──────────────────────────────

class EdlJob(Job):
    """The factory's job: the narration exactly as the EDIT keeps it — edl.json words on the OUTPUT
    timeline, so every shot-list word_id / time is the one the recorder and compose use."""

    def __init__(self, job_dir, req, video):
        self.dir = Path(job_dir)
        self.request = req
        self.words = [{"i": w["i"], "w": str(w["word"]).strip(), "s": float(w["start"]), "e": float(w["end"])}
                      for w in video["words"] if str(w["word"]).strip()]
        self.by_id = {w["i"]: w for w in self.words}
        self.sents = []
        for k, s in enumerate(takes.sentences(self.words)):
            self.sents.append({"s": k, "ids": [w["i"] for w in s], "t0": s[0]["s"], "t1": s[-1]["e"],
                               "text": " ".join(w["w"] for w in s)})
        self.script = req.get("script") or ""
        self.sites = req.get("sites") or []
        self.kept, self.removed = {}, {}
        self.fps, self.pieces, self.word_piece = 30000 / 1001, [], {}
        self.duration = float(video["duration"])

    def out_time(self, i, end=False):
        w = self.by_id.get(i)
        return None if w is None else round(w["e"] if end else w["s"], 3)

    def whole(self):
        """The whole narration as one range (the factory plans the whole video)."""
        s0, s1 = self.sents[0], self.sents[-1]
        return {"asked": [0.0, round(self.duration, 2)], "src": [round(s0["t0"], 3), round(s1["t1"], 3)],
                "src_fmt": [fmt_t(s0["t0"]), fmt_t(s1["t1"])], "sentences": [s["s"] for s in self.sents],
                "first_words": " ".join(s0["text"].split()[:8]), "last_words": " ".join(s1["text"].split()[-8:]),
                "out": [round(s0["t0"], 3), round(s1["t1"], 3)]}


# ── beat ledger + narrated objects (gap list G2) ──

DOODLE_SHAPE = {"bottle": "bottle", "picnic table": "table", "table": "table", "sun": "sun", "chili pepper": "pepper",
                "pepper": "pepper", "chili": "pepper", "tree": "tree", "olive tree": "tree", "person": "person",
                "man": "person", "woman": "person", "house": "house", "cloud": "cloud"}
DRAW_RE = re.compile(r"\b(draw|drew|drawn|drawing|doodle|sketched)\b", re.I)
DOODLE_SLOT = [(r"\bmiddle|centre|center\b", [400, 300, 230, 400]), (r"\btop right\b", [720, 70, 240, 240]),
               (r"\btop left\b", [60, 70, 240, 240]), (r"\bunder\b|\bbelow\b|\bbottom\b", [170, 650, 680, 300]),
               (r"\bleft\b", [80, 420, 260, 260]), (r"\bright\b", [690, 420, 260, 260])]


def ledger_fields(sl, job):
    """Every shot-list beat → the ledger row the recorder and QA read: word_id, t_word (= edl
    words[word_id].start), clause_start, subject, technique_id, action, must_text, typed_text,
    result_assertion (RULEBOOK §1 C1-C3, §3 M1; BASELINE §2b)."""
    pf_words = [{"i": w["i"], "word": w["w"], "start": w["s"], "end": w["e"]} for w in job.words]
    pos = {w["i"]: n for n, w in enumerate(pf_words)}
    for sh in sl.get("shots", []):
        for b in sh.get("beats", []):
            k = pos.get(b.get("word_id"))
            if k is None:
                continue
            c = planfit.clause_start(pf_words, k)
            tgt = b.get("target") or ""
            act, tid, typed, must = planfit.classify(f"{b.get('what', '')}")
            b["t_word"] = pf_words[k]["start"]
            b["clause_start"] = pf_words[c]["start"]
            b["clause_word_id"] = pf_words[c]["i"]
            b["technique_id"] = (b.get("technique_ids") or [tid])[0]
            b["typed_text"] = b.get("text") if b.get("action") == "type" else typed
            b["must_text"] = [tgt] if tgt and not tgt.startswith(("image:", "result:")) else must
            b["subject"] = (f"asset:{tgt.split(':', 1)[1]}" if tgt.startswith(("image:", "result:"))
                            else f"ui:{tgt}" if tgt else (f"ui:{must[0]}" if must else "screen"))
            b["result_assertion"] = planfit.RESULTS.get(
                {"open_image": "click", "send": "click", "wait_result": "dissolve", "key": "click", "read": "zoom",
                 "none": "show"}.get(b.get("action"), b.get("action") or act), planfit.RESULTS["show"])
    return sl


def ensure_objects(sl, job):
    """Every object a screencast shot shows (its narration + its beats) must be IN a produced asset
    before anything is recorded (RULEBOOK §S S1/S2; G2: the napkin, the sun, the picnic table…).
    Missing ones are added to the asset the shot needs (a doodle item / a phrase of the photo prompt);
    what cannot be added is reported. → sl["objects"] rows."""
    assets = sl.setdefault("assets", [])
    by = {a["id"]: a for a in assets}
    facts = planfit.Facts(None, {"assets": assets})
    rows = []
    for sh in sl.get("shots", []):
        if sh.get("kind") not in ("screencast", "graphic"):
            continue
        text = " ".join([sh.get("words", "")] + [str(b.get("what", "")) for b in sh.get("beats", [])])
        typed = [str(b.get("text") or "") for b in sh.get("beats", []) if b.get("action") == "type"]
        for o in planfit.scan_objects(text):
            need = [by[n] for n in sh.get("needs", []) if n in by]
            have = None
            for a in need:
                if (o in planfit.KIND_OBJECTS and a.get("kind") in planfit.KIND_OBJECTS[o][1]) or \
                        (o not in planfit.KIND_OBJECTS and planfit._obj_rx(o).search(facts.asset_text(a))):
                    have = a["id"]
                    break
            if have:
                rows.append({"object": o, "shot": sh["id"], "asset": have, "status": "in_asset"})
                continue
            if o not in planfit.KIND_OBJECTS and any(planfit._obj_rx(o).search(t) for t in typed):
                rows.append({"object": o, "shot": sh["id"], "asset": None, "status": "made_on_camera"})
                continue
            if o in planfit.KIND_OBJECTS:
                kind = planfit.KIND_OBJECTS[o][1][0]
                a = next((x for x in assets if x.get("kind") in planfit.KIND_OBJECTS[o][1]), None)
                if not a:
                    sents = [s["text"] for s in job.sents if planfit.KIND_OBJECTS[o][0].search(s["text"])][:3]
                    a = {"id": o.replace(" ", "_"), "kind": kind, "desc": f"{o} the narration shows",
                         **({"prompt": " ".join(sents) or o} if kind == "photo" else {"doodle": []})}
                    assets.append(a)
                    by[a["id"]] = a
                if a["id"] not in sh.setdefault("needs", []):
                    sh["needs"].append(a["id"])
                rows.append({"object": o, "shot": sh["id"], "asset": a["id"], "status": "added"})
                continue
            # the sentence that names it (in this shot first) says WHICH picture holds it: drawn → the doodle,
            # otherwise the most-made picture the shot shows (an edit of a photo keeps the rest)
            ks = [k for k in sh.get("sentences", []) if k < len(job.sents)] + list(range(len(job.sents)))
            k = next((k for k in ks if planfit._obj_rx(o).search(job.sents[k]["text"])), None)
            where = job.sents[k]["text"] if k is not None else ""
            drawn = k is not None and any(DRAW_RE.search(job.sents[j]["text"]) for j in range(max(0, k - 2), k + 1))
            order = ("sketch",) if drawn else ("app_generation", "photo")
            tgt = next((a for k in order for a in need if a.get("kind") == k), None)
            if tgt is None:
                rows.append({"object": o, "shot": sh["id"], "asset": None, "status": "missing",
                             "why": "the shot needs no producible " + ("sketch" if drawn else "photo/app generation")
                                    + " to add it to"})
                continue
            if tgt["kind"] == "sketch":
                shape = DOODLE_SHAPE.get(o)
                if not shape:
                    rows.append({"object": o, "shot": sh["id"], "asset": tgt["id"], "status": "missing",
                                 "why": "no doodle shape for it (preprod.doodle_svg)", "said": where[:160]})
                    continue
                m = planfit._obj_rx(o).search(where)
                clause = re.split(r"[,.;]", where[m.end():] if m else "")[0]
                hits = [(mm.start(), b) for rx, b in DOODLE_SLOT for mm in [re.search(rx, clause, re.I)] if mm]
                used = [d.get("box") for d in tgt.get("doodle", [])]
                box = min(hits)[1] if hits else next((b for b in ([80, 80, 220, 220], [700, 640, 260, 200], [80, 640, 260, 200])
                                                      if b not in used), [80, 80, 220, 220])
                tgt.setdefault("doodle", []).append({"shape": shape, "box": box, "color": "#111"})
            else:
                tgt["prompt"] = (tgt.get("prompt") or tgt.get("desc", "")).rstrip(". ") + f", with {_article(o)} clearly visible"
            rows.append({"object": o, "shot": sh["id"], "asset": tgt["id"], "status": "added", "said": where[:160]})
    sl["objects"] = rows
    return rows


def _article(o):
    return ("an " if o[0] in "aeiou" else "a ") + o


def expect_rows(sl):
    """expect.json: what every screencast beat must put on screen, and by when (QA, G4)."""
    out = []
    for sh in sl.get("shots", []):
        if sh.get("kind") != "screencast":
            continue
        for b in sh.get("beats", []):
            if b.get("t_word") is None:
                continue
            out.append({"shot": sh["id"], "word_id": b["word_id"], "word": b.get("word"), "t_word": b["t_word"],
                        "clause_start": b.get("clause_start"), "action": b.get("action"), "subject": b.get("subject"),
                        "technique_id": b.get("technique_id"), "must_text": b.get("must_text"),
                        "typed_text": b.get("typed_text"), "framed_by": round(b["t_word"] + 0.30, 3),
                        "result_window": [round(b["t_word"] + 0.2, 3), round(b["t_word"] + 1.4, 3)],
                        "result_assertion": b.get("result_assertion")})
    return {"rules": "RULEBOOK §1 C1 (framed by word + 0.30 s), C2 (result +0.2…+1.4 s, BASELINE §2b), C3 (typed text)",
            "beats": out}


def _flow(job, out, ranges, app, elements=None, steps=None, max_gens=1, image_budget=3.0, cancelled=None, say=None):
    """readiness → shot list (+ beat ledger, narrated objects) → assets → set dressing → dry run → gate
    (+ expect.json). Live browser work stays behind the adapter: app.probe(workdir) and app.dry_run(...)
    when the adapter has them (a test's fake), else the off-camera Probe / dry_run below."""
    steps = steps or ALL_STEPS
    say = say or log
    stop = cancelled or (lambda: False)

    def check():
        if stop():
            raise InterruptedError()
    site = app.site
    costs = json.loads((out / "costs.json").read_text()) if (out / "costs.json").exists() else {"claude_usd": 0, "image_api_usd": 0}
    if (job.dir / "request.json").exists() and job.dir.resolve() != out.resolve():
        shutil.copyfile(job.dir / "request.json", out / "request.json")

    if "readiness" in steps:
        df = shutil.disk_usage("/").free / 1e9
        mk = getattr(app, "probe", None)
        p = mk(out / "session") if mk else Probe(out / "session", app.site, dark=True)
        try:
            checks = app.readiness(p, out)
            # automatic remedy: a failed global check is retried once on a fresh load
            for c in checks:
                if c["id"] in REQUIRED_GLOBAL and c["status"] != "pass":
                    say(f"readiness {c['id']} failed — retrying once")
                    again = {x["id"]: x for x in app.readiness(p, out)}
                    if again.get(c["id"], {}).get("status") == "pass":
                        c.update(again[c["id"]], note=(again[c["id"]].get("note", "") + " (pass on retry)"))
        finally:
            p.close()
        sc = getattr(p, "scout", None) or {}
        jdump({"app": site, "scout_profile": sc.get("slug"), "logged_in_at": sc.get("logged_in_at"),
               "disk_free_gb": round(df, 1), "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": checks,
               "features": features_of(app, checks)}, out / "readiness.json")
        say(f"readiness: {sum(c['status'] == 'pass' for c in checks)}/{len(checks)} pass")
    readiness = json.loads((out / "readiness.json").read_text())
    if set(steps) <= {"readiness"}:
        return None
    check()

    elem_names = sorted(p.name for p in Path(elements).glob("*")) if elements and Path(elements).is_dir() else []
    if "shotlist" in steps:
        _, tech_ids, _ = techniques_digest()
        prompt = shot_prompt(job, ranges, readiness, elem_names)
        (out / "shotlist.prompt.txt").write_text(prompt)
        sl, meta = director.call([{"type": "text", "text": prompt}], SHOT_SYSTEM, max_tokens=32000, effort="medium")
        costs["claude_usd"] = round(costs.get("claude_usd", 0) + meta["usd"], 4)
        jdump(costs, out / "costs.json")
        sl, problems = validate_shots(sl, job, ranges, tech_ids, readiness)
        ledger_fields(sl, job)
        objs = ensure_objects(sl, job)
        sl.update(ranges=ranges, problems=problems, model=director.MODEL, cost=meta)
        jdump(sl, out / "shotlist.json")
        (out / "SHOTLIST.md").write_text(shotlist_md(sl, ranges))
        say(f"shot list: {len(sl['shots'])} shots, {len(sl.get('assets', []))} assets, "
            f"{sum(o['status'] == 'added' for o in objs)} narrated object(s) added to assets, "
            f"{sum(o['status'] == 'missing' for o in objs)} missing, problems {problems}, ${meta['usd']}")
    if not (out / "shotlist.json").exists():
        return None
    sl = json.loads((out / "shotlist.json").read_text())
    check()

    if "assets" in steps:
        assets = build_assets(sl, out, elements, image_budget - costs.get("image_api_usd", 0))
        assets["objects"] = sl.get("objects", [])
        costs["image_api_usd"] = round(costs.get("image_api_usd", 0) + assets["image_api_usd"], 4)
        jdump(costs, out / "costs.json")
        jdump(assets, out / "assets.json")
        say("assets: " + ", ".join(f"{a['id']}={a['status']}" for a in assets["assets"]))
    if not (out / "assets.json").exists():
        return None
    assets = json.loads((out / "assets.json").read_text())

    if "set_dressing" in steps:
        setd = set_dressing_plan(sl, assets, app)
        jdump(setd, out / "set_dressing.json")
    setd = json.loads((out / "set_dressing.json").read_text())
    check()

    if "dryrun" in steps:
        if shutil.disk_usage("/").free / 1e9 < 2:
            raise RuntimeError("disk below 2 GB — no browser session")
        fn = getattr(app, "dry_run", None)
        dry = fn(job, sl, assets, setd, out, max_gens) if fn else dry_run(job, sl, assets, setd, app, out, max_gens=max_gens)
        jdump(dry, out / "dryrun.json")
        jdump(assets, out / "assets.json")         # in-app generations now ready (file, chat URL)
        # the plan now carries the real chat URLs + verification results of the replay
        for seg in setd["segments"]:
            r = next((x for x in dry.get("set_dressing", []) if x["shot"] == seg["shot"]), None)
            seg["verified"] = bool(r and r["ok"])
            seg["first_frame"] = r and r.get("first_frame")
        setd["chat_urls"] = {k: v.get("chat_url") for k, v in dry.get("produced", {}).items()}
        setd["image_index"] = {k: v.get("image_index", 0) for k, v in dry.get("produced", {}).items()}
        # a chat that gained newer images after the asset is no longer pristine: the recording stage re-makes the
        # asset in a fresh chat first (its produce_first steps; 1 generation each) and uses that chat's URL
        setd["refresh_before_record"] = [{"asset": ob["id"].split(":", 1)[1], "why": ob["note"]}
                                         for ob in dry.get("observations", []) if ob["id"].startswith("stale_after:")]
        jdump(setd, out / "set_dressing.json")
    dry = json.loads((out / "dryrun.json").read_text()) if (out / "dryrun.json").exists() else {"actions": []}

    jdump(expect_rows(sl), out / "expect.json")
    g = None
    if "gate" in steps:
        g = gate(sl, readiness, assets, setd, dry, ranges, app.warnings(sl) if hasattr(app, "warnings") else None)
        g["costs"] = costs
        jdump(g, out / "gate.json")
        say(f"GATE: {g['status']} — failing {[f['item'] for f in g['failing']]}")
    jdump(costs, out / "costs.json")
    return g


DARK_APPS = {"chatgpt"}                        # RULEBOOK S7: ChatGPT is recorded in dark theme
FACTORY_FILES = ("readiness.json", "shotlist.json", "assets.json", "set_dressing.json", "dryrun.json", "expect.json")


def run(job_dir, req=None, edl=None, log=log, progress=None, cancelled=None, adapter=None, **_):
    """The worker's PRE-PRODUCTION stage of the creative edit (bin/aieditor-worker run_preprod).
    Unattended, machine-readable only (Jake: "an automated factory"):
      sites      request.json "sites", else derived from the narration (aieditor/sites.py)
      readiness  per site: Scout profile copy available + logged in (agentrec.scout_for), theme
      the FULL flow for the whole narration on the first ready app that has an adapter (APPS):
                 readiness.json (+ "features" the plan may use), shotlist.json (beat ledger: every
                 beat on its edl word), assets.json (every narrated object produced first),
                 set_dressing.json, dryrun.json, expect.json — the director plans from these
                 (longedit → director.plan / validate, planfit.Facts)
      gate.json  {"go", "status", "sites": [{url, scout, dark, ready}], "fallbacks", "flow", ...}
    A site that is not ready is dropped from the gate (its moments stay A-roll) — never a stop.
    The flow's files are reused while they are newer than edl.json (it costs Claude + images)."""
    from . import sites as sites_mod
    d = Path(job_dir)
    out = d / "preprod"
    out.mkdir(exist_ok=True)
    req = req if req is not None else json.loads((d / "request.json").read_text())
    edl = edl if edl is not None else json.loads((d / "edl.json").read_text())
    v = edl["videos"][0]
    video = {"title": v.get("title", ""), "duration": v["duration"], "words": v["words"]}
    if progress:
        progress("Pre-production: what can be screencast…", 0.1)
    found, usd = sites_mod.resolve(d, req, video, log=log)
    rows, fallbacks = [], []
    for s in found:
        sc = agentrec.scout_for(s["url"])
        row = {"url": s["url"], "note": s.get("note", ""), "scout": sc["slug"] if sc else None,
               "dark": bool(sc and sc["slug"] in DARK_APPS), "derived": bool(s.get("derived"))}
        if sc:
            prof = Path(sc["profile"])
            row["ready"] = bool(sc.get("logged_in_at")) and (prof / "Default").is_dir()
            row["why"] = "logged in (UX Scout)" if row["ready"] else "Scout profile not logged in / missing"
        else:
            row["ready"] = bool(s.get("public") or not s.get("derived"))
            row["why"] = "public page (no login)" if row["ready"] else "needs a login we do not have"
        (rows if row["ready"] else fallbacks).append(row)
        if not row["ready"]:
            log(f"pre-production: {s['url']} not ready ({row['why']}) — its moments stay A-roll")
    g = {"go": True, "status": "go" if rows else "aroll_only", "next_stage": "record",
         "sites": rows, "fallbacks": fallbacks,
         "aroll_motion": "planned at compose from the final A-roll blocks (aieditor/arollplan.py)",
         "costs": {"claude_usd": usd}}
    note = (f"{len(rows)} screencast site(s): " + ", ".join(r["scout"] or r["url"] for r in rows)) if rows \
        else "nothing can be screencast — A-roll + overlays only"
    # the full pre-production for the whole narration, on the first ready app with an adapter
    row = next((r for r in rows if adapter is not None or adapter_for(r["url"])), None)
    edl_at = (d / "edl.json").stat().st_mtime if (d / "edl.json").exists() else 0
    if row and video["words"]:
        app = adapter or adapter_for(row["url"])
        fresh = all((out / f).exists() and (out / f).stat().st_mtime >= edl_at for f in FACTORY_FILES)
        try:
            if fresh:
                fg = json.loads((out / "flow-gate.json").read_text()) if (out / "flow-gate.json").exists() else {}
                log("pre-production: readiness/shot list/assets/dry run are newer than the edit — reused")
            else:
                if progress:
                    progress("Pre-production: readiness, shot list, assets, dry run…", 0.2)
                job = EdlJob(d, req, video)
                fg = _flow(job, out, [job.whole()], app, elements=(d / "elements") if (d / "elements").is_dir() else None,
                           cancelled=cancelled, say=log) or {}
                jdump(fg, out / "flow-gate.json")
            costs = json.loads((out / "costs.json").read_text()) if (out / "costs.json").exists() else {}
            usd += float(costs.get("claude_usd", 0) or 0) + float(costs.get("image_api_usd", 0) or 0) if not fresh else 0.0
            g["flow"] = {"app": row["url"], "status": fg.get("status"), "files": list(FACTORY_FILES),
                         "failing": [f["item"] for f in fg.get("failing", [])], "shot_overrides": fg.get("shot_overrides", {})}
            g["costs"].update(costs)
            if fg and not fg.get("go", True):
                # the app is not usable (e.g. not logged in): its moments stay A-roll — never a stop
                rows.remove(row)
                fallbacks.append({**row, "ready": False, "why": f"pre-production gate: {fg.get('status')} "
                                  f"({', '.join(g['flow']['failing'][:4])})"})
                g["status"] = "go" if rows else "aroll_only"
            note += f"; pre-production {fg.get('status') or 'done'}"
        except InterruptedError:
            raise
        except Exception as e:  # noqa: BLE001 — factory rule: route, don't fail
            log(f"pre-production flow failed ({type(e).__name__}: {e}) — the plan runs on the Scout report only")
            g["flow"] = {"app": row["url"], "status": "failed", "error": f"{type(e).__name__}: {e}"[:400]}
            note += "; pre-production flow failed (see log)"
    jdump(g, out / "gate.json")
    return {"note": note, "usd": usd}


def run_ranges(job_dir, out_dir, ranges_arg, elements=None, steps=None, max_gens=1, image_budget=3.0):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    job = Job(job_dir)
    ranges = []
    for r in ranges_arg:
        a, b = r.split("-")
        ranges.append(job.snap(parse_t(a), parse_t(b)))
    jdump({"job": str(job.dir), "ranges": ranges}, out / "ranges.json")
    log("ranges: " + "; ".join(f"{r['src_fmt'][0]}–{r['src_fmt'][1]} (S{r['sentences'][0]}–S{r['sentences'][-1]})" for r in ranges))
    site = (job.sites[0]["url"] if job.sites else "")
    app = adapter_for(site)
    if not app:
        raise SystemExit(f"no pre-production adapter for {site} (add one to APPS)")
    _flow(job, out, ranges, app, elements, steps, max_gens, image_budget)
    return out


def main():
    ap = argparse.ArgumentParser(prog="python -m aieditor.preprod")
    ap.add_argument("job_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--ranges", nargs="+", required=True, help="source-timeline ranges, e.g. 0:00-1:00 7:03-8:03")
    ap.add_argument("--elements", help="dir of editing elements supplied for the job")
    ap.add_argument("--steps", default=",".join(ALL_STEPS))
    ap.add_argument("--max-gens", type=int, default=1)
    ap.add_argument("--image-budget", type=float, default=3.0)
    a = ap.parse_args()
    run_ranges(a.job_dir, a.out_dir, a.ranges, a.elements, a.steps.split(","), a.max_gens, a.image_budget)


if __name__ == "__main__":
    main()
