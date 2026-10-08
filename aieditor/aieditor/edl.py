"""Kept words -> frame-exact pieces of the source, and the output-timeline transcript.

Jake's gap rule: every silence longer than 0.35 s becomes exactly 0.35 s (what his
Descript "shorten word gaps" pass does).

⚠️ FRAME-EXACT BY CONSTRUCTION (Jake 2026-10-04: "the audio should be aligned 100%
with the video"). A piece is (first source frame, frame count); its audio is exactly
the samples those frames cover. The renderer and the word-time mapping both read
these pieces, so the transcript the planner sees lines up with the picture too.
"""
import array
import math
import sys
import wave

GAP_CAP = 0.35
# Long-form: a natural pause is left exactly as recorded up to 0.7 s — shortening it
# would be a jump cut to save ~0.2 s (388 of 553 cuts in the first Cowork cut, Jake:
# "too many in between cuts"). Longer pauses become exactly GAP_CAP. Shorts keep 0.35.
LONG_PAUSE_KEEP = 0.70
HEAD_PAD = 0.12          # kept before a word that follows a cut
TAIL_PAD = 0.18          # kept after a word that precedes a cut
SR_OUT = 48000


class Audio:
    """16 kHz mono 16-bit wav in memory (host Python has no numpy)."""
    def __init__(self, path):
        with wave.open(str(path)) as f:
            assert f.getframerate() == 16000 and f.getnchannels() == 1
            raw = f.readframes(f.getnframes())
        # array('h'): 2 bytes a sample. A tuple of Python ints is ~36 bytes a sample —
        # 1.6 GB for a 46-minute recording on a box with 8 GB.
        self.x = array.array("h")
        self.x.frombytes(raw)
        if sys.byteorder == "big":
            self.x.byteswap()
        self.sr = 16000

    def rms_db(self, a, b):
        i, j = max(0, int(a * self.sr)), min(len(self.x), int(b * self.sr))
        if j - i < 16:
            return -90.0
        seg = self.x[i:j:4]
        p = sum(v * v for v in seg) / len(seg)
        return 10 * math.log10(p / 32768 ** 2 + 1e-12)

    def floor(self):
        """Room noise level: the 10th percentile of 100 ms frames (computed once)."""
        if getattr(self, "_floor", None) is None:
            frames, t, n = [], 0.0, len(self.x) / self.sr
            while t < n:
                frames.append(self.rms_db(t, t + 0.1))
                t += 0.1
            self._frames = frames
            self._floor = sorted(frames)[len(frames) // 10] if frames else -90.0
        return self._floor

    def room_tone(self, seconds=2.0):
        """Start of the quietest `seconds` of real room noise (not digital silence)."""
        self.floor()
        fr, n = self._frames, int(seconds * 10)
        best, at = None, 0.0
        for k in range(0, max(1, len(fr) - n)):
            win = fr[k:k + n]
            if min(win) < -85:            # digital silence / dropout: not room tone
                continue
            m = sum(win) / n
            if best is None or m < best:
                best, at = m, k / 10
        return at

    def quietest(self, t, radius=0.04, win=0.01, lo=None, hi=None):
        """Centre of the quietest 10 ms window within +-radius of t, never outside [lo, hi]."""
        best, bt = None, t
        k = -radius
        while k <= radius + 1e-9:
            c = t + k
            if not ((lo is not None and c < lo) or (hi is not None and c > hi)):
                d = self.rms_db(c - win / 2, c + win / 2)
                if best is None or d < best:
                    best, bt = d, c
            k += 0.005
        return max(0.0, bt)


TOUCH_GAP = 0.15          # neighbours closer than this share a boundary with no real silence
EDGE_REACH = 0.03         # how far into a kept word's ALIGNED span its edge may still be moved


def _valley(audio, lo, hi, prefer=None):
    """The quietest point (5 ms steps, 10 ms window) in [lo, hi]: where two words that
    touch can be separated with the least of either one left over. Of the points within
    VALLEY_SLACK dB of the quietest, the one nearest `prefer` (the edge it replaces)."""
    pts, t = [], lo
    while t <= hi + 1e-9:
        pts.append((audio.rms_db(t - 0.005, t + 0.005), t))
        t += 0.005
    if not pts:
        return max(0.0, (lo + hi) / 2)
    floor_db = min(d for d, _ in pts)
    near = [t for d, t in pts if d <= floor_db + VALLEY_SLACK]
    ref = prefer if prefer is not None else (lo + hi) / 2
    return max(0.0, min(near, key=lambda t: abs(t - ref)))


VALLEY_SLACK = 3.0


PAUSE_SPEECH_DB = 30      # over the floor: louder than this inside a pause is speech, not a breath


def _quiet_span(audio, a, b):
    """The longest stretch of [a, b] with no SPEECH in it, or None. A breath or room
    noise (15-25 dB over the floor on the Cowork mic) still counts as pause; speech the
    transcript missed ("by hand" at 1:21: 37-57 dB) does not."""
    thr = audio.floor() + PAUSE_SPEECH_DB
    loud, t = [], a
    while t + 0.01 <= b + 1e-9:
        loud.append(audio.rms_db(t, t + 0.01) > thr)
        t += 0.01
    # a mouth click (<= CLICK_MAX) is not speech: it never breaks a pause
    k = 0
    while k < len(loud):
        if loud[k]:
            m = k
            while m < len(loud) and loud[m]:
                m += 1
            if (m - k) * 0.01 <= CLICK_MAX:
                loud[k:m] = [False] * (m - k)
            k = m
        else:
            k += 1
    best, start = None, None
    for k, ld in enumerate(loud):
        if not ld:
            start = k if start is None else start
            if best is None or k + 1 - start > best[1] - best[0]:
                best = (start, k + 1)
        else:
            start = None
    return (a + best[0] * 0.01, a + best[1] * 0.01) if best else None


def kept_words(video, sents):
    out = []
    for seg in video["segments"]:
        drop = set(seg.get("drop", []))
        out += [w for w in sents[seg["s"]] if w["i"] not in drop]
    return out


SPEECH_REL_DB = 10        # within this much of the noise floor counts as "quiet"
CLICK_REL_DB = 12         # a 10 ms blip this far above the floor inside a pause is muted
MAX_DECAY = 0.30          # how far past the aligned word end its sound may still ring
MAX_ATTACK = 0.15         # how far before the aligned word start its sound may begin
TAIL_SHARE = 0.6          # of a 0.35 s pause: 0.21 s after the word, 0.14 s before the next


def _sound_end(audio, w, limit):
    """Where word w's sound really stops. The aligner marks ends early, and a nasal
    ("in") rings on: Jake heard the "n" clipped at 2:07 of the Cowork cut."""
    floor = audio.floor()
    # a neighbour the aligner placed OVERLAPPING this word ("installed." 175.06-175.62
    # vs the removed "Uh," from 175.40) must not end it early: Jake heard "installed"
    # clipped at 2:37 of the Cowork cut
    limit = max(limit, w["e"])
    t = w["e"]
    stop = min(w["e"] + MAX_DECAY, limit)
    while t < stop and audio.rms_db(t, t + 0.01) > floor + SPEECH_REL_DB:
        t += 0.01
    return min(t + 0.02, limit)


def _sound_start(audio, w, limit):
    floor = audio.floor()
    limit = min(limit, w["s"])              # same guard as _sound_end, at the start
    t = w["s"]
    stop = max(w["s"] - MAX_ATTACK, limit)
    while t > stop and audio.rms_db(t - 0.01, t) > floor + SPEECH_REL_DB:
        t -= 0.01
    return max(t - 0.02, limit)


JOIN_FILLERS = {"uh", "um", "umm", "uhh", "uhm", "erm", "so", "mm", "hmm", "mhm", "mm-hmm"}


def _norm(t):
    return "".join(c for c in t.lower() if c.isalnum() or c == "-")


CLICK_MAX = 0.08          # a click/smack is a blip; anything longer is speech or a breath


def _clicks(audio, a, b):
    """Mouth clicks inside a pause [a, b] — SHORT blips only. ⚠️ A longer loud stretch is
    speech the transcript placed wrong (Jake heard the end of "by hand" muted at 1:21 of
    the Cowork cut: Whisper misheard it and the aligner fit the wrong words short of the
    real ones). Speech is never muted; removed words are kept out by the range limits."""
    floor = audio.floor()
    out, t = [], a
    while t < b:
        if audio.rms_db(t, min(b, t + 0.01)) > floor + CLICK_REL_DB:
            lo, hi = max(a, t - 0.01), min(b, t + 0.02)
            if out and lo <= out[-1][1]:
                out[-1][1] = hi
            else:
                out.append([lo, hi])
        t += 0.01
    return [x for x in out if x[1] - x[0] <= CLICK_MAX + 0.03]


BREATH_MIN = 0.20        # a sound this long before a sentence (10-33 dB over the floor) is an in-breath
BREATH_MAX_DB = 33        # louder than floor + this for > CLICK_MAX = speech, never a breath
BREATH_HEAD_MAX = 0.50    # the head never starts more than this before the first word
BREATH_GAP = 0.25         # quiet allowed between the breath and the word's attack


def _pre_sound(audio, w, s_lo, lo):
    """What sits just before a sentence's first word (searched back from its measured
    sound start s_lo, never before lo = the end of the previous word's sound):
    ("breath", onset, end) — an in-breath >= BREATH_MIN; ("blob", onset, end) — a shorter
    non-speech sound (leftover of a removed murmur); or None.
    LEARNED FROM LINEARITY: every time the automatic start of a sentence landed INSIDE such
    a sound and Jake touched it, he moved it to that sound's edge: two half-breaths ->
    the whole breath (-394 / -310 ms; breaths 0.3-0.4 s at 15-30 dB over the floor), one
    90 ms murmur -> just after it (+117 ms, the lost pause put back on the tail). A head
    never starts partway through a sound. (A -352 ms nudge that ADDED a breath the start
    had cleanly left out is a one-off — not encoded.)"""
    q = audio.floor() + SPEECH_REL_DB
    sp = audio.floor() + BREATH_MAX_DB
    t = s_lo
    stop = max(lo, w["s"] - 1.2)
    # 1) quiet between the attack and the sound before it (may be none: breath attached)
    gap = 0.0
    while t - 0.01 >= stop and audio.rms_db(t - 0.01, t) <= q and gap < BREATH_GAP:
        t -= 0.01
        gap += 0.01
    if t - 0.01 < stop or audio.rms_db(t - 0.01, t) <= q:
        return None
    end = t
    # 2) the sound itself, allowing dips up to 30 ms; it ends at 40 ms of quiet
    loud_run, quiet_run, start = 0.0, 0.0, t
    while t - 0.01 >= stop:
        d = audio.rms_db(t - 0.01, t)
        if d > sp:
            loud_run += 0.01
            if loud_run > CLICK_MAX:
                return None                # speech: not ours to touch
        else:
            loud_run = 0.0
        if d <= q:
            quiet_run += 0.01
            if quiet_run >= 0.04:
                break
        else:
            quiet_run, start = 0.0, t - 0.01
        t -= 0.01
    if start <= stop + 0.005:
        return None                        # runs into the previous word / search limit
    if end - start >= BREATH_MIN:
        return ("breath", start, end)
    return ("blob", start, end)


def ranges_for(kept, by_id, audio, exact_gap=False, nudges=None, starts=None):
    """Kept words -> source ranges (a, b, words, muted, hold_head, hold_tail).
    muted = source-time spans inside the range whose audio becomes room tone;
    hold_head/hold_tail are always 0: Jake ruled frames are never held.

    Words that follow each other in the source with a pause <= 0.35 s (long-form: 0.7 s)
    form a run and play as recorded. Between runs (a cut, or a pause > 0.35 s) the pause is rebuilt:
      long-form (exact_gap): EXACTLY 0.35 s — Jake: "they should be 0.35 not below it".
        At least 0.35 s of the source's own silence; a click in it (Jake heard one at
        1:51) becomes room tone. Never into a neighbouring word's sound and never a held
        frame: where a removed word leaves less silence than that, the join keeps only
        the silence that is really there.
      shorts: a tighter 0.12 s head / 0.18 s tail, snapped to the quietest point.
    """
    keep_pause = LONG_PAUSE_KEEP if exact_gap else GAP_CAP
    runs, quiet = [], {}
    for w in kept:
        p = runs[-1][-1] if runs else None
        if p and p["i"] == w["i"] - 1 and w["s"] >= p["e"] - 0.05 and w["s"] - p["e"] <= keep_pause:
            runs[-1].append(w)
        elif (p and p["i"] == w["i"] - 1 and w["s"] < p["e"] - 0.05 and w["e"] > p["e"]
              and f"a:{w['i']}" not in (nudges or {})):       # Jake already fixed this join by hand
            # consecutive kept words the aligner OVERLAPPED ("list." 790.78-791.08 / "I'm"
            # 790.82-791.79 in Linearity) play as recorded. As two runs the second began
            # before the first ended — 0.25 s of "list." played twice (Jake: +372 ms).
            runs[-1].append(w)
        elif p and p["i"] == w["i"] - 1 and w["s"] > p["e"]:
            # ⚠️ a "pause" between two KEPT words is only as long as its real silence.
            # Jake, 1:21 of the Cowork cut: "he says 'dig it out by hand' but there's no
            # 'by hand'" — Whisper heard "ahead and do that", the aligner fit those words
            # short, and the gap after them was shortened straight through the real words.
            # Measured: if the longest quiet stretch is no longer than keep_pause it is
            # speech, played as recorded; otherwise only that stretch is shortened.
            q = _quiet_span(audio, p["e"], w["s"])
            if q is None or q[1] - q[0] <= keep_pause:
                runs[-1].append(w)
            else:
                quiet[p["i"]] = q
                runs.append([w])
        else:
            runs.append([w])
    kept_ids = {w["i"] for w in kept}
    # each run's own sound: never cut into it
    snd = []
    for run in runs:
        first, last = run[0], run[-1]
        pa, nb = by_id.get(first["i"] - 1), by_id.get(last["i"] + 1)
        # the neighbour's own measured sound bounds ours, not its (possibly overlapping)
        # aligned time
        snd.append([_sound_start(audio, first, pa["e"] if pa else 0.0),
                    _sound_end(audio, last, max(nb["s"], last["e"]) if nb else last["e"] + MAX_DECAY), pa, nb])
    # a measured pause between two kept runs: everything outside its quiet stretch is
    # sound (possibly words the transcript missed) and belongs to the runs
    for k in range(len(runs) - 1):
        q = quiet.get(runs[k][-1]["i"])
        if q:
            snd[k][1] = max(snd[k][1], q[0])
            snd[k + 1][0] = min(snd[k + 1][0], q[1])
    # how much REAL silence each run may use on either side: never into a neighbouring
    # word's sound (Jake heard a removed word muted under the pause at 0:51)
    lo_lim, hi_lim = [], []
    for k, run in enumerate(runs):
        first, last = run[0], run[-1]
        s_lo, s_hi, pa, nb = snd[k]
        lo_lim.append(min(_sound_end(audio, pa, first["s"]) if pa else 0.0, s_lo))
        hi_lim.append(max(_sound_start(audio, nb, last["e"]) if nb else last["e"] + 10.0, s_hi))
        if k and runs[k - 1][-1]["i"] in quiet:
            lo_lim[k] = min(s_lo, quiet[runs[k - 1][-1]["i"]][0])
        if last["i"] in quiet:
            hi_lim[k] = max(s_hi, quiet[last["i"]][1])
    # the speaker's normal gap between words inside a phrase
    gaps = sorted(b["s"] - a["e"] for r in runs for a, b in zip(r, r[1:]) if 0.02 < b["s"] - a["e"] < GAP_CAP)
    word_gap = gaps[len(gaps) // 2] if gaps else 0.12
    heads, tails = [0.0] * len(runs), [0.0] * len(runs)
    breath = [False] * len(runs)
    for k, run in enumerate(runs):
        first, last = run[0], run[-1]
        s_lo, s_hi, pa, nb = snd[k]
        attack, decay = first["s"] - s_lo, s_hi - last["e"]
        room_head, room_tail = first["s"] - lo_lim[k], hi_lim[k] - last["e"]
        if exact_gap:
            if k == 0:
                heads[k] = min(max(HEAD_PAD, attack), room_head)
            if k == len(runs) - 1:
                tails[k] = min(max(TAIL_PAD, decay), room_tail)
            else:
                # the join to the next run: at least GAP_CAP of real silence in total,
                # split 60/40 but rebalanced when one side has less room. ⚠️ Jake: "the
                # last frame should never be held, the cut needs to be in another timing
                # not on top of the word" — if the two sides together hold less than
                # GAP_CAP (a stumble removed mid-phrase), the join keeps only what is
                # really there and plays like natural speech.
                nxt = runs[k + 1]
                n_s_lo = snd[k + 1][0]
                n_attack = nxt[0]["s"] - n_s_lo
                n_room = nxt[0]["s"] - lo_lim[k + 1]
                gone = [by_id[i] for i in range(last["i"] + 1, nxt[0]["i"]) if i in by_id]
                if gone and nxt[0]["i"] > last["i"] and all(_norm(w["w"]) in JOIN_FILLERS for w in gone):
                    # ⚠️ Jake: "If it's cutting out uh, um, so — the 0.35 rule doesn't
                    # apply there." Only a filler left: close it up to the speaker's OWN
                    # normal gap between words (measured below), never longer than the
                    # pause he made before the filler, so the line flows as if the "uh"
                    # was never said. (Keeping the whole pre-filler pause kept the
                    # hesitation: Cowork's 110 filler joins still averaged 0.37 s.)
                    want = min(word_gap, max(0.0, gone[0]["s"] - last["e"]))
                    tail = min(max(decay, want * TAIL_SHARE), room_tail)
                    head = min(max(n_attack, want - tail), n_room)
                    if tail + head < want:
                        tail = min(room_tail, want - head)
                else:
                    tail = min(max(decay, GAP_CAP * TAIL_SHARE), room_tail)
                    head = min(max(n_attack, GAP_CAP - tail), n_room)
                    if tail + head < GAP_CAP:
                        tail = min(room_tail, max(tail, GAP_CAP - head))
                    a0 = nxt[0]["s"] - head
                    # ⚠️ nudges are ms RELATIVE to the automatic edge: an edge Jake already
                    # placed by hand keeps the base he placed it from
                    if (starts and nxt[0]["i"] in starts and f"a:{nxt[0]['i']}" not in (nudges or {})
                            and audio.rms_db(a0, a0 + 0.01) > audio.floor() + SPEECH_REL_DB):
                        # a sentence start that lands ON a sound before the word: never
                        # half of it. An in-breath is kept whole, a short murmur left out.
                        pre = _pre_sound(audio, nxt[0], n_s_lo, lo_lim[k + 1])
                        if pre and pre[1] - 0.01 < a0 <= pre[2] + 0.01:
                            if pre[0] == "breath":
                                head = min(max(head, nxt[0]["s"] - (pre[1] - 0.01)), BREATH_HEAD_MAX, n_room)
                                breath[k + 1] = True
                            else:
                                head = max(n_attack, nxt[0]["s"] - (pre[2] + 0.01))
                                if tail + head < GAP_CAP:  # the pause it lost goes to the tail
                                    tail = min(room_tail, GAP_CAP - head)
                tails[k], heads[k + 1] = tail, head
        else:
            lo = first["s"] - HEAD_PAD
            if pa and pa["e"] > lo:
                lo = (pa["e"] + first["s"]) / 2
            hi = last["e"] + TAIL_PAD
            if nb and nb["s"] < hi:
                hi = (last["e"] + nb["s"]) / 2
            lo = audio.quietest(lo, lo=pa["e"] if pa else None, hi=first["s"])
            hi = audio.quietest(hi, lo=last["e"], hi=nb["s"] if nb else None)
            heads[k] = min(max(first["s"] - lo, attack), room_head)
            tails[k] = min(max(hi - last["e"], decay), room_tail)
    out = []
    for k, run in enumerate(runs):
        s_lo, s_hi, pa, nb = snd[k]
        a = max(0.0, run[0]["s"] - heads[k])
        b = run[-1]["e"] + tails[k]
        # ⚠️ Jake (v3 Cowork): "there are still some cut audio milliseconds ... there should
        # be none between full words". 99 of 253 joins ended — and 118 began — while sound
        # was still playing: a removed "uh" or duplicate word butting straight onto a kept
        # one, where the aligner's boundary is a guess. An edge that lands on sound moves
        # to the quietest point between the two words, never inside the kept word.
        # Where the neighbour really touches (TOUCH_GAP) the edge moves to the quiet
        # point between them. Across a real pause (a drawn-out "ummm" or a breath running
        # past its aligned end) the edge stays — the pause keeps its length — and the
        # leftover sound up to the quiet point nearest the kept word becomes room tone.
        fill = []
        if pa and audio.rms_db(a, a + 0.01) > audio.floor() + SPEECH_REL_DB:
            if run[0]["s"] - pa["e"] < TOUCH_GAP:
                a = _valley(audio, min(pa["e"], run[0]["s"]), run[0]["s"] + EDGE_REACH, prefer=a)
            elif pa["i"] not in kept_ids:      # only a REMOVED word's leftover; speech
                fill.append([a, _valley(audio, a, min(s_lo, run[0]["s"]), prefer=s_lo)])
        if nb and audio.rms_db(b - 0.01, b) > audio.floor() + SPEECH_REL_DB:
            if nb["s"] - run[-1]["e"] < TOUCH_GAP:
                b = _valley(audio, run[-1]["e"] - EDGE_REACH, max(nb["s"], run[-1]["e"]), prefer=b)
            elif nb["i"] not in kept_ids:      # we keep is never room-toned
                fill.append([_valley(audio, max(s_hi, run[-1]["e"]), b, prefer=s_hi), b])
        auto_a, auto_b = a, b
        # Jake's hand nudges from the review page (Descript-style), in ms, keyed by the
        # word the edge belongs to: "a:<first word id>" / "b:<last word id>". His edge
        # wins — the automatic room-tone fill on that side is dropped with it.
        na = (nudges or {}).get(f"a:{run[0]['i']}")
        nb_ = (nudges or {}).get(f"b:{run[-1]['i']}")
        if na:
            a = max(0.0, min(a + na / 1000.0, run[0]["e"] - 0.02))
            fill = [x for x in fill if x[1] != auto_a and x[0] != auto_a]
        if nb_:
            b = max(b + nb_ / 1000.0, run[-1]["s"] + 0.02)
            fill = [x for x in fill if x[0] != auto_b and x[1] != auto_b]
        # a kept in-breath is played whole: its louder fragments are not "clicks"
        muted = (([] if breath[k] else _clicks(audio, a, s_lo)) + _clicks(audio, s_hi, b)
                 + [x for x in fill if x[1] - x[0] > 0.004])
        # no held frames, ever (Jake) — the last two fields stay for the piece format
        out.append((a, max(b, a + 0.04), run, muted, 0.0, 0.0, {"auto_a": auto_a, "auto_b": auto_b}))
    return out


def pieces_for(ranges, fps, audio=None):
    """Snap ranges to the source frame grid. Audio sample counts run on a cumulative
    grid (48000/fps per frame, error carried) so they never drift from the frames.
    A piece is [held first frame x hold_head][src_frames of source][held last frame x hold_tail].

    Widening to whole frames adds up to one frame (33 ms) of source beyond the chosen
    cut. Where that sliver has sound (the start of a removed word), its audio is room
    tone — the picture keeps the frame, the ear never hears a fragment."""
    pieces, frames_done = [], 0
    loud = (lambda x, y: y - x > 0.001 and audio.rms_db(x, y) > audio.floor() + SPEECH_REL_DB - 4
            ) if audio is not None else (lambda x, y: False)
    for r in ranges:
        a, b, ws, muted = r[:4]
        hold_head, hold_tail = (r[4], r[5]) if len(r) > 4 else (0.0, 0.0)
        # widen to whole frames (start on/before a, end on/after b): rounding to the
        # NEAREST frame shaved up to 33 ms off pauses Jake wants at no less than 0.35 s
        f0 = math.floor(a * fps + 1e-6)
        n_src = max(1, math.ceil(b * fps - 1e-6) - f0)
        hf = math.ceil(hold_head * fps - 1e-6) if hold_head > 0.005 else 0
        tf = math.ceil(hold_tail * fps - 1e-6) if hold_tail > 0.005 else 0
        n = hf + n_src + tf
        s0 = round(frames_done * SR_OUT / fps)
        s1 = round((frames_done + n) * SR_OUT / fps)
        t0 = f0 / fps - hf / fps          # source time that maps to the piece's 0
        muted = list(muted)
        if loud(f0 / fps, a):
            muted.append([f0 / fps, a])
        if loud(b, (f0 + n_src) / fps):
            muted.append([b, (f0 + n_src) / fps])
        tone = []
        if hf:
            tone.append([0.0, round(hf / fps, 4)])
        tone += [[round(max(hf / fps, x - t0), 4), round(min((hf + n_src) / fps, y - t0), 4)]
                 for x, y in muted if y - t0 > hf / fps and x - t0 < (hf + n_src) / fps]
        if tf:
            tone.append([round((hf + n_src) / fps, 4), round(n / fps, 4)])
        auto = r[6] if len(r) > 6 else {}
        pieces.append({"src_frame": f0, "src_frames": n_src, "hold_head": hf, "hold_tail": tf,
                       # the exact cut in source seconds (frames are widened around it;
                       # what lies outside it is room tone when it has sound)
                       "src_a": round(a, 4), "src_b": round(b, 4),
                       "auto_a": round(auto.get("auto_a", a), 4), "auto_b": round(auto.get("auto_b", b), 4),
                       "frames": n, "out_frame": frames_done, "samples": s1 - s0,
                       "src_samples": round(n_src * SR_OUT / fps),
                       "head_samples": round(hf * SR_OUT / fps),
                       "word_ids": [w["i"] for w in ws],
                       # piece-relative seconds whose audio is room tone
                       "tone": tone})
        frames_done += n
    return pieces, frames_done


def output_words(pieces, by_id, fps):
    """Each kept word's start/end on the OUTPUT timeline (the edited video)."""
    out = []
    for p in pieces:
        src0 = (p["src_frame"] - p.get("hold_head", 0)) / fps
        out0, dur = p["out_frame"] / fps, p["frames"] / fps
        for i in p["word_ids"]:
            w = by_id[i]
            s = min(max(0.0, w["s"] - src0), dur) + out0
            e = min(max(0.0, w["e"] - src0), dur) + out0
            out.append({"i": i, "word": w["w"], "start": round(s, 3), "end": round(e, 3)})
    return out


def joins_for(pieces, by_id, fps):
    """One entry per cut, for the review page's cut editor: where it is in the edited
    video, the words either side, and both exact edges (+ what the algorithm chose)."""
    out = []
    for k in range(len(pieces) - 1):
        L, R = pieces[k], pieces[k + 1]
        lw, rw = L["word_ids"], R["word_ids"]
        out.append({
            "k": k, "out": round(R["out_frame"] / fps, 3),
            "left_id": lw[-1], "right_id": rw[0],
            "left_text": " ".join(by_id[i]["w"] for i in lw[-4:]),
            "right_text": " ".join(by_id[i]["w"] for i in rw[:4]),
            # words removed between the two sides (empty = only a pause was shortened)
            "removed": " ".join(by_id[i]["w"] for i in range(lw[-1] + 1, rw[0]) if i in by_id)[:200],
            "b": L["src_b"], "a": R["src_a"], "auto_b": L["auto_b"], "auto_a": R["auto_a"],
            "left_tone": [[round(L["src_frame"] / fps + x, 4), round(L["src_frame"] / fps + y, 4)] for x, y in L["tone"]],
            "right_tone": [[round(R["src_frame"] / fps + x, 4), round(R["src_frame"] / fps + y, 4)] for x, y in R["tone"]],
        })
    return out


def build(video, sents, by_id, audio, fps, exact_gap=False, nudges=None):
    kept = kept_words(video, sents)
    # the first kept word of every sentence (breath rule)
    starts = set()
    for seg in video["segments"]:
        first = next((w for w in sents[seg["s"]] if w["i"] not in set(seg.get("drop", []))), None)
        if first:
            starts.add(first["i"])
    rng = ranges_for(kept, by_id, audio, exact_gap, nudges, starts)
    pieces, frames = pieces_for(rng, fps, audio)
    return {"title": video["title"], "pieces": pieces, "frames": frames,
            "duration": round(frames / fps, 3), "cuts": max(0, len(pieces) - 1),
            "words": output_words(pieces, by_id, fps), "joins": joins_for(pieces, by_id, fps),
            "text": " ".join(w["w"] for w in kept), "warnings": video.get("warnings", [])}


def passthrough(words, by_id, duration, fps, title="Video 1"):
    """Workflow 2 ("Creative Edit an edited narration", Jake 2026-10-08): the narration is
    ALREADY edited, so the whole timeline is kept as it is — one piece from the first frame
    to the last whole frame, no cuts, no pause re-timing, no room tone. Same shape as
    build(), so everything downstream (sound check, preview, graphics, the full edit,
    the final) works on it unchanged."""
    n = max(1, int(math.floor(duration * fps + 1e-6)))
    end = n / fps
    pieces, frames = pieces_for([(0.0, end, list(words), [])], fps, None)
    return {"title": title, "pieces": pieces, "frames": frames,
            "duration": round(frames / fps, 3), "cuts": 0,
            "words": output_words(pieces, by_id, fps), "joins": [],
            "text": " ".join(w["w"] for w in words), "warnings": [], "passthrough": True}
