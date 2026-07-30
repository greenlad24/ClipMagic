/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  SCOPED AI USAGE — "what did THIS piece of work cost?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * runAccounting.ts answers the same question for a render run, but it answers it
 * through a single module-level `activeRun` pointer and it only records while
 * that pointer is set. Anything outside the render pipeline — the Channel Audit,
 * most obviously — makes real, expensive Claude calls and books nothing. Every
 * audit ever run reports $0.00 for exactly that reason.
 *
 * The fix is not a second global pointer. Two audits can run at once (two tabs,
 * or a chat message arriving mid-run), and a global would attribute one run's
 * tokens to the other — a wrong number is worse than no number, because a wrong
 * number gets believed. So the scope rides on Node's async context: any block of
 * async work can open a scope, and EVERY Claude call made inside it — however
 * deep, however parallel — books into that scope and no other.
 *
 *     await withUsageScope(scope, async () => { ...the whole audit... });
 *
 * No call site changes. `callClaude` reports into whatever scope is active, the
 * same way it already reports into whatever run is active.
 *
 * COST IS NEVER GUESSED. Tokens are the provider's own counts from the response
 * `usage` block, priced against pricing.ts. A model with no rate entry is booked
 * at $0 and flagged `unpriced` — so "we don't know" can be told apart from
 * "it was free", which a bare 0 cannot.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ANTHROPIC_RATES, tokenCost, roundUsd } from "./pricing.js";
import type { CallPurpose } from "./runAccounting.js";

/** One priced API call. `label` is the purpose, so a bill decomposes by stage. */
export interface ScopedCall {
  label: string;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
  ms: number;
  /**
   * The model had no entry in ANTHROPIC_RATES. costUsd is 0 because the price is
   * UNKNOWN, not because the call was free — surfaced so a total can say so.
   */
  unpriced?: boolean;
}

export interface UsageScope {
  /** Every call booked so far. Seed it from storage to continue a paused run. */
  calls: ScopedCall[];
  /**
   * Fired after each call lands. A long run uses this to persist as it goes, so
   * a crash three stages in still leaves an honest partial bill behind.
   */
  onCall?: (call: ScopedCall, all: ScopedCall[]) => void;
}

const storage = new AsyncLocalStorage<UsageScope>();

/** Run `fn` with `scope` collecting every Claude call made inside it. */
export function withUsageScope<T>(scope: UsageScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/** The scope covering the current async context, if any. */
export function currentUsageScope(): UsageScope | undefined {
  return storage.getStore();
}

/**
 * Book one real Anthropic response into the active scope. Called by claude.ts
 * with the provider's own `usage` object. A no-op when nothing is scoped, which
 * is the common case (most of the app books through runAccounting instead).
 */
export function recordScopedUsage(args: {
  model: string;
  purpose: CallPurpose | undefined;
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  ms: number;
}): void {
  const scope = storage.getStore();
  if (!scope) return;

  const u = args.usage ?? {};
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const rate = ANTHROPIC_RATES[args.model];

  const call: ScopedCall = {
    label: args.purpose ?? "unlabelled",
    model: args.model,
    input,
    output,
    cacheWrite,
    cacheRead,
    costUsd: rate ? roundUsd(tokenCost(rate, input, output, cacheWrite, cacheRead)) : 0,
    ms: args.ms,
    ...(rate ? {} : { unpriced: true }),
  };

  scope.calls.push(call);
  scope.onCall?.(call, scope.calls);
}

/** Total dollars across a set of calls. */
export function totalCost(calls: ScopedCall[]): number {
  return roundUsd(calls.reduce((s, c) => s + c.costUsd, 0));
}

/** True when any call ran on a model with no published rate on file. */
export function hasUnpriced(calls: ScopedCall[]): boolean {
  return calls.some((c) => c.unpriced);
}

export interface CostByLabel {
  label: string;
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
  ms: number;
  /** Models seen under this label — usually one, but a fallback can add another. */
  models: string[];
  unpriced: boolean;
}

/**
 * Decompose a bill by purpose, dearest first. This is the shape worth showing a
 * human: "thumbnails cost $1.40, renames cost $2.10" answers what to cut, where
 * a single total only says whether to wince.
 */
export function costByLabel(calls: ScopedCall[]): CostByLabel[] {
  const by = new Map<string, CostByLabel>();
  for (const c of calls) {
    let row = by.get(c.label);
    if (!row) {
      row = {
        label: c.label,
        calls: 0,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        costUsd: 0,
        ms: 0,
        models: [],
        unpriced: false,
      };
      by.set(c.label, row);
    }
    row.calls += 1;
    row.input += c.input;
    row.output += c.output;
    row.cacheWrite += c.cacheWrite;
    row.cacheRead += c.cacheRead;
    row.costUsd += c.costUsd;
    row.ms += c.ms;
    if (!row.models.includes(c.model)) row.models.push(c.model);
    if (c.unpriced) row.unpriced = true;
  }
  return [...by.values()]
    .map((r) => ({ ...r, costUsd: roundUsd(r.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd);
}
