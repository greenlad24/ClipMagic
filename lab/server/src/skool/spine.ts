/**
 * Designing a new spine for the classroom.
 *
 * THE ATOM HERE IS A UNIT, NOT A COURSE, and that is the decision the whole
 * file rests on. 55 of the 60 courses are a single video with a written
 * companion, so "course" is not a meaningful unit of curriculum in this
 * classroom — it is just what a video got wrapped in. Meanwhile 60 of the 123
 * modules are completely empty: a title with no video and no text behind it.
 *
 * So the planner works over the things that actually carry content — every unit
 * with a video or a body, plus the channel's videos that never made it in — and
 * the empty modules simply cease to exist in the new structure. Nothing is
 * "moved" from them because there was never anything in them.
 *
 * TWO PASSES, NEVER ONE — the rule the audit's custom sections established. The
 * model designs the spine first, seeing only the shape of the catalogue. Then,
 * with the spine fixed, it places items into it. Asking for structure and
 * assignment in one breath gets a structure bent to whatever the model happened
 * to place first.
 *
 * THE MODEL NEVER HANDLES AN ID. It sees numbered items and returns numbers;
 * the server maps those back to real Skool ids and YouTube ids. A hallucinated
 * course id would be written to a live community.
 */
import { claudeJSONForPurpose } from "../ai/claude.js";
import type { SkoolInventory } from "./classroom.js";

/** One placeable thing: an existing unit that carries content, or a video. */
export interface SpineItem {
  /** Stable index the model uses to refer to this. Never a Skool id. */
  index: number;
  kind: "unit" | "video" | "written";
  title: string;
  /** For a unit, the course it currently sits in. */
  courseTitle: string | null;
  courseSlug: string | null;
  courseId: string | null;
  unitId: string | null;
  videoId: string | null;
  views: number | null;
  publishedAt: string | null;
  /** Length of the written body, and the opening of it. */
  chars: number;
  excerpt: string;
  /**
   * For an AUTHORED chapter: the written lesson itself.
   *
   * A chapter the creator has no video for. It is authored rather than left
   * blank because a titled chapter with nothing behind it is exactly what made
   * this classroom hollow in the first place — 60 of its 123 modules.
   */
  body?: string;
}

export interface SpineModule {
  title: string;
  /** Which item fills this slot. */
  item: SpineItem;
  /** Why it belongs here, in the model's words. */
  reason: string;
}

export interface SpineTrack {
  title: string;
  /** What a member can do after finishing it. */
  promise: string;
  /** True when the operator required this track, rather than the model designing it. */
  required: boolean;
  /**
   * The track's lessons, in order.
   *
   * FLAT, by decision. Skool supports folders inside a course, and an earlier
   * pass grouped chapters into them — Jake asked for pages only. A course is a
   * list of pages, and a member reaching every lesson without an extra click
   * is worth more than the tidiness of sections.
   */
  modules: SpineModule[];
}

const CHAPTERS_SYSTEM = `You are laying out the chapters of one course in a classroom.

You are given the course, what the creator said it should be, and the lessons
already assigned to it. Return the FULL ordered chapter list the course should
have to deliver on its promise — including chapters there is no lesson for yet.

{"chapters":[{"title":"...","covers":N or null,"why":"one line"}]}

"covers" is the number of an existing lesson, or null when nothing covers it.
Use each existing lesson at most once; every lesson given to you must be
covered by exactly one chapter. Do not invent lessons — a chapter with no
lesson is exactly what we want to know about.

Be realistic about scope. A course of 6-12 chapters is a course; 30 is a
reference manual nobody finishes.`;

const AUTHOR_SYSTEM = `You write lessons for a paid community's classroom, in the creator's voice.

You are given the creator's own writing as the reference for voice, and a
chapter to write. Write the LESSON ITSELF — the thing a member reads.

- Match the reference's voice, density and formatting habits. If they use short
  headed sections and copy-paste blocks, do the same.
- Be concrete and specific. Real settings, real steps, real prompt text.
- No preamble about what you are about to cover, no "in conclusion".
- Never claim the creator did or said something you were not told.
- If the chapter names a platform, everything must be true of THAT platform.

Return JSON only: {"body":"the lesson, as plain text with line breaks"}`;

/** Bounds on authoring — a runaway here is real money and a wall of unread text. */
const MAX_AUTHORED_PER_TRACK = 8;
const MAX_AUTHORED_TOTAL = 30;

export interface SpinePlan {
  tracks: SpineTrack[];
  /** Deliberately left out of the spine, each with a stated reason. */
  notPlaced: { item: SpineItem; reason: string }[];
  /**
   * Items the model never returned a verdict on.
   *
   * These are a BUG being surfaced, not a category. Everything must be either
   * placed or explicitly declined; anything that lands here was dropped, and it
   * is reported rather than quietly treated as "not placed" — that is exactly
   * how content goes missing in a rebuild.
   */
  unassigned: SpineItem[];
  emptyModulesDropped: number;
  /** How many rebalance rounds ran, and whether it actually converged. */
  rebalanceRounds: number;
  /** Non-required tracks still outside the bounds after the last round. */
  stillOversized: string[];
  /** Chapters written because no lesson existed for them. */
  authoredCount: number;
  createdAt: number;
}

const EXCERPT_CHARS = 220;

/**
 * Build the list of placeable items.
 *
 * A unit qualifies if it has a video or any written body. The empty ones are
 * counted and reported, not carried.
 */
export function buildItems(
  inventory: SkoolInventory,
  missingVideos: { videoId: string; title: string; views: number | null; publishedAt: string | null }[],
): { items: SpineItem[]; emptyModulesDropped: number } {
  const items: SpineItem[] = [];
  let empty = 0;

  for (const course of inventory.courses) {
    for (const unit of course.units) {
      if (unit.depth === 0) continue; // the course node itself, not content
      if (!unit.videoUrl && unit.contentChars === 0) {
        empty++;
        continue;
      }
      items.push({
        index: items.length,
        kind: "unit",
        title: unit.title || course.title,
        courseTitle: course.title,
        courseSlug: course.slug,
        courseId: course.id,
        unitId: unit.id,
        videoId: youtubeIdOf(unit.videoUrl),
        views: null,
        publishedAt: unit.createdAt ? unit.createdAt.slice(0, 10) : null,
        chars: unit.contentChars,
        excerpt: unit.content.slice(0, EXCERPT_CHARS).replace(/\s+/g, " ").trim(),
      });
    }
  }

  for (const v of missingVideos) {
    items.push({
      index: items.length,
      kind: "video",
      title: v.title,
      courseTitle: null,
      courseSlug: null,
      courseId: null,
      unitId: null,
      videoId: v.videoId,
      views: v.views,
      publishedAt: v.publishedAt,
      chars: 0,
      excerpt: "",
    });
  }

  return { items, emptyModulesDropped: empty };
}

/** `https://youtu.be/XXXX` and friends → the id. */
export function youtubeIdOf(url: string | null): string | null {
  const m = String(url ?? "").match(/(?:youtu\.be\/|v=|embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function itemLine(it: SpineItem): string {
  const bits = [
    `#${it.index}`,
    it.kind === "video" ? "[not in classroom]" : "[in classroom]",
    it.title,
  ];
  if (it.views != null) bits.push(`${it.views} views`);
  if (it.publishedAt) bits.push(it.publishedAt);
  if (it.chars) bits.push(`${it.chars} chars written`);
  if (it.kind === "unit" && it.courseTitle && it.courseTitle !== it.title) bits.push(`in "${it.courseTitle}"`);
  const line = bits.join(" · ");
  return it.excerpt ? `${line}\n     ${it.excerpt}` : line;
}

/**
 * Tracks the operator has required.
 *
 * These are a CONSTRAINT ON THE STRUCTURE, not a line in a prompt, and that
 * distinction is the whole point. The first spine run produced a 34-module
 * track and a 3-module track while the prompt told it, in as many words, not
 * to do either. So a required track is inserted into the spine by the server
 * and the model designs the rest around it — it is never asked to remember.
 */
export interface RequiredTrack {
  title: string;
  /** Operator guidance for what belongs in it and how it should be shaped. */
  note: string;
}

const SPINE_SYSTEM = `You design curricula for a paid community's classroom.

You are given every piece of content a creator has: lessons already in their
classroom, and videos from their channel that are not in it yet.

Design the SPINE — the ordered set of tracks a member moves through. Judge it
by one question: can a member land here, know where to start, and see a path
that ends somewhere worth ending?

Rules:
- Tracks are ordered by the member's journey, not by your sense of importance.
- A track is a promise. Name what someone can DO after it, not the topic.
- Prefer few strong tracks over many thin ones. A track with two lessons is a
  section of another track, not a track.
- The catalogue's real shape decides the spine. If half of it is one subject,
  that subject needs internal structure, not one enormous track.
- Titles are for a member browsing, not for search. No clickbait, no ALL CAPS.

Some tracks may be REQUIRED. Those already exist and are listed for you; do
not restate them, rename them, or design around their absence. Design the
tracks that should exist ALONGSIDE them, and do not duplicate their subject —
if a required track covers making images, no track of yours should.

Return JSON only:
{"tracks":[{"title":"...","promise":"one sentence: what they can do after"}]}`;

const ASSIGN_SYSTEM = `You are placing content items into a fixed curriculum spine.

For EVERY item you are given, return exactly one verdict:
- placed:  {"index":N,"track":T,"title":"module title","reason":"why here"}
- declined:{"index":N,"track":null,"reason":"why it does not belong"}

Rules:
- Every index you are given must appear exactly once in your answer.
- "title" is the module title as a member will see it inside the track. Rewrite
  a YouTube title into a lesson title: drop the clickbait, keep the substance.
  ("How to Scrape UNLIMITED LinkedIn Leads" -> "Scraping LinkedIn leads").
- Decline an item only when it genuinely serves no track: a dated tool review,
  a news reaction, something superseded by a better lesson in the set. Say
  which, in the reason. When two items cover the same ground, place the
  stronger one and decline the other naming it.
- Do not invent items. Do not merge two indices into one verdict.

Return JSON only: {"verdicts":[...]}`;

/** How many items go in one assignment call. */
const ASSIGN_BATCH = 20;

/**
 * ⚠️ THE SPINE IS DESIGNED BLIND TO HOW MANY ITEMS WILL LAND IN EACH TRACK.
 *
 * That is the flaw this pass exists for, and it is not a prompt-wording
 * problem. The first run produced a 34-module scraping track and a 3-module
 * prompting track — both violating instructions the prompt gave in as many
 * words — because at design time the model is guessing at a distribution it
 * cannot see. Telling it harder does not give it the numbers.
 *
 * So once assignment has happened, the real counts go back to it and it revises
 * the spine: split what is unusable, fold what is too thin. Then everything is
 * placed again against the revised spine.
 *
 * Bounds are about a member reading a list, not about balance for its own sake.
 * Below MIN a track is a section of something else; above MAX it is a wall.
 */
const MIN_TRACK = 4;
const MAX_TRACK = 15;

/**
 * Rebalance rounds.
 *
 * One round is not enough: splitting a track and re-assigning everything can
 * reconstitute a different oversized track (a 34 became a 19 that way). So it
 * loops — but it is bounded, because there may be no fixed point at all, and a
 * planner that never returns is worse than a track of 19. If it runs out of
 * rounds the plan says so rather than pretending it converged.
 */
const MAX_REBALANCE_ROUNDS = 4;

const REBALANCE_SYSTEM = `You are revising a curriculum spine you designed, now that you can see how
many lessons actually landed in each track.

Split any track that is too large to browse into coherent named tracks — split
by what the lessons are ABOUT, never "Part 1 / Part 2". Fold any track too thin
to stand on its own into the track it most belongs to.

Keep everything else. A track at a workable size should come back unchanged,
with its exact title, so the work already done for it still applies.

Return JSON only: {"tracks":[{"title":"...","promise":"..."}]}`;

type Verdict = { track: number | null; title?: string; reason: string };

/**
 * Place every item into the given spine.
 *
 * Batching is BY ITEM, not by track, and that is what makes "exactly once"
 * hold: each batch covers a disjoint set of indices, so no item can be placed
 * twice by two calls that cannot see each other.
 */
async function assignAll(
  items: SpineItem[],
  tracks: { title: string; promise: string; required?: boolean }[],
): Promise<Map<number, Verdict>> {
  const trackList = tracks.map((t, i) => `${i}. ${t.title} — ${t.promise}`).join("\n");
  const verdicts = new Map<number, Verdict>();

  for (let i = 0; i < items.length; i += ASSIGN_BATCH) {
    const batch = items.slice(i, i + ASSIGN_BATCH);
    const raw = await claudeJSONForPurpose({
      tier: "director",
      purpose: "skool-assign",
      system: ASSIGN_SYSTEM,
      messages: [
        {
          role: "user",
          content: `The spine:\n${trackList}\n\nPlace these ${batch.length} items:\n${batch.map(itemLine).join("\n")}`,
        },
      ],
    });
    let parsed: any[] = [];
    try {
      parsed = JSON.parse(raw)?.verdicts ?? [];
    } catch {
      parsed = [];
    }
    for (const v of parsed) {
      const index = Number(v?.index);
      // Ignore a verdict for an index outside this batch: a model reaching into
      // another batch is how an item ends up placed twice.
      if (!batch.some((b) => b.index === index)) continue;
      if (verdicts.has(index)) continue;
      const track = v?.track == null ? null : Number(v.track);
      verdicts.set(index, {
        track: track != null && track >= 0 && track < tracks.length ? track : null,
        title: typeof v?.title === "string" ? v.title.trim() : undefined,
        reason: String(v?.reason ?? "").trim(),
      });
    }
  }
  return verdicts;
}

/**
 * Design the spine, place every item in it, then revise it against the real
 * distribution and place everything again.
 */
export async function planSpine(
  items: SpineItem[],
  emptyModulesDropped: number,
  opts: {
    communityName: string | null;
    roadmap: string;
    requiredTracks?: RequiredTrack[];
    /** The creator's own lesson bodies, as the voice reference for authoring. */
    voiceSamples?: string[];
  },
): Promise<SpinePlan> {
  const required = (opts.requiredTracks ?? []).filter((t) => t.title.trim());
  // ---- pass 1: the spine itself, from the shape of the catalogue ----------
  const catalogue = items.map(itemLine).join("\n");
  const spineRaw = await claudeJSONForPurpose({
    tier: "director",
    purpose: "skool-spine",
    system: SPINE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          opts.communityName ? `Community: ${opts.communityName}` : "",
          opts.roadmap ? `\nWhere the creator wants members to end up:\n${opts.roadmap}` : "",
          required.length
            ? `\nREQUIRED tracks that already exist in the spine:\n${required
                .map((t) => `- ${t.title}${t.note ? ` — ${t.note}` : ""}`)
                .join("\n")}`
            : "",
          `\n${items.length} content items:\n${catalogue}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  let designed: { title: string; promise: string }[] = [];
  try {
    designed = (JSON.parse(spineRaw)?.tracks ?? []).filter((t: any) => t?.title);
  } catch {
    designed = [];
  }
  // Drop anything the model produced that collides with a required title — it
  // was told not to restate them, and a duplicate track would split its lessons
  // across two homes.
  const requiredTitles = new Set(required.map((t) => t.title.toLowerCase()));
  designed = designed.filter((t) => !requiredTitles.has(String(t.title).toLowerCase()));

  // Required tracks lead: they are what the operator asked the classroom to be.
  let tracks: { title: string; promise: string; required?: boolean }[] = [
    ...required.map((t) => ({ title: t.title, promise: t.note, required: true })),
    ...designed,
  ];
  if (tracks.length === 0) throw new Error("The spine designer returned no tracks.");

  // ---- pass 2: place every item, in disjoint batches ----------------------
  let verdicts = await assignAll(items, tracks);

  // ---- pass 3: rebalance, now that the real distribution is known ---------
  let rebalanceRounds = 0;
  for (let round = 0; round < MAX_REBALANCE_ROUNDS; round++) {
    const counts = tracks.map((_, i) => [...verdicts.values()].filter((v) => v.track === i).length);
    // A required track is exempt from the bounds: the operator asked for it, and
    // splitting or folding it away would quietly overrule them.
    const unusable = counts.some(
      (n, i) => !tracks[i].required && (n > MAX_TRACK || (n > 0 && n < MIN_TRACK)),
    );
    if (!unusable) break;
    rebalanceRounds++;
    const withCounts = tracks
      .map((t, i) => {
        const placed = items.filter((it) => verdicts.get(it.index)?.track === i);
        const verdict = t.required
          ? "REQUIRED — return exactly as-is"
          : counts[i] > MAX_TRACK
            ? "TOO LARGE — split it"
            : counts[i] < MIN_TRACK
              ? "TOO THIN — fold it in"
              : "fine";
        // The oversized tracks get their lesson titles listed, because a split
        // has to be made on what the lessons are about.
        const listing =
          counts[i] > MAX_TRACK && !t.required ? `\n   lessons: ${placed.map((p) => p.title).join("; ")}` : "";
        return `${i}. ${t.title} — ${t.promise}\n   ${counts[i]} lessons — ${verdict}${listing}`;
      })
      .join("\n");

    const revisedRaw = await claudeJSONForPurpose({
      tier: "director",
      purpose: "skool-spine",
      system: REBALANCE_SYSTEM,
      messages: [{ role: "user", content: `Workable size is ${MIN_TRACK}–${MAX_TRACK} lessons.\n\n${withCounts}` }],
    });
    let revised: { title: string; promise: string }[] = [];
    try {
      revised = (JSON.parse(revisedRaw)?.tracks ?? []).filter((t: any) => t?.title);
    } catch {
      revised = [];
    }
    // A revision that comes back empty or broken leaves the original standing —
    // an unbalanced spine is still a spine, and a lost one is not.
    // Required tracks must survive a revision verbatim. If the model dropped or
    // renamed one, put it back rather than accept a spine the operator did not
    // ask for.
    if (revised.length === 0) break;
    {
      const revisedTitles = new Set(revised.map((t) => String(t.title).toLowerCase()));
      const restored = required
        .filter((t) => !revisedTitles.has(t.title.toLowerCase()))
        .map((t) => ({ title: t.title, promise: t.note, required: true }));
      tracks = [
        ...restored,
        ...revised.map((t) => ({
          ...t,
          required: requiredTitles.has(String(t.title).toLowerCase()),
        })),
      ];
      verdicts = await assignAll(items, tracks);
    }
  }

  // ---- assemble; anything without a verdict is surfaced, not swallowed ----
  const built: SpineTrack[] = tracks.map((t) => ({
    title: t.title,
    promise: t.promise,
    required: t.required === true,
    modules: [],
  }));
  const notPlaced: SpinePlan["notPlaced"] = [];
  const unassigned: SpineItem[] = [];

  for (const item of items) {
    const v = verdicts.get(item.index);
    if (!v) {
      unassigned.push(item);
      continue;
    }
    if (v.track == null) {
      notPlaced.push({ item, reason: v.reason || "No reason given." });
      continue;
    }
    built[v.track].modules.push({ title: v.title || item.title, item, reason: v.reason });
  }

  // ---- pass 4: author the chapters no lesson covers ----------------------
  let authoredCount = 0;
  if (opts.voiceSamples?.length) {
    for (const track of built) {
      if (!track.required) continue; // only the operator's own tracks get authored into
      if (authoredCount >= MAX_AUTHORED_TOTAL) break;
      authoredCount += await authorTrack(track, opts.voiceSamples, MAX_AUTHORED_TOTAL - authoredCount);
    }
  }

  const finalCounts = built.map((t) => t.modules.length);
  const stillOversized = built
    .filter((t, i) => !t.required && (finalCounts[i] > MAX_TRACK || (finalCounts[i] > 0 && finalCounts[i] < MIN_TRACK)))
    .map((t) => `${t.title} (${t.modules.length})`);

  return {
    tracks: built,
    notPlaced,
    unassigned,
    emptyModulesDropped,
    rebalanceRounds,
    stillOversized,
    authoredCount,
    createdAt: Date.now(),
  };
}

/**
 * Lay out one required track's chapters and write the ones nothing covers.
 *
 * Only REQUIRED tracks are authored into. A track the model designed was
 * designed around content that exists; a track the operator asked for was not,
 * and that gap is the whole reason this pass exists — "one chapter per
 * platform" cannot be satisfied by moving videos around when there is no video
 * for four of the platforms.
 *
 * Returns how many chapters it wrote.
 */
async function authorTrack(track: SpineTrack, voiceSamples: string[], budget: number): Promise<number> {
  const existing = track.modules;
  const listing = existing.map((m, i) => `${i}. ${m.title}`).join("\n") || "(none yet)";

  let chapters: { title: string; covers: number | null }[] = [];
  try {
    const raw = await claudeJSONForPurpose({
      tier: "director",
      purpose: "skool-chapters",
      system: CHAPTERS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Course: ${track.title}\nWhat it should be: ${track.promise}\n\nLessons already assigned to it:\n${listing}`,
        },
      ],
    });
    chapters = (JSON.parse(raw)?.chapters ?? [])
      .filter((c: any) => c?.title)
      .map((c: any) => ({ title: String(c.title).trim(), covers: c.covers == null ? null : Number(c.covers) }));
  } catch {
    chapters = [];
  }
  // A chapter layout that came back broken leaves the track exactly as it was.
  if (chapters.length === 0) return 0;

  // Re-order the track to the chapter layout, keeping every existing lesson.
  // An existing lesson the layout failed to reference is APPENDED, never
  // dropped — losing a real lesson to a chapter plan would be the worst
  // outcome of a pass whose whole purpose is filling gaps.
  const used = new Set<number>();
  const rebuilt: SpineModule[] = [];
  let written = 0;

  for (const chapter of chapters) {
    const covers = chapter.covers;
    if (covers != null && existing[covers] && !used.has(covers)) {
      used.add(covers);
      rebuilt.push({ ...existing[covers], title: existing[covers].title });
      continue;
    }
    if (covers != null) continue; // a reference to a lesson already used, or a bad index
    if (written >= MAX_AUTHORED_PER_TRACK || rebuilt.length + written >= budget + existing.length) continue;

    const body = await authorChapter(track, chapter.title, voiceSamples);
    if (!body) continue;
    written++;
    rebuilt.push({
      title: chapter.title,
      reason: "Written for this chapter — no existing lesson covered it.",
      item: {
        index: -1,
        kind: "written",
        title: chapter.title,
        courseTitle: null,
        courseSlug: null,
        courseId: null,
        unitId: null,
        videoId: null,
        views: null,
        publishedAt: null,
        chars: body.length,
        excerpt: body.slice(0, EXCERPT_CHARS).replace(/\s+/g, " ").trim(),
        body,
      },
    });
  }

  for (const [i, m] of existing.entries()) if (!used.has(i)) rebuilt.push(m);
  track.modules = rebuilt;
  return written;
}

/** Write one lesson. Returns null rather than a stub if it cannot. */
async function authorChapter(track: SpineTrack, title: string, voiceSamples: string[]): Promise<string | null> {
  try {
    const raw = await claudeJSONForPurpose({
      tier: "director",
      purpose: "skool-author",
      system: AUTHOR_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            "The creator's own writing, for voice:",
            ...voiceSamples.map((v, i) => `--- sample ${i + 1} ---\n${v}`),
            `\nCourse: ${track.title}`,
            `What the course should deliver: ${track.promise}`,
            `\nWrite the chapter: ${title}`,
          ].join("\n"),
        },
      ],
    });
    const body = String(JSON.parse(raw)?.body ?? "").trim();
    return body.length > 200 ? body : null;
  } catch {
    return null;
  }
}
