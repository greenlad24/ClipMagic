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

      for (let i = 0; i < words.length; i++) {
        currentGroup.push(words[i]);
        const nextW = words[i + 1];
        const gap = nextW ? nextW.start - words[i].end : Infinity;
        if (gap > 0.35 || currentGroup.length >= 4) {
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

    const semanticBeatPrompt = `You are a senior short-form video editor analyzing a narration script to plan cuts.

Your job: split this transcript into SEMANTIC BEATS — meaningful rhetorical segments where the speaker's intent, topic, or energy shifts. Think like an editor watching the script performed: where would you cut away from a talking head to show something more compelling?

TRANSCRIPT (word-level timestamps):
${transcriptForPrompt}

DURATION: ${duration.toFixed(1)}s
CONTEXT: ${project.contextHint ?? 'none'}

AVAILABLE PRODUCT URLs for screencast shots:
${urlReferenceBlock}

For each beat, decide:
  beatType: one of "hook" | "pain" | "problem" | "proof" | "demo" | "objection" | "payoff" | "cta" | "transition"
  visualIntent: one of "talking_head" | "screencast" | "tactical_broll"
  showNarrator: boolean — should the narrator's face be visible during this beat?
  overlayDelaySeconds: number — if an overlay (screencast/broll) is used, how many seconds to keep showing the narrator before cutting to the overlay. Default 1.0.

CORE EDITING PHILOSOPHY:
  When deciding between showing the narrator and showing an overlay, optimize for TRUST first, PROOF second, STYLE third.
  THE VIEWER SHOULD ALMOST NEVER SEE A LONG STATIC TALKING HEAD SHOT IN THE MIDDLE OF THE VIDEO.
  After the brief opening, the edit should be DENSE with screencasts and at least one early tactical B-roll.

VISUAL INTENT RULES — SCREENCAST-DOMINANT WITH REQUIRED EARLY TACTICAL B-ROLL:

  MANDATORY EDITORIAL FLOW (the required video structure):
    1. Narrator visible first (talking_head) — KEEP THIS SHORT: 0.5–1.5 seconds MAX for the opening beat
    2. ONE tactical_broll moment IMMEDIATELY after — must be the 2nd beat, starting around 0.8–2.0 seconds
    3. Then transition into screencast-dominant proof/demo flow for the MAJORITY of the remaining video
    4. Talking_head returns ONLY for brief authority/opinion moments, CTA, or short transition resets (max 3–4s each)

  CRITICAL OPENING RULE:
    - The FIRST beat must be talking_head, but SHORT (0.5–1.5s, just enough for the narrator to appear)
    - The SECOND beat MUST be tactical_broll, starting between 0.8s and 2.0s. NOT at 6s. NOT at 4s. AROUND 1 SECOND.
    - After the tactical B-roll, the next beats should be screencast.
    - NEVER wait until 4+ seconds to show the first B-roll. The first visual change MUST happen around 1 second.

  • "talking_head" — USE SPARINGLY. Only for:
      - Opening hook (KEEP SHORT: 0.5–1.5s max for the first beat)
      - Brief authority/trust moments ("I've been doing this for 10 years…") — max 3–4s
      - Personal opinion or emotion — max 3–4s
      - CTA at the end
      - Short transition resets between screencasts — max 2–3s
    AFTER THE FIRST 6–8 SECONDS, DO NOT ALLOW ANY UNINTERRUPTED TALKING_HEAD BEAT LONGER THAN 3–4 SECONDS.
    If the script discusses any product, tool, feature, or proof point, USE SCREENCAST INSTEAD.
    Set showNarrator=true, overlayDelaySeconds=0 for these.

  • "screencast" — THE DOMINANT VISUAL TYPE. This should cover 50–70% of the total video duration.
    USE SCREENCAST FOR ANY BEAT ABOUT: products, tools, features, workflows, software, comparisons, proof points, use cases, demonstrations, "how it works", categories, free alternatives, pricing, or anything that COULD be shown with product footage.
    WHEN IN DOUBT, USE SCREENCAST. It is always better than talking_head for informational content.
    Set productEntity to the product name and matchKeywords to search terms.
    Set showNarrator=true and overlayDelaySeconds=1.0 to keep the narrator visible briefly before the screencast appears.

  • "tactical_broll" — EXACTLY 1 required per video (2 max only if strongly justified).
    PLACEMENT: MUST be the 2nd beat, starting around 0.8–2.0 seconds. This is NON-NEGOTIABLE.
    PURPOSE: early pattern interrupt, emotional hook, visual punch.
    GOOD CANDIDATES:
      - Pain point / frustration ("you're wasting hours on…")
      - Emotional contrast ("imagine if you could just…")
      - Hook / attention grab after narrator
      - Setup moment ("the problem is…")
    Set showNarrator=true and overlayDelaySeconds=1.0.
    Mark with "isRequiredTacticalSlot": true.

  PACING GUARD — ENFORCED STRICTLY:
    After the first 6–8 seconds of the video, check EVERY talking_head beat:
      - If it is longer than 3.5 seconds AND the script content discusses ANY product/tool/feature/workflow → CHANGE IT TO SCREENCAST
      - If it is longer than 4.0 seconds for ANY reason → split it or shorten it
    The goal: NO long static talking head stretches in the middle. The viewer's eye should always be engaged with visual changes.

STRICT RULES:
  • The FIRST beat is talking_head lasting 0.5–1.5s.
  • The SECOND beat MUST be tactical_broll starting around 0.8–2.0s.
  • After that, SCREENCAST should be the dominant visual (50–70% of remaining duration).
  • talking_head after 6–8s must be ≤ 3–4 seconds each. Break up longer sections.
  • Every video MUST have at least 1 tactical_broll beat.
  • Do NOT have more than 2 tactical_broll beats.
  • SCREENCAST is the default. If a product or feature is mentioned, use screencast.
  • Do NOT use tactical_broll when a screencast would work.
  • For non-talking-head beats, prefer overlayDelaySeconds=1.0.
  • Beats should cover the ENTIRE duration with no gaps.
  • Aim for 8–18 beats (more beats = tighter pacing = better). Short scripts (< 30s) should have 6–10 beats.
  • Each beat must have start/end times matching transcript word timestamps.
  • priority: 1 = most important cut, higher = less critical.

Return ONLY valid JSON (no markdown fences):
{
  "beats": [
    {
      "start": 0.0,
      "end": 3.5,
      "beatType": "hook",
      "summary": "Direct-to-camera hook grabbing attention",
      "productEntity": null,
      "featureEntity": null,
      "emotionalIntent": "curiosity",
      "visualIntent": "talking_head",
      "showNarrator": true,
      "overlayDelaySeconds": 0,
      "priority": 2,
      "transcriptSnippet": "You won't believe what this tool can do",
      "matchKeywords": [],
      "isRequiredTacticalSlot": false
    }
  ],
  "intensity_map": [{"second":0,"intensity":95},{"second":1,"intensity":70}]
}

Also generate an intensity_map for EVERY integer second 0 through ${Math.floor(duration)}, assign a numeric value 0–100:
  0–14 = static/baseline | 15–39 = subtle zoom | 40–69 = moderate zoom | 70–89 = strong push zoom | 90–100 = snap zoom peak
  Use 90–100 sparingly for true high-energy moments (opening hook, major reveals, CTA).`;

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

    // RULE 1: Cap tactical_broll at 2 (demote excess)
    if (tacticalCount > 2) {
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
        if (tacticalCount <= 2) break;
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

    // RULE 2: Enforce MINIMUM 1 tactical_broll per video (promote best early candidate if missing)
    if (tacticalCount === 0 && semanticBeats.length > 1 && duration > 3) {
      console.log('[runPipeline] ⚡ No tactical_broll found — promoting best early candidate');
      const emotionalBeatTypes = new Set(['hook', 'pain', 'problem', 'objection']);
      const candidates = semanticBeats
        .map((b, i) => ({ b, i }))
        .filter(({ b, i }) => {
          if (i === 0 && semanticBeats.length > 2) return false; // keep narrator visible first
          if (b.beatType === 'cta') return false;
          if (b.visualIntent === 'talking_head' && b.start > duration * 0.7) return false;
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
          // Prefer emotional beat types
          if (emotionalBeatTypes.has(b.beatType)) score += 40;
          // Prefer non-screencast (less disruption)
          if (b.visualIntent === 'talking_head') score += 10;
          // Prefer 2nd or 3rd beat position
          if (i === 1) score += 25;
          if (i === 2) score += 15;
          return { b, i, score };
        })
        .sort((a, b) => b.score - a.score);

      if (candidates.length > 0) {
        const winner = candidates[0].b;
        const prevIntent = winner.visualIntent;
        winner.visualIntent = 'tactical_broll';
        winner.showNarrator = true;
        winner.overlayDelaySeconds = winner.overlayDelaySeconds || 1.0;
        winner.isRequiredTacticalSlot = true;
        winner.tacticalPlacementReason = `Promoted from ${prevIntent} — required early tactical B-roll (beat "${winner.beatType}" at ${winner.start.toFixed(1)}s, score=${candidates[0].score})`;
        tacticalCount = 1;
        console.log(`[runPipeline] ⬆ Promoted ${prevIntent} → tactical_broll at ${winner.start.toFixed(2)}s | beat="${winner.beatType}" | "${winner.summary.slice(0, 50)}" | reason: ${winner.tacticalPlacementReason}`);
      } else {
        console.warn('[runPipeline] ⚠ Could not find any suitable candidate for required tactical B-roll');
      }
    }

    // Ensure the required tactical slot is flagged on at least one beat
    const tacticalBeats = semanticBeats.filter(b => b.visualIntent === 'tactical_broll');
    if (tacticalBeats.length > 0 && !tacticalBeats.some(b => b.isRequiredTacticalSlot)) {
      const earliest = tacticalBeats.sort((a, b) => a.start - b.start)[0];
      earliest.isRequiredTacticalSlot = true;
      if (!earliest.tacticalPlacementReason) {
        earliest.tacticalPlacementReason = `Earliest tactical B-roll at ${earliest.start.toFixed(1)}s — marked as required minimum slot`;
      }
      console.log(`[runPipeline] 📌 Marked tactical_broll at ${earliest.start.toFixed(2)}s as required slot`);
    }

    // ── Phase 3.7: PACING GUARD — enforce strict editorial rules ──────────────
    // This runs AFTER tactical B-roll enforcement and BEFORE shot record creation.
    // It auto-corrects the plan if it violates pacing rules.

    const pacingLog: string[] = [];

    // RULE A: First tactical B-roll must start before 2.5s
    const firstTactical = semanticBeats.find(b => b.visualIntent === 'tactical_broll');
    const firstTacticalStart = firstTactical?.start ?? null;
    if (firstTacticalStart !== null && firstTacticalStart > 2.5) {
      pacingLog.push(`⚠ First tactical B-roll at ${firstTacticalStart.toFixed(2)}s is too late (target: 0.8–2.0s)`);
      // Try to split the first beat to create an earlier tactical slot
      const firstBeat = semanticBeats[0];
      if (firstBeat && firstBeat.visualIntent === 'talking_head' && firstBeat.end > 1.5) {
        const splitPoint = Math.min(1.2, firstBeat.end * 0.4);
        // Move the tactical_broll to start at splitPoint
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
          pacingLog.push(`✅ Moved tactical B-roll from ${oldTacStart.toFixed(2)}s → ${firstTactical.start.toFixed(2)}s (split opening TH at ${splitPoint.toFixed(2)}s)`);
          // Re-sort
          semanticBeats.sort((a, b) => a.start - b.start);
        }
      }
    } else if (firstTacticalStart !== null) {
      pacingLog.push(`✅ First tactical B-roll at ${firstTacticalStart.toFixed(2)}s — within target range`);
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

    // RULE C: Break up long uninterrupted TH stretches after 6s
    // Compute consecutive TH duration by merging adjacent TH beats
    const TH_MAX_AFTER_OPENING = 3.5; // seconds
    const OPENING_BOUNDARY = 6.0; // seconds — rule kicks in after this point
    let pacingRevisions = 0;
    const maxPacingPasses = 3; // prevent infinite loops

    for (let pass = 0; pass < maxPacingPasses; pass++) {
      let madeChange = false;
      semanticBeats.sort((a, b) => a.start - b.start);

      for (let i = 0; i < semanticBeats.length; i++) {
        const beat = semanticBeats[i];
        if (beat.visualIntent !== 'talking_head') continue;
        if (beat.start < OPENING_BOUNDARY) continue;

        const beatDur = beat.end - beat.start;
        if (beatDur <= TH_MAX_AFTER_OPENING) continue;

        // This TH beat is too long after the opening section
        // Try to promote it to screencast if there are product URLs available
        if (hasScreencastUrls) {
          // Check if the transcript content could support a screencast
          const prevIntent = beat.visualIntent;
          beat.visualIntent = 'screencast';
          beat.showNarrator = true;
          beat.overlayDelaySeconds = 1.0;
          pacingLog.push(`✅ Promoted long TH (${beatDur.toFixed(1)}s at ${beat.start.toFixed(1)}s) → screencast (was ${prevIntent}, exceeded ${TH_MAX_AFTER_OPENING}s limit)`);
          madeChange = true;
          pacingRevisions++;
        } else {
          // No screencast URLs — split into shorter TH beats
          const splitPoint = parseFloat((beat.start + TH_MAX_AFTER_OPENING).toFixed(3));
          const newBeat: SemanticBeat = {
            ...beat,
            start: splitPoint,
            end: beat.end,
            summary: beat.summary + ' (cont.)',
          };
          beat.end = splitPoint;
          semanticBeats.splice(i + 1, 0, newBeat);
          pacingLog.push(`✅ Split long TH at ${beat.start.toFixed(1)}s into two beats at ${splitPoint.toFixed(1)}s (no screencast URLs available)`);
          madeChange = true;
          pacingRevisions++;
        }
        break; // restart pass after modification
      }
      if (!madeChange) break;
    }

    // RULE D: Check consecutive TH blocks (adjacent TH beats that form one long stretch)
    for (let pass = 0; pass < maxPacingPasses; pass++) {
      let madeChange = false;
      semanticBeats.sort((a, b) => a.start - b.start);

      for (let i = 0; i < semanticBeats.length; i++) {
        if (semanticBeats[i].visualIntent !== 'talking_head') continue;
        if (semanticBeats[i].start < OPENING_BOUNDARY) continue;

        // Find consecutive TH stretch
        let stretchEnd = i;
        while (stretchEnd + 1 < semanticBeats.length &&
               semanticBeats[stretchEnd + 1].visualIntent === 'talking_head' &&
               Math.abs(semanticBeats[stretchEnd].end - semanticBeats[stretchEnd + 1].start) < 0.1) {
          stretchEnd++;
        }
        const stretchDur = semanticBeats[stretchEnd].end - semanticBeats[i].start;
        if (stretchDur > TH_MAX_AFTER_OPENING && stretchEnd > i && hasScreencastUrls) {
          // Promote the longest beat in this stretch to screencast
          let longestIdx = i;
          let longestDur = 0;
          for (let j = i; j <= stretchEnd; j++) {
            const d = semanticBeats[j].end - semanticBeats[j].start;
            if (d > longestDur) { longestDur = d; longestIdx = j; }
          }
          semanticBeats[longestIdx].visualIntent = 'screencast';
          semanticBeats[longestIdx].showNarrator = true;
          semanticBeats[longestIdx].overlayDelaySeconds = 1.0;
          pacingLog.push(`✅ Broke up consecutive TH stretch (${stretchDur.toFixed(1)}s at ${semanticBeats[i].start.toFixed(1)}s) — promoted beat at ${semanticBeats[longestIdx].start.toFixed(1)}s to screencast`);
          madeChange = true;
          pacingRevisions++;
          break;
        }
      }
      if (!madeChange) break;
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

    const updatedFirstTactical = semanticBeats.find(b => b.visualIntent === 'tactical_broll');
    const finalFirstTacticalStart = updatedFirstTactical?.start ?? -1;

    const pacingValidation = {
      firstTacticalBrollStart: finalFirstTacticalStart,
      totalTalkingHeadDuration: parseFloat(totalTHDuration.toFixed(2)),
      totalScreencastDuration: parseFloat(totalSCDuration.toFixed(2)),
      totalTacticalBrollDuration: parseFloat(totalTBDuration.toFixed(2)),
      longestTalkingHeadStretch: parseFloat(longestTHStretch.toFixed(2)),
      videoDuration: parseFloat(duration.toFixed(2)),
      screencastCoveragePercent: parseFloat(((totalSCDuration / duration) * 100).toFixed(1)),
      talkingHeadCoveragePercent: parseFloat(((totalTHDuration / duration) * 100).toFixed(1)),
      pacingRevisions,
      passed: finalFirstTacticalStart >= 0 && finalFirstTacticalStart <= 2.5 &&
              longestTHStretch <= 5.0 &&
              (totalSCDuration >= totalTHDuration * 0.5 || !hasScreencastUrls),
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
            veo3Prompt: beat.summary,
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
    directorData.editorialRulesVersion = 2;

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
