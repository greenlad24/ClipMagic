# WhatsApp Cloud Scheduler

A **self-hosted** service for scheduling WhatsApp messages. You schedule messages
the natural way — by typing a `/schedule` command **inside a real WhatsApp chat**
— and the server delivers them later, even while your phone is asleep. Everything
runs on **your** machine or server; your data never leaves it.

## How you use it

**Type a command in any WhatsApp chat** (iPhone, Android, or desktop):

```
/s tomorrow 18:00: don't forget the milk
```

The linked server sees the command, schedules the message, and replies with a
confirmation. That's the whole product. There is no separate app to open and no
form to fill in — you schedule from wherever you already are: the chat itself.

A small **self-hosted status page** also runs (see below), but only to link the
device via QR on first run and to view/cancel what's already scheduled. You do
**not** compose messages there.

---

## Providers: `personal` vs `business`

The service can send through one of two back-ends, chosen with the `WA_PROVIDER`
environment variable.

| | `personal` | `business` |
|---|---|---|
| Library / API | `whatsapp-web.js` (WhatsApp Web) | Official WhatsApp **Business Cloud API** |
| How it links | Scan a **QR code** (Linked Devices) | API credentials (token) |
| Who you can message | **Anyone**, free-form text | Within Cloud API rules (templates / 24h window) |
| Cost | Free | Metered by Meta |
| In-chat `/schedule` commands | ✅ Supported | ⚠️ Needs a webhook receiver (inbound is a no-op) |
| Terms of Service | ⚠️ **Against WhatsApp's ToS** | ✅ Sanctioned by Meta |
| Best for | Personal use, testing, low volume | Production, businesses, compliance |

> ### ⚠️ Warning — automating a personal number can get it banned
> The `personal` provider drives WhatsApp Web with an unofficial library.
> **Automating a personal WhatsApp number violates WhatsApp's Terms of Service and
> can get the number permanently banned.** If you use `personal`:
> - Use a **dedicated or secondary number**, never your main one.
> - Keep the **volume low** and the messages human-like.
> - Understand you are accepting the risk. For anything serious, use `business`.
>
> The in-chat `/schedule` workflow relies on the `personal` provider (it reads
> your outgoing messages to spot commands). The `business` provider sends
> scheduled messages fine but cannot receive in-chat commands without a webhook.

---

## Local setup

Requirements: **Node.js >= 18**.

```bash
# 1. Get the configuration file
cp .env.example .env
#    ...then edit .env (at minimum pick WA_PROVIDER and set TZ)

# 2. Install dependencies
npm install

# 3. Start the server
npm start

# 4. Open the status page to link your device (see "Connecting" below)
#    http://localhost:3000
```

For development with auto-restart on file changes: `npm run dev`.

### Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `TZ` | — | Timezone for all scheduling, e.g. `Europe/London` |
| `DATA_DIR` | `./data` | Where messages + session are stored |
| `WA_PROVIDER` | `personal` | `personal` or `business` |
| `WA_CHROME_PATH` | — | Path to Chromium (optional; set in Docker) |
| `API_TOKEN` | — | Bearer token to protect the status page/API (set on public IPs) |
| `WA_PHONE_NUMBER_ID` | — | *business* — sender Phone Number ID |
| `WA_ACCESS_TOKEN` | — | *business* — access token |
| `WA_API_VERSION` | `v21.0` | *business* — Graph API version |

See `.env.example` for the full, commented list.

---

## Connecting your WhatsApp

### Personal provider (QR) — required for in-chat commands

1. Start the server and open the status page (`http://localhost:3000`).
2. It shows a **QR code** (the same code is also printed in the terminal).
3. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device**, then
   scan the QR.
4. Once linked, the status page shows you're connected and you can start sending
   `/schedule` commands from any chat. The session is saved under `DATA_DIR`, so
   you normally only scan once.

### Business provider (Cloud API)

Set these three variables in `.env` (from Meta / Facebook Developers) and restart:

```env
WA_PROVIDER=business
WA_PHONE_NUMBER_ID=your_phone_number_id
WA_ACCESS_TOKEN=your_access_token
WA_API_VERSION=v21.0
```

There is no QR to scan; the app reports connected once both the ID and token are
present. (In-chat commands need the personal provider / a webhook.)

---

## Scheduling with in-chat `/schedule` commands

This is how you schedule. In **any WhatsApp chat**, send a message that starts
with a trigger word. Triggers (case-insensitive) at the start of the message:
**`/schedule`**, **`/sched`**, or **`/s`**.

**Grammar:**

```
<trigger> <when...> [to <number>] : <message>
```

The **colon** separates the schedule spec from the message text.

- If you include **`to <number>`**, that number is the recipient.
- If you **omit `to`**, the message is scheduled for **the current chat** — i.e.
  whoever's conversation you typed the command in.

**Examples:**

```
/s monday 9am to +447911123456: Standup
/s tomorrow 18:00: don't forget the milk
/schedule 2026-07-28 09:00 to +44...: Payroll reminder
/sched in 2 hours to +447911123456: Call the plumber
```

The second example has no `to`, so it's typed **inside the recipient's chat** and
scheduled to that person — no number needed. The server replies in the chat with
a confirmation (`✅ Scheduled for …`) or a helpful error (`⚠️ …`).

**Supported `when` formats** (all in the server's `TZ`):

| Form | Examples |
|---|---|
| Relative | `in 30 mins`, `in 2 hours`, `in 3 days` |
| Tomorrow / today | `tomorrow 9am`, `today 21:00` |
| Weekday | `mon`, `monday 9:30am`, `fri 0900` (next future occurrence) |
| ISO-ish | `2026-07-28 09:00`, `2026-07-28T09:00` |

Times accept `9`, `9am`, `9:30am`, `21:00`, or `0900`. If you give only a day,
the time defaults to **09:00**.

### Weekend → Monday suggestion

When a `/schedule` command lands on a **Saturday or Sunday**, the bot notices and
**replies suggesting you send Monday at 09:00 instead**, so weekend reminders
don't get lost. You're free to keep the weekend time — the suggestion is just a
nudge in the reply.

> Note: in-chat commands are a `personal`-provider feature. The `business`
> provider would need an inbound **webhook** receiver to support them.

---

## The status page

A small self-hosted page runs at `http://localhost:3000`. It is **not** a compose
app — you never write messages there. It does two things:

1. **Link the device on first run** — shows the QR code to scan (personal
   provider).
2. **Show upcoming scheduled messages** — a read-only list of what's queued, with
   a status badge (`pending`, `sent`, `failed`, `canceled`) and the ability to
   **cancel** anything you no longer want sent.

---

## Deploying to your own server (Docker)

The repo ships a `Dockerfile` (Node 20 + Chromium) and a `docker-compose.yml`.

```bash
cp .env.example .env      # configure first
docker compose up -d      # build + run in the background
```

The compose service:
- builds the image from `.`,
- reads config from `.env`,
- maps port **3000:3000**,
- mounts **`./data`** so your messages and WhatsApp session survive restarts,
- restarts automatically (`unless-stopped`).

### Put it behind HTTPS

Expose the app through a **reverse proxy** (nginx, Caddy, Traefik) that terminates
**TLS/HTTPS** and forwards to the container's port. The QR-scan/linking flow works
best over HTTPS.

> ### 🔒 Set `API_TOKEN` whenever the port is public
> If the status page is reachable from the internet, **anyone who finds it could
> view your scheduled messages or cancel them**. Set a long random `API_TOKEN` in
> `.env`. The API then requires `Authorization: Bearer <token>` on every `/api/*`
> call, and the status page prompts you for the token on first load (it is stored
> in your browser).

---

## Data storage & keeping the server running

- Scheduled messages are stored as **JSON** (`messages.json`) under `DATA_DIR`
  (default `./data`). With Docker this is bind-mounted to `./data` on the host, so
  it **stays on your server** and survives restarts.
- The personal provider's WhatsApp session also lives under `DATA_DIR`
  (`wwebjs_auth`), so you don't re-scan every time.
- **The server must stay running to send.** A scheduler loop wakes periodically
  and delivers any messages whose time has arrived. If the process is stopped when
  a message is due, it will send as soon as the server is running again and the
  next tick reaches it — so keep the service up (that's what Docker's
  `restart: unless-stopped` is for).
