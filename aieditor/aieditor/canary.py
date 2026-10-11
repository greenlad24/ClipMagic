"""THE WEEKLY CANARY (per app) — the self-healing layer's early warning (docs/SELF-HEALING.md).

An app's UI drifts weekly. A short, cheap job exercises ONE example of each failure class on the live app BEFORE a real
video meets the drift, and refreshes the 7-day recent-proofs ledger (onboard.recent_proven):

  D  run control     the Claude cap must fit the canary (headroom) before anything starts; $1.50 cap for the whole run
  B  asset fidelity  image production in the app's UI (Create image; an edit with an upload; Remove BG on the picture)
                     — <= 3 generations — and the asset audit on each result
  C  proofs          one replay of the newest learned actions (the ledger is refreshed for every one that still
                     replays) + the playbook audit
  A  UI drift        the preflight of 3 representative start states (home, an image chat, the never-logged-in US
                     pricing page) with the drift-repair agent, and ONE 5-second screencast recording

Queued by bin/aieditor-canary (request.json "canary": true, action "edit"): the worker sends it to a factory server like
any logged-in job (account lock, a profile COPY, the US route). The worker calls run() instead of the edit pipeline.
Report: <job>/canary-report.json (the Lab's Video factory panel shows the newest one as a status line).
Hard rules as everywhere: no image API; never Jake's chats or Library; no delete / buy / upgrade / billing / publish /
share / invite / log out; pricing only from the never-logged-in US route.
"""
import json
import os
import time
from pathlib import Path

from . import apiledger, config

CANARY_USD = 1.50
MAX_GENS = 3
APPS = {"chatgpt": {"site": "https://chatgpt.com/", "pricing": "https://chatgpt.com/pricing"}}
PHOTO = "an ordinary phone photo of a hot sauce bottle on a kitchen counter"
EDIT = "the same hot sauce bottle from the phone photo, now standing on a rustic wooden table in morning light"
CUTOUT = "Remove BG result: the hot sauce bottle from the phone photo, cut out"
TYPED = "A short canary prompt that is never sent"


def request(app="chatgpt", now=None):
    """The canary job's request.json (bin/aieditor-canary enqueue)."""
    a = APPS[app]
    return {"title": f"Weekly canary — {app}", "workflow": "creative", "canary": True, "app": app,
            "sites": [{"url": a["site"], "note": "weekly canary"}], "format": "long", "sponsored": False,
            "run_on": "factory", "created_by": "aieditor-canary",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now or time.time()))}


def enqueue(app="chatgpt", jobs=None, now=None):
    """A new canary job folder + its queue entry. → the job dir."""
    jobs = Path(jobs or config.JOBS)
    jid = f"canary-{app}-{time.strftime('%Y%m%d-%H%M', time.gmtime(now or time.time()))}"
    d = jobs / jid
    d.mkdir(parents=True, exist_ok=False)
    (d / "request.json").write_text(json.dumps(request(app, now), indent=1))
    (d / "status.json").write_text(json.dumps({"state": "queued", "message": "Weekly canary queued", "progress": 0,
                                               "stages": {}, "cost_usd": 0.0, "created_at": now or time.time()}, indent=1))
    (d / "queue.json").write_text(json.dumps({"action": "edit"}))
    return d


class Report:
    def __init__(self, app, jid):
        self.doc = {"app": app, "job": jid, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "checks": [], "classes": {k: "not run" for k in "ABCD"}, "generations": 0, "claude_usd": 0.0}

    def add(self, cls, name, ok, detail="", skipped=False):
        self.doc["checks"].append({"cls": cls, "check": name, "ok": bool(ok) if not skipped else None,
                                   "skipped": bool(skipped), "detail": str(detail)[:400]})
        rows = [c for c in self.doc["checks"] if c["cls"] == cls]
        if any(c["ok"] is False for c in rows):
            self.doc["classes"][cls] = "fail"
        elif any(c["ok"] for c in rows):
            self.doc["classes"][cls] = "ok"
        else:
            self.doc["classes"][cls] = "skipped"

    def summary(self):
        c = self.doc["classes"]
        mark = {"ok": "✓", "fail": "✗", "skipped": "–", "not run": "–"}
        fails = [x for x in self.doc["checks"] if x["ok"] is False]
        return (f"Canary {self.doc['app']}: " + " ".join(f"{k} {mark[c[k]]}" for k in "ABCD")
                + f" — ${self.doc['claude_usd']:.2f} Claude, {self.doc['generations']} generation(s)"
                + (f"; first problem: {fails[0]['check']} — {fails[0]['detail'][:120]}" if fails else ""))


def _spent(jid):
    return round(apiledger.job_total(jid), 4)


def _gens(app, jid):
    from . import genledger
    return sum(1 for r in genledger.all_rows(app) if r.get("job") == jid and r.get("kind") == "gen")


def _words(n=14, step=0.36):
    ws = "this is the weekly canary we type a short prompt here and never send it at all".split()
    return [{"i": i, "word": ws[i % len(ws)], "start": round(0.2 + i * step, 3), "end": round(0.2 + i * step + 0.28, 3)}
            for i in range(n)]


def run(d, req, log=print, progress=lambda m, f=None: None, cancelled=lambda: False, ctx_factory=None,
        session_factory=None, recorder_factory=None):
    """The canary, start to finish (on a factory server). Never raises for a failed check — every outcome is a row of
    the report; only a cancel or the cap stops it. → the report dict ("summary" included)."""
    from . import onboard, preflight, preprod
    d = Path(d)
    app = req.get("app") or "chatgpt"
    site = APPS.get(app, {}).get("site") or (req.get("sites") or [{}])[0].get("url")
    jid = d.name
    rep = Report(app, jid)
    out = d / "preprod"
    out.mkdir(parents=True, exist_ok=True)
    old_cap = os.environ.get(apiledger.ENV_JOB_CAP)
    os.environ[apiledger.ENV_JOB_CAP] = str(CANARY_USD)            # the canary's own Claude cap (process-local)
    t0 = time.time()

    def budget_left():
        return CANARY_USD - _spent(jid)
    try:
        # ── D: the cap headroom, before anything starts ──
        try:
            est = preflight.headroom(jid, 4, per_need_usd=0.25, workflow="creative")
            rep.add("D", "Claude cap headroom", True, f"${est:.2f} estimate fits")
        except apiledger.BudgetExceeded as e:
            rep.add("D", "Claude cap headroom", False, str(e))
            return _finish(d, rep, log, t0)
        progress("Canary: making pictures in the app…", 0.1)
        ctx = (ctx_factory or _live_ctx)(d, out, app, site, req, log, progress, cancelled)
        if getattr(ctx, "producer", None) is not None:
            ctx.producer.max_tries = 1                               # <= 1 generation per picture
            ctx.producer.tool_tries = 1
        # ── B: image production in the app's UI (<= 3 generations) + the asset audit ──
        made = {}
        for aid, desc, src in (("canary_photo", PHOTO, ()), ("canary_edit", EDIT, ("canary_photo",)),
                               ("canary_cutout", CUTOUT, ("canary_photo",))):
            if cancelled():
                raise InterruptedError("cancelled")
            if _gens(app, jid) >= MAX_GENS or budget_left() < 0.15:
                rep.add("B", f"make {aid}", None, "skipped: generation / Claude budget", skipped=True)
                continue
            if src and not all(made.get(s) for s in src):
                rep.add("B", f"make {aid}", None, f"skipped: its source {src[0]} was not made", skipped=True)
                continue
            try:
                row = onboard.produce_asset(ctx, aid, desc, made_from=src)
            except Exception as e:  # noqa: BLE001 — QuotaWait (the app's cap / a wall) is a finding too
                row = {"status": "failed", "why": f"{type(e).__name__}: {e}"}
            ok = row.get("status") == "ready"
            probs = preflight.audit_asset(row, (), getattr(ctx.producer, "tool_of", None) if ctx.producer else None,
                                          ctx.producer.tools() if ctx.producer else None) if ok else []
            via = (row.get("source") or {}).get("route") or row.get("why")
            rep.add("B", f"make {aid}", ok and not probs, "; ".join(p["why"] for p in probs) or via)
            if ok:
                made[aid] = row
        rep.doc["generations"] = _gens(app, jid)
        # ── C: one replay of the newest learned actions (refreshes the 7-day ledger) + the playbook audit ──
        progress("Canary: replaying learned actions…", 0.4)
        seen, n_ok = set(), 0
        rows = []
        try:
            for line in open(onboard._proven_lib()):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("app") == app and time.time() - float(r.get("ts") or 0) <= onboard.RECENT_DAYS * 86400:
                    rows.append(r)
        except OSError:
            pass
        for r in sorted(rows, key=lambda x: -float(x.get("ts") or 0)):
            if r.get("key") in seen or len(seen) >= 4:
                continue
            seen.add(r.get("key"))
            act = dict(r.get("action") or {})
            if not act or act.get("generates"):
                continue
            ctx.pb["actions"][r["aid"]] = act
            prm = {"chat_url": (made.get("canary_photo") or {}).get("source", {}).get("chat_url") or ctx.image_chat}
            try:
                pr = onboard.prove(ctx, r["aid"], {k: v for k, v in prm.items() if v}, n=1)
                ok, why = pr["proven"], "; ".join(str(x.get("why")) for x in pr["replays"] if not x["ok"])
            except Exception as e:  # noqa: BLE001
                ok, why = False, str(e)
            if ok:
                n_ok += 1
                onboard.remember_proven(ctx, r.get("need"), r["aid"], act)          # the ledger stays fresh
            rep.add("C", f"replay learned '{str(r.get('need'))[:60]}'", ok, why or "replays (ledger refreshed)")
        if not seen:
            rep.add("C", "replay learned actions", None, "no action proven in the last 7 days", skipped=True)
        aud = preflight.audit_playbook(ctx.pb)
        bad = [f for f in aud if f["rule"] in ("requires_unknown", "need_folds_send")]
        rep.add("C", "playbook audit", not bad, "; ".join(f"{f['action']}: {f['why']}" for f in bad)[:300] or f"{len(aud)} note(s)")
        # ── A: the preflight of 3 start states + ONE 5-second screencast ──
        progress("Canary: preflight of the start states…", 0.6)
        pb = ctx.pb
        segs = []
        for name, url, kind in (("home", pb["start_state"]["url"], "logged_in"),
                                ("image chat", (made.get("canary_photo") or {}).get("source", {}).get("chat_url"), "logged_in"),
                                ("logged-out pricing (US route)", APPS.get(app, {}).get("pricing"), "outside")):
            if not url:
                rep.add("A", f"start state: {name}", None, "skipped: no picture chat was made", skipped=True)
                continue
            from . import usroute
            if kind == "outside" and not usroute.route_for_job():
                rep.add("A", f"start state: {name}", None, "skipped: no US route (pricing never goes out through Singapore)",
                        skipped=True)
                continue
            segs.append({"name": name, "t0": 0.3, "t1": 4.0, "url": url, "app": app, "session": kind,
                         "beats": [{"id": f"cn{len(segs)}b0", "word_id": 1, "t_word": 0.56, "word": "is", "action": "camera",
                                    "subject": "screen"}]})
        new_session = session_factory or _live_sessions(d, app, cancelled)
        from . import drift
        pf = preflight.RecordingPreflight(d / "canary-preflight", segs, {app: pb}, {"assets": list(made.values())}, _words(),
                                          new_session, repairer=drift.Repairer(budget=drift.Budget(cap=max(0.0, min(0.6, budget_left()))),
                                                                               log=log),
                                          log=log, cancelled=cancelled,
                                          allowed_chats=[(m.get("source") or {}).get("chat_url") for m in made.values()])
        pf.min_systematic = 1                       # the canary repairs a drift seen on ONE start state
        res = pf.run()                              # its browsers stay open for the recording (closed at the end)
        for i, s in enumerate(segs):
            r = (res.get("segments") or {}).get(str(i)) or {}
            fixed = next((x for x in res.get("repairs") or [] if i in x.get("segments", []) and x.get("accepted")), None)
            rep.add("A", f"start state: {s['name']}", r.get("ok"),
                    ("drift repaired: " + json.dumps(fixed.get("patch"))[:200] if fixed else "")
                    or "; ".join(r.get("reasons") or [])[:300] or "clean first frame")
        rep.doc["drift"] = [{k: x.get(k) for k in ("cluster", "verdict", "why", "accepted", "patch")} for x in res.get("repairs") or []]
        progress("Canary: one 5-second screencast…", 0.8)
        rec_seg = {"t0": 0.3, "t1": 5.3, "url": pb["start_state"]["url"], "app": app, "session": "logged_in",
                   "beats": [{"id": "rec_b0", "word_id": 1, "t_word": 0.56, "word": "is", "action": "camera", "subject": "screen"},
                             {"id": "rec_b1", "word_id": 6, "t_word": 2.36, "word": "a", "action": "paste_prompt",
                              "params": {"text": TYPED}}]}
        try:
            doc = (recorder_factory or _live_recorder)(d, app, {app: res.get("playbooks", {}).get(app) or pb}, made, new_session,
                                                         log, cancelled).record_segment(0, rec_seg)
            ok = doc.get("status") == "ok" and (d / "canary-rec" / "seg-00" / "rec" / "raw.mp4").exists() \
                if recorder_factory is None else doc.get("status") == "ok"
            rep.add("A", "one 5-second screencast", ok, doc.get("why") or "recorded")
        except Exception as e:  # noqa: BLE001
            rep.add("A", "one 5-second screencast", False, f"{type(e).__name__}: {e}")
        finally:
            closer = getattr(new_session, "close_all", None)
            if callable(closer):
                closer()
        return _finish(d, rep, log, t0)
    finally:
        if old_cap is None:
            os.environ.pop(apiledger.ENV_JOB_CAP, None)
        else:
            os.environ[apiledger.ENV_JOB_CAP] = old_cap


def _finish(d, rep, log, t0):
    rep.doc["claude_usd"] = _spent(rep.doc["job"])
    rep.doc["took_s"] = round(time.time() - t0, 1)
    rep.doc["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    rep.doc["summary"] = rep.summary()
    rep.doc["ok"] = all(v in ("ok", "skipped") for v in rep.doc["classes"].values())
    (Path(d) / "canary-report.json").write_text(json.dumps(rep.doc, indent=1, ensure_ascii=False))
    log(rep.doc["summary"])
    return rep.doc


# ───────────────────────── the live plumbing (factory server) ─────────────────────────

class _Job:
    def __init__(self, d, req):
        self.dir, self.request = Path(d), dict(req or {})


def _live_ctx(d, out, app, site, req, log, progress, cancelled):
    from . import preprod
    adapter = preprod.adapter_for(site)
    if adapter is None:
        raise RuntimeError(f"no adapter for {site}")
    return preprod.make_ctx(_Job(d, req), out, adapter, {}, {"assets": []}, say=log, progress=progress, cancelled=cancelled)


def _live_sessions(d, app, cancelled):
    from . import agentrec, usroute
    cache = {}

    def new_session(app_, kind, fresh):
        key = (app_, kind)
        if fresh or key not in cache:
            if kind == "outside":
                prof = usroute.fresh_profile(Path(d) / "canary-outside")
                cache[key] = agentrec.Session(Path(d) / "canary-rec", None, cancelled,
                                              env=usroute.outside_chrome_env(usroute.route_for_job(), prof))
            else:
                sc = agentrec.scout_for(APPS.get(app_, {}).get("site") or "") or {}
                cache[key] = agentrec.Session(Path(d) / "canary-rec", sc.get("profile"), cancelled, dark=True,
                                              profile_name="profile")
        return cache[key]

    def close_all():
        for s_ in cache.values():
            try:
                s_.close()
            except Exception:  # noqa: BLE001
                pass
        cache.clear()
    new_session.close_all = close_all
    return new_session


def _live_recorder(d, app, playbooks, made, new_session, log, cancelled):
    from . import recorder
    w = Path(d) / "canary-rec"
    w.mkdir(parents=True, exist_ok=True)
    return recorder.Recorder(w, playbooks, {"assets": list(made.values())}, {"words": _words(), "duration": 6.0},
                             new_session=new_session, verdict=None, media=recorder.DockerMedia(cancelled), log=log,
                             cancelled=cancelled)
