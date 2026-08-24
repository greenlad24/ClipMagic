#!/usr/bin/env python3
"""Generate a real Instagram carousel via the Claude API (self-contained HTML).

This is the platform's asset source: Claude actually designs the carousel (the exact
thing the tutorial teaches), returned as one self-contained HTML file whose slides are
`<section class="slide" id="slide-N">` at 1080x1350 (4:5). render_slides.py then
rasterizes each slide to a PNG headlessly — no browser scraping, no manual download.

    .venv/bin/python scripts/generate_carousel.py "3 AI habits that save founders 5+ hours a week"

Writes .media/tutorial/assets/carousel.html.
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

OUT = ".media/tutorial/assets/carousel.html"
MODEL = "claude-opus-5"

SYSTEM = (
    "You are an expert Instagram carousel designer. Output ONE self-contained HTML "
    "document and NOTHING else (no prose, no markdown fences). Requirements:\n"
    "- Exactly 10 slides. Each slide is `<section class=\"slide\" id=\"slide-1\">` … "
    "`id=\"slide-10\"`, in order.\n"
    "- Each .slide is EXACTLY 1080px wide by 1350px tall (4:5), overflow hidden, and "
    "lays out its content with flexbox (centered padding ~90px).\n"
    "- All CSS is inline in a single <style>; NO external assets, fonts, images, JS "
    "libraries, or network requests (use system font stacks; draw accents with CSS).\n"
    "- A cohesive modern design system: one bold headline font stack, one body stack, a "
    "consistent color palette, generous whitespace, a small slide counter (e.g. 01/10) "
    "and a subtle brand mark per slide.\n"
    "- Slide 1 = a scroll-stopping hook. Middle slides = punchy headlines + short body "
    "copy (real, specific, useful). Slide 10 = a clear CTA.\n"
    "- Body background neutral; the .slide elements are the posts."
)


def _key() -> str:
    for line in open(".env", encoding="utf-8"):
        if line.startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("ANTHROPIC_API_KEY not in .env")


def main() -> None:
    topic = sys.argv[1] if len(sys.argv) > 1 else "3 AI habits that save founders 5+ hours a week"
    import anthropic
    client = anthropic.Anthropic(api_key=_key())
    print(f"Claude API: designing carousel — {topic} …", flush=True)
    with client.messages.stream(
        model=MODEL, max_tokens=20000, system=SYSTEM,
        messages=[{"role": "user", "content":
                   f"Design the 10-slide carousel about: {topic}. Return only the HTML."}],
    ) as stream:
        msg = stream.get_final_message()
    html = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    # strip accidental code fences
    html = re.sub(r"^```[a-zA-Z]*\n|\n```$", "", html).strip()
    if "<section" not in html or "slide-1" not in html:
        sys.exit("model did not return the expected slide HTML:\n" + html[:400])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(html)
    n = len(re.findall(r'id="slide-\d+"', html))
    print(f"  -> {OUT}  ({n} slides, {len(html)} bytes)")
    print(f"  usage: in={msg.usage.input_tokens} out={msg.usage.output_tokens}")


if __name__ == "__main__":
    main()
