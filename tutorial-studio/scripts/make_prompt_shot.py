#!/usr/bin/env python3
"""Render a clean 'prompt screenshot' (the real carousel prompt in a chat UI) via
Playwright → .media/tutorial/assets/prompt.png. Used as a card in every tutorial video.

    .venv/bin/python scripts/make_prompt_shot.py "Make me a 10-slide carousel about ..."
"""

from __future__ import annotations

import os
import sys

OUT = ".media/tutorial/assets/prompt.png"
DEFAULT = ("Make me a 10-slide Instagram carousel about “3 AI habits that save "
           "founders 5+ hours a week”. Fully designed — a scroll-stopping hook, "
           "punchy headlines, short body copy, consistent colors and type, and a final "
           "CTA. Make every slide a 4:5 image ready to post.")

HTML = """<!doctype html><html><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
html,body{{margin:0;width:1080px;height:1350px;background:#F5F4EF;font-family:'Inter',sans-serif;
  display:flex;flex-direction:column;}}
.top{{display:flex;align-items:center;gap:16px;color:#3d3d3a;font-weight:700;font-size:34px;padding:60px 64px 0;}}
.dot{{width:30px;height:30px;border-radius:50%;background:#D97757;}}
.greet{{flex:1;display:flex;align-items:flex-end;justify-content:center;color:#c9c6bd;
  font-size:52px;font-weight:600;padding-bottom:30px;}}
/* the compose / input box with the prompt typed inside */
.compose{{margin:0 56px 64px;background:#fff;border:1px solid #e3e1da;border-radius:34px;
  padding:40px 44px 30px;box-shadow:0 14px 40px rgba(0,0,0,.08);}}
.field{{font-size:41px;line-height:1.5;color:#26251f;min-height:120px;}}
.field .cursor{{display:inline-block;width:3px;height:40px;background:#D97757;vertical-align:-7px;margin-left:3px;}}
.row{{display:flex;align-items:center;justify-content:space-between;margin-top:30px;}}
.tools{{display:flex;gap:20px;color:#8a8880;font-size:40px;}}
.tools span{{width:56px;height:56px;border:2px solid #e3e1da;border-radius:14px;display:flex;
  align-items:center;justify-content:center;}}
.send{{width:70px;height:70px;border-radius:50%;background:#D97757;display:flex;align-items:center;
  justify-content:center;color:#fff;font-size:40px;}}
</style></head>
<body>
  <div class="top"><span class="dot"></span>Claude</div>
  <div class="greet">How can I help you today?</div>
  <div class="compose">
    <div class="field">{prompt}<span class="cursor"></span></div>
    <div class="row"><div class="tools"><span>+</span><span>&#9776;</span></div>
      <div class="send">&#8593;</div></div>
  </div>
</body></html>"""



def _launch(p):
    """Launch system Chrome if present, else Playwright's bundled Chromium."""
    for kw in ({"channel": "chrome"}, {}):
        try:
            return p.chromium.launch(headless=True, **kw)
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("no Chrome/Chromium available (run: playwright install chromium)")

def render(prompt: str, out: str = OUT):
    from playwright.sync_api import sync_playwright
    os.makedirs(os.path.dirname(out), exist_ok=True)
    html = HTML.format(prompt=prompt)
    with sync_playwright() as p:
        b = _launch(p)
        pg = b.new_page(viewport={"width": 1080, "height": 1350}, device_scale_factor=2)
        pg.set_content(html, wait_until="networkidle")
        pg.wait_for_timeout(500)
        pg.screenshot(path=out)
        b.close()
    return out


def main():
    prompt = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    print("rendered", render(prompt))


if __name__ == "__main__":
    main()
