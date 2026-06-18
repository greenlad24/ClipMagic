# ClipMagic self-hosted server — one image that uploads, stores, renders
# (local FFmpeg) and serves the bulk UI. Designed to run on a single droplet.
FROM node:22-bookworm-slim

# FFmpeg + fonts for burned-in subtitles. fontconfig lets libass/drawtext
# resolve font names; ca-certificates lets the server fetch remote input URLs.
# libgomp1 is required by onnxruntime-node (the background-removal model used to
# cut characters out for the contrarian workflow's 1:1 programmatic composite).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg fonts-dejavu-core fontconfig ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching. better-sqlite3 ships prebuilt
# binaries for node22/glibc, so no compiler toolchain is needed.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source + build
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY assets ./assets
# Build needs typescript (a dev dep); install it transiently then compile.
RUN npm install --no-audit --no-fund typescript@5.7.3 \
  && npx tsc -p tsconfig.json \
  && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# Persisted volume: uploads, outputs, sqlite db, tmp downloads.
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
