/**
 * AI News Stream — news collection.
 *
 * High-recall discovery (official company blogs, major publications and
 * newsletters, Google News topic feeds, Brave Search news) → cluster items
 * that cover the same event → score for the show's audience (people who use AI
 * tools, beginners to advanced) and tag each story with a category → surface
 * 30-50 stories with one-line summaries for manual selection.
 *
 * Streams progress as JSON strings `{ message, percent }`, one per stage.
 */
import { stories, sourceCache, todayDate } from './db.js';
import { callNewsModel } from './ai.js';
import { getBraveSearchApiKey, getNewsApiOrgKey, getGNewsApiKey, getDataForSeoCreds } from '../settings/postizSecrets.js';

interface RawItem {
  url: string;
  title: string;
  content: string;
  sourceName: string;
  sourceCompany?: string;
  isOfficialSource: boolean;
  type: 'blog' | 'article';
  publishedAt: string;
}

interface ClusterResult {
  headline: string;
  itemIndices: number[];
  anchorIndex: number;
  hasOfficialBlog: boolean;
  officialCompanies: string[];
  credibleOutlets: string[];
  majorOutletCount: number;
  operatorRelevance: number;
  category: StoryCategory;
  firstSeenAt: string;
}

/**
 * What KIND of story it is — separate from how well confirmed it is (status).
 * Jake's show wants a mix: model releases, tools, breakthroughs, robotics, and
 * the gossip and rumors people are talking about.
 */
export const STORY_CATEGORIES = [
  'Model release', 'AI tools & features', 'Breakthroughs & research',
  'Robotics', 'Drama & rumors', 'Business & policy',
] as const;
export type StoryCategory = typeof STORY_CATEGORIES[number];
const toCategory = (v: unknown): StoryCategory =>
  (STORY_CATEGORIES as readonly string[]).includes(v as string) ? v as StoryCategory : 'AI tools & features';

// ══════════════════════════════════════════════════════════════════════════════
//  STAGE 1 — HIGH-RECALL DISCOVERY  (target: ~700 raw items)
// ══════════════════════════════════════════════════════════════════════════════

// ── Official company newsroom RSS feeds ───────────────────────────────────────
const COMPANY_BLOGS = [
  { url: 'https://openai.com/blog/rss.xml',                   name: 'OpenAI Blog',       company: 'OpenAI' },
  { url: 'https://www.anthropic.com/feed',                    name: 'Anthropic Blog',    company: 'Anthropic' },
  { url: 'https://blog.google/technology/ai/rss/',            name: 'Google AI Blog',    company: 'Google AI' },
  { url: 'https://deepmind.google/blog/rss.xml',              name: 'DeepMind Blog',     company: 'Google DeepMind' },
  { url: 'https://ai.meta.com/blog/rss/',                     name: 'Meta AI Blog',      company: 'Meta AI' },
  { url: 'https://blogs.microsoft.com/ai/feed/',              name: 'Microsoft AI Blog', company: 'Microsoft AI' },
  { url: 'https://machinelearning.apple.com/rss.xml',         name: 'Apple ML Blog',     company: 'Apple' },
  { url: 'https://www.perplexity.ai/hub/rss',                 name: 'Perplexity Blog',   company: 'Perplexity' },
  { url: 'https://huggingface.co/blog/feed.xml',              name: 'Hugging Face Blog', company: 'Hugging Face' },
  { url: 'https://stability.ai/news/rss',                     name: 'Stability AI Blog', company: 'Stability AI' },
  { url: 'https://mistral.ai/feed',                           name: 'Mistral Blog',      company: 'Mistral' },
  { url: 'https://x.ai/feed',                                 name: 'xAI Blog',          company: 'xAI' },
  // Additional AI platform/tool company blogs
  { url: 'https://blog.adobe.com/en/topics/creativity/feed',  name: 'Adobe Blog',        company: 'Adobe' },
  { url: 'https://www.canva.com/designschool/feed/',           name: 'Canva Blog',        company: 'Canva' },
  { url: 'https://www.notion.so/blog/rss',                    name: 'Notion Blog',       company: 'Notion' },
  { url: 'https://zapier.com/blog/feed/',                     name: 'Zapier Blog',       company: 'Zapier' },
  { url: 'https://blog.replit.com/feed.xml',                  name: 'Replit Blog',        company: 'Replit' },
  { url: 'https://cursor.com/blog/rss.xml',                   name: 'Cursor Blog',       company: 'Cursor' },
  { url: 'https://vercel.com/blog/rss.xml',                   name: 'Vercel Blog',       company: 'Vercel' },
];

// ── Major publication + newsletter RSS feeds ──────────────────────────────────
const RSS_FEEDS = [
  // Tier 1 — major tech press
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch' },
  { url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', name: 'The Verge' },
  { url: 'https://venturebeat.com/category/ai/feed/', name: 'VentureBeat' },
  { url: 'https://www.wired.com/feed/category/artificial-intelligence/latest/rss', name: 'Wired' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica' },
  { url: 'https://feeds.reuters.com/reuters/technologyNews', name: 'Reuters' },
  { url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html', name: 'CNBC' },
  { url: 'http://feeds.bbci.co.uk/news/technology/rss.xml', name: 'BBC Technology' },
  { url: 'https://www.cnet.com/rss/news/', name: 'CNET' },
  { url: 'https://9to5mac.com/feed/', name: '9to5Mac' },
  { url: 'https://9to5google.com/feed/', name: '9to5Google' },
  { url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', name: 'MIT Technology Review' },
  // Tier 2 — AI/tech newsletters (discovery, not major-outlet credit)
  { url: 'https://tldr.tech/api/rss/ai', name: 'TLDR AI' },
  { url: 'https://bensbites.beehiiv.com/feed', name: "Ben's Bites" },
  { url: 'https://www.therundown.ai/rss', name: 'The Rundown AI' },
  { url: 'https://www.superhuman.ai/feed', name: 'Superhuman AI' },
  // Tier 3 — SaaS / marketing / creator / product
  { url: 'https://www.producthunt.com/feed', name: 'Product Hunt' },
  { url: 'https://blog.hubspot.com/marketing/rss.xml', name: 'HubSpot Marketing' },
  { url: 'https://searchengineland.com/feed', name: 'Search Engine Land' },
  { url: 'https://www.seoround.com/feed/', name: 'SEO Roundtable' },
  { url: 'https://www.socialmediatoday.com/feed', name: 'Social Media Today' },
];

// ── Brave Search News queries — 40 queries × 20 results = ~800 items ─────────
const BRAVE_SEARCH_QUERIES = [
  // ── Family 1: Major AI model/tool releases ──
  { q: 'OpenAI new release update feature',                     label: 'Brave — OpenAI releases' },
  { q: 'Anthropic Claude new release feature update',            label: 'Brave — Anthropic releases' },
  { q: 'Google Gemini AI new feature release update',            label: 'Brave — Google AI releases' },
  { q: 'xAI Grok new release update feature',                   label: 'Brave — xAI releases' },
  { q: 'Meta AI Llama new release model update',                label: 'Brave — Meta AI releases' },
  { q: 'Microsoft Copilot AI new feature update release',       label: 'Brave — Microsoft AI releases' },
  { q: 'Perplexity AI new feature update release',              label: 'Brave — Perplexity releases' },
  { q: 'Apple Intelligence AI update feature new',              label: 'Brave — Apple AI releases' },
  { q: 'Mistral AI new model release update',                   label: 'Brave — Mistral releases' },
  { q: 'AI new model release launch open source weights',       label: 'Brave — new AI models' },

  // ── Family 2: AI product updates for business users ──
  { q: 'AI tool launch product update small business',           label: 'Brave — AI biz tools' },
  { q: 'AI SaaS product launch feature update pricing',         label: 'Brave — AI SaaS' },
  { q: 'AI startup product launch demo beta',                   label: 'Brave — AI startup launches' },
  { q: 'ChatGPT new feature plugin update practical',           label: 'Brave — ChatGPT updates' },
  { q: 'Midjourney Runway Stable Diffusion AI image update',    label: 'Brave — AI image tools' },

  // ── Family 3: AI marketing / content / search ──
  { q: 'AI marketing tool SEO content creation new',            label: 'Brave — AI marketing' },
  { q: 'AI content writing tool copywriting update',            label: 'Brave — AI writing' },
  { q: 'AI search Google SGE Perplexity Genspark update',       label: 'Brave — AI search' },
  { q: 'AI social media tool scheduling content creation',      label: 'Brave — AI social media' },
  { q: 'AI email marketing tool automation personalization',    label: 'Brave — AI email marketing' },

  // ── Family 4: AI automation / agents / no-code / workflow ──
  { q: 'AI agent autonomous tool workflow automation new',       label: 'Brave — AI agents' },
  { q: 'no-code AI tool builder vibe coding app generator',     label: 'Brave — vibe coding' },
  { q: 'AI workflow automation Zapier Make n8n integration',     label: 'Brave — AI automation' },
  { q: 'AI coding assistant Cursor Copilot Replit update',      label: 'Brave — AI coding' },
  { q: 'AI chatbot builder customer support tool',              label: 'Brave — AI chatbots' },

  // ── Family 5: Creator / small business AI adoption ──
  { q: 'AI for freelancers consultants small business',          label: 'Brave — AI freelance' },
  { q: 'AI agency tool client work service delivery',            label: 'Brave — AI agencies' },
  { q: 'solopreneur AI tool workflow productivity',              label: 'Brave — solopreneur AI' },
  { q: 'AI video tool creator economy YouTube podcast',          label: 'Brave — AI video creators' },

  // ── Family 6: Pricing / access / API / integration changes ──
  { q: 'AI pricing change free tier API update access',          label: 'Brave — AI pricing' },
  { q: 'AI API update developer SDK integration new',           label: 'Brave — AI API updates' },
  { q: 'OpenAI API pricing ChatGPT Plus Pro update',            label: 'Brave — OpenAI pricing' },

  // ── Family 7: AI productivity / meeting / research / support ──
  { q: 'AI productivity tool meeting notes transcription',       label: 'Brave — AI productivity' },
  { q: 'AI research tool knowledge management assistant',        label: 'Brave — AI research' },
  { q: 'AI customer support tool helpdesk automation',           label: 'Brave — AI support' },
  { q: 'AI sales tool CRM automation outreach',                  label: 'Brave — AI sales' },

  // ── Family 8: Major platform changes ──
  { q: 'Adobe AI Firefly Canva AI Notion AI update feature',    label: 'Brave — creative AI' },
  { q: 'Shopify AI HubSpot AI platform update feature',         label: 'Brave — platform AI' },
  { q: 'Google Workspace AI Microsoft 365 AI update',           label: 'Brave — workspace AI' },

  // ── Family 9: Broader discovery — funding, partnerships, regulation ──
  { q: 'AI startup funding raise launch',                       label: 'Brave — AI funding' },
  { q: 'AI regulation policy update law practical impact',       label: 'Brave — AI regulation' },

  // ── Family 10: Frontier tech, robotics, and what people are talking about ──
  { q: 'DeepSeek Qwen open source AI model release',             label: 'Brave — open models' },
  { q: 'AI breakthrough research new capability',                label: 'Brave — AI breakthroughs' },
  { q: 'humanoid robot Figure Optimus Unitree Boston Dynamics',   label: 'Brave — humanoid robots' },
  { q: 'robotics AI robot launch self-driving',                   label: 'Brave — robotics' },
  { q: 'AI leak rumor reportedly OpenAI Anthropic Google',        label: 'Brave — AI rumors' },
  { q: 'AI lawsuit feud Sam Altman Elon Musk',                    label: 'Brave — AI drama' },
];

interface BraveNewsResult {
  title: string;
  url: string;
  description?: string;
  meta_url?: { netloc?: string; hostname?: string };
  source?: string;
  age?: string;
  page_fetched?: string;
  extra_snippets?: string[];
}

async function fetchBraveSearchNews(apiKey: string, prog: (msg: string, pct: number) => Promise<void>): Promise<RawItem[]> {
  const items: RawItem[] = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const BATCH = 8; // run 8 queries concurrently
  for (let b = 0; b < BRAVE_SEARCH_QUERIES.length; b += BATCH) {
    const batch = BRAVE_SEARCH_QUERIES.slice(b, b + BATCH);
    const results = await Promise.allSettled(batch.map(async (query) => {
      const params = new URLSearchParams({
        q: query.q,
        count: '20',
        freshness: 'pd',
        country: 'us',
        search_lang: 'en',
      });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(`https://api.search.brave.com/res/v1/news/search?${params}`, {
        signal: ctrl.signal,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });
      clearTimeout(t);
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: BraveNewsResult[] };
      const queryItems: RawItem[] = [];
      for (const r of data.results || []) {
        if (!r.title || !r.url) continue;
        const sourceName = r.source || r.meta_url?.netloc || r.meta_url?.hostname || 'Unknown';
        let publishedAt = new Date().toISOString();
        if (r.page_fetched) {
          const d = new Date(r.page_fetched);
          if (!isNaN(d.getTime())) {
            if (d.getTime() < cutoff) continue;
            publishedAt = d.toISOString();
          }
        }
        const content = (r.description || r.extra_snippets?.[0] || '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
        queryItems.push({
          url: r.url, title: r.title, content,
          sourceName, isOfficialSource: false,
          type: 'article', publishedAt,
        });
      }
      return queryItems;
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') items.push(...(r.value as RawItem[]));
    }
    if (b + BATCH < BRAVE_SEARCH_QUERIES.length) {
      await prog(`Brave Search: ${items.length} items from ${Math.min(b + BATCH, BRAVE_SEARCH_QUERIES.length)}/${BRAVE_SEARCH_QUERIES.length} queries…`, 33 + Math.round((b / BRAVE_SEARCH_QUERIES.length) * 7));
    }
  }
  return items;
}

/* ── Additional news providers ────────────────────────────────────────────────
   Every source runs TOGETHER and everything lands in the same pool, because
   overlap is the point: two outlets on one story is what moves it off Single
   Source, and the clustering stage is what turns duplicates into corroboration.
   Each provider is optional and independent — a missing key, an exhausted quota
   or a dead endpoint narrows discovery and never fails the run.

   ⚠️ GOOGLE DOES NOT PUBLISH A NEWS API. The feeds this app already reads are
   Google News RSS, which is free and unkeyed; the paid "Google News APIs" are
   resellers. GNews.io is one, and DataForSEO (already configured for the
   Keyword tool) serves the real Google News SERP. Both are wired here so the
   show gets whichever Jake has credit on.                                    */

/**
 * ⚠️ ONE QUERY LIST DOES NOT FIT THREE APIS, AND THE WRONG SHAPE FAILS SILENTLY
 * WITH A 200. Measured against the live keys on 2026-09-28:
 *
 *   • Brave takes the natural-language queries as written — 20 results each.
 *   • NewsAPI ANDs every word, so "OpenAI new release update feature 2025"
 *     matches almost nothing. Grouped with OR it returned 71 articles in ONE
 *     request, where forty narrow ones returned twenty apiece and spent forty
 *     of its hundred daily calls.
 *   • GNews returned 200 with an EMPTY article list for the same long query,
 *     and 10 articles for "OpenAI". It also 429s after roughly a request a
 *     second, so it gets a short list, spaced out.
 *
 * A provider that answers 200 and nothing is the failure this whole file keeps
 * running into: it looks like quiet news, not a broken query.
 */
const PROVIDER_QUERIES = BRAVE_SEARCH_QUERIES.map((q) => q.q);

/**
 * NewsAPI: the same eight families, OR-grouped. One request each, 100 articles
 * a page — eight calls a run out of a hundred a day, instead of forty.
 */
const NEWSAPI_QUERIES = [
  '(OpenAI OR Anthropic OR "Google Gemini" OR xAI OR Grok OR "Meta AI" OR Llama OR "Microsoft Copilot" OR Perplexity OR "Apple Intelligence" OR Mistral) AND (launch OR release OR update OR feature OR model)',
  '("AI tool" OR "AI SaaS" OR "AI startup" OR ChatGPT OR Midjourney OR Runway OR "Stable Diffusion") AND (launch OR release OR update OR pricing OR beta)',
  '("AI marketing" OR "AI content" OR "AI SEO" OR "AI writing" OR "AI search" OR "AI social media" OR "AI email") AND (tool OR update OR launch)',
  '("AI agent" OR "AI automation" OR "AI workflow" OR "no-code" OR "vibe coding" OR Zapier OR n8n OR Cursor OR Replit) AND (launch OR update OR release OR tool)',
  '("AI for freelancers" OR solopreneur OR "small business AI" OR "AI agency" OR "creator economy") AND (tool OR workflow OR AI)',
  '("AI pricing" OR "free tier" OR "AI API" OR "developer SDK") AND (AI AND (change OR update OR launch))',
  '("AI productivity" OR "meeting notes" OR "AI transcription" OR "AI research tool" OR "AI customer support" OR "AI sales") AND (tool OR launch OR update)',
  '(Adobe OR Canva OR Notion OR Shopify OR HubSpot OR "Google Workspace" OR "Microsoft 365") AND (AI AND (update OR feature OR launch))',
  '("humanoid robot" OR robotics OR "AI breakthrough" OR DeepSeek OR Qwen OR "open-source model" OR "AI lawsuit") AND (AI OR robot)',
];

/**
 * GNews: SHORT queries only, and few of them. The free tier is 100 requests a
 * day with a per-second cap, so this is a focused entity sweep rather than the
 * full forty — the breadth comes from Brave and NewsAPI.
 */
const GNEWS_QUERIES = [
  'OpenAI', 'Anthropic Claude', 'Google Gemini', 'Microsoft Copilot',
  'ChatGPT', 'AI agent', 'AI startup', 'Perplexity AI',
  'AI tool launch', 'Meta AI',
];

/** GNews 429s at roughly one request a second, so space them out. */
const GNEWS_SPACING_MS = 1500;

/** Fold a provider's raw rows into the pool, tolerating every shape of failure. */
function pushArticle(
  into: RawItem[],
  row: { url?: string; title?: string; content?: string; source?: string; publishedAt?: string },
  cutoff: number,
): void {
  if (!row.url || !row.title) return;
  let publishedAt = new Date().toISOString();
  if (row.publishedAt) {
    const d = new Date(row.publishedAt);
    if (!isNaN(d.getTime())) {
      if (d.getTime() < cutoff) return;
      publishedAt = d.toISOString();
    }
  }
  into.push({
    url: row.url,
    title: row.title,
    content: (row.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500),
    sourceName: row.source || (() => { try { return new URL(row.url!).hostname.replace(/^www\./, ''); } catch { return 'Unknown'; } })(),
    isOfficialSource: false,
    type: 'article',
    publishedAt,
  });
}

/** newsapi.org — one /everything search per query. */
async function fetchNewsApiOrg(apiKey: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const from = new Date(cutoff).toISOString().slice(0, 19);
  const BATCH = 4;
  for (let b = 0; b < NEWSAPI_QUERIES.length; b += BATCH) {
    const results = await Promise.allSettled(
      NEWSAPI_QUERIES.slice(b, b + BATCH).map(async (q) => {
        const params = new URLSearchParams({
          q, from, language: 'en', sortBy: 'publishedAt', pageSize: '100',
        });
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000);
        try {
          const res = await fetch(`https://newsapi.org/v2/everything?${params}`, {
            signal: ctrl.signal,
            headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
          });
          // 429 = the free plan's 100/day is spent. Stop asking; it will not
          // recover inside this run, and 40 more requests is 40 more seconds.
          if (res.status === 429) throw new Error('quota');
          if (!res.ok) return [];
          const data = (await res.json()) as { articles?: any[] };
          const out: RawItem[] = [];
          for (const a of data.articles || []) {
            pushArticle(out, {
              url: a?.url, title: a?.title,
              content: a?.description || a?.content,
              source: a?.source?.name, publishedAt: a?.publishedAt,
            }, cutoff);
          }
          return out;
        } finally {
          clearTimeout(t);
        }
      }),
    );
    if (results.some((r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason).includes('quota'))) break;
    for (const r of results) if (r.status === 'fulfilled') items.push(...r.value);
  }
  return items;
}

/** gnews.io — Google News results behind a key. */
async function fetchGNews(apiKey: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const from = new Date(cutoff).toISOString();

  // Sequential on purpose. Concurrency is what trips the per-second cap, and a
  // 429 here costs the rest of the day's quota, not just this request.
  for (const [i, q] of GNEWS_QUERIES.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, GNEWS_SPACING_MS));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const params = new URLSearchParams({ q, lang: 'en', max: '10', apikey: apiKey, from });
      const res = await fetch(`https://gnews.io/api/v4/search?${params}`, { signal: ctrl.signal });
      if (res.status === 429 || res.status === 403) break; // rate-limited or spent
      if (!res.ok) continue;
      const data = (await res.json()) as { articles?: any[] };
      for (const a of data.articles || []) {
        pushArticle(items, {
          url: a?.url, title: a?.title,
          content: a?.description || a?.content,
          source: a?.source?.name, publishedAt: a?.publishedAt,
        }, cutoff);
      }
    } catch {
      continue;
    } finally {
      clearTimeout(t);
    }
  }
  return items;
}

/**
 * DataForSEO's Google News SERP — no new key, it is already configured for the
 * Keyword tool.
 *
 * ⚠️ MEASURED 2026-09-28: the account answers 402 (balance −$0.01), so this
 * contributes nothing until it is topped up. That is why the FIRST 402 aborts
 * the whole stage rather than repeating it forty times — a dead provider must
 * cost one request, not one per query.
 */
async function fetchDataForSeoNews(creds: { login: string; password: string }): Promise<RawItem[]> {
  const items: RawItem[] = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const auth = 'Basic ' + Buffer.from(`${creds.login}:${creds.password}`).toString('base64');
  for (const q of PROVIDER_QUERIES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch('https://api.dataforseo.com/v3/serp/google/news/live/advanced', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keyword: q, location_code: 2840, language_code: 'en', depth: 20 }]),
      });
      if (res.status === 402 || res.status === 401) break; // out of credit / bad creds
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      for (const it of data?.tasks?.[0]?.result?.[0]?.items || []) {
        pushArticle(items, {
          url: it?.url, title: it?.title, content: it?.snippet,
          source: it?.domain, publishedAt: it?.timestamp,
        }, cutoff);
      }
    } catch {
      continue;
    } finally {
      clearTimeout(t);
    }
  }
  return items;
}

// ── Google News feeds — wide discovery ────────────────────────────────────────
const GOOGLE_NEWS_FEEDS = [
  // Company-specific
  { url: 'https://news.google.com/rss/search?q=%22OpenAI%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — OpenAI' },
  { url: 'https://news.google.com/rss/search?q=%22xAI%22+OR+%22Grok+AI%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — xAI' },
  { url: 'https://news.google.com/rss/search?q=%22Anthropic%22+OR+%22Claude+AI%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Anthropic' },
  { url: 'https://news.google.com/rss/search?q=%22Google+Gemini%22+OR+%22Google+DeepMind%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Google AI' },
  { url: 'https://news.google.com/rss/search?q=%22Microsoft+Copilot%22+OR+%22Microsoft+AI%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Microsoft AI' },
  { url: 'https://news.google.com/rss/search?q=%22Perplexity+AI%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Perplexity' },
  { url: 'https://news.google.com/rss/search?q=%22Apple+Intelligence%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Apple AI' },
  { url: 'https://news.google.com/rss/search?q=%22Meta+AI%22+OR+%22Llama+AI%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Meta AI' },
  // Topic-specific — broad discovery
  { url: 'https://news.google.com/rss/search?q=%22AI+tool%22+OR+%22AI+app%22+launch+OR+update&hl=en-US&gl=US&ceid=US:en', name: 'Google News — AI Tools' },
  { url: 'https://news.google.com/rss/search?q=%22AI+agent%22+OR+%22AI+automation%22+OR+%22AI+workflow%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — AI Automation' },
  { url: 'https://news.google.com/rss/search?q=%22AI+marketing%22+OR+%22AI+content%22+OR+%22AI+SEO%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — AI Marketing' },
  { url: 'https://news.google.com/rss/search?q=%22AI+startup%22+launch+OR+funding+OR+product&hl=en-US&gl=US&ceid=US:en', name: 'Google News — AI Startups' },
  { url: 'https://news.google.com/rss/search?q=%22no+code%22+AI+OR+%22vibe+coding%22+OR+%22AI+builder%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — No-Code AI' },
  { url: 'https://news.google.com/rss/search?q=%22AI+model%22+release+OR+%22large+language+model%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Model Releases' },
  { url: 'https://news.google.com/rss/search?q=%22AI+pricing%22+OR+%22AI+API%22+OR+%22ChatGPT+update%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — AI Pricing/API' },
  { url: 'https://news.google.com/rss/search?q=%22AI+productivity%22+OR+%22AI+assistant%22+OR+%22AI+meeting%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — AI Productivity' },
  // Frontier tech, robotics, and the talk of the industry
  { url: 'https://news.google.com/rss/search?q=DeepSeek+OR+Qwen+OR+%22open-source+AI+model%22&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Open Models' },
  { url: 'https://news.google.com/rss/search?q=%22AI+breakthrough%22+OR+%22DeepMind%22+research&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Breakthroughs' },
  { url: 'https://news.google.com/rss/search?q=%22humanoid+robot%22+OR+robotics+AI&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Robotics' },
  { url: 'https://news.google.com/rss/search?q=%22Figure+AI%22+OR+%22Tesla+Optimus%22+OR+%22Boston+Dynamics%22+OR+Unitree&hl=en-US&gl=US&ceid=US:en', name: 'Google News — Robot Makers' },
  { url: 'https://news.google.com/rss/search?q=%28OpenAI+OR+Anthropic+OR+Gemini+OR+xAI%29+%28leak+OR+rumor+OR+reportedly+OR+lawsuit%29&hl=en-US&gl=US&ceid=US:en', name: 'Google News — AI Drama' },
];

// ── Major outlets whitelist ───────────────────────────────────────────────────
const MAJOR_OUTLETS_LIST = [
  'TechCrunch', 'The Verge', 'Ars Technica', 'Wired', 'Reuters', 'VentureBeat',
  'Bloomberg', 'BBC', 'BBC Technology', 'CNET', 'CNBC', 'The Information',
  'The Guardian', 'Financial Times', 'WSJ', 'NYT', 'The New York Times',
  'Associated Press', 'AP', 'The Washington Post', 'Washington Post',
  'Axios', 'Engadget', 'ZDNET', 'Business Insider', 'Fortune',
  'MIT Technology Review', 'IEEE Spectrum', 'Semafor',
];
const MAJOR_OUTLETS = new Set(MAJOR_OUTLETS_LIST);
const MAJOR_OUTLETS_STR = MAJOR_OUTLETS_LIST.join(", ");

/**
 * ⚠️ ONE OUTLET, MANY SPELLINGS — and a status is only as good as this match.
 * Google News says "Bloomberg.com" or "The Wall Street Journal", Brave and the
 * keyed APIs hand over a bare domain, and the whitelist says "Bloomberg" and
 * "WSJ". Anything that doesn't fold to the whitelist spelling silently counts
 * as a minor outlet, and a story Reuters, Bloomberg and The Verge all ran is
 * marked unverified.
 */
const OUTLET_ALIASES: Record<string, string> = {
  'techcrunch.com': 'TechCrunch', 'theverge.com': 'The Verge', 'verge': 'The Verge',
  'arstechnica.com': 'Ars Technica', 'wired.com': 'Wired', 'reuters.com': 'Reuters',
  'venturebeat.com': 'VentureBeat', 'bloomberg.com': 'Bloomberg', 'bloomberg law': 'Bloomberg',
  'bbc.com': 'BBC', 'bbc.co.uk': 'BBC', 'bbc news': 'BBC', 'bbc technology': 'BBC',
  'cnet.com': 'CNET', 'cnbc.com': 'CNBC', 'theinformation.com': 'The Information',
  'theguardian.com': 'The Guardian', 'the guardian': 'The Guardian',
  'ft.com': 'Financial Times', 'wsj.com': 'WSJ', 'the wall street journal': 'WSJ', 'wall street journal': 'WSJ',
  'nytimes.com': 'The New York Times', 'new york times': 'The New York Times',
  'apnews.com': 'Associated Press', 'ap news': 'Associated Press', 'the associated press': 'Associated Press',
  'washingtonpost.com': 'The Washington Post', 'washington post': 'The Washington Post',
  'axios.com': 'Axios', 'engadget.com': 'Engadget', 'zdnet.com': 'ZDNET', 'zdnet': 'ZDNET',
  'businessinsider.com': 'Business Insider', 'fortune.com': 'Fortune',
  'technologyreview.com': 'MIT Technology Review', 'mit technology review': 'MIT Technology Review',
  'spectrum.ieee.org': 'IEEE Spectrum', 'ieee spectrum': 'IEEE Spectrum', 'semafor.com': 'Semafor',
};
const MAJOR_BY_LOWER = new Map(MAJOR_OUTLETS_LIST.map(o => [o.toLowerCase(), o]));
function normalizeOutlet(name: string): string {
  const raw = (name || '').trim();
  const key = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  return OUTLET_ALIASES[key] ?? MAJOR_BY_LOWER.get(key) ?? MAJOR_BY_LOWER.get(key.replace(/\.com$/, '')) ?? raw;
}

const decodeEntities = (t: string) => t
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// ── URL resolution for Google News ────────────────────────────────────────────
/**
 * ⚠️ FOLLOWING THE REDIRECT DOES NOT WORK AND NEVER REPORTS THAT IT DIDN'T.
 *
 * A `news.google.com/rss/articles/CBMi…` link used to 302 to the publisher.
 * It does not any more: Google answers 200 with a 583KB Angular app that
 * redirects in the browser, so `res.url` comes back still on news.google.com
 * and the item silently keeps its Google link. That is why the measured run
 * resolved 0 of 361 — not a handful of failures, every single one — while the
 * stage reported success and moved on.
 *
 * The real destination is behind Google's own RPC. Each article page carries
 * `data-n-a-id`, `data-n-a-ts` and `data-n-a-sg` (a signature), and posting
 * those to `batchexecute` returns the publisher URL. Verified live: an OpenAI
 * item resolved to the nbcnews.com article.
 *
 * TWO REQUESTS PER ITEM, so this stage is bounded by a DEADLINE rather than
 * left to run as long as it takes — a news show that is ten minutes late
 * because it was tidying links has failed at the thing it is for. Whatever has
 * not resolved when time runs out keeps its Google link, which is exactly what
 * every item had before.
 */
const GN_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function resolveGoogleNewsUrl(url: string, signal: AbortSignal): Promise<string> {
  if (!url.includes('news.google.com')) return url;
  try {
    const page = await fetch(url, { signal, headers: { 'User-Agent': GN_UA } });
    const body = await page.text();
    const id = body.match(/data-n-a-id="([^"]+)"/)?.[1];
    const ts = body.match(/data-n-a-ts="([^"]+)"/)?.[1];
    const sg = body.match(/data-n-a-sg="([^"]+)"/)?.[1];
    if (!id || !ts || !sg) return url;

    const inner = JSON.stringify([
      'garturlreq',
      [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
        'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      id,
      Number(ts),
      sg,
    ]);
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': GN_UA,
      },
      body: 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]])),
    });
    const text = await res.text();
    // The response is Google's length-prefixed JSON stream; the publisher URL
    // is the one absolute link in it that is not another Google host.
    const found = text.match(/https?:\/\/(?!news\.google\.com)[^"\\\s]+/)?.[0];
    return found ? found.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&') : url;
  } catch {
    return url;
  }
}

/** How long the whole resolution stage may take before it gives up the rest. */
const GN_RESOLVE_BUDGET_MS = 90_000;

async function resolveGoogleNewsUrls(items: RawItem[]): Promise<RawItem[]> {
  const CONCURRENT = 12;
  const resolved = [...items];
  const deadline = Date.now() + GN_RESOLVE_BUDGET_MS;

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= resolved.length) return;
      if (Date.now() > deadline) return; // out of time — the rest keep their links
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const url = await resolveGoogleNewsUrl(resolved[i].url, ctrl.signal);
        resolved[i] = { ...resolved[i], url };
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENT, resolved.length) }, worker));
  return resolved;
}

// ── RSS parser ────────────────────────────────────────────────────────────────
function parseRSSItems(xml: string, sourceName: string, isOfficialSource = false, sourceCompany?: string): RawItem[] {
  const items: RawItem[] = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const c = match[1];
    const getField = (tag: string) => {
      const cd = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(c)?.[1];
      const plain = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`).exec(c)?.[1];
      return (cd || plain || '').trim();
    };
    let title = getField('title');
    const link = (/<link>([^<]+)<\/link>/.exec(c))?.[1]?.trim() || getField('link');
    // ⚠️ A Google News item is NOT from "Google News — OpenAI". Its real
    // publisher is in <source>, and the title ends " - <publisher>". Crediting
    // the feed instead made every outlet the same non-outlet, so no story could
    // ever count a second major outlet: Claude Sonnet 5.5's launch came out
    // "Unconfirmed" with a dozen sources behind it.
    let itemSource = sourceName;
    const publisher = /<source[^>]*>([^<]+)<\/source>/.exec(c)?.[1];
    if (publisher && sourceName.startsWith('Google News')) {
      const pub = decodeEntities(publisher.trim());
      itemSource = normalizeOutlet(pub);
      if (title.endsWith(` - ${pub}`)) title = title.slice(0, -(pub.length + 3));
    }
    const pubDate = getField('pubDate');
    const desc = getField('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
    if (!title || !link) continue;
    const pub = pubDate ? new Date(pubDate) : new Date();
    if (pub.getTime() < cutoff) continue;
    items.push({
      url: link, title, content: desc, sourceName: itemSource,
      sourceCompany, isOfficialSource,
      type: isOfficialSource ? 'blog' : 'article',
      publishedAt: pub.toISOString(),
    });
  }
  return items;
}

async function fetchRSSFeed(feed: { url: string; name: string }, isOfficialSource = false, sourceCompany?: string): Promise<RawItem[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(feed.url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' } });
    clearTimeout(t);
    if (!res.ok) return [];
    return parseRSSItems(await res.text(), feed.name, isOfficialSource, sourceCompany);
  } catch { return []; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  STAGE 2+3 — CLUSTERING & AUDIENCE-AWARE SCORING (batched, high-recall)
// ══════════════════════════════════════════════════════════════════════════════

// Process items in batches through LLM clustering, then merge
async function clusterBatch(items: RawItem[], globalOffset: number): Promise<ClusterResult[]> {
  if (!items.length) return [];

  const prompt = `You are clustering AI news items for a daily AI news show. The audience: everyday people who use AI tools, from beginners taking their first steps with ChatGPT, Claude and Gemini to people making images, video and apps with AI. They watch to hear what is new, what they can try, and what everyone in AI and robotics is talking about.

YOUR JOB: Group items covering the SAME event into clusters. Produce as MANY distinct clusters as the data supports. Do NOT over-merge — two different product launches are TWO clusters even if from the same company.

KEEP almost everything. Only discard (→ ignoredIndices) if an item is:
- Not news: how-to guides, listicles ("The 5 best..."), marketing or SEO advice, product roundups, sponsored posts
- A software package or library version release (PyPI, npm, GitHub release notes)
- Pure stock/earnings/valuation with no product, technology or people angle
- Not about AI or robotics, duplicate spam, or broken content

For each cluster assign audienceInterest 1-10 — how much THIS audience would want it on the show:
- 9-10: Major model releases or upgrades from the big labs (OpenAI, Anthropic, Google, Meta, xAI, DeepSeek, Mistral, Qwen...); big new features in ChatGPT, Claude, Gemini or Copilot; jaw-dropping demos everyone will share
- 7-8: Notable new AI tools, apps and features people can try; real technical breakthroughs; robotics milestones (humanoids, home robots, self-driving); the industry drama and rumors people are talking about (leaks, rumored launches, feuds, lawsuits, big hires and departures)
- 5-6: Useful context: platform or policy changes that affect users, pricing changes, big partnerships with a product angle, notable research
- 3-4: Tangential: enterprise deals, funding rounds with no product, regulation with no near-term effect
- 1-2: No reason for this audience to care

Rumors and gossip are welcome when people are genuinely talking about them: score them on interest, not on how confirmed they are — confirmation is tracked separately.

For each cluster also assign exactly ONE category:
${STORY_CATEGORIES.map(c => `"${c}"`).join(' | ')}

CLUSTERING RULES:
1. Cluster by SPECIFIC EVENT — "Anthropic Ships Claude 4.5" not "Anthropic news"
2. Size-1 clusters are perfectly fine — a unique story is still a story
3. Headlines: Title Case, factual, under 12 words, no clickbait. A rumor or leak says so ("Reportedly", "Rumored", "Leak Suggests")
4. anchorIndex: prefer [OFFICIAL_BLOG] items, then major outlets (${MAJOR_OUTLETS_STR}), then any
5. TARGET: produce ALL distinct story clusters the data supports — do NOT cap at a low number

Respond ONLY with valid JSON (no markdown fences):
{"clusters":[{"headline":"...","itemIndices":[0,1],"anchorIndex":0,"audienceInterest":8,"category":"Model release"}],"ignoredIndices":[3,5]}

Items:
${items.map((it, i) => `${i}: ${it.isOfficialSource ? '[OFFICIAL_BLOG]' : '[SOURCE]'} ${it.sourceName}${it.sourceCompany ? ` (${it.sourceCompany})` : ''} | ${it.title.slice(0, 120)} | ${it.publishedAt}`).join('\n')}`;

  try {
    const t = await callNewsModel(prompt, 'news-cluster');
    const json = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
    const result: { clusters: any[]; ignoredIndices: number[] } = JSON.parse(json);
    const inRange = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < items.length;
    return (result.clusters || [])
      .map((c: any) => ({ ...c, itemIndices: Array.isArray(c.itemIndices) ? c.itemIndices.filter(inRange) : [] }))
      .filter((c: any) => c.itemIndices.length > 0)
      .map((c: any) => {
        const interest = c.audienceInterest ?? c.operatorRelevance;
        return {
          headline: c.headline || 'Untitled Story',
          // Remap local indices to global indices
          itemIndices: (c.itemIndices as number[]).map(i => i + globalOffset),
          anchorIndex: (inRange(c.anchorIndex) ? c.anchorIndex : c.itemIndices[0]) + globalOffset,
          // Outlets, official blogs and dates are counted from the items
          // themselves in deriveFacts() — never taken from the model.
          hasOfficialBlog: false, officialCompanies: [], credibleOutlets: [], majorOutletCount: 0,
          operatorRelevance: typeof interest === 'number' ? Math.max(1, Math.min(interest, 10)) : 5,
          category: toCategory(c.category),
          firstSeenAt: new Date().toISOString(),
        };
      });
  } catch {
    // Fallback: each item is its own cluster
    return items.slice(0, 30).map((it, i) => ({
      headline: it.title.slice(0, 80),
      itemIndices: [i + globalOffset], anchorIndex: i + globalOffset,
      hasOfficialBlog: it.isOfficialSource,
      officialCompanies: it.sourceCompany ? [it.sourceCompany] : [],
      credibleOutlets: [], majorOutletCount: 0, operatorRelevance: 5,
      category: 'AI tools & features' as StoryCategory,
      firstSeenAt: it.publishedAt,
    }));
  }
}

// Merge clusters from different batches that cover the same story
async function mergeDuplicateClusters(clusters: ClusterResult[]): Promise<ClusterResult[]> {
  if (clusters.length <= 60) return clusters; // small enough, no merge needed

  // Ask LLM to identify duplicate headlines
  const headlines = clusters.map((c, i) => `${i}: ${c.headline}`).join('\n');
  const prompt = `These are AI news cluster headlines. Some may be about the SAME event/story phrased differently.

Return a JSON array of merge groups. Each group is an array of indices that should be merged into one cluster. Only include groups of 2+ indices. Leave unique stories out of the output.

IMPORTANT: Only merge if they are truly the SAME specific event. "OpenAI releases GPT-5" and "OpenAI pricing update" are DIFFERENT stories — do NOT merge them.

Return ONLY valid JSON: [[0,5],[2,8,12]]
If no duplicates, return: []

Headlines:
${headlines}`;

  try {
    const t = await callNewsModel(prompt, 'news-cluster');
    const mergeGroups: number[][] = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
    if (!Array.isArray(mergeGroups) || mergeGroups.length === 0) return clusters;

    const merged = new Set<number>();
    const result: ClusterResult[] = [];

    for (const group of mergeGroups) {
      if (!Array.isArray(group) || group.length < 2) continue;
      const valid = group.filter(i => i >= 0 && i < clusters.length && !merged.has(i));
      if (valid.length < 2) continue;

      // Merge: pick best headline (highest operatorRelevance), combine indices
      const sorted = valid.map(i => clusters[i]).sort((a, b) => b.operatorRelevance - a.operatorRelevance);
      const primary = sorted[0];
      const mergedCluster: ClusterResult = {
        ...primary,
        itemIndices: [...new Set(sorted.flatMap(c => c.itemIndices))],
        credibleOutlets: [...new Set(sorted.flatMap(c => c.credibleOutlets))],
        officialCompanies: [...new Set(sorted.flatMap(c => c.officialCompanies))],
        hasOfficialBlog: sorted.some(c => c.hasOfficialBlog),
        majorOutletCount: new Set(sorted.flatMap(c => c.credibleOutlets)).size,
        operatorRelevance: Math.max(...sorted.map(c => c.operatorRelevance)),
        firstSeenAt: sorted.reduce((earliest, c) =>
          new Date(c.firstSeenAt) < new Date(earliest) ? c.firstSeenAt : earliest, sorted[0].firstSeenAt),
      };
      result.push(mergedCluster);
      valid.forEach(i => merged.add(i));
    }

    // Add all non-merged clusters
    clusters.forEach((c, i) => { if (!merged.has(i)) result.push(c); });
    return result;
  } catch {
    return clusters; // merge failed, keep all
  }
}

/**
 * Count a story's outlets, official blogs and first appearance from its ITEMS.
 * The model used to report these itself and got them wrong in both directions
 * (it cannot see which outlets exist beyond the names in the prompt); the
 * items know exactly who published them.
 */
function deriveFacts(c: ClusterResult, items: RawItem[]): ClusterResult {
  const members = c.itemIndices.map(i => items[i]).filter(Boolean);
  const official = members.filter(m => m.isOfficialSource);
  const outlets = [...new Set(members.filter(m => !m.isOfficialSource).map(m => m.sourceName).filter(n => MAJOR_OUTLETS.has(n)))];
  const times = members.map(m => new Date(m.publishedAt).getTime()).filter(t => !isNaN(t));
  return {
    ...c,
    hasOfficialBlog: official.length > 0,
    officialCompanies: [...new Set(official.map(m => m.sourceCompany || m.sourceName))],
    credibleOutlets: outlets,
    majorOutletCount: outlets.length,
    firstSeenAt: times.length ? new Date(Math.min(...times)).toISOString() : c.firstSeenAt,
  };
}

function computeStatus(c: ClusterResult): 'Verified' | 'Likely' | 'Unconfirmed' | 'Single Source' {
  if (c.itemIndices.length === 1) return 'Single Source';
  if (c.majorOutletCount >= 3) return 'Verified';
  if (c.majorOutletCount >= 2 || (c.majorOutletCount >= 1 && c.hasOfficialBlog)) return 'Likely';
  return 'Unconfirmed';
}

function computeScore(c: ClusterResult, status: string): number {
  // Operator relevance is PRIMARY (0-30 from 1-10 scale)
  const relevanceBonus = c.operatorRelevance * 3;
  // Coverage credibility (secondary)
  const statusBonus = status === 'Verified' ? 4 : status === 'Likely' ? 2 : status === 'Unconfirmed' ? 0.5 : 0;
  const outletBonus = Math.min(c.majorOutletCount * 1.5, 6);
  const sourceBonus = Math.min(c.itemIndices.length, 3);
  const officialBonus = c.hasOfficialBlog ? 3 : 0;
  // Recency
  const hoursSince = (Date.now() - new Date(c.firstSeenAt).getTime()) / 3600000;
  const recencyPenalty = Math.min(hoursSince * 0.2, 5);
  // Penalize very-low-relevance stories
  const lowRelevancePenalty = c.operatorRelevance <= 2 ? 15 : 0;
  return Math.round((relevanceBonus + statusBonus + outletBonus + sourceBonus + officialBonus - recencyPenalty - lowRelevancePenalty) * 10) / 10;
}

// ══════════════════════════════════════════════════════════════════════════════
//  STAGE 4 — SUMMARIES
// ══════════════════════════════════════════════════════════════════════════════

async function generateSummaries(clusters: ClusterResult[], items: RawItem[]): Promise<string[]> {
  const BATCH = 20;
  const summaries: string[] = new Array(clusters.length).fill('');
  for (let i = 0; i < clusters.length; i += BATCH) {
    const batch = clusters.slice(i, i + BATCH);
    const prompt = `Write a 1-sentence summary (max 20 words) for each AI news story. Written for everyday people who use AI tools — what happened and why it matters to them. Be specific, plain English, no clickbait.
Return ONLY a JSON array: ["summary 1", "summary 2", ...]

Stories:
${batch.map((c, j) => {
  const anchor = items[c.anchorIndex] || items[c.itemIndices[0]];
  return `${j}: "${c.headline}" — ${anchor?.content.slice(0, 200) || ''}`;
}).join('\n')}`;
    try {
      const t = await callNewsModel(prompt, 'news-summary', 'fast');
      const arr: string[] = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
      batch.forEach((_, j) => { summaries[i + j] = arr[j] || batch[j].headline; });
    } catch {
      batch.forEach((c, j) => { summaries[i + j] = c.headline; });
    }
  }
  return summaries;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN ENDPOINT
// ══════════════════════════════════════════════════════════════════════════════

export async function collectNews(
  write: (chunk: string) => void | Promise<void>,
): Promise<{ success: boolean; storiesFound: number; message: string }> {
    // Read from the lab's own settings store, not the environment: Jake adds
    // keys on the Settings page, and a key that only works from .env is a key
    // that looks saved and does nothing.
    const braveApiKey = getBraveSearchApiKey();
    const prog = async (msg: string, pct: number) => { await write(JSON.stringify({ message: msg, percent: pct })); };

    await prog('Stage 1: High-recall discovery — targeting ~700 raw items…', 2);

    // ── 1a. Official company blog posts ────────────────────────────────
    await prog(`Fetching ${COMPANY_BLOGS.length} official company newsrooms…`, 4);
    const blogResults = await Promise.allSettled(
      COMPANY_BLOGS.map(b => fetchRSSFeed({ url: b.url, name: b.name }, true, b.company))
    );
    const blogItems = blogResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const successBlogs = blogResults.filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<RawItem[]>).value.length > 0).length;
    await prog(`${blogItems.length} blog posts from ${successBlogs}/${COMPANY_BLOGS.length} newsrooms. Fetching publications…`, 10);

    // ── 1b. Major publications + newsletters + SaaS press ─────────────
    const pubResults = await Promise.allSettled(RSS_FEEDS.map(f => fetchRSSFeed(f)));
    const pubItems = pubResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const successPubs = pubResults.filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<RawItem[]>).value.length > 0).length;
    await prog(`${pubItems.length} articles from ${successPubs}/${RSS_FEEDS.length} publications. Fetching Google News…`, 18);

    // ── 1c. Google News — wide topical discovery ──────────────────────
    const gnResults = await Promise.allSettled(GOOGLE_NEWS_FEEDS.map(f => fetchRSSFeed(f)));
    const gnItems = gnResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const gnSuccess = gnResults.filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<RawItem[]>).value.length > 0).length;
    await prog(`${gnItems.length} items from ${gnSuccess}/${GOOGLE_NEWS_FEEDS.length} Google News feeds. Resolving URLs…`, 24);

    const resolvedGnItems = await resolveGoogleNewsUrls(gnItems);
    const resolvedCount = resolvedGnItems.filter((it, i) => it.url !== gnItems[i].url).length;

    // ── 1d. Brave Search — primary wide discovery engine ──────────────
    let braveItems: RawItem[] = [];
    // ── 1d. Keyed providers — all of them, in parallel ────────────────
    // Additive by design: the goal is as many outlets as possible on each
    // story, and overlap between providers is what earns a story its second
    // and third source. Any provider without a key is simply absent.
    const newsApiKey = getNewsApiOrgKey();
    const gnewsKey = getGNewsApiKey();
    const dfsCreds = getDataForSeoCreds();

    const enabled = [
      braveApiKey && 'Brave',
      newsApiKey && 'NewsAPI',
      gnewsKey && 'GNews',
      dfsCreds && 'DataForSEO',
    ].filter(Boolean) as string[];

    await prog(
      enabled.length
        ? `${resolvedCount} GN URLs resolved. Querying ${enabled.join(' · ')}…`
        : `${resolvedCount} GN URLs resolved. ⚠ No search-provider keys set — discovery is RSS + Google News only. Deduplicating…`,
      28,
    );

    const [braveRes, newsApiRes, gnewsRes, dfsRes] = await Promise.allSettled([
      braveApiKey ? fetchBraveSearchNews(braveApiKey, prog) : Promise.resolve([]),
      newsApiKey ? fetchNewsApiOrg(newsApiKey) : Promise.resolve([]),
      gnewsKey ? fetchGNews(gnewsKey) : Promise.resolve([]),
      dfsCreds ? fetchDataForSeoNews(dfsCreds) : Promise.resolve([]),
    ]);
    const took = (r: PromiseSettledResult<RawItem[]>): RawItem[] => (r.status === 'fulfilled' ? r.value : []);
    braveItems = took(braveRes);
    const newsApiItems = took(newsApiRes);
    const gnewsItems = took(gnewsRes);
    const dfsItems = took(dfsRes);

    if (enabled.length) {
      const counts = [
        braveApiKey ? `Brave ${braveItems.length}` : null,
        newsApiKey ? `NewsAPI ${newsApiItems.length}` : null,
        gnewsKey ? `GNews ${gnewsItems.length}` : null,
        dfsCreds ? `DataForSEO ${dfsItems.length}` : null,
      ].filter(Boolean).join(' · ');
      await prog(`${counts}. Deduplicating…`, 42);
    }

    const allRawItems = [
      ...blogItems, ...pubItems, ...resolvedGnItems,
      ...braveItems, ...newsApiItems, ...gnewsItems, ...dfsItems,
    ].map(it => it.isOfficialSource ? it : { ...it, sourceName: normalizeOutlet(it.sourceName) });
    await prog(`Stage 1 complete: ${allRawItems.length} total raw items discovered.`, 44);

    // ── Stage 2: Deduplicate by URL ───────────────────────────────────
    const today = todayDate();
    // Skip only what an EARLIER show day already saw (see first_seen_date in db.ts).
    const cachedUrls = sourceCache.urlsFirstSeenBefore(today);
    const seenUrls = new Set<string>();
    // Light dedup: only remove exact URL matches, keep everything else
    const uniqueItems = allRawItems.filter(i => {
      if (!i.url || seenUrls.has(i.url)) return false;
      seenUrls.add(i.url);
      return true;
    });
    // Relaxed cache filter: allow official sources through, and only skip cache for non-official
    const itemsToProcess = uniqueItems.filter(i => i.isOfficialSource || !cachedUrls.has(i.url));

    const officialInBatch = itemsToProcess.filter(i => i.isOfficialSource).length;
    const braveInBatch = itemsToProcess.filter(i => braveItems.some(b => b.url === i.url)).length;
    await prog(`${itemsToProcess.length} unique items to cluster (${officialInBatch} official · ${braveInBatch} Brave · ${itemsToProcess.length - officialInBatch - braveInBatch} other). Starting Stage 2…`, 46);

    if (itemsToProcess.length === 0) {
      await prog('No new items. Click "Clear Cache & Re-collect" to force a fresh run.', 100);
      return { success: true, storiesFound: 0, message: 'No new items found.' };
    }

    // ── Stage 2: Batch clustering ─────────────────────────────────────
    // Process in batches of ~250 items to stay within LLM context limits
    const CLUSTER_BATCH_SIZE = 250;
    const allClusters: ClusterResult[] = [];
    const totalBatches = Math.ceil(itemsToProcess.length / CLUSTER_BATCH_SIZE);

    for (let b = 0; b < totalBatches; b++) {
      const start = b * CLUSTER_BATCH_SIZE;
      const batchItems = itemsToProcess.slice(start, start + CLUSTER_BATCH_SIZE);
      await prog(`Clustering batch ${b + 1}/${totalBatches} (${batchItems.length} items)…`, 48 + Math.round((b / totalBatches) * 15));
      const batchClusters = await clusterBatch(batchItems, start);
      allClusters.push(...batchClusters);
    }

    await prog(`${allClusters.length} raw clusters from ${totalBatches} batch(es). Merging cross-batch duplicates…`, 65);

    // ── Stage 2b: Merge duplicate clusters across batches ─────────────
    const mergedClusters = (await mergeDuplicateClusters(allClusters)).map(c => deriveFacts(c, itemsToProcess));

    const verifiedCount = mergedClusters.filter(c => computeStatus(c) === 'Verified').length;
    const likelyCount = mergedClusters.filter(c => computeStatus(c) === 'Likely').length;
    const topOutlets = mergedClusters.length > 0 ? Math.max(...mergedClusters.map(c => c.majorOutletCount)) : 0;
    await prog(`${mergedClusters.length} distinct stories — ${verifiedCount} verified · ${likelyCount} likely. Generating summaries…`, 68);

    // ── Stage 3: Score all clusters ───────────────────────────────────
    const scoredClusters = mergedClusters.map(c => ({
      cluster: c,
      status: computeStatus(c),
      score: computeScore(c, computeStatus(c)),
    })).sort((a, b) => b.score - a.score);

    // ── Stage 4: Surface shortlist — minimum 30, prefer 35-50 ─────────
    // Keep all clusters with operatorRelevance >= 3 (wide net)
    // Only cut truly irrelevant stories (operatorRelevance <= 2)
    const MIN_STORIES = 30;
    let surfaced = scoredClusters.filter(s => s.cluster.operatorRelevance >= 3);

    // If below minimum, add back lower-relevance stories
    if (surfaced.length < MIN_STORIES) {
      const extras = scoredClusters.filter(s => s.cluster.operatorRelevance < 3);
      surfaced = [...surfaced, ...extras].slice(0, Math.max(MIN_STORIES, surfaced.length));
    }

    // Re-sort by score
    surfaced.sort((a, b) => b.score - a.score);

    await prog(`Surfacing ${surfaced.length} stories (from ${mergedClusters.length} total clusters). Generating summaries…`, 72);

    // ── Stage 4: Summaries for surfaced stories ───────────────────────
    const surfacedClusters = surfaced.map(s => s.cluster);
    const summaries = await generateSummaries(surfacedClusters, itemsToProcess);
    await prog(`Summaries ready. Saving ${surfacedClusters.length} stories…`, 82);

    // ── Save to database ──────────────────────────────────────────────
    const existing = stories.where('deck_date = ?', today);
    for (const s of existing) stories.remove(s.id);

    const storyRecords = surfaced.map((s, idx) => {
      const c = s.cluster;
      const blogSources = c.itemIndices.map(i => itemsToProcess[i])
        .filter(it => it?.type === 'blog')
        .map(it => ({ company: it.sourceCompany || it.sourceName, url: it.url, title: it.title, isOfficial: it.isOfficialSource }));
      const articleSources = c.itemIndices.map(i => itemsToProcess[i])
        .filter(it => it?.type === 'article')
        .map(it => ({ outlet: it.sourceName, url: it.url, title: it.title }));
      return {
        headline: c.headline,
        status: s.status,
        compositeScore: s.score,
        sourceCount: c.majorOutletCount,
        firstSeenAt: c.firstSeenAt,
        summary: summaries[idx] || c.headline,
        hasOfficialBlog: c.hasOfficialBlog,
        blogSources: JSON.stringify(blogSources),
        articleSources: JSON.stringify(articleSources),
        addedToDeck: false,
        deckDate: today,
        category: c.category,
      };
    });

    stories.insertMany(storyRecords);

    // ── Update source cache ───────────────────────────────────────────
    const cacheRecords = allRawItems.filter(i => !!i.url).map(i => ({
      sourceUrl: i.url,
      itemType: i.type === 'blog' ? 'Blog' : 'Article',
      lastSeenAt: new Date().toISOString(),
      sourceName: i.sourceName,
      firstSeenDate: today,
    }));
    sourceCache.upsertMany(cacheRecords);

    const rawCount = allRawItems.length;
    const uniqueCount = itemsToProcess.length;
    await prog(`Done! ${rawCount} raw → ${uniqueCount} unique → ${mergedClusters.length} clusters → ${storyRecords.length} surfaced stories. ${verifiedCount} verified · ${likelyCount} likely · top covered by ${topOutlets} outlets.`, 100);
    return { success: true, storiesFound: storyRecords.length, message: `${rawCount} raw → ${storyRecords.length} surfaced stories` };
}
