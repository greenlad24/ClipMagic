/**
 * Deal Organizer — AI chat (port of chatAI.ts, streaming).
 *
 * Same regex intent router (modes A/B/C/D), same prompts, same Brave research
 * + 7-day cache, same FOLLOW-UP STATUS context. Model mapping: gpt-4o (modes A
 * and B) → Claude research tier; gpt-4o-mini (thread-intent override) → fast.
 *
 * STREAM CHUNKS are plain strings, exactly what the original wrote with
 * `stream.write(...)`: the frontend appends each one to the assistant bubble.
 * ⚠️ The Lab's Claude helper is not token-streaming, so modes A and B arrive as
 * ONE chunk holding the whole answer (plus a separate chunk for the Mode A
 * "research?" suffix), instead of many small deltas. Modes C and D send their
 * one status line, as before. The final result is `{ text, mode, companyName?,
 * searchTerm? }` as before.
 *
 * Bug-fix pass (SPEC §12 #8, #9, #19):
 *   - Follow-up stages are picked by stage KEY (a rename no longer breaks
 *     them) and an empty stage no longer matches every stage.
 *   - "Recent Emails" are the newest 500 by date (were the oldest 500 rows),
 *     and each follow-up deal's thread is read directly, not guessed from them.
 *   - Mode D's search term is cleaned: "pull up the Softr threads" → "Softr"
 *     (was "up the Softr").
 *   - Mode A's "Research X?" suffix works: a low-confidence pipeline question
 *     that names what looks like a company (a domain, or a capitalised name
 *     that isn't on the board) gets the suggestion.
 */
import { latestThreadForDeal } from "./matching.js";
import { z } from "zod";
import {
  deals as dealsTable, emails as emailsTable, deadlineProjects, stageConfig, aiConfig, companyResearchCache,
  type DealRecord, type EmailRecord, type DeadlineProjectRecord,
} from "./db.js";
import { loadStageConfig } from "./stageUtils.js";
import { ARCHIVED_FALSE, aiText, braveKey, parse, sleep, type Emit, type Turn } from "./common.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Channel identity (Mode B) ────────────────────────────────────────────────

const CHANNEL_CONTEXT = `==========================================
JAKE DAWSON — WHO HE IS
==========================================

PERSON
- Name: Jake Dawson
- Location/timezone: Asia/Bangkok (UTC+7)
- Email: jakedawsonbusiness@gmail.com
- Channel: YouTube — "Jake Dawson" (AI tutorials for solopreneurs)
- Subscribers: 55,300+ (May 2026)
- Videos published: 116
- Biggest hit: 1.4M views, "25 Things ChatGPT Could Do" (May 2025)

BUSINESS MODEL
- Primary revenue: Brand sponsorships on YouTube (sponsor revenue dominates)
- Sponsor floor: Minimum one sponsor pays $5,000 per video; average is 4-figure to low 5-figure
- Secondary revenue: Skool community (~$69/mo, ~69 paying members)
- Channel is healthy — pipeline strong, many incoming sponsor inquiries
- Brand alignment is the active business priority (May 2026)

==========================================
THE CHANNEL — POSITIONING & PROMISE
==========================================

ONE-LINE BRAND THESIS
"Most people use AI like a search engine. I show you how to use it like a system — so it actually scales your business instead of eating your time."

WHAT JAKE TEACHES
- AI tools for solopreneurs and small business owners
- "Learn how to actually USE any AI tool" — the Kevin Stratvert of AI
- Tutorial depth + AI-first focus; step-by-step, no jargon walls
- Tools demonstrated, not just described

JAKE'S UNIQUE EDGE
- Can explain complex topics simply, with humor
- Picks up new software fast (UX engineer background)
- Finds hacks/tricks that make hard things easy

==========================================
THE AUDIENCE — WHO WATCHES
==========================================

PRIMARY SPONSOR TARGET (vast majority)
- Solopreneurs and small business owners learning AI
- AI-curious to AI-trying, not yet operationalized
- Sees AI as a way to do more without hiring

SECONDARY: Agency owners
EDGE CASE: Marketing managers / corporate marketing staff (one sponsor only)
NOT A TARGET: Enterprise execs, big-company ops/IT/finance leaders, Fortune 500 decision-makers

DEMOGRAPHICS (YouTube Studio, lifetime, May 2026)
- Gender: 79% male / 21% female
- Age: 13-17 (0.2%), 18-24 (8.4%), 25-34 (24.1%), 35-44 (25.0% ← largest), 45-54 (20.8%), 55-64 (14.2%), 65+ (7.3%)
- Top countries: US 39.1%, UK 9.4%, Canada 6.7%, India 5.2%, Australia 3.9%
- Tier-1 English-speaking: 59.1% of audience

TOP AUDIENCE PROBLEMS (the things sponsors should solve)
1. Which AI tools actually save time/money
2. Translating AI hype into real business outcomes
3. Doing it themselves without hiring a team

==========================================
CONTENT FRAMEWORK
==========================================

VIDEO TYPES THAT WORK
- Tool tutorials ("How to use X")
- Listicles ("X Things Y Can Do — Exact Prompts")
- Tool reviews / deep dives (often sponsored)
- "I tested X for Y days" experiment videos

VIDEO TYPES JAKE WON'T DO
- "Make money online" / income claims
- Crypto / get-rich-quick
- Negative-emotion framing (no fear, no shame, no scarcity)
- Tools that require Jake to punch sideways at competitors

CONTENT RULES (non-negotiable)
1. Never take shots at competitors or other creators
2. Never talk down to the audience
3. Voice is "guy at the bar everyone wants to talk to" — approachable, slightly dry

==========================================
RECENT CHANNEL CHANGES (CRITICAL CONTEXT)
==========================================

THE PIVOT (May 2025 → present)
~12 months ago, after a viral 1.4M-view ChatGPT video, the channel rebranded:
- FROM: AI automation building (for small biz owners → Skool conversions)
- TO: AI tools tutorials (broader topic, 25-44 audience)

RESULT OF THE PIVOT
- Audience shifted younger/broader; Skool conversions dropped
- Sponsor-attractive audience grew
- Channel now optimizes for SPONSOR revenue, not Skool conversions
- Skool is a soft CTA only

PAID TRAFFIC CAVEAT
- A significant share of recent views come from PAID ADS, not organic
- High views ≠ organic resonance — factor this in
- Sponsor conversion data from any single video should not be taken as pure organic signal

==========================================
HOW TO ASSESS SPONSOR FIT — 4 AXES
==========================================

1. AUDIENCE OVERLAP
- High = their ICP is a solopreneur or small business owner
- Medium = adjacent (creators, freelancers, side-hustlers — overlaps but not exact)
- Low = enterprise-only, ops-leader-only, IT-only, or pure B2C consumer

2. SPONSOR BUDGET LIKELIHOOD
- Startup (pre-seed to Series A): Tight budgets, may push back on Jake's $5K+ floor
- Growth (Series B to D): Real budgets, often sponsor creators
- Established / public / late-stage: Best budgets, can pay premium
- Bootstrapped profitable: Mixed

3. PAST CREATOR SPONSOR ACTIVITY
- High signal: They've already sponsored AI / tech / productivity YouTubers in Jake's tier (50K-500K subs)
- Low signal: B2B enterprise content only, podcast-only, or no creator sponsorships at all

4. CHANNEL ANGLE FIT
- Is there a credible 10-minute video Jake could make about this tool?
- Can he demo it on screen in a way a solopreneur would care about?
- Will the demo land with the "guy at the bar" voice?
- If the demo requires Jake to credential himself as an enterprise buyer or IT manager — it's not a fit

==========================================
RECOMMENDATION TIERS
==========================================

✅ TAKE IT — All 4 axes are green. Direct ICP match, real budget, they've sponsored creators before, Jake can naturally demo it.
🟡 STRETCH BUT DOABLE — 2-3 axes green, 1-2 yellow. ICP is adjacent OR budget tight OR angle needs creativity. Worth taking if fee is in range AND they're flexible on angle.
❌ PASS — 2+ axes red. Enterprise-only ICP, no creator sponsor history, or the angle would force Jake off-brand.`;

const MODE_B_FORMAT = `REQUIRED OUTPUT FORMAT (use these exact emoji headers every time):

🏢 COMPANY SNAPSHOT
- What they do (1 sentence)
- Stage: Startup / Growth / Established / Public
- Employees: ~X (source)
- Funding: $Xm raised, last round [stage] in [year] / Bootstrapped / Public (source)
- Recent news: 1-2 bullets (last 6 months)

🎯 FIT WITH JAKE'S CHANNEL
- Audience overlap: High / Medium / Low + 1-sentence why
- Sponsor budget likelihood: High / Medium / Low based on company stage
- Existing YouTube sponsor activity: Yes (list 2-3 creators) / No / Unknown
- Angle that could work: 1 sentence

✅ MY TAKE
- Recommendation: ✅ Take it / 🟡 Stretch but doable / ❌ Pass
- Why: 2-3 sentences (honest, not flattering, not pessimistic)
- If taking it — one specific video idea as the pitch angle
- If passing — say why politely, don't sugarcoat

VOICE RULES
- Direct, short sentences. One idea per sentence.
- Cite sources for any specific number. If you can't confirm a fact, say "I couldn't confirm this" — never invent.
- No enterprise jargon ("synergy", "ecosystem", "value proposition").
- "Guy at the bar" tone — friendly but specific.`;

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseDelayMs = 3000): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      if ((status === 429 || msg.includes('429')) && attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ─── Brave Search helper ──────────────────────────────────────────────────────

interface BraveResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

async function braveSearch(query: string, count = 5): Promise<BraveResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  // Retry once on 429 (rate limit) with a 1.2s backoff
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': braveKey(),
      },
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }
    if (!res.ok) throw new Error(`Brave Search error ${res.status}`);
    const data = (await res.json()) as { web?: { results?: BraveResult[] } };
    return data.web?.results ?? [];
  }
  return [];
}

function formatBraveResults(label: string, results: BraveResult[]): string {
  if (!results.length) return `${label}: No results found.\n`;
  const lines = results.map((r, i) =>
    `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.description}${r.age ? ` (${r.age})` : ''}`
  );
  return `${label}:\n${lines.join('\n\n')}\n`;
}

// ─── Chat completion (was the OpenAI gpt-4o stream) ───────────────────────────

async function chatCompletion(
  systemPrompt: string,
  messages: Turn[],
  onChunk: (t: string) => void,
): Promise<string> {
  return withRetry(async () => {
    const fullText = await aiText('research', 'deals-chat', systemPrompt, messages, 2500); // the original's max_tokens
    if (fullText) onChunk(fullText);
    return fullText;
  });
}

// ─── Intent classifier (keyword/regex — zero API calls) ───────────────────────

/**
 * Strip the filler a regex capture drags in around the name ("up the Softr",
 * "all the threads with Notion", "Apify's") → "Softr", "Notion", "Apify".
 */
export function cleanSearchTerm(raw: string): string {
  const FILLER = new Set(['up', 'me', 'the', 'my', 'all', 'of', 'a', 'an', 'our', 'any', 'latest', 'recent', 'last',
    'thread', 'threads', 'email', 'emails', 'conversation', 'conversations', 'with', 'from', 'for', 'about', 'to', 'please', 'pls']);
  const words = raw.replace(/[“”"'`]/g, ' ').replace(/[.!?,;:]+$/g, '').trim().split(/\s+/).filter(Boolean);
  while (words.length && FILLER.has(words[0].toLowerCase())) words.shift();
  while (words.length && FILLER.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ').replace(/'s$/i, '').trim();
}

const NOT_A_COMPANY = new Set(['I', 'I\'m', 'Jake', 'AI', 'Gmail', 'YouTube', 'Slack', 'Skool', 'USD', 'Q1', 'Q2', 'Q3', 'Q4',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

/**
 * For the Mode A "Research X?" suffix: something in a low-confidence pipeline
 * question that looks like a company — a domain-like token, or a capitalised
 * name that is not the first word of the sentence.
 */
function companyMention(message: string): string | null {
  const domainRe = /\b[A-Za-z0-9][\w-]*\.(?:ai|io|co|com|app|xyz|net|org|so|dev|tools|tech|cloud|software|studio|design|agency|gg|fm|tv|pro|me|us|uk)\b/i;
  const d = message.match(domainRe);
  if (d) return d[0];
  const tokens = message.replace(/[.!?,;:()"]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i].replace(/'s$/i, '');
    if (/^[A-Z][A-Za-z0-9&-]{1,30}$/.test(t) && !NOT_A_COMPANY.has(t)) {
      const next = tokens[i + 1]?.replace(/'s$/i, '');
      return next && /^[A-Z][A-Za-z0-9&-]{1,30}$/.test(next) && !NOT_A_COMPANY.has(next) ? `${t} ${next}` : t;
    }
  }
  return null;
}

export function classifyIntent(message: string): {
  mode: 'A' | 'B' | 'C' | 'D';
  companyName: string | null;
  searchTerm: string | null;
  confidence: 'high' | 'low';
} {
  const clean = message.trim();
  const lower = clean.toLowerCase();

  // ── Mode D: compose reply to thread — checked FIRST (most specific) ─────────
  // Bare trigger words that always mean Mode D regardless of what follows
  const modeDTriggerWords = /^(?:thread|threads|email|emails)[.!?]*$/i;
  if (modeDTriggerWords.test(clean)) {
    return { mode: 'D', companyName: null, searchTerm: '', confidence: 'high' };
  }

  const modeDPatterns: Array<{ re: RegExp; cap: number }> = [
    // "bring in the apify thread" / "get me the venngage thread" — company BEFORE keyword
    { re: /bring in (?:the )?(.+?) (?:thread|threads|email|emails)[.!?]*$/i, cap: 1 },
    { re: /(?:get|fetch|load|pull(?: up)?|bring up|look up|find|open|show) (?:me )?(?:all )?(?:of )?(?:the |my )?(.+?) (?:thread|threads|email|emails)[.!?]*$/i, cap: 1 },
    // "thread [company]" / "threads [company]" / "email [company]" / "emails [company]"
    { re: /^(?:thread|threads|email|emails)\s+(?:with\s+|for\s+|from\s+|about\s+)?(.+?)(?:[.!?]|$)/i, cap: 1 },
    // bare "[company] thread/threads/email/emails" — e.g. "apify thread", "emilya emails"
    { re: /^(?:the )?(.+?) (?:thread|threads|email|emails)[.!?]*$/i, cap: 1 },
    // thread/email keyword anywhere with "with/for/about/from [company]"
    { re: /pull up (?:the )?(?:thread|threads|conversation|emails?) (?:with|for|about|from) (.+?)(?:[.!?]|$)/i, cap: 1 },
    { re: /show me (?:the )?(?:thread|threads|conversation|emails?) (?:with|for|about|from) (.+?)(?:[.!?]|$)/i, cap: 1 },
    { re: /open (?:the |my )?(?:thread|threads|conversation|emails?) (?:with|for|about|from) (.+?)(?:[.!?]|$)/i, cap: 1 },
    { re: /(?:compose|draft|write) (?:a )?reply to (.+?)(?:[.!?]|$)/i, cap: 1 },
    { re: /i (?:want|need) to reply to (.+?)(?:[.!?]|$)/i, cap: 1 },
    { re: /reply to (.+?)(?:[.!?]|$)/i, cap: 1 },
  ];
  for (const { re, cap } of modeDPatterns) {
    const m = clean.match(re);
    if (!m) continue;
    const searchTerm = cleanSearchTerm(m[cap] ?? '');
    if (searchTerm && searchTerm.length > 1) {
      return { mode: 'D', companyName: null, searchTerm, confidence: 'high' };
    }
  }

  // ── Mode C: bulk follow-up workflow — checked FIRST (takes priority) ────────
  const modeCKeywords = [
    'stale deal', 'gone quiet', 'bulk follow', 'who needs follow',
    "who hasn't replied", "who haven't replied", 'no response for',
    'generate follow-up', 'generate follow up', 'draft follow-up', 'draft follow up',
    'which companies need follow', 'which deals need follow', 'who needs to be followed',
    'show me stale', "who's stale", 'follow-up queue', 'follow up queue',
  ];
  if (
    modeCKeywords.some(k => lower.includes(k)) ||
    /who\s+(?:hasn'?t|haven'?t)\s+(?:replied|responded)/i.test(clean) ||
    /show\s+(?:me\s+)?(?:all\s+)?stale/i.test(clean) ||
    /\bstale\b.*\bdeals?\b/i.test(clean) ||
    /\bdeals?\b.*\bstale\b/i.test(clean)
  ) {
    return { mode: 'C', companyName: null, searchTerm: null, confidence: 'high' };
  }

  // Strong Mode A keywords → always Mode A
  const modeAWords = [
    'pipeline', 'deals', 'deadline', 'invoice', 'payment', 'follow up', 'follow-up',
    'in production', 'contract', 'negotiation', 'upcoming', 'overdue', 'script',
    'filming', 'active deal', 'stuck', 'at risk', 'total pipeline',
  ];
  if (modeAWords.some(k => lower.includes(k))) {
    return { mode: 'A', companyName: null, searchTerm: null, confidence: 'high' };
  }

  // Mode B patterns — most specific first
  const modeBPatterns: Array<{ re: RegExp; cap: number; ambiguous?: true }> = [
    // Explicit research commands
    { re: /^research\s+([^\s].+?)(?:\s+(?:for\s+me|online|please))?[.!?]*$/i, cap: 1 },
    // "Tell me about / tell me more about / what do you know about"
    { re: /^(?:tell\s+me\s+(?:more\s+)?about|what\s+(?:do\s+you\s+know\s+about|is|are))\s+(.+?)(?:[.!?]|$)/i, cap: 1 },
    // "thinking of signing with X" / "I'm thinking about X"
    { re: /(?:thinking\s+of|thinking\s+about)\s+(?:signing\s+with\s+)?(.+?)(?:\s*[-—].*)?(?:[.!?]|$)/i, cap: 1 },
    // "should I sign with / work with / take X"
    { re: /^should\s+I\s+(?:sign\s+with|work\s+with|take|partner\s+with)\s+(.+?)(?:[.!?]|$)/i, cap: 1 },
    // "is X worth it / a good sponsor / right for my channel"
    { re: /^is\s+(.+?)\s+(?:worth\s+it|a\s+good\s+sponsor|right\s+for\s+(?:my|the)\s+channel)(?:[.!?]|$)/i, cap: 1 },
    // "do you know X" / "do you know anything about X"
    { re: /^do\s+you\s+know\s+(?:anything\s+about\s+)?(.+?)(?:[.!?]|$)/i, cap: 1 },
    // Fit questions
    { re: /^(?:is|would|could)\s+(.+?)\s+(?:be\s+a?\s*)?(?:good\s+)?(?:sponsor(?:ship)?\s+)?fit/i, cap: 1 },
    { re: /^(.+?)\s+sponsor(?:ship)?\s+fit/i, cap: 1 },
    { re: /^(.+?)\s+(?:a\s+)?good\s+fit(?:\?|$)/i, cap: 1 },
    // "X — good fit?" or "X - worth it?"
    { re: /^(.+?)\s*[-—]\s*(?:good\s+fit|worth\s+it|good\s+sponsor)(?:\?|$)/i, cap: 1 },
    // Lookup / check commands (supports "look up X", "lookup X", "lookup on X")
    { re: /^(?:look\s*-?\s*up|lookup)(?:\s+on)?\s+(.+?)(?:[.!?]|$)/i, cap: 1 },
    { re: /^(?:check\s+out|find\s+out\s+about)\s+(.+?)(?:[.!?]|$)/i, cap: 1 },
    // Assess / evaluate
    { re: /^(?:assess|evaluate|analyze)\s+(.+?)(?:\s+(?:as|for)\s+.+?)?(?:[.!?]|$)/i, cap: 1 },
    { re: /^(.+?)\s+as\s+(?:a\s+)?(?:potential\s+)?sponsor/i, cap: 1 },
    // Ambiguous "what about X"
    { re: /^what\s+about\s+(.+?)[.!?]*$/i, cap: 1, ambiguous: true },
  ];

  const pipelineGuard = ['deal', 'email', 'emails', 'deadline', 'stage', 'invoice', 'payment', 'thread', 'threads'];

  for (const { re, cap, ambiguous } of modeBPatterns) {
    const m = clean.match(re);
    if (!m) continue;
    const companyName = m[cap]?.trim() ?? null;
    if (!companyName) continue;
    const words = companyName.toLowerCase().split(/\s+/);
    if (words.length > 6) continue;
    if (pipelineGuard.some(w => words.includes(w))) continue;
    return { mode: 'B', companyName, searchTerm: null, confidence: ambiguous ? 'low' : 'high' };
  }

  // ── Fallback: detect domain names or capitalized company names ────────────
  // If the message is short and contains something that looks like a company
  // (e.g. "Expertise.ai", "GoodTaco.io", "Notion"), trigger Mode B research.
  const words = clean.split(/\s+/);
  if (words.length <= 8) {
    // Check for domain-like tokens: word.ai, word.io, word.com, etc.
    const domainRe = /^[A-Za-z0-9][\w-]*\.(ai|io|co|com|app|xyz|net|org|so|dev|tools|tech|cloud|software|studio|design|agency|gg|fm|tv|pro|me|us|uk)$/i;
    const domainToken = words.find(w => domainRe.test(w));
    if (domainToken) {
      return { mode: 'B', companyName: domainToken, searchTerm: null, confidence: 'high' };
    }

    // Short message (1-3 words) that starts with a capitalized word → likely a company name
    // e.g. "Softr", "Apify", "Venngage", "Expertise AI"
    if (words.length <= 3 && /^[A-Z]/.test(clean) && !pipelineGuard.some(w => lower.includes(w))) {
      const candidate = clean.replace(/[.!?]+$/, '').trim();
      if (candidate.length >= 2 && candidate.length <= 40) {
        return { mode: 'B', companyName: candidate, searchTerm: null, confidence: 'low' };
      }
    }
  }

  return { mode: 'A', companyName: companyMention(clean), searchTerm: null, confidence: 'low' };
}

// ─── AI-powered thread intent classifier (fallback when regex misses) ─────────

async function aiClassifyThreadIntent(message: string): Promise<{ isReplyMode: boolean; keyword: string }> {
  try {
    const raw = await aiText(
      'fast', 'deals-classify',
      'You decide if a message is asking to open, view, search, or reply to email threads. Return only valid JSON.',
      [{
        role: 'user',
        content: `Is this message asking to view, search, pull up, or interact with email threads/emails? If yes, extract the search keyword (company or person name).

Message: "${message}"

Return JSON only, no other text: {"isReplyMode": true/false, "keyword": "name or empty string"}

Examples:
"Pull up all the threads with Softr" → {"isReplyMode": true, "keyword": "Softr"}
"Show me emails from Emilya" → {"isReplyMode": true, "keyword": "Emilya"}
"Get me the Notion thread" → {"isReplyMode": true, "keyword": "Notion"}
"thread" → {"isReplyMode": true, "keyword": ""}
"emails" → {"isReplyMode": true, "keyword": ""}
"What are my active deals?" → {"isReplyMode": false, "keyword": ""}
"Who needs a follow up?" → {"isReplyMode": false, "keyword": ""}
"Is Softr a good sponsor?" → {"isReplyMode": false, "keyword": ""}
"What's happening in the pipeline?" → {"isReplyMode": false, "keyword": ""}`,
      }],
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        isReplyMode: Boolean(parsed.isReplyMode),
        keyword: String(parsed.keyword ?? '').trim(),
      };
    }
  } catch { /* non-fatal — fall through to normal mode */ }
  return { isReplyMode: false, keyword: '' };
}

// ─── Follow-up stages (by stage KEY — bug 8) ──────────────────────────────────

const FOLLOW_UP_STAGE_KEYS = ['started_negotiation_no_answer', 'to_follow_up_with', 'new_requests', 'contract_negotiation'];

// ─── Follow-up analyser ───────────────────────────────────────────────────────

function buildFollowUpCtx(
  deals: DealRecord[],
  emails: EmailRecord[],
  todayDate: Date,
  followUpStageNames: Set<string>,
): string {
  // Exact stage match (bug 9: `s.includes(stage)` with an empty stage matched every deal).
  const followUpDeals = deals.filter(d => !!d.stage && followUpStageNames.has(d.stage));

  if (!followUpDeals.length) return 'No deals found in follow-up stages.';

  // Build threadId → most-recent-email map for fast O(1) lookup
  const threadLatest = new Map<string, (typeof emails)[0]>();
  for (const e of emails) {
    if (!e.threadId || !e.date) continue;
    const existing = threadLatest.get(e.threadId);
    if (!existing || new Date(e.dateIso ?? e.date) > new Date(existing.dateIso ?? existing.date ?? 0)) {
      threadLatest.set(e.threadId, e);
    }
  }

  const results = followUpDeals.map(deal => {
    const contactName = (deal.clientName ?? '').trim();
    const companyName = (deal.projectName ?? '').trim();

    // Display: company name is the primary identifier, contact is secondary
    const displayLabel = companyName
      ? `**${companyName}** (contact: ${contactName})`
      : `**${contactName}**`;
    const val = deal.estimatedValue ? ` | ${deal.estimatedValue.toLocaleString()}` : '';
    const header = `${displayLabel} [${deal.stage}${val}]`;

    // The deal's live thread = the shared matcher (matching.ts): the most recently active of ALL
    // its threads (source, manual links, contact closure) — was: source thread, then a fuzzy
    // name-word match over every email (which picked other deals' mail).
    const live = latestThreadForDeal(deal.id)?.threadId ?? deal.sourceThreadId;
    const last = live ? threadLatest.get(live) : undefined;

    if (!last?.date) {
      return { line: `• ${header} — ⚠️ NO EMAIL HISTORY FOUND`, needsFollowUp: true };
    }

    const daysSince = Math.floor(
      (todayDate.getTime() - new Date(last.date).getTime()) / 86_400_000
    );
    const dateStr = new Date(last.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const subj = last.subject ? ` | "${last.subject}"` : '';

    if (last.isFromMe) {
      const needsFollowUp = daysSince >= 3;
      const flag = needsFollowUp
        ? `⚠️ NO REPLY — ${daysSince} days silence`
        : `⏳ Waiting — Jake sent ${daysSince}d ago`;
      return { line: `• ${header} — ${flag} (sent ${dateStr})${subj}`, needsFollowUp };
    } else {
      return {
        line: `• ${header} — ✅ They replied ${daysSince}d ago (${dateStr})${subj} — Jake to respond`,
        needsFollowUp: false,
      };
    }
  });

  const needCount = results.filter(r => r.needsFollowUp).length;
  return [
    `## FOLLOW-UP STATUS — ${followUpDeals.length} deals in follow-up stages, **${needCount} need follow-up now** (3+ days no reply):`,
    ...results.map(r => r.line),
  ].join('\n');
}

// ─── Context builders ─────────────────────────────────────────────────────────

function buildDealsCtx(deals: DealRecord[]): string {
  return deals.map(d => {
    const parts = [
      `Client: ${d.clientName ?? 'Unknown'}`,
      d.projectName ? `Project: ${d.projectName}` : null,
      d.stage ? `Stage: ${d.stage}` : null,
      d.estimatedValue ? `Value: $${d.estimatedValue.toLocaleString()}` : null,
      d.deadline ? `Deadline: ${d.deadline}` : null,
      d.confidence ? `Confidence: ${d.confidence}` : null,
      d.inProduction ? 'In Production: Yes' : null,
      d.about ? `About: ${d.about.slice(0, 120)}` : null,
      d.nextSteps ? `Next: ${d.nextSteps.slice(0, 80)}` : null,
    ].filter(Boolean).join(' | ');
    return `• ${parts}`;
  }).join('\n');
}

function buildEmailsCtx(emails: EmailRecord[]): string {
  return [...emails]
    .sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime())
    .slice(0, 50)
    .map(e => {
      const dir = e.isFromMe ? '→ Sent' : '← From';
      return `• ${dir} ${e.fromName ?? e.fromEmail ?? 'Unknown'} | ${e.subject ?? '(no subject)'} | ${e.snippet?.slice(0, 100) ?? ''} | ${e.date ? new Date(e.date).toLocaleDateString() : ''}`;
    }).join('\n');
}

function buildDeadlinesCtx(deadlines: DeadlineProjectRecord[]): string {
  return deadlines.map(d => {
    const parts = [
      `Project: ${d.dealName ?? 'Unknown'}`,
      d.clientName ? `Client: ${d.clientName}` : null,
      d.deadline ? `Due: ${d.deadline}` : null,
      d.status ? `Status: ${d.status}` : null,
      d.completed ? 'Completed' : 'In Progress',
    ].filter(Boolean).join(' | ');
    return `• ${parts}`;
  }).join('\n');
}


// ─── Main (streaming) ─────────────────────────────────────────────────────────

export async function chatAI(raw: unknown, emit: Emit): Promise<{ text: string; mode?: 'A' | 'B' | 'C' | 'D'; companyName?: string; searchTerm?: string }> {
  const input = parse(z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })),
  }), raw);

  const lastMessage = input.messages.at(-1)?.content ?? '';
  const todayDate = new Date();
  const today = todayDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Step 1: Regex classify — zero API calls, instant
  let { mode, companyName, searchTerm, confidence } = classifyIntent(lastMessage);

  // Step 1b: AI fallback for email/thread keywords that regex missed
  const threadKeywords = ['email', 'emails', 'thread', 'threads'];
  const lower = lastMessage.toLowerCase();
  const hasThreadKeyword = threadKeywords.some(k => lower.includes(k));

  if (hasThreadKeyword && mode !== 'D') {
    const aiResult = await aiClassifyThreadIntent(lastMessage);
    if (aiResult.isReplyMode) {
      mode = 'D';
      searchTerm = cleanSearchTerm(aiResult.keyword);
    }
  }

  // ── MODE D: Compose reply — thread lookup happens in lookupThread
  if (mode === 'D') {
    const term = searchTerm ?? '';
    const msg = term
      ? `🔍 Looking up the thread with **${term}**…`
      : `🔍 Loading your recent threads…`;
    emit(msg);
    return { text: msg, mode: 'D' as const, searchTerm: term };
  }

  // ── MODE C: Bulk follow-up — heavy lifting in getFollowUpDrafts
  if (mode === 'C') {
    const msg = '📬 Scanning your Gmail threads for stale deals — loading drafts…';
    emit(msg);
    return { text: msg, mode: 'C' as const };
  }

  // Step 2: DB context
  const deals = dealsTable.where(`${ARCHIVED_FALSE} ORDER BY created_at, rowid LIMIT 2000`);
  // The NEWEST 500 emails (bug 19: were the first 500 rows ever inserted).
  const emails = emailsTable.where(`1 = 1 ORDER BY date_iso DESC, rowid DESC LIMIT 500`);
  const deadlines = deadlineProjects.all(200);
  const stages = stageConfig.all(100);

  const stageNames = stages
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(s => s.displayName ?? s.stageKey ?? '').filter(Boolean);

  // ── MODE A: Database query (1 AI call)
  if (mode === 'A') {
    const { toDB } = await loadStageConfig();
    const followUpStageNames = new Set(FOLLOW_UP_STAGE_KEYS.map(k => toDB[k]).filter(Boolean));
    // Every email of the follow-up deals' own threads, whatever their age, plus the recent ones.
    const fuThreads = [...new Set(deals.filter(d => d.stage && followUpStageNames.has(d.stage) && d.sourceThreadId).map(d => latestThreadForDeal(d.id)?.threadId ?? d.sourceThreadId!))];
    const threadMail: EmailRecord[] = [];
    for (let i = 0; i < fuThreads.length; i += 500) {
      const ids = fuThreads.slice(i, i + 500);
      threadMail.push(...emailsTable.where(`thread_id IN (${ids.map(() => '?').join(',')})`, ...ids));
    }
    const followUpCtx = buildFollowUpCtx(deals, [...emails, ...threadMail], todayDate, followUpStageNames);

    const systemPrompt = `You are a smart business assistant for a content creator managing their deal pipeline, emails, and production deadlines. Today is ${today}.

Answer accurately and concisely. Use bullet points and bold text where helpful. If data is missing, say so.

## Pipeline Stages (in order):
${stageNames.join(' → ')}

## Deals (${deals.length} active):
${buildDealsCtx(deals) || 'No deals found.'}

${followUpCtx}

## Recent Emails (last 50):
${buildEmailsCtx(emails) || 'No emails found.'}

## Deadline Projects (${deadlines.length} total):
${buildDeadlinesCtx(deadlines) || 'No deadline projects found.'}

INSTRUCTIONS FOR FOLLOW-UP QUESTIONS:
When the user asks which companies to follow up with, who hasn't replied, or anything about outreach priority — use the FOLLOW-UP STATUS section above. It has already computed, per deal, whether the last email was sent by Jake with no reply for 3+ days.
- The company/brand name is in bold (from projectName field). The contact person is shown in parentheses.
- Surface ⚠️ NO REPLY entries first, sorted by days of silence (longest first).
- For each, state the company/brand name clearly, the contact person, the deal stage, deal value, days since Jake's last email, and the email subject.
- For ⚠️ NO EMAIL HISTORY FOUND entries, list them separately at the end as "No email thread found — may need first outreach".`;

    let suffix = '';
    // Suggest research only for a name that isn't already a deal on the board.
    const onBoard = companyName && deals.some(d => `${d.clientName ?? ''} ${d.projectName ?? ''}`.toLowerCase().includes(companyName.toLowerCase()));
    if (confidence === 'low' && companyName && !onBoard) {
      suffix = `\n\n---\n💡 *Noticed you mentioned **${companyName}**. Want me to research them online? Ask: "Research ${companyName}"*`;
    }

    const text = await chatCompletion(systemPrompt, input.messages, (chunk) => emit(chunk));
    if (suffix) emit(suffix);
    return { text: text + suffix, mode: 'A' as const };
  }

  // ── MODE B: Company research (Brave Search → cache → Claude)
  const company = companyName!;

  let liveChannelContext = CHANNEL_CONTEXT;
  try {
    const configRecord = aiConfig.where("key = ? ORDER BY created_at, rowid LIMIT 1", 'channel_context')[0];
    if (configRecord?.value) liveChannelContext = configRecord.value;
  } catch { /* non-fatal — use hardcoded fallback */ }

  const companyDeals = deals.filter(d =>
    d.clientName?.toLowerCase().includes(company.toLowerCase()) ||
    d.clientEmail?.toLowerCase().includes(company.toLowerCase()) ||
    d.about?.toLowerCase().includes(company.toLowerCase())
  );
  const localDataCtx = companyDeals.length > 0
    ? `\nLOCAL DATABASE — Existing deals for ${company}:\n` +
      companyDeals.map(d =>
        `• ${d.projectName || 'Unknown project'} | Stage: ${d.stage} | Value: ${d.estimatedValue ? '$' + d.estimatedValue.toLocaleString() : 'Unknown'} | Confidence: ${d.confidence} | ${d.about?.slice(0, 200) ?? ''}`
      ).join('\n')
    : `\nNo existing deals in database for "${company}".`;

  // Check research cache (7 days)
  let cachedResearch: string | null = null;
  let cacheRecordId: string | null = null;
  try {
    const cached = companyResearchCache.where("company_name = ? ORDER BY created_at, rowid LIMIT 1", company)[0];
    if (cached?.cachedAt && cached.researchData &&
        Date.now() - new Date(cached.cachedAt).getTime() < SEVEN_DAYS_MS) {
      cachedResearch = cached.researchData;
      cacheRecordId = cached.id ?? null;
    }
  } catch { /* cache miss */ }

  let webResearchCtx = '';
  if (cachedResearch) {
    webResearchCtx = `CACHED WEB RESEARCH (last 7 days):\n${cachedResearch}`;
  } else {
    try {
      const companyCore = company.replace(/\.(ai|io|co|com|app|xyz|net|org)$/i, '').trim();

      // Sequential with delays — Brave Free plan rate-limits to 1 req/sec
      const delay = () => sleep(1100);
      const overviewResults = await braveSearch(`${company} company about what is`, 6);
      await delay();
      const sponsorResults = await braveSearch(`${company} youtube creator sponsor`, 5);
      await delay();
      const fundingResults = await braveSearch(`${companyCore} funding employees founded crunchbase`, 5);

      const totalHits = overviewResults.length + sponsorResults.length + fundingResults.length;
      let extraResults: BraveResult[] = [];
      if (totalHits <= 2 && companyCore !== company) {
        await delay();
        extraResults = await braveSearch(`${companyCore} startup software SaaS overview`, 5);
      }

      const overviewSection = formatBraveResults(`COMPANY OVERVIEW — ${company}`, [...overviewResults, ...extraResults]);
      const sponsorSection = formatBraveResults(`YOUTUBE SPONSORSHIP HISTORY — ${company}`, sponsorResults);
      const fundingSection = formatBraveResults(`FUNDING & COMPANY DETAILS — ${companyCore}`, fundingResults);
      webResearchCtx = `LIVE WEB RESEARCH:\n${overviewSection}\n${sponsorSection}\n${fundingSection}`;

      // Cache the raw research data (the original's "fire-and-forget": failures ignored)
      const researchToCache = `${overviewSection}\n${sponsorSection}\n${fundingSection}`;
      try {
        if (cacheRecordId) {
          companyResearchCache.update(cacheRecordId, { researchData: researchToCache, cachedAt: new Date().toISOString() });
        } else {
          companyResearchCache.insert({ companyName: company, researchData: researchToCache, cachedAt: new Date().toISOString() });
        }
      } catch { /* non-fatal */ }
    } catch {
      webResearchCtx = `WEB RESEARCH: Could not fetch live data for "${company}". Base your assessment on any information you already know about this company.`;
    }
  }

  const systemPrompt = `You are the AI assistant inside Jake Dawson's Deal Pipeline app. Today is ${today}.

When assessing a company's fit for Jake's channel, market position, or sponsor suitability, you research the company online and assess fit using the channel context below. Your assessments must be honest — not flattering, not pessimistic. Treat Jake as a smart operator who wants accurate signal, not validation.

${liveChannelContext}

Now assess whether "${company}" is a good fit as a sponsor for Jake's channel.

INSTRUCTIONS FOR FILLING THE SNAPSHOT:
1. Use the WEB RESEARCH results below as your PRIMARY source for company facts.
2. If the web research is sparse or empty (small/new company), use your OWN TRAINING KNOWLEDGE about this company — you may know about it even if the search didn't surface much. Write "(from training data)" when doing so.
3. Only write "I couldn't confirm this" for facts you genuinely have NO information about from either source.
4. Never fabricate specific numbers (funding amounts, employee counts, revenue). But do use qualitative inferences (e.g. "early-stage startup based on their product maturity") when you can reason from context.

${webResearchCtx}
${localDataCtx}

${MODE_B_FORMAT}`;

  const text = await chatCompletion(systemPrompt, input.messages, (chunk) => emit(chunk));

  return { text, mode: 'B' as const, companyName: company };
}
