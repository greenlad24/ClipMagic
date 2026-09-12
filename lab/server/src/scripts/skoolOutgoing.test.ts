/**
 * The pre-send gate on everything the Skool agent writes (skool/outgoing).
 *
 * ⚠️⚠️ HALF OF THESE TESTS ARE THE FALSE POSITIVES, AND THEY MATTER MORE THAN
 * THE CATCHES. A guard that refuses honest text stops the agent posting, which
 * is the failure Jake has actually experienced ("you said it's going to work
 * last time. And it didn't work"). "ChatGPT Plus is $20 a month", "I made this
 * in 3 hours", a Make.com homepage link and the word "Make" in a course title
 * beside a price all have to pass, or the check gets switched off within a week.
 *
 * Pure module — no DB, no browser, no network. Run:
 *   cd lab && docker build -f Dockerfile --target server -t X . &&
 *   docker run --rm -w /build/server X node dist/scripts/skoolOutgoing.test.js
 */
import assert from "node:assert/strict";
import { checkOutgoing, linksIn, normaliseUrl, repairInstruction } from "../skool/outgoing.js";
import { echoedWords } from "../skool/voice.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

const COMMUNITY = "https://www.skool.com/ai-automation-mastery";
const LESSON = `${COMMUNITY}/classroom/20abb1f4?md=8e2f1c`;
const OTHER_LESSON = `${COMMUNITY}/classroom/25737100?md=aa11bb`;

const post = (text: string, extra: Record<string, unknown> = {}) =>
  checkOutgoing(text, { surface: "post", communityUrl: COMMUNITY, ...extra } as any);
const dm = (text: string, extra: Record<string, unknown> = {}) =>
  checkOutgoing(text, { surface: "dm", communityUrl: COMMUNITY, ...extra } as any);

const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);

/* ── a real-shaped post passes ─────────────────────────────────── */

const GOOD_POST = [
  "Alright... quick question.",
  "",
  "Most people open ChatGPT and ask it to 'write something good'. Then they wonder why the answer is generic.",
  "",
  "🔥 The fix is boring: tell it who it is writing for.",
  "",
  "ChatGPT Plus has a paid tier, but everything here works on the free plan.",
  "The Make Images with AI course covers the same idea for prompts:",
  "👉 " + LESSON,
  "",
  "What are you stuck on this week? Drop it below 👇",
].join("\n");

check("a real-shaped post passes, price and course title and all", () => {
  const r = post(GOOD_POST, { allowedUrls: [LESSON] });
  assert.equal(r.ok, true, r.detail);
});

check("'Make Images with AI' near a price is not an earnings claim", () => {
  // The exact false positive a wide keyword window produces: "Make" sits 60
  // characters from "$20". It must come back as a price to hedge, never as a
  // claim about what somebody earns.
  const r = post("The Make Images with AI course is free. ChatGPT Plus is $20 a month.");
  assert.deepEqual(rules(r), ["tool-price"]);
});

/* ── money ─────────────────────────────────────────────────────── */

check("an income claim is refused", () => {
  const r = post("I made $5,000 a month with this workflow last year.");
  assert.deepEqual(rules(r), ["earnings"]);
});

check("an income claim with no verb beside it is still refused by the noun", () => {
  assert.ok(rules(post("That took monthly revenue to $12,000 without ads.")).includes("earnings"));
});

check("'six figures' is an income claim", () => {
  assert.ok(rules(post("This is how members get to six figures.")).includes("earnings"));
});

check("a price on the community is refused", () => {
  const r = dm("Everything else is on the paid side — the community is $47 a month.");
  assert.deepEqual(rules(r), ["offer-price"]);
});

check("a third-party price stated as fact is refused", () => {
  // Jake, 2026-08-28: "Don't state tool pricing or feature claims as fact."
  assert.deepEqual(rules(post("Claude Pro is $20 a month, so grab that first.")), ["tool-price"]);
});

check("the same price with a hedge passes", () => {
  assert.equal(
    post("Claude Pro is around $20 a month last I checked — check their pricing page for the current plans.").ok,
    true,
  );
});

check("what an automation costs is still sayable — the Tuesday post is required to say it", () => {
  assert.equal(
    post(
      "What it costs: Make.com has a free tier that covers this, and the OpenAI call is fractions of a cent. " +
        "Prices change, so check their pricing page before you build it out.",
    ).ok,
    true,
  );
});

check("a time-saved claim is refused", () => {
  assert.ok(rules(post("It saves you 20 hours a week, every week.")).includes("earnings"));
});

check("'I made this in 3 hours' is not a claim", () => {
  assert.equal(post("I made this in 3 hours on a Sunday and it still runs.").ok, true);
});

check("a results multiplier is refused", () => {
  assert.ok(rules(post("This will 10x your revenue in a quarter.")).includes("earnings"));
});

check("'2x faster' is not a results claim", () => {
  assert.equal(post("It renders about 2x faster than the old way.").ok, true);
});

check("a discount and urgency are refused", () => {
  assert.deepEqual(rules(post("50% off with promo code AI50 — limited time.")).sort(), ["discount", "discount", "discount"]);
});

/* ── placeholders ──────────────────────────────────────────────── */

check("an unfilled placeholder is refused", () => {
  assert.deepEqual(rules(post("Here is the {{title}} you asked for.")), ["placeholder"]);
});

check("the model talking about itself is refused", () => {
  assert.ok(rules(dm("As an AI I can't open that link for you.")).includes("placeholder"));
});

/* ── placeholders inside a demonstrated prompt ──────────────────── */
/**
 * ⚠️ THE FIXTURE IS THE REAL REFUSED REPLY. On 2026-09-01 the agent answered a
 * member who was tired of hand-scraping Craigslist, showed him what to type at
 * an agentic browser, and the placeholder rule refused the whole message for the
 * two blanks that make a demonstrated prompt reusable. It was recorded as
 * `skipped` and left for Jake, who does not read the queue. Jake, 2026-09-02:
 * "placeholders are ok when you demonstrate a prompt."
 */
const FRED_REPLY = [
  "Hey Fred, this is a good one to hand off — and honestly the way to do it in 2026 is different from what it was even a year ago.",
  "",
  "The old answer was a Make.com scenario wired to a paid scraper, and yeah, those bleed you dry on subscriptions and break the second Facebook changes their layout.",
  "",
  "1. Agentic browsers. Perplexity's Comet and ChatGPT's agent mode can actually open a browser, go to a search page, read the listings and pull them back into a list for you. You tell it \"go to Craigslist, search [your terms] in [your city], give me title, price and link for anything posted today\" and it does the point-click-read part for you.",
  "",
  "2. A saved search that pushes to you instead of you pulling. Craigslist still has RSS feeds on any search results page.",
].join("\n");

check("the real refused reply — a prompt demonstrated in quotes — now passes", () => {
  const r = dm(FRED_REPLY, { allowedMentions: ["Fred"] });
  assert.equal(r.ok, true, r.detail);
});

check("a blank inside backticks is a demonstration, not a defect", () => {
  assert.equal(dm("Type `summarise [your topic] in five bullets` and it will.").ok, true);
});

check("a Make mapping quoted as an example passes", () => {
  assert.equal(post('In the subject field put "New enquiry from {{1.name}}" and map it.').ok, true);
});

check("the same blank in plain prose is still refused", () => {
  // Nothing else in this sentence trips a rule, so the list is the proof.
  assert.deepEqual(rules(dm("Put [your email] into the form field before saving.")), ["placeholder"]);
});

check("quoting an unfinished note does not make it sendable", () => {
  assert.ok(rules(post('The next step is "TODO: write this bit".')).includes("placeholder"));
});

check("an unclosed quote cannot disarm the rule for the rest of the text", () => {
  // The opening quote has no partner on its own line; without the blank-line and
  // length bounds the span would run to the end and swallow the real placeholder.
  const text = 'He said "here we go\n\nNow put [your name] at the top and send it.';
  assert.ok(rules(post(text)).includes("placeholder"));
});

check("a quoted span longer than the ceiling is not a demonstration", () => {
  const long = "x".repeat(620);
  assert.ok(rules(post(`He wrote "${long} [your city]" in the doc.`)).includes("placeholder"));
});

check("a refusal produces repair instructions naming the fragment", () => {
  const r = dm("Put [your email] into the form field before saving.");
  const note = repairInstruction(r);
  assert.ok(note.includes("[your email]"), note);
  assert.ok(/refused/i.test(note));
  assert.equal(repairInstruction(dm("Nothing wrong with this one at all.")), "");
});

/* ── links ─────────────────────────────────────────────────────── */

check("a bare tool name is not a link", () => {
  assert.deepEqual(linksIn("we teach Make.com and Zapier here").length, 0);
});

check("a schemeless link with a path is still a link", () => {
  assert.equal(linksIn("👉 skool.com/ai-automation-mastery/classroom/x")[0].url, "skool.com/ai-automation-mastery/classroom/x");
});

check("a shortener is refused", () => {
  assert.deepEqual(rules(post("Grab it here: https://bit.ly/3xamPl3")), ["link"]);
});

check("an affiliate tag is refused", () => {
  assert.deepEqual(rules(post("Get it at https://tool.com/pricing?aff=jake123")), ["link"]);
});

check("a placeholder domain is refused", () => {
  assert.deepEqual(rules(post("Put your webhook at https://example.com/hook and save.")), ["link"]);
});

check("another community on skool.com is refused", () => {
  assert.deepEqual(rules(post(`Worth a look: https://www.skool.com/some-other-community/about`)), ["link"]);
});

check("a lesson link that was never shown to the drafter is refused", () => {
  const r = post(`The answer is in this lesson: ${OTHER_LESSON}`, { allowedUrls: [LESSON] });
  assert.deepEqual(rules(r), ["link"]);
});

check("a lesson link that WAS shown passes", () => {
  assert.equal(post(`The answer is in this lesson: ${LESSON}`, { allowedUrls: [LESSON] }).ok, true);
});

check("the plans page is always allowed — the upgrade nudge is required to link it", () => {
  assert.equal(dm(`That one is on the paid side: ${COMMUNITY}/plans`, { allowedUrls: [] }).ok, true);
});

check("a non-skool link is not gated by allowedUrls — the MCP post links real services", () => {
  assert.equal(post("Sign in at https://make.com/en/login and connect Sheets.", { allowedUrls: [] }).ok, true);
});

check("no allowedUrls means community links are not gated at all", () => {
  // ⚠️ undefined and [] are opposite instructions, the same as allowedCourseSlugs.
  assert.equal(post(`Lesson: ${OTHER_LESSON}`).ok, true);
  assert.equal(post(`Lesson: ${OTHER_LESSON}`, { allowedUrls: [] }).ok, false);
});

check("normaliseUrl ignores scheme, www and a trailing slash", () => {
  assert.equal(normaliseUrl("https://www.skool.com/x/"), normaliseUrl("skool.com/x"));
});

/* ── mentions ──────────────────────────────────────────────────── */

check("mentioning somebody who is not in the conversation is refused", () => {
  assert.deepEqual(rules(dm("@Sarah asked the same thing last week.")), ["mention"]);
});

check("the person being answered may be named", () => {
  assert.equal(dm("@Sarah that one is in the beginners course.", { allowedMentions: ["Sarah"] }).ok, true);
});

check("Jake's own handle is always allowed", () => {
  assert.equal(post("Subscribe over at @Jake.Dawson for the full walkthrough.").ok, true);
});

check("an email address is not read as a mention", () => {
  assert.equal(rules(dm("Send it to support@skool.com if it happens again.")).includes("mention"), false);
});

/* ── length ────────────────────────────────────────────────────── */

check("a runaway generation is refused", () => {
  const r = post("a".repeat(5001));
  assert.deepEqual(rules(r), ["length"]);
});

check("a long step-by-step reply is not — RULE 3 is overridden for replies", () => {
  assert.equal(checkOutgoing("step. ".repeat(600), { surface: "comment" }).ok, true);
});

/* ── the reason is readable ────────────────────────────────────── */

check("a refusal names the rule and quotes the fragment", () => {
  const r = post("I made $5,000 a month doing this.");
  assert.match(r.detail, /earnings/);
  assert.match(r.detail, /\$5,000/);
});


/* ── commitments, confidences, and what a regex cannot do ──────── */

check("a promise about future content is refused", () => {
  assert.deepEqual(rules(post("Great question — I'll cover that next week.")), ["commitment"]);
});

check("an offer to do the work is refused", () => {
  assert.ok(rules(dm("Send it over and I'll take a look for you.")).includes("commitment"));
});

check("free access is refused", () => {
  assert.ok(rules(dm("Tell you what, I'll let you in for free this once.")).includes("commitment"));
});

check("a guarantee is refused", () => {
  assert.ok(rules(post("Do this and I promise it will work.")).includes("commitment"));
});

check("a commitment inside quotation marks is a script, not a promise", () => {
  // ⚠️ MEASURED, NOT IMAGINED: the only commitment ever found in a real reply
  // was this exact sentence, teaching a member what not to say to a prospect.
  const r = dm('"Here\'s what it\'d look like for your business" beats "I can build you something" every time.');
  assert.equal(r.ok, true, r.detail);
});

check("the same words unquoted are still refused", () => {
  assert.ok(rules(dm("I can build you something if you send it over and I'll take a look.")).includes("commitment"));
});

check("how the channel is run is refused", () => {
  assert.deepEqual(rules(dm("My editor puts those together, not me.")), ["confidential"]);
});

check("sponsorship is refused", () => {
  assert.ok(rules(dm("That one was sponsored, so I had to say it.")).includes("confidential"));
});

check("repeating another member's DM is refused", () => {
  assert.ok(rules(dm("Another member told me the same thing yesterday.")).includes("confidential"));
});

check("implying access to billing is refused", () => {
  assert.ok(rules(dm("I can see your billing — it went through fine.")).includes("confidential"));
});

check("ordinary teaching prose survives all of it", () => {
  // ⚠️ THE TEST THAT MATTERS MOST. Everything above adds a way to refuse; this
  // is the one that fails if the guard has quietly become a wall.
  const ordinary = [
    "Hey Dawn, honestly the fastest way in is to build one scenario end to end.",
    "Start with the free plan — it's plenty to learn on.",
    "Pick something boring: save Gmail attachments into Drive, or post an RSS feed to Discord.",
    "You'll break it a few times, and that's the whole skill. Mapping data between modules is where everyone gets stuck.",
    "Once one scenario runs on its own, it clicks.",
  ].join("\n");
  const r = dm(ordinary, { allowedMentions: ["Dawn"] });
  assert.equal(r.ok, true, r.detail);
});

/* ── the drafter arguing with its own draft ─────────────────────── */
/**
 * ⚠️ THE FIXTURE IS THE REAL REFUSED POST. On 2026-09-06 the video announcement
 * for "7 Claude Skills That Actually Save Time" came back from its repair pass
 * with the refused classroom link STILL in it and the model's own second thought
 * typed in after it. Only the link rule caught that draft — so a version that
 * dropped the URL and kept the sentence would have gone out to 73 members
 * reading "Wait — that lesson link isn't one I can use". The day was abandoned
 * on `attempts` 1 of 12 and the video was never announced.
 */
check("the drafter's own second-guessing is refused", () => {
  const drafted = [
    "New one's live, and it's on Claude Skills.",
    "",
    "Watch it here: https://www.youtube.com/watch?v=SjTlCJ6IXHc",
    "",
    "And go through this first — it'll make the video land harder: 👉 " + LESSON,
    "Wait — that lesson link isn't one I can actually point you at.",
  ].join("\n");
  // Grounded, so the LINK rule has nothing to say and only the self-talk is left.
  const r = post(drafted, { allowedUrls: [LESSON] });
  assert.equal(r.ok, false, "the model's aside about its own draft has to be caught on its own");
  assert.ok(rules(r).includes("placeholder"), r.detail);
});

check("naming the check or the grounding is refused", () => {
  assert.ok(rules(post("That URL isn't in my grounding, so here's the short version instead.")).includes("placeholder"));
  assert.ok(rules(post("The pre-send check refused my first go at this.")).includes("placeholder"));
});

check("a real sentence about not linking something still passes", () => {
  // ⚠️ THE FALSE POSITIVE THAT WOULD MATTER. Jake declining to link something is
  // ordinary writing; only text about the DRAFT itself is meant to be caught.
  const ordinary = [
    "I can't link you to it — it's behind their paywall and I'd rather not send you somewhere you can't read.",
    "Wait until the pricing settles before you commit to a year.",
    "Actually, that whole approach is worth a post of its own.",
  ].join("\n");
  const r = post(ordinary);
  assert.equal(r.ok, true, r.detail);
});

check("the repair note tells a refused draft to delete the link and say nothing about it", () => {
  const refused = post(`Go through this one first: ${OTHER_LESSON}`, { allowedUrls: [LESSON] });
  assert.equal(refused.ok, false);
  const note = repairInstruction(refused);
  assert.match(note, /DELETE IT/);
  assert.match(note, /link nothing at all/i);
  assert.match(note, /SEND BACK ONLY THE FINISHED TEXT/);
});

/* ── the conversation rules, from the thread Jake sent on 2026-09-12 ──────────
 *
 * ⚠️ THESE ARE THE REAL MESSAGES, not invented examples. Jake: "in a DM thread
 * I don't want the bot to repeat the idea that the other person said in the
 * first paragraph or at all in the next message... Also I don't want to include
 * the same links twice in a thread." Every fixture below is a line this agent
 * actually sent to Renata Oros on 9 and 10 September 2026.
 */

const NOTEBOOK_LESSON = `${COMMUNITY}/classroom/f3b3941a?md=2764915228374d6eb1d5a56cd9578ee5`;
const UGC_LESSON = `${COMMUNITY}/classroom/f3b3941a?md=ec4d212315c14f4bb2b68482d22a216c`;

const HER_FIRST =
  "Hi! I'm doing great, thank you. I'm a video editor, and I got into AI mainly for work - I wanted to " +
  "use it to help with outreach and finding leads/clients more efficiently. Still learning, but excited " +
  "to see what's possible!";
const HER_SECOND =
  "Thanks for this! My niche is fitness influencers - I'd love to reach out to them for editing work. " +
  "I'm also a UGC creator, so I already have some experience on that side too.";
const HER_THIRD =
  "I usually focus on highlighting my actual results in my pitch because I have them - hitting 2.6M " +
  "views with clients has been a great piece of social proof for me so far.";

check("the opener that hands her own message back is flagged", () => {
  const r = dm("A video editor getting into AI for outreach — that's a good spot to be in honestly. " +
    "You already know what good looks like on screen.", { theirText: HER_FIRST });
  assert.ok(rules(r).includes("echo"), r.detail);
});

check("⚠️ a decimal does not end the opening sentence — \"2.6M\" hid a restatement", () => {
  // Regression. Splitting on a bare full stop cut this opener at "…play — 2."
  // and reported the loudest restatement in the thread as clean.
  const words = echoedWords("That's a strong hand to play — 2.6M views with real clients is proper social proof.", HER_THIRD);
  assert.ok(words.length >= 3, `only found ${JSON.stringify(words)}`);
});

check("…and so are the other two that actually went out", () => {
  const second = dm("Love this — fitness influencers are a smart niche to pick. They post constantly.",
    { theirText: HER_SECOND });
  assert.ok(rules(second).includes("echo"), second.detail);
  const third = dm("That's a strong hand to play — 2.6M views with real clients is proper social proof.",
    { theirText: HER_THIRD });
  assert.ok(rules(third).includes("echo"), third.detail);
});

check("⚠️ a reply that answers the question may use its words after the first sentence", () => {
  // Both of these are real drafts, written once PATTERN A was withdrawn by name
  // — they open on the answer and then discuss her pitch, because that is what
  // she asked about. A window wider than the first sentence flags both, and
  // then every honest reply pays for a repair pass.
  for (const [text, theirs] of [
    ["The results and the outcome pitch aren't either/or, they work best stacked. 2.6M views for clients is your proof. The outcome is what that number did for those clients.", HER_THIRD],
    ["Both stacked beats picking one. Keep the 2.6M in the pitch, that's the hard proof nobody can argue with.", HER_THIRD],
  ] as [string, string][]) {
    const r = dm(text, { theirText: theirs });
    assert.ok(!rules(r).includes("echo"), `should pass: ${text.slice(0, 60)}… — ${r.detail}`);
  }
});

check("a reply that opens on the answer is not an echo", () => {
  // The same conversation, answered the way Jake asked for: straight into what
  // she does not know. It still has to mention her subject — that is not a
  // restatement, and a check that could not tell the difference would refuse
  // every on-topic reply ever written.
  const r = dm(
    "NotebookLM is the one to start with. Drop their recent captions and a few competitor accounts in, " +
    "then ask it what their audience keeps asking for. You walk in already knowing their content.",
    { theirText: HER_SECOND },
  );
  assert.ok(!rules(r).includes("echo"), r.detail);
});

check("an echo is never a reason to hold the message", () => {
  const r = dm("Love this — fitness influencers are a smart niche to pick.", { theirText: HER_SECOND });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, false, "a restatement must not park a member's reply");
});

check("the same lesson link twice in one thread is flagged", () => {
  const r = dm(`The NotebookLM lesson is the right one to start with:\n${NOTEBOOK_LESSON}`, {
    alreadySentUrls: [NOTEBOOK_LESSON],
  });
  assert.ok(rules(r).includes("repeat-link"), r.detail);
  assert.equal(r.blocked, false);
});

check("⚠️ a DIFFERENT lesson in the SAME course is not a repeat", () => {
  // Both links are `classroom/f3b3941a` and differ only after the `?md=`. This
  // is the test that fails the moment normaliseUrl stops keeping the query,
  // and the failure would suppress a correct second recommendation.
  const r = dm(`And the AI video/UGC lesson is a natural next one for you:\n${UGC_LESSON}`, {
    alreadySentUrls: [NOTEBOOK_LESSON],
  });
  assert.ok(!rules(r).includes("repeat-link"), r.detail);
});

check("a repeat is matched past the scheme, the www and the trailing full stop", () => {
  const bare = NOTEBOOK_LESSON.replace("https://www.", "");
  const r = dm(`Start here: ${bare}.`, { alreadySentUrls: [NOTEBOOK_LESSON] });
  assert.ok(rules(r).includes("repeat-link"), r.detail);
});

check("no already-sent list means no repeat rule — a comment has no history", () => {
  const r = checkOutgoing(`Start here: ${NOTEBOOK_LESSON}`, { surface: "comment", communityUrl: COMMUNITY } as any);
  assert.ok(!rules(r).includes("repeat-link"), r.detail);
});

/* ── Jake's word list, shared with the script generator ──────────────────── */

check("words Jake does not write are flagged", () => {
  for (const [text, word] of [
    ["One caveat before you start.", "caveat"],
    ["It's genuinely weak at technical accuracy.", "genuinely"],
    ["That's a clever way to do it.", "clever"],
    ["So — new folks first, then everyone else.", "folks"],
    ["I'd look at whether it fits your workflow.", "whether"],
  ] as [string, string][]) {
    const r = dm(text);
    assert.ok(rules(r).includes("voice"), `${word} should be flagged: ${r.detail}`);
  }
});

check("⚠️ \"which\" as a QUESTION is Jake's own voice and must survive", () => {
  // Measured over every post this agent has sent: 31 hits, and only 2 are the
  // relative pronoun the rule is about. "Which AI do you actually open every
  // day?" heads the only format in this community that earns comments at all.
  for (const text of [
    "Which AI do you actually open every day?",
    "Tell me which one wins and I'll do a post on the best answers.",
    "If AI could only do ONE job for you — which one?",
    "If you're still deciding which video generator fits what you're making, start here.",
  ]) {
    const r = post(text);
    assert.ok(!rules(r).includes("voice"), `should pass: ${text} — ${r.detail}`);
  }
});

check("…but \"which\" as a join is split into two sentences", () => {
  const r = post("It runs on a schedule, which is handy.");
  assert.ok(rules(r).includes("voice"), r.detail);
});

check("⚠️ \"clip\" is a script rule that does not travel to a conversation", () => {
  // Jake's "call it a video, never a clip" is about how a lesson names the thing
  // it teaches a beginner to make. To a video editor about her own footage,
  // "clips" is simply the word, and all 6 live uses were right.
  const r = dm("Most of these run short clips, so the usual workflow still applies.");
  assert.ok(!rules(r).includes("voice"), r.detail);
});

check("AI-register filler is flagged", () => {
  const r = post("It's worth noting that this is a real game-changer for your workflow.");
  assert.ok(rules(r).includes("voice"), r.detail);
});

check("narrating your own honesty is flagged — both of the live ones", () => {
  for (const text of [
    "Quick honest bit first, because it saves you a headache later.",
    "So here's the honest bit first. There's no push-button way to do this.",
  ]) {
    assert.ok(rules(dm(text)).includes("voice"), text);
  }
});

check("punching down is flagged, describing the world is not", () => {
  assert.ok(rules(post("Most people don't even realise their tools don't talk.")).includes("voice"));
  const fine = post("You've got a calendar, a CRM and a form tool, and they barely speak to each other.");
  assert.ok(!rules(fine).includes("voice"), fine.detail);
});

check("a banned word inside a demonstrated prompt is left alone", () => {
  // Same exemption the placeholder rule has: a prompt he is showing a member how
  // to type is their words about their tool, not his prose.
  const r = dm('Try typing this at it: "list every caveat in this contract and rank them".');
  assert.ok(!rules(r).includes("voice"), r.detail);
});

check("⚠️⚠️ a voice finding fails the check and does NOT block the send", () => {
  const r = dm("That's genuinely useful for what you're building.");
  assert.equal(r.ok, false, "it should earn a repair pass");
  assert.equal(r.blocked, false, "…and it must never make a member wait for a human");
  assert.equal(r.blocking.length, 0);
});

check("…while a real refusal still blocks", () => {
  const r = dm("This will make you $5k a month once it's running.");
  assert.equal(r.blocked, true, r.detail);
  assert.ok(r.blocking.length > 0);
});

check("a mixed draft blocks on the harm and still reports the word", () => {
  const r = dm("One caveat — this will make you $5k a month once it's running.");
  assert.equal(r.blocked, true);
  assert.ok(rules(r).includes("voice"));
  assert.ok(r.blocking.every((v) => v.rule !== "voice"), "the voice finding must not be in `blocking`");
});

check("the repair note explains all three new kinds", () => {
  const r = dm(`One caveat, and here it is again: ${NOTEBOOK_LESSON}`, {
    alreadySentUrls: [NOTEBOOK_LESSON],
    theirText: "caveat here it is again",
  });
  const note = repairInstruction(r);
  assert.match(note, /the catch is/);
  assert.match(note, /already sent in this conversation/);
  assert.match(note, /cut the whole first sentence/);
});

check("the good post still passes every new rule", () => {
  const r = post(GOOD_POST);
  assert.equal(r.ok, true, r.detail);
});

console.log(`\n${passed} checks passed`);
