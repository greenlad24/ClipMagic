# Tutorial Studio sidecar.
#
# The pipeline is Python, but every stage shells out to something heavy:
# ffmpeg (assembly, meme normalization, the grid montage), a headless Chromium
# (carousel slides, the prompt screenshot, and the frame-by-frame overlay pass),
# and faster-whisper (word timings). None of that belongs in the Lab's Node
# image, so it lives here and is reached over the Docker network.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

# ffmpeg + ffprobe are called by name from run_reel.py, prep_memes.py,
# make_tutorial_video.py and assemble_reel.py. fonts-liberation gives Chromium a
# sane default face; the three brand fonts ride with the asset pack.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# Chromium plus its system libraries. `--with-deps` is what pulls the ~40 shared
# objects headless Chrome needs on a slim image; without it Playwright launches
# and immediately dies with a missing-library error.
RUN python -m playwright install --with-deps chromium

# The package itself. Assets last — they are 41MB and change least often, but
# they'd still bust the pip layer if copied first.
COPY server.py run_reel.py ./
COPY scripts ./scripts
COPY assets ./assets

ENV DATA_DIR=/data PORT=3100
EXPOSE 3100

CMD ["python", "server.py"]
