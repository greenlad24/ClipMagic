/**
 * Product fit check (#41) — and, for service providers, the "genuine standout"
 * check (#44). Looks the product up (Brave search + the brand's own site) and
 * rates it fit / partial / none against the channel. Cached per domain.
 */
import { getBraveSearchApiKey } from "../../settings/postizSecrets.js";
import { loadRulebook, channelContext } from "./rulebook.js";
import { getFitCache, setFitCache, type Fit } from "./store.js";
import { aiJSON, triageModel, htmlToText, clip, errMsg } from "./util.js";

async function fetchText(url: string, max = 3500): Promise<string> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (DealOrganizer fit check)" } });
    clearTimeout(timer);
    if (!r.ok) return "";
    const ct = r.headers.get("content-type") ?? "";
    if (!/html|text/.test(ct)) return "";
    return clip(htmlToText(await r.text()), max);
  } catch {
    return "";
  }
}

async function brave(q: string): Promise<string> {
  const key = getBraveSearchApiKey();
  if (!key) return "";
  try {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: "6" })}`, {
      headers: { accept: "application/json", "x-subscription-token": key },
    });
    if (!r.ok) return "";
    const j: any = await r.json();
    return (j?.web?.results ?? []).slice(0, 6).map((x: any) => `- ${x.title} — ${x.url}\n  ${String(x.description ?? "").replace(/<[^>]+>/g, "")}`).join("\n");
  } catch {
    return "";
  }
}

export interface FitResult extends Fit {
  standout?: boolean;
  sources: string[];
}

export async function checkFit(input: {
  kind: "product" | "service";
  brand: string;
  product: string | null;
  domain: string | null;
  urls: string[];
  emailSummary: string;
  log: (m: string) => void;
}): Promise<FitResult> {
  const cacheKey = `${input.kind}:${(input.domain || input.brand).toLowerCase()}:${(input.product ?? "").toLowerCase().slice(0, 40)}`;
  const cached = getFitCache(cacheKey);
  if (cached) return cached as FitResult;

  const sources: string[] = [];
  const pages: string[] = [];
  const siteUrls = [
    ...(input.domain ? [`https://${input.domain}`] : []),
    ...input.urls.filter((u) => !/unsubscribe|calendly|youtube\.com|linkedin\.com|twitter\.com|x\.com|google\.com|utm_/i.test(u)).slice(0, 2),
  ];
  for (const u of [...new Set(siteUrls)].slice(0, 3)) {
    const t = await fetchText(u);
    if (t) { pages.push(`[PAGE ${u}]\n${t}`); sources.push(u); }
  }
  const search = await brave(`${input.product || input.brand} ${input.kind === "service" ? "portfolio" : "what is it who is it for"}`);
  if (search) sources.push("brave search");

  const system = [
    "You check whether a sponsor's product (or a service provider's work) fits Jake Dawson's YouTube channel.",
    "Follow the rulebook exactly — rule #41 (fit / partial fit / no fit), #42 (declined brands), #44 (service providers: only a rare, genuinely outstanding portfolio is a standout).",
    "Never invent facts. If the pages say little, say so in notes and judge from what you have.",
    "",
    "=== RULEBOOK ===",
    loadRulebook(),
    "",
    "=== CHANNEL CONTEXT ===",
    channelContext("fit"),
  ].join("\n");
  const user = [
    `Kind: ${input.kind}`,
    `Brand: ${input.brand}`,
    input.product ? `Product: ${input.product}` : "",
    input.domain ? `Sender domain: ${input.domain}` : "",
    `What the email says (summary): ${input.emailSummary}`,
    "",
    pages.length ? pages.join("\n\n") : "(the brand's site could not be fetched)",
    "",
    search ? `Web search:\n${search}` : "(no web search results)",
    "",
    input.kind === "product"
      ? `Return JSON: {"verdict":"fit"|"partial"|"none","angle": string|null /* for partial: the business/work angle we need, one sentence; null otherwise */,"notes": string /* 1-3 sentences: what it is, who it is for, why this verdict */}`
      : `Return JSON: {"verdict":"none","angle":null,"notes": string /* what they offer and the quality of their portfolio, 1-2 sentences */,"standout": boolean /* true ONLY for a rare, really impressive portfolio worth Jake's personal review */}`,
  ].filter(Boolean).join("\n");

  try {
    const r = await aiJSON<any>({ model: triageModel(), purpose: "deals-agent-fit", system, user });
    const out: FitResult = {
      verdict: ["fit", "partial", "none"].includes(r?.verdict) ? r.verdict : "partial",
      angle: r?.angle ? String(r.angle) : null,
      notes: String(r?.notes ?? ""),
      ...(input.kind === "service" ? { standout: Boolean(r?.standout) } : {}),
      sources,
    };
    setFitCache(cacheKey, out);
    return out;
  } catch (e) {
    input.log(`fit check failed for ${input.brand}: ${errMsg(e)}`);
    return { verdict: "partial", angle: null, notes: `Fit check failed (${errMsg(e)}); treated as unverified.`, sources };
  }
}
