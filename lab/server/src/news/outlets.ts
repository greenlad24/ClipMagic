/**
 * AI News Stream — which source a slide shows.
 *
 * Jake's rule (2026-09-29): when a story is picked, show it from the BIGGEST
 * news outlet that covered it, never a small blog. The slide's "best source"
 * is what the source tab opens on air and what the script credits, so
 * "according to Zapier" on the Claude Sonnet 5.5 launch — which is what the old
 * "official blog first, else the first article" rule produced, because Zapier's
 * blog sits on the company-blog list — is exactly what must not happen.
 *
 * Order: the major outlets by reach, then the AI labs' own announcements (a
 * primary source, not a small blog), then a second tier of recognizable news
 * sites, then anything else. Only when nothing better exists does a small site
 * win, because there is nothing else to show.
 */

/** Biggest first. Names match the spellings collect.ts normalizes to. */
export const OUTLET_RANK = [
  'Reuters', 'Bloomberg', 'Associated Press', 'The New York Times', 'WSJ',
  'Financial Times', 'The Washington Post', 'BBC', 'CNBC', 'The Guardian',
  'The Verge', 'TechCrunch', 'Wired', 'Axios', 'The Information', 'CNET',
  'Ars Technica', 'Business Insider', 'Fortune', 'Engadget', 'VentureBeat',
  'ZDNET', 'MIT Technology Review', 'IEEE Spectrum', 'Semafor',
  '9to5Mac', '9to5Google',
];

/** Recognizable, but below a lab's own announcement. Biggest first. */
export const OUTLET_RANK_2 = [
  'CNN', 'NBC News', 'Forbes', 'Newsweek', 'Yahoo', 'MarketWatch',
  'The Times of India', 'Economic Times', 'Business Standard', 'Business Today',
  'International Business Times', 'Gizmodo', 'Mashable', 'TechRadar', "Tom's Guide",
  "Tom's Hardware", 'PCMag', 'The Register', 'The Next Web', 'SiliconANGLE',
  'Digital Trends', 'Android Authority', 'Interesting Engineering', 'BleepingComputer',
  'MacRumors', 'Windows Central', 'Neowin', 'Futurism', 'Decrypt', 'Thurrott', 'Android Headlines',
];

/**
 * The labs whose own post is the primary source for their OWN news, and the
 * words that say a headline is about them. ⚠️ Only then: clustering sometimes
 * files a lab's unrelated post under someone else's story, and "Leaked Gemini 4
 * Pro benchmarks" credited to OpenAI's blog is worse than any small site.
 */
const AI_LABS: Record<string, RegExp> = {
  'OpenAI': /\b(openai|chatgpt|gpt-?\d|sora|codex)\b/i,
  'Anthropic': /\b(anthropic|claude)\b/i,
  'Google AI': /\b(google|gemini)\b/i,
  'Google DeepMind': /\b(deepmind|gemini)\b/i,
  'Meta AI': /\b(meta|llama)\b/i,
  'Microsoft AI': /\b(microsoft|copilot)\b/i,
  'Apple': /\b(apple|siri)\b/i,
  'xAI': /\b(xai|grok)\b/i,
  'Mistral': /\bmistral\b/i,
  'Perplexity': /\bperplexity\b/i,
  'Hugging Face': /\bhugging ?face\b/i,
  'Stability AI': /\b(stability|stable diffusion)\b/i,
};

const ALIASES: Record<string, string> = {
  'reuters.com': 'Reuters', 'bloomberg.com': 'Bloomberg', 'apnews.com': 'Associated Press',
  'ap news': 'Associated Press', 'the associated press': 'Associated Press',
  'nytimes.com': 'The New York Times', 'new york times': 'The New York Times', 'nyt': 'The New York Times',
  'wsj.com': 'WSJ', 'the wall street journal': 'WSJ', 'wall street journal': 'WSJ',
  'ft.com': 'Financial Times', 'washingtonpost.com': 'The Washington Post', 'washington post': 'The Washington Post',
  'bbc.com': 'BBC', 'bbc.co.uk': 'BBC', 'bbc news': 'BBC', 'bbc technology': 'BBC',
  'cnbc.com': 'CNBC', 'theguardian.com': 'The Guardian', 'theverge.com': 'The Verge',
  'techcrunch.com': 'TechCrunch', 'wired.com': 'Wired', 'axios.com': 'Axios',
  'theinformation.com': 'The Information', 'cnet.com': 'CNET', 'arstechnica.com': 'Ars Technica',
  'businessinsider.com': 'Business Insider', 'fortune.com': 'Fortune', 'engadget.com': 'Engadget',
  'venturebeat.com': 'VentureBeat', 'zdnet.com': 'ZDNET', 'technologyreview.com': 'MIT Technology Review',
  'spectrum.ieee.org': 'IEEE Spectrum', 'semafor.com': 'Semafor', '9to5mac.com': '9to5Mac', '9to5google.com': '9to5Google',
  'cnn.com': 'CNN', 'nbcnews.com': 'NBC News', 'forbes.com': 'Forbes', 'newsweek.com': 'Newsweek',
  'yahoo.com': 'Yahoo', 'yahoo news': 'Yahoo', 'yahoo finance': 'Yahoo', 'marketwatch.com': 'MarketWatch',
  'indiatimes.com': 'The Times of India', 'times of india': 'The Times of India',
  'economictimes.indiatimes.com': 'Economic Times', 'the economic times': 'Economic Times',
  'business-standard.com': 'Business Standard', 'businesstoday.in': 'Business Today',
  'ibtimes.com': 'International Business Times', 'gizmodo.com': 'Gizmodo', 'mashable.com': 'Mashable',
  'techradar.com': 'TechRadar', 'tomsguide.com': "Tom's Guide", 'tomshardware.com': "Tom's Hardware",
  'pcmag.com': 'PCMag', 'theregister.com': 'The Register', 'thenextweb.com': 'The Next Web',
  'siliconangle.com': 'SiliconANGLE', 'digitaltrends.com': 'Digital Trends',
  'androidauthority.com': 'Android Authority', 'interestingengineering.com': 'Interesting Engineering',
  'bleepingcomputer.com': 'BleepingComputer', 'macrumors.com': 'MacRumors',
  'windowscentral.com': 'Windows Central', 'neowin.net': 'Neowin', 'futurism.com': 'Futurism',
  'decrypt.co': 'Decrypt', 'thurrott.com': 'Thurrott', 'androidheadlines.com': 'Android Headlines',
};
const lowerMap = (list: string[]) => new Map(list.map((o, i) => [o.toLowerCase(), i]));
const TIER1 = lowerMap(OUTLET_RANK);
const TIER2 = lowerMap(OUTLET_RANK_2);

/** Canonical outlet name for a display name or a hostname ("tech.yahoo.com" → "Yahoo"). */
function canonical(name: string): string {
  const key = (name || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const parent = key.split('.').slice(-2).join('.'); // tech.yahoo.com → yahoo.com
  return ALIASES[key] ?? ALIASES[parent] ?? name.trim();
}

/** Tier 1 = 0..n, tier 2 = 1000+, unknown = Infinity. Lower is bigger. */
function rankOf(name: string): number {
  const c = canonical(name).toLowerCase();
  const bare = c.replace(/\.com$/, '');
  const t1 = TIER1.get(c) ?? TIER1.get(bare);
  if (t1 !== undefined) return t1;
  const t2 = TIER2.get(c) ?? TIER2.get(bare);
  return t2 !== undefined ? 1000 + t2 : Infinity;
}

/**
 * The real publisher of an article. Stories collected before the Google News
 * fix credited the FEED ("Google News — Anthropic"); their titles still end
 * " - <publisher>", which is the only record of who actually ran it.
 */
function publisherOf(a: { outlet: string; title?: string }): string {
  if (!a.outlet?.startsWith('Google News')) return a.outlet;
  const m = / - ([^-]+)$/.exec(a.title || '');
  return m ? m[1].trim() : a.outlet;
}

export interface BestSource { name: string; url: string; kind: 'outlet' | 'lab' | 'other' }

export function pickBestSource(
  blogSources: { company: string; url: string; isOfficial?: boolean }[],
  articleSources: { outlet: string; url: string; title?: string }[],
  headline = '',
): BestSource | null {
  // A Google News redirect breaks the source tab (it navigates cross-origin
  // and the window handle is lost), so a direct link always beats one.
  const direct = (url: string) => !!url && !url.includes('news.google.com');
  const articles = articleSources
    .map(a => ({ name: publisherOf(a), url: a.url }))
    .filter(a => direct(a.url));

  const ranked = articles
    .map(a => ({ ...a, rank: rankOf(a.name) }))
    .filter(a => a.rank !== Infinity)
    .sort((x, y) => x.rank - y.rank);
  const top = ranked[0];
  if (top && top.rank < 1000) return { name: OUTLET_RANK[top.rank], url: top.url, kind: 'outlet' };

  // The SUBJECT is the lab named first: "Leaked Gemini 4 Pro Beats GPT-6" is
  // Google's story even though it names OpenAI's model too.
  const firstAt = (company: string) => {
    const m = AI_LABS[company]?.exec(headline);
    return m ? m.index : Infinity;
  };
  const subjectAt = Math.min(...Object.keys(AI_LABS).map(firstAt));
  const lab = blogSources.find(b => b.isOfficial && direct(b.url) && firstAt(b.company) !== Infinity && firstAt(b.company) === subjectAt);
  if (lab) return { name: lab.company, url: lab.url, kind: 'lab' };

  if (top) return { name: OUTLET_RANK_2[top.rank - 1000], url: top.url, kind: 'outlet' };

  if (articles[0]) return { ...articles[0], kind: 'other' };
  const blog = blogSources.find(b => direct(b.url));
  if (blog) return { name: blog.company, url: blog.url, kind: 'other' };

  const any = articleSources[0] ?? null;
  return any ? { name: publisherOf(any), url: any.url, kind: 'other' } : null;
}
