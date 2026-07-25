FROM node:20-slim

# ---------------------------------------------------------------------------
# System Chromium + the runtime libraries Puppeteer/whatsapp-web.js needs.
# We use the distro Chromium rather than letting Puppeteer download its own,
# so PUPPETEER_SKIP_DOWNLOAD is enabled below.
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libgtk-3-0 \
      libgbm1 \
      libasound2 \
      libxshmfence1 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libxkbcommon0 \
      libpango-1.0-0 \
      libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer's own Chromium download and point the app at the system binary.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    WA_CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# Install runtime-only dependencies first for better layer caching.
COPY package*.json ./
# Prefer a reproducible install from the lockfile. If no package-lock.json is
# present, swap this line for: RUN npm install --omit=dev
RUN npm ci --omit=dev

# Copy the rest of the application.
COPY . .

EXPOSE 3000

CMD ["node", "server/index.js"]
