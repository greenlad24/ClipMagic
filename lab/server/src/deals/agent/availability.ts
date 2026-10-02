/**
 * Availability from the LIVE pipeline (rules #24, #31, #32, #33).
 *
 *  - A client is "in production" only once the contract is signed by BOTH
 *    sides = the deal sits in a production column (Contract Signed onward).
 *  - Up to 3 DEDICATED sponsored videos a month; Shorts never take a slot.
 *  - Priority slot (100% upfront) from 1 month out; at the very start of a
 *    month with nothing booked, 3 weeks out may be offered (#32 exception).
 *  - Delivery: video draft up to 14 days from script approval (#33).
 *
 * Deadlines on the board are free text ("October 14 2026", "By October 9, 2026
 * (October 16, 2026)", "late July") — the first month named decides the slot.
 */
import { db } from "../../db/index.js";
import { bangkokParts, MONTHS } from "./util.js";

const MONTH_RE = new RegExp(`\\b(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})(?![a-z])\\.?\\s*(\\d{1,2})?(?:st|nd|rd|th)?,?\\s*(\\d{4})?`, "i");

function parseDeadlineMonth(text: string | null | undefined, today: { y: number; m: number }): { y: number; m: number; label: string } | null {
  if (!text) return null;
  const mm = text.match(MONTH_RE);
  if (!mm) return null;
  const idx = MONTHS.findIndex((x) => x.toLowerCase().startsWith(mm[1].toLowerCase().slice(0, 3)));
  if (idx < 0) return null;
  let y = mm[3] ? Number(mm[3]) : today.y;
  if (!mm[3] && idx + 1 < today.m - 6) y += 1;
  return { y, m: idx + 1, label: text };
}

const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const addMonths = (y: number, m: number, k: number) => { const t = (y * 12 + (m - 1)) + k; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; };

export interface Availability {
  todayIso: string;
  capacityPerMonth: number;
  months: Array<{ key: string; name: string; booked: string[]; free: number }>;
  standardMonth: string;
  priorityFrom: string;
  threeWeekException: boolean;
  nextMonthBookings: number;
  pending: string[];
  stale: string[];
  text: string;
}

export function computeAvailability(now = new Date()): Availability {
  const t = bangkokParts(now);
  const capacity = 3;
  const stageRows = db.prepare(`SELECT display_name, is_production_stage, sort_order FROM deals_stage_config`).all() as any[];
  const prod = new Set(stageRows.filter((r) => r.is_production_stage === 1).map((r) => r.display_name));
  const done = new Set(["Completed", "2nd Invoice Paid"]);
  const deals = db.prepare(`SELECT id, client_name, project_name, stage, deadline, deadline_date, estimated_value, updated_at, client_email FROM deals_deals WHERE (archived IS NULL OR archived != 1)`).all() as any[];

  const months = Array.from({ length: 5 }, (_, k) => addMonths(t.y, t.m, k)).map(({ y, m }) => ({ key: monthKey(y, m), name: `${MONTHS[m - 1]} ${y}`, booked: [] as string[], free: capacity }));
  const byKey = new Map(months.map((x) => [x.key, x]));
  const pending: string[] = [];
  const stale: string[] = [];

  for (const d of deals) {
    const name = `${d.project_name || d.client_name || "?"} (${d.client_email || "?"})`;
    if (prod.has(d.stage) && !done.has(d.stage)) {
      // Prefer the AI/rule-parsed date (deadlineParse.ts); fall back to reading the text.
      const iso = typeof d.deadline_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.deadline_date) ? d.deadline_date : null;
      const dm = iso
        ? { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), label: `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` }
        : parseDeadlineMonth(d.deadline, t);
      const label = `${name} — ${d.stage}${d.deadline ? `, deadline "${d.deadline}"` : ", no deadline set"}`;
      if (!dm) {
        // In production but undated: it will publish within the next few weeks — count it in the month 3 weeks from today.
        const soon = new Date(Date.UTC(t.y, t.m - 1, t.day) + 21 * 86_400_000);
        const k = monthKey(soon.getUTCFullYear(), soon.getUTCMonth() + 1);
        stale.push(`${label} (no deadline on the board — counted in ${MONTHS[soon.getUTCMonth()]})`);
        byKey.get(k)?.booked.push(`${label} [undated]`);
        continue;
      }
      const k = monthKey(dm.y, dm.m);
      if (k < monthKey(t.y, t.m)) { stale.push(`${label} (deadline already passed)`); continue; }
      byKey.get(k)?.booked.push(label);
    } else if (["Waiting For Invoice", "Waiting For Payment", "Date/Contract Negotiation"].includes(d.stage)) {
      const ageDays = (Date.now() - Date.parse(d.updated_at)) / 86_400_000;
      if (ageDays <= 45) pending.push(`${name} — ${d.stage}${d.deadline ? `, target "${d.deadline}"` : ""}${d.estimated_value ? `, $${d.estimated_value}` : ""}`);
    }
  }
  for (const m of months) m.free = Math.max(0, capacity - m.booked.length);

  const cur = months[0];
  const next = months[1];
  const threeWeek = t.day <= 7 && cur.booked.length === 0;
  const priorityDate = new Date(Date.UTC(t.y, t.m - 1, t.day) + (threeWeek ? 21 : 0) * 86_400_000);
  if (!threeWeek) priorityDate.setUTCMonth(priorityDate.getUTCMonth() + 1);
  const pKey = monthKey(priorityDate.getUTCFullYear(), priorityDate.getUTCMonth() + 1);
  const pMonth = byKey.get(pKey);
  const priorityFrom = pMonth && pMonth.free > 0
    ? `${MONTHS[priorityDate.getUTCMonth()]} ${priorityDate.getUTCDate()}, ${priorityDate.getUTCFullYear()}`
    : `${(months.find((x) => x.key > pKey && x.free > 0) ?? months[months.length - 1]).name} (the month of ${pKey} is full)`;
  // Standard (50/50) bookings: the first month with a free slot starting ~6 weeks out.
  const sixWeeks = new Date(Date.UTC(t.y, t.m - 1, t.day) + 42 * 86_400_000);
  const sKey = monthKey(sixWeeks.getUTCFullYear(), sixWeeks.getUTCMonth() + 1);
  const std = months.find((x) => x.key >= sKey && x.free > 0) ?? months[months.length - 1];

  const text = [
    `Today (Bangkok): ${t.weekday}, ${MONTHS[t.m - 1]} ${t.day}, ${t.y}.`,
    `Capacity: ${capacity} DEDICATED sponsored videos per month (Shorts never take a slot). Only deals with a contract signed by BOTH sides count as booked.`,
    ...months.map((m) => `- ${m.name}: ${m.booked.length}/${capacity} booked, ${m.free} free${m.booked.length ? `\n    ${m.booked.join("\n    ")}` : ""}`),
    pending.length ? `Not yet signed (NOT counted, but they may take a slot soon — don't oversell):\n    ${pending.join("\n    ")}` : "Not yet signed: none active.",
    stale.length ? `Board data to treat with care:\n    ${stale.join("\n    ")}` : "",
    `Earliest PRIORITY slot (100% upfront, rule #32): ${priorityFrom}${threeWeek ? " — start-of-month exception: nothing booked this month, so 3 weeks out may be offered (work begins once payment lands; video draft 14 days from script approval)." : "."}`,
    `Earliest STANDARD booking window: ${std.name}.`,
    `Next month (${next.name}) bookings: ${next.booked.length}.`,
    `Delivery rule (#33): contract signed → payment → research → script for approval; the video draft is due up to 14 days after SCRIPT APPROVAL — write the concrete date when script approval is known; otherwise stay vague about progress ("we're in research and script development").`,
  ].filter(Boolean).join("\n");

  return {
    todayIso: t.iso, capacityPerMonth: capacity, months, standardMonth: std.name, priorityFrom, threeWeekException: threeWeek,
    nextMonthBookings: next.booked.length, pending, stale, text,
  };
}
