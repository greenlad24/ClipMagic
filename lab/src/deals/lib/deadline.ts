/**
 * Deal deadlines — FREE TEXT, parsed to a date (Jake, 2026-09-30: "I prefer free
 * text that is analyzed by AI after").
 *
 * `deal.deadline` is exactly what was typed (or what the email autofill wrote):
 * "mid Oct", "late June or early July", "Oct 15 go-live". The server parses it
 * into `deal.deadline_date` (YYYY-MM-DD) — deterministic rules first, a cheap AI
 * call when the text is ambiguous (server/src/deals/deadlineParse.ts). Sort,
 * group and count down on the DATE; show the TEXT as the label.
 *
 * `parseDeadlineText` below is the same rule set as the server's, used for the
 * live "→ Wed 15 Oct" preview while typing and as the fallback for a deal whose
 * date the server has not parsed yet. A deadline is a "by" date: a bare month →
 * its last day, "early" → 10th, "mid" → 15th, "late / end of" → last day,
 * "first|second|third week of" → 7|14|21, "Q3" → Sep 30, "… onward" / "from …"
 * → the start of that window, ranges → the first option.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NO_DATE_RE = /^\s*(tbd|tba|tbc|asap|n\/?a|none|no deadline|flexible|unknown|-+)\s*$/i;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dim(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}
function ymd(y: number, m0: number, d: number): string {
  const day = Math.min(Math.max(1, d), dim(y, m0));
  return `${y}-${String(m0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function toUtc(s: string): number {
  return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
}
function addDays(s: string, n: number): string {
  const d = new Date(toUtc(s) + n * 86_400_000);
  return ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Today (the viewer's local calendar date) as YYYY-MM-DD. */
export function todayYmd(): string {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
}

/** True for a real `YYYY-MM-DD` date. */
export function isIsoDate(s: string | null | undefined): boolean {
  if (!s) return false;
  const m = s.trim().match(ISO_RE);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  return y >= 1970 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= dim(y, mo - 1);
}

/** Free text → YYYY-MM-DD (or null). Same rules as the server's deterministic pass. */
export function parseDeadlineText(text: string | null | undefined, ref: string = todayYmd()): string | null {
  const raw = (text ?? '').trim();
  if (!raw || NO_DATE_RE.test(raw)) return null;
  const refY = +ref.slice(0, 4);

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso && isIsoDate(`${iso[1]}-${iso[2]}-${iso[3]}`)) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const lower = raw.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/\s+/g, ' ');
  const explicitYear = lower.match(/\b(20\d{2})\b/);
  const inYear = (m0: number, day: (y: number) => number): string => {
    if (explicitYear) { const y = +explicitYear[1]; return ymd(y, m0, day(y)); }
    let s = ymd(refY, m0, day(refY));
    if (toUtc(s) < toUtc(ref) - 60 * 86_400_000) s = ymd(refY + 1, m0, day(refY + 1));
    return s;
  };

  if (/\btoday\b|\beod\b/.test(lower)) return ref;
  if (/\btomorrow\b/.test(lower)) return addDays(ref, 1);
  const inN = lower.match(/\bin (\d{1,3}) (day|week|month)s?\b/);
  if (inN) {
    const n = +inN[1];
    if (inN[2] === 'day') return addDays(ref, n);
    if (inN[2] === 'week') return addDays(ref, 7 * n);
    const m0 = +ref.slice(5, 7) - 1 + n;
    return ymd(refY + Math.floor(m0 / 12), m0 % 12, +ref.slice(8, 10));
  }
  if (/\b(end of (this |the )?month|eom)\b/.test(lower) && !MONTH_RE.test(lower)) return ymd(refY, +ref.slice(5, 7) - 1, 31);
  if (/\bend of next month\b/.test(lower)) { const m0 = +ref.slice(5, 7); return ymd(refY + Math.floor(m0 / 12), m0 % 12, 31); }
  if (/\bnext week\b/.test(lower) && !MONTH_RE.test(lower)) return addDays(ref, 7);
  const wd = WEEKDAYS.findIndex(w => new RegExp(`\\b${w.slice(0, 3)}(${w.slice(3)})?\\b`).test(lower));
  if (wd >= 0 && !MONTH_RE.test(lower) && !/\d/.test(lower)) {
    const cur = new Date(toUtc(ref)).getUTCDay();
    let delta = (wd - cur + 7) % 7;
    if (delta === 0) delta = 7;
    if (/\bnext\b/.test(lower) && delta < 7) delta += 7;
    return addDays(ref, delta);
  }
  const q = lower.match(/\bq([1-4])\b/);
  if (q && !MONTH_RE.test(lower)) { const m0 = +q[1] * 3 - 1; return inYear(m0, y => dim(y, m0)); }

  const mm = lower.match(MONTH_RE);
  if (mm && mm.index !== undefined) {
    const m0 = MONTHS.indexOf(mm[1].slice(0, 3));
    const before = lower.slice(0, mm.index);
    const after = lower.slice(mm.index + mm[0].length);
    const dayAfter = after.match(/^\s*(\d{1,2})\b(?![:.]\d)/);
    const dayBefore = before.match(/\b(\d{1,2})\s*(?:of\s+)?$/);
    const startWindow = /\b(onward|onwards|from|starting|start from|beginning from|after|and later|or later)\b/.test(lower);
    let day: (y: number) => number;
    if (dayAfter && +dayAfter[1] >= 1 && +dayAfter[1] <= 31) { const d = +dayAfter[1]; day = () => d; }
    else if (dayBefore && +dayBefore[1] >= 1 && +dayBefore[1] <= 31) { const d = +dayBefore[1]; day = () => d; }
    else {
      const wk = before.match(/\b(first|1|second|2|third|3|fourth|4|last|final) week\b/);
      if (wk) {
        const n = ({ first: 1, '1': 1, second: 2, '2': 2, third: 3, '3': 3, fourth: 4, '4': 4 } as Record<string, number>)[wk[1]];
        day = n ? (startWindow ? () => (n - 1) * 7 + 1 : () => n * 7) : (y => (startWindow ? dim(y, m0) - 6 : dim(y, m0)));
      } else if (/\bmid(-|\s)?$|\bmiddle of\s*$|\bmid\b/.test(before)) day = () => 15;
      else if (/\b(end of|late|by the end of|by end of|last days? of)\s*$/.test(before) || /\b(late|end)\b/.test(before)) day = y => (startWindow ? 20 : dim(y, m0));
      else if (/\b(early|beginning of|start of|first days? of)\b/.test(before)) day = () => (startWindow ? 1 : 10);
      else day = y => (startWindow ? 1 : dim(y, m0));
    }
    return inYear(m0, day);
  }

  const num = lower.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
  if (num) {
    const a = +num[1], b = +num[2];
    let month = a, day = b;
    if (a > 12 && b <= 12) { month = b; day = a; }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let y: number | null = num[3] ? +num[3] : null;
    if (y !== null && y < 100) y += 2000;
    return y ? ymd(y, month - 1, day) : inYear(month - 1, () => day);
  }
  return null;
}

type DeadlineLike = { deadline?: string | null; deadline_date?: string | null; deadline_parsed_from?: string | null };

/**
 * The deal's deadline as YYYY-MM-DD: the server's parse (when it belongs to the
 * current text — right after an edit the text is new and the date not yet), else
 * a local parse of the text.
 */
export function dealDeadlineYmd(deal: DeadlineLike): string | null {
  const text = (deal.deadline ?? '').trim();
  if (!text) return null;
  const fresh = deal.deadline_parsed_from == null || deal.deadline_parsed_from.trim() === text;
  if (fresh && deal.deadline_date && isIsoDate(deal.deadline_date)) return deal.deadline_date;
  return parseDeadlineText(text);
}

/** Local Date for a YYYY-MM-DD (no UTC shift). */
export function ymdToDate(s: string): Date {
  return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
}

/** The deal's deadline as a local Date, or null. */
export function dealDeadlineDate(deal: DeadlineLike): Date | null {
  const s = dealDeadlineYmd(deal);
  return s ? ymdToDate(s) : null;
}

/** Whole days from today to the deal's deadline date; negative when past. */
export function dealDaysUntil(deal: DeadlineLike): number | null {
  const s = dealDeadlineYmd(deal);
  if (!s) return null;
  return Math.round((toUtc(s) - toUtc(todayYmd())) / 86_400_000);
}

/** Legacy helpers (text only). */
export function parseDeadlineDate(s: string | null | undefined): Date | null {
  const p = parseDeadlineText(s);
  return p ? ymdToDate(p) : null;
}
export function daysUntil(s: string | null | undefined): number | null {
  return dealDaysUntil({ deadline: s });
}

/** The parsed-date chip: "Wed 15 Oct" (+ year when not this year). */
export function formatDeadlineChip(s: string | null | undefined): string {
  if (!s || !isIsoDate(s)) return '';
  const d = ymdToDate(s);
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const dm = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${wd} ${dm}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

/** Label: the text exactly as written (an ISO date — old imports / the picker era — reads "Oct 15"). */
export function formatDeadline(s: string | null | undefined): string {
  if (!s) return '';
  if (!isIsoDate(s.trim())) return s;
  const d = ymdToDate(s.trim());
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Sep 28" for the "from email · <date>" hint. */
export function formatShortDay(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.slice(0, 10);
  if (!isIsoDate(t)) return '';
  return ymdToDate(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
