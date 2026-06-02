// Reference implementation code for the two ShortStack microservices.
// These are displayed on the /setup page for the user to copy and deploy.

export const CAPTURE_PACKAGE_JSON = `{
  "name": "shortstack-capture",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "playwright": "^1.40.0",
    "@aws-sdk/client-s3": "^3.450.0",
    "uuid": "^9.0.0"
  }
}`;

export const CAPTURE_DOCKERFILE = `FROM mcr.microsoft.com/playwright:v1.40.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \\
  CMD curl -f http://localhost:3001/health || exit 1
CMD ["node", "server.js"]`;

export const CAPTURE_SERVER = `const express = require('express');
const { chromium } = require('playwright');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '1mb' }));

async function uploadClip(localPath) {
  const s3 = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const key = 'clips/' + uuidv4() + '.webm';
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: fs.readFileSync(localPath),
    ContentType: 'video/webm',
    ACL: 'public-read',
  }));
  const ep = process.env.S3_ENDPOINT;
  const b = process.env.S3_BUCKET;
  const r = process.env.AWS_REGION || 'us-east-1';
  return ep ? (ep + '/' + b + '/' + key)
            : ('https://' + b + '.s3.' + r + '.amazonaws.com/' + key);
}

app.post('/capture', async function(req, res) {
  const url      = req.body.url;
  const selector = req.body.selector;
  const duration = Math.max(0.5, (req.body.endTime || 5) - (req.body.startTime || 0));
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cap-'));

  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: { dir: tmpDir, size: { width: 1920, height: 1080 } },
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    if (selector) {
      try {
        await page.locator(selector).scrollIntoViewIfNeeded({ timeout: 5000 });
        await page.waitForTimeout(300);
      } catch (e) { /* selector not found — continue */ }
    }

    await page.waitForTimeout(duration * 1000);
    await context.close();
    await browser.close();

    const files = fs.readdirSync(tmpDir).filter(function(f) { return f.endsWith('.webm'); });
    if (!files.length) throw new Error('No video was recorded');

    const clipUrl = await uploadClip(path.join(tmpDir, files[0]));
    res.json({ clipUrl: clipUrl });
  } catch (err) {
    console.error('[capture]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
});

app.get('/health', function(_req, res) {
  res.json({ status: 'ok', service: 'capture' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('ShortStack capture service running on :' + PORT);
});`;

export const RENDER_PACKAGE_JSON = `{
  "name": "shortstack-render",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "@aws-sdk/client-s3": "^3.450.0",
    "uuid": "^9.0.0"
  }
}`;

export const RENDER_DOCKERFILE = `FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg curl fonts-dejavu-core \\
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
  CMD curl -f http://localhost:3002/health || exit 1
CMD ["node", "server.js"]`;

export const RENDER_SERVER = `const express = require('express');
const { execFile } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '10mb' }));

function download(url, dest) {
  return new Promise(function(resolve, reject) {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, function(response) {
      if (response.statusCode !== 200) {
        reject(new Error('Download failed: HTTP ' + response.statusCode + ' for ' + url));
        return;
      }
      response.pipe(file);
      file.on('finish', function() { file.close(); resolve(); });
    }).on('error', function(err) {
      fs.unlink(dest, function() {});
      reject(err);
    });
  });
}

// Binary-append chunks — raw byte slices cannot be opened by the ffmpeg concat demuxer
function assembleChunks(chunkPaths, destPath) {
  return new Promise(function(resolve, reject) {
    const wstream = fs.createWriteStream(destPath);
    wstream.on('error', reject);

    function pipeNext(i) {
      if (i >= chunkPaths.length) { wstream.end(resolve); return; }
      const rstream = fs.createReadStream(chunkPaths[i]);
      rstream.on('error', reject);
      rstream.on('end', function() {
        try { fs.unlinkSync(chunkPaths[i]); } catch(e) {}
        pipeNext(i + 1);
      });
      rstream.pipe(wstream, { end: false });
    }
    pipeNext(0);
  });
}

function ffrun(args) {
  return new Promise(function(resolve, reject) {
    execFile('ffmpeg', ['-y'].concat(args), { maxBuffer: 200 * 1024 * 1024 },
      function(err, _stdout, stderr) {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
  });
}

async function uploadOutput(localPath) {
  const s3 = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const key = 'renders/' + uuidv4() + '.mp4';
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: fs.readFileSync(localPath),
    ContentType: 'video/mp4',
    ACL: 'public-read',
  }));
  const ep = process.env.S3_ENDPOINT;
  const b  = process.env.S3_BUCKET;
  const r  = process.env.AWS_REGION || 'us-east-1';
  return ep ? (ep + '/' + b + '/' + key)
            : ('https://' + b + '.s3.' + r + '.amazonaws.com/' + key);
}

app.post('/render', async function(req, res) {
  const shots           = req.body.shots || [];
  const narrationUrl    = req.body.narrationUrl;
  const videoChunksJson = req.body.videoChunksJson;
  const audioUrl        = req.body.audioUrl;   // pre-extracted 16 kHz mono WAV (preferred for audio)
  const accentColor     = (req.body.accentColor || '#FFD60A').replace('#', '');
  const musicUrl        = req.body.musicUrl;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-render-'));

  try {
    // ── 1. Reassemble narration from chunks ─────────────────────────────────
    // IMPORTANT: chunks are raw byte slices of the original MP4, NOT valid
    // individual MP4 files. Use binary stream concatenation — ffmpeg concat
    // demuxer would fail with "moov atom not found".
    const chunks = videoChunksJson ? JSON.parse(videoChunksJson)
                                   : (narrationUrl ? [narrationUrl] : []);
    let narrationPath = null;
    if (chunks.length === 1) {
      narrationPath = path.join(tmpDir, 'narration.mp4');
      await download(chunks[0], narrationPath);
    } else if (chunks.length > 1) {
      const cpaths = [];
      for (let i = 0; i < chunks.length; i++) {
        const cp = path.join(tmpDir, 'chunk_' + i + '.mp4');
        await download(chunks[i], cp);
        cpaths.push(cp);
      }
      narrationPath = path.join(tmpDir, 'narration_full.mp4');
      await assembleChunks(cpaths, narrationPath);  // binary concat, not ffmpeg
    }

    // ── 2. Download pre-extracted narration audio (WAV) if available ────────
    // Prefer audioUrl (16 kHz mono WAV) over extracting audio from the video.
    let narrationAudioPath = null;
    if (audioUrl) {
      narrationAudioPath = path.join(tmpDir, 'narration_audio.wav');
      await download(audioUrl, narrationAudioPath);
    }

    // ── 3. Download music ────────────────────────────────────────────────────
    let musicPath = null;
    if (musicUrl) {
      musicPath = path.join(tmpDir, 'music.mp3');
      await download(musicUrl, musicPath);
    }

    // ── 4. Process each shot into a normalised 1080x1920 clip ───────────────
    const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const processedClips = [];

    for (let i = 0; i < shots.length; i++) {
      const shot     = shots[i];
      const duration = Math.max(0.1, (shot.endTime || 1) - (shot.startTime || 0));
      const outClip  = path.join(tmpDir, 'clip_' + i + '.mp4');
      const caption  = (shot.caption || '').replace(/'/g, "\\'").replace(/:/g, '\\\\:');
      const baseVf   = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
      const captVf   = caption
        ? 'drawtext=text=\\'' + caption + '\\'':x=(w-text_w)/2:y=h*0.82:fontsize=68:fontcolor=white'
          + ':fontfile=' + FONT + ':box=1:boxcolor=0x000000AA:boxborderw=16'
        : null;
      const vf = captVf ? (baseVf + ',' + captVf) : baseVf;

      if (shot.shotType === 'Talking Head' && narrationPath) {
        // Trim video segment from the reassembled narration file.
        // If a separate audio WAV exists, use it as the audio source for a cleaner mix.
        if (narrationAudioPath) {
          await ffrun([
            '-ss', String(shot.startTime || 0), '-t', String(duration), '-i', narrationPath,
            '-ss', String(shot.startTime || 0), '-t', String(duration), '-i', narrationAudioPath,
            '-map', '0:v', '-map', '1:a',
            '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-ar', '44100', '-r', '30', outClip,
          ]);
        } else {
          await ffrun([
            '-ss', String(shot.startTime || 0), '-t', String(duration), '-i', narrationPath,
            '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-ar', '44100', '-r', '30', outClip,
          ]);
        }
      } else if (shot.clipUrl) {
        const rawClip = path.join(tmpDir, 'raw_' + i + '.webm');
        await download(shot.clipUrl, rawClip);
        await ffrun([
          '-t', String(duration), '-i', rawClip,
          '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-r', '30', outClip,
        ]);
      } else {
        // Black-screen fallback
        const silentArgs = [
          '-f', 'lavfi', '-i', 'color=c=0x1a1a1a:size=1080x1920:duration=' + duration + ':rate=30',
          '-f', 'lavfi', '-i', 'aevalsrc=0:duration=' + duration,
        ];
        if (captVf) silentArgs.push('-vf', captVf);
        silentArgs.push('-c:v', 'libx264', '-c:a', 'aac', outClip);
        await ffrun(silentArgs);
      }
      processedClips.push(outClip);
    }

    // ── 5. Concatenate processed clips (these ARE valid MP4s, safe for concat demuxer) ──
    const clist = path.join(tmpDir, 'concat.txt');
    const concatContent = processedClips.map(function(f) { return "file '" + f + "'"; }).join('\\n');
    fs.writeFileSync(clist, concatContent);
    const concatOut = path.join(tmpDir, 'concat.mp4');
    await ffrun(['-f', 'concat', '-safe', '0', '-i', clist, '-c', 'copy', concatOut]);

    // ── 6. Mix in background music ───────────────────────────────────────────
    let finalOut = concatOut;
    if (musicPath) {
      finalOut = path.join(tmpDir, 'final.mp4');
      await ffrun([
        '-i', concatOut, '-i', musicPath,
        '-filter_complex',
        '[0:a]volume=1.0[narr];[1:a]volume=0.2,aloop=loop=-1:size=2e+09[mus];[narr][mus]amix=inputs=2:duration=first[aout]',
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', finalOut,
      ]);
    }

    const outputUrl = await uploadOutput(finalOut);
    res.json({ outputUrl: outputUrl });
  } catch (err) {
    console.error('[render]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
});

app.get('/health', function(_req, res) {
  res.json({ status: 'ok', service: 'render' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, function() {
  console.log('ShortStack render service running on :' + PORT);
});`;

export const DOCKER_COMPOSE = `version: '3.8'

services:
  capture:
    build: ./capture-service
    ports:
      - "3001:3001"
    environment:
      PORT: 3001
      S3_BUCKET: \${S3_BUCKET}
      S3_ENDPOINT: \${S3_ENDPOINT:-}
      AWS_REGION: \${AWS_REGION:-us-east-1}
      AWS_ACCESS_KEY_ID: \${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: \${AWS_SECRET_ACCESS_KEY}
    restart: unless-stopped

  render:
    build: ./render-service
    ports:
      - "3002:3002"
    environment:
      PORT: 3002
      S3_BUCKET: \${S3_BUCKET}
      S3_ENDPOINT: \${S3_ENDPOINT:-}
      AWS_REGION: \${AWS_REGION:-us-east-1}
      AWS_ACCESS_KEY_ID: \${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: \${AWS_SECRET_ACCESS_KEY}
    restart: unless-stopped`;

export const ENV_EXAMPLE = `# Cloud storage (AWS S3 or S3-compatible, e.g. Cloudflare R2, MinIO)
S3_BUCKET=your-bucket-name
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

# For Cloudflare R2 or MinIO, also set:
# S3_ENDPOINT=https://your-account.r2.cloudflarestorage.com

# Ports (optional — defaults shown)
# PORT=3001  (capture service)
# PORT=3002  (render service)`;

export const SETUP_COMMANDS = `# 1. Create the folder structure
mkdir shortstack-services
cd shortstack-services
mkdir capture-service render-service

# 2. Copy the files from the Setup Guide tabs into:
#    capture-service/server.js
#    capture-service/package.json
#    capture-service/Dockerfile
#    render-service/server.js
#    render-service/package.json
#    render-service/Dockerfile
#    docker-compose.yml  (at the root)
#    .env                (at the root)

# 3. Build and start both services
cp .env.example .env   # edit with your values
docker compose up -d --build

# 4. Confirm both services are healthy
curl http://localhost:3001/health   # → {"status":"ok","service":"capture"}
curl http://localhost:3002/health   # → {"status":"ok","service":"render"}

# 5. Add the URLs as secrets in ShortStack
#    ZITE_CAPTURE_SERVICE_URL = http://your-server-ip:3001
#    ZITE_RENDER_SERVICE_URL  = http://your-server-ip:3002`;
