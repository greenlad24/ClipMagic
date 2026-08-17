# Multi-stage: build the web app and the server separately, ship one runtime.
#
# Also the typecheck. `--target web` and `--target server` each run the real
# `tsc`, so `docker build --target server .` is how you check the backend
# without a local toolchain.

# ── web ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN ./node_modules/.bin/tsc --noEmit -p tsconfig.json && npm run build

# ── server ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm install
COPY server/ ./
RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
# ffmpeg is required, not optional: it converts the PCM Gemini TTS returns into
# mp3, measures narration duration, and concatenates the rendered segments into
# the finished video.
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=server /build/server/dist ./dist
COPY --from=web /build/web/dist ./web/dist

ENV NODE_ENV=production \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/web/dist \
    PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/index.js"]
