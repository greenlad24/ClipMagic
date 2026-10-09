"""Mac-Chrome recorder + challenge guard (Jake 2026-10-08): offline checks."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import agentrec, cloud, config  # noqa: E402

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


e = agentrec.WallError({"kind": "challenge", "why": "Just a moment...", "url": "https://chatgpt.com/"})
check(isinstance(e, RuntimeError), "a wall is a RuntimeError (the caller's retry path catches it)")
check("human check" in agentrec.wall_message("chatgpt", e.wall), "challenge message")
check("login page" in agentrec.wall_message("chatgpt", {"kind": "login"}), "login message")
check(agentrec.wall_message("chatgpt", {}).startswith("ChatGPT"), "app name in the job log")
check(config.SC_IMAGE in cloud.IMAGES, "the recorder image is baked into the factory snapshot")
check(cloud.EGRESS.startswith("http://10.104."), "egress proxy is a VPC address")
mc = (ROOT / "screencast" / "macchrome.mjs").read_text()
for needle in ("AutomationControlled", '"MacIntel"', 'platform: "macOS"', '"Google Chrome"', "Asia/Bangkok",
               "__amhb", "--proxy-server", "verify you are human", "just a moment"):
    check(needle.lower() in mc.lower(), f"macchrome.mjs has {needle}")
fonts = (ROOT / "screencast" / "image" / "fonts-mac.conf").read_text()
for fam in ("-apple-system", "BlinkMacSystemFont", "system-ui", "SF Pro", "Helvetica Neue", "SF Mono"):
    check(re.search(rf"<family>{re.escape(fam)}</family>", fonts), f"font alias for {fam}")
for f in ("agent_rec.mjs", "vrecord.mjs", "inventory.mjs"):
    src = (ROOT / "screencast" / f).read_text()
    check("macchrome.mjs" in src and "/usr/bin/chromium" not in src, f"{f} launches through macchrome.mjs")
qa = (ROOT / "screencast" / "qa_content.py").read_text()
check("no_challenge" in qa, "QA rejects a recorded challenge page")

# overlay frames named by a float (render.mjs before 2026-10-09) are repaired before compose
import tempfile  # noqa: E402
from aieditor import graphics_long  # noqa: E402
with tempfile.TemporaryDirectory() as td:
    ev = Path(td) / "ev-03"
    ev.mkdir()
    for i in range(3):
        (ev / f"f{1920.0000000000002 + i}.png").write_text("x")
    (ev / "f02048.png").write_text("x")
    k = graphics_long.repair_frame_names(td, [{"frames_dir": "ev-03"}, {"frames_dir": "missing"}, {}])
    names = sorted(p.name for p in ev.iterdir())
    check(k == 3 and names == ["f01920.png", "f01921.png", "f01922.png", "f02048.png"], f"frame names repaired: {names}")
rj = (ROOT / "motion" / "render.mjs").read_text()
check("Math.round(first)" in rj and "outFirst != null" in rj, "render.mjs names frames by integer output frame")

# the frame guard (OCR) patterns
sys.path.insert(0, str(ROOT / "screencast"))
try:
    import qa_frames  # noqa: E402  (needs cv2: present in the screencast image only)
except ImportError:
    qa_frames = None
if qa_frames:
    check(qa_frames.CHALLENGE.search("Unusual activity has been detected from your device. Try again later."), "OCR: block")
    check(qa_frames.ERROR.search("Message delivery timed out. Please try again."), "OCR: error")
    check(qa_frames.GREET.search("Hey, Keith. Ready to dive in?").group(1) == "Keith", "OCR: greeting")
le = (ROOT / "aieditor" / "longedit.py").read_text()
check("frame_guard(" in le and "screen_pieces(" in le and "gates.salvage(" in le,
      "compose salvages the clean footage around what the frame guard flags (never a prefix-cut + A-roll)")
check("GUARD_EVERY_S = gates.GUARD_EVERY_S" in le and "--expect" in le, "the guard runs every 0.5 s with the beat expectations")
ar = (ROOT / "screencast" / "agent_rec.mjs").read_text()
check('execCommand("selectAll")' in ar, "typing clears a leftover draft first (C3)")
# the extended guard's pure rules (gap list G4.2): idle tail, empty canvas, garbled text, red-text margin
if qa_frames:
    sp = qa_frames.hit_spans([{"t": 10.0, "kind": "challenge", "why": "x"}, {"t": 10.5, "kind": "challenge", "why": "x"}], 0.5, 60)
    check(sp == [{"t0": 9.5, "t1": 11.0, "kind": "challenge", "why": "x"}], f"a run of hits widened by one interval: {sp}")
    stills = [(t / 2, 0.5 if t < 20 else 0.0) for t in range(0, 120)]          # moves for 10 s, then frozen
    idle = qa_frames.idle_spans(stills, [{"type": "click", "t": 4.0}], 60.0, 0.5)
    check(len(idle) == 1 and idle[0]["kind"] == "idle_tail" and idle[0]["t0"] <= 10.0, f"idle tail: {idle}")
    idle = qa_frames.idle_spans(stills, [{"type": "click", "t": 30.0, "end": 30.2}], 60.0, 0.5)
    check(idle and idle[0]["t0"] >= 30.0, "an agent event inside a freeze: only what follows it is idle")
    short = [(t / 2, 0.0 if 10 <= t < 14 else 0.5) for t in range(0, 40)]     # 2 s still: allowed
    check(qa_frames.idle_spans(short, [], 20.0, 0.5) == [], "a still under 3 s is fine")
    win = qa_frames.content_windows([{"at": 5.0, "content": True}, {"at": 9.0, "content": False}], 20.0)
    check(win == [(5.0, 9.0)], f"content windows: {win}")
    em = qa_frames.empty_spans([(4.5, 0.95), (5.0, 0.95), (5.5, 0.95), (9.5, 0.95), (6.0, 0.3)], win, 0.5)
    check(len(em) == 1 and em[0]["t0"] == 5.0 and em[0]["kind"] == "empty", f"empty canvas only where a result is due: {em}")
    ev = [{"type": "type", "t": 2.0, "end": 3.0, "text": "Create a shallow depth of field effect",
           "value": "Colorize this black and white photoCreate a shallow depth of field effect"}]
    texts = [(t / 2, "Colorize this black and white photo Create a shallow") for t in range(4, 20)]
    gb = qa_frames.garbled_spans(ev, texts, 0.5, 30.0)
    check(gb and gb[0]["kind"] == "garbled" and gb[0]["t1"] >= 9.5, f"garbled field text while the OCR reads it: {gb}")
    ok = [{"type": "type", "t": 2.0, "text": "Remove the man", "value": "Remove the man"}]
    check(qa_frames.garbled_spans(ok, texts, 0.5, 30.0) == [], "a field holding exactly the typed text is fine")
    m = qa_frames.merge_kind([{"t0": 1, "t1": 3, "kind": "garbled"}, {"t0": 2, "t1": 5, "kind": "garbled"},
                              {"t0": 2, "t1": 4, "kind": "idle"}])
    check(len(m) == 2 and m[0]["t1"] == 5, "same-kind spans merge, different kinds stay")
print(f"test_guard: {n} checks passed")
