import { z } from 'zod';
import { createEndpoint, Projects, MusicTracks, Shots, ZiteError } from 'zite-integrations-backend-sdk';
import OpenAI, { toFile } from 'openai';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract http/https URLs from a string */
function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s,)"']+/g) ?? [];
  return [...new Set(matches)];
}

/** Convert a numeric 0–100 intensity value to a display label */
function numericToIntensityLabel(n: number): string {
  if (n >= 90) return 'peak';
  if (n >= 70) return 'massive';
  if (n >= 40) return 'major';
  if (n >= 15) return 'minor';
  return 'baseline';
}

// ── Legacy 8-window formula (fallback only) ───────────────────────────────────
const BROLL_FORMULA_WINDOWS = [
  { insert: 1, label: 'Hook',           start: 1,  end: 3,  intensity: 'major'   },
  { insert: 2, label: 'Re-engage',      start: 7,  end: 10, intensity: 'major'   },
  { insert: 3, label: 'Emphasis',       start: 19, end: 23, intensity: 'major'   },
  { insert: 4, label: 'Major spike',    start: 31, end: 34, intensity: 'massive' },
  { insert: 5, label: 'Climax',         start: 51, end: 53, intensity: 'peak'    },
  { insert: 6, label: 'Quick punch',    start: 67, end: 68, intensity: 'major'   },
  { insert: 7, label: 'Extended drama', start: 70, end: 77, intensity: 'major'   },
  { insert: 8, label: 'CTA / outro',    start: 81, end: 85, intensity: 'massive' },
] as const;

// ── Semantic beat types ───────────────────────────────────────────────────────

type SemanticBeat = {
  start: number;
  end: number;
  beatType: string;
  summary: string;
  productEntity?: string;
  featureEntity?: string;
  emotionalIntent?: string;
  visualIntent: 'talking_head' | 'screencast' | 'tactical_broll';
  showNarrator: boolean;
  overlayDelaySeconds: number;
  priority: number;
  transcriptSnippet: string;
  matchKeywords: string[];
  isRequiredTacticalSlot?: boolean;
  tacticalPlacementReason?: string;
  rationale?: string;
  brollPrompt?: string;
};

type ShotRec = {
  caption?: string; project?: string; shotType?: string; beat?: string;
  beatCount?: number; startTime?: number; endTime?: number;
  targetUrl?: string; targetSelector?: string; uiLabelsJson?: string;
  transitionIn?: string; sfxIn?: string; captureStatus?: string;
};

interface ResearchedUrl { name: string; url: string; use: string; }

/** Map beatType → the beat field used in the Shots DB */
function beatTypeToDbBeat(bt: string): string {
  const map: Record<string, string> = {
    hook: 'Hook', pain: 'Setup', problem: 'Setup', proof: 'Demo',
    demo: 'Demo', objection: 'Setup', payoff: 'Payoff', cta: 'CTA', transition: 'Setup',
  };
  return map[bt] ?? 'Demo';
}

/** Pick best URL from research list for a given product/feature entity */
function resolveUrlForEntity(entity: string | undefined, researchedUrls: ResearchedUrl[]): string | undefined {
  if (!entity || !researchedUrls.length) return undefined;
  const lower = entity.toLowerCase();
  const match = researchedUrls.find(r => r.name.toLowerCase().includes(lower) || lower.includes(r.name.toLowerCase()));
  if (match) return match.url;
  // Fallback: first screencast URL
  const sc = researchedUrls.find(r => r.use === 'screencast');
  return sc?.url;
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

export default createEndpoint({
  authenticated: true,
  description: 'Transcribe narration, generate subtitles, research URLs, semantic-beat-based director, subtle TH camera animation. Media generation handled by captureShots.',
  inputSchema: z.object({ projectId: z.string() }),
  outputSchema: z.object({ success: z.boolean(), shotCount: z.number() }),
  execute: async ({ input, context }) => {
    const client = new OpenAI({ apiKey: process.env.ZITE_OPENAI_ACCESS_TOKEN });
    const { projectId } = input;

    const project = await Projects.findOne({ id: projectId });
    if (!project) throw new ZiteError({ code: 'NOT_FOUND', message: 'Project not found' });

    const transcriptSourceUrl = project.audioUrl || project.narrationUrl || '';
    if (!transcriptSourceUrl) {
      throw new ZiteError({
        code: 'BAD_REQUEST',
        message: `Project has no audio or narration URL — audioUrl="${project.audioUrl ?? ''}", narrationUrl="${project.narrationUrl ?? ''}"`,
      });
    }

    // ── Phase 1: Transcribe ───────────────────────────────────────────────────
    await Projects.update({ id: projectId, record: { status: 'Transcribing' } });

    let audioRes: Response;
    try {
      audioRes = await fetch(transcriptSourceUrl);
    } catch (e: any) {
      await Projects.update({ id: projectId, record: { status: 'Error', validationErrors: 'Could not fetch audio for transcription' } });
      throw new ZiteError({ code: 'INTERNAL_ERROR', message: 'Could not fetch audio: ' + (e.message ?? String(e)) });
    }
    if (!audioRes.ok) {
      await Projects.update({ id: projectId, record: { status: 'Error', validationErrors: `Audio fetch failed: HTTP ${audioRes.status}` } });
      throw new ZiteError({ code: 'INTERNAL_ERROR', message: `Failed to fetch audio (HTTP ${audioRes.status})` });
    }

    const buffer = Buffer.from(await audioRes.arrayBuffer());
    const isWav = !!project.audioUrl;
    const audioExt = isWav ? 'wav' : 'mp4';
    const audioMime = isWav ? 'audio/wav' : 'video/mp4';
    const audioFile = await toFile(buffer, `narration.${audioExt}`, { type: audioMime });

    let transcription: any;
    try {
      transcription = await (client.audio.transcriptions.create as any)({
        model: 'whisper-1',
        file: audioFile,
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });
    } catch (e: any) {
      await Projects.update({ id: projectId, record: { status: 'Error', validationErrors: 'Transcription failed: ' + (e.message ?? String(e)) } });
      throw new ZiteError({ code: 'INTERNAL_ERROR', message: 'Transcription failed: ' + (e.message ?? String(e)) });
    }

    const words: Array<{ word: string; start: number; end: number }> = transcription.words ?? [];
    const duration: number = transcription.duration ?? 60;
    const fullText: string = transcription.text ?? '';
    const transcriptForPrompt = words.length
      ? words.map((w) => `[${w.start.toFixed(2)}s] ${w.word}`).join(' ')
      : fullText;

    const shortTitle = fullText.split(' ').slice(0, 8).join(' ') + (fullText.split(' ').length > 8 ? '…' : '');

    // ── Phase 1.4: Generate subtitle events ──────────────────────────────────
    interface SubtitleWord { text: string; start: number; end: number; emphasis: boolean; }
    interface SubtitleEvent { start: number; end: number; words: SubtitleWord[]; placement: 'center' | 'lower'; lines: number; }

    const subtitleEvents: SubtitleEvent[] = [];

    if (words.length > 0) {
      const phraseGroups: Array<Array<{ word: string; start: number; end: number }>> = [];
      let currentGroup: Array<{ word: string; start: number; end: number }> = [];

      // Hormozi-style captions: SHORT punchy chunks — at most 3 words, and only
      // 2 when the words are long (so a caption never runs off the frame).
      // Also break on a real pause or sentence/clause punctuation.
      const CHARS_2WORD_LIMIT = 13; // if total chars would exceed this, cap at 2 words
      const wlen = (g: Array<{ word: string }>) =>
        g.reduce((n, w) => n + w.word.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
      for (let i = 0; i < words.length; i++) {
        currentGroup.push(words[i]);
        const nextW = words[i + 1];
        const gap = nextW ? nextW.start - words[i].end : Infinity;
        const endsSentence = /[.!?…]$/.test(words[i].word.trim());
        const endsClause = /[,;:]$/.test(words[i].word.trim());
        // Long-word cap: once we have 2 words and they're already wide, break
        // (don't add a 3rd). A "long" caption is one whose letters exceed the
        // 2-word char budget, or where the next word would push it over ~16 chars.
        const curChars = wlen(currentGroup);
        const nextChars = nextW ? nextW.word.replace(/[^\p{L}\p{N}]/gu, "").length : 0;
        const longTwo = currentGroup.length >= 2 && (curChars > CHARS_2WORD_LIMIT || curChars + nextChars > 16);
        if (
          currentGroup.length >= 3 ||
          longTwo ||
          gap > 0.35 ||
          endsSentence ||
          (endsClause && currentGroup.length >= 2)
        ) {
          phraseGroups.push([...currentGroup]);
          currentGroup = [];
        }
      }
      if (currentGroup.length > 0) phraseGroups.push(currentGroup);

      let emphasisIndices = new Set<number>();
      try {
        const wordList = words.map((w, i) => `${i}:${w.word}`).join(' ');
        const emphRes = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Identify emotionally stressed, key, or impactful words for kinetic subtitle emphasis styling.\nReturn ONLY valid JSON: {"emphasis":[2,5,9,14]} — 0-based word indices.\nMark: product names, power verbs, key nouns, charged words, numbers, superlatives.\nDo NOT mark: articles (a, the), prepositions, conjunctions, filler words.\nAim for ~15–25% of total words.`,
            },
            { role: 'user', content: `WORDS (index:word):\n${wordList}` },
          ],
          response_format: { type: 'json_object' },
        });
        const emphData = JSON.parse(emphRes.choices[0]?.message?.content ?? '{}');
        if (Array.isArray(emphData.emphasis)) emphasisIndices = new Set(emphData.emphasis.map(Number));
      } catch (e: any) {
        console.warn('[runPipeline] Subtitle emphasis detection skipped (non-fatal):', e.message);
      }

      let globalWordIndex = 0;
      for (const group of phraseGroups) {
        const swArr: SubtitleWord[] = group.map((w) => ({
          text: w.word,
          start: w.start,
          end: w.end,
          emphasis: emphasisIndices.has(globalWordIndex++),
        }));
        subtitleEvents.push({
          start: swArr[0].start,
          end: swArr[swArr.length - 1].end,
          words: swArr,
          placement: 'center',
          lines: swArr.length > 3 ? 2 : 1,
        });
      }
    }

    const subtitlesJson = subtitleEvents.length ? JSON.stringify(subtitleEvents) : undefined;

    await Projects.update({
      id: projectId,
      record: { transcript: fullText, durationSeconds: duration, title: shortTitle, status: 'Directing', subtitlesJson },
    });

    // ── Phase 1.5: URL Research ───────────────────────────────────────────────
    const hintUrls = extractUrls(project.contextHint ?? '');
    let researchedUrls: ResearchedUrl[] = [];

    try {
      const researchRes = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a web research assistant for a short-form video director.\nGiven a transcript, identify every product, tool, website, software, or service mentioned by name.\nFor each entity, output its real, publicly-accessible URL from your training knowledge.\nAlso suggest 2–3 additional web pages useful as B-roll visuals.\n\nReturn ONLY valid JSON with no markdown fences:\n{"entities":[{"name":"Notion","url":"https://notion.so","use":"screencast"}]}\n\nStrict rules:\n- NEVER output example.com, placeholder.com, localhost, or any invented URL\n- Only include URLs you are confident actually exist\n- Use canonical URLs (no tracking params)\n- "screencast" = primary product page; "broll" = feature/docs/pricing page\n- If pre-supplied URLs are given, include them with "screencast" use at the top`,
          },
          {
            role: 'user',
            content: `TRANSCRIPT:\n${fullText}\n\nCONTEXT HINT: ${project.contextHint ?? 'none'}${
              hintUrls.length
                ? `\n\nPRE-SUPPLIED URLs:\n${hintUrls.map((u) => '  ' + u).join('\n')}`
                : ''
            }\n\nIdentify all products and resolve their real website URLs now.`,
          },
        ],
        response_format: { type: 'json_object' },
      });
      const data = JSON.parse(researchRes.choices[0]?.message?.content ?? '{}');
      researchedUrls = Array.isArray(data.entities) ? data.entities : [];
    } catch (e: any) {
      console.warn('[runPipeline] URL research step failed (non-fatal):', e.message);
    }

    for (const u of hintUrls) {
      if (!researchedUrls.find((r) => r.url === u)) {
        researchedUrls.unshift({ name: 'primary (from context hint)', url: u, use: 'screencast' });
      }
    }

    const urlReferenceBlock = researchedUrls.length
      ? researchedUrls.map((r) => `  [${r.use.toUpperCase()}] ${r.name}: ${r.url}`).join('\n')
      : 'No specific URLs resolved.';

    // ── Phase 2: Resolve music track ──────────────────────────────────────────
    let bpm = 124;
    let trackName = 'Default';
    let trackId = Array.isArray(project.musicTrack) ? project.musicTrack[0] : project.musicTrack;

    if (!trackId) {
      const { records: userTracks } = await MusicTracks.findAll({
        filters: { user: context.user.id, analysisStatus: 'Ready' },
        limit: 5,
      });
      if (userTracks.length) trackId = userTracks[0].id;
    }
    if (trackId) {
      const track = await MusicTracks.findOne({ id: trackId });
      if (track) {
        bpm = track.bpm ?? 124;
        trackName = track.trackName ?? 'Track';
      }
    }

    // ── Phase 3: Semantic Beat Planner ────────────────────────────────────────
    console.log('[runPipeline] ▶ Starting semantic beat planner');

    const semanticBeatPrompt = `You are a senior short-form video editor planning the cuts for a vertical (9:16) talking-head video. You think OUT LOUD about why each choice keeps the viewer watching and how it emphasizes what the narrator is saying.

Your job: split this transcript into SEMANTIC BEATS — meaningful rhetorical segments where the speaker's intent, topic, or energy shifts — and decide, for each beat, whether to stay on the narrator or cut to an overlay.

TRANSCRIPT (word-level timestamps):
${transcriptForPrompt}

DURATION: ${duration.toFixed(1)}s
CONTEXT: ${project.contextHint ?? 'none'}

AVAILABLE PRODUCT / PROMO FOOTAGE you can cut to (screencast shots):
${urlReferenceBlock}

For each beat, decide:
  beatType: one of "hook" | "pain" | "problem" | "proof" | "demo" | "objection" | "payoff" | "cta" | "transition"
  visualIntent: one of "talking_head" | "screencast" | "tactical_broll"
  showNarrator: boolean — should the narrator's face be visible during this beat?
  overlayDelaySeconds: number — ADAPTIVE: on important/personal/authority lines, keep the narrator visible ~1.0s before the overlay enters (grounded); during fast list/proof/demo runs, cut to the overlay almost immediately (0–0.3s) for pace.
  rationale: 1–2 first-person sentences explaining WHY you chose this visual for THESE EXACT WORDS and HOW it emphasizes the narrator's point.
  brollPrompt: ONLY for visualIntent="tactical_broll" — an EXTENSIVE, detailed video-generation prompt (see the tactical_broll rules below).

★ STEP 0 — CLASSIFY THE VIDEO, THEN EDIT TO ITS STRATEGY:
  First read the WHOLE transcript and the AVAILABLE PROMO FOOTAGE list, then pick the ONE category that best fits. Each category has a target footage mix — follow it. The categories (auto-detect the best one):

  1. "product_showcase" — one product/tool is the subject. FOOTAGE-LED: show its promo footage for most demo/feature beats; narrator connects. Target ~55–70% overlay.
  2. "listicle" — "N tools/ways for X". For EACH item, show that product's promo footage (or brand-fitting stock if none). Fast, footage-heavy. Target ~60–70% overlay.
  3. "comparison" — A vs B. Cut between the two products' footage as they're discussed. Target ~55–65% overlay.
  4. "tutorial" — step-by-step using a product. Screencast/promo follows the workflow steps. Target ~60–75% overlay.
  5. "news" — "X just launched Y". Show the new product/feature footage prominently. Target ~50–65% overlay.
  6. "problem_solution" — pain point → the product that fixes it. STOCK for the pain/problem beats, PROMO for the solution/product. Target ~50–60% overlay.
  7. "educational" — teaches a concept. Mostly stock/generated situational visuals; promo only for concrete product examples. Target ~45–60% overlay.
  8. "story_opinion" — personal take / narrative / hot-take. NARRATOR-LEANING, but still CUT ON EVERY CONCRETE NOUN — any nameable product, place, object, or scene gets a quick stock/promo cut. Target ~35–50% overlay.
  9. "hype_promo" — high-energy promo for one product/launch. Maximize its promo footage + punchy stock. Target ~60–75% overlay.
  10. "reaction" — reacting to a thing/trend. Show the thing being reacted to (promo/stock), cut back to narrator for the takes. Target ~45–60% overlay.

  Return your pick as editApproach.category and HIT ITS OVERLAY TARGET. "Balanced" is the floor — across the whole video aim for roughly a 50/50 narrator-vs-visual split AT MINIMUM, more for footage-led categories above.

★ CORE PRINCIPLE — USE YOUR FOOTAGE. FAST CUTS. NARRATOR IS THE GLUE, NOT THE DEFAULT:
  This must feel like a high-retention, FAST-PACED viral short with CONSTANT MOTION — change the visual roughly every 2–3 seconds. The narrator is the connective tissue BETWEEN visuals, not the fallback you sit on. A talking-head-heavy edit is only correct for story_opinion.
  ★ PROMO vs STOCK — WHICH SOURCE TO USE (decisive rule):
    • When the narrator talks about AI TECHNOLOGY — what it is, how it works, how it's advancing, a specific AI product/tool/feature, or how AI is affecting things — use a "screencast" (PROMO footage of that technology). This is the primary reason to insert a promo. Set productEntity + matchKeywords to the specific technology being described (e.g. "image generation", "voice cloning", "AI video editor") so retrieval can find the segment that SHOWS that exact tech.
    • When the narrator talks about PEOPLE or real-world SITUATIONS (someone doing something, a workplace, an emotion, a scenario) — use "tactical_broll" (PEXELS stock of that situation), NOT a promo.
  ★ NAME-DROP RULE: whenever the narrator NAMES or references a product, tool, app, brand, or feature, PLAN a "screencast" beat for it. If no promo footage exists, fall back to brand-fitting stock via tactical_broll — do NOT just stay on the narrator for a name-drop.
  ★ MINIMUM SHOT LENGTH — NO MACHINE-GUN CUTS: every overlay must hold for at least ~2s (promos ~3s). Do NOT plan a string of different promos back-to-back where each shows for under 2s — that looks broken/glitchy. If you want to show several products in a row, give EACH its own ≥2–3s beat; if there isn't enough time/words for that, show FEWER products longer, or return to the narrator between them. Two consecutive overlays must be ≥2s each.
  MAX ENERGY, LOOSE FITS ALLOWED: prioritize constant motion, but never at the cost of sub-2s flashes. A reasonably on-theme clip that keeps the pace is acceptable. (Only the HOOK and clearly-wrong/contradictory footage are off-limits.)
  ORDER OF PREFERENCE for each cutaway: (1) matching promo/screencast footage (for AI-tech moments) → (2) topic-fitting Pexels stock (for people/situations) → (3) a generated situational clip (≤2/video) → (4) only then hold on the narrator.
  TONE: confident and premium — purposeful, well-motivated cuts, fast but intentional.

★ THE HOOK IS THE EXCEPTION — EARN THE FIRST ~3 SECONDS:
  Retention is won or lost in the first 3 seconds, so the hook ALWAYS gets a deliberate visual pattern-interrupt:
    1. Open on the narrator (talking_head), SHORT: ~0.5–1.5s — just enough to establish a real human.
    2. At ~1 SECOND, cut to ONE high-retention overlay that VISUALIZES THE BIG IDEA OF THE WHOLE VIDEO — the core topic, promise, or payoff the viewer will get by watching to the end. This is a THEMATIC ESTABLISHING SHOT: read the ENTIRE transcript and choose a visual that captures what the video is ultimately about, NOT a literal illustration of the specific words being spoken at second 1.
       - Example: if the video is "5 AI tools that replace your whole team", the hook visual should evoke that overall idea (e.g. the hero product/dashboard, or a montage-feeling concept of automation) — even if the narrator's opening line is just "Okay so last week…".
    3. PREFER a "screencast" (real product/promo footage) of the video's MAIN product/subject for this establishing shot. Use a "tactical_broll" (generated clip) only if the overall idea is abstract and no real footage captures it.
    4. It must still be RELEVANT to the video's theme — a random/unrelated clip is worse than staying on the narrator. Set its productEntity/matchKeywords/summary to describe the WHOLE-VIDEO concept (so the right hero footage is retrieved), and explain this in its rationale.
  This early overlay (screencast or generated) at ~1s is REQUIRED. After the hook, return to the narrator-first principle above.

VISUAL INTENT OPTIONS:
  • "talking_head" — the narrator on camera. The CONNECTIVE TISSUE between visuals, not a default. Use it for the hook open, personal/authority/emotional punches, the CTA, and brief resets — plus longer stretches ONLY in the story_opinion category. Set showNarrator=true, overlayDelaySeconds=0.
  • "screencast" — cut to real product/promo footage. The PREFERRED overlay. Use it WHENEVER the narrator names or describes ANY product, tool, app, brand, feature, screen, workflow, or result — promo footage may exist for it, and retrieval will find the best clip. Don't gate yourself: when in doubt and a product is mentioned, PLAN A SCREENCAST. Set productEntity to the product/brand name and matchKeywords to search terms. Set showNarrator=true, overlayDelaySeconds=1.0.
  • "tactical_broll" — a SITUATIONAL cutaway for a CONCEPT/EMOTION/SCENARIO that has no matching promo footage (e.g. "how AI is changing the job market" → a real person at a laptop scrolling job listings in a modern apartment). These are filled FIRST from a free library of REAL STOCK footage, and only the 1–2 most important are AI-generated. So USE tactical_broll FREELY for situational movement — you do NOT need to ration them. For EACH tactical_broll beat provide BOTH:
      - matchKeywords: a concise, concrete, FILMABLE stock-search query (2–5 words, e.g. ["person","laptop","job search","office"]) — this is what we search stock footage with, so make it visual and literal, not abstract.
      - brollPrompt: the extensive generation prompt (used only if this becomes one of the ≤2 AI-generated clips).
    Mark the hook one with "isRequiredTacticalSlot": true. Do NOT use tactical_broll when a screencast (real product footage) genuinely fits — promo footage is still preferred for anything about a specific product/feature.
    For EVERY tactical_broll beat you MUST write an EXTENSIVE "brollPrompt" (a detailed video-generation prompt, ~60–120 words) that:
      - Depicts the LITERAL SITUATION the narrator is describing (show the scenario, not a metaphor), informed by the WHOLE video's topic.
      - DOCUMENTARY-REALISM, PHOTOREAL look — like real candid filmed footage, natural true-to-life lighting and color (NOT stylized, NOT cartoon, NOT abstract).
      - Features REAL PEOPLE authentically in the scenario (a person/people doing the thing being discussed), unless the line is purely about an object/place.
      - Describes: subject & who they are, setting/location, the action happening, mood/emotion, time of day/lighting, camera framing & gentle motion, and that it is vertical 9:16.
      - Contains NO on-screen text, NO captions, NO logos, NO brand names, and NO fake UI/app screens (these generate as garbled artifacts).

★ ALSO DECIDE THE OVERALL APPROACH (return as "editApproach"):
  category: one of the 10 in STEP 0 (product_showcase | listicle | comparison | tutorial | news | problem_solution | educational | story_opinion | hype_promo | reaction).
  mode: "promo_led" (footage-heavy categories) | "narration_led" (story_opinion) | "ai_led" (concept-heavy / educational with little footage).
  overlayTargetPercent: your intended % of the video covered by overlays (per the category target).
  reasoning: 1–2 sentences naming the category and why, and how you'll hit the overlay target.

STRUCTURE RULES:
  • Beat 1 = talking_head, ~0.5–1.5s (narrator appears).
  • Beat 2 = the hook overlay (screencast preferred, else tactical_broll), starting ~0.8–2.0s, visualizing the WHOLE-VIDEO idea.
  • Through the body, alternate accurate overlays with the narrator on a FAST ~2–3s rhythm (every ~1.5–2.5s on lists/proof). Bias toward more, shorter beats — this is a fast-paced viral edit.
  • END ON THE NARRATOR: the final beat (the CTA / closing line) should be talking_head so the video lands on a human call-to-action.
  • NARRATOR-RETURN on key beats: for longer overlays on hook / authority / payoff / CTA moments, plan to cut back to the narrator's face before the beat ends to re-anchor trust.
  • NUMBERS, STATS & LISTS: do NOT force a cutaway just because a number or list item is spoken — those are emphasized in the subtitles. Only cut if there is genuinely accurate footage for the stat/item.
  • Cover the ENTIRE duration with no gaps; start/end align to transcript word timestamps.
  • Use as MANY or as FEW beats as the content honestly needs — do not manufacture cuts to look busy.
  • priority: 1 = most important cut, higher = less critical.

Return ONLY valid JSON (no markdown fences):
{
  "editApproach": { "category": "listicle", "mode": "promo_led", "overlayTargetPercent": 65, "reasoning": "A roundup of named AI tools — each item shows that product's promo footage (or brand-fitting stock), narrator connects, ~65% overlay." },
  "beats": [
    {
      "start": 0.0, "end": 1.2, "beatType": "hook", "summary": "Direct-to-camera hook",
      "emotionalIntent": "curiosity", "visualIntent": "talking_head",
      "showNarrator": true, "overlayDelaySeconds": 0, "priority": 1,
      "transcriptSnippet": "AI is about to change everything about work",
      "matchKeywords": [], "isRequiredTacticalSlot": false,
      "rationale": "Open on his face for a beat to establish a real person before the thematic pattern-interrupt."
    },
    {
      "start": 1.2, "end": 5.0, "beatType": "problem", "summary": "AI reshaping the job market",
      "emotionalIntent": "tension", "visualIntent": "tactical_broll",
      "showNarrator": true, "overlayDelaySeconds": 0.3, "priority": 1,
      "transcriptSnippet": "millions of jobs are shifting", "matchKeywords": ["job market","AI","office"],
      "isRequiredTacticalSlot": true,
      "rationale": "Hook establishing shot for the whole video's idea — the changing job market — so the viewer instantly knows what this is about.",
      "brollPrompt": "Documentary-realism, photoreal vertical 9:16 footage of a real person in their late 20s sitting at a small wooden desk in a sunlit modern apartment, scrolling job listings on a laptop with a slightly worried expression. Natural soft daylight from a window, true-to-life muted colors, shallow depth of field, gentle handheld push-in. Candid, authentic mood. No on-screen text, no logos, no app UI, no captions."
    }
  ],
  "intensity_map": [{"second":0,"intensity":60},{"second":1,"intensity":45}]
}

Also generate an intensity_map for EVERY integer second 0 through ${Math.floor(duration)}, assign a numeric value 0–100 (this drives a SUBTLE camera push on the narrator — keep it premium and restrained):
  0–14 = static/baseline | 15–39 = subtle zoom | 40–69 = moderate zoom | 70–89 = strong push zoom | 90–100 = snap zoom peak
  For this CONFIDENT/PREMIUM tone, keep most seconds in the 15–55 range (subtle/moderate). Reserve 70+ for the opening hook, a major reveal, or the CTA only. Avoid frequent snap zooms.`;

    let semanticBeats: SemanticBeat[] = [];
    let intensityMapRaw: Array<{ second: number; intensity: number }> = [];
    let directorRaw = '{}';
    let usedFallback = false;

    try {
      const beatRes = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: semanticBeatPrompt },
          { role: 'user', content: `Analyze this ${duration.toFixed(1)}s script and output the semantic beat plan now.` },
        ],
        response_format: { type: 'json_object' },
      });
      directorRaw = beatRes.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(directorRaw);

      if (Array.isArray(parsed.beats) && parsed.beats.length > 0) {
        semanticBeats = parsed.beats.map((b: any) => ({
          start: typeof b.start === 'number' ? b.start : 0,
          end: typeof b.end === 'number' ? b.end : 0,
          beatType: typeof b.beatType === 'string' ? b.beatType : 'transition',
          summary: typeof b.summary === 'string' ? b.summary : '',
          productEntity: typeof b.productEntity === 'string' ? b.productEntity : undefined,
          featureEntity: typeof b.featureEntity === 'string' ? b.featureEntity : undefined,
          emotionalIntent: typeof b.emotionalIntent === 'string' ? b.emotionalIntent : undefined,
          visualIntent: (['talking_head', 'screencast', 'tactical_broll'].includes(b.visualIntent) ? b.visualIntent : (b.visualIntent === 'situational_broll' ? 'tactical_broll' : 'talking_head')) as SemanticBeat['visualIntent'],
          showNarrator: typeof b.showNarrator === 'boolean' ? b.showNarrator : (b.visualIntent === 'talking_head'),
          overlayDelaySeconds: typeof b.overlayDelaySeconds === 'number' ? b.overlayDelaySeconds : (b.visualIntent === 'talking_head' ? 0 : 1.0),
          priority: typeof b.priority === 'number' ? b.priority : 5,
          transcriptSnippet: typeof b.transcript_snippet === 'string' ? b.transcript_snippet : (typeof b.transcriptSnippet === 'string' ? b.transcriptSnippet : ''),
          matchKeywords: Array.isArray(b.match_keywords) ? b.match_keywords.filter((k: any) => typeof k === 'string') : (Array.isArray(b.matchKeywords) ? b.matchKeywords.filter((k: any) => typeof k === 'string') : []),
          isRequiredTacticalSlot: b.isRequiredTacticalSlot === true,
          tacticalPlacementReason: typeof b.tacticalPlacementReason === 'string' ? b.tacticalPlacementReason : undefined,
          rationale: typeof b.rationale === 'string' ? b.rationale : (typeof b.reason === 'string' ? b.reason : undefined),
          brollPrompt: typeof b.brollPrompt === 'string' ? b.brollPrompt : (typeof b.broll_prompt === 'string' ? b.broll_prompt : undefined),
        }));
        intensityMapRaw = Array.isArray(parsed.intensity_map) ? parsed.intensity_map : [];
        console.log(`[runPipeline] ✅ Semantic beat planner returned ${semanticBeats.length} beats`);
      } else {
        console.warn('[runPipeline] ⚠ Semantic beat planner returned empty beats — using fallback');
        usedFallback = true;
      }
    } catch (e: any) {
      console.warn('[runPipeline] ⚠ Semantic beat planner failed — using fallback:', e.message);
      usedFallback = true;
    }

    // ── Log semantic beats ────────────────────────────────────────────────────
    for (const b of semanticBeats) {
      console.log(`[runPipeline] BEAT ${b.start.toFixed(2)}s–${b.end.toFixed(2)}s | ${b.beatType.padEnd(12)} | visual=${b.visualIntent.padEnd(16)} | narrator=${b.showNarrator ? 'Y' : 'N'} delay=${b.overlayDelaySeconds}s | product=${b.productEntity ?? '-'} | "${b.summary.slice(0, 50)}"`);
    }

    // ── Fallback: convert formula windows into pseudo-beats ───────────────────
    if (usedFallback) {
      console.log('[runPipeline] Using legacy formula-window fallback');
      const windows = BROLL_FORMULA_WINDOWS.filter((w) => w.start < duration);
      let cursor = 0;
      let placedTactical = false;
      for (const win of windows) {
        if (cursor < win.start - 0.05) {
          semanticBeats.push({
            start: cursor, end: win.start,
            beatType: cursor === 0 ? 'hook' : 'transition',
            summary: 'Talking head segment',
            visualIntent: 'talking_head', showNarrator: true, overlayDelaySeconds: 0, priority: 5,
            transcriptSnippet: '', matchKeywords: [],
          });
        }
        // First non-TH window becomes required tactical B-roll; rest use screencast
        const isFirstOverlay = !placedTactical;
        const fallbackVisual = isFirstOverlay ? 'tactical_broll' as const : (researchedUrls.length > 0 ? 'screencast' as const : 'tactical_broll' as const);
        semanticBeats.push({
          start: win.start, end: Math.min(win.end, duration),
          beatType: isFirstOverlay ? 'hook' : 'demo', summary: win.label,
          visualIntent: fallbackVisual, showNarrator: true, overlayDelaySeconds: 1.0, priority: isFirstOverlay ? 1 : 3,
          transcriptSnippet: '', matchKeywords: [],
          isRequiredTacticalSlot: isFirstOverlay,
          tacticalPlacementReason: isFirstOverlay ? 'Fallback: first overlay window used as required tactical B-roll' : undefined,
        });
        if (isFirstOverlay) placedTactical = true;
        cursor = Math.min(win.end, duration);
      }
      if (cursor < duration - 0.05) {
        semanticBeats.push({
          start: cursor, end: duration,
          beatType: 'cta', summary: 'Closing / CTA',
          visualIntent: 'talking_head', showNarrator: true, overlayDelaySeconds: 0, priority: 5,
          transcriptSnippet: '', matchKeywords: [],
        });
      }
    }

    // ── Phase 3.5: Beat-snap alignment ─────────────────────────────────────
    // Snap semantic cut boundaries to nearby musical downbeats/beats when
    // the transcript meaning isn't harmed. Improves pacing by aligning
    // visual cuts with the music grid.
    const SNAP_WINDOW_DOWNBEAT = 0.25; // snap to downbeat within this range
    const SNAP_WINDOW_BEAT     = 0.12; // snap to any beat within this range

    const beatDurSec = 60 / bpm;
    const allMusicalBeats: number[] = [];
    for (let t = 0; t <= duration + beatDurSec; t += beatDurSec) {
      allMusicalBeats.push(parseFloat(t.toFixed(3)));
    }
    const musicalDownbeats = allMusicalBeats.filter((_, i) => i % 4 === 0);

    // Sort first so we snap in order
    semanticBeats.sort((a, b) => a.start - b.start);

    let snappedCount = 0;
    for (let i = 1; i < semanticBeats.length; i++) {
      const beat = semanticBeats[i];
      const origStart = beat.start;
      // Try downbeat snap first (larger window)
      let bestSnap: number | null = null;
      let snapSource = '';
      for (const db of musicalDownbeats) {
        if (Math.abs(db - origStart) <= SNAP_WINDOW_DOWNBEAT && db > 0.1) {
          bestSnap = db;
          snapSource = 'downbeat';
          break;
        }
      }
      // Fallback: try any beat (smaller window)
      if (bestSnap === null) {
        for (const mb of allMusicalBeats) {
          if (Math.abs(mb - origStart) <= SNAP_WINDOW_BEAT && mb > 0.1) {
            bestSnap = mb;
            snapSource = 'beat';
            break;
          }
        }
      }
      if (bestSnap !== null && bestSnap !== origStart) {
        beat.start = bestSnap;
        // Adjust previous beat's end to match
        semanticBeats[i - 1].end = bestSnap;
        snappedCount++;
        console.log(`[runPipeline] 🎵 BEAT-SNAP: cut ${origStart.toFixed(3)}s → ${bestSnap.toFixed(3)}s (${snapSource}, Δ=${(bestSnap - origStart).toFixed(3)}s) | beat="${beat.beatType}"`);
      }
    }
    console.log(`[runPipeline] 🎵 Beat-snap: ${snappedCount} cut${snappedCount !== 1 ? 's' : ''} snapped (BPM=${bpm}, downbeat-window=${SNAP_WINDOW_DOWNBEAT}s, beat-window=${SNAP_WINDOW_BEAT}s)`);

    // ── Phase 4: Convert semantic beats → shot records ────────────────────────
    console.log('[runPipeline] ▶ Building shot list from semantic beats');

    // ── Post-process: enforce editorial rules ──────────────────────────────────
    const hasScreencastUrls = researchedUrls.some(r => r.use === 'screencast');
    let tacticalCount = semanticBeats.filter(b => b.visualIntent === 'tactical_broll').length;

    // RULE 1: Sanity-cap the number of situational (tactical_broll) cutaways the
    // director plans. These are filled by FREE STOCK footage (Pexels) first and
    // only AI-generated as a last resort — the hard "max 2 AI-generated" budget
    // is enforced downstream in captureShots — so we allow several here for
    // movement and just guard against pathological plans.
    const MAX_GENERATED = 8;
    if (tacticalCount > MAX_GENERATED) {
      const sorted = semanticBeats
        .map((b, i) => ({ b, i }))
        .filter(x => x.b.visualIntent === 'tactical_broll')
        .sort((a, b) => {
          // Keep required slots; demote highest priority number first (least important)
          if (a.b.isRequiredTacticalSlot && !b.b.isRequiredTacticalSlot) return 1;
          if (!a.b.isRequiredTacticalSlot && b.b.isRequiredTacticalSlot) return -1;
          return b.b.priority - a.b.priority;
        });

      for (const { b } of sorted) {
        if (tacticalCount <= MAX_GENERATED) break;
        if (hasScreencastUrls) {
          b.visualIntent = 'screencast';
          b.overlayDelaySeconds = 1.0;
          b.showNarrator = true;
          console.log(`[runPipeline] ⬇ Demoted tactical_broll → screencast at ${b.start.toFixed(2)}s ("${b.summary.slice(0, 40)}")`);
        } else {
          b.visualIntent = 'talking_head';
          b.showNarrator = true;
          b.overlayDelaySeconds = 0;
          console.log(`[runPipeline] ⬇ Demoted tactical_broll → talking_head at ${b.start.toFixed(2)}s ("${b.summary.slice(0, 40)}")`);
        }
        tacticalCount--;
      }
    }

    // RULE 2: Guarantee the HOOK pattern-interrupt — an OVERLAY (screencast OR
    // generated) must start by ~2.5s to stop the scroll. We do NOT force a
    // generated clip: a real screencast is preferred whenever the hook can be
    // shown with product footage; a generated clip is the fallback.
    const isOverlay = (b: SemanticBeat) => b.visualIntent === 'screencast' || b.visualIntent === 'tactical_broll';
    const hasEarlyOverlay = semanticBeats.some(b => isOverlay(b) && b.start <= 2.5);
    if (!hasEarlyOverlay && semanticBeats.length > 1 && duration > 3) {
      console.log('[runPipeline] ⚡ No early hook overlay found — promoting best early candidate');
      const candidates = semanticBeats
        .map((b, i) => ({ b, i }))
        .filter(({ b, i }) => {
          if (i === 0 && semanticBeats.length > 2) return false; // keep narrator visible first
          if (b.beatType === 'cta') return false;
          return true;
        })
        .map(({ b, i }) => {
          let score = 0;
          // Prefer VERY early placement (0.8–2.0s ideal, 2.0–3.0s acceptable)
          if (b.start >= 0.8 && b.start <= 2.0) score += 80;
          else if (b.start > 2.0 && b.start <= 3.0) score += 50;
          else if (b.start < 0.8) score += 20;
          else if (b.start <= 5.0) score += 25;
          else score += 5;
          // Prefer the 2nd/3rd beat position (right after the narrator appears)
          if (i === 1) score += 30;
          if (i === 2) score += 15;
          return { b, i, score };
        })
        .sort((a, b) => b.score - a.score);

      if (candidates.length > 0) {
        const winner = candidates[0].b;
        const prevIntent = winner.visualIntent;
        // Prefer a real screencast for the hook when product footage exists and
        // the beat references a product; otherwise fall back to a generated clip.
        const preferScreencast = hasScreencastUrls && (!!winner.productEntity || (winner.matchKeywords?.length ?? 0) > 0 || prevIntent === 'screencast');
        winner.visualIntent = preferScreencast ? 'screencast' : 'tactical_broll';
        winner.showNarrator = true;
        winner.overlayDelaySeconds = winner.overlayDelaySeconds || 1.0;
        if (winner.visualIntent === 'tactical_broll') {
          winner.isRequiredTacticalSlot = true;
          winner.tacticalPlacementReason = `Promoted from ${prevIntent} — required hook overlay (no matching screencast footage), beat "${winner.beatType}" at ${winner.start.toFixed(1)}s`;
          tacticalCount++;
        }
        if (!winner.rationale) {
          winner.rationale = `Hook pattern-interrupt: cutting to ${winner.visualIntent === 'screencast' ? 'real footage' : 'a generated visual'} ~1s in to stop the scroll while staying tied to the hook.`;
        }
        console.log(`[runPipeline] ⬆ Promoted ${prevIntent} → ${winner.visualIntent} (hook overlay) at ${winner.start.toFixed(2)}s | beat="${winner.beatType}" | "${winner.summary.slice(0, 50)}"`);
      } else {
        console.warn('[runPipeline] ⚠ Could not find any suitable candidate for the hook overlay');
      }
    }

    // If the hook overlay ended up being a generated clip, flag the required slot.
    const tacticalBeats = semanticBeats.filter(b => b.visualIntent === 'tactical_broll');
    if (tacticalBeats.length > 0 && !tacticalBeats.some(b => b.isRequiredTacticalSlot)) {
      const earliest = tacticalBeats.sort((a, b) => a.start - b.start)[0];
      if (earliest.start <= 2.5) {
        earliest.isRequiredTacticalSlot = true;
        if (!earliest.tacticalPlacementReason) {
          earliest.tacticalPlacementReason = `Earliest generated clip at ${earliest.start.toFixed(1)}s — serving as the hook overlay`;
        }
        console.log(`[runPipeline] 📌 Marked tactical_broll at ${earliest.start.toFixed(2)}s as hook slot`);
      }
    }

    // ── Phase 3.7: PACING GUARD — enforce strict editorial rules ──────────────
    // This runs AFTER tactical B-roll enforcement and BEFORE shot record creation.
    // It auto-corrects the plan if it violates pacing rules.

    const pacingLog: string[] = [];

    // RULE A: The hook overlay (first screencast OR generated clip) must start before 2.5s
    const firstTactical = semanticBeats.find(b => b.visualIntent === 'screencast' || b.visualIntent === 'tactical_broll');
    const firstTacticalStart = firstTactical?.start ?? null;
    if (firstTacticalStart !== null && firstTacticalStart > 2.5) {
      pacingLog.push(`⚠ Hook overlay at ${firstTacticalStart.toFixed(2)}s is too late (target: 0.8–2.0s)`);
      // Try to split the first beat to create an earlier overlay slot
      const firstBeat = semanticBeats[0];
      if (firstBeat && firstBeat.visualIntent === 'talking_head' && firstBeat.end > 1.5) {
        const splitPoint = Math.min(1.2, firstBeat.end * 0.4);
        // Move the overlay to start at splitPoint
        if (firstTactical && firstTactical.start > splitPoint + 0.5) {
          // Insert a new short TH beat to cover [original firstBeat.start, splitPoint]
          // and shift the tactical_broll to [splitPoint, tactical_broll's original end or next beat]
          const origFirstEnd = firstBeat.end;
          firstBeat.end = parseFloat(splitPoint.toFixed(3));

          // Move tactical to start right after the shortened first beat
          const oldTacStart = firstTactical.start;
          firstTactical.start = parseFloat(splitPoint.toFixed(3));
          // If there was a gap between the shortened TH and the old tactical, fill it
          // by adjusting the beat that was between them
          const beatsBetween = semanticBeats.filter(b => b !== firstBeat && b !== firstTactical && b.start >= firstBeat.end && b.end <= oldTacStart + 0.1);
          if (beatsBetween.length === 0 && origFirstEnd < oldTacStart - 0.1) {
            // The old first beat covered the gap — nothing between. Just adjust.
            // Create a filler talking_head for [firstBeat.end, firstTactical.start] only if there's a real gap
          }
          // Adjust the beat before tactical to end at the new tactical start
          const prevBeat = semanticBeats.filter(b => b.end <= oldTacStart + 0.01 && b !== firstTactical).sort((a, b) => b.end - a.end)[0];
          if (prevBeat && prevBeat !== firstBeat) {
            prevBeat.end = firstTactical.start;
          }
          pacingLog.push(`✅ Moved hook overlay from ${oldTacStart.toFixed(2)}s → ${firstTactical.start.toFixed(2)}s (split opening TH at ${splitPoint.toFixed(2)}s)`);
          // Re-sort
          semanticBeats.sort((a, b) => a.start - b.start);
        }
      }
    } else if (firstTacticalStart !== null) {
      pacingLog.push(`✅ Hook overlay at ${firstTacticalStart.toFixed(2)}s — within target range`);
    }

    // RULE B: Opening TH beat must be ≤ 1.5s
    const openingBeat = semanticBeats[0];
    if (openingBeat && openingBeat.visualIntent === 'talking_head' && (openingBeat.end - openingBeat.start) > 1.8) {
      const origEnd = openingBeat.end;
      const newEnd = parseFloat((openingBeat.start + 1.2).toFixed(3));
      if (semanticBeats[1] && semanticBeats[1].start > newEnd) {
        // There's a gap — need to adjust
        semanticBeats[1].start = newEnd;
      }
      openingBeat.end = newEnd;
      pacingLog.push(`✅ Shortened opening TH from ${(origEnd - openingBeat.start).toFixed(2)}s → ${(newEnd - openingBeat.start).toFixed(2)}s`);
      semanticBeats.sort((a, b) => a.start - b.start);
    }

    // NOTE (editorial-rules v3 — narrator-first):
    // Earlier versions force-converted any talking-head beat longer than a few
    // seconds into a screencast after the 6s mark. That is what produced the
    // "way too many screencasts, disconnected from the narration" feel. We now
    // TRUST the director's narrator-first plan: long narrator stretches are
    // allowed, and overlays only appear where the model decided they reinforce
    // the words. The only structural guarantee we still enforce is the HOOK
    // overlay (RULE A above). No TH→screencast promotion happens here.
    const OPENING_BOUNDARY = 6.0; // retained for logging/metrics below
    let pacingRevisions = 0;

    // ── Overlay-coverage guardrail (category-aware) ──────────────────────────
    // The director picks a category with a target overlay %. If its plan falls
    // short (the old narrator-first bias), promote the longest narrator beats
    // that reference a product/concept into overlays until we approach target —
    // screencast when a product/keywords exist (retrieval will match it),
    // otherwise tactical_broll (filled by brand/topic-fitting stock). This is
    // what makes promo footage actually get used.
    {
      let approach: any = {};
      try { approach = JSON.parse(directorRaw)?.editApproach ?? {}; } catch { /* */ }
      const category = typeof approach.category === 'string' ? approach.category : '';
      // Default target by category (fraction of duration), floor 0.5 unless story.
      const CATEGORY_TARGET: Record<string, number> = {
        product_showcase: 0.6, listicle: 0.65, comparison: 0.6, tutorial: 0.65,
        news: 0.55, problem_solution: 0.55, educational: 0.5, story_opinion: 0.4,
        hype_promo: 0.65, reaction: 0.5,
      };
      const targetPct = typeof approach.overlayTargetPercent === 'number'
        ? Math.max(0.35, Math.min(0.8, approach.overlayTargetPercent / 100))
        : (CATEGORY_TARGET[category] ?? 0.5);

      const overlayDur = () => semanticBeats
        .filter(b => b.visualIntent !== 'talking_head')
        .reduce((s, b) => s + (b.end - b.start), 0);
      let coverage = overlayDur() / duration;

      if (coverage < targetPct - 0.05) {
        // Candidate narrator beats (skip the opening hook + the CTA), longest &
        // most product-y first.
        const looksProducty = (b: SemanticBeat) =>
          !!b.productEntity || (b.matchKeywords?.length ?? 0) > 0 || /[A-Z][a-zA-Z]+/.test(b.summary || '');
        const candidates = semanticBeats
          .map((b, i) => ({ b, i }))
          .filter(({ b, i }) => b.visualIntent === 'talking_head' && i > 0 && b.beatType !== 'cta')
          .sort((a, c) => {
            // product-referencing beats first, then longest
            const pa = looksProducty(a.b) ? 1 : 0, pc = looksProducty(c.b) ? 1 : 0;
            if (pa !== pc) return pc - pa;
            return (c.b.end - c.b.start) - (a.b.end - a.b.start);
          });
        for (const { b } of candidates) {
          if (coverage >= targetPct - 0.05) break;
          const hasProduct = !!b.productEntity || (b.matchKeywords?.length ?? 0) > 0;
          b.visualIntent = (hasScreencastUrls && hasProduct) ? 'screencast' : 'tactical_broll';
          b.showNarrator = true;
          b.overlayDelaySeconds = b.overlayDelaySeconds || 1.0;
          if (!b.rationale) b.rationale = `Promoted to overlay to hit the ${category || 'category'} footage target (≈${Math.round(targetPct * 100)}%).`;
          pacingRevisions++;
          coverage = overlayDur() / duration;
        }
        console.log(`[runPipeline] 🎯 Coverage guardrail: category=${category || '?'} target=${Math.round(targetPct * 100)}% → ${(coverage * 100).toFixed(0)}% after promoting ${pacingRevisions} beat(s)`);
      } else {
        console.log(`[runPipeline] 🎯 Coverage ${(coverage * 100).toFixed(0)}% meets category target ${Math.round(targetPct * 100)}% — no promotion needed`);
      }
    }

    // ── Compute pacing validation metrics ────────────────────────────────────
    semanticBeats.sort((a, b) => a.start - b.start);

    let totalTHDuration = 0;
    let totalSCDuration = 0;
    let totalTBDuration = 0;
    let longestTHStretch = 0;
    let currentTHStretch = 0;
    let prevWasTH = false;

    for (const b of semanticBeats) {
      const d = b.end - b.start;
      if (b.visualIntent === 'talking_head') {
        totalTHDuration += d;
        if (prevWasTH) {
          currentTHStretch += d;
        } else {
          currentTHStretch = d;
        }
        longestTHStretch = Math.max(longestTHStretch, currentTHStretch);
        prevWasTH = true;
      } else {
        if (b.visualIntent === 'screencast') totalSCDuration += d;
        else totalTBDuration += d;
        prevWasTH = false;
        currentTHStretch = 0;
      }
    }

    const updatedFirstOverlay = semanticBeats.find(b => b.visualIntent === 'screencast' || b.visualIntent === 'tactical_broll');
    const finalFirstOverlayStart = updatedFirstOverlay?.start ?? -1;

    const pacingValidation = {
      // Hook overlay (screencast OR generated) start — the one structural rule.
      firstOverlayStart: finalFirstOverlayStart,
      hookOverlayType: updatedFirstOverlay?.visualIntent ?? 'none',
      totalTalkingHeadDuration: parseFloat(totalTHDuration.toFixed(2)),
      totalScreencastDuration: parseFloat(totalSCDuration.toFixed(2)),
      totalTacticalBrollDuration: parseFloat(totalTBDuration.toFixed(2)),
      longestTalkingHeadStretch: parseFloat(longestTHStretch.toFixed(2)),
      videoDuration: parseFloat(duration.toFixed(2)),
      screencastCoveragePercent: parseFloat(((totalSCDuration / duration) * 100).toFixed(1)),
      talkingHeadCoveragePercent: parseFloat(((totalTHDuration / duration) * 100).toFixed(1)),
      pacingRevisions,
      // Narrator-first: the only thing we require is an early hook overlay.
      // Long narrator stretches are intentional and do NOT fail validation.
      passed: finalFirstOverlayStart >= 0 && finalFirstOverlayStart <= 2.5,
      log: pacingLog,
    };

    console.log(`[runPipeline] 📐 PACING VALIDATION:`, JSON.stringify(pacingValidation, null, 2));
    if (!pacingValidation.passed) {
      console.warn(`[runPipeline] ⚠ Pacing validation FAILED — review shot plan`);
      for (const msg of pacingLog) console.log(`[runPipeline]   ${msg}`);
    } else {
      console.log(`[runPipeline] ✅ Pacing validation PASSED`);
    }

    // Log final visual intent distribution
    const distro = { talking_head: 0, screencast: 0, tactical_broll: 0 };
    for (const b of semanticBeats) distro[b.visualIntent]++;
    console.log(`[runPipeline] 📊 Visual distribution: TH=${distro.talking_head} SC=${distro.screencast} TB=${distro.tactical_broll}`);
    console.log(`[runPipeline] 📊 Duration split: TH=${totalTHDuration.toFixed(1)}s (${pacingValidation.talkingHeadCoveragePercent}%) | SC=${totalSCDuration.toFixed(1)}s (${pacingValidation.screencastCoveragePercent}%) | TB=${totalTBDuration.toFixed(1)}s`);
    console.log(`[runPipeline] 📊 Longest uninterrupted TH stretch: ${longestTHStretch.toFixed(1)}s`);
    for (const tb of semanticBeats.filter(b => b.visualIntent === 'tactical_broll')) {
      console.log(`[runPipeline] 🎬 Tactical B-Roll: ${tb.start.toFixed(2)}s–${tb.end.toFixed(2)}s | required=${tb.isRequiredTacticalSlot ? 'YES' : 'no'} | beat="${tb.beatType}" | "${tb.summary.slice(0, 60)}" | reason: ${tb.tacticalPlacementReason ?? 'AI-planned'}`);
    }

    const shotRecords: ShotRec[] = [];

    // ── Minimum visible-overlay guardrail ────────────────────────────────────
    // An overlay is only visible from (start + overlayDelaySeconds) to end.
    // Targets / floors:
    //   • PROMO (screencast): TARGET 3s. NEVER reverts to narration (rule 4) —
    //     a chosen promo was chosen for a reason; we keep it, with a hard 2s
    //     floor enforced by borrowing/trimming.
    //   • stock / generated (tactical_broll): target 1.6s; may revert if it
    //     truly can't reach a usable length.
    const MIN_PROMO_VISIBLE = 3.0;
    const PROMO_HARD_FLOOR = 2.0; // promos never show for less than this
    const MIN_BROLL_VISIBLE = 1.6;
    const isPromo = (b: SemanticBeat) => b.visualIntent === 'screencast';
    const isOverlay = (b: SemanticBeat) => b.visualIntent !== 'talking_head';
    const floorFor = (b: SemanticBeat) => (isPromo(b) ? PROMO_HARD_FLOOR : MIN_BROLL_VISIBLE);

    // ── Pre-pass: fix machine-gun cuts WITHOUT reverting to narrator ──────────
    // Find each contiguous RUN of overlays. If the run contains any sub-floor
    // (<2s) cut, it's choppy — collapse the WHOLE run into its single most
    // important beat and let that one clip fill the entire run's span. We never
    // drop a choppy run back to the narrator; we keep the best visual and give
    // it the time. Importance = required hook > promo(screencast) > generated >
    // stock, then longer duration, then lower priority number.
    semanticBeats.sort((a, b) => a.start - b.start);
    {
      const importance = (b: SemanticBeat): number => {
        let s = 0;
        if (b.isRequiredTacticalSlot) s += 1000;
        if (b.visualIntent === 'screencast') s += 400;            // promo footage wins
        else if (b.brollPrompt) s += 200;                          // generated situational
        else s += 100;                                             // stock
        s += Math.min(50, (b.end - b.start) * 10);                // prefer the longer one
        s += Math.max(0, 20 - (b.priority ?? 10));                // lower priority# = more important
        return s;
      };
      let i = 0;
      while (i < semanticBeats.length) {
        if (!isOverlay(semanticBeats[i])) { i++; continue; }
        // Extent of this contiguous overlay run [i, j)
        let j = i;
        while (j < semanticBeats.length && isOverlay(semanticBeats[j])) j++;
        const run = semanticBeats.slice(i, j);
        const choppy = run.some((b) => (b.end - (b.start + (b.overlayDelaySeconds || 0))) < floorFor(b));
        if (run.length > 1 && choppy) {
          // Winner takes the whole span [run.start, run.end].
          const winner = run.reduce((best, b) => (importance(b) > importance(best) ? b : best), run[0]);
          const spanStart = run[0].start;
          const spanEnd = run[run.length - 1].end;
          winner.start = spanStart;
          winner.end = spanEnd;
          winner.overlayDelaySeconds = 0; // it now opens the span
          if (!winner.rationale) winner.rationale = `Collapsed a choppy run of ${run.length} short cuts into this one clip so it holds for the full ${(spanEnd - spanStart).toFixed(1)}s.`;
          // Replace the whole run with just the winner.
          semanticBeats.splice(i, run.length, winner);
          console.log(`[runPipeline] 🧹 Collapsed ${run.length} back-to-back short overlays at ${spanStart.toFixed(1)}s → kept ${winner.visualIntent}${winner.productEntity ? ' (' + winner.productEntity + ')' : ''} for ${(spanEnd - spanStart).toFixed(1)}s`);
          i += 1; // move past the winner
        } else {
          i = j;
        }
      }
    }

    // ── Minimum visible-overlay guardrail ────────────────────────────────────
    // An overlay is only visible from (start + overlayDelaySeconds) to end.
    // Targets / floors:
    //   • PROMO (screencast): TARGET 3s. NEVER reverts to narration (rule 4) —
    //     a chosen promo was chosen for a reason; we keep it, with a hard 2s
    //     floor enforced by borrowing/trimming.
    //   • stock / generated (tactical_broll): target 1.6s; may revert if it
    //     truly can't reach a usable length.
    semanticBeats.sort((a, b) => a.start - b.start);
    for (let i = 0; i < semanticBeats.length; i++) {
      const b = semanticBeats[i];
      if (b.visualIntent === 'talking_head') continue;
      const target = isPromo(b) ? MIN_PROMO_VISIBLE : MIN_BROLL_VISIBLE;
      let visible = b.end - (b.start + (b.overlayDelaySeconds || 0));
      if (visible >= target) continue;

      // 1) cut the narrator-first delay down (promos may drop it entirely)
      if ((b.overlayDelaySeconds || 0) > 0) {
        const need = target - visible;
        b.overlayDelaySeconds = Math.max(0, (b.overlayDelaySeconds || 0) - need);
        visible = b.end - (b.start + (b.overlayDelaySeconds || 0));
      }
      // 2a) If this is the LAST beat and there's video left after it, extend it
      //     toward the end — a final overlay should use the time available
      //     instead of cutting early. (Fixes "the end cut could have been longer.")
      const next = semanticBeats[i + 1];
      if (visible < target && !next && b.end < duration - 0.05) {
        b.end = parseFloat(duration.toFixed(3));
        visible = b.end - (b.start + (b.overlayDelaySeconds || 0));
      }
      // 2b) borrow time from the FOLLOWING narrator beat. Promos borrow harder
      //    (can shrink the next narrator beat to 0.3s) to guarantee their floor.
      if (visible < target && next && next.visualIntent === 'talking_head') {
        const want = target - visible;
        const keepNext = isPromo(b) ? 0.3 : 0.6;
        const give = Math.min(want, Math.max(0, (next.end - next.start) - keepNext));
        if (give > 0) {
          b.end = parseFloat((b.end + give).toFixed(3));
          next.start = b.end;
          visible = b.end - (b.start + (b.overlayDelaySeconds || 0));
        }
      }

      const prev = semanticBeats[i - 1];
      const prevIsNarr = !prev || prev.visualIntent === 'talking_head';
      if (isPromo(b)) {
        // Reach the 2s floor by pulling the start earlier into a narrator beat.
        // Promos are NEVER reverted to the narrator (rule 4) — the run-collapse
        // pass above already removed choppy promo runs, so any remaining short
        // promo is just kept at whatever length it has.
        if (visible < PROMO_HARD_FLOOR && prevIsNarr) {
          const deficit = PROMO_HARD_FLOOR - visible;
          b.start = parseFloat(Math.max(0, b.start - deficit).toFixed(3));
          if (prev && prev.end > b.start) prev.end = b.start;
          b.overlayDelaySeconds = 0;
          visible = b.end - b.start;
        }
        console.log(`[runPipeline] 🎬 Promo at ${b.start.toFixed(2)}s kept → ${visible.toFixed(2)}s visible`);
      } else if (visible < target - 0.15) {
        // stock/generated that can't reach a usable length → revert to narrator
        console.log(`[runPipeline] ⤵ B-roll at ${b.start.toFixed(2)}s only ${visible.toFixed(2)}s — reverting to talking_head`);
        b.visualIntent = 'talking_head';
        b.overlayDelaySeconds = 0;
        b.showNarrator = true;
      } else {
        console.log(`[runPipeline] ⏱ Overlay (${b.visualIntent}) at ${b.start.toFixed(2)}s → ${visible.toFixed(2)}s visible`);
      }
    }
    semanticBeats.sort((a, b) => a.start - b.start);

    // Beat types that benefit from narrator-return (cut back to face before beat ends)
    const NARRATOR_RETURN_BEATS = new Set(['hook', 'pain', 'objection', 'cta', 'transition']);
    const DEFAULT_NARRATOR_RETURN_LEAD = 0.8; // seconds before beat end to cut back

    for (let i = 0; i < semanticBeats.length; i++) {
      const beat = semanticBeats[i];
      const beatStart = parseFloat(Math.max(0, beat.start).toFixed(3));
      const beatEnd = parseFloat(Math.min(beat.end, duration).toFixed(3));
      if (beatEnd <= beatStart + 0.05) continue;

      const dbBeat = beatTypeToDbBeat(beat.beatType);
      const beatDur = beatEnd - beatStart;

      // Compute narrator-return: useful for authority/hook/CTA/transition beats
      // Only if the beat is long enough (overlay needs ≥1.5s visible after delay)
      const nextBeat = semanticBeats[i + 1];
      const nextIsTH = nextBeat?.visualIntent === 'talking_head';
      const wantsReturn = NARRATOR_RETURN_BEATS.has(beat.beatType) && beat.showNarrator;
      const minOverlayVisible = 1.5;
      const canReturn = wantsReturn && beatDur > (beat.overlayDelaySeconds + minOverlayVisible + DEFAULT_NARRATOR_RETURN_LEAD);
      // Don't return if the next beat is already talking_head (would be redundant)
      const returnToNarr = canReturn && !nextIsTH;
      const narrReturnLead = returnToNarr ? parseFloat(Math.min(DEFAULT_NARRATOR_RETURN_LEAD, beatDur * 0.2).toFixed(2)) : 0;

      if (beat.visualIntent === 'talking_head') {
        const thDur = beatEnd - beatStart;
        if (beatStart >= OPENING_BOUNDARY && thDur > 3.0) {
          console.log(`[runPipeline] 👤 TH KEPT (${thDur.toFixed(1)}s at ${beatStart.toFixed(1)}s): beat="${beat.beatType}" | "${beat.summary.slice(0, 50)}" — allowed because: ${!hasScreencastUrls ? 'no screencast URLs' : beat.beatType === 'cta' ? 'CTA beat' : 'pacing guard already processed'}`);
        }
        shotRecords.push({
          caption: beat.summary || '',
          project: projectId,
          shotType: 'Talking Head',
          beat: dbBeat,
          beatCount: Math.max(1, Math.round((beatEnd - beatStart) * bpm / 60)),
          startTime: beatStart,
          endTime: beatEnd,
          transitionIn: 'Hard Cut',
          uiLabelsJson: JSON.stringify({
            beatType: beat.beatType,
            visualIntent: 'talking_head',
            emotionalIntent: beat.emotionalIntent ?? '',
            transcriptSnippet: beat.transcriptSnippet,
            priority: beat.priority,
            showNarrator: true,
            showNarratorFirst: true,
            overlayDelaySeconds: 0,
            rationale: beat.rationale ?? '',
          }),
          captureStatus: 'Pending',
        });
      } else if (beat.visualIntent === 'screencast') {
        const targetUrl = resolveUrlForEntity(beat.productEntity, researchedUrls);
        console.log(`[runPipeline] 🖥️ Screencast: ${beatStart.toFixed(2)}s–${beatEnd.toFixed(2)}s | product="${beat.productEntity ?? 'N/A'}" | url=${targetUrl ? 'YES' : 'NO'} | reason: beat="${beat.beatType}", content supports product demo`);
        shotRecords.push({
          caption: beat.summary || beat.productEntity || '',
          project: projectId,
          shotType: 'Screencast',
          beat: dbBeat,
          beatCount: Math.max(1, Math.round((beatEnd - beatStart) * bpm / 60)),
          startTime: beatStart,
          endTime: beatEnd,
          targetUrl,
          transitionIn: 'Hard Cut',
          uiLabelsJson: JSON.stringify({
            beatType: beat.beatType,
            visualIntent: 'screencast',
            productEntity: beat.productEntity ?? '',
            featureEntity: beat.featureEntity ?? '',
            emotionalIntent: beat.emotionalIntent ?? '',
            matchKeywords: beat.matchKeywords,
            transcriptSnippet: beat.transcriptSnippet,
            priority: beat.priority,
            showNarrator: beat.showNarrator,
            showNarratorFirst: beat.showNarrator,
            overlayDelaySeconds: beat.overlayDelaySeconds,
            returnToNarratorBeforeEnd: returnToNarr,
            narratorReturnLeadSeconds: narrReturnLead,
            rationale: beat.rationale ?? '',
          }),
          captureStatus: 'Pending',
        });
      } else {
        // tactical_broll — required early pattern interrupt
        shotRecords.push({
          caption: beat.summary || '',
          project: projectId,
          shotType: 'B-Roll',
          beat: dbBeat,
          beatCount: Math.max(1, Math.round((beatEnd - beatStart) * bpm / 60)),
          startTime: beatStart,
          endTime: beatEnd,
          transitionIn: 'Hard Cut',
          sfxIn: beat.beatType === 'hook' ? 'Impact' : (beat.beatType === 'payoff' ? 'Riser' : undefined),
          uiLabelsJson: JSON.stringify({
            beatType: beat.beatType,
            emotionalIntent: beat.emotionalIntent ?? '',
            visualIntent: 'tactical_broll',
            veo3Prompt: beat.brollPrompt || beat.summary,
            brollPrompt: beat.brollPrompt || '',
            matchKeywords: beat.matchKeywords,
            transcriptSnippet: beat.transcriptSnippet,
            priority: beat.priority,
            showNarrator: beat.showNarrator,
            showNarratorFirst: beat.showNarrator,
            overlayDelaySeconds: beat.overlayDelaySeconds,
            returnToNarratorBeforeEnd: returnToNarr,
            narratorReturnLeadSeconds: narrReturnLead,
            brollMode: 'tactical_broll',
            brollTrack: 'generated',
            isRequiredTacticalBroll: beat.isRequiredTacticalSlot ?? false,
            isRequiredTacticalSlot: beat.isRequiredTacticalSlot ?? false,
            tacticalPlacementReason: beat.tacticalPlacementReason ?? 'AI-planned early pattern interrupt',
            plannedEntryTime: beatStart,
            rationale: beat.rationale ?? '',
          }),
          captureStatus: 'Pending',
        });
      }
    }

    // ── Log final shot plan with three-phase timing ─────────────────────────────
    console.log(`[runPipeline] ✅ Final shot plan: ${shotRecords.length} shots`);
    for (const s of shotRecords) {
      let phaseInfo = '';
      try {
        if (s.uiLabelsJson) {
          const lbl = JSON.parse(s.uiLabelsJson);
          const delay = lbl.overlayDelaySeconds ?? 0;
          const retLead = lbl.narratorReturnLeadSeconds ?? 0;
          const ret = lbl.returnToNarratorBeforeEnd === true;
          const isReq = lbl.isRequiredTacticalBroll === true || lbl.isRequiredTacticalSlot === true;
          if (s.shotType !== 'Talking Head') {
            phaseInfo = ` | phases: narr=${delay}s→overlay→${ret ? `narr-return(${retLead}s)` : 'end'}`;
            if (isReq) phaseInfo += ' ⚡REQ';
          }
        }
      } catch { /* */ }
      console.log(`[runPipeline] SHOT ${(s.startTime ?? 0).toFixed(2)}s–${(s.endTime ?? 0).toFixed(2)}s | ${(s.shotType ?? '').padEnd(14)} | beat=${(s.beat ?? '').padEnd(6)} | "${(s.caption ?? '').slice(0, 50)}"${phaseInfo}`);
    }

    // ── Persist shot records ──────────────────────────────────────────────────
    const allCreated: Array<{ id: string; fields: any }> = [];
    for (let i = 0; i < shotRecords.length; i += 100) {
      const res = await Shots.bulkCreate({ records: shotRecords.slice(i, i + 100) as any });
      allCreated.push(...res.records);
    }

    const shotsWithIds = shotRecords.map((sr, i) => ({ ...sr, id: allCreated[i]?.id }));

    // ── Phase 5: Camera keyframe generation for TH shots ─────────────────────
    const animationMapForDisplay = intensityMapRaw.map((e) => ({
      second: e.second,
      intensity: numericToIntensityLabel(e.intensity),
    }));
    const animationMapJson = animationMapForDisplay.length ? JSON.stringify(animationMapForDisplay) : undefined;

    type CamKf = { t: number; zoom: number; panX: number; panY: number };
    const KEYFRAME_PRESETS: Record<string, CamKf[]> = {
      baseline: [],
      minor:   [{ t: 0, zoom: 1, panX: 0, panY: 0 },    { t: 1, zoom: 1.02, panX: 0, panY: -0.01 }],
      major:   [{ t: 0, zoom: 1, panX: 0, panY: 0 },    { t: 0.5, zoom: 1.03, panX: 0, panY: -0.01 }, { t: 1, zoom: 1.04, panX: 0, panY: -0.02 }],
      massive: [{ t: 0, zoom: 1, panX: 0, panY: 0 },    { t: 0.4, zoom: 1.05, panX: 0.01, panY: -0.01 }, { t: 1, zoom: 1.06, panX: 0, panY: -0.02 }],
      peak:    [{ t: 0, zoom: 1, panX: 0, panY: 0 },    { t: 0.3, zoom: 1.06, panX: 0.01, panY: -0.01 }, { t: 0.6, zoom: 1.08, panX: 0, panY: -0.02 }, { t: 1, zoom: 1.06, panX: -0.01, panY: -0.01 }],
    };

    const thItems = shotsWithIds.filter((s) => s.shotType === 'Talking Head' && s.id);
    await Promise.all(
      thItems.map(async (s) => {
        const segStart = s.startTime ?? 0;
        const segEnd   = s.endTime   ?? segStart + 5;
        const subMap   = intensityMapRaw.filter(
          (e) => e.second >= Math.floor(segStart) && e.second < Math.ceil(segEnd)
        );
        const maxVal  = Math.max(...subMap.map(e => e.intensity), 0);
        const label   = numericToIntensityLabel(maxVal);
        const keyframes = KEYFRAME_PRESETS[label] ?? [];
        if (keyframes.length === 0 || !s.id) return;

        let existing: Record<string, any> = {};
        try { if (s.uiLabelsJson) existing = JSON.parse(s.uiLabelsJson); } catch { /* */ }
        await Shots.update({
          id: s.id,
          record: { uiLabelsJson: JSON.stringify({ ...existing, cameraKeyframes: keyframes }) },
        });
      })
    );

    // ── Final project update ──────────────────────────────────────────────────
    // Merge pacing validation into directorJson for debug/inspection
    let directorData: any = {};
    try { directorData = JSON.parse(directorRaw); } catch { /* */ }
    directorData.pacingValidation = pacingValidation;
    directorData.editorialRulesVersion = 4;
    if (directorData.editApproach) {
      const ea = directorData.editApproach;
      console.log(`[runPipeline] 🎬 Edit approach: category=${ea.category ?? '?'} mode=${ea.mode ?? '?'} target=${ea.overlayTargetPercent ?? '?'}% — ${ea.reasoning ?? ''}`);
    }

    await Projects.update({
      id: projectId,
      record: {
        directorJson: JSON.stringify(directorData),
        animationMapJson,
        musicTrack: trackId ?? undefined,
        status: 'Capturing',
      },
    });

    console.log(`[runPipeline] ✅ Pipeline complete — ${shotRecords.length} shots, status → Capturing`);
    return { success: true, shotCount: shotRecords.length };
  },
});
