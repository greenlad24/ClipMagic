/**
 * AI News Stream — build the presentation deck from the stories marked
 * "added to deck": presenter notes (why it matters, key points, talking angle,
 * suggested time) and a teleprompter script per story, in Jake's voice.
 *
 * Streams progress as JSON strings `{ message, percent }`.
 */
import { stories, decks, slides, todayDate, type SlideRecord } from './db.js';
import { callNewsModel } from './ai.js';
import { pickReadableSource } from './access.js';
import { findVideoForStory, slideVideoFields, uniqueVideos, type VideoResult } from './video.js';
import { generateStageForStory, type StoryStage } from './stage.js';

// Official/company blog sources of a story
interface BlogSource { company: string; url: string; title: string; isOfficial: boolean; }
interface ArticleSource { outlet: string; url: string; title: string; }

// ── Jake Dawson Script Style Guide (full) ─────────────────────────────────────
export const JAKE_STYLE_GUIDE = `You write scripts that Jake Dawson reads out loud on camera. Jake runs a YouTube channel about AI tools and how to use them. His audience is regular people who are curious about AI: some are just starting out with ChatGPT, Claude or Gemini, others already make images, videos or apps with AI. They are NOT engineers and they are not reading tech news all day. The news show is where he tells them what happened in AI and robotics and what it means for them.

THE TOP RULE: conversational American English a 14-year-old can follow.
This rule sits above every other style rule. Only accuracy ranks higher.
Every script is written in conversational, United States English, at a level a 14-year-old can understand without pausing, rewinding or looking anything up. The more complex the topic, the more this rule matters.

What "conversational American English" means:
- American spelling: color, organize, analyze, center, program, license, traveled, gray, favorite.
- American words: "cell phone" not "mobile," "vacation" not "holiday," "apartment" not "flat," "math" not "maths," "gotten" is fine.
- American money and numbers, written the way they're said: "twenty dollars a month," not "$20/mo." If a price is in another currency, say it in that currency.
- Contractions always: it's, that's, you're, don't, won't, they've, here's.
- Everyday American casual phrasing: "pretty much," "kind of," "a ton of," "honestly," "the thing is," "no big deal," "here's the deal."
- Talk to one person. Use "you," not "users," "viewers," "individuals."
- Active voice. "Google released a new model," not "A new model was released by Google."
- No formal or bookish words when a simple one works: utilize→use, approximately→about, commence→start, facilitate→help, demonstrate→show, obtain→get, sufficient→enough, numerous→a lot of, subsequently→then, in order to→to, prior to→before, regarding→about, functionality→what it does, capabilities→what it can do, implement→set up, additionally→also, however (starting a sentence)→but, therefore→so, individuals→people, purchase→buy.

The 14-year-old test — for every sentence ask:
1. Would they know every word? If not, swap it for a plain word, or cut it. Explain it only if the story can't be told without it.
2. Could they say it back in their own words? If not, split it.
3. Would they know why it matters? If not, add the "so what" in one line.
Aim for 8-15 word sentences. A longer one for rhythm is fine. Two long ones in a row is not.

EXPLAIN BY REMOVAL (from Jake's writing guide — this is the main tool):
Write to reduce confusion, not to sound smart. Before explaining a technical detail, ask: does the viewer need it to get the story? If not, cut it. Explaining a jargon word is still making them learn a jargon word.
- Say what a thing DOES, not what it's called. "It gets stuff done in fewer steps," not "it makes fewer tool calls." "It scored almost as high on the tests companies use to compare AI," not "it nearly matches Opus on benchmarks."
- Official terms are the exception. When a term is the official name the story itself is about (for example "misaligned," a model's name, a law's name), keep it — it's the word the viewer will see in headlines — and explain it in plain words right after.
- At most one or two explained terms per segment. If a story needs more, you're telling too much of it.
- Insider words to avoid unless they are the official term the story is about: benchmark, tool call, parameters, tokens, inference, latency, throughput, compute, flagship, mid-tier, tier, SOTA, frontier model, open weights, multimodal, context window, fine-tuning, API, endpoint, agentic, orchestration, deployment, pipeline, stack, enterprise, scale (as a verb), ecosystem, use case.
- Model and product names: the first time, say what it is in a few everyday words. "Sonnet, which is the everyday version of Claude," not "the mid-tier model."
- Short sentences. One idea per sentence. One thought per paragraph.
- Final test: could a 14-year-old repeat this story to a friend tomorrow? If not, simplify again.

How to explain a complex topic (use every time):
1. Say it in one plain sentence first.
2. If a hard word has to stay, explain it right away.
3. Use an everyday comparison linked to something a teenager knows.
4. One new idea at a time.
5. Turn numbers into pictures.
6. Show it in a real day the viewer might have: "Let's say you're planning a trip…", "Say you use ChatGPT for homework…", "Let's say you're making a video for your channel…" Not "Let's say you run a small agency." Most viewers don't run a business.
7. Land the "so what."
8. Cut what they don't need.

Terms that need a plain explanation IF they have to stay (prefer cutting them): model, LLM, agent, API, token, context window, benchmark, parameters, fine-tuning, open source / open weights, inference, GPU / chip, data center, multimodal, reasoning model, hallucination, prompt, integration, workflow, automation, SaaS, funding round, valuation, IPO, regulation, antitrust, and any product or model name that isn't a household name.

Jake's persona — bar-Jake:
The smart, curious friend at the bar everyone wants to talk to for hours. Approachable, slightly dry, says things that make you think or laugh. Not a teacher. Not a guru. Not a salesperson. Not a news anchor.
- He would rather make you laugh than impress you.
- He's smart but doesn't perform being smart.
- He's curious about the news, not cynical about it.
- He talks with the viewer, never at them.
- His tone is closer to Anthony Bourdain, Casey Neistat or Chris Williamson than to a hype-driven YouTube guru.

The bar test applies to every line: would Jake say this to a stranger he just met and liked? If not, cut or rewrite it.

ACCURACY RULES (these come before everything else):
1. Use only the facts in the source material. Never invent numbers, prices, dates, quotes, feature names, benchmark scores, user counts or company statements.
2. If a fact is missing, leave it out. Don't guess. Say it plainly: "They haven't said what it costs yet."
3. Attribute claims: "OpenAI says…", "according to Google…", "the company claims…"
4. Label unconfirmed news: "This is still a rumor." "Nothing's confirmed yet."
5. Separate fact from Jake's take. Jake's opinion: "My take…", "I think…", "Honestly, I'm curious whether…"
6. Keep dates honest. Don't turn "last Tuesday" into "today."
7. Quote exactly or paraphrase and attribute.
8. Hypothetical examples must sound hypothetical: "Let's say you're planning a trip…" Never invent real-sounding people or results.
9. No income claims.
10. No medical, legal or financial advice.

HARD VOICE RULES (non-negotiable):
1. Never punch sideways. No jabs at other creators, channels, or outlets. Never "most AI channels won't tell you this."
2. Never punch down. No "if you've been doing this wrong," "most people don't know." The viewer is Jake's equal.
3. Humor goes at Jake or at the situation. Never at the viewer. Never at other creators.
4. Never lead with credentials.
5. No mentions of Jake's past companies by name.
6. Background comes out sideways — at most one short backstory line, followed by a pivot back to the news.
7. Sound human, not presented. Read like a person thinking out loud.

NEWS COMPETITOR RULE:
- Allowed: Naming companies in the story. Reporting comparisons the company itself made, attributed.
- Allowed: Neutral context: "Google launched something similar in the spring."
- Not allowed: Jake picking winners/losers mockingly. "This kills [tool]," "[Company] is finished."
- Not allowed: Jabs at companies' users.

STORY LOOP (each main story):
1. What happened. Plain facts, attributed. One idea per sentence.
2. What it actually is. Explain simply. If technical, explain by taking things away.
3. A concrete example from everyday life. "Let's say you're selling your old bike online…"
4. Why it matters (or doesn't) for the viewer. Be honest.
5. Caveat. What we don't know yet, what it costs, what's limited.
6. Jake's take. Short, owned as opinion, positive with some realism. It can sit anywhere after the facts, not only at the end.
7. The ending. Different every story (each segment is assigned its own ending shape). Never the same "my take → don't act yet → keep an eye on it" close.

CONVERSATIONAL PHRASE MENU (use 4-8 per episode, from 4-6 different slots, never repeat, never stack two in a row):

Story openers: "So, I'm going to start with [X], just because…" / "A couple neat things in [X]." / "But then there's this new feature…" / "Now, [X] got a big update as well." / "And then there's also…"

Real-time thinking: "Like…" / "So…" / "I mean…" / "You know…" / "…kind of…" / "…basically…" / "…essentially…"

Soft hedges: "…I think." / "I'm not sure how I feel about [X], to be honest." / "Maybe it's just me, but…" / "We'll see." / "…if it works…" / "…if they get this right, that's a real win."

Credit-giving: "…it's a different take on it. I'll give them credit for that." / "It's a genuinely smart idea." / "What's clever about this is…" / "That's a huge win." / "You love to see it."

Anticipation: "Now, here's the thing…" / "And the part I keep coming back to is…"

Concrete example pivot: "But let's say you're [specific situation]…" / "Well, if you have [X], it can actually…" / "…without you having to [the manual pain]."

Honest uncertainty: "And honestly, I'm curious to see how they handle [edge case]…" / "Could go either way, but if they get it right, that's a real win."

Self-aware humor (one per episode max): "…to make sure I'm not crazy here…" / "I don't know why they named it that, but…"

Closers/transitions: "Either way…" / "Anyway…" / "So, that's all pretty convenient." / "Alright, moving on."

HUMOR:
- Dry, observational, understated, timing-based. Should feel accidental, not performed.
- One joke per moment. Pattern: joke, then two-three facts, then a personality beat, then repeat.
- Accuracy beats humor. Never bend a fact for a laugh.
- Techniques: unexpected-twist analogy, comedic pause, rule of three, controlled sarcasm at the old way, harmless hot take, callback, word swaps (sparingly), one-word punch.

BANNED WORDS AND PATTERNS:
Words: delve, dive deep, deep dive, game-changer, game-changing, revolutionize, revolutionary, groundbreaking, cutting-edge, unleash, unlock (as in potential), supercharge, harness the power, leverage (verb), seamless, seamlessly, robust, elevate, empower, transformative, paradigm shift, landscape ("the AI landscape"), realm, tapestry, testament, pivotal, crucial, vital, navigate (figuratively), bustling, synergy, ever-evolving, in the ever-changing world of, at the end of the day, buckle up, strap in, without further ado, mind-blowing, jaw-dropping, insane (in the script body).
Patterns: "It's not just X, it's Y." / "In today's fast-paced world…" / "Whether you're a X or a Y, this…" / Rhetorical question immediately answered / Stacking three adjectives / Summary lines repeating what was just said / "Let's dive in" (except in the fixed welcome line) / Ending every story on a big inspirational line.
Jake-specific bans: "Most tutorials don't…" / "If you've been doing this wrong…" / "Trust me" / "I'm an expert" / "I'm super excited to announce…" / "Smash that subscribe button" / "Number one… number two…" as story openers / "This changes everything" / "Make money with…"

OUTPUT FORMAT:
- Output only the words Jake says out loud. No markdown, no headers, no bold, no bullet points, no emojis.
- No labels or markers: no "HOOK:", "STORY 1:", "[B-ROLL]", timestamps or stage directions.
- Paragraph after paragraph in speaking order, separated by a single line break.
- Plain text only. Natural speech. Contractions throughout. Em dashes and ellipses where natural.
- Only use facts from the source material provided.`;

// ── Endings (Jake 2026-10-01) ─────────────────────────────────────────────────
// Every segment used to close the same way: "My take… don't act yet… keep an eye
// on it." Scripts are written in parallel, so they can't see each other — each
// story is ASSIGNED a different ending shape and opinion marker by its position
// in the deck, and the stock closers are banned outright.
export const SCRIPT_ENDINGS = [
  'TRY IT: end on one concrete thing the viewer can actually do with it today (where to find it, what to type, who gets it). Only if it is really available; otherwise use the next shape.',
  'SURPRISING FACT: end on the single most surprising number or detail in the story, said plainly, then stop. No lesson after it.',
  'OPEN QUESTION: end on the one honest question this raises — a real question Jake is curious about, not a rhetorical "what do you think?"',
  'WHAT HAPPENS NEXT: end on who has to respond now or what this sets up (a rival, a regulator, a next launch), stated concretely.',
  'PUNCHY VERDICT: end on a short, confident one-line verdict. No hedging, no "but we\'ll see".',
  'CALLBACK: end by calling back to the first detail of the segment with a small twist or a light joke.',
  'WHO IT\'S FOR: end on who this is great for and who can safely ignore it, in one line.',
  'EVERYDAY COMPARISON: end on a quick comparison to something familiar from everyday life that makes the point stick.',
];

const TAKE_MARKERS = [
  'Signal the opinion with "I think…"',
  'Signal the opinion with "Honestly…"',
  'Signal the opinion with "Here\'s what gets me…"',
  'Signal the opinion with "If you ask me…"',
  'Give the opinion without any marker — just say it.',
  'Signal the opinion with "The part I like…" or "The part that bugs me…"',
];

const BANNED_CLOSERS = `BANNED ENDINGS (never end a segment with any of these or a close variant): "keep an eye on it", "worth keeping an eye on", "watch this space", "wait and see", "we'll see", "time will tell", "I'd wait", "let other people go first", "don't rush", "nothing to act on (yet)", "for now, nothing changes", "only time will tell", "stay tuned". Do not open the opinion with "My take" — that phrase is overused on this show.`;

/** The ending + opinion-marker block for the story at `index` in the deck. */
export function endingRule(index: number): string {
  const ending = SCRIPT_ENDINGS[((index % SCRIPT_ENDINGS.length) + SCRIPT_ENDINGS.length) % SCRIPT_ENDINGS.length];
  const marker = TAKE_MARKERS[((index * 5 + 2) % TAKE_MARKERS.length + TAKE_MARKERS.length) % TAKE_MARKERS.length];
  return `ENDING FOR THIS SEGMENT (assigned so every story in the show ends differently): ${ending}\nOPINION: ${marker}\n${BANNED_CLOSERS}`;
}

// ── Script generator ──────────────────────────────────────────────────────────
export async function generateScriptForStory(
  headline: string,
  blogSources: BlogSource[],
  articleSources: ArticleSource[],
  sourceName: string,
  index = 0,
): Promise<string> {
  const ending = endingRule(index);
  const sourceLines = [
    ...blogSources.map(b => `${b.isOfficial ? '[OFFICIAL]' : '[BLOG]'} ${b.company}: ${b.title}`),
    ...articleSources.map(a => `[ARTICLE] ${a.outlet}: ${a.title}`),
  ].join('\n').slice(0, 2000);

  const prompt = `${JAKE_STYLE_GUIDE}

---

Write a teleprompter script for this ONE news segment. This is one segment in a multi-segment live AI news show — NOT a full episode. Do NOT include the hook, welcome line, subscribe/like/comment CTAs, wrap-up, or outro. Those belong to the full episode, not individual segments.

SEGMENT-SPECIFIC RULES (non-negotiable):
- TARGET: 120–200 words. These are 60–90 second segments, not explainers.
- START MID-THOUGHT. First sentence states what happened. No "Alright guys, let's dive into…" No throat-clearing openers.
- FOLLOW THE STORY LOOP: what happened → what it actually is (explain simply) → concrete example → why it matters or doesn't → caveat → Jake's take → what to do. Not every beat needs to be long — compress smaller stories. But every segment must answer "what happened" and "does it matter to me."
- NO RECAP PADDING. Once the news is delivered, do not re-explain or summarize what was just said.
- ONE REACTION THEN DONE. After the facts, give one honest take then stop.
- NO FILLER CLOSERS. No "stay tuned," "that's all for today," or any sign-off. This is one segment in a longer show.
- NEVER SAY "folks". Prefer not addressing the audience directly.
- Use 1-2 phrases from the conversational phrase menu — no more for a single segment.
- The last beat is NOT automatically "what to do". Use the ending below.

${ending}

TOPIC: "${headline}"
SOURCE: ${sourceName || 'Unknown'}

SOURCE MATERIAL:
${sourceLines || '(no sources available)'}

Write the script now. Plain text only. No formatting. No markdown. No headers. No labels. Paragraph after paragraph. Natural speech. Contractions throughout. Em dashes and ellipses where natural. Only use facts from the source material above.`;

  let draft: string;
  try {
    draft = await callNewsModel(prompt, 'news-script', 'director');
  } catch {
    return '';
  }
  if (!draft) return '';

  // The skill's "review while generating" step: a second read whose only job
  // is the 14-year-old test. The first draft keeps the jargon it explains
  // ("benchmarks — those are the tests…"); this pass cuts it instead. If the
  // review fails, the draft still goes on air rather than an empty slide.
  try {
    const reviewed = await callNewsModel(buildReviewPrompt(draft, headline, sourceLines, ending), 'news-script', 'director');
    return reviewed || draft;
  } catch {
    return draft;
  }
}

function buildReviewPrompt(draft: string, headline: string, sourceLines: string, ending: string): string {
  return `${JAKE_STYLE_GUIDE}

---

You are reviewing a teleprompter script Jake will read out loud on a live AI news show. Rewrite anything that's unclear, doesn't deliver value, or uses complex language. Aim for a 14-year-old's reading level.

Check every sentence:
1. Is there a word a 14-year-old wouldn't know? Swap it for what the thing does, or cut it. Keep an official term the story is about (like "misaligned" or a model's name) and make sure it's explained in plain words right after.
2. Is a technical detail explained that the viewer doesn't need to get the story? Cut the detail and its explanation.
3. Is the example about running a business or agency? Swap it for an everyday situation a regular person has.
4. Could a 14-year-old repeat this story to a friend tomorrow? If not, simplify.
5. Read it out loud in your head. Does it sound like a normal American talking to a friend — not a news anchor, not a press release, not an article being read? Anything stiff, written-sounding or formal gets rewritten the way a person would actually say it: contractions, everyday American phrasing ("pretty much," "kind of," "here's the thing"), short spoken sentences, numbers said the way people say them ("thirty percent," "twenty bucks a month").

6. Does the ending follow the assigned shape below and avoid every banned ending? If it ends on "keep an eye on it", "wait and see", "I'd wait" or anything like it, rewrite the last two sentences to the assigned shape. If the opinion starts with "My take", reword it as the OPINION line says.

${ending}

Do NOT change: the facts, the attributions, rumor/unconfirmed labels, Jake's voice, or the order of the story. Do not add facts that aren't in the source material. Stay between 120 and 200 words.

TOPIC: "${headline}"

SOURCE MATERIAL (for fact-checking only):
${sourceLines || '(no sources available)'}

SCRIPT TO REVIEW:
${draft}

Output ONLY the final script — the words Jake says out loud. No comments about what you changed. No labels, no markdown. Paragraph after paragraph.`;
}

// ── Notes generator ───────────────────────────────────────────────────────────
async function generateNotesForStory(
  headline: string,
  status: string,
  blogSources: BlogSource[],
  articleSources: ArticleSource[],
): Promise<{ whyItMatters: string; keyPoints: string[]; talkingAngle: string; suggestedTimeSeconds: number }> {
  const sourceLines = [
    ...blogSources.map(b => `${b.isOfficial ? '[OFFICIAL BLOG]' : '[BLOG]'}\n${b.company} — ${b.title}\n${b.url}`),
    ...articleSources.map(a => `[ARTICLE] ${a.outlet}\n${a.title}\n${a.url}`),
  ].join('\n\n---\n\n').slice(0, 4000);

  const prompt = `You are writing PRESENTER NOTES for a live AI news show. The audience is regular people curious about AI tools, from beginners to people making images, videos and apps with AI — not engineers.

TOPIC: "${headline}"
VERIFICATION STATUS: ${status}

SOURCE MATERIAL:
${sourceLines}

RULES:
1. Base everything on the sources. Do NOT invent facts.
2. Prioritize [OFFICIAL BLOG] content — those are direct company announcements.
3. "whyItMatters": 2-3 sentences on why a regular person watching should care. Be specific.
4. "keyPoints": Exactly 3 bullets, each with at least one specific fact from the sources.
5. "talkingAngle": 1-2 sentences — what should the audience actually DO after hearing this?
6. "suggestedTimeSeconds": 60-180 based on complexity.
7. Voice: Conversational, plain English a 14-year-old understands, active voice. Say what a thing does instead of using insider words (benchmark, tool call, parameters, tokens, flagship, inference). Keep an official term the story is about (e.g. "misaligned") but explain it in plain words.
8. Banned words: leverage, delve, robust, seamless, empower, unlock, revolutionary, game-changer, groundbreaking, transformative, cutting-edge.

Respond ONLY with valid JSON (no markdown):
{"whyItMatters":"...","keyPoints":["fact 1","fact 2","fact 3"],"talkingAngle":"...","suggestedTimeSeconds":90}`;

  try {
    const t = await callNewsModel(prompt, 'news-notes');
    const json = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
    const n = JSON.parse(json);
    return {
      whyItMatters: n.whyItMatters || '',
      keyPoints: Array.isArray(n.keyPoints) ? n.keyPoints.slice(0, 5) : [],
      talkingAngle: n.talkingAngle || '',
      suggestedTimeSeconds: typeof n.suggestedTimeSeconds === 'number' ? n.suggestedTimeSeconds : 90,
    };
  } catch {
    return { whyItMatters: '', keyPoints: [], talkingAngle: '', suggestedTimeSeconds: 90 };
  }
}

/** The source list the stage prompt sees — same material as the script's. */
function stageSourceLines(blogSources: BlogSource[], articleSources: ArticleSource[]): string {
  return [
    ...blogSources.map(b => `${b.isOfficial ? '[OFFICIAL]' : '[BLOG]'} ${b.company}: ${b.title}`),
    ...articleSources.map(a => `[ARTICLE] ${a.outlet}: ${a.title}`),
  ].join('\n').slice(0, 2000);
}

/**
 * Stages for slides that have none — decks built before stages existed — without
 * touching their scripts, notes or videos (a Rebuild would rewrite all of it).
 * `force` regenerates every slide's stage. Sequential-ish: 3 at a time.
 */
const stagesRunning = new Set<string>();
export async function buildStagesForDeck(deckId: string, force = false): Promise<{ built: number; failed: number; skipped: number }> {
  // A second click while the first run is going would pay for every stage twice.
  if (stagesRunning.has(deckId)) throw Object.assign(new Error('Visuals are already being made for this deck.'), { status: 409 });
  stagesRunning.add(deckId);
  try { return await buildStages(deckId, force); } finally { stagesRunning.delete(deckId); }
}

async function buildStages(deckId: string, force: boolean): Promise<{ built: number; failed: number; skipped: number }> {
  const list = slides.where('deck_id = ? AND (deleted IS NULL OR deleted = 0)', deckId);
  const todo = list.filter((s) => force || !s.stageJson);
  let built = 0, failed = 0;
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (sl) => {
      const story = sl.story ? stories.get(sl.story) : undefined;
      let blogSources: BlogSource[] = [];
      let articleSources: ArticleSource[] = [];
      try { blogSources = JSON.parse(story?.blogSources || '[]'); } catch {}
      try { articleSources = JSON.parse(story?.articleSources || '[]'); } catch {}
      let keyPoints: string[] = [];
      try { keyPoints = JSON.parse(sl.keyPoints || '[]'); } catch {}
      const stage: StoryStage | null = await generateStageForStory({
        headline: sl.topicLabel || story?.headline || '',
        status: story?.status || '',
        sourceName: sl.bestSourceName || '',
        sourceLines: stageSourceLines(blogSources, articleSources),
        script: sl.teleprompterScript || '',
        keyPoints: Array.isArray(keyPoints) ? keyPoints.map(String) : [],
        whyItMatters: sl.whyItMatters || '',
      });
      if (stage) { slides.update(sl.id, { stageJson: JSON.stringify(stage) }); built++; } else failed++;
    }));
  }
  return { built, failed, skipped: list.length - todo.length };
}

export async function buildDeckFromStories(
  write: (chunk: string) => void | Promise<void>,
  opts: { template?: string } = {},
): Promise<{ success: boolean; slidesCreated: number; deckId: string; message: string }> {
    const prog = async (msg: string, pct: number) => { await write(JSON.stringify({ message: msg, percent: pct })); };

    await prog('Loading stories marked for deck…', 5);

    const today = todayDate();
    const chosen = stories.where('deck_date = ? AND added_to_deck = 1', today);

    if (chosen.length === 0) {
      await prog('No stories added to deck yet. Select stories above and click "Build presentation".', 100);
      return { success: true, slidesCreated: 0, deckId: '', message: 'No stories added to deck.' };
    }

    const sorted = [...chosen].sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
    await prog(`Building deck from ${sorted.length} stories. Clearing previous slides…`, 12);

    // Get or create today's deck
    let deck = decks.where('deck_date = ? ORDER BY created_at DESC LIMIT 1', today)[0];
    if (deck) {
      for (const s of slides.where('deck_id = ?', deck.id)) slides.remove(s.id);
      // Jake picks the template before every build (2026-10-06: "every new deck asks you for the template you want first")
      if (opts.template !== undefined) decks.update(deck.id, { template: opts.template });
    } else {
      // A new day's deck takes the template picked for this build, else the look Jake last picked; none = his brand.
      const lastLook = decks.where("template IS NOT NULL AND template != '' ORDER BY created_at DESC LIMIT 1")[0]?.template ?? "";
      deck = decks.insert({ deckDate: today, totalSlides: 0, template: opts.template ?? lastLook });
    }

    await prog(`Deck ready. Generating presenter notes + scripts for ${sorted.length} stories…`, 18);

    const slideRecords: Partial<SlideRecord>[] = [];
    // Each slide's video as found, aligned with slideRecords — made unique across the deck below.
    const videoFound: { story: (typeof sorted)[number]; result: VideoResult | null }[] = [];
    const NOTE_BATCH = 4;

    for (let i = 0; i < sorted.length; i += NOTE_BATCH) {
      const batch = sorted.slice(i, i + NOTE_BATCH);

      // Generate notes AND teleprompter scripts in parallel per story
      const resultsArr = await Promise.all(batch.map(async (story, j) => {
        let blogSources: BlogSource[] = [];
        let articleSources: ArticleSource[] = [];
        try { blogSources = JSON.parse(story.blogSources || '[]'); } catch {}
        try { articleSources = JSON.parse(story.articleSources || '[]'); } catch {}

        // The biggest outlet that ran it AND that a logged-out viewer can read
        // (access.ts — no sign-in/subscription walls on screen, Jake 2026-10-02).
        // The same pick is what the script credits and what the source tab opens.
        const pick = await pickReadableSource(blogSources, articleSources, story.headline || '');
        if (pick.skipped.length) {
          console.log(`[news:sources] "${(story.headline || '').slice(0, 60)}": skipped ${pick.skipped.map(x => `${x.name} (${x.reason})`).join('; ')} → ${pick.best?.name ?? 'no readable source'}`);
        }
        const sourceName = pick.best?.name ?? '';

        const [notes, teleprompterScript, video] = await Promise.all([
          generateNotesForStory(story.headline || '', story.status || '', blogSources, articleSources),
          generateScriptForStory(story.headline || '', blogSources, articleSources, sourceName, i + j),
          // The official release video (video.ts). Never fails the deck.
          findVideoForStory(story).catch(() => null),
        ]);

        // The story's on-screen stage (stage.ts): cover + Deep Dive-style scenes
        // whose beats follow the script, so it runs after the script exists.
        const stage = await generateStageForStory({
          headline: story.headline || '',
          status: story.status || '',
          sourceName,
          sourceLines: stageSourceLines(blogSources, articleSources),
          script: teleprompterScript,
          keyPoints: notes.keyPoints,
          whyItMatters: notes.whyItMatters,
        });

        return { notes, teleprompterScript, blogSources, articleSources, video, best: pick.best, stage };
      }));

      batch.forEach((story, j) => {
        const { notes, teleprompterScript, blogSources, articleSources, video, best, stage } = resultsArr[j];
        videoFound.push({ story, result: video });

        const officialBlog = blogSources.find(b => b.isOfficial) ?? blogSources[0];

        const allSources = [
          ...blogSources.map(b => ({ url: b.url, source: b.company, type: 'blog', official: b.isOfficial })),
          ...articleSources.map(a => ({ url: a.url, source: a.outlet, type: 'article', official: false })),
        ];

        const contentLines = [
          officialBlog ? `<p><strong>${officialBlog.company}:</strong> ${officialBlog.title}</p>` : '',
          ...articleSources.slice(0, 3).map(a => `<p>${a.outlet}: ${a.title}</p>`),
        ].filter(Boolean);
        const fullContentHtml = contentLines.join('\n') || `<p>${story.headline || ''}</p>`;

        slideRecords.push({
          topicLabel: story.headline,
          deck: deck!.id,
          story: story.id,
          position: i + j + 1,
          sourcesCount: story.sourceCount ?? allSources.length,
          bestSourceType: 'Article',
          bestSourceName: best?.name ?? '',
          bestSourceHandle: best?.name ?? '',
          bestSourceUrl: best?.url,
          publishedAt: story.firstSeenAt,
          fullContentHtml,
          allSourcesJson: JSON.stringify(allSources),
          avgRelevanceScore: story.compositeScore ?? 0,
          whyItMatters: notes.whyItMatters,
          keyPoints: JSON.stringify(notes.keyPoints),
          talkingAngle: notes.talkingAngle,
          suggestedTimeSeconds: notes.suggestedTimeSeconds,
          teleprompterScript,
          stageJson: stage ? JSON.stringify(stage) : undefined,
          favorited: false,
          deleted: false,
          ...slideVideoFields(video),
        });
      });

      await prog(
        `Notes + scripts: ${Math.min(i + NOTE_BATCH, sorted.length)}/${sorted.length}`,
        18 + Math.round(70 * Math.min(i + NOTE_BATCH, sorted.length) / sorted.length),
      );
    }

    // No video twice in one deck (video.ts `uniqueVideos`): an earlier slide
    // keeps its pick, a later clashing one gets the next-best fit or none.
    const unique = await uniqueVideos(videoFound);
    unique.forEach((r, k) => { if (r !== videoFound[k].result) Object.assign(slideRecords[k], slideVideoFields(r)); });

    // Bulk create slides
    slides.insertMany(slideRecords as Record<string, unknown>[]);
    decks.update(deck!.id, { totalSlides: slideRecords.length });

    await prog(`Done! ${slideRecords.length} slides built with presenter notes and teleprompter scripts.`, 100);
    return { success: true, slidesCreated: slideRecords.length, deckId: deck!.id, message: `Created ${slideRecords.length} slides` };
}

