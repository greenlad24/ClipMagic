# Screencast recorder + camera renderer for the Auto Editor (phase 3).
# Base = the Lab image: chromium, puppeteer-core (/app/node_modules), ffmpeg 5/6.
FROM clipmagic-lab:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth python3-numpy python3-opencv opencv-data \
      fonts-noto-color-emoji fonts-inter && rm -rf /var/lib/apt/lists/*
ENTRYPOINT []
