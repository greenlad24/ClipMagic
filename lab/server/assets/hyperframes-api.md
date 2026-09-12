# Hyperframes render server — API contract

**Status: live.** Every endpoint below is implemented, deployed and verified
end to end — submit, render, poll, download, cancel, delete, and both asset
routes (a 488 KB font and an image arrived byte-identical through a real render,
SHA-256 checked on the way out).

Get your key from the Render queue page in the Lab (API key button), or on the
server with `hyperframes-key show`.

Base URL `https://lab.jakedaw.com/api/hyperframes/v1`
Auth `Authorization: Bearer <token>` on every request, including downloads.
Content type `application/json` for all request bodies.

---

## The one thing to get right

**Send links, not files.** A submit is a small JSON document. The server fetches
the video and stock footage itself, straight from the URLs you give it.

Measured on this box: a 3.19 GB Descript master downloads in **under 4 minutes**
at 14 MB/s. Pushing the same file through a chat sandbox or an MCP connector is
not possible at all. So:

```
you  → { "url": "https://share.descript.com/view/5Pn6JYDr88G" }   ~200 bytes
server → downloads 3.19 GB directly                               ~4 minutes
```

`share.descript.com/view/...` links are resolved natively — the server extracts
the signed media URL from the share page. Any other direct-download URL works
too, as long as it responds to a plain GET without a login.

**When you hold bytes and no URL**, use an upload bucket (section 3) for large
or binary assets, or put a small one straight in `project.files` as base64. The
rule above is about footage, which is gigabytes; a font is not.

---

## 1. Readiness

```http
GET /ready
```

Confirms the pinned runtime verifies and there is room to work. Call it before a
submit if you want a clean failure instead of a queued job that cannot run.

```json
{
  "ok": true,
  "runtime": {
    "hyperframes": "0.8.30",
    "browser": "Chrome headless shell 152.0.7977.30",
    "node": "24.19.0",
    "verified": true,
    "files_verified": 6050
  },
  "worker": { "healthy": true, "running": 0, "queued": 0 },
  "disk": { "free_bytes": 47563112448, "free_human": "44.3GB" },
  "concurrency": 1
}
```

`ok` is false when the runtime fails its integrity check, the worker is not
responding, or free disk is under 5 GB. `concurrency` is 1: this is a 4-vCPU box
that also runs other services, so renders queue rather than compete.

---

## 2. Submit a render

```http
POST /jobs
```

```json
{
  "name": "Blotato walkthrough",
  "client_ref": "video-0042",

  "project": {
    "files": {
      "index.html": "<!doctype html>…the composition…",
      "styles.css": "…",
      "fonts/Heading.woff2": { "base64": "d09GMgABAAAAA…" }
    },
    "upload_id": "up_x9Qf2K7mB3nVtLpZ"
  },

  "sources": [
    {
      "name": "main.mp4",
      "url": "https://share.descript.com/view/5Pn6JYDr88G",
      "bytes": 3192109832
    },
    {
      "name": "broll-city.mp4",
      "url": "https://cdn.example.com/stock/city-4k.mp4",
      "prepare": { "scale": "3840x2160" }
    }
  ],

  "render": {
    "fps": 30,
    "quality": "high",
    "output_name": "render.mp4"
  }
}
```

| field | required | meaning |
|---|---|---|
| `name` | yes | Human label. Becomes part of the job id. |
| `client_ref` | no | Your own identifier, echoed back on every response. Use it to correlate; the server does not interpret it. |
| `project.files` | one of | The composition, as a filename → content map. `index.html` is required somewhere in the project. A value is either a **string** (text) or **`{"base64": "…"}`** for binary. 24 MB total, counted decoded. |
| `project.upload_id` | one of | A bucket of files already uploaded (section 3), linked into the project. Combine freely with `files` — on a name collision, `files` wins. |
| `project.url` | one of | Alternative: a `.zip`/`.tar.gz` the server downloads and unpacks. |
| `sources` | no | Footage to fetch. Each lands at `media/<name>` inside the project. |
| `sources[].bytes` | no | Expected size. If given and the file is already present at that size, the download is skipped — this is how a revision reuses footage already here. |
| `sources[].prepare` | no | An ffmpeg pass before the render sees it: `scale` (`"3840x2160"`), `fps`, `trim_start`, `trim_duration`. See section 3. |
| `render.fps` | no | Default 30. |
| `render.quality` | no | `draft` \| `standard` \| `high`. Default `high`. |
| `render.output_name` | no | Default `render.mp4`. |
| `render.chunk_frames` | no | Frames per chunk. Default **150**. See section 4. |
| `render.chunk_seconds` | no | Same thing in seconds (2-60), if you prefer. |

Filenames are restricted — see **Filenames the server accepts** in section 3
before naming anything. `logo@2x.png` and `_variables.css` are both rejected.

Reference footage by its media path. A `<video>` needs a real `src`, an `id`
and `muted` — see **What a project must contain**:

```html
<video id="presenter" src="media/main.mp4" data-start="0" data-duration="12"
       muted playsinline></video>
```

**Response — 202 Accepted**, immediately, before any downloading starts:

```json
{
  "job_id": "blotato-walkthrough-09081912",
  "client_ref": "video-0042",
  "status": "queued",
  "runtime": "Hyperframes 0.8.30"
}
```

### Revisions

⚠️ **Correction — read this before planning a revision.** An earlier version of
this contract said that re-submitting with the same `sources` and `bytes` reuses
footage already on the server. **That is only true within one job.** Every submit
gets its own job directory and its own `media/`, so a *new* job with the same
`sources` re-downloads them — for a 3 GB master, several minutes and several
gigabytes, every revision.

What each mechanism actually does:

| | scope |
|---|---|
| `sources[].bytes` matching | **Retries of the same job.** A job that failed and is re-attempted skips footage it already has. |
| **Upload bucket** (`project.upload_id`) | **Across submits.** Files are hard-linked into each job, so a bucket feeds any number of renders at no extra disk and no re-download. |

**So: for anything you will revise, put the footage in a bucket** (section 3) and
submit with `upload_id` and no `sources` entry for it. Buckets last 24 hours.
Use `sources[]` for footage fetched once.

⚠️ `bytes` also means different things on the two paths: with `prepare` it is
compared against the **raw download**, without it against the **final file**. If
you set it to the prepared size on a prepared source, the check never matches.
Leave it out when you are unsure — completion is recorded either way.

---

## 3. Assets that have no URL

Fonts, background images, logos, a clip you just generated — anything you hold
as bytes rather than as a link. Two routes, and the size decides which:

**Small and inline.** Put it in `project.files` as `{"base64": "…"}`. No extra
call, no bucket to clean up. The 24 MB ceiling is on the whole decoded project,
and a JSON body is parsed in one piece, so keep this for fonts, icons and
ordinary images.

**Large and streamed.** An upload bucket. Create it, PUT files into it, then
name it in a submit. Nothing is buffered in memory, so a 4K master is fine.

```http
POST /uploads
{ "name": "cafe-video assets" }

→ 201 { "upload_id": "up_x9Qf2K7mB3nVtLpZ", "expires_in_hours": 24 }
```

```http
PUT /uploads/up_x9Qf2K7mB3nVtLpZ/fonts/Heading.woff2
Content-Type: application/octet-stream
<raw bytes>

→ 201 { "path": "fonts/Heading.woff2", "bytes": 84120, "sha256": "…" }
```

The path after the upload id is where the file lands **inside the project**, so
`media/broll.mp4` and `fonts/Heading.woff2` end up exactly where the composition
expects them. Then submit with `"project": { "upload_id": "up_…", "files": {…} }`.

| | |
|---|---|
| `GET /uploads` | Everything currently held. |
| `GET /uploads/{id}` | One bucket: files, sizes, SHA-256 of each. |
| `DELETE /uploads/{id}` | Removes it and reports the bytes freed. |
| Per file | 8 GB |
| Kept for | 24 hours, then swept |

⚠️ **`Content-Type: application/octet-stream`.** A JSON body is parsed rather
than stored, and a PUT that sends one is refused with `415` rather than writing
an empty file.

A bucket **survives the submit** and can feed several renders — that is the
point: revising a caption should not mean re-uploading a font. Delete it when
the video is finished, or leave it and it expires.

### Preparing footage the server fetched

`sources[].prepare` runs one ffmpeg pass before the render starts. The case it
exists for: a 1080p clip going into a 4K composition. Without it the browser
upscales every frame itself with default filtering — softer, and paid for on all
900 frames instead of once.

```json
{ "name": "cafe.mp4",
  "url": "https://…/wan-generated-1080p.mp4",
  "prepare": { "scale": "3840x2160" } }
```

| field | |
|---|---|
| `scale` | Exact output size, `"WIDTHxHEIGHT"`. Upscales with lanczos. |
| `fps` | Resample to this frame rate. |
| `trim_start` | Seconds into the source to begin. |
| `trim_duration` | Seconds to keep. |

The untouched download is kept beside the result, so changing `prepare` on a
revision re-derives from the original rather than re-processing its own output.
An unchanged `prepare` on a retry is free. Progress appears as
`Preparing cafe.mp4 → 3840x2160 45%` in `step`.

Measured on this box: **3 seconds of 1080p → true 3840×2160 in 11 seconds**, so
budget roughly 4× the clip length for a 4K upscale, before the render itself.

⚠️ `prepare` applies to `sources[]` — footage the **server** fetches from a URL.
It does not run on files you upload. Upload those already prepared.

### Filenames the server accepts

Every path segment must match `[A-Za-z0-9][A-Za-z0-9._ -]*`: start with a letter
or digit, then letters, digits, dot, underscore, space or hyphen. This applies
to `project.files` keys **and** to upload paths, and subdirectories of any depth
are fine.

| | |
|---|---|
| `fonts/Inter_Bold.woff2` | ✅ |
| `media/b-roll 01.mp4` | ✅ spaces are allowed |
| `a/b/c/deep.png` | ✅ any depth |
| `_variables.css` | ❌ starts with an underscore |
| `images/.hidden.png` | ❌ starts with a dot |
| `images/logo(1).png` | ❌ parentheses |
| `images/logo@2x.png` | ❌ `@` |
| `images/logo+alt.png` | ❌ `+` |
| `images/Ünter.png` | ❌ non-ASCII |
| `../../etc/passwd` | ❌ refused, raw or percent-encoded |

Rejections are `400 invalid_request` and the message names the offending file.
Rename it rather than retrying — this list will not change under you.

### Sending base64 correctly

- Send the **bare payload**. A `data:font/woff2;base64,…` prefix is **rejected** —
  strip everything up to and including the comma.
- Line breaks inside the payload are fine; standard 76-character wrapping works.
- It is validated **before** it is decoded. Bad padding or a stray character is a
  `400`, never a quietly truncated file — a short font would otherwise render as
  a fallback typeface and look like a styling bug rather than a transport bug.
- `{"text": "…"}` is the explicit form for text; a bare string means the same.
- Wrong shapes get a plain message: `project.files["x"] must be a string,
  {text} or {base64}.`

### A complete worked example

This exact project rendered on this server: a bucket for the font, base64 for
the image, everything else inline.

```bash
# 1 — a bucket
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"name":"styled render assets"}' $BASE/uploads
# → { "upload_id": "up_FIWRzG1zAiK1Z7pvrFAr", ... }

# 2 — the font, raw bytes, streamed
curl -X PUT --data-binary @Roboto.ttf \
     -H "Authorization: Bearer $KEY" -H 'Content-Type: application/octet-stream' \
     $BASE/uploads/up_FIWRzG1zAiK1Z7pvrFAr/fonts/Roboto.ttf
# → { "path": "fonts/Roboto.ttf", "bytes": 488584, "sha256": "d7598e12…" }

# 3 — submit, referencing the bucket
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     --data-binary @submit.json $BASE/jobs
```

`submit.json`:

```json
{
  "name": "asset path proof",
  "client_ref": "assets-001",
  "project": {
    "upload_id": "up_FIWRzG1zAiK1Z7pvrFAr",
    "files": {
      "index.html": "…see below…",
      "gsap.min.js": "…the library, as text…",
      "images/backdrop.png": { "base64": "iVBORw0KGgoAAAANSUhEUg…" }
    }
  },
  "render": { "fps": 30, "quality": "high", "output_name": "assets.mp4" }
}
```

`index.html` — note that the font is used through an ordinary `@font-face` with
a **relative** path, and the image through a relative `src`:

```html
<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'RobotoTest'; src: url('fonts/Roboto.ttf') format('truetype'); }
  body{margin:0;width:640px;height:360px;overflow:hidden;background:#111}
  #root{width:640px;height:360px;position:relative;overflow:hidden}
  #bg{position:absolute;inset:0;width:640px;height:360px;object-fit:cover;opacity:.55}
  #title{position:absolute;left:40px;top:150px;font-family:'RobotoTest',serif;
         font-size:44px;color:#fff;opacity:0}
</style></head>
<body data-composition-id="root" data-width="640" data-height="360" data-duration="1">
  <div id="root">
    <img id="bg" src="images/backdrop.png">
    <div id="title">Asset path works</div>
  </div>
  <script src="./gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#title', { y: -30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6 }, 0.1);
    window.__timelines = { root: tl };
  </script>
</body></html>
```

The renderer confirms a local font in the log, which is how you tell a real font
from a silent fallback:

```
[Compiler] Embedded local font file: fonts/Roboto.ttf (477 KB → data URI)
```

---

## 4. Long renders: chunking and resume

**The renderer cannot resume.** Hyperframes 0.8.30 has no `--resume`, no
`--start-frame` and no frame-range flag, and a failed render deletes its work
directory. A 30-second 4K job that died at frame 675 of 886 threw away 26
minutes and started again at zero — that is why this exists.

**You do not have to do anything.** The server cuts the timeline into short
independent renders, re-times your composition for each one, renders only what
is missing on a retry, and joins the pieces without re-encoding. Compositions
need no chunk awareness; the ones already written work unchanged.

### What you get

| | |
|---|---|
| Chunk size | **150 frames** (5s at 30fps), at every timeline length |
| A crash costs | that one chunk — 5 seconds of work, not the whole render |
| Partial output | the finished chunks, joined, downloadable while the rest is still missing |
| Retries | only missing chunks re-render; an attempt that progressed does not count against the 3-attempt limit |
| Verification | a chunk is accepted only if its frame count is exactly right |

150 frames is deliberate at every length, and the reason is disk as much as
resume. The extracted-frame cache runs about 940 KB per 4K frame, so a
20-minute film is roughly 33 GB of cache — more than this box has free. Because
each chunk extracts a **disjoint** window of source frames, nothing is shared
between chunks, so the cache is kept per chunk and dropped once that chunk
verifies: about 140 MB at a time instead of 33 GB. The cost is ~8s of browser
start per chunk, which on a 20-hour 4K render is under 3%.

| timeline | chunks |
|---|---|
| 30 s | 6 |
| 2 min | 24 |
| 20 min | 240 |
| 60 min | 720 |

`render.chunk_frames` or `render.chunk_seconds` override it if you need to.

### How the re-timing works

For a chunk covering absolute 5s-10s, the server rewrites the composition:

- the root's `data-duration` becomes the chunk length;
- every `<video>`/`<audio>` is re-timed — a clip already playing when the chunk
  begins gets `data-start="0"` with its `data-media-start` advanced by however
  much was skipped, and every clip is clamped to the chunk;
- a small script offsets the registered GSAP timeline so local time 0 is
  absolute 5s.

A clip at `data-start="3.155"` with `data-media-start="0"` therefore becomes
`data-start="0"` with `data-media-start="1.845"` — 1.845 seconds into itself
when the chunk opens.

⚠️ **If the offset cannot be applied, the chunk fails loudly.** A composition
that registers `window.__timelines[id]` asynchronously (after a `fetch`, say)
is not patchable at injection time, and a chunk whose timeline was not shifted
would render plausible, wrong footage — the one outcome worse than a failure.
Register your timeline synchronously.

`data-hf-chunkable="false"` on the root turns chunking off for a composition;
`data-hf-chunkable="true"` means *you* handle the offset from
`hfChunkStart` / `hfChunkDuration` / `hfChunkIndex` / `hfChunkCount`
(delivered through `window.__hyperframes.getVariables()`), and the server will
only set the root duration.

### Getting a partial video

When a chunked render stops early, the finished chunks are joined into a
partial file and reported on the job:

```json
"partial": { "url": "/api/hyperframes/v1/jobs/{id}/partial", "seconds": 45.0, "chunks": 9 }
```

`GET /jobs/{id}/partial` downloads it, and the Render queue page shows a
**Partial MP4** button. Only a *leading* run of chunks is joined: 0,1,2 makes
watchable film, whereas 0,1,4 would make a video that silently jumps.

⚠️ Chunking makes a long render **survivable, not fast**. A 4K frame costs
roughly 2 seconds here, so 20 minutes of 4K is around 20 hours.

---

## 5. Progress

```http
GET /jobs/{job_id}
```

```json
{
  "job_id": "blotato-walkthrough-09081912",
  "client_ref": "video-0042",
  "status": "rendering",
  "step": "Streaming frames",
  "progress_percent": 62,
  "frames_completed": 558,
  "total_frames": 900,
  "estimated_minutes_remaining": 18,
  "attempt": 1,
  "elapsed_seconds": 1284,
  "updated_at": "2026-09-08T19:31:04Z",
  "message": ""
}
```

`status` is one of:

| status | meaning |
|---|---|
| `queued` | Accepted, not started. |
| `fetching` | Downloading sources. `step` names the file and percentage. |
| `rendering` | Frames are being produced. |
| `done` | Finished. Call `/result`. |
| `failed` | Gave up after 3 attempts. `message` says why; the log has detail. |
| `cancelled` | Stopped on request. |

**Two honest notes about these numbers.**

`estimated_minutes_remaining` is null until at least 10 frames have rendered —
an estimate from three frames is noise, and a figure that swings from 4 to 40
is worse than none.

`updated_at` advances at least every 30 seconds while a job is alive, even when
the renderer is silent. **If it stops advancing, the render is stuck** — that is
the whole point of it being there. Poll no faster than every 15 seconds; nothing
changes more often than that, and there is no AI cost to a poll either way.

---

## 6. Result

```http
GET /jobs/{job_id}/result
```

```json
{
  "job_id": "blotato-walkthrough-09081912",
  "client_ref": "video-0042",
  "status": "done",
  "video":   { "url": ".../files/blotato-walkthrough-09081912/output/render.mp4",
               "bytes": 48213551 },
  "project": { "url": ".../project/blotato-walkthrough-09081912.tar.gz" },
  "log":     { "url": ".../files/blotato-walkthrough-09081912/render.log" },
  "render":  { "seconds": 1841, "attempts": 1, "frames": 900,
               "width": 3840, "height": 2160, "fps": 30 },
  "runtime": { "hyperframes": "0.8.30", "browser": "152.0.7977.30" }
}
```

Downloads carry the same bearer token and support range requests, so a large
result resumes if interrupted. `404` until the job reaches `done`.

---

## 7. Cancel and delete

```http
POST   /jobs/{job_id}/cancel
DELETE /jobs/{job_id}[?keep_output=true]
```

Cancel stops a running render within a few seconds. Delete removes the job
directory entirely — project, footage, frame cache, output and log. There is no
second copy anywhere: no bucket, no CDN, nothing in a database to contradict it.
`keep_output=true` drops the footage and cache but keeps the finished MP4, which
is the usual way to reclaim 3 GB while keeping the 50 MB you wanted.

Deleting a running job cancels it and returns `409`; repeat the delete once it
has stopped.

---

## What a project must contain

The renderer scrubs a **paused GSAP timeline**; it does not play the page. A
composition that animates with CSS keyframes or `requestAnimationFrame` renders
as a still frame, because nothing advances when time is set by hand.

`index.html`, at the project root:

```html
<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:3840px;height:2160px;overflow:hidden}
  #root{width:3840px;height:2160px;position:relative;overflow:hidden}
</style></head>

<body data-composition-id="root" data-width="3840" data-height="2160" data-duration="12">
  <div id="root">
    <video id="presenter" src="media/main.mp4" data-start="0" data-duration="12"
           muted playsinline></video>
    <audio id="narration" src="media/main.mp4" data-start="0" data-duration="12"
           data-volume="1"></audio>
    <div id="title">…</div>
  </div>

  <script src="./gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });          // paused is required
    tl.fromTo('#title', { y: -50, opacity: 0 },
                        { y: 0, opacity: 1, duration: 0.4 }, 0.1);
    // Registered synchronously — see the warning under "What a project must contain".
    window.__timelines = { root: tl };                    // keyed by composition id
  </script>
</body></html>
```

| requirement | |
|---|---|
| `data-composition-id` | Must match the key in `window.__timelines`. |
| `data-width` / `data-height` | Output pixels. |
| `data-duration` | Seconds. Frames rendered = duration × fps. |
| `window.__timelines` | `{ "<composition-id>": <paused gsap timeline> }`. ⚠️ Register it **synchronously**. A composition that assigns it after a `fetch` cannot be re-timed for chunking, and the chunk fails rather than rendering wrong footage. |
| Audio | `<audio src="…" data-start="0" data-duration="3" data-volume="1">`. |
| Footage | `<video id="clip" src="media/main.mp4" data-start="0" data-duration="12" muted playsinline>` — see below. |
| Fonts | `@font-face { src: url('fonts/X.ttf') }` — a relative path to a file you sent. The compiler inlines it and logs `Embedded local font file`. |
| Images | `<img src="images/X.png">` or `url(images/X.png)` — same relative paths. |

**Media elements have hard requirements, and `--strict` rejects the alternatives:**

| | |
|---|---|
| `src="media/x.mp4"` | A real `src` (or a `<source>` child). **`data-src` does not work** — the renderer reports `media_missing_src` and the clip never loads. |
| `id="..."` | Required. Without it: `media_missing_id`, and the video renders **frozen**. |
| `muted` on `<video>` | Required, or `data-has-audio="true"`. Otherwise `video_missing_muted`. Put sound in a separate `<audio>`. |
| `data-start` | When the clip appears on the composition timeline, in seconds. |
| `data-duration` | How long it runs. |
| `data-media-start` | Where to begin **inside the source file**. Source time is `data-media-start + (t − data-start)`. |

```html
<video id="presenter" src="media/main.mp4" data-start="0" data-duration="29.5"
       muted playsinline></video>
<audio id="narration" src="media/main.mp4" data-start="0" data-duration="29.5"
       data-volume="1"></audio>
```

`gsap.min.js` is plain text, so it can travel inside `project.files` with the
composition. Fonts, images and audio are binary: send them as `{"base64": …}`
inside `project.files`, or in an upload bucket (section 3). Reference them by
the same relative path you gave them — `fonts/Heading.woff2` in the project is
`url(fonts/Heading.woff2)` in the CSS.

---

## Errors

```json
{ "error": "not_enough_disk",
  "message": "Needs 3046 MB, 1204 MB free.",
  "job_id": "blotato-walkthrough-09081912" }
```

| code | HTTP | |
|---|---|---|
| `unauthorized` | 401 | Missing or wrong bearer token. |
| `invalid_request` | 400 | Malformed body; `message` names the field. |
| `not_found` | 404 | No such job. |
| `conflict` | 409 | Delete attempted on a running job. |
| `unsupported_media_type` | 415 | A file upload sent as JSON instead of `application/octet-stream`. |
| `not_enough_disk` | 507 | Refused rather than filling the disk. |
| `insufficient_storage` | 507 | An upload would leave under 5 GB free, or exceeds the 8 GB per-file limit. |
| `source_unreachable` | 502 | A `sources` URL did not return a file. Expired Descript share links land here. |

---

## What the server will not do

- **Store a second copy of anything.** Deleted means deleted.
- **Resume a part-finished *chunk*.** Hyperframes 0.8.30 has no resume, no
  checkpoint restart and no frame-range flag, so the chunk that was in flight
  when a render died restarts from its own frame 0 — at most 150 frames of lost
  work. Every chunk already finished is kept and skipped. This is automatic;
  there is nothing to opt into (section 4).
- **Run two renders at once.** One at a time, by design.
- **Prepare a file you uploaded.** `prepare` is for footage the server fetches
  from a URL. Upload yours already at the size you need.
- **Delete one file from a bucket.** Buckets are all-or-nothing: `DELETE
  /uploads/{id}`. Re-PUT the same path to replace a file in place.
- **Push you a notification.** Poll `/jobs/{id}`. The dashboard does the same
  and costs nothing.
- **Install, upgrade or reseal the runtime.** It is pinned and verified. If it
  stops verifying, jobs fail loudly rather than being repaired in the dark.

---

## Practical limits on this box

| | |
|---|---|
| Hardware | 4 vCPU, 8 GB RAM, shared with Postiz, the Lab, Temporal, Elasticsearch, 2× Postgres |
| Render container | 2 CPUs, 4 GB, 1 GB `/dev/shm` |
| Measured | 3s of 4K in ~50s; source download 14 MB/s; 1080p→4K upscale ~4× clip length |
| Free disk | ~44 GB, and a 3 GB project plus output is a real dent |
| Concurrency | 1 |
| Inline project | 24 MB total, decoded |
| Uploaded file | 8 GB each; refused if it would leave under 5 GB free |
| Buckets | Kept 24 hours, then swept |

A ten-minute 4K render is hours, not minutes, on this hardware. That is a sizing
conversation, not a bug — the queue will finish it, but plan around it.
