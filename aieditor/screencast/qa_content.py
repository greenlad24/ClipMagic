"""Content QA — does the screen show what the narration names, when it names it, in the right brand?

    python3 qa_content.py <edit-NN dir> <expect.json> [--out qa_content.json]

Why (loop round 1, 2026-10-07): v12 scored 95.2 on qa.py (geometry: where content edges sit) while an
independent frame review found 9 high-severity errors — a coffee brand shown for "my colors / my logo",
a garbled prompt, a logged-in Home instead of the sign-up page, beats 1–3 s late or never framed. None
of that is geometry. This checks, per segment, from the recorder's own log (events.json: every beat
records `at` = the word, the page title/url and the DOM text inside the framed box, a typed field's
final value) and the camera plan (camera.json moves):

  delivered   every scripted beat (beats.json) ran without an error — no silently dropped beat
  on_word     the camera view at (word + 0.3 s) contains ≥ 90 % of the beat's box, centred within 0.2 of
              the view (an edge the view is clamped against excused) — "the thing he names, as he names it"
  late_s      when the view first satisfies that, minus the word time (≤ 0.4 s passes)
  nav_on_word a page change (goto / navigating click) lands within 0.15 s of its word
  brand       no event's title / framed text contains a forbidden string (expect["forbid"], e.g. another
              company's brand used as "my logo")
  must        a beat's title / framed text / url contains one of expect["beats"][...]["must"]
  typed       a typed field holds EXACTLY the scripted text (a stale draft + new text = garbled)

expect.json: {"forbid": ["Blue Bottle"], "segments": {"0": [{"at": 3.39, "must": ["Jake Dawson"]}, ...]}}
(`at` = segment-relative word time of the beat the requirement belongs to, matched within 0.05 s.)
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import camera  # noqa: E402


CENTRE_TOL = 0.08     # ROUND 2 ruling (review round 1 D1): target centre within 0.08 of the frame centre


def view_ok(view, box, W, H, zoom_want, real_edges=True):
    z, cx, cy = view
    vw, vh = W / z, H / z
    x0, y0 = cx - vw / 2, cy - vh / 2
    bx, by, bw, bh = box
    ix = max(0, min(bx + bw, x0 + vw) - max(bx, x0))
    iy = max(0, min(by + bh, y0 + vh) - max(by, y0))
    inside = ix * iy / max(1, bw * bh)
    # a box bigger than the view counts as inside when it fills the view
    if bw > vw or bh > vh:
        inside = max(inside, ix * iy / (vw * vh))
    dx = (bx + bw / 2 - cx) / vw
    dy = (by + bh / 2 - cy) / vh
    # clamped against a capture edge in that direction: the subject may sit off-centre (refs clamp)
    # ...but only at a REAL page edge: a design canvas scrolls, so its capture edge is no excuse
    if real_edges and ((dx < 0 and x0 <= 1) or (dx > 0 and x0 + vw >= W - 1)):
        dx = 0
    if real_edges and ((dy < 0 and y0 <= 1) or (dy > 0 and y0 + vh >= H - 1)):
        dy = 0
    zok = zoom_want is None or z >= 0.9 * min(zoom_want, 2.0) or zoom_want <= 1.0
    return inside >= 0.9 and abs(dx) <= CENTRE_TOL and abs(dy) <= CENTRE_TOL and zok, {"inside": round(inside, 2), "dx": round(dx, 2),
                                                                        "dy": round(dy, 2), "zoom": round(z, 2)}


def check_segment(sd, clip_cam, exp_beats, forbid):
    ev = json.load(open(sd / "rec" / "events.json"))
    beats = json.load(open(sd / "rec" / "beats.json")) if (sd / "rec" / "beats.json").exists() else []
    cam = json.load(open(clip_cam)) if clip_cam and Path(clip_cam).exists() else None
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    fps = ev["capture"]["fps"]
    p = camera.params()
    eases = camera.make_eases(p)
    out = []
    for b in beats:
        a, r = b["action"], b["result"]
        if not r.get("ok"):
            out.append({"check": "delivered", "ok": False, "beat": a.get("type"), "at": a.get("at"), "why": r.get("error")})
    focus = [e for e in ev["events"] if e.get("at") is not None and e.get("beat") and e.get("box")]
    for e in focus:
        at = e["at"]
        if cam:
            # a navigating click is judged just before its page changes
            nxt = 1e9
            if e["type"] in ("click", "dblclick") and e.get("press") is not None:
                nxt = min([x["t"] for x in ev["events"] if x["type"] in ("nav", "cut") and x.get("big", True)
                           and x["t"] >= e["press"] - 0.01 and x.get("why") != "late beat"] + [1e9])
            f = cam["f0"] + min(at + 0.3, nxt - 0.02) * fps
            # (a centre cut logged around the word is the beat's own landing — judged after it)
            own = [x["t"] for x in ev["events"] if x["type"] == "cut" and x.get("why") == "late beat" and abs(x["t"] - e["t"]) <= 0.6]
            if own:
                f = max(f, cam["f0"] + (max(own) + 0.05) * fps)
            v = camera.camera_at(cam["moves"], f, p, eases, W, H)
            real = "/file/" not in str(e.get("url", ""))
            ok, info = view_ok(v, e["box"], W, H, e.get("zoom"), real)
            late = None
            for k in range(0, int(3 * fps)):
                vv = camera.camera_at(cam["moves"], cam["f0"] + (at - 0.8) * fps + k, p, eases, W, H)
                if view_ok(vv, e["box"], W, H, e.get("zoom"), real)[0]:
                    late = round(-0.8 + k / fps, 2)
                    break
            out.append({"check": "on_word", "ok": ok and late is not None and late <= 0.4, "type": e["type"], "at": round(at, 2),
                        "late_s": late, **info})
    for e in ev["events"]:
        if e["type"] == "nav" and e.get("at") is not None:
            out.append({"check": "nav_on_word", "ok": abs(e["t"] - e["at"]) <= 0.15, "t": round(e["t"], 2), "at": e["at"]})
    # navs carry no "at" in the log: compare with the scripted goto
    navs = [e for e in ev["events"] if e["type"] == "nav"]
    gotos = [b["action"] for b in beats if b["action"]["type"] == "goto" or b["action"].get("goto")]
    for g, n in zip(gotos, navs):
        if g.get("at") is not None:
            out.append({"check": "nav_on_word", "ok": abs(n["t"] - g["at"]) <= 0.15 + 0.8 * bool(g.get("goto")),
                        "t": round(n["t"], 2), "at": g["at"], "url": n.get("url")})
    for e in ev["events"]:
        # what the viewer can read: the FRAMED text of a beat (a nav's whole-page text is not what is framed —
        # the Home Recents row is below the ×1.35 frame since round 2)
        keys = ("title",) if e["type"] == "nav" else ("title", "vis", "value", "text")
        txt = " ".join(str(e.get(k, "")) for k in keys)
        for bad in forbid:
            if bad.lower() in txt.lower():
                out.append({"check": "brand", "ok": False, "t": round(e["t"], 2), "type": e["type"], "found": bad,
                            "title": e.get("title")})
        if e["type"] == "type" and e.get("value") is not None:
            want = e.get("text", "")
            out.append({"check": "typed", "ok": e["value"].strip() == want.strip(), "value": e["value"][:120], "want": want})
    # GUARD (Jake 2026-10-08): no bot check / captcha page may ever be in a recording
    walls = [x for x in ev.get("walls", []) if x.get("kind") == "challenge"]
    out.append({"check": "no_challenge", "ok": not walls, "walls": walls[:3]})
    for e in ev["events"]:
        if re.search(r"just a moment|verify you are human|attention required", str(e.get("title", "")) + " " + str(e.get("vis", "")), re.I):
            out.append({"check": "no_challenge", "ok": False, "t": round(e["t"], 2), "title": e.get("title")})
    for req in exp_beats:
        hits = [e for e in ev["events"] if abs((e.get("at") if e.get("at") is not None else e["t"]) - req["at"]) <= 0.12]
        txt = " ".join(" ".join(str(e.get(k, "")) for k in ("title", "vis", "value", "url", "text")) for e in hits)
        ok = bool(hits) and any(m.lower() in txt.lower() for m in req["must"])
        out.append({"check": "must", "ok": ok, "at": req["at"], "must": req["must"], "seen": txt[:200]})
    return out


def main():
    edit, expect = Path(sys.argv[1]), json.load(open(sys.argv[2]))
    res = {}
    for sd in sorted(edit.glob("seg-[0-9][0-9]")):
        if not (sd / "rec" / "events.json").exists():
            continue
        i = int(sd.name[4:])
        cams = sorted(edit.glob(f"sc-{i:02d}-*.mp4.camera.json"))
        res[sd.name] = check_segment(sd, cams[0] if cams else None, expect.get("segments", {}).get(str(i), []),
                                     expect.get("forbid", []))
    allc = [c for v in res.values() for c in v]
    summary = {"checks": len(allc), "failed": sum(1 for c in allc if not c["ok"])}
    summary["verdict"] = "PASS" if summary["failed"] == 0 else "FAIL"   # ROUND 2: any failure fails the round
    by = {}
    for c in allc:
        k = c["check"]
        by.setdefault(k, [0, 0])
        by[k][0] += 1
        by[k][1] += 0 if c["ok"] else 1
    summary["by_check"] = {k: {"n": n, "failed": f} for k, (n, f) in by.items()}
    out = {"summary": summary, "segments": res}
    o = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    if o:
        json.dump(out, open(o, "w"), indent=1)
    print(json.dumps(summary, indent=1))
    for k, v in res.items():
        for c in v:
            if not c["ok"]:
                print(k, json.dumps(c)[:300])
    sys.exit(0 if summary["verdict"] == "PASS" else 1)


if __name__ == "__main__":
    main()
