/**
 * The rulebook and the other reference texts, loaded at RUNTIME from the data
 * dir so Jake's edits to AGENT-RULES.md apply on the next run without a deploy.
 *
 *   AGENT-RULES.md                — THE source of truth (74 rules; the latest wording wins)
 *   reference/old-reply-prompts/  — the 19 stage definitions + per-stage structure (superseded
 *                                   wherever they conflict with the rulebook)
 *   deals_ai_config.channel_context — who Jake/the audience are (its prices are stale; stripped)
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { houseRulesBlock } from "./houseRules.js";

export const SPEC_DIR = () => path.join(config.dataDir, "imports", "dealorg", "SPEC");

const cache = new Map<string, { mtimeMs: number; text: string }>();
function readCached(file: string): string | null {
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = fs.readFileSync(file, "utf8");
    cache.set(file, { mtimeMs: st.mtimeMs, text });
    return text;
  } catch {
    return null;
  }
}

/** The rulebook text. Throws if it is missing — the agent must never run without it. */
export function loadRulebook(): string {
  const t = readCached(path.join(SPEC_DIR(), "AGENT-RULES.md"));
  if (!t || t.length < 2000) throw new Error(`Rulebook not found or empty at ${path.join(SPEC_DIR(), "AGENT-RULES.md")}`);
  // The "Rejected / removed" list is for humans; keep it (it tells the model what NOT to use).
  // Jake's own newer rules (Lab / Slack) ride at the end and override the numbered ones.
  return t.trim() + houseRulesBlock();
}

/** The 19 stages (baselines only — rule #10) with their definitions. */
export const STAGES = [
  "Collaboration", "ReturningBrand", "RateNegotiation", "TimelinePush", "BriefReceived", "PaymentConfirmed", "DealAcceptance",
  "AffiliatePitch", "ContractReceived", "ConflictOfInterest", "GiftedProduct", "NicheMismatch", "HighValueDeal",
  "LongTermPartnership", "CoachingInquiry", "Questions", "Reply", "Editing", "Miscellaneous",
] as const;
export type Stage = (typeof STAGES)[number];

/** Stage definitions, taken from the old "Determine Stage" prompt (price lines there are stale). */
export function stageDefinitions(): string {
  const t = readCached(path.join(SPEC_DIR(), "reference", "old-reply-prompts", "030_Determine Stage.txt")) ?? "";
  const lines = t.split("\n").filter((l) => /^[A-Z][A-Za-z]+: /.test(l.trim()));
  return lines
    .map((l) => l.replace(/The minimum deal price is \$5500[^.]*\.[^.]*\./, "A deal counts as accepted only at $6,000+ for a dedicated video (or $2,500 per Short) in writing (rule #20)."))
    .map((l) => l.replace(/\(currently 2 month from today\)/, "(availability comes from the live pipeline — rule #31)"))
    .join("\n");
}

const STAGE_FILES: Record<string, string[]> = {
  Collaboration: ["033_Collaboration.txt"],
  ReturningBrand: ["100_ReturningBrand.txt"],
  RateNegotiation: ["110_RateNegotiation.txt"],
  TimelinePush: ["120_TimelinePush.txt"],
  BriefReceived: ["130_BriefReceived.txt"],
  PaymentConfirmed: ["140_PaymentConfirmed.txt"],
  DealAcceptance: ["150_DealAcceptance.txt"],
  AffiliatePitch: ["160_AffiliatePitch.txt"],
  ContractReceived: ["170_ContractReceived.txt"],
  ConflictOfInterest: ["180_ConflictOfInterest.txt"],
  GiftedProduct: ["190_GiftedProduct.txt"],
  NicheMismatch: ["200_NicheMismatch.txt"],
  HighValueDeal: ["210_HighValueDeal.txt"],
  LongTermPartnership: ["230_LongTermPartnership.txt"],
  CoachingInquiry: ["260_CoachingInquiry.txt"],
  Questions: ["034_Questions.txt"],
  Reply: ["035_Reply.txt"],
  Editing: ["032_Editing.txt"],
};

/**
 * The old per-stage reply guidance for `stage`, stripped of its output-format
 * rules (it asked for HTML; we write plain text) and of the {{template}} lines.
 * Used as a STRUCTURE reference only — the rulebook overrides it.
 */
export function oldStageGuidance(stage: string): string {
  const files = STAGE_FILES[stage] ?? [];
  const out: string[] = [];
  for (const f of files) {
    const t = readCached(path.join(SPEC_DIR(), "reference", "old-reply-prompts", f));
    if (!t) continue;
    const sys = t.split("=====USER=====")[0];
    const kept = sys.split("\n").filter((l) =>
      !/HTML|<p>|<br>|<ol>|<li>|<a href|Sign off exactly|Output ONLY|Do not escape|{{|Current date:|\$\s?\d|floor|minimum|calculate|months? from|booked (till|until)|dedicated videos per month|integration|Replace \[|placeholder|\[calculated/i.test(l),
    );
    out.push(kept.join("\n").replace(/\n{3,}/g, "\n\n").trim());
  }
  return out.join("\n\n");
}

/**
 * Jake's channel profile, for business context (the blind test's #1 failure
 * was missing context). Stripped of: every line with a $ amount (stale prices),
 * the paid-traffic caveat (#22/#35 — our own ads are never mentioned), the
 * lifetime demographics (stale — the live YouTube snapshot is used instead),
 * and the output-format / example sections meant for a research chat.
 */
export function channelContext(section: "draft" | "fit"): string {
  let v = "";
  try {
    const r = db.prepare(`SELECT value FROM deals_ai_config WHERE key = 'channel_context' ORDER BY updated_at DESC LIMIT 1`).get() as { value: string } | undefined;
    v = r?.value ?? "";
  } catch { /* table may not exist yet */ }
  if (!v) return "";
  const blocks = `\n${v}`.split(/\n={10,}\n/);
  const keep: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const title = blocks[i].trim();
    if (!/^[A-Z'’ —&()-]+$/.test(title)) continue;
    const body = blocks[i + 1] ?? "";
    if (/OUTPUT FORMAT|EXAMPLE RESPONSE|VOICE WHEN RESPONDING/.test(title)) continue;
    if (section === "draft" && /HOW TO ASSESS|RECOMMENDATION CATEGORIES/.test(title)) continue;
    let text = body;
    text = text.replace(/PAID TRAFFIC CAVEAT[\s\S]*?(?=\n[A-Z][A-Z ]+\n|$)/, "");
    text = text.replace(/DEMOGRAPHICS[\s\S]*?(?=\nTOP AUDIENCE PROBLEMS)/, "");
    text = text.split("\n").filter((l) => !/\$|paid ad|PAID|conversion/i.test(l)).join("\n");
    keep.push(`## ${title}\n${text.trim()}`);
  }
  return keep.join("\n\n").trim();
}
