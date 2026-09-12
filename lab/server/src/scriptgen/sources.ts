/**
 * Judging where the research actually got its facts.
 *
 * THE RUN THAT CAUSED THIS
 * "How I'd Automate Daily Social Media Content in 2026" (run 4jeWHiyyuByZK3lNuauqE,
 * Sept 10 2026) opened 21 pages. Nineteen were third-party review sites. The two
 * that were not were a vendor help article last edited in September 2025 and a
 * changelog whose newest entry was February 2026. The product's own pricing page
 * was never opened. Every price in that script therefore came from a review blog,
 * and the video's central premise — which plan Auto Posting runs on — rested on a
 * document a year old.
 *
 * The research prompt already said to read the vendor's own pages first. It said
 * it in prose, at line 258 of a 420-line prompt, with nothing checking. This
 * module is the check. It is deliberately NOT a model call: the run above would
 * have told you, confidently, that it had researched the product thoroughly.
 *
 * WHAT IT CAN AND CANNOT DO
 * It can tell first-party from not-first-party exactly, because that is a
 * hostname comparison. It CANNOT tell a careful independent write-up from an SEO
 * farm — the pages in that run were maxaeo.ai, aitoolbeat.com, coldiq.com,
 * oreateai.com, techbriefly.com and nine more like them, a long tail no list will
 * ever enumerate. So it does not pretend to: the known software directories are
 * named, the obvious community sites are named, and everything else is counted as
 * "other" rather than guessed at. The signal that matters — and the one that is
 * always reliable — is whether the vendor's own words were read at all.
 *
 * Pure: no imports beyond types, no I/O, unit-tested in scriptgen-coverage.test.ts.
 */
import type { ScriptSource, SourceAudit } from "./types.js";

/**
 * Software directories and review aggregators. These recycle copy for years and
 * restamp the page title with the current year, so they look current to a
 * date-anchored search and are the single most common way a dead price gets into
 * a script. Naming them is worth doing even though the long tail cannot be.
 */
const AGGREGATOR_HOSTS = [
  "g2.com",
  "capterra.com",
  "getapp.com",
  "trustradius.com",
  "softwareadvice.com",
  "saashub.com",
  "alternativeto.net",
  "producthunt.com",
  "crozdesk.com",
  "goodfirms.co",
  "financesonline.com",
  "sourceforge.net",
  "slashdot.org",
  "tekpon.com",
  "toolify.ai",
  "futurepedia.io",
  "theresanaiforthat.com",
  "aitools.fyi",
  "slant.co",
  "trustpilot.com",
];

/** Places where people who actually use the thing talk about it. */
const COMMUNITY_HOSTS = [
  "reddit.com",
  "news.ycombinator.com",
  "github.com",
  "stackoverflow.com",
  "stackexchange.com",
  "discord.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
  "medium.com",
  "dev.to",
  "substack.com",
];

/**
 * Hosted changelog / feedback services. A page here is written BY the vendor
 * even though the domain is not theirs — `predis.frill.co` is Predis publishing
 * its own release notes. Counted first-party when the subdomain matches the
 * vendor name, which is how every one of these is addressed.
 */
const VENDOR_PUBLISHING_HOSTS = [
  "frill.co",
  "canny.io",
  "featurebase.app",
  "productlane.com",
  "noticeable.news",
  "headwayapp.co",
  "launchnotes.io",
  "gitbook.io",
  "readme.io",
  "notion.site",
];

/** Subdomains a vendor puts its own documentation behind. */
const VENDOR_SUBDOMAINS = ["www", "help", "docs", "support", "blog", "app", "developers", "developer", "api", "changelog", "status", "learn", "academy", "community"];

export type SourceKind = "first-party" | "community" | "aggregator" | "other";

/** Lowercase hostname with a leading `www.` removed, or "" if the URL is unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function endsWithHost(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/**
 * Guess the vendor's own domain(s) from the topic the run is about.
 *
 * A topic reaches us as a short brief — "Predis.ai", "Claude Cowork", "Twin.so
 * (browser agent)". The name is the part before any dash, colon or parenthesis;
 * `searchTopic()` in videoResearch.ts reduces it the same way for the same
 * reason, and the two are deliberately similar rather than shared, because that
 * one is tuned for a YouTube query and this one for a hostname.
 *
 * When the name already carries a TLD ("predis.ai", "twin.so") that IS the
 * domain and no guessing is needed. Otherwise the common TLDs are offered as
 * candidates — they cost nothing, since a candidate only ever MATCHES a source
 * the search already returned. A wrong guess can never invent a source; it can
 * only fail to recognise a real one.
 */
export function vendorHosts(coreTopic: string, specificFocus?: string): string[] {
  const name = toolName(coreTopic) || toolName(specificFocus || "");
  if (!name) return [];
  const compact = name.toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!compact) return [];
  // Already a domain: "predis.ai", "twin.so", "n8n.io".
  if (/^[a-z0-9-]+(\.[a-z]{2,})+$/.test(compact) && !compact.endsWith(".")) {
    const parts = compact.split(".");
    // A two-letter final part is a TLD ("twin.so"); anything else is too, but a
    // single-word name with no dot never reaches here.
    if (parts.length >= 2 && parts[parts.length - 1].length >= 2) return [compact];
  }
  const bare = compact.replace(/\./g, "");
  if (bare.length < 2) return [];
  return [`${bare}.com`, `${bare}.ai`, `${bare}.io`, `${bare}.co`, `${bare}.app`, `${bare}.dev`];
}

/**
 * The product NAME out of a brief: drop parentheticals, cut at the first dash or
 * colon, keep at most three words. "Predis.ai — AI social media manager" →
 * "Predis.ai".
 */
export function toolName(brief: string): string {
  let t = (brief || "").replace(/\([^)]*\)/g, " ");
  t = t.split(/\s[-–—:]\s|:/)[0];
  const words = t.trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return words.join(" ").trim();
}

/** Which bucket one source falls in, judged against this run's vendor hosts. */
export function classifySource(url: string, hosts: string[]): SourceKind {
  const host = hostOf(url);
  if (!host) return "other";
  for (const base of hosts) {
    if (endsWithHost(host, base)) return "first-party";
  }
  // A hosted changelog under the vendor's own name: "predis.frill.co".
  for (const svc of VENDOR_PUBLISHING_HOSTS) {
    if (!endsWithHost(host, svc)) continue;
    const sub = host.slice(0, host.length - svc.length - 1);
    for (const base of hosts) {
      const bare = base.split(".")[0];
      if (sub === bare || sub.startsWith(`${bare}-`) || sub.endsWith(`-${bare}`)) return "first-party";
    }
  }
  for (const base of AGGREGATOR_HOSTS) if (endsWithHost(host, base)) return "aggregator";
  for (const base of COMMUNITY_HOSTS) if (endsWithHost(host, base)) return "community";
  return "other";
}

/**
 * Count what the research rested on. Called after Stage 1 with the sources the
 * search actually returned — never with what the model says it read.
 */
export function auditSources(sources: ScriptSource[], hosts: string[]): SourceAudit {
  const counts = { firstParty: 0, community: 0, aggregator: 0 };
  const firstPartyHosts: string[] = [];
  for (const s of sources) {
    const kind = classifySource(s.url, hosts);
    if (kind === "first-party") {
      counts.firstParty++;
      const h = hostOf(s.url);
      if (h && !firstPartyHosts.includes(h)) firstPartyHosts.push(h);
    } else if (kind === "community") counts.community++;
    else if (kind === "aggregator") counts.aggregator++;
  }
  return {
    total: sources.length,
    firstParty: counts.firstParty,
    community: counts.community,
    aggregator: counts.aggregator,
    vendorHosts: hosts,
    firstPartyHosts,
    // No vendor hosts to check against is not the same as having checked and
    // found none — a topic that is not a product ("how to price a course") has
    // no vendor at all, and flagging that as a research failure would cry wolf
    // on every run that isn't about a tool.
    noFirstParty: hosts.length > 0 && counts.firstParty === 0,
  };
}

/**
 * The line the run logs after research. Written out in full because when a
 * script comes back with stale prices this is the first thing to look at, and a
 * bare count of 21 sources says nothing about where they came from.
 */
export function auditLogLine(a: SourceAudit): string {
  const parts = [
    `${a.total} source(s)`,
    `first-party ${a.firstParty}${a.firstPartyHosts.length ? ` (${a.firstPartyHosts.join(", ")})` : ""}`,
    `aggregator ${a.aggregator}`,
    `community ${a.community}`,
  ];
  const tail = a.noFirstParty
    ? ` — NO FIRST-PARTY SOURCE. Nothing here came from ${a.vendorHosts.slice(0, 3).join(" / ")}; every price and limit in this run is second-hand.`
    : "";
  return parts.join(", ") + tail;
}

/**
 * What the research is TOLD to do before anything else, built in code from the
 * topic so it names real domains rather than describing the idea of a domain.
 *
 * This exists because the same instruction already lived in the research prompt
 * as prose and was ignored. A prompt that says "read the vendor's own pricing
 * page" is advice; a prompt that says "your first search is site:predis.ai
 * pricing" is an instruction with a subject.
 */
export function firstPartyBlock(coreTopic: string, hosts: string[]): string {
  if (!hosts.length) return "";
  const name = toolName(coreTopic) || "the product";
  const primary = hosts.slice(0, 4);
  return [
    "## REQUIRED FIRST SEARCHES — THE VENDOR'S OWN PAGES",
    "",
    `Before any review, roundup or comparison article, go to ${name}'s own site and read what ${name} publishes about itself. Likely domains, in order:`,
    "",
    ...primary.map((h) => `- \`${h}\``),
    "",
    "Run these first, and spend real searches on them:",
    "",
    `- \`site:${primary[0]} pricing\` — the live pricing page, not a blog's summary of it`,
    `- \`site:${primary[0]} changelog OR "release notes" OR "what's new"\``,
    `- \`site:${primary[0]} docs OR help\` — for limits, tiers and what gates what`,
    "",
    "**A price, a tier name, a quota or a plan limit taken from a review site is hearsay.** Those sites rewrite one article for years and put the current year in the title, so they look current to a dated search and are not. Where you have a figure from a review site and none from the vendor, the fact sheet must carry it as second-hand with the site named — never as what the product costs today.",
    "",
    "If the vendor's own pages cannot be reached or do not exist, say that explicitly in the SOURCE DATES section. That is a finding about the topic — a product with no public pricing page is a real thing to know — and it is what tells the writer to lean on the screenshots and the recordings instead.",
  ].join("\n");
}
