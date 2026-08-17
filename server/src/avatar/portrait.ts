/**
 * The persona portrait — the single most important input in this tool.
 *
 * InfiniteTalk animates the face it is given; it does not improve it. Whether
 * the finished video reads as a real person is decided almost entirely by this
 * one still, and the failure modes are specific and repeatable:
 *
 *   • A smiling or open mouth in the source fights the lipsync — the model has
 *     to close a mouth that the portrait insists is open, and the result is the
 *     rubbery look people recognise instantly as AI.
 *   • A tight face crop leaves no shoulders to move, so the head floats.
 *   • Hard side lighting bakes shadows that cannot follow the head, so they
 *     slide across the face as it turns.
 *   • Anything stylised — a hint of illustration, over-smoothed skin, a beauty
 *     filter — is amplified by the video model, not hidden by it.
 *
 * So the portrait prompt is not "a photo of a person". It is a specification
 * built to be animated, and PORTRAIT_RULES below encodes it. The caller only
 * supplies who the presenter is; everything that makes the still animatable is
 * added here, consistently, every time.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { getSegmindApiKey } from "../settings/secrets.js";
import { publishForProvider, revoke } from "./publicAssets.js";
import { generateChatImage } from "../imagechat/imageChat.js";
import type { ChatAspect } from "../imagechat/imageChat.js";
import { buildEditPrompt, buildScenePrompt, describeCharacter, findFraming, findMedium, NEGATIVE_PROMPT } from "./look.js";
import type { CaptureMedium, CharacterSpec, Framing } from "./look.js";
import { buildRoomPortraitPrompt, findRoom, roomPlateFile, roomsDir } from "./rooms.js";
import { buildCharacterSheetPrompt, buildPlacementPrompt } from "./characterSheet.js";

/**
 * The non-negotiable half of the portrait prompt — the rules that hold for
 * every engine and every look.
 *
 * Lighting, background and framing deliberately are NOT here. They used to be,
 * with flat frontal light mandated because a lipsync model cannot move a baked
 * shadow. That constraint belongs to that engine, not to portraits in general:
 * a generative model redraws the light every frame, and flat light was the very
 * thing making these read as studio-fake. So lighting and set now come from the
 * CAPTURE MEDIUM, framing comes from the FRAMING, and only what is true
 * regardless survives here.
 */
export const PORTRAIT_RULES = [
  "Photorealistic photograph — not an illustration, not a render, not stylised.",
  "The subject looks directly into the lens.",
  "Expression: relaxed and neutral with the MOUTH CLOSED and lips together. Not smiling, not speaking, teeth not visible.",
  "Head is upright and still, facing the camera square-on. No tilt, no turn, no motion blur.",
  "No text, no logos, no other people in shot.",
  "Natural skin with real texture and pores — no beauty retouching, no smoothing, no plastic sheen.",
  "Sharp focus on the eyes. Clean, unobstructed view of the face: no sunglasses, no hands near the face, no hair across the mouth.",
].join(" ");

/**
 * The lens used when the caller names no medium.
 *
 * The lens USED to live in PORTRAIT_RULES as a fixed 85mm at f/4, which meant
 * every medium that named its own glass was immediately contradicted a sentence
 * later — "35mm at f/2.0 … shot with an 85mm lens at f/4" in one prompt. The
 * model splits the difference and the shot loses whatever character the medium
 * was reaching for. It lives here now so the medium always wins, and this only
 * applies on the free-text path where nothing else specifies one.
 */
export const FALLBACK_LENS =
  "Shot on a full-frame camera with an 85mm lens at f/4.";

/**
 * The motion hint handed to the avatar model at render time (not to the image
 * model). InfiniteTalk takes a prompt describing what the person is DOING; kept
 * beside the portrait rules because the two have to agree — a portrait framed
 * chest-up and a prompt asking for full-body gestures produce a fight.
 */
export const DEFAULT_SCENE_PROMPT = buildScenePrompt({ framing: findFraming(undefined) });

/** Aspect ratios worth offering — landscape for YouTube, vertical for Shorts. */
export const PORTRAIT_ASPECTS: ChatAspect[] = ["16:9", "9:16", "1:1"];

export function coercePortraitAspect(x: unknown): ChatAspect {
  return (PORTRAIT_ASPECTS as string[]).includes(x as string) ? (x as ChatAspect) : "9:16";
}

/**
 * Compose the full image prompt from the caller's description of the presenter.
 * Exported and pure so the exact prompt can be asserted in a unit test — this is
 * the string that decides output quality, and it should not be able to drift
 * silently.
 *
 * `medium` names how the footage was captured. It is optional only for
 * backwards compatibility: leaving it out is the single biggest realism
 * regression available in this codebase, because an image model with no stated
 * medium blends every style it knows into the half-CGI look. Callers that have
 * a look should always pass one.
 */
export function buildPortraitPrompt(description: string, medium?: CaptureMedium, framing?: Framing): string {
  const who = (description ?? "").trim();
  if (!who) throw new Error("Describe the presenter — age, look, clothing, and setting.");
  // Framing is separate from the rest of the rules because it is the one line
  // that has to change with the engine: a generative model wants room for
  // hands, a lipsync model cannot animate arms that are not in the still.
  const shot = (framing ?? findFraming(undefined)).spec;
  // The medium owns the glass; FALLBACK_LENS covers only the case where there
  // is no medium to own it (see the note on FALLBACK_LENS).
  const lens = medium ? undefined : FALLBACK_LENS;
  return [who + ".", medium?.spec, lens, shot, PORTRAIT_RULES, NEGATIVE_PROMPT].filter(Boolean).join(" ");
}

/**
 * The whole prompt for a persona built from a structured look: who they are,
 * how they were shot, what makes the still animatable, and what to avoid. This
 * is the path the UI uses; `buildPortraitPrompt` on a free-text description is
 * the escape hatch for an operator who would rather write it themselves.
 */
export function buildLookPortraitPrompt(character: CharacterSpec, medium: CaptureMedium, framing?: Framing): string {
  return buildPortraitPrompt(describeCharacter(character), medium, framing);
}

/**
 * Turn a persona's portrait into a twenty-view character sheet.
 *
 * Nano Banana rather than GPT Image 2 for the same reason the plates use it:
 * the source rides inline, so nothing has to be published to a capability URL
 * first. Written beside the portrait it came from, as a persona-level asset.
 */
export async function generateCharacterSheet(opts: {
  sourceFile: string;
  model?: "flash" | "pro" | "flash-31";
}): Promise<GeneratedPortrait> {
  if (!fs.existsSync(opts.sourceFile)) {
    throw new Error("That portrait is no longer on disk — generate the persona again.");
  }
  const prompt = buildCharacterSheetPrompt();
  const image = await generateChatImage({
    instruction: prompt,
    images: [{ mimeType: "image/png", data: fs.readFileSync(opts.sourceFile) }],
    model: opts.model ?? "pro",
    // 16:9 fits a 5-across grid; a tall frame squashes the cells.
    aspect: "16:9",
  });

  fs.mkdirSync(config.avatarDir, { recursive: true });
  const ext = image.mimeType.includes("jpeg") ? "jpg" : "png";
  const file = path.join(config.avatarDir, `sheet-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  fs.writeFileSync(file, Buffer.from(image.base64, "base64"));
  return { file, mime: image.mimeType, prompt };
}

/**
 * Put an EXISTING persona into a room — the same face, a different set.
 *
 * The identity comes from the character sheet when the persona has one and from
 * the plain portrait when it does not. Both work; the sheet works better,
 * because a single portrait leaves the model guessing at every angle it cannot
 * see and guessing is where a face drifts. That is the whole reason sheets
 * exist, so the caller is told which one was used rather than left wondering.
 */
export async function placeInRoom(opts: {
  /** Character sheet, when the persona has one. */
  sheetFile?: string | null;
  /** The persona's locked portrait — the fallback identity, and always present. */
  portraitFile: string;
  roomId: string;
  model?: "flash" | "pro" | "flash-31";
}): Promise<GeneratedPortrait & { usedSheet: boolean }> {
  const room = findRoom(opts.roomId);
  if (!room) throw new Error("Pick a room to put them in.");
  const plate = roomPlateFile(opts.roomId);
  if (!plate) {
    throw new Error(`The "${room.label}" room plate is not on disk — regenerate it before using this room.`);
  }

  const identity = opts.sheetFile && fs.existsSync(opts.sheetFile) ? opts.sheetFile : opts.portraitFile;
  if (!fs.existsSync(identity)) {
    throw new Error("That persona's portrait is no longer on disk.");
  }
  const usedSheet = identity === opts.sheetFile;

  const prompt = buildPlacementPrompt(room.placement);
  const image = await generateChatImage({
    instruction: prompt,
    // ORDER IS THE CONTRACT — the prompt says "the first image" is the person
    // and "the second" is the room. Swapping these swaps their meanings.
    images: [
      { mimeType: "image/png", data: fs.readFileSync(identity) },
      { mimeType: "image/png", data: fs.readFileSync(plate) },
    ],
    model: opts.model ?? "pro",
    // The plate decides the frame; forcing an aspect would re-crop the room.
    aspect: "auto",
  });

  fs.mkdirSync(config.avatarDir, { recursive: true });
  const ext = image.mimeType.includes("jpeg") ? "jpg" : "png";
  const file = path.join(config.avatarDir, `persona-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  fs.writeFileSync(file, Buffer.from(image.base64, "base64"));
  return { file, mime: image.mimeType, prompt, usedSheet };
}

// ── GPT Image 2, via Segmind ─────────────────────────────────────────────────

const SEGMIND_BASE = process.env.SEGMIND_BASE_URL || "https://api.segmind.com";
const SEGMIND_IMAGE_MODEL = process.env.SEGMIND_IMAGE_MODEL || "gpt-image-2";

/**
 * GPT Image 2 only takes fixed sizes, so the persona's aspect maps onto the
 * nearest one. 1024x1536 is 2:3 rather than 9:16 — close enough, because the
 * video engine is asked for `adaptive` and follows the portrait it is given
 * rather than the other way round.
 */
const SEGMIND_SIZES: Record<string, string> = {
  "9:16": "1024x1536",
  "16:9": "1536x1024",
  "1:1": "1024x1024",
};

/**
 * Generate the portrait with GPT Image 2 rather than Nano Banana.
 *
 * Two reasons it is the default. It is reported to be the strongest model
 * available for photorealistic *people* specifically, which is the only thing
 * this prompt ever asks for. And it puts the portrait on the same key as the
 * video and the voice — one account, one bill, one thing to rotate.
 *
 * Cost is token-billed ($8/M in, $30/M out): roughly $0.15–0.22 for a
 * high-quality portrait, $0.01–0.02 at low quality. `quality` is exposed for
 * exactly that reason — roll cheap while you are hunting a face, then spend
 * twenty cents on the one you keep, since it is reused by every video forever.
 */
/**
 * Segmind wraps the upstream provider's error as a JSON *string* inside its own
 * JSON, so the useful sentence arrives buried under two layers of escaping and
 * a wall of `\n`. Dig the message out; fall back to the raw body, because a
 * shape we did not anticipate is exactly when the raw text matters most.
 */
function unwrapUpstreamError(body: string): string {
  try {
    let node: any = JSON.parse(body);
    for (let depth = 0; depth < 4; depth++) {
      if (typeof node === "string") {
        node = JSON.parse(node);
        continue;
      }
      const message = node?.error?.message ?? node?.message;
      if (typeof message === "string") return message;
      if (node?.error !== undefined) {
        node = node.error;
        continue;
      }
      break;
    }
  } catch {
    /* not JSON, or not the shape we guessed — the raw body is the fallback */
  }
  return body.slice(0, 300);
}

async function segmindPortrait(opts: {
  prompt: string;
  aspect: ChatAspect;
  quality: "low" | "medium" | "high";
  /**
   * PUBLICLY FETCHABLE url of the source image — present only when EDITING.
   *
   * It must be a real http(s) URL, not a data URL: Segmind fetches this field
   * server-side with Python `requests`, which answers a data URL with
   * "No connection adapters were found". See publicAssets.ts.
   */
  imageUrl?: string;
}): Promise<{ base64: string; mimeType: string }> {
  const key = getSegmindApiKey();
  if (!key) throw new Error("Segmind API key not configured — add SEGMIND_API_KEY in Settings → Avatar Narrator.");

  const res = await fetch(`${SEGMIND_BASE}/v1/${SEGMIND_IMAGE_MODEL}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: opts.prompt,
      // Present only on an edit. GPT Image 2 does text-to-image and guided
      // editing through the same endpoint; the source image is what switches it.
      ...(opts.imageUrl ? { image: opts.imageUrl } : {}),
      size: SEGMIND_SIZES[opts.aspect] ?? "1024x1536",
      quality: opts.quality,
      // PNG, losslessly. The portrait is the persona's permanent asset and the
      // video model amplifies whatever is in it, so compression artefacts are
      // not a size/quality trade here — they are a defect that shows up in
      // every video forever.
      //
      // `output_compression` is NOT optional despite reading like it: a default
      // below 100 is applied server-side, and PNG rejects anything less with
      // `invalid_png_output_compression`. Sending 100 explicitly is what makes
      // the PNG path legal.
      output_format: "png",
      output_compression: 100,
      // The prompt describes a real person in an ordinary room; the default
      // moderation tier occasionally refuses photoreal faces outright.
      moderation: "low",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GPT Image 2 failed: HTTP ${res.status} ${unwrapUpstreamError(body)}`);
  }

  // Segmind's /v1 endpoints answer with the raw media; a JSON body means it
  // handed back a URL instead, so follow it rather than writing JSON to a .png.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json: any = await res.json().catch(() => ({}));
    const url = json?.image ?? json?.url ?? json?.output?.[0] ?? json?.data?.[0]?.url;
    const inlineB64 = json?.b64_json ?? json?.data?.[0]?.b64_json;
    if (inlineB64) return { base64: String(inlineB64), mimeType: "image/png" };
    if (!url) throw new Error(`GPT Image 2 returned no image: ${JSON.stringify(json).slice(0, 300)}`);
    const img = await fetch(String(url));
    if (!img.ok) throw new Error(`Fetching the generated portrait failed: HTTP ${img.status}`);
    return { base64: Buffer.from(await img.arrayBuffer()).toString("base64"), mimeType: "image/png" };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("GPT Image 2 returned an empty image.");
  return { base64: buf.toString("base64"), mimeType: contentType || "image/png" };
}

/**
 * Refine a portrait that already exists, rather than rolling a new face.
 *
 * Editing is worth having for a reason the cost model makes obvious: a roll is
 * ~90 seconds and ~$0.20, and "almost right" is the usual outcome. But the
 * expensive failure is silent — an edit that returns a different person looks
 * fine in isolation and only shows up later as a persona whose face drifted.
 * `buildEditPrompt` is where that is defended; this function is just transport.
 *
 * The result is saved as a NEW roll rather than overwriting the source, so the
 * original survives in the gallery and a bad edit costs nothing but the call.
 */
export async function editPortrait(opts: {
  /** Absolute path of the portrait being improved. */
  sourceFile: string;
  /** What the operator wants changed, in their own words. */
  instruction: string;
  aspect?: ChatAspect;
  mediumId?: string;
  quality?: "low" | "medium" | "high";
}): Promise<GeneratedPortrait> {
  if (!fs.existsSync(opts.sourceFile)) {
    throw new Error("That portrait is no longer on disk — pick another roll.");
  }
  const prompt = buildEditPrompt(opts.instruction, findMedium(opts.mediumId));

  // Segmind fetches `image` server-side, so the source has to be reachable
  // without our session — the same reason the render pipeline publishes the
  // portrait and the narration. Unguessable path, revoked as soon as the call
  // returns rather than left to the 24h sweep.
  const published = publishForProvider(opts.sourceFile, `source${path.extname(opts.sourceFile) || ".png"}`);
  let image: { base64: string; mimeType: string };
  try {
    image = await segmindPortrait({
      prompt,
      aspect: coercePortraitAspect(opts.aspect),
      quality: opts.quality ?? "high",
      imageUrl: published.url,
    });
  } finally {
    revoke(published.token);
  }

  fs.mkdirSync(config.avatarDir, { recursive: true });
  const ext = image.mimeType.includes("jpeg") ? "jpg" : "png";
  const file = path.join(config.avatarDir, `persona-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  fs.writeFileSync(file, Buffer.from(image.base64, "base64"));
  return { file, mime: image.mimeType, prompt };
}

export interface GeneratedPortrait {
  /** Absolute path of the saved portrait. */
  file: string;
  mime: string;
  /** The exact prompt used, stored on the persona so a re-roll is reproducible. */
  prompt: string;
}

/**
 * Generate a persona portrait and save it under `config.avatarDir`.
 *
 * Defaults to Nano Banana Pro: this still gets reused across every video the
 * persona ever appears in, so it is the one image in the whole pipeline where
 * paying for the sharper model is obviously right.
 */
export async function generatePortrait(opts: {
  description: string;
  aspect?: ChatAspect;
  model?: "flash" | "pro" | "flash-31";
  /** Capture medium id (see look.ts). Defaults to the daylight interior. */
  mediumId?: string;
  /** Framing id (see look.ts). Defaults to the medium shot with hands. */
  framingId?: string;
  /** Which image model. Defaults to GPT Image 2 on the same key as the rest. */
  engine?: "gptimage2" | "nanobanana";
  /** GPT Image 2 only: roll cheap, then spend on the one you keep. */
  quality?: "low" | "medium" | "high";
  /**
   * Room plate to seat the presenter in (see rooms.ts). When it resolves to a
   * file on disk this takes over completely: the plate IS the room, so the
   * medium and framing that would otherwise describe one are not used, and the
   * engine is forced to Nano Banana because the plate rides inline.
   */
  roomId?: string;
}): Promise<GeneratedPortrait> {
  const aspect = coercePortraitAspect(opts.aspect);
  const room = findRoom(opts.roomId);
  const plateFile = roomPlateFile(opts.roomId);

  // A named room whose plate is missing must not silently produce a different
  // room — that is exactly the continuity break the plates exist to prevent.
  if (room && !plateFile) {
    throw new Error(
      `The "${room.label}" room plate is not on disk (${path.join(roomsDir(), room.file)}) — regenerate it before using this room.`,
    );
  }

  const prompt = plateFile
    ? buildRoomPortraitPrompt(opts.description, room!)
    : buildPortraitPrompt(opts.description, findMedium(opts.mediumId), findFraming(opts.framingId));

  const image = plateFile
    ? await generateChatImage({
        instruction: prompt,
        // The plate is the only reference; the person is described in words.
        images: [{ mimeType: "image/png", data: fs.readFileSync(plateFile) }],
        model: opts.model ?? "pro",
        // "auto" keeps the plate's own aspect. Forcing one would re-crop the
        // room, and a re-cropped room is a different room.
        aspect: "auto",
      })
    : opts.engine === "nanobanana"
      ? await generateChatImage({ instruction: prompt, model: opts.model ?? "pro", aspect })
      : await segmindPortrait({ prompt, aspect, quality: opts.quality ?? "high" });

  fs.mkdirSync(config.avatarDir, { recursive: true });
  const ext = image.mimeType.includes("jpeg") ? "jpg" : "png";
  const file = path.join(config.avatarDir, `persona-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  fs.writeFileSync(file, Buffer.from(image.base64, "base64"));

  return { file, mime: image.mimeType, prompt };
}
