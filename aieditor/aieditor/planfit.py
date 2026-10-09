"""PLAN FIT: the director's plan is made to fit what the app, the account and the produced assets
can actually show, in the reference span structure. Pure functions, no I/O, no live calls.

Gap list G2. Jake: "the references are the 100% mark score".
  beat ledger   every "on '<cue>': <body>" beat of a segment intent is resolved to a narration word
                {word_id, t_word, clause_start, subject, technique_id, action, must_text, typed_text,
                result_assertion} (RULEBOOK §1 C1-C3, §3 M1)
  facts         readiness.json "features" (what the app/account has: exists true/false + honest
                alternative) and assets.json (what pre-production produced). A beat that names a missing
                feature, an object no produced asset contains, or an invented chat/page is REWRITTEN to
                its honest route ('+ -> Sketch', the public pricing page in a never-logged-in US browser,
                RULEBOOK §8 L4) or ROUTED to A-roll
  structure     screencast spans p50 10-18 s, max 30 s; A-roll beats 5-7 s; screencast share 72-76 %;
                3-6 screen<->face boundaries per minute; plates <= 1.5 % of runtime, first 40 s only
                (REFERENCE-BASELINE §1a/§1b, rubric D7); cuts on sentence starts (§2d)
  hook plate    the first 40 s point at a thing ("look at this", "on the left/right") -> one
                TX07/TX09 plate beat showing the produced asset (BASELINE §1a: r2 0:07, r3 0:04, r5 0:12)
  instructions  an A-roll stretch >= 8 s whose words tell the viewer to upload/click/type/drag/select/
                open needs a segment or an explicit why (rubric D1/D7)
"""
import difflib
import re
import statistics

# ── reference numbers (REFERENCE-BASELINE §1a/§1b; refs r2-r5) ──
SPAN_P50 = (10.0, 18.0)          # screencast span median band
SPAN_MAX = 30.0                  # no span longer than this
SPAN_TARGET = 14.0               # where a split aims a piece
AROLL_BEAT = (5.0, 7.0)          # A-roll block p50 5.1-6.5 s
SHARE = (0.72, 0.76)             # screencast share of runtime
SHARE_AIM = 0.74
BOUNDS_PER_MIN = (3.0, 6.0)
PLATE_MAX_FRAC = 0.015           # plates <= 1.5 % of runtime ...
HOOK_S = 40.0                    # ... and only inside the first 40 s
BLOCK_AIM = 5.0                  # a pacing A-roll beat aims here (refs p50 5.1-6.5 s; shorter keeps the share)
CLAUSE_SPLIT_S = 6.0             # a sentence longer than this may also be cut at a clause comma
LEAD = 0.1                       # the picture leads the next sentence by ~0.1 s (CUT04/CUT05)
MIN_SPAN = 2.5                   # RULEBOOK P4
MIN_GAP = 3.0                    # at least this much A-roll between two screencasts of different worlds
LONG_STRUCTURE_S = 120.0         # the share/fill rules are for tutorials, not 20 s tests

POINT_RE = re.compile(r"\b(look at (?:this|that)|on the (?:left|right)|check (?:this|that) out|see this|right here)\b", re.I)
ACTION_RE = re.compile(r"\b(upload\w*|click\w*|typ(?:e|es|ed|ing)|drag\w*|select\w*|open(?:s|ed|ing)?)\b", re.I)
# the presenter's own lines stay A-roll (director rule 5): calls to action and the sign-off
PRESENTER_RE = re.compile(
    r"\b(subscribe\w*|notification bell|like button|follow me|tiktok|instagram|comment (?:down )?below|"
    r"links? (?:is |are )?(?:down )?in the description|description below|see you (?:in the next|there)|"
    r"thank you so much|next video|video to my (?:left|right)|welcome back|i'm jake dawson)\b", re.I)

CUE_RE = re.compile(r"""\b[Oo]n\s+['‘"“]((?:[^'’"”;]|'(?=[a-z]))+?)['’"”]\s*:\s*""")
QUOTE_RE = re.compile(r"""['‘"“]((?:[^'"‘’“”]|'(?=[a-z]))+?)['’"”](?![a-z])""")
TYPED_RE = re.compile(r"""['‘"“]((?:[^'"‘’“”]|'(?=[a-z]))+?)['’"”]\s+(?:is\s+|are\s+)?(?:pasted|typed)""")
URL_RE = re.compile(r"https?://[^\s,;'\")]+")

# body verb -> (action, technique id). The earliest match in the body wins.
ACTIONS = [
    (r"\bdissolves?\b", "dissolve", "TR02"),
    (r"\bclicks?\b|\bpress(?:es)? enter\b|\bhits?\b", "click", "ZM12"),
    (r"\bpasted\b|\btyped\b|\btypes?\b", "type", "CUT01"),
    (r"\bdrag(?:ged|s)?\b|\bbrush\b|\bdrawn\b|\bdraws?\b|\bpin (?:drops|on)\b|\ba pin\b", "drag", "CR01"),
    (r"\bupload(?:ed|s)?\b|\battached\b", "upload", "CUT01"),
    (r"\bscroll", "scroll", "SC01"),
    (r"\bcut to\b|\bgoto\b", "cut", "CUT02"),
    (r"\bease out\b|\bfull (?:photo|result|picture|logo|top bar|toolbar)\b|\bunzoomed\b|\bzoomed out\b", "release", "ZM11"),
    (r"\bzoom|\btighter\b|\bframed\b", "zoom", "ZM05"),
    (r"\bpush\b", "push", "ZM10"),
    (r"\bholds?\b|\bstay on\b|\brests\b", "hold", "ZM10"),
    (r"\bcursor\b", "hover", "PN01"),
]
ZOOM_KIND = [(r"\bcard\b|\bplan\b", "ZM09"), (r"\bbox\b|\bprompt\b|\bmessage\b", "ZM03"),
             (r"\bmenu\b|\bpanel\b|\blist\b|\bsidebar\b|\btoolbar\b|\btop bar\b", "ZM04"),
             (r"\bbutton\b|\btab\b|\bicon\b|\blabel next\b|\barrow\b|\bpill\b", "ZM02"),
             (r"\blanding\b|\blogo\b|\bhero\b", "ZM07"), (r"\btext\b|\bline\b|\blettering\b", "ZM06")]
RESULTS = {
    "click": "the click lands on the word (C2 ±0.15 s); its visible UI result arrives +0.2…+1.4 s after the word "
             "(BASELINE §2b, median +0.7 s); the named control is framed by word + 0.3 s",
    "type": "the field is EMPTY on the first frame (C3); the final text equals typed_text exactly, pasted whole at ×1.0 (K1)",
    "dissolve": "3–8 f dissolve +0.5…+0.8 s after the word straight to the finished result, framed ×1.19–1.30 (K2, BASELINE §2c)",
    "drag": "the stroke/box/pin appears on the named subject while he says it (C2)",
    "upload": "the produced file is attached (thumbnail visible) by word + 1.4 s (C2)",
    "scroll": "one native wheel flick that ends on the named thing (K3, SC01)",
    "cut": "hard cut / page change lands by word + 0.3 s on the named page (CUT02, L1)",
    "release": "zoom-out ratio 0.76–0.90 over 34–40 f, never right before a cut to A-roll (M3)",
    "zoom": "the subject box centre within 0.06 W / 0.08 H of frame centre by word + 0.3 s (C1/F1), F3 zoom band",
    "push": "slow centred push ×1.06–1.26 over 24–46 f, no still > 3 s (M5/P1)",
    "hold": "nothing still for > 3.0 s: a slow centred push fills the hold (P1/M5)",
    "hover": "the cursor arrives on the named element on a straight path (K4); a hover is not an action",
    "show": "the named thing is visible, legible and the framed subject by word + 0.3 s (C1)",
}

# physical objects a beat can name inside an image (the asset must contain them, RULEBOOK §S S1/S2)
OBJECTS = [
    "picnic table", "chili pepper", "olive tree", "kitchen counter", "wood grain", "phone photo",
    "bottle", "napkin", "sun", "table", "pepper", "chili", "label", "counter", "window", "crumb",
    "sofa", "couch", "chair", "tree", "plant", "cup", "mug", "bowl", "baker", "bread", "pastry",
    "person", "man", "woman", "dog", "cat", "car", "flower", "shelf",
    "lamp", "laptop", "shoe", "hat", "bag", "wood", "glass", "box of", "candle", "lemon", "apple", "sign",
]
# object-kind requirements: these name a produced asset of a kind, not a thing inside one
KIND_OBJECTS = {
    "phone photo": (re.compile(r"\bphone photo\b|\bhot sauce (?:bottle )?photo\b|\bphoto of (?:a|the|my) (?:hot sauce )?bottle\b", re.I),
                    ("photo", "element")),
    "sketch": (re.compile(r"\b(?:the|my|finished|rough|drawn|made from the)\s+(?:sketch|doodle|drawing)\b(?!\s*(?:plugin|canvas|button|tool|option))"
                          r"|\bfinished doodle\b|\bis drawn\b|\bdoodle\b", re.I),
               ("sketch",)),
}
DESCRIBED_RE = re.compile(r"\bthe ([a-z]+) (picture|image|photo)\b", re.I)
GENERIC_PIC = {"same", "new", "latest", "finished", "edited", "whole", "full", "tall", "generated", "produced", "result",
               "first", "second", "third", "last", "final", "real", "original", "other", "best", "older", "next", "sauce",
               "hot", "bottle", "phone", "sketch", "uploaded", "attached", "existing", "black", "white", "old"}
UI_BEFORE = re.compile(r"(?:percentage|progress|character|word|page|search|text|name)\s+$", re.I)
UI_AFTER = re.compile(r"^\s*(?:(?:next to|beside|in the|on the (?:left|right|top))\s+(?:the\s+)?)?«q»", re.I)
NAMED_CONTENT_RE = re.compile(
    r"""(?:the\s+)?['‘"“]([^'’"”]{3,60})['’"”]\s+(chat|conversation|document|project|thread|folder|brand|campaign|board)\b"""
    r"""|\b(chat|conversation|document|project|thread)\s+(?:called|named|titled)\s+['‘"“]([^'’"”]{3,60})['’"”]""", re.I)


def norm(w):
    return re.sub(r"[^a-z0-9]", "", str(w).lower())


def _stem(w):
    w = w.lower()
    if len(w) > 4 and not w.endswith("ss"):
        return re.sub(r"(ies|es|s)$", lambda m: "y" if m.group(1) == "ies" and not w.endswith("lies") else "", w)
    return w


def _obj_rx(o):
    parts = [re.escape(_stem(p)) for p in o.split()]
    return re.compile(r"\b" + r"\s+".join(p + r"(?:s|es|en|ies)?" for p in parts) + r"\b", re.I)


# ────────────────────────────── sentences / units ──────────────────────────────

def sentences(words):
    """Punctuation or a > 0.9 s pause ends a sentence (takes.sentences, on the output timeline)."""
    out, cur = [], []
    for w in words:
        if cur and w["start"] - cur[-1]["end"] > 0.9:
            out.append(cur)
            cur = []
        cur.append(w)
        if re.search(r"[.?!][\"')\]]*$", w["word"]):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def presenter_windows(video):
    """The presenter's own moments (director rule 5) as time windows: what those graphics occupy
    (graphics_long / recipes2): the link slide runs 2.3 s from "link"; the subscribe button appears
    ~2.4 s before its click; the name title; the welcome line."""
    ws = video["words"]
    nm = [norm(w["word"]) for w in ws]
    out = []
    for i, n in enumerate(nm):
        w = ws[i]
        if n in ("subscribe", "subscribed"):
            out.append((w["start"] - 2.8, w["end"] + 2.6))
        elif n in ("link", "links") and "description" in nm[i:i + 12]:
            out.append((w["start"] - 0.6, w["start"] + 2.6))
        elif n == "dawson" and i and nm[i - 1] == "jake":
            out.append((w["start"] - 1.5, w["end"] + 1.2))
        elif n == "welcome" and nm[i + 1:i + 2] == ["back"]:
            hey = next((ws[j] for j in range(max(0, i - 3), i) if nm[j] in ("hey", "hi", "hello")), w)
            out.append((hey["start"] - 0.6, w["end"] + 1.5))
    return out


def units(video, windows=()):
    """Cut units = sentences; a sentence > 9 s is split at its clause commas; every unit is also split
    where a presenter window ends, so a screencast may resume right after the moment."""
    ws = video["words"]
    res = []
    for s in sentences(ws):
        parts, cur = [], []
        for k, w in enumerate(s):
            cur.append(w)
            nxt = s[k + 1] if k + 1 < len(s) else None
            if nxt is None:
                break
            long_ = (s[-1]["end"] - s[0]["start"] > CLAUSE_SPLIT_S and cur[-1]["end"] - cur[0]["start"] >= 2.0
                     and s[-1]["end"] - nxt["start"] >= 2.0)
            if long_ and re.search(r"[,;:]$", w["word"]):
                parts.append((cur, True))
                cur = []
            elif any(w["start"] < b <= nxt["start"] or w["start"] < a <= nxt["start"] for a, b in windows):
                parts.append((cur, True))
                cur = []
        if cur:
            parts.append((cur, True))
        for n, (p, _) in enumerate(parts):
            res.append({"ids": [w["i"] for w in p], "words": p, "t0": p[0]["start"], "t1": p[-1]["end"],
                        "text": " ".join(w["word"] for w in p), "sentence_start": n == 0})
    for k, u in enumerate(res):
        u["k"] = k
        u["next_t0"] = res[k + 1]["t0"] if k + 1 < len(res) else video["duration"]
        u["dur"] = max(0.0, u["next_t0"] - u["t0"])
        u["hard"] = any(a <= w["start"] < b for a, b in windows for w in u["words"]) or bool(PRESENTER_RE.search(u["text"]))
        u["act"] = bool(ACTION_RE.search(u["text"]))
    return res


# ────────────────────────────── beats (the ledger) ──────────────────────────────

def parse_intent(intent):
    """"on '<cue>': <body>; on ..." → (preamble, [{cue, body}])."""
    intent = str(intent or "")
    ms = list(CUE_RE.finditer(intent))
    if not ms:
        return intent.strip(), []
    pre = intent[:ms[0].start()].strip()
    beats = []
    for k, m in enumerate(ms):
        end = ms[k + 1].start() if k + 1 < len(ms) else len(intent)
        body = intent[m.end():end].strip().rstrip(";").strip()
        beats.append({"cue": m.group(1).strip(), "body": body})
    return pre, beats


def resolve_cue(cue, words, lo, hi, after=-1):
    """The narration word a cue names (its first word), searched in words[lo:hi] from position
    `after` + 1 on (cues are in narration order). → (index, score) or (None, score)."""
    target = norm(cue)
    if not target:
        return None, 0.0
    best, best_s = None, 0.0
    for k in range(max(lo, after + 1), hi):
        acc = ""
        for j in range(k, min(hi, k + 12)):
            acc += norm(words[j]["word"])
            if len(acc) >= len(target):
                break
        s = difflib.SequenceMatcher(None, target, acc[:len(target) + 2]).ratio()
        if norm(words[k]["word"])[:2] != target[:2]:
            s -= 0.15                                  # the cue starts on its first word
        if s > best_s + 1e-9:
            best, best_s = k, s
            if s >= 0.98:
                break
    return (best, best_s) if best_s >= 0.62 else (None, best_s)


def sentence_text(words, k):
    a = k
    while a > 0 and not re.search(r"[.?!]$", words[a - 1]["word"]):
        a -= 1
    b = k
    while b + 1 < len(words) and not re.search(r"[.?!]$", words[b]["word"]):
        b += 1
    return " ".join(w["word"] for w in words[a:b + 1])


def clause_start(words, k):
    """Start of the clause that holds words[k]: back to the previous , ; : . ? ! or a ≥ 0.35 s pause."""
    j = k
    while j > 0 and k - j < 25:
        prev = words[j - 1]
        if re.search(r"[,;:.?!]$", prev["word"]) or words[j]["start"] - prev["end"] >= 0.35:
            break
        j -= 1
    return j


def classify(body, preamble=""):
    low = body.lower()
    hits = []
    for rx, act, tid in ACTIONS:
        m = re.search(rx, low)
        if m:
            hits.append((m.start(), act, tid))
    typed = [m.group(1) for m in TYPED_RE.finditer(body)]
    quotes = [m.group(1) for m in QUOTE_RE.finditer(body)]
    if not hits and quotes and re.fullmatch(r"""\s*['‘"“].*['’"”]\s*\.?""", body, re.S) and re.search(r"past|typ", preamble, re.I):
        typed = quotes[:1]                             # "On 'x': 'Prompt text'" under a "pasted whole" preamble
        hits.append((0, "type", "CUT01"))
    act, tid = ("show", "ZM05")
    if hits:
        _, act, tid = min(hits)
    if act == "zoom":
        tid = next((t for rx, t in ZOOM_KIND if re.search(rx, low)), "ZM05")
    must = [q for q in quotes if q not in typed and not q.startswith(("http", "/"))]
    return act, tid, typed[0] if typed else None, must


def scan_objects(text):
    """Physical objects named in a beat (quoted text = typed/UI labels, not image content)."""
    t = QUOTE_RE.sub(" «q» ", text)
    found, used = [], []
    for o in OBJECTS:
        for m in _obj_rx(o).finditer(t):
            if any(a < m.end() and m.start() < b for a, b in used):
                continue
            if UI_AFTER.match(t[m.end():]) or UI_BEFORE.search(t[:m.start()]):
                continue                               # "the label next to 'Images'", "percentage counter" are UI
            used.append((m.start(), m.end()))
            if o not in found:
                found.append(o)
    kinds = [k for k, (rx, _) in KIND_OBJECTS.items() if rx.search(text)]
    return [o for o in found if o not in KIND_OBJECTS] + [k for k in kinds if k not in found] + \
        [o for o in found if o in KIND_OBJECTS and o not in kinds]


# ────────────────────────────── facts ──────────────────────────────

class Facts:
    """What the app/account can show (readiness.json "features" + checks) and what pre-production
    produced (assets.json). Built from files, so a test can hand in fixtures."""

    def __init__(self, readiness=None, assets=None, pages=None):
        readiness = readiness or {}
        self.features = list(readiness.get("features") or [])
        self.checks = {c.get("id"): c for c in readiness.get("checks", []) or []}
        self.assets = list((assets or {}).get("assets", []) or [])
        self.pages = list(pages or [])
        self.labels = set()
        for c in self.checks.values():
            if c.get("status") == "pass":
                for v in re.findall(r'"(?:text|label)":\s*"([^"]{2,40})"', str(c.get("where")).replace("'", '"')):
                    self.labels.add(v)

    @property
    def empty(self):
        return not (self.features or self.assets)

    def asset_text(self, a, seen=None):
        """Everything an asset shows: its own words + what it was made from (an edit keeps the rest)."""
        seen = seen or set()
        if a.get("id") in seen:
            return ""
        seen.add(a.get("id"))
        src = a.get("source") or {}
        bits = [a.get("id", ""), a.get("desc", ""), a.get("prompt") or "", src.get("prompt") or "", a.get("text") or "",
                " ".join(f"{d.get('shape', '')} {d.get('label', '')}" for d in (src.get("doodle") or a.get("doodle") or []))]
        for m in (a.get("made_from") or src.get("made_from") or []):
            p = next((x for x in self.assets if x.get("id") == m), None)
            if p:
                bits.append(self.asset_text(p, seen))
        return " ".join(str(b) for b in bits)

    def usable_assets(self):
        return [a for a in self.assets if a.get("status") in ("ready", "pending_in_app", None)]

    def find_object(self, obj, live_texts=()):
        """→ (asset id | 'live:<n>' | None)."""
        if obj in KIND_OBJECTS:
            kinds = KIND_OBJECTS[obj][1]
            for a in self.usable_assets():
                if a.get("kind") in kinds or obj in a.get("desc", "").lower():
                    return a["id"]
            return None
        rx = _obj_rx(obj)
        for a in self.usable_assets():
            if rx.search(self.asset_text(a)):
                return a["id"]
        for n, t in enumerate(live_texts):
            if t and rx.search(t):
                return f"live:{n}"
        return None

    def feature_exists(self, fid):
        f = next((f for f in self.features if f.get("id") == fid), None)
        if f is not None:
            return bool(f.get("exists"))
        return self.checks.get(fid, {}).get("status") == "pass"

    def missing_features(self, text):
        """Features this text names that the account does NOT have → [feature]."""
        out = []
        for f in self.features:
            if f.get("exists"):
                continue
            if any(re.search(p, text, re.I) for p in f.get("patterns", [])):
                out.append(f)
        return out

    def known_name(self, name):
        n = norm(name)
        hay = [a.get("id", "") + " " + a.get("desc", "") + " " + str(a.get("prompt") or "") for a in self.assets]
        hay += [f"{u} {t}" for u, t in self.pages]
        hay += [str(c.get("where")) for c in self.checks.values()]
        return any(n and n in norm(h) for h in hay)

    def result_asset(self):
        """The produced image a scene can honestly open on (latest generation, else a photo/sketch)."""
        order = {"app_generation": 0, "photo": 1, "element": 2, "sketch": 3}
        cands = [a for a in self.usable_assets() if a.get("kind") in order]
        return min(cands, key=lambda a: order[a["kind"]]) if cands else None


# ────────────────────────────── the ledger + checks ──────────────────────────────

def build_ledger(segments, video, facts):
    """Every beat of every planned segment → a ledger row with its word, checks and route."""
    ws = video["words"]
    pos = {w["i"]: n for n, w in enumerate(ws)}
    ledger, live = [], []
    check = not facts.empty                  # no pre-production facts → nothing to check against
    for si, s in enumerate(segments):
        pre, beats = parse_intent(s.get("intent"))
        lo = max(0, pos.get(s.get("start"), 0) - 6)
        hi = min(len(ws), pos.get(s.get("end"), len(ws) - 1) + 8)
        after = lo - 1
        opened = False
        pending = []
        for b in beats:
            k, score = resolve_cue(b["cue"], ws, lo, hi, after)
            act, tid, typed, must = classify(b["body"], pre)
            row = {"seg": si, "cue": b["cue"], "body": b["body"], "action": act, "technique_id": tid,
                   "typed_text": typed, "must_text": must, "route": "keep", "why": None, "cue_score": round(score, 2)}
            if k is None:
                row.update(route="drop", why=f"cue '{b['cue']}' is not in the narration of this segment")
                ledger.append(row)
                continue
            after = k
            w = ws[k]
            c = clause_start(ws, k)
            row.update(word_id=w["i"], t_word=w["start"], clause_start=ws[c]["start"], clause_word_id=ws[c]["i"])
            text = f"{b['cue']} :: {b['body']}"
            urls = URL_RE.findall(b["body"])
            # 1. features the account does not have
            miss = facts.missing_features(text) if check else []
            alt = next((f.get("alternative") for f in miss if f.get("alternative")), None)
            if miss:
                names = ", ".join(f["id"] for f in miss)
                if alt and alt.get("route") == "public":
                    row.update(route="public", why=f"{names}: {miss[0].get('note') or 'not inside the account'} → "
                               f"the public page in a separate never-logged-in browser (RULEBOOK §8 L4)",
                               session={"kind": "public", "locale": alt.get("locale", "en-US"),
                                        "timezone": alt.get("timezone", "America/New_York"),
                                        "currency": alt.get("currency", "USD"), "egress": alt.get("egress", "US")},
                               url=alt.get("url"))
                    row["body"] = (f"[separate never-logged-in en-US browser, US prices] " + b["body"]
                                   .replace("https://chatgpt.com/pricing", alt.get("url") or "the public pricing page"))
                elif alt and alt.get("route") == "rewrite" and all(f.get("alternative") for f in miss):
                    row.update(route="rewrite", why=f"{names} does not exist in this account → honest route: {alt['how']}",
                               body=f"{alt['how']} (the honest route — {names} does not exist here)")
                    if alt.get("url"):
                        row["url"] = alt["url"]
                    row["action"], row["technique_id"] = classify(row["body"])[:2]
                else:
                    row.update(route="aroll", feature_missing=True,
                               why=f"{names}: {miss[0].get('note') or 'does not exist in this account'} "
                               "— no honest way to show it, the words stay on the presenter (C1)")
            # 2. invented chats / documents / pages
            if check and row["route"] in ("keep", "rewrite"):
                for m in NAMED_CONTENT_RE.finditer(b["body"]):
                    name = m.group(1) or m.group(4)
                    if facts.known_name(name) or any(name.lower() in t.lower() for t in live if t):
                        continue
                    ra = facts.result_asset()
                    if ra and not opened:
                        row.update(route="rewrite", why=f"'{name}' {m.group(2) or m.group(3)} does not exist (no asset, no "
                                   f"page) → opens on the produced {ra['id']}",
                                   body=f"the chat holding the produced {ra['id']} ({ra.get('desc', '')[:80]}), the image in "
                                        f"view (opens_on chat_result:{ra['id']})", subject=f"asset:{ra['id']}")
                    elif norm(name) in norm(sentence_text(ws, k)):
                        row.update(route="aroll", why=f"'{name}' {m.group(2) or m.group(3)} is invented: no asset, page or "
                                   "earlier step makes it — he names it, so the words stay on the presenter")
                    else:
                        row.update(route="drop", why=f"'{name}' {m.group(2) or m.group(3)} is invented: no asset, page or "
                                   "earlier step makes it — beat dropped")
                    break
            # 2b. "the <x> picture/image/photo": a picture described by content no asset / narration has
            if check and row["route"] in ("keep", "rewrite") and not row.get("subject"):
                said = sentence_text(ws, k)
                for m in DESCRIBED_RE.finditer(b["body"]):
                    word = m.group(1).lower()
                    if word in GENERIC_PIC or word.endswith(("ing", "ed")) or any(_obj_rx(word).search(t) for t in
                                                  [said] + live + [facts.asset_text(a) for a in facts.assets]):
                        continue
                    row.update(route="drop", why=f"'the {word} {m.group(2)}' is invented: no produced asset or earlier "
                               "step makes it — beat dropped, the previous framing holds")
                    break
            # 3. objects named in the image must be in a produced asset (or made by a prompt typed earlier)
            # (a typing beat shows the message box, not the image: its words are a prompt, not a subject)
            objs = scan_objects(b["body"]) if row["action"] != "type" else []
            row["objects"] = {}
            for o in objs:
                row["objects"][o] = facts.find_object(o, live)
            missing = [o for o, a in row["objects"].items() if a is None]
            if check and missing and row["route"] in ("keep", "rewrite") and not row.get("subject"):
                said = sentence_text(ws, k)
                named = [o for o in missing if _obj_rx(o).search(said) or o in KIND_OBJECTS and KIND_OBJECTS[o][0].search(said)]
                if named:
                    row.update(route="aroll", why=f"he names {', '.join(named)} but no produced asset contains it (RULEBOOK "
                               "§S S1/S2, C1) — pre-production must produce it first; the words stay on the presenter")
                else:
                    row.update(route="drop", why=f"the beat invents {', '.join(missing)} (not said, in no produced asset) — "
                               "dropped, the previous framing holds")
            named_asset = next((m.group(1) for m in re.finditer(r"\bproduced (\w+)", row["body"])
                                if any(a.get("id") == m.group(1) for a in facts.assets)), None)
            subj = f"asset:{named_asset}" if named_asset else \
                next((f"asset:{a}" for a in row["objects"].values() if a and not a.startswith("live:")), None)
            row.setdefault("subject", subj or (f"ui:{must[0]}" if must else f"page:{urls[0]}" if urls else "screen"))
            row["result_assertion"] = RESULTS.get(row["action"], RESULTS["show"])
            if row["typed_text"]:
                pending.append(row["typed_text"])
            elif pending and (row["action"] == "dissolve" or re.search(r"\bsend\b|\bblue arrow\b|\benter\b", b["body"], re.I)):
                live.extend(pending)                   # a prompt that was SENT made those objects on camera
                pending = []
            if row["route"] in ("keep", "rewrite", "public"):
                opened = True
            ledger.append(row)
    # a scene whose premise does not exist (half or more of its beats name a missing feature) goes to
    # A-roll whole: its remaining beats would show a menu/box for a step that cannot happen (C1/C2)
    for si in {r["seg"] for r in ledger}:
        rows = [r for r in ledger if r["seg"] == si and r.get("word_id") is not None]
        gone = [r for r in rows if r["route"] == "aroll" and r.get("feature_missing")]
        if rows and len(gone) * 2 >= len(rows):
            for r in rows:
                if r["route"] in ("keep", "rewrite"):
                    r.update(route="aroll", why=f"the scene's feature does not exist ({gone[0]['why'][:80]}…) — the whole "
                             "scene stays on the presenter")
    return ledger


# ────────────────────────────── structure ──────────────────────────────

def _runs(U, pred):
    out, cur = [], []
    for u in U:
        if pred(u):
            cur.append(u)
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def _dur(run):
    return run[-1]["next_t0"] - run[0]["t0"]


def _split_run(run, target=SPAN_TARGET, lo=10.0, hi=18.0, blk=AROLL_BEAT, relax=False):
    """Choose A-roll blocks (whole units, 5-7 s, sentence starts first, no beat cue inside) that cut a
    long screencast run into pieces of ~target s. → list of unit lists that become A-roll."""
    blocks, pos = [], run[0]["t0"]
    end = run[-1]["next_t0"]
    k0 = 0
    while end - pos > (hi if not relax else SPAN_MAX):
        best, best_c = None, 1e9
        for a in range(max(1, k0), len(run) - 1):
            if run[a]["t0"] - pos < (lo if not relax else 6.0):
                continue
            if run[a]["t0"] - pos > (hi if not relax else SPAN_MAX):
                break
            for b in range(a, len(run) - 1):
                d = run[b]["next_t0"] - run[a]["t0"]
                if d > blk[1] + (2.0 if relax else 0.5):
                    break
                if d < blk[0] - (2.0 if relax else 0.5):
                    continue
                tail = end - run[b]["next_t0"]
                if tail < (lo if not relax else 6.0):
                    continue
                part = run[a:b + 1]
                if any(u.get("acts") for u in part):
                    continue                           # an on-screen action beat never goes to A-roll
                cost = (6 * sum(u.get("cues", 0) for u in part) + 3 * sum(u["act"] for u in part) + abs(d - BLOCK_AIM)
                        + 0.5 * abs(run[a]["t0"] - pos - target) + (0 if blk[0] <= d <= blk[1] else 4)
                        + (0 if run[a]["sentence_start"] else 2) + 20 * sum(u.get("forced", False) for u in part))
                if cost < best_c:
                    best, best_c = (a, b), cost
        if not best:
            break
        a, b = best
        blocks.append(run[a:b + 1])
        pos = run[b]["next_t0"]
        k0 = b + 1
    return blocks


def _run_at(U, k):
    lab = U[k]["label"]
    a = k
    while a > 0 and U[a - 1]["label"] == lab:
        a -= 1
    b = k
    while b + 1 < len(U) and U[b + 1]["label"] == lab:
        b += 1
    return U[a:b + 1]


def structure_stats(U, duration):
    S = [_dur(r) for r in _runs(U, lambda u: u["label"] == "S")]
    A = [_dur(r) for r in _runs(U, lambda u: u["label"] == "A")]
    P = [_dur(r) for r in _runs(U, lambda u: u["label"] == "P")]
    bounds = sum(1 for x, y in zip(U, U[1:]) if (x["label"] == "S") != (y["label"] == "S"))
    return {"spans": len(S), "span_p50": round(statistics.median(S), 2) if S else 0.0,
            "span_max": round(max(S), 2) if S else 0.0, "span_min": round(min(S), 2) if S else 0.0,
            "aroll_blocks": len(A), "aroll_p50": round(statistics.median(A), 2) if A else 0.0,
            "share": round(sum(S) / duration, 4) if duration else 0.0,
            "plate_s": round(sum(P), 2), "plate_frac": round(sum(P) / duration, 4) if duration else 0.0,
            "bounds_per_min": round(bounds / (duration / 60.0), 2) if duration else 0.0,
            "spans_s": [round(x, 1) for x in S], "aroll_s": [round(x, 1) for x in A],
            "band": {"span_p50": SPAN_P50, "span_max": SPAN_MAX, "aroll_beat": AROLL_BEAT, "share": SHARE,
                     "bounds_per_min": BOUNDS_PER_MIN, "plate_max_frac": PLATE_MAX_FRAC,
                     "source": "REFERENCE-BASELINE §1a/§1b (refs r2-r5)"}}


def shape(U, duration, long_form=True):
    """Label units S (screencast) / A (A-roll) / P (plate) to the reference structure.
    In: u["label"] from the plan, u["hard"] (presenter), u["forced"] (an unshowable beat), u["seg"]."""
    # P4: a span shorter than 2.5 s is not created
    for r in _runs(U, lambda u: u["label"] == "S"):
        if _dur(r) < MIN_SPAN:
            for u in r:
                u.update(label="A", why="span < 2.5 s (P4)")
    if long_form:
        # FILL: an A-roll stretch longer than an A-roll beat keeps one 5-7 s beat (or its presenter
        # lines); the rest joins the neighbouring screencast (results held, BASELINE §3). Lines that name a
        # produced asset ("here's the one I'm using…") go to the screen first (C1).
        for r in _runs(U, lambda u: u["label"] == "A"):
            if any(u.get("instruction") or u.get("pacing") for u in r):
                continue
            if _dur(r) <= AROLL_BEAT[1] + 0.5:
                if all(u.get("shows") and not u["hard"] and not u.get("forced") for u in r):
                    a, b = len(r), len(r) - 1          # all of it names a produced asset: no A-roll beat
                else:
                    continue
            else:
                hard = [n for n, u in enumerate(r) if u["hard"] or u.get("forced")]
                if hard:
                    a, b = hard[0], hard[-1]
                else:
                    a = b = 0
                    free = [n for n, u in enumerate(r) if not u.get("shows")]
                    win = None
                    for x in free:                     # the first window without asset lines that is long enough
                        y = x
                        while y + 1 < len(r) and not r[y + 1].get("shows") and r[y]["next_t0"] - r[x]["t0"] < AROLL_BEAT[0]:
                            y += 1
                        if r[y]["next_t0"] - r[x]["t0"] >= AROLL_BEAT[0] - 2.0:
                            win = (x, y)
                            break
                    if win:
                        a, b = win
                while r[b]["next_t0"] - r[a]["t0"] < AROLL_BEAT[0] - 2.0 and (b + 1 < len(r) or a > 0):
                    if b + 1 < len(r):
                        b += 1
                    else:
                        a -= 1
            k_first, k_last = r[0]["k"], r[-1]["k"]
            prev_seg = U[k_first - 1].get("seg") if k_first > 0 and U[k_first - 1]["label"] == "S" else None
            next_seg = U[k_last + 1].get("seg") if k_last + 1 < len(U) and U[k_last + 1]["label"] == "S" else None
            for n, u in enumerate(r):
                if a <= n <= b or u["hard"] or u.get("forced"):
                    continue
                before = n < a
                seg = (prev_seg if prev_seg is not None else next_seg) if before else \
                    (next_seg if next_seg is not None else prev_seg)
                if seg is None:
                    continue
                u.update(label="S", seg=seg, fill=True,
                         fill_dir="prev" if seg == prev_seg and (before or next_seg is None) else "next")
    def share():
        return sum(_dur(r) for r in _runs(U, lambda u: u["label"] == "S")) / duration

    def spans():
        return [_dur(r) for r in _runs(U, lambda u: u["label"] == "S")]

    def cut(blk, on=True):
        for u in blk:
            u.update(label="A" if on else "S", pacing=on)

    # SPLIT: a run over the p50 band gets 5-7 s A-roll beats at sentence starts; pieces may be short
    # (refs p10 = 3-4 s); a run over 30 s is split whatever it costs
    for r in _runs(U, lambda u: u["label"] == "S"):
        if _dur(r) > SPAN_P50[1]:
            for blk in _split_run(r, target=12.0, lo=6.0, hi=SPAN_P50[1]):
                cut(blk)
    for r in _runs(U, lambda u: u["label"] == "S"):
        if _dur(r) > SPAN_MAX:
            for blk in _split_run(r, relax=True):
                cut(blk)
    if long_form:
        # SHARE up: merge a pacing beat back — the one whose merged span is the LONGEST still <= 30 s, so
        # the short spans stay short (refs: p50 10-18 s, p90 25-72 s)
        guard = 0
        while share() < SHARE[0] and guard < 200:
            guard += 1
            best, best_c = None, -1.0
            for r in _runs(U, lambda u: u["label"] == "A"):
                if not all(u.get("pacing") for u in r):
                    continue
                k0, k1 = r[0]["k"], r[-1]["k"]
                lt = _dur(_run_at(U, k0 - 1)) if k0 > 0 and U[k0 - 1]["label"] == "S" else 0.0
                rt = _dur(_run_at(U, k1 + 1)) if k1 + 1 < len(U) and U[k1 + 1]["label"] == "S" else 0.0
                merged = lt + _dur(r) + rt
                if merged <= SPAN_MAX and merged > best_c:
                    best, best_c = r, merged
            if not best:
                break
            cut(best, on=False)
        # SHARE down: more beats inside the longest runs
        guard = 0
        while share() > SHARE[1] and guard < 50:
            guard += 1
            for r in sorted(_runs(U, lambda u: u["label"] == "S"), key=_dur, reverse=True):
                blks = _split_run(r, target=12.0, lo=6.0, hi=max(12.0, _dur(r) - 11.0))
                if blks:
                    cut(blks[0])
                    break
            else:
                break
        # MEDIAN: while the span median is over the band, split the shortest run above it once — only
        # while the share stays in its band
        guard = 0
        while spans() and statistics.median(spans()) > SPAN_P50[1] and guard < 60:
            guard += 1
            done = False
            for r in sorted([r for r in _runs(U, lambda u: u["label"] == "S") if _dur(r) > SPAN_P50[1]], key=_dur):
                blks = _split_run(r, target=_dur(r) / 2 - 2.6, lo=4.0, hi=_dur(r) - 4.0)
                if not blks:
                    continue
                cut(blks[0])
                if share() >= SHARE[0]:
                    done = True
                    break
                cut(blks[0], on=False)
            if not done:
                break
    for r in _runs(U, lambda u: u["label"] == "S"):
        if _dur(r) < MIN_SPAN:
            for u in r:
                u.update(label="A", why="span < 2.5 s (P4)")
    return U


def hook_plate(U, video, facts):
    """BASELINE §1a: when the first 40 s point at a thing, a TX07/TX09 plate shows it (produced asset).
    Plates stay <= 1.5 % of runtime and inside the first 40 s. → plate dict | None (labels the units P)."""
    dur = video["duration"]
    cap = min(PLATE_MAX_FRAC * dur, HOOK_S)
    first = next((u for u in U if u["t0"] < HOOK_S and POINT_RE.search(u["text"]) and u["label"] != "S" and not u["hard"]), None)
    if not first:
        return None
    t0 = max(0.0, first["t0"] - LEAD) if first["t0"] - LEAD > 2.5 else 0.0
    take = []
    for u in U[first["k"]:]:
        if u["label"] == "S" or u["hard"] or u["next_t0"] - t0 > cap + 0.25 or u["t0"] >= HOOK_S:
            break
        take.append(u)
    t1 = take[-1]["next_t0"] - LEAD if take else min(first["next_t0"], t0 + cap) - LEAD
    t1 = min(t1, t0 + cap, HOOK_S)
    for u in take:
        u["label"] = "P"
    txt = " ".join(u["text"] for u in (take or [first]))
    two = bool(re.search(r"\bon the left\b", txt, re.I) and re.search(r"\bon the right\b", txt, re.I))
    kinds = {"sketch": 0, "photo": 1, "element": 1, "app_generation": 2}
    shown = sorted([a for a in facts.usable_assets() if a.get("kind") in kinds], key=lambda a: kinds[a["kind"]])
    if two and len(shown) > 2:
        shown = [shown[0], shown[-1]]                 # left = the input, right = what came back
    elif not two:
        shown = shown[-1:]
    ws = [w for w in video["words"] if t0 - 0.01 <= w["start"] < t1]
    return {"kind": "plate", "technique": "TX09" if two else "TX07", "t0": round(t0, 3), "t1": round(t1, 3),
            "start": ws[0]["i"] if ws else None, "end": ws[-1]["i"] if ws else None,
            "layout": "side_by_side" if two else "single", "assets": [a["id"] for a in shown],
            "missing": [] if shown else ["no produced asset to show — pre-production must make it"],
            "words": txt[:200],
            "why": "the hook points at a thing ('look at this', 'on the left/right'): the plate shows it "
                   "(BASELINE §1a: r2 0:07-0:11, r3 0:04, r5 0:12; plates <= 1.5 % and only in the first 40 s)"}


def _label(segments, video, facts, windows, aroll_why):
    """Units labelled from the plan + the ledger's routes; the instructional A-roll stretches it left."""
    ws = video["words"]
    pos = {w["i"]: n for n, w in enumerate(ws)}
    U = units(video, windows)
    ledger = build_ledger(segments, video, facts)
    uk = {i: u for u in U for i in u["ids"]}
    # a unit is screencast when a segment covers most of it
    for u in U:
        u.update(label="A", seg=None)
        for si, s in enumerate(segments):
            a, b = ws[pos[s["start"]]]["start"], ws[pos[s["end"]]]["end"]
            cov = max(0.0, min(b, u["t1"]) - max(a, u["t0"]))
            if cov >= 0.5 * max(0.01, u["t1"] - u["t0"]):
                u.update(label="S", seg=si)
                break
        if u["hard"]:
            u["label"] = "A"
    if not facts.empty:
        for u in U:
            hit = next((facts.find_object(o) for o in scan_objects(u["text"])), None)
            if hit and not hit.startswith("live:"):
                u["shows"] = hit                       # he talks about a produced picture
    # a keep beat is a cue the structure must not hide; an unshowable beat forces its unit to A-roll
    for b in ledger:
        u = uk.get(b.get("word_id"))
        if not u:
            continue
        if b["route"] == "aroll":
            u["forced"] = True
            u["label"] = "A"
        elif b["route"] in ("keep", "rewrite", "public"):
            u["cues"] = u.get("cues", 0) + 1
            if b["action"] in ("click", "type", "drag", "upload", "dissolve", "cut", "scroll"):
                u["acts"] = u.get("acts", 0) + 1     # an on-screen ACTION never goes to A-roll for pacing
    # instructional A-roll stretches the plan left (G2 spec 5: a segment or an explicit why)
    stretches = []
    for r in _runs(U, lambda u: u["label"] == "A" and not u["hard"]):
        if _dur(r) >= 8.0 and any(u["act"] for u in r):
            ks = [n for n, u in enumerate(r) if u["act"] and not u.get("forced")]
            if not ks:
                continue
            part = r[ks[0]:ks[-1] + 1]
            txt = " ".join(u["text"] for u in part)
            given = next((x.get("why") for x in (aroll_why or []) if x.get("why")
                          and pos.get(x.get("start"), -1) <= pos[part[-1]["ids"][-1]]
                          and pos.get(x.get("end"), -1) >= pos[part[0]["ids"][0]]), None)
            for u in part:
                u["instruction"] = True
            stretches.append({"t0": round(part[0]["t0"], 3), "t1": round(part[-1]["t1"], 3),
                              "start": part[0]["ids"][0], "end": part[-1]["ids"][-1],
                              "verbs": sorted({m.lower() for m in ACTION_RE.findall(txt)}), "words": txt[:240],
                              "segment": None,
                              "why": given or ("the director planned no screencast for this instructional stretch and gave "
                                               "no reason, and the narration names no step the account + produced assets can "
                                               "show — kept on the presenter (C2)")})
    return U, ledger, uk, stretches


UPLOAD_CLAUSE = re.compile(r"\b(upload|drag)\w*\b", re.I)


def compile_instruction(x, video, facts, site_url):
    """The deterministic fallback for an instructional stretch the director left on the presenter:
    each 'upload …' step he says becomes a beat that uploads a PRODUCED asset (feature 'upload' must
    exist). Nothing is invented: no prompt text is made up, no unknown control is clicked.
    → a raw segment {start, end, url, intent, auto} | None."""
    if not site_url or not facts.feature_exists("upload"):
        return None
    imgs = [a for a in facts.usable_assets() if a.get("kind") in ("photo", "element", "app_generation", "sketch")]
    if not imgs:
        return None
    ws = video["words"]
    pos = {w["i"]: n for n, w in enumerate(ws)}
    part = ws[pos[x["start"]]:pos[x["end"]] + 1]
    beats, used = [], 0
    for k, w in enumerate(part):
        if UPLOAD_CLAUSE.match(norm(w["word"])) and used < len(imgs):
            a = imgs[used]
            cue = " ".join(v["word"] for v in part[k:k + 3]).strip(",.")
            body = (f"{'a fresh chat; ' if not beats else ''}upload the produced {a['id']} ({a.get('desc', '')[:60]}) — its "
                    "thumbnail lands above the message box, zoomed out (CUT01)")
            beats.append(f"on '{cue}': {body}")
            used += 1
    if not beats:
        return None
    return {"start": x["start"], "end": x["end"], "url": site_url, "auto": "compiled from the narration",
            "intent": "; ".join(beats) + "; nothing is sent."}


def fit(segments, video, facts, aroll_why=None, site_url=None):
    """The whole fit: ledger + checks + hook plate + reference structure.
    segments: the director's raw segments {start, end, url, intent} (word ids already checked).
    → {"segments", "plates", "beats", "objects", "dropped", "aroll_actions", "structure", "units"}"""
    ws = video["words"]
    dur = video["duration"]
    pos = {w["i"]: n for n, w in enumerate(ws)}
    windows = presenter_windows(video)
    segments = list(segments)
    U, ledger, uk, aroll_actions = _label(segments, video, facts, windows, aroll_why)
    if not facts.empty:
        extra = [c for c in (compile_instruction(x, video, facts, site_url) for x in aroll_actions) if c]
        if extra:
            segments = sorted(segments + extra, key=lambda s: pos[s["start"]])
            covered = [(x, next(n for n, s in enumerate(segments) if s is c)) for x in aroll_actions for c in extra
                       if c["start"] == x["start"]]
            U, ledger, uk, left = _label(segments, video, facts, windows, aroll_why)
            aroll_actions = left + [{**x, "why": None, "compiled": True} for x, _ in covered]
    plate = hook_plate(U, video, facts)
    shape(U, dur, long_form=dur >= LONG_STRUCTURE_S)
    # beats whose word ended up on A-roll for pacing are reported (the cost function avoids it)
    dropped = []
    for b in ledger:
        u = uk.get(b.get("word_id"))
        if b["route"] in ("keep", "rewrite", "public") and u and u["label"] != "S":
            b.update(route="aroll", why="its sentence became an A-roll beat (span structure, BASELINE §1b)"
                     + (f"; before: {b['why']}" if b.get("why") else ""))
        if b["route"] in ("aroll", "drop"):
            dropped.append({"seg": b["seg"], "cue": b["cue"], "dropped": b["why"]})
    # screencast pieces: one per (run, original segment, session)
    out = []
    for r in _runs(U, lambda u: u["label"] == "S"):
        pieces, cur = [], []
        for u in r:
            sess = _session_at(u, ledger, cur[-1].get("sess") if cur else None)
            u["sess"] = sess
            if cur and (u["seg"] != cur[-1]["seg"] or sess != cur[-1]["sess"]):
                pieces.append(cur)
                cur = []
            cur.append(u)
        if cur:
            pieces.append(cur)
        for p in pieces:
            out.append(_piece(p, segments, ledger, video, len(out)))
    for k, s in enumerate(out):
        s["t1"] = round(min(dur, s["t1"]), 3)
    # instructional stretches that ended up inside a screencast are covered
    for x in aroll_actions:
        seg = next((n for n, s in enumerate(out) if s["t0"] <= x["t0"] + 0.5 and x["t1"] - 0.5 <= s["t1"]), None)
        if seg is None and x.get("compiled"):
            seg = next((n for n, s in enumerate(out) if s["t0"] < x["t1"] and x["t0"] < s["t1"]), None)
        if seg is not None:
            x.update(segment=seg, why=None)
        elif not x.get("why"):
            x["why"] = "its compiled screencast did not survive the span structure — kept on the presenter"
    objects = {}
    for b in ledger:
        for o, a in (b.get("objects") or {}).items():
            e = objects.setdefault(o, {"asset": None, "beats": []})
            e["beats"].append(f"seg-{b['seg']:02d} '{b['cue']}'")
            if a and not e["asset"]:
                e["asset"] = a
    for o, e in objects.items():
        e["status"] = "in_asset" if e["asset"] and not e["asset"].startswith("live:") else \
            "made_on_camera" if e["asset"] else "missing"
    stats = structure_stats(U, dur)
    return {"segments": out, "plates": [plate] if plate else [], "beats": ledger, "objects": objects,
            "dropped": dropped, "aroll_actions": aroll_actions, "structure": stats,
            "units": [{"t0": round(u["t0"], 2), "label": u["label"], "seg": u.get("seg"),
                       **({"why": "presenter"} if u["hard"] else {}), **({"pacing": True} if u.get("pacing") else {}),
                       **({"fill": True} if u.get("fill") else {}), **({"forced": True} if u.get("forced") else {})}
                      for u in U]}


def _session_at(u, ledger, prev):
    """A public (logged-out) beat runs from its word until the next logged-in beat of the same segment."""
    bs = [b for b in ledger if b["seg"] == u["seg"] and b.get("t_word") is not None
          and b["route"] in ("keep", "rewrite", "public")]
    cur = None
    for b in sorted(bs, key=lambda b: b["t_word"]):
        if b["t_word"] < u["next_t0"] - 0.05 and (b["t_word"] < u["t0"] + 0.05 or cur is None and b["t_word"] < u["t1"]):
            cur = "public" if b["route"] == "public" else "app"
        if b["t_word"] >= u["t0"] - 0.05 and b["t_word"] < u["next_t0"]:
            cur = "public" if b["route"] == "public" else "app"
            break
    return cur or prev or "app"


def _piece(p, segments, ledger, video, n):
    s = segments[p[0]["seg"]]
    t0 = max(0.0, p[0]["t0"] - LEAD)
    t1 = p[-1]["next_t0"] - LEAD if p[-1]["next_t0"] < video["duration"] else p[-1]["t1"] + 0.35
    mine = [b for b in ledger if b["seg"] == p[0]["seg"] and b["route"] in ("keep", "rewrite", "public")
            and b.get("t_word") is not None and t0 - 0.05 <= b["t_word"] < t1]
    earlier = [b for b in ledger if b["seg"] == p[0]["seg"] and b.get("t_word") is not None and b["t_word"] < t0
               and b["route"] in ("keep", "rewrite", "public")]
    pre, _ = parse_intent(s.get("intent"))
    lead = []
    if pre:
        lead.append(pre)
    if earlier:
        lb = earlier[-1]
        lead.append(f"Continues the same scene: opens on the state after '{lb['cue']}' ({lb['body'][:140]}), "
                    "already framed (CUT06).")
    first = next((u for u in p if u["t1"] - u["t0"] >= 0.3), p[0])
    if any(u.get("fill") and u.get("fill_dir") == "next" for u in p[:1]):
        lead.append(f"on '{video_word(video, first['ids'][0])}': this scene's opening screen (its first beat's "
                    "subject) is already up, slow centred push (M5/ZM10) until the first beat")
    elif not mine:
        lead.append(f"on '{video_word(video, first['ids'][0])}': the last result/screen of this scene held, slow "
                    "centred push (M5/ZM10) — nothing new is shown")
    intent = "; ".join(x.strip().rstrip(";") for x in lead + [f"on '{b['cue']}': {b['body']}" for b in mine] if x.strip())
    sess = p[0].get("sess", "app")
    url = s.get("url")
    pub = next((b for b in mine if b["route"] == "public"), None)
    if sess == "public" and pub:
        url = pub.get("url") or url
    seg = {"start": p[0]["ids"][0], "end": p[-1]["ids"][-1], "url": url, "intent": intent,
           "t0": round(t0, 3), "t1": round(t1, 3), "part_of": p[0]["seg"],
           "beats": [{k: b.get(k) for k in ("cue", "word_id", "t_word", "clause_start", "subject", "technique_id",
                                            "action", "must_text", "typed_text", "result_assertion", "route")} for b in mine]}
    if any(u.get("fill") for u in p):
        seg["fill"] = round(sum(u["dur"] for u in p if u.get("fill")), 2)
    if sess == "public" and pub:
        seg["session"] = pub["session"]
    return seg


def video_word(video, i):
    return next((w["word"] for w in video["words"] if w["i"] == i), "")
