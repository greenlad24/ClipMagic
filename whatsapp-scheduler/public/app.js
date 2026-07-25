'use strict';

/*
 * WhatsApp Cloud Scheduler — status / QR / read-only list page.
 * The product itself is the in-chat `/schedule` command; this page only:
 *   (a) shows the QR to link a personal device (polls /api/status every 3s),
 *   (b) confirms "Connected as <me>" + shows the command how-to, and
 *   (c) lists pending scheduled messages with a Cancel action.
 * Talks to /api/status, /api/messages, POST /api/messages/:id/cancel,
 * DELETE /api/messages/:id.
 */

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'wa_token';

const API = {
  token: localStorage.getItem(TOKEN_KEY) || '',

  setToken(t) {
    this.token = t || '';
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  },

  async call(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    if (opts.body != null) headers['Content-Type'] = 'application/json';
    // Strip any leading slash so requests resolve against the <base href="/wa/">
    // this app is proxied under (an absolute "/api/…" would bypass the base and
    // hit The Lab, not the scheduler).
    const url = String(path).replace(/^\/+/, '');
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      API.setToken('');
      showScreen('screen-token');
      throw new Error('Unauthorized');
    }
    let data = {};
    try {
      data = await res.json();
    } catch (_e) {
      data = {};
    }
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  },
};

// ---------------------------------------------------------------------------
// Screen switching
// ---------------------------------------------------------------------------
const SCREENS = ['screen-loading', 'screen-token', 'screen-qr', 'screen-app'];

function showScreen(id) {
  for (const s of SCREENS) {
    const el = document.getElementById(s);
    if (el) el.hidden = s !== id;
  }
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------
let statusTimer = null;
let listTimer = null;
let appInitialized = false;

function stopStatusPoll() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

function startStatusPoll() {
  if (statusTimer) return; // idempotent
  statusTimer = setInterval(startStatusFlow, 3000);
}

function startListPoll() {
  if (listTimer) return;
  listTimer = setInterval(loadMessages, 5000);
}

// ---------------------------------------------------------------------------
// Status flow — the top-level router
// ---------------------------------------------------------------------------
async function startStatusFlow() {
  let status;
  try {
    status = await API.call('/api/status');
  } catch (_e) {
    return; // 401 already routed to token screen
  }

  updateProviderBadge(status);

  if (status.authRequired && !API.token) {
    stopStatusPoll();
    showScreen('screen-token');
    return;
  }

  if (status.provider === 'personal' && !status.connected) {
    showQr(status);
    showScreen('screen-qr');
    startStatusPoll();
    return;
  }

  // Connected (or a business provider that is ready).
  stopStatusPoll();
  showScreen('screen-app');
  setConnectedTitle(status);
  await initApp();
}

function updateProviderBadge(status) {
  const badge = document.getElementById('provider-badge');
  if (!badge || !status.provider) return;
  badge.hidden = false;
  badge.textContent = status.provider;
  badge.classList.toggle('connected', !!status.connected);
}

function setConnectedTitle(status) {
  const title = document.getElementById('connected-title');
  if (!title) return;
  title.textContent = status.me
    ? '✅ Connected as ' + status.me
    : '✅ Connected';
}

function showQr(status) {
  const img = document.getElementById('qr-img');
  const waiting = document.getElementById('qr-waiting');
  if (status.qr) {
    img.src = status.qr;
    img.hidden = false;
    if (waiting) waiting.hidden = true;
  } else {
    img.hidden = true;
    if (waiting) waiting.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Token form
// ---------------------------------------------------------------------------
document.getElementById('token-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('token-input');
  const err = document.getElementById('token-error');
  const val = input.value.trim();
  if (!val) return;
  err.hidden = true;
  API.setToken(val);
  showScreen('screen-loading');
  startStatusFlow();
});

// ---------------------------------------------------------------------------
// App init (read-only list). Runs once.
// ---------------------------------------------------------------------------
async function initApp() {
  if (appInitialized) return;
  appInitialized = true;
  await loadMessages();
  startListPoll();
}

// ---------------------------------------------------------------------------
// Messages list (read-only + Cancel)
// ---------------------------------------------------------------------------
async function loadMessages() {
  let data;
  try {
    data = await API.call('/api/messages');
  } catch (_e) {
    return;
  }
  const messages = (data.messages || [])
    .slice()
    .sort((a, b) => b.when - a.when);
  renderMessages(messages);
}

function renderMessages(messages) {
  const list = document.getElementById('messages');
  const empty = document.getElementById('empty-state');
  const count = document.getElementById('list-count');

  const pendingCount = messages.filter((m) => m.status === 'pending').length;
  count.textContent = pendingCount
    ? pendingCount + ' pending · ' + messages.length + ' total'
    : messages.length
      ? messages.length + ' total'
      : '';
  empty.hidden = messages.length > 0;

  list.innerHTML = '';
  for (const m of messages) {
    list.appendChild(renderItem(m));
  }
}

function renderItem(m) {
  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = m.id;

  const head = document.createElement('div');
  head.className = 'message-head';

  const to = document.createElement('span');
  to.className = 'message-to';
  to.textContent = m.toDisplay || m.to;

  const badge = document.createElement('span');
  badge.className = 'badge badge-' + m.status;
  badge.textContent = m.status;

  head.appendChild(to);
  head.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'message-text';
  body.textContent = m.text;

  const when = document.createElement('div');
  when.className = 'message-when muted small';
  when.textContent =
    formatWhen(m.when) + (m.source === 'chat' ? ' · via chat' : '');
  if (m.status === 'failed' && m.error) {
    when.textContent += ' · ' + m.error;
  }

  li.appendChild(head);
  li.appendChild(body);
  li.appendChild(when);

  if (m.status === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.appendChild(
      actionBtn('Cancel', 'btn-ghost btn-danger', () => cancelMsg(m.id)),
    );
    li.appendChild(actions);
  }

  return li;
}

function actionBtn(label, cls, handler) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-small ' + cls;
  b.textContent = label;
  b.addEventListener('click', handler);
  return b;
}

async function cancelMsg(id) {
  try {
    await API.call('/api/messages/' + encodeURIComponent(id) + '/cancel', {
      method: 'POST',
    });
    toast('Canceled');
    await loadMessages();
  } catch (err) {
    toast(err.message || 'Failed');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatWhen(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch (_e) {
    return String(ms);
  }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    el.hidden = true;
  }, 2500);
}

// ---------------------------------------------------------------------------
// Service worker + boot
// ---------------------------------------------------------------------------
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* SW registration is best-effort */
      });
    });
  }
}

// Service worker registration is intentionally DISABLED here: this build is
// served under /wa/ behind The Lab's auth-gating reverse proxy, and a SW that
// precaches root-absolute asset paths would both miss (wrong scope) and risk
// serving stale, unauthenticated shells. The status page needs no offline cache.
void registerServiceWorker; // keep the fn defined but don't register.
startStatusFlow();
