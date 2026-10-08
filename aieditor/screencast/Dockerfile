# Screencast recorder + camera renderer for the Auto Editor.
# 0.1 = the Lab image (chromium, puppeteer-core in /app/node_modules, ffmpeg) + xvfb, numpy/opencv,
#       Noto Color Emoji, Inter:
#   FROM clipmagic-lab:latest
#   RUN apt-get install xvfb xauth python3-numpy python3-opencv opencv-data fonts-noto-color-emoji fonts-inter
# 0.2 (2026-10-08, Jake: "it should be acting like a real chrome on Mac not chromium"): adds Google
#     Chrome stable (the Chrome brand + proprietary codecs; agent_rec.mjs prefers it) and the macOS
#     font look (image/fonts-mac.conf). Build: docker build -t aieditor-screencast:0.2 screencast/
FROM aieditor-screencast:0.1
USER root
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates fonts-jetbrains-mono \
      fonts-liberation2 fonts-inter fonts-noto-color-emoji \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb && rm -f /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/*
COPY image/fonts-mac.conf /etc/fonts/local.conf
RUN fc-cache -f >/dev/null && google-chrome-stable --version
ENTRYPOINT []
