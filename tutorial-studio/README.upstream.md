# Tutorial Studio

Automated English talking-head **tutorial reels** (9:16, ~30s) in a reference-accurate
editing style. One command turns a topic into a finished reel:

> script → talking-head + voice (Wan 3.0) → real carousel (Claude) → slides + prompt
> screenshots (headless browser) → designed paper-note overlays + memes + SFX → `reel.mp4`

Standalone — no database, no server, no legacy app. Just Python + ffmpeg + a headless
browser.

## Setup (once)

```bash
bash setup.sh            # ffmpeg check, venv, pip deps, Playwright Chromium, .env
# then edit .env and add APIMART_API_KEY + ANTHROPIC_API_KEY
```

Requirements: **Python 3.10+**, **ffmpeg** on PATH, internet (Google Fonts + the APIs).

## Run

```bash
.venv/bin/python run_reel.py "how to make carousels with Claude"
# reuse the last talking-head (skip the ~$2 Wan step, only swap the teaching content):
.venv/bin/python run_reel.py "how to ..." --reuse-base
```

Output: `.media/tutorial/reel.mp4`. Always run from the package root (paths are relative
to `.media/tutorial/`).

## What each stage does (scripts/)

| Script | Stage | API |
|---|---|---|
| `make_tutorial_script.py` | 30s English script + two-part title + CTA | Qwen (apimart) |
| `make_talkinghead_frame.py` | creator start frame (`--outfit`/`--scene`), hosted URL for Wan | GPT Image 2 (apimart) |
| `make_tutorial_video.py` | one ~30s talking clip **with generated voice** | Wan 3.0 (apimart) |
| `generate_carousel.py` | real self-contained carousel HTML | Claude API |
| `render_slides.py` | rasterize each slide (also screenshots any URL) | Playwright |
| `make_prompt_shot.py` | the prompt shown inside a chat input box | Playwright |
| `prep_memes.py` | normalize meme GIFs → short render-safe clips (auto) | ffmpeg |
| `sfx.py` | synthesized click/whoosh/pop (royalty-free) | numpy |
| `assemble_reel.py` + `overlay_engine.html` | build the timeline, render overlays frame-by-frame, composite + memes + SFX | Playwright + ffmpeg |
| `make_creator_sheet.py` / `make_room_frame.py` / `make_element.py` | (helpers) generate a new creator/room/element | GPT Image 2 |

## Design system (assets in `.media/tutorial/`)

- **fonts/** — `FruityCake` (title lead-in) + `rozanova-geo-black` (main title) + `FunClub-Italic` (paper-note ink).
- **elements/** — torn-paper strips chosen by text length (`short CTA` / `longer CTA` / `2-lines`) + `brush-stroke` (underline below a note).
- **memes/** — reaction GIFs named by sentiment (matched to the words she says). Add/remove freely.
- **refs/** — `creator_sheet.png`, `room.png` (the creator's identity + room for start frames).

Editing rules baked in: two-font title (title alone for the first ~1s), word-by-word
captions, elements word-synced to the narration, paper notes only at top or center-middle
(never over subtitles), all screenshots centered + straight, max 2 memes centered and
never over a card, hard cuts, mouse-click SFX. Captions style is unchanged from the
reference.

## Cost per video

~**$2.45** fresh (Wan ~$2.06 + carousel ~$0.36 + start frame ~$0.04 + script ~$0.02).
`--reuse-base` ≈ **$0.40**. Everything else (slides, overlays, captions, SFX, memes,
assembly) runs locally for free. 480P Wan or a Sonnet carousel lower it further.

## Swapping the creator / brand

- New creator: `python scripts/make_creator_sheet.py` (edit the prompt), then it becomes `refs/creator_sheet.png`.
- New room: `python scripts/make_room_frame.py`.
- Per-video outfit/scene: `run_reel.py --outfit "..." --scene "..."`.
- New design elements: drop your own PNGs into `elements/` (keep the length-based names) and GIFs into `memes/`.

## Notes

- The overlay engine loads Poppins + Space Grotesk from Google Fonts (needs internet);
  the three uploaded fonts are embedded from `fonts/`.
- If system Chrome isn't installed, the scripts fall back to Playwright's bundled Chromium
  (installed by `setup.sh`).
- The Wan poll endpoint is apimart's `/v1/tasks/{id}`; each run also saves the task id
  (`*.task.txt`) so a timed-out job is recoverable via `scripts/… ` fetch-by-id.
