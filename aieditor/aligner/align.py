"""Re-time Whisper words against the audio with wav2vec2 forced alignment (torchaudio MMS_FA).

Whisper's word times drift 0.1-0.4 s, worst after a pause (a word gets stretched over
the silence before it), which makes cutting a single "so" impossible. Forced alignment
keeps Whisper's WORDS but finds where each one actually sits in the audio.

usage: python align.py <audio16k.wav> <words.json> <out.json>
Aligns sentence by sentence inside a padded window; a star token at both window ends
absorbs neighbouring or untranscribed speech. A window that fails keeps Whisper's times.
"""
import json, os, re, sys, time
import torch, torchaudio

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def num_words(n):
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000:
        return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + num_words(n % 100))
    for div, name in ((10**9, "billion"), (10**6, "million"), (1000, "thousand")):
        if n >= div:
            return num_words(n // div) + " " + name + ("" if n % div == 0 else " " + num_words(n % div))


def spoken(tok):
    """Whisper token -> the letters the aligner should look for (may be several words)."""
    t = tok.lower().replace("’", "'")
    t = t.replace("%", " percent").replace("&", " and ").replace("$", "")
    out = []
    for part in re.split(r"[\s\-/]+", t):
        m = re.fullmatch(r"(\d{4})s?", part.strip(".,!?:;\"'()"))
        if m and 1900 <= int(m.group(1)) <= 2099:          # years read as two pairs
            y = int(m.group(1))
            out.append(num_words(y // 100) + " " + (num_words(y % 100) if y % 100 >= 10 else "oh " + num_words(y % 100) if y % 100 else "hundred"))
            continue
        digits = re.sub(r"[,]", "", part)
        m = re.fullmatch(r"(\d+)(st|nd|rd|th|x|k)?", digits.strip(".!?:;\"'()"))
        if m:
            out.append(num_words(int(m.group(1))) + {"k": " thousand", "x": " times"}.get(m.group(2) or "", ""))
            continue
        out.append(re.sub(r"[^a-z']", "", part))
    return " ".join(o for o in out if o).split()


def main():
    wav_path, words_path, out_path = sys.argv[1:4]
    words = json.load(open(words_path))["words"]
    wav, sr = torchaudio.load(wav_path)
    assert sr == 16000
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=True).eval()
    tokenizer, aligner = bundle.get_tokenizer(), bundle.get_aligner()
    torch.set_num_threads(int(os.environ.get("THREADS", "2")))

    # sentence windows
    groups, cur = [], []
    for i, w in enumerate(words):
        if cur and float(w["start"]) - float(words[cur[-1]]["end"]) > 0.9:
            groups.append(cur); cur = []
        cur.append(i)
        if re.search(r"[.?!]$", w["word"].strip()):
            groups.append(cur); cur = []
    if cur:
        groups.append(cur)

    out = [dict(w, start=float(w["start"]), end=float(w["end"]), aligned=False) for w in words]
    t0, failed, n = time.time(), 0, wav.shape[1] / sr
    for gi, g in enumerate(groups):
        if gi % 25 == 0:
            print(f"progress {gi}/{len(groups)}", flush=True)
        a = max(0.0, float(words[g[0]]["start"]) - 0.6)
        b = min(n, float(words[g[-1]]["end"]) + 0.6)
        seg = wav[:, int(a * sr):int(b * sr)]
        toks = [spoken(words[i]["word"]) for i in g]
        flat = ["*"] + [x for t in toks for x in t] + ["*"]
        if len(flat) <= 2 or seg.shape[1] < sr * 0.2:
            failed += 1; continue
        try:
            with torch.inference_mode():
                emission, _ = model(seg)
            spans = aligner(emission[0], tokenizer(flat))
        except Exception:
            failed += 1; continue
        ratio = seg.shape[1] / emission.shape[1] / sr
        spans = spans[1:-1]                      # drop the two star tokens
        k = 0
        for i, t in zip(g, toks):
            if not t:
                continue
            first, last = spans[k], spans[k + len(t) - 1]
            k += len(t)
            out[i]["start"] = round(a + first[0].start * ratio, 3)
            out[i]["end"] = round(a + last[-1].end * ratio, 3)
            out[i]["aligned"] = True
    json.dump({"words": out}, open(out_path, "w"))
    moved = [abs(o["start"] - float(w["start"])) for o, w in zip(out, words) if o["aligned"]]
    moved.sort()
    print(f"{len(groups)} windows, {failed} failed, {sum(o['aligned'] for o in out)}/{len(out)} words aligned, "
          f"median shift {moved[len(moved)//2]:.3f}s, p90 {moved[int(len(moved)*.9)]:.3f}s, {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
