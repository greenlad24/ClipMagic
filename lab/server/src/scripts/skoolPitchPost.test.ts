/**
 * Unit checks for the services-pitch screen on members' posts
 * (skool/engageGen → looksLikeServicesPitch).
 *
 * ⚠️ WHY THIS EXISTS. The "comment on members' posts" surface was armed with a
 * vendor advert sitting at the top of the feed — a dev shop listing its stack
 * and asking for clients. Jake's comment is the first thing anyone reads under a
 * post, so the ordinary warm reply the drafter would have written reads as him
 * recommending them to his own members. Jake, 2026-09-20: "welcome, don't engage
 * the pitch."
 *
 * The screen only picks which drafting branch runs, so the cost of the two
 * mistakes is deliberately lopsided: a false positive is a welcome that leaves
 * one sentence out, a false negative is the behaviour we had anyway. These cases
 * guard the line between an ADVERT and the two things that look like one — a
 * member introducing themselves who happens to freelance, and a win post with a
 * list of tools in it.
 *
 * Runs against a throwaway DATA_DIR, so importing engageGen (which opens the
 * sqlite db via db/index) never touches real lab data, and nothing here reaches
 * the network, the model or the browser. Run:
 *   cd lab/server && npx tsx src/scripts/skoolPitchPost.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-pitch-post-"));
  process.env.DATA_DIR = root;
  process.env.DB_PATH = path.join(root, "db", "test.db");
  fs.mkdirSync(path.join(root, "db"), { recursive: true });

  const { looksLikeServicesPitch } = await import("../skool/engageGen.js");

  // The post the screen was written for, abbreviated. Note what it does NOT
  // contain: no "DM me", no rates, no link. It is polite, it thanks the admin,
  // and it is still an advert — which is why the offering phrases alone were
  // never going to be enough.
  const theAdvert = [
    "A CTO from Tokyo is currently writing this message.",
    "I'm based in Tokyo, Japan and work mainly across AI, full-stack development, SaaS and automation.",
    "First, big thanks to the ADMIN for building this community.",
    "Most of my work is with global clients, usually founders or companies building something real.",
    "Main areas I work in:",
    "• AI agents and multi-agent systems",
    "• LLM apps, RAG, AI search",
    "• Business automation and internal AI tools",
    "• SaaS platforms",
    "• Web applications",
    "• Mobile apps",
    "Typical tech stack: React, Next.js, Python, FastAPI, PyTorch.",
  ].join("\n");

  await check("the advert reads as a pitch", () => {
    assert.equal(looksLikeServicesPitch(theAdvert), true);
  });

  await check("a short pitch with no list is still a pitch", () => {
    // Seller's self-description plus an ask for work, and nothing else. The
    // catalogue test would never fire on this one.
    assert.equal(
      looksLikeServicesPitch("I build AI agents for founders who are sick of doing it by hand. DM me if you want one."),
      true,
    );
  });

  await check("an introduction from someone who happens to freelance is NOT a pitch", () => {
    // ⚠️ THE ONE THAT MATTERS MOST. Half this community freelances; saying so
    // while introducing yourself is not advertising, and this member should get
    // the ordinary welcome with a real question back.
    assert.equal(
      looksLikeServicesPitch(
        "Hi everyone, I'm Sarah. I'm a freelance designer and I've never touched automation before — here to learn. Excited to be here!",
      ),
      false,
    );
  });

  await check("a win post with a list of tools in it is NOT a pitch", () => {
    // Bullets are how people show their work. Shape without intent is nothing.
    assert.equal(
      looksLikeServicesPitch(
        [
          "Finally got my first automation running!",
          "It watches a Gmail label and files everything into Notion. Took me three evenings.",
          "- Make.com",
          "- Gmail",
          "- Notion",
          "- ChatGPT for the summaries",
          "- Google Sheets as a backup",
          "- Slack for the alert",
          "Chuffed with it. What should I build next?",
        ].join("\n"),
      ),
      false,
    );
  });

  await check("a plain question is NOT a pitch", () => {
    assert.equal(
      looksLikeServicesPitch("Which AI do you use for writing emails? I keep going back and forth between ChatGPT and Claude."),
      false,
    );
  });

  await check("a catalogue with no seller behind it is NOT a pitch", () => {
    // "What I do" as a hobby list, from someone asking where to start.
    assert.equal(
      looksLikeServicesPitch(
        ["What I do all day:", "- school run", "- emails", "- invoices", "- chasing quotes", "- stock counts", "- the socials", "Which of these can AI take off me?"].join("\n"),
      ),
      false,
    );
  });

  await check("empty text is not a pitch, and does not throw", () => {
    assert.equal(looksLikeServicesPitch(""), false);
    assert.equal(looksLikeServicesPitch("   \n  "), false);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

void main();
