/**
 * Pre-save checks (#73 + the price/ads/payment rules), as code FIRST and then
 * a checker-model pass. A draft is saved only when every check passes; one
 * failure → one redraft with the problems fed back; still failing → no draft,
 * the item is flagged with the reason.
 */
import type { Check } from "./store.js";
import { loadRulebook } from "./rulebook.js";
import { aiJSON, draftModel, clip } from "./util.js";

const PLACEHOLDER = /\[[^\]\n]{0,80}\]|\{\{[^}]*\}\}|<(?:insert|link|date|name|first name|brand|month|price|invoice)[^>]*>|\b(TBD|TBC|XXX+|INSERT\b|PLACEHOLDER|lorem ipsum)\b/i;
const NOTE_TO_JAKE = /(note to (jake|self)|internal note|\(note|for jake:|jake,? (please|you should|confirm)|\bTODO\b|\bFYI jake|draft (note|comment)|\[agent|as an ai (language model|assistant)\b|\bthe agent\b)/i;
const CODE = /```|<\/?(p|div|br|html|span|ol|ul|li|strong|a)\b[^>]*>|function\s*\(|=>|\bconst\s+\w+\s*=|\{\s*"\w+"\s*:/i;
const OWN_ADS = /(\b(we|i)\s+(also\s+|may\s+|might\s+|will\s+|usually\s+|typically\s+)?(run|running|boost|boosting|put|putting|promote|promoting)\s+(paid\s+)?(ads|advertising|ad spend|promotion)\b)|(\bpaid (ads|traffic|promotion|media)\b[^.\n]{0,60}\b(our|my) (video|videos|channel|content)\b)|(\b(our|my) (own )?(paid )?(ads|ad campaigns|ad spend)\b)|(\bboost(ed)? (the |your )?video with (paid )?ads\b)/i;
const DOUBT = /(will|would) (you|that) be (ok|okay|alright|fine) (if|with)|hope (that'?s|this is) (ok|okay|alright)|if that'?s (ok|okay) with you|sorry for (the|any) (inconvenience|delay)|unfortunately we can only/i;
const PAYPAL = /\bpay\s?pal\b/i;
const CRYPTO = /\b(crypto|usdt|usdc|bitcoin|wallet address)\b/i;
const FLOOR_WORDS = /\b(floor|absolute minimum|lowest (we|i) (can|could) go|bottom line price|rock[- ]bottom)\b/i;

function amounts(text: string): Array<{ usd: number; at: number }> {
  const out: Array<{ usd: number; at: number }> = [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b|K\b)?|\b(\d{1,3}(?:,\d{3})+|\d{4,5})\s?(?:USD|usd|dollars)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = (m[1] ?? m[3] ?? "").replace(/,/g, "");
    let v = Number(raw);
    if (m[2]) v *= 1000;
    if (Number.isFinite(v) && v > 0) out.push({ usd: v, at: m.index });
  }
  return out;
}

function near(text: string, at: number, re: RegExp, span = 90): boolean {
  return re.test(text.slice(Math.max(0, at - span), at + span));
}

export function codeChecks(input: {
  body: string;
  signature: string;
  firstReply: boolean;
  inboundText: string;
  approvedOverrides: string;
  earlierJakeText: string;
  fitVerdict?: "fit" | "partial" | "none" | null;
}): Check[] {
  const { body, signature } = input;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const withoutSig = body.replace(signature, "");

  const ph = withoutSig.match(PLACEHOLDER);
  add("no_placeholders", !ph, ph ? `Contains a placeholder/bracket: "${ph[0]}"` : "No brackets or placeholders.");
  const nj = withoutSig.match(NOTE_TO_JAKE);
  add("no_notes_to_jake", !nj, nj ? `Looks like a note to Jake: "${nj[0]}"` : "No notes to Jake.");
  const cd = withoutSig.match(CODE);
  add("no_code", !cd, cd ? `Contains code/markup: "${cd[0]}"` : "No code or markup.");
  add("signature_present", norm(body).endsWith(norm(signature)), norm(body).endsWith(norm(signature)) ? "Ends with the standard signature (#48)." : "The standard signature is missing or altered (#48).");
  const oa = withoutSig.match(OWN_ADS);
  add("no_own_ads", !oa, oa ? `Mentions our own paid ads (#22/#35): "${oa[0]}"` : "No mention of our own ads.");
  const pp = PAYPAL.test(withoutSig) || CRYPTO.test(withoutSig);
  add("payment_methods", !pp, pp ? "Mentions PayPal/crypto — only Wise, then Stripe, may be offered (#68)." : "No PayPal/crypto.");
  const db = withoutSig.match(DOUBT);
  add("no_doubt_phrases", !db, db ? `Plants doubt / apologetic phrasing (#47): "${db[0]}"` : "Confident tone.");

  // ── prices ──
  const inboundAmounts = new Set(amounts(input.inboundText).map((a) => a.usd));
  const problems: string[] = [];
  const found = amounts(withoutSig);
  for (const a of found) {
    const v = a.usd;
    const isShort = near(withoutSig, a.at, /\bshorts?\b|\breels?\b|tiktok/i);
    const isAdRights = near(withoutSig, a.at, /\b(ad|ads|advertis\w*|usage|rights|whitelist\w*|paid media|spark)\b/i);
    if (isShort && v % 2500 === 0) continue; // $2,500 per Short, or n × $2,500
    if (isShort && v < 2500) { problems.push(`$${v} for Shorts — every Short is $2,500, never discounted (#21)`); continue; }
    if (isAdRights && v === 1000) continue; // +$1,000 per 30 days (#67)
    if (v >= 6000) {
      if (input.firstReply && v < 6500 && !input.approvedOverrides) problems.push(`first reply quotes $${v} — the first reply quotes $6,500 (#18/#19)`);
      continue;
    }
    if (inboundAmounts.has(v) && near(withoutSig, a.at, /\b(your|you|budget|offer|mentioned|proposed)\b/i)) continue; // restating THEIR number
    if (input.approvedOverrides && input.approvedOverrides.includes(String(v))) continue; // Jake approved this exact number on Slack
    problems.push(`$${v} is below the $6,000 dedicated-video floor and isn't a Short ($2,500) or the ad-rights add-on ($1,000/30 days)`);
  }
  if (input.firstReply) {
    if (/\b6,?000\b/.test(withoutSig) && !input.approvedOverrides) problems.push("first reply names $6,000 — the floor is never mentioned in a first reply (#19)");
    if (FLOOR_WORDS.test(withoutSig)) problems.push("first reply talks about a floor/minimum (#19)");
  }
  if (/\bshorts?\b[^.\n]{0,80}\b(discount|bundle|package deal|reduced)\b|\b(discount|bundle|reduced)\b[^.\n]{0,80}\bshorts?\b/i.test(withoutSig)) problems.push("Shorts discount/bundle language (#21)");
  if (/\bintegration\b/i.test(withoutSig) && !/\bno longer\b|\bdon'?t offer\b|\bonly\b|\binstead\b/i.test(withoutSig)) problems.push("offers an integration — dedicated videos only (#28)");
  add("price_rules", problems.length === 0, problems.length ? problems.join("; ") : found.length ? `Prices OK: ${found.map((a) => `$${a.usd.toLocaleString("en-US")}`).join(", ")}` : "No prices quoted.");

  if (input.fitVerdict === "none") {
    const offers = /\$\s?6,?[05]00\b|dedicated (youtube )?video:/i.test(withoutSig);
    add("fit_consistency", !offers, offers ? "The fit check rated this product NO FIT (#41) but the draft makes a paid offer — decline politely, or ask Jake if you believe the fit check is wrong." : "Consistent with the no-fit verdict.");
  }
  const words = withoutSig.split(/\s+/).filter(Boolean).length;
  add("length", words <= 260, words <= 260 ? `${words} words before the signature.` : `${words} words before the signature — too long (#47: as few words as possible).`);
  return checks;
}

/** The checker model: rules a regex can't see (goal answered, dates consistent, invented facts, tone). */
export async function modelCheck(input: {
  draft: string;
  transcript: string;
  triageGoal: string;
  availabilityText: string;
  jakeAnswers: string;
  firstReply: boolean;
  todayLine: string;
  /** What the drafter was given as fact: fit verdict, live audience snapshot, board record. */
  facts: string;
}): Promise<Check[]> {
  const system = [
    "You are the final pre-save checker for reply drafts in Jake Dawson's sponsorship inbox. You never rewrite; you judge.",
    "Fail the draft only for a REAL problem a careful human editor would block. Checks:",
    "1. goal — the draft answers what the sender actually wants in their latest email (and doesn't ignore a direct question).",
    "2. rules — follow the product-fit verdict given below (#41: no fit → polite decline, partial → offer with the angle stated); nothing in the draft breaks the rulebook (prices, first-reply pricing, Shorts only if they asked, no integrations, no PayPal, never mentions our own paid ads, payment ladder, exclusivity max 1 month + flagged, contract terms, formats not sold, Skool pricing, no past sponsors' results).",
    "3. dates — every date/month is consistent with earlier replies in the thread, with the availability block, and with the 14-days-from-script-approval rule; no date in the past; weekday/date pairs are correct.",
    "4. facts — nothing invented: no audience numbers except those in the live snapshot below, no 'share of business owners' figure unless provided, no promises Jake hasn't made, no links not given, no claims about production progress beyond 'research and script development' unless the thread/board says so.",
    "5. placeholders — no brackets, no 'insert link', no notes to Jake, no code.",
    "6. concise — as short as possible without dropping a needed detail; relaxed, confident, premium, polite; written as a company with a policy; no doubt-planting.",
    "",
    "=== RULEBOOK ===",
    loadRulebook(),
  ].join("\n");
  const user = [
    input.todayLine,
    `First reply from Jake in this thread: ${input.firstReply ? "yes" : "no"}`,
    `What the sender wants (triage): ${input.triageGoal}`,
    input.jakeAnswers ? `Jake's answers on Slack for this thread (these override the rulebook for this thread):\n${input.jakeAnswers}` : "",
    "",
    "=== FACTS THE DRAFTER WAS GIVEN (fit check, live audience snapshot, board record) — these are NOT invented ===",
    input.facts || "(none)",
    "",
    "=== AVAILABILITY ===",
    input.availabilityText,
    "",
    "=== THREAD (oldest first) ===",
    clip(input.transcript, 30000),
    "",
    "=== DRAFT TO CHECK ===",
    input.draft,
    "",
    `Return JSON: {"checks":[{"name":"goal"|"rules"|"dates"|"facts"|"placeholders"|"concise","ok":boolean,"detail":string /* one sentence; for a failure say exactly what to change */}]}`,
  ].filter(Boolean).join("\n");
  const r = await aiJSON<any>({ model: draftModel(), purpose: "deals-agent-check", system, user });
  const list: Check[] = Array.isArray(r?.checks) ? r.checks.map((c: any) => ({ name: `model_${String(c?.name ?? "check")}`, ok: Boolean(c?.ok), detail: String(c?.detail ?? "") })) : [];
  if (!list.length) return [{ name: "model_check", ok: false, detail: "Checker returned nothing usable." }];
  return list;
}
