#!/usr/bin/env python3
"""Headless-browser screenshotter — the platform's 'browser + screenshots at scale'.

Renders each `.slide` element of a self-contained carousel HTML to a crisp PNG using
Playwright driving the installed Chrome (no Chromium download). Also usable to
screenshot ANY url/element for real tutorial screenshots.

    .venv/bin/python scripts/render_slides.py            # renders assets/carousel.html slides
    .venv/bin/python scripts/render_slides.py --url https://example.com --sel "main" --out shot.png
"""

from __future__ import annotations

import argparse
import glob
import os
import sys

HTML = ".media/tutorial/assets/carousel.html"
OUTDIR = ".media/tutorial/assets"


def _browser(p):
    # Use the installed Chrome (channel) so no separate Chromium download is needed.
    for kw in ({"channel": "chrome"}, {}):
        try:
            return p.chromium.launch(headless=True, **kw)
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("could not launch Chrome/Chromium via Playwright")


def render_slides(html_path: str, outdir: str, scale: int = 2) -> list[str]:
    from playwright.sync_api import sync_playwright
    os.makedirs(outdir, exist_ok=True)
    url = "file://" + os.path.abspath(html_path)
    saved = []
    with sync_playwright() as p:
        b = _browser(p)
        pg = b.new_page(viewport={"width": 1080, "height": 1350}, device_scale_factor=scale)
        pg.goto(url, wait_until="networkidle")
        slides = pg.query_selector_all(".slide")
        if not slides:
            b.close(); sys.exit("no .slide elements found in the HTML")
        for i, el in enumerate(slides, 1):
            out = os.path.join(outdir, f"slide_{i:02d}.png")
            el.scroll_into_view_if_needed()
            el.screenshot(path=out)
            saved.append(out)
        b.close()
    return saved


def shoot_url(url: str, sel: str | None, out: str, scale: int = 2) -> str:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = _browser(p)
        pg = b.new_page(viewport={"width": 1080, "height": 1350}, device_scale_factor=scale)
        pg.goto(url, wait_until="networkidle")
        if sel:
            pg.query_selector(sel).screenshot(path=out)
        else:
            pg.screenshot(path=out, full_page=True)
        b.close()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", default=HTML)
    ap.add_argument("--outdir", default=OUTDIR)
    ap.add_argument("--url", help="screenshot an arbitrary url instead of the carousel")
    ap.add_argument("--sel", help="CSS selector to screenshot (with --url)")
    ap.add_argument("--out", default="shot.png")
    args = ap.parse_args()

    if args.url:
        print(shoot_url(args.url, args.sel, args.out))
        return
    saved = render_slides(args.html, args.outdir)
    print(f"rendered {len(saved)} slides -> {args.outdir}/slide_*.png")
    for s in saved:
        print("  ", s)


if __name__ == "__main__":
    main()
