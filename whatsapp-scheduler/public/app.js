'use strict';

/*
 * WhatsApp Cloud Scheduler — link, compose, and review scheduled messages.
 *   (a) shows the QR to link a personal device (polls /api/status every 3s),
 *   (b) composes a scheduled message: pick an existing chat, say when in plain
 *       language ("Monday morning"), write the text, and
 *   (c) lists pending messages with a Cancel action.
 * Recipients are opaque refs throughout — the browser is never handed a chat
 * id or phone number, and the server persists neither.
 * Talks to /api/status, /api/chats, /api/parse-when, /api/messages,
 * POST /api/messages/:id/cancel, DELETE /api/messages/:id.
 */

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'wa_token';

// Set by index.html when this page is served behind The Lab's /wa proxy, which
// gates on Google Sign-In and injects the sidecar's Bearer token server-side.
// In that mode the browser holds no token and the token prompt is a dead end.
const PROXIED = window.WA_PROXIED === true;

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
      let body = {};
      try {
        body = await res.json();
      } catch (_e) {
        body = {};
      }
      // The proxy could not tell the scheduler who we are — a signed-out or
      // expired session. Retrying cannot fix that, so say so instead of
      // spinning on "Connecting…".
      if (body.signInRequired) {
        stopStatusPoll();
        showSignInRequired(body.error);
        throw new Error('Sign-in required');
      }
      // Proxied: the injected token is the server's to fix, not the visitor's.
      if (!PROXIED) {
        API.setToken('');
        showScreen('screen-token');
      }
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

/** Terminal state: we are not signed in, and only a fresh sign-in fixes it. */
function showSignInRequired(message) {
  const card = document.querySelector('#screen-loading .card');
  if (card) {
    card.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = message || 'Sign in to The Lab to use the WhatsApp Scheduler.';
    card.appendChild(p);
    const a = document.createElement('a');
    a.className = 'btn btn-primary';
    a.href = '/';
    a.textContent = 'Go to The Lab';
    card.appendChild(a);
  }
  showScreen('screen-loading');
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
    // Proxied: a failure here is a server/config problem the visitor cannot fix
    // by typing a token, so keep retrying rather than dead-ending on "Connecting…".
    if (PROXIED) startStatusPoll();
    return; // otherwise the 401 already routed to the token screen
  }

  updateProviderBadge(status);
  updateAccountBadge(status);

  if (status.authRequired && !API.token && !PROXIED) {
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

/**
 * Show which lab account this page is acting as. Sessions are per signed-in
 * email, so this is the difference between "my WhatsApp" and someone else's.
 */
function updateAccountBadge(status) {
  const badge = document.getElementById('account-badge');
  if (badge) {
    badge.hidden = !status.user;
    badge.textContent = status.user || '';
  }
  const qrAccount = document.getElementById('qr-account');
  if (qrAccount) {
    qrAccount.hidden = !status.user;
    qrAccount.textContent = status.user
      ? 'Linking a device for ' + status.user
      : '';
  }
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
  initComposer();
}

// ---------------------------------------------------------------------------
// Composer — schedule from the web UI.
// ---------------------------------------------------------------------------

/** datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time, not an ISO string. */
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  );
}

async function initComposer() {
  const form = document.getElementById('compose-form');
  if (!form || form.dataset.ready) return;
  form.dataset.ready = '1';

  // The exact-time picker is revealed only by the "Custom" option.
  const exact = document.getElementById('compose-when');
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  soon.setSeconds(0, 0);
  exact.value = toLocalInputValue(soon);
  exact.min = toLocalInputValue(new Date());
  exact.addEventListener('change', () => previewWhen());

  await loadChats();

  const filter = document.getElementById('compose-filter');
  if (filter) filter.addEventListener('input', () => renderChatOptions(filter.value));

  const whenSel = document.getElementById('compose-when-select');
  whenSel.addEventListener('change', () => {
    exact.hidden = whenSel.value !== CUSTOM_WHEN;
    previewWhen();
  });

  form.addEventListener('submit', submitCompose);
  previewWhen();
}

// --- "when" resolution ------------------------------------------------------

const CUSTOM_WHEN = '__custom__';
let whenPreviewTimer = null;
// Last resolved selection, so submit never re-parses a stale phrase.
let resolvedWhen = { key: '', ms: null };

/** The exact-time input, in epoch ms, or null when unusable. */
function exactWhenMs() {
  const el = document.getElementById('compose-when');
  if (!el || !el.value) return null;
  const ms = new Date(el.value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function previewWhen() {
  if (whenPreviewTimer) clearTimeout(whenPreviewTimer);
  whenPreviewTimer = setTimeout(resolveWhen, 120);
}

async function resolveWhen() {
  const out = document.getElementById('compose-when-preview');
  const sel = document.getElementById('compose-when-select');
  if (!out || !sel) return;
  const choice = sel.value;

  if (choice === CUSTOM_WHEN) {
    const ms = exactWhenMs();
    resolvedWhen = { key: CUSTOM_WHEN, ms };
    if (!ms) {
      out.textContent = 'Choose a date and time.';
    } else if (ms <= Date.now()) {
      resolvedWhen.ms = null;
      out.textContent = 'That time has already passed.';
    } else {
      out.innerHTML =
        '→ <span class="when-ok">' +
        escapeHtml(new Date(ms).toLocaleString()) +
        '</span>';
    }
    return;
  }

  resolvedWhen = { key: choice, ms: null };
  let data;
  try {
    data = await API.call('/api/parse-when?q=' + encodeURIComponent(choice));
  } catch (_e) {
    out.textContent = '';
    return;
  }
  // A later change may have superseded this response.
  if (document.getElementById('compose-when-select').value !== choice) return;
  if (data.ok) {
    resolvedWhen = { key: choice, ms: data.when };
    out.innerHTML = '→ <span class="when-ok">' + escapeHtml(data.pretty) + '</span>';
  } else {
    out.textContent = data.error || 'Not a time we understand.';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Every chat we know about, kept client-side so filtering needs no round-trip.
let allChats = [];

async function loadChats() {
  const sel = document.getElementById('compose-to');
  if (!sel) return;
  let data;
  try {
    data = await API.call('/api/chats');
  } catch (_e) {
    sel.innerHTML = '<option value="">Could not load chats</option>';
    return;
  }
  allChats = data.chats || [];
  renderChatOptions('');
}

function renderChatOptions(filter) {
  const sel = document.getElementById('compose-to');
  if (!sel) return;
  const q = String(filter || '').trim().toLowerCase();
  const matches = q
    ? allChats.filter((c) => (c.name || '').toLowerCase().includes(q))
    : allChats;

  const previous = sel.value;
  sel.innerHTML = '';

  if (!allChats.length) {
    sel.innerHTML = '<option value="">No chats available</option>';
    return;
  }

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = matches.length
    ? '— pick a chat (' + matches.length + ') —'
    : '— no chat matches that —';
  sel.appendChild(blank);

  // Cap the rendered list: there can be hundreds of chats, and the filter box
  // is the way to reach the rest.
  for (const c of matches.slice(0, 200)) {
    const opt = document.createElement('option');
    // An opaque ref — the browser is never given a chat id or phone number.
    opt.value = c.ref;
    opt.textContent = (c.isGroup ? '👥 ' : '') + c.name;
    sel.appendChild(opt);
  }
  if (matches.length > 200) {
    const more = document.createElement('option');
    more.value = '';
    more.disabled = true;
    more.textContent = '…' + (matches.length - 200) + ' more — keep typing to narrow';
    sel.appendChild(more);
  }
  // Keep the current pick if it survived the filter.
  if (previous && matches.some((c) => c.ref === previous)) sel.value = previous;
}

async function submitCompose(e) {
  e.preventDefault();
  const sel = document.getElementById('compose-to');
  const textEl = document.getElementById('compose-text');
  const errEl = document.getElementById('compose-error');
  const btn = document.getElementById('compose-submit');

  const showError = (m) => {
    errEl.textContent = m;
    errEl.hidden = false;
  };
  errEl.hidden = true;

  // Recipients are restricted to existing conversations by design: no free-text
  // number field exists, so no arbitrary phone number is ever sent or stored.
  const to = sel ? sel.value : '';
  if (!to) return showError('Pick a chat to send to.');

  const text = (textEl.value || '').trim();
  if (!text) return showError('Message is empty.');

  const sel2 = document.getElementById('compose-when-select');
  if (resolvedWhen.key !== sel2.value || !resolvedWhen.ms) await resolveWhen();
  const when = resolvedWhen.ms;
  if (!when) return showError('Choose when to send it.');

  if (!Number.isFinite(when)) return showError('That send time is not valid.');
  if (when <= Date.now()) return showError('That time is in the past.');

  btn.disabled = true;
  try {
    await API.call('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ to, text, when }),
    });
    textEl.value = '';
    toast('Scheduled ✅');
    await loadMessages();
  } catch (err) {
    showError(String((err && err.message) || err));
  } finally {
    btn.disabled = false;
  }
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

  const actions = document.createElement('div');
  actions.className = 'message-actions';

  if (m.status === 'pending') {
    actions.appendChild(
      actionBtn('Cancel', 'btn-ghost btn-danger', () => cancelMsg(m.id)),
    );
  } else if (m.status === 'failed' || m.status === 'canceled') {
    // Deliberately NOT a one-click resend. This loads the message back into the
    // composer so the send time is chosen again and confirmed — a failed
    // message is usually hours or days old by the time anyone looks at it, and
    // firing its original text off immediately is rarely what was wanted.
    const btn = actionBtn('Reschedule', 'btn-ghost', () => reschedule(m));
    if (!m.toRef) {
      // The chat no longer resolves on this device, so there is nothing for the
      // picker to select. Say why rather than offering a button that fails.
      btn.disabled = true;
      btn.title = 'That conversation is not available on this device any more';
    }
    actions.appendChild(btn);
  }

  if (actions.childNodes.length) li.appendChild(actions);

  return li;
}

/**
 * Load a past message into the composer: same recipient, same text, new time.
 *
 * The picker only renders the first 200 matches, so the chat has to be brought
 * into view via the filter before its option exists to be selected.
 */
function reschedule(m) {
  const filter = document.getElementById('compose-filter');
  const sel = document.getElementById('compose-to');
  const textEl = document.getElementById('compose-text');
  if (!sel || !textEl) return;

  if (filter && m.toDisplay) {
    filter.value = m.toDisplay;
    renderChatOptions(m.toDisplay);
  }
  sel.value = m.toRef || '';
  if (!sel.value) {
    toast('That conversation is not available any more');
    return;
  }
  textEl.value = m.text || '';

  const card = document.getElementById('compose-card') || sel.closest('.card');
  if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Land on the time, since that is the one thing that must change.
  const when = document.getElementById('compose-when-select');
  if (when && when.focus) when.focus();
  toast('Loaded — pick a new time');
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
