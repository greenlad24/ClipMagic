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
print(f"test_guard: {n} checks passed")
