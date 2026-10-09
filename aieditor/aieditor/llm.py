"""The ONE place the editor talks to the Claude API (architecture recommendation step 1).

    llm.messages(model, system, content, max_tokens, effort, job, stage, purpose) -> Reply

Before sending: apiledger.check() refuses a call that would pass the per-job or the rolling daily
API cap (BudgetExceeded — the job ends held, reason "API cap"). After: one ledger line with the
priced usage (config.API_PRICES), and the usual events.api() line for the Lab's live log.

A call made while a screencast is being RECORDED raises OnCameraCall: models decide off camera only
(agentrec.Session.recording; defence in depth behind config.RECORDER's on_camera_agent=False).

Raw HTTP on purpose: the editor has always used urllib (no SDK in the images), and keeping the
transport here means the key, retries, pricing and caps live in one file. Tests swap TRANSPORT.
"""
import json
import threading
import time
import urllib.error
import urllib.request

from . import apiledger, config, events

API_HOST = "api.anthropic.com"
API_URL = f"https://{API_HOST}/v1/messages"
VERSION = "2023-06-01"
OUT_ESTIMATE = 8000          # output tokens assumed by the pre-call cap check (max_tokens is a ceiling)
IMAGE_TOKENS = 1600          # one screenshot ≈ 1.6 k input tokens
RETRY_CODES = (429, 500, 502, 503, 529)

_ctx = {"job": None, "stage": None, "workflow": None}
_recording = set()
_refusals = []               # cap refusals in this job — sticky, so a caller that swallows the error
                             # (a "route, don't fail" except) still ends the job held (bin/aieditor-worker)
_rlock = threading.Lock()


class OnCameraCall(RuntimeError):
    pass


class Reply(dict):
    """{text, usage, stop_reason, content, usd, seconds} — a dict, so callers can keep it as meta."""
    @property
    def text(self):
        return self["text"]


# ── context the worker sets for every job / stage ──────────────────────────────
def set_context(**kw):
    if "job" in kw and kw["job"] != _ctx["job"]:
        _refusals.clear()
    for k, v in kw.items():
        if k in _ctx:
            _ctx[k] = v


def clear_context():
    for k in _ctx:
        _ctx[k] = None
    _refusals.clear()


def refusals():
    """The cap refusals since the job started (BudgetExceeded messages)."""
    return list(_refusals)


def context():
    return dict(_ctx)


def set_recording(owner, on):
    """agentrec.Session flips this while frames are being captured."""
    with _rlock:
        (_recording.add if on else _recording.discard)(owner)


def recording():
    return bool(_recording)


# ── pricing ────────────────────────────────────────────────────────────────────
def price(model, usage):
    p = config.API_PRICES.get(model) or config.API_PRICES[config.API_PRICE_DEFAULT]
    u = usage or {}
    return (u.get("input_tokens", 0) * p["in"] + u.get("output_tokens", 0) * p["out"]
            + u.get("cache_read_input_tokens", 0) * p["cache_read"]
            + u.get("cache_creation_input_tokens", 0) * p["cache_write"]) / 1e6


def _tokens_in(obj):
    """A rough input-token count: text ≈ 3.5 chars a token, an image ≈ IMAGE_TOKENS."""
    if isinstance(obj, str):
        return len(obj) / 3.5
    if isinstance(obj, list):
        return sum(_tokens_in(x) for x in obj)
    if isinstance(obj, dict):
        if obj.get("type") == "image":
            return IMAGE_TOKENS
        return sum(_tokens_in(v) for k, v in obj.items() if k not in ("type", "cache_control", "media_type"))
    return 0


def estimate(model, system, msgs, max_tokens):
    tin = _tokens_in(system) + _tokens_in(msgs)
    return price(model, {"input_tokens": tin, "output_tokens": min(max_tokens, OUT_ESTIMATE)})


# ── transport ──────────────────────────────────────────────────────────────────
def _http(body, stream, timeout):
    """POST /v1/messages → {"content", "usage", "stop_reason"} (a stream is folded into the same)."""
    key = config.env_key("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set in /opt/clipmagic/.env")
    req = urllib.request.Request(API_URL, data=json.dumps(body).encode(),
                                 headers={"x-api-key": key, "anthropic-version": VERSION,
                                          "content-type": "application/json"})
    if not stream:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    text, usage, stop = [], {}, None
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:])
            if ev["type"] == "message_start":
                usage.update(ev["message"]["usage"])
            elif ev["type"] == "content_block_delta" and ev["delta"].get("type") == "text_delta":
                text.append(ev["delta"]["text"])
            elif ev["type"] == "message_delta":
                usage.update(ev.get("usage", {}))
                stop = ev["delta"].get("stop_reason")
            elif ev["type"] == "error":
                raise RuntimeError(f"Claude error: {ev.get('error')}")
    return {"content": [{"type": "text", "text": "".join(text)}], "usage": usage, "stop_reason": stop}


TRANSPORT = _http


# ── the call ───────────────────────────────────────────────────────────────────
def messages(model, system, content, max_tokens, effort=None, job=None, stage=None, purpose="", *,
             msgs=None, thinking=True, stream=False, timeout=1800, retries=3, workflow=None, schema=None):
    """One Claude Messages call. content = the user turn (str or blocks); msgs = a whole message list
    instead (a follow-up turn). Returns Reply. Raises BudgetExceeded before sending when a cap would
    be passed, OnCameraCall while a screencast is being recorded. schema = a JSON schema the answer must
    match (structured outputs: output_config.format json_schema)."""
    if recording():
        raise OnCameraCall(f"Claude call '{purpose}' refused: a screencast is being recorded "
                           "(models decide off camera only)")
    job = job if job is not None else _ctx["job"]
    stage = stage if stage is not None else _ctx["stage"]
    workflow = workflow or _ctx["workflow"]
    msgs = msgs if msgs is not None else [{"role": "user", "content": content}]
    body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": msgs}
    if thinking:
        body["thinking"] = {"type": "adaptive"}
    if effort:
        body["output_config"] = {"effort": effort}
    if schema is not None:
        body.setdefault("output_config", {})["format"] = {"type": "json_schema", "schema": schema}
    if stream:
        body["stream"] = True
    est = estimate(model, system, msgs, max_tokens)
    try:
        apiledger.check(job, est, workflow)          # BudgetExceeded: nothing is sent
    except apiledger.BudgetExceeded as e:
        _refusals.append(str(e))
        events.emit("api", f"{purpose or model}: REFUSED before sending — {e}", level="error")
        raise
    t0 = time.time()
    res, err = None, None
    try:
        for attempt in range(retries + 1):
            try:
                res = TRANSPORT(body, stream, timeout)
                break
            except urllib.error.HTTPError as e:
                if e.code in RETRY_CODES and attempt < retries:
                    events.emit("api", f"{purpose or model}: HTTP {e.code}, retrying ({attempt + 1}/{retries})",
                                level="warn")
                    time.sleep(5 * (attempt + 1))
                    continue
                raise
    except BaseException as e:                       # the failed call still gets its ledger line
        err = e
        raise
    finally:
        usage = (res or {}).get("usage") or {}
        usd = price(model, usage)
        apiledger.record({"ts": round(time.time(), 3), "job": job, "stage": stage, "model": model,
                          "purpose": purpose, "in": usage.get("input_tokens", 0),
                          "out": usage.get("output_tokens", 0),
                          "cache_read": usage.get("cache_read_input_tokens", 0),
                          "cache_write": usage.get("cache_creation_input_tokens", 0),
                          "usd": round(usd, 6), "ok": err is None and res is not None,
                          **({"error": type(err).__name__} if err is not None else {})})
    secs = time.time() - t0
    events.api(model, usd, secs, purpose, usage)
    blocks = res.get("content") or []
    return Reply(text="".join(b.get("text", "") for b in blocks if b.get("type") == "text"),
                 usage=usage, stop_reason=res.get("stop_reason"), content=blocks,
                 usd=round(usd, 6), seconds=round(secs, 2))
