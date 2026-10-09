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
check("frame_guard(" in le and "MIN_KEEP_S" in le, "compose cuts/drops screencasts the frame guard flags")
ar = (ROOT / "screencast" / "agent_rec.mjs").read_text()
check('execCommand("selectAll")' in ar, "typing clears a leftover draft first (C3)")
print(f"test_guard: {n} checks passed")
