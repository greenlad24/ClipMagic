#!/usr/bin/env bash
# One-time setup for Tutorial Studio.
set -e
echo "1) System deps: ensure ffmpeg is installed (e.g. apt-get install -y ffmpeg / brew install ffmpeg)"
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not found"; exit 1; }
echo "2) Python venv + deps"
python3 -m venv .venv
. .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
echo "3) Headless browser (bundled Chromium for Playwright)"
python -m playwright install chromium
echo "4) Copy .env.example -> .env and add your keys"
[ -f .env ] || cp .env.example .env
echo "Done. Run:  .venv/bin/python run_reel.py \"how to make carousels with Claude\""
