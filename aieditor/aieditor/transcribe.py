"""Word-level transcript from Groq Whisper (whisper-large-v3-turbo).

Measured on Jake's raw recordings (2026-10-04): it keeps repeated run-throughs,
crew talk, "Mm-hmm" and most "uh", and left no stretch of speech without words —
but its word TIMES drift (median 0.12 s, p90 0.42 s), so align.py re-times them.

Groq's file limit is 25 MB; 16 kHz 32 kb/s mono is ~14 MB/hour, so up to ~100
minutes goes in one call. Longer audio is refused with a clear message (splitting
is not built: no raw recording so far has come close).
"""
import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from . import config, media

LIMIT = 24 * 1024 * 1024


def _call(mp3_bytes, prompt=""):
    key = config.env_key("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY is not set in /opt/clipmagic/.env")
    b = uuid.uuid4().hex
    fields = {"model": config.GROQ_MODEL, "response_format": "verbose_json",
              "timestamp_granularities[]": "word", "language": "en", "temperature": "0"}
    if prompt:
        fields["prompt"] = prompt
    body = b"".join(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
                    for k, v in fields.items())
    body += (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.mp3\"\r\n"
             f"Content-Type: audio/mpeg\r\n\r\n").encode() + mp3_bytes + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request("https://api.groq.com/openai/v1/audio/transcriptions", data=body,
                                 headers={"Authorization": f"Bearer {key}", "User-Agent": "aieditor/1",
                                          "Content-Type": f"multipart/form-data; boundary={b}"})
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(req, timeout=900))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(15 * (attempt + 1))
                continue
            raise RuntimeError(f"Groq transcription HTTP {e.code}: {e.read()[:300]!r}")


# A filler-heavy prompt nudges Whisper toward a verbatim transcript (keeps "uh", restarts).
VERBATIM_PROMPT = "Umm, uh, so, so the- the thing is, uh, I- I mean, let me, let me redo that. Um, okay."


def _words(r, offset=0.0):
    return [{"word": w["word"].strip(), "start": round(float(w["start"]) + offset, 3),
             "end": round(float(w["end"]) + offset, 3)}
            for w in r.get("words", []) if w.get("word", "").strip()]


# ⚠️ WHISPER SOMETIMES SKIPS SPEECH. On Jake's Cowork raw (2026-10-04) it wrote ONE
# "word" — "Umm," — spanning 56.4 s → 86.4 s over 30 s of continuous talking: his
# whole intro (what he does, the Skool community, the prompts). Nothing downstream
# can keep words the transcript never had, so the intro was cut. Re-transcribing just
# that slice recovered all 95 words. So: find every stretch where the audio has speech
# but the transcript has (almost) nothing, and transcribe those slices again.
LONG_WORD = 1.5          # no real word lasts this long
SPEECH_DB = 15           # a 100 ms frame this far above the noise floor is speech
MIN_SPEECH = 1.0         # seconds of speech inside a span before it counts as skipped


def suspect_spans(words, audio):
    frames = []
    t, n = 0.0, len(audio.x) / audio.sr
    while t < n:
        frames.append(audio.rms_db(t, t + 0.1))
        t += 0.1
    floor = sorted(frames)[len(frames) // 10] if frames else -90
    speech = lambda a, b: sum(1 for k in range(int(a * 10), min(len(frames), int(b * 10)))
                              if frames[k] > floor + SPEECH_DB) / 10
    spans = []
    prev_end = 0.0
    for w in words + [None]:
        start = w["start"] if w else n
        # a silent-looking gap that actually holds speech
        if start - prev_end > LONG_WORD and speech(prev_end, start) >= MIN_SPEECH:
            spans.append([prev_end, start])
        # one "word" stretched over several seconds
        if w and w["end"] - w["start"] > LONG_WORD and speech(w["start"], w["end"]) >= MIN_SPEECH:
            spans.append([w["start"], w["end"]])
        if w:
            prev_end = max(prev_end, w["end"])
    merged = []
    for a, b in sorted(spans):
        if merged and a <= merged[-1][1] + 0.5:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


def repair(doc, wav16k, job, audio, passes=2):
    """Re-transcribe every suspect span on its own and splice the words back in."""
    log = []
    for _ in range(passes):
        spans = suspect_spans(doc["words"], audio)
        if not spans:
            break
        for a, b in spans:
            # widen to the neighbouring real words so the slice has context
            before = [w for w in doc["words"] if w["end"] <= a + 0.05 and w["end"] - w["start"] <= LONG_WORD]
            after = [w for w in doc["words"] if w["start"] >= b - 0.05 and w["end"] - w["start"] <= LONG_WORD]
            lo = max(0.0, (before[-1]["start"] if before else a) - 0.2)
            hi = (after[0]["end"] if after else b) + 0.2
            sl = Path(job) / "slice.mp3"
            media._docker("ffmpeg", ["-v", "error", "-y", "-ss", f"{lo:.3f}", "-to", f"{hi:.3f}",
                                     "-i", f"/job/{Path(wav16k).name}", "-ac", "1", "-ar", "16000",
                                     "-b:a", "32k", "/job/slice.mp3"], [(Path(job).resolve(), "/job", "rw")])
            r = _call(sl.read_bytes())
            sl.unlink(missing_ok=True)
            new = [w for w in _words(r, lo) if lo <= w["start"] < hi]
            old = [w for w in doc["words"] if lo <= w["start"] < hi]
            if len(new) <= len(old):
                log.append(f"{lo:.1f}-{hi:.1f}s: re-transcribed, nothing new")
                continue
            # splice in place. ⚠️ Never re-sort the whole list by time: Whisper gives
            # neighbouring words overlapping times, and a sort turned "using in this
            # video" into "using video, in this".
            ws = doc["words"]
            at = next((k for k, w in enumerate(ws) if lo <= w["start"] < hi),
                      next((k for k, w in enumerate(ws) if w["start"] >= hi), len(ws)))
            doc["words"] = ws[:at] + new + [w for w in ws[at:] if not (lo <= w["start"] < hi)]
            log.append(f"{lo:.1f}-{hi:.1f}s: {len(old)} -> {len(new)} words")
    return log


def transcribe(mp3_path, out_path, wav16k=None, job=None, audio=None):
    data = open(mp3_path, "rb").read()
    if len(data) > LIMIT:
        raise RuntimeError("Audio over ~100 minutes: split the recording into parts in Descript first")
    r = _call(data, VERBATIM_PROMPT)
    doc = {"model": config.GROQ_MODEL, "duration": r.get("duration"), "text": r.get("text", ""),
           "words": _words(r)}
    doc["repairs"] = repair(doc, wav16k, job, audio) if audio is not None else []
    json.dump(doc, open(out_path, "w"))
    return doc
