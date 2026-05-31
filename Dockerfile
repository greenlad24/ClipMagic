# ClipMagic — single image that builds the React frontend + the Node/FFmpeg
# backend and serves everything on one port. Build context is the repo root.
#
#   docker build -t clipmagic .
#   docker run -p 8080:8080 -v clipmagic-data:/data clipmagic
#
# ── Stage 1: build the React frontend (web/ + the original app in src/) ───────
FROM node:22-bookworm-slim AS web
WORKDIR /build
# Install web deps first for caching.
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm install --no-audit --no-fund
# The web app imports the original app source from ../src, so copy both.
COPY web ./web
COPY src ./src
COPY tailwind.config.ts ./tailwind.config.ts
# Vite resolves bare deps from the importing file's tree; the src/ app resolves
# them from /build/node_modules, so link the web deps there too.
RUN ln -sfn /build/web/node_modules /build/node_modules
RUN cd web && npm run build   # -> /build/web/dist

# ── Stage 2: build the server (TypeScript -> dist) ───────────────────────────
FROM node:22-bookworm-slim AS server
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
# FFmpeg + fonts for burned-in subtitles; ca-certificates for fetching remote
# input URLs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg fonts-dejavu-core fontconfig ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=server /app/node_modules ./node_modules
COPY --from=server /app/dist ./dist
COPY server/package.json ./
COPY server/public ./public
COPY server/assets ./assets
# Built React app, served as the primary UI.
COPY --from=web /build/web/dist ./web/dist

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/web/dist

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
