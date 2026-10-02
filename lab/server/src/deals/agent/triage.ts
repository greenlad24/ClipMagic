/**
 * Triage: what is this thread, what does the sender actually WANT (the blind
 * test's biggest failure was misreading the goal), and which hard routes apply
 * (spam #69, skip #17, minors / reputation-legal #72, ask Jake #8/#23/#27/#40/#43/#44/#46).
 *
 * Deterministic pre-screen first (automated senders, crypto/WhatsApp payment
 * asks), then one model call on the cheaper tier with the whole rulebook.
 */
import { loadRulebook, stageDefinitions, STAGES } from "./rulebook.js";
import { aiJSON, triageModel, clip, type ParsedMessage } from "./util.js";

export interface Triage {
  category: "sponsor" | "viewer" | "service" | "automated" | "personal" | "other";
  stage: string;
  edgeCase: string | null;
  brand: string | null;
  product: string | null;
  productUrl: string | null;
  senderRole: "brand" | "agency" | "individual" | "platform" | "unknown";
  goal: string;
  suspicious: { is: boolean; why: string; confidence: "high" | "medium" | "low" };
  reputationLegalRisk: { is: boolean; why: string };
  minor: { is: boolean; why: string };
  needsJake: Array<{ rule: string; why: string }>;
  isNewBrand: boolean;
  asks: { shorts: boolean; exclusivity: boolean; audienceData: boolean; adRights: boolean; contract: boolean; linkOrInvoice: boolean; rush: boolean; counterOfferUsd: number | null };
  prescreen?: string;
}

const AUTOMATED_FROM = /(^|[.@_-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|alerts?|updates?|news(letter)?|digest|billing|receipts?|accounts?-?noreply)([.@_-]|$)/i;
const AUTOMATED_DOMAINS = /(^|\.)(google\.com|accounts\.google\.com|youtube\.com|facebookmail\.com|linkedin\.com|slack\.com|notion\.so|stripe\.com|wise\.com|paypal\.com|claude\.ai|anthropic\.com|github\.com|substack\.com|medium\.com|mailchimp\.com|hubspot\.com)$/i;
const CRYPTO_PAY = /\b(usdt|usdc|bitcoin|btc|ethereum|eth wallet|crypto(currency)? (payment|wallet|transfer)|pay(ment)? (in|via|with) crypto|trc-?20|erc-?20|binance pay)\b/i;
const WHATSAPP_PAY = /\b(whats\s?app|telegram)\b[\s\S]{0,160}\b(pay|payment|transfer|deposit|wallet|salary|commission|contact me|add me|reach me)\b|\b(pay|payment|transfer|deposit)\b[\s\S]{0,160}\b(whats\s?app|telegram)\b/i;

/** Returns a skip/spam verdict without spending a model call, or null. */
export function prescreen(latest: ParsedMessage, all: ParsedMessage[]): { kind: "skip" | "spam"; why: string } | null {
  const from = latest.fromEmail;
  const dom = from.split("@")[1] ?? "";
  const humanThread = all.some((m) => m.isFromMe && !m.isDraft);
  if (!humanThread && (AUTOMATED_FROM.test(from.split("@")[0] ?? "") || AUTOMATED_DOMAINS.test(dom))) {
    return { kind: "skip", why: `Automated sender (${from}) — Miscellaneous, no draft (#17).` };
  }
  const text = all.filter((m) => !m.isFromMe).map((m) => m.fresh).join("\n");
  if (CRYPTO_PAY.test(text)) return { kind: "spam", why: "Crypto payment request (#69) — marked spam, never answered, not flagged." };
  if (WHATSAPP_PAY.test(text) && !humanThread) return { kind: "spam", why: "WhatsApp/Telegram payment or contact ask from an unknown sender (#69) — marked spam, never answered, not flagged." };
  return null;
}

export async function triageThread(input: {
  transcript: string;
  subject: string;
  latestFrom: string;
  dealContext: string;
  brandHistory: string;
  jakeHasReplied: boolean;
}): Promise<Triage> {
  const system = [
    "You triage emails arriving in Jake Dawson's sponsorship inbox (jakedawsonbusiness@gmail.com). Jake is a YouTube creator (AI tools for solopreneurs / small-business owners).",
    "Your job: classify the thread, work out what the sender ACTUALLY wants from Jake in their latest email (the concrete goal — e.g. 'get a second free month of credits', 'get the invoice link so finance can pay', 'push the publish date earlier', 'get a price for 2 Shorts'), and detect every route the rulebook forces.",
    "The rulebook below is the source of truth and overrides the stage definitions. Read it completely.",
    "",
    "Hard routes to detect:",
    "- suspicious (#69) — marking spam is irreversible from the brand's side, so be precise. SUSPICIOUS means concrete scam/impersonation signals: someone claiming to BE a brand's employee while writing from an unrelated domain or free-mail AND other red flags; lookalike/misspelled brand domains; asking Jake to 'verify' via a third-party link, download/run a file or install an app; payment in crypto or via WhatsApp/Telegram; fees to start. NOT suspicious by itself: an AGENCY or talent/marketing firm writing from its OWN domain on behalf of a client brand (that is how most sponsorships arrive — agencies have their own domains, e.g. ssgmcn.com, famesters.com, mediacube.io); an individual rep or small agency on gmail; a brand you haven't heard of. #69's 'domain doesn't match the brand or a known agency' targets IMPERSONATION (claiming to be the brand), not agencies. Set confidence 'high' only when the scam signals are concrete; otherwise 'low'/'medium' and explain in why.",
    "- reputationLegalRisk (#72): anything that could risk Jake's reputation or cause legal issues (threats, legal claims, harassment, controversial/adult/gambling/crypto-scheme promotion, requests to make false claims).",
    "- minor (#72): the sender is (or says they are) under 18.",
    "- needsJake: every case where the rulebook says Jake must decide — #8 production/scheduling/contract conflicts; #23 any exclusivity / non-compete request; #27 great fit + below-floor offer when next month is light (the drafter checks the month); #35 a contract arrived (flag whether it keeps our ad rights — note only); #40 duplicate/exclusivity conflicts when unsure; #43 big deals and long-term offers (flag every such email); #44 a genuinely standout service provider; #46 ANY needed link or document only Jake has (invoice link, video draft link, contract, payment details); #72 flags. Do NOT list things the rulebook lets the agent answer itself (price holds, standard terms, Skool questions, polite declines).",
    "- Miscellaneous = automated notifications, newsletters, platform alerts, personal/non-business mail, anything that needs no reply (#17).",
    "",
    "=== STAGES (baselines only, #10 — use edgeCase when none fits well) ===",
    stageDefinitions(),
    "",
    "=== RULEBOOK ===",
    loadRulebook(),
  ].join("\n");

  const user = [
    `Subject: ${input.subject}`,
    `Latest message from: ${input.latestFrom}`,
    `Jake has already replied in this thread: ${input.jakeHasReplied ? "yes" : "no"}`,
    "",
    "=== DEAL ORGANIZER RECORD FOR THIS SENDER ===",
    input.dealContext || "(no deal on the board for this sender/domain)",
    "",
    "=== EARLIER THREADS WITH THIS SENDER'S DOMAIN ===",
    input.brandHistory || "(none)",
    "",
    "=== THE WHOLE THREAD (oldest first) ===",
    clip(input.transcript, 40000),
    "",
    `Return JSON exactly:
{"category":"sponsor"|"viewer"|"service"|"automated"|"personal"|"other",
 "stage": one of ${JSON.stringify(STAGES)},
 "edgeCase": string|null /* one sentence when the thread doesn't fit the stage cleanly */,
 "brand": string|null /* the company/product brand being promoted (not the agency) */,
 "product": string|null,
 "productUrl": string|null,
 "senderRole":"brand"|"agency"|"individual"|"platform"|"unknown",
 "goal": string /* what they want from Jake in THEIR LATEST email — concrete, one or two sentences */,
 "suspicious":{"is":boolean,"confidence":"high"|"medium"|"low","why":string},
 "reputationLegalRisk":{"is":boolean,"why":string},
 "minor":{"is":boolean,"why":string},
 "needsJake":[{"rule":"#NN","why":string}],
 "isNewBrand":boolean,
 "asks":{"shorts":boolean,"exclusivity":boolean,"audienceData":boolean,"adRights":boolean,"contract":boolean,"linkOrInvoice":boolean,"rush":boolean,"counterOfferUsd":number|null}}`,
  ].join("\n");

  // Triage is a judgement call (spam, what Jake must decide) — medium effort on Sonnet 5.5.
  const r = await aiJSON<any>({ model: triageModel(), purpose: "deals-agent-classify", system, user, effort: "medium" });
  const stage = STAGES.includes(r?.stage) ? r.stage : "Reply";
  const b = (x: any) => ({ is: Boolean(x?.is), why: String(x?.why ?? "") });
  return {
    category: r?.category ?? "other",
    stage,
    edgeCase: r?.edgeCase ? String(r.edgeCase) : null,
    brand: r?.brand ? String(r.brand) : null,
    product: r?.product ? String(r.product) : null,
    productUrl: r?.productUrl ? String(r.productUrl) : null,
    senderRole: r?.senderRole ?? "unknown",
    goal: String(r?.goal ?? ""),
    suspicious: { ...b(r?.suspicious), confidence: ["high", "medium", "low"].includes(r?.suspicious?.confidence) ? r.suspicious.confidence : "low" },
    reputationLegalRisk: b(r?.reputationLegalRisk),
    minor: b(r?.minor),
    needsJake: Array.isArray(r?.needsJake) ? r.needsJake.map((x: any) => ({ rule: String(x?.rule ?? ""), why: String(x?.why ?? "") })).filter((x: any) => x.why) : [],
    isNewBrand: Boolean(r?.isNewBrand),
    asks: {
      shorts: Boolean(r?.asks?.shorts), exclusivity: Boolean(r?.asks?.exclusivity), audienceData: Boolean(r?.asks?.audienceData),
      adRights: Boolean(r?.asks?.adRights), contract: Boolean(r?.asks?.contract), linkOrInvoice: Boolean(r?.asks?.linkOrInvoice),
      rush: Boolean(r?.asks?.rush), counterOfferUsd: typeof r?.asks?.counterOfferUsd === "number" ? r.asks.counterOfferUsd : null,
    },
  };
}
