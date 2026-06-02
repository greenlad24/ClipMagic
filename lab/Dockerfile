# ClipMagic LAB — identical build to the main image, but for the isolated lab
# app. Build context is the lab/ directory (which mirrors the repo layout:
# lab/web + lab/src + lab/server), so this is the root Dockerfile unchanged
# except it defaults to port 9090. Keys come from the SAME .env as the main app
# (wired in docker-compose.yml); only the port and data volume are isolated.
#
#   docker compose --profile lab up -d --build clipmagic-lab
#   then open http://<host>:9090
#
# ── Stage 1: build the React frontend (web/ + the original app in src/) ───────
FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm install --no-audit --no-fund
# The web app imports the original app source from ../src, so copy both.
COPY web ./web
COPY src ./src
COPY tailwind.config.ts ./tailwind.config.ts
# The src/ app resolves bare deps from /build/node_modules; link the web deps.
RUN ln -sfn /build/web/node_modules /build/node_modules
RUN cd web && npm run build   # -> /build/web/dist

# ── Stage 2: build the server (tsc) + AI pipeline bundle (esbuild) ───────────
FROM node:22-bookworm-slim AS server
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/scripts ./scripts
COPY server/src ./src
# Original app source the pipeline bundle compiles against.
COPY src /build/src
# esbuild resolves the bundled app-source's deps (zod, nanoid) from
# /build/node_modules; point it at the server deps (which include them).
RUN ln -sfn /build/server/node_modules /build/node_modules
RUN npm run build
RUN test -f dist/ai/pipeline-bundle.js \
      || (echo "ERROR: dist/ai/pipeline-bundle.js was not built" >&2; exit 1)
RUN npm prune --omit=dev

# ── Stage 2b: Remotion motion-graphics project (optional feature) ─────────────
# Installs the @remotion/* SSR deps for the motion-graphics service. Kept in its
# own stage so a failure here (or a future removal) never affects the core build,
# and so its heavy deps are copied into the runtime ONLY for this feature. The
# feature is still gated at runtime by MOTION_GRAPHICS=1.
FROM node:22-bookworm-slim AS motion
WORKDIR /build/remotion
COPY remotion/package.json remotion/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY remotion ./

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
# Base render deps + the system libraries Remotion's headless Chromium needs.
# The Chromium libs add ~300MB; they're harmless when MOTION_GRAPHICS is off
# (Chromium is simply never launched). Remotion downloads its own Chromium binary
# on first ensureBrowser() into REMOTION_BROWSER cache under /data.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg fonts-dejavu-core fontconfig ca-certificates \
       libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
       libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
       libpango-1.0-0 libcairo2 libatspi2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=server /build/server/node_modules ./node_modules
COPY --from=server /build/server/dist ./dist
COPY server/package.json ./
COPY server/public ./public
COPY server/assets ./assets
COPY --from=web /build/web/dist ./web/dist
# Remotion project (source + its node_modules) for the motion-graphics service.
COPY --from=motion /build/remotion ./remotion

ENV NODE_ENV=production \
    PORT=9090 \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/web/dist \
    MOTION_ENTRY_POINT=/app/remotion/src/index.ts \
    REMOTION_BROWSER_EXECUTABLE= \
    REMOTION_BROWSER_CACHE_DIR=/data/.remotion-chromium

VOLUME ["/data"]
EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
