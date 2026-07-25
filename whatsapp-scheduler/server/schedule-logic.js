'use strict';

// server/schedule-logic.js — pure, dependency-free scheduling brain.
// CommonJS, Node >= 18, no external dependencies.

const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;
const FIVE_MIN = 5 * MS_MIN;

function toDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
  // Fallback: attempt construction; may yield Invalid Date, handled by callers.
  return new Date(now);
}

// Sat(6) or Sun(0)
function isWeekend(date) {
  const d = toDate(date);
  const day = d.getDay();
  return day === 0 || day === 6;
}

// The upcoming Monday at hour:minute strictly after `now`.
// If today is Monday and the time already passed -> next week.
// If today is Monday and the time is still ahead -> today.
function nextMonday(now, hour = 9, minute = 0) {
  const n = toDate(now);
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate(), hour, minute, 0, 0);
  const day = d.getDay();
  let add;
  if (day === 1) {
    add = d.getTime() > n.getTime() ? 0 : 7;
  } else {
    add = (1 - day + 7) % 7; // days until next Monday (>=1 for non-Monday)
  }
  d.setDate(d.getDate() + add);
  return d;
}

function roundUpTo5Min(date) {
  const ms = date.getTime();
  return new Date(Math.ceil(ms / FIVE_MIN) * FIVE_MIN);
}

// defaultSend = now + 1h rounded up to next 5 min.
// weekend -> suggested = nextMonday(now,9,0) with an explanatory reason.
function suggestSendTime(now) {
  const n = toDate(now);
  const defaultSend = roundUpTo5Min(new Date(n.getTime() + MS_HOUR));
  if (isWeekend(n)) {
    const suggested = nextMonday(n, 9, 0);
    return {
      isWeekend: true,
      suggested,
      defaultSend,
      reason:
        "It's the weekend — messages usually land better on a weekday, so this is scheduled for Monday at 9:00 AM.",
    };
  }
  return {
    isWeekend: false,
    suggested: defaultSend,
    defaultSend,
    reason: '',
  };
}

// Strip +, spaces, dashes, parens; keep digits; require 8-15 digits.
function normalizePhone(input) {
  if (input === null || input === undefined) {
    return { ok: false, error: 'Phone number is required' };
  }
  const digits = String(input).replace(/\D+/g, '');
  if (digits.length === 0) {
    return { ok: false, error: 'Phone number must contain digits' };
  }
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, error: 'Phone number must be 8–15 digits (international format)' };
  }
  return { ok: true, value: digits };
}

function toChatId(digits) {
  return `${digits}@c.us`;
}

// Parse a time token: "9", "9am", "9:30am", "21:00", "0900".
// Returns { hour, minute } or null.
function parseTime(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).trim().toLowerCase();
  if (!s) return null;

  // 9am / 9:30am / 12pm
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (h < 1 || h > 12 || min > 59) return null;
    if (ap === 'am') {
      if (h === 12) h = 0;
    } else if (h !== 12) {
      h += 12;
    }
    return { hour: h, minute: min };
  }

  // 21:00 / 9:30 (24h)
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return { hour: h, minute: min };
  }

  // 0900 / 2100 (military, 4 digits)
  m = s.match(/^(\d{4})$/);
  if (m) {
    const h = parseInt(m[1].slice(0, 2), 10);
    const min = parseInt(m[1].slice(2), 10);
    if (h > 23 || min > 59) return null;
    return { hour: h, minute: min };
  }

  // plain hour: 9 / 21
  m = s.match(/^(\d{1,2})$/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h > 23) return null;
    return { hour: h, minute: 0 };
  }

  return null;
}

const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// Parse human time into a Date, or null if unparseable.
function parseWhen(input, now) {
  if (input === null || input === undefined) return null;
  const nowDate = toDate(now);
  if (isNaN(nowDate.getTime())) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  // Relative: "in <n> <unit>"
  let m = s.match(/^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2][0];
    let ms;
    if (unit === 'm') ms = n * MS_MIN;
    else if (unit === 'h') ms = n * MS_HOUR;
    else ms = n * MS_DAY;
    return new Date(nowDate.getTime() + ms);
  }

  // today / tomorrow [at] <time>
  m = s.match(/^(today|tomorrow)(?:\s+(?:at\s+)?(.+))?$/);
  if (m) {
    const base = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    if (m[1] === 'tomorrow') base.setDate(base.getDate() + 1);
    let time = { hour: 9, minute: 0 };
    if (m[2]) {
      const t = parseTime(m[2]);
      if (!t) return null;
      time = t;
    }
    base.setHours(time.hour, time.minute, 0, 0);
    return base;
  }

  // ISO-ish: YYYY-MM-DD[ T]HH:MM
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], da = +m[3], h = +m[4], mi = +m[5];
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
    const d = new Date(y, mo - 1, da, h, mi, 0, 0);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  // ISO date only: YYYY-MM-DD -> default 09:00
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], da = +m[3];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    const d = new Date(y, mo - 1, da, 9, 0, 0, 0);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  // Weekday name [at] <time>; next strict future occurrence.
  m = s.match(/^([a-z]+)(?:\s+(?:at\s+)?(.+))?$/);
  if (m && Object.prototype.hasOwnProperty.call(WEEKDAYS, m[1])) {
    const target = WEEKDAYS[m[1]];
    let time = { hour: 9, minute: 0 };
    if (m[2]) {
      const t = parseTime(m[2]);
      if (!t) return null;
      time = t;
    }
    const d = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate(),
      time.hour,
      time.minute,
      0,
      0
    );
    const cur = d.getDay();
    let add = (target - cur + 7) % 7;
    if (add === 0) {
      add = d.getTime() > nowDate.getTime() ? 0 : 7;
    }
    d.setDate(d.getDate() + add);
    return d;
  }

  return null;
}

// Validate a schedule request. `now` may be a Date or epoch ms.
function validateSchedule({ to, text, when } = {}, now) {
  const errors = [];
  if (!text || !String(text).trim()) {
    errors.push('Message text is required');
  }
  const np = normalizePhone(to);
  if (!np.ok) {
    errors.push(np.error || 'Invalid phone number');
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (typeof when !== 'number' || !Number.isFinite(when)) {
    errors.push('Send time is invalid');
  } else if (!Number.isFinite(nowMs)) {
    errors.push('Reference time is invalid');
  } else if (when <= nowMs) {
    errors.push('Send time must be in the future');
  }
  return { ok: errors.length === 0, errors };
}

// Parse an in-chat command: "<trigger> <when...> [to <number>] : <message>".
// `now` may be a Date or epoch ms (index.js passes Date.now()).
function parseChatCommand(body, now, opts = {}) {
  if (body === null || body === undefined) {
    return { ok: false, error: 'Empty command' };
  }
  const s = String(body).trim();
  const trig = s.match(/^(\/schedule|\/sched|\/s)\b\s*(.*)$/i);
  if (!trig) {
    return {
      ok: false,
      error: 'Not a schedule command. Start with /schedule, /sched, or /s',
    };
  }
  const rest = trig[2].trim();

  // Find the message separator ':' — the first colon that is NOT part of a
  // clock time (HH:MM), i.e. whose following character is not a digit. This
  // lets times like "18:00" or "9:30am" live in the schedule spec. Falls back
  // to the first colon if every colon looks time-like.
  let idx = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === ':' && !/\d/.test(rest[i + 1] || '')) {
      idx = i;
      break;
    }
  }
  if (idx === -1) idx = rest.indexOf(':');
  if (idx === -1) {
    return {
      ok: false,
      error: "Missing ':' — format is /schedule <when> [to <number>] : <message>",
    };
  }
  let spec = rest.slice(0, idx).trim();
  const text = rest.slice(idx + 1).trim();
  if (!text) {
    return { ok: false, error: 'Message text is empty' };
  }

  // Extract a trailing "to <number>" clause from the schedule spec.
  let toDisplay;
  const toMatch = spec.match(/\bto\s+(\+?\d[\d\s\-()]*)$/i);
  if (toMatch) {
    toDisplay = toMatch[1].trim();
    spec = spec.slice(0, toMatch.index).trim();
  } else if (opts.defaultChatNumber !== null && opts.defaultChatNumber !== undefined) {
    toDisplay = String(opts.defaultChatNumber);
  }

  if (!toDisplay) {
    return {
      ok: false,
      error: "No recipient — add 'to <number>' or send this inside a chat",
    };
  }
  const np = normalizePhone(toDisplay);
  if (!np.ok) {
    return { ok: false, error: 'Invalid recipient number: ' + (np.error || 'bad format') };
  }

  if (!spec) {
    return { ok: false, error: 'Missing schedule time' };
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  const when = parseWhen(spec, nowDate);
  if (!when || isNaN(when.getTime())) {
    return { ok: false, error: `Couldn't understand the time: "${spec}"` };
  }
  const whenMs = when.getTime();
  const nowMs = nowDate.getTime();
  if (whenMs <= nowMs) {
    return { ok: false, error: 'That time is in the past' };
  }

  return {
    ok: true,
    to: np.value,
    toDisplay,
    text,
    when: whenMs,
  };
}

module.exports = {
  isWeekend,
  nextMonday,
  suggestSendTime,
  normalizePhone,
  toChatId,
  parseWhen,
  validateSchedule,
  parseChatCommand,
};
