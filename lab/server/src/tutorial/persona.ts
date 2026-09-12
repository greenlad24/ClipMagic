/**
 * Tutorial Studio — a sentence in, a real-looking person out.
 *
 * The Avatars tab used to be upload-only: you made the start image somewhere
 * else and brought it here. This is the other half — describe who you want (or
 * hand over a photo of the KIND of person you want) and get a portrait back.
 *
 * Four stages, because each one fixes a different failure:
 *
 *   1. READ    a reference photo into a written spec (vision). Features, never
 *              identity — see FICTION_RULE.
 *   2. WRITE   a vague sentence into that same spec (text). "A 30-something
 *              British designer" is not a face; the spec is. This is where
 *              realism is actually won: an image model given adjectives invents
 *              an averaged, retouched, magazine face, and an averaged face is
 *              the single most recognisable AI tell there is.
 *   3. DRAW    the person from the spec, with the reference attached as a WEAK
 *              second input (type only, face explicitly not copied).
 *   4. REFINE  the drawn image back through the model with an identity-locked,
 *              texture-only instruction.
 *
 * Nothing is written to disk here. Images travel as base64 and are only
 * persisted when the operator saves one, at which point it goes to the sidecar
 * through the ordinary avatar-create path. That keeps a discarded roll from
 * leaving anything behind, and keeps this module pure enough to test.
 *
 * The prompt builders are exported and pure ON PURPOSE: they are the strings
 * that decide whether the output looks like a person or like an AI's idea of
 * one, and they should not be able to drift without a test noticing.
 */
import { NEGATIVE_PROMPT } from "../avatar/look.js";
import { claudeChatJSON, claudeVisionLabeledJSON, anthropicConfigured } from "../ai/claude.js";
import { generateChatImage, type ChatImageModel, type ChatAspect } from "../imagechat/imageChat.js";
import { getApimartApiKey } from "../settings/postizSecrets.js";

// ── what a person is, written down ──────────────────────────────────────────

/**
 * A face specific enough to draw twice.
 *
 * Every field is REQUIRED and every field is a sentence, not a label. The spec
 * exists to stop the image model averaging: "brown hair" is an average, "dark
 * brown, cut blunt at the collarbone, parted slightly off-centre, with the
 * left side tucked behind the ear" is a person.
 */
export interface PersonaSpec {
  /** An exact age, not a range — ranges average into blandness. */
  age: string;
  /** "woman" | "man" | "person" — however the operator put it. */
  presenting: string;
  /** Heritage / colouring, if it matters. Free text. */
  heritage: string;
  /** Height and build, in ordinary words. */
  build: string;
  /**
   * Posture and energy — what kind of moment this photo is.
   *
   * It exists because the model kept writing one anyway, into whichever field
   * was nearest, and because it is a real realism lever: a portrait with no
   * stated demeanour defaults to the photogenic stock-photo read.
   */
  demeanour: string;
  /** Bone structure: face shape, jaw, cheekbones, nose, brow, chin. */
  face: string;
  /** Eyes, lids, lashes and eyebrows — including how they differ side to side. */
  eyes: string;
  /** Cut, colour, parting, and how it actually sits today. */
  hair: string;
  /** REQUIRED, and the field realism lives or dies on. Pores, tone, marks. */
  skin: string;
  /** Clothes with material and weight named, not just colour. */
  wardrobe: string;
  /**
   * Two or three ordinary flaws. Named individually because a model asked for
   * "imperfections" in the abstract renders none, and a face with none is the
   * tell everyone can see but nobody can name.
   */
  imperfections: string;
}

export const SPEC_FIELDS: Array<keyof PersonaSpec> = [
  "age",
  "presenting",
  "heritage",
  "build",
  "demeanour",
  "face",
  "eyes",
  "hair",
  "skin",
  "wardrobe",
  "imperfections",
];

/** Coerce anything model-shaped into a full spec, so a missing field is "". */
export function coerceSpec(x: unknown): PersonaSpec {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const out = {} as PersonaSpec;
  for (const f of SPEC_FIELDS) out[f] = String(o[f] ?? "").trim().slice(0, 600);
  return out;
}

export function specIsUsable(spec: PersonaSpec): boolean {
  // Skin and face are the two that carry the likeness; a spec without them is
  // an adjective pile and will render as one.
  return Boolean(spec.face && spec.skin && spec.presenting);
}

/**
 * Accept a data: URL or bare base64, and tell the truth about what it is.
 *
 * The declared type is not trusted: Claude vision rejects a mislabelled
 * media_type outright, and the browser's file picker is happy to hand over a
 * PNG named .jpg. Sniffed by magic number, the same way the sidecar guards its
 * avatar uploads.
 */
export function readImageInput(raw: string): RefImage {
  const text = (raw || "").trim();
  if (!text) throw new Error("An image is required.");
  const b64 = text.startsWith("data:") && text.includes(",")
    ? text.slice(text.indexOf(",") + 1)
    : text;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    throw new Error("That image could not be decoded.");
  }
  const mime = sniffImage(buf);
  if (!mime) throw new Error("That file is not a PNG, JPEG, WEBP or GIF image.");
  return { base64: buf.toString("base64"), mimeType: mime };
}

/** The four types Anthropic's vision API accepts, by magic number. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (buf.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  return null;
}

// ── the rules ───────────────────────────────────────────────────────────────

/**
 * The one non-negotiable: an original human being who exists nowhere.
 *
 * It is stated in every prompt — the spec, the draw and the refine — because
 * this is also what makes the reference-photo path safe. The reference sets the
 * TYPE (age band, colouring, build, hair, styling); it must never set the face.
 */
export const FICTION_RULE =
  "This person is ORIGINAL and FICTIONAL. They must not resemble any real, living, " +
  "identifiable or public figure. Where a reference photograph is supplied it is a " +
  "TYPE reference only — the same age band, colouring, build, hair and way of dressing — " +
  "and the face must be a clearly DIFFERENT individual: different bone structure, " +
  "different nose, different mouth, different eye spacing, so that the two people could " +
  "never be mistaken for one another.";

/**
 * What makes an image read as a photograph of a person rather than a rendering
 * of one. Every line here was earned somewhere in this codebase or costs a roll
 * to relearn; the comments say which.
 */
export const REALISM_RULES = [
  // An image model with no stated medium blends every style it knows, and the
  // blend is the half-CGI look. Naming the gear is also self-consistent: real
  // optics constrain what the rest of the image is allowed to do.
  "A photorealistic photograph of a real human being — not an illustration, not a 3D render, not a stylised or AI-art portrait.",

  // Ordinariness is the biggest single lever and nobody asks for it, so the
  // model defaults to a face selected for beauty, which is a face nobody has.
  "An ORDINARY-looking person — the kind you would walk past in the street. Not a model, not conventionally perfect, not styled for a magazine. Believable before beautiful.",

  // Symmetry is the tell most people feel and cannot name.
  "A real face is ASYMMETRIC: the two eyes sit and open slightly differently, the eyebrows do not match, the nose is not perfectly centred, one side of the mouth is a little higher. Keep that asymmetry clearly visible.",

  // Skin is where realism lives (the Avatar Narrator spec makes this field
  // required for the same reason).
  "Real skin under real light: visible pores across the nose and cheeks, fine vellus hair catching the light along the jaw and hairline, uneven tone, a low natural sheen on the forehead and the bridge of the nose. No retouching of any kind.",

  // Eyes go dead when they are drawn as a flat colour with a pasted highlight.
  // The second half is the anti-glare clause every character-sheet guide
  // insists on: left alone, models put an oversized specular blob in the iris
  // and make the colour glow, which reads as a render more than skin does.
  "Living eyes: visible iris texture rather than a flat colour, real moisture, a catchlight that matches the actual light source in the room, and faint redness at the inner corner. Naturally muted catchlights, no oversized specular glare in the iris, eye colour muted rather than glowing.",

  // Adults come back as babyfaces unless this is said. The correction is
  // structural, not cosmetic, so it names bone structure and proportions.
  "If they are an adult, give them adult bone structure: a defined rather than soft-round jaw and cheekbones, longer facial thirds, mature proportions. No babyface, no overly youthful rounded features.",

  // "Matte" has to be asked for. Left alone the model adds a dewy beauty
  // highlight, which is the retouched look arriving by the back door.
  "A matte-to-natural complexion: no glossy or dewy retouched finish, no highlight blooms, no artificial glare on the skin.",

  // Light that does not belong to the room is the cut-out failure by another
  // route — the Avatar Narrator learned this placing people into room plates.
  "The light comes from a source that is visible or clearly implied in the frame, and it falls on the person exactly as it falls on the room: same direction, same colour, same softness. A real contact shadow where they meet what they are sitting on or standing against.",

  // Depth, foreground and separation are what make a subject inhabit a space.
  "The person is IN the space, not pasted onto it: something in the near foreground slightly breaks an edge of the frame, they sit clearly forward of whatever is behind them, and the background falls softly out of focus without dissolving into mush.",

  // The image is an IDENTITY REFERENCE that the reel pipeline re-renders from,
  // so the face has to be readable and neutral rather than performed.
  "Expression: relaxed and neutral, mouth closed, lips together, not smiling, teeth not visible. Head upright and square to the camera.",

  "One person only. No text, no captions, no logos, no watermark, no border.",
].join(" ");

/**
 * How much of her is in frame — stated BEFORE the camera, and emphatically.
 *
 * Both halves of this were bought with a real roll. Described only as "shot on
 * a phone's front camera, held at arm's length", the model produced a MIRROR
 * SELFIE: a wide, full-body seated shot with a phone visible in her raised
 * hand. Both are fatal here — this image is the identity reference the reel
 * pipeline re-renders from, and it re-renders whatever it is given, including
 * a phone where the microphone is supposed to go. So the framing is pinned
 * ahead of the capture spec, and the hands are explicitly emptied and removed.
 */
export const FRAMING_RULE = [
  "Framing: vertical 9:16, a MEDIUM-TIGHT PORTRAIT — cropped just below the collarbone, her head in",
  "the upper portion of the frame with a little headroom, the head filling at least a third of the",
  "frame height, looking straight down the lens. NOT a wide shot, NOT full body, NOT a seated wide",
  "angle, and NOT a mirror selfie.",
  "Her hands are relaxed and OUT OF SHOT: she is holding nothing — no phone, no camera, no",
  "microphone, no cup — and no hand, arm or held object appears anywhere in the picture. No phone,",
  "camera, mirror or reflection is visible in the frame at all.",
].join(" ");

/**
 * How it was shot. Two registers, because the right answer depends on what the
 * avatar is FOR: the reel's own start frames are phone-camera UGC, so a phone
 * reference matches what the pipeline will re-render — while a cleaner camera
 * portrait gives the start-frame model more face to hold on to.
 */
export interface CaptureLook {
  id: string;
  label: string;
  hint: string;
  spec: string;
}

export const CAPTURE_LOOKS: CaptureLook[] = [
  {
    id: "phone-selfie",
    label: "Phone on a stand",
    hint: "Matches the reels — front-facing UGC realism",
    spec:
      "Shot on a modern phone's front camera with the phone PROPPED ON A SMALL STAND at eye level a " +
      "short distance in front of her — nobody is holding it, and the phone itself is not in the " +
      "picture. A 26mm-equivalent lens at f/1.8, the mild wide-angle rendering of a front camera, " +
      "enough depth of field to keep the room readable behind her, phone-camera colour science, a " +
      "faint luminance grain in the shadows and the very slight softness of a front camera rather " +
      "than clinical sharpness.",
  },
  {
    id: "camera-portrait",
    label: "Camera on a table",
    hint: "Cleaner reference — more face for the pipeline to hold",
    spec:
      "Shot on a full-frame mirrorless camera resting on the desk at chest height: a 35mm lens at " +
      "f/2.8, natural daylight from one window just off-camera as the only light, the unlit side of " +
      "the face allowed to fall away into the room, a muted low-contrast grade with warmth kept only " +
      "in the skin, and fine natural sensor grain.",
  },
];

export function findCapture(id: string | undefined): CaptureLook {
  return CAPTURE_LOOKS.find((c) => c.id === id) || CAPTURE_LOOKS[0];
}

// ── composing the person ────────────────────────────────────────────────────

/**
 * The spec as a paragraph.
 *
 * `-year-old` is appended to the AGE and is not a separator — joining the three
 * identity fields with it is what produced "36-year-old Black British-year-old
 * man" in the Avatar Narrator, in every prompt that set a heritage.
 */
export function describePersona(spec: PersonaSpec): string {
  // Every field is written by a model, so any of them may or may not already
  // end in a full stop. Strip it and add exactly one, or a field that arrives
  // punctuated composes as "…dark colouring.. Medium height…".
  const sentence = (s: string) => s.trim().replace(/[.\s]+$/, "");
  // Heritage is its OWN sentence rather than a word wedged before the noun:
  // the writer returns phrases like "English and Welsh, warm olive-toned
  // complexion", which in the noun slot reads "A 34-year-old English and Welsh,
  // warm olive-toned complexion woman."
  const who = [`${spec.age}-year-old`.replace(/^-year-old$/, ""), spec.presenting]
    .map((x) => sentence(x || ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  return [
    who ? `A ${who}` : "",
    spec.heritage,
    spec.build,
    spec.demeanour,
    spec.face,
    spec.eyes,
    spec.hair,
    spec.skin ? `Skin: ${sentence(spec.skin)}` : "",
    spec.wardrobe ? `Wearing ${sentence(spec.wardrobe)}` : "",
    spec.imperfections
      ? `Ordinary imperfections, all of them visible: ${sentence(spec.imperfections)}`
      : "",
  ]
    .map((x) => sentence(x || ""))
    .filter(Boolean)
    .map((x) => `${x}.`)
    .join(" ");
}

/**
 * The full text-to-image prompt for a new avatar.
 *
 * Order matters and is deliberate: WHO first (the model commits to a person),
 * then WHERE, then HOW IT WAS SHOT, then the realism rules, then the fiction
 * rule, then the negatives. The room comes before the capture spec so the
 * capture spec's light has a room to be in.
 */
export function buildPersonaPrompt(opts: {
  spec: PersonaSpec;
  /** The one place this avatar's videos are shot in. */
  environment?: string;
  captureId?: string;
}): string {
  const person = describePersona(opts.spec);
  if (!person) throw new Error("Describe the person first — the spec is empty.");
  const room = (opts.environment || "").trim();
  return [
    person,
    room
      ? `She is at home in ${room}, seated, with the room visible and softly out of focus behind her.`
      : "She is seated in an ordinary lived-in home interior, visible and softly out of focus behind her.",
    FRAMING_RULE,
    findCapture(opts.captureId).spec,
    REALISM_RULES,
    FICTION_RULE,
    NEGATIVE_PROMPT,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The same prompt, plus the citation that makes an attached reference behave.
 *
 * The Avatar Narrator learned this the expensive way placing people into room
 * plates: an image attached but not CITED is read as "another view of the
 * subject", and the model quietly copies it. So the reference has to be named,
 * given a job, and given an explicit list of what NOT to take from it.
 */
export function buildReferencedPersonaPrompt(opts: {
  spec: PersonaSpec;
  environment?: string;
  captureId?: string;
}): string {
  return [
    buildPersonaPrompt(opts),
    "The attached photograph is a TYPE REFERENCE and nothing more. Take from it only the general " +
      "impression: the age band, the colouring, the build, the hair family and the way this kind of " +
      "person dresses and carries themselves. Do NOT copy the face — not the bone structure, not the " +
      "nose, not the mouth, not the eye spacing — and do not copy its background, its framing or its " +
      "lighting. The written description above is authoritative wherever the two disagree. The result " +
      "must be a DIFFERENT person who could plausibly be the same age and background.",
    // The framing is restated LAST, on purpose. Told once at the top and then
    // handed a photograph, the model follows the photograph: a wide seated
    // reference came back as a wide seated portrait with hands in shot, even
    // with "do not copy its framing" already in the prompt. Recency wins, so
    // the last word on framing has to be ours.
    `However the attached photograph happens to be framed, THIS picture is framed as follows and nothing about the attachment changes it. ${FRAMING_RULE}`,
  ].join(" ");
}

/**
 * The refine pass: same person, better photograph.
 *
 * This is an EDIT, and edits have one dangerous failure — coming back as
 * somebody else, which looks fine in isolation and only shows up later as an
 * avatar whose face drifted between videos. So identity is locked first, in its
 * own sentence, before anything is asked for.
 */
export function buildRealismRefinePrompt(notes?: string): string {
  const extra = (notes || "").trim();
  return [
    "Rework the attached photograph of this person so that it reads as an unretouched real photograph.",
    "KEEP THE PERSON EXACTLY: the same face, the same bone structure, the same eyes, nose and mouth, " +
      "the same hair, the same age, the same clothes, the same pose, the same framing and the same " +
      "room. This is the same individual and must remain recognisably so — change nothing about WHO " +
      "this is, only HOW IT WAS PHOTOGRAPHED.",
    "Fix specifically what makes it read as generated: add real skin texture with visible pores and " +
      "fine vellus hair, restore uneven skin tone and any small natural marks, break up the symmetry " +
      "of the face so the two sides differ, put real moisture and iris texture into the eyes, make the " +
      "light on the face agree with the light in the room and land a real contact shadow, and let the " +
      "image carry ordinary camera grain instead of a clean digital surface.",
    extra ? `Also: ${extra}.` : "",
    NEGATIVE_PROMPT,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * THE AVATAR MAP — one identity asset, three panels.
 *
 * WHY IT EXISTS. An avatar is one photograph, and a photograph shows a body
 * from exactly one angle. Every later step — the reel's start frame, a new
 * room, a different outfit — has to invent the angles it cannot see, and
 * inventing is where the person quietly becomes someone else. Hand the model
 * the map instead and "imagine her from behind" becomes "copy the panel you
 * were shown", which is a far easier instruction to obey.
 *
 * WHAT IS ON IT, exactly as asked: a head-and-shoulders close-up, a standing
 * front full body, and the body from behind with the head out of frame.
 *
 * THREE THINGS HERE ARE LOAD-BEARING, all of them from how these sheets fail:
 *
 *  • The composition clause comes FIRST. Image models weight early tokens
 *    hardest, so the sheet type and the panel layout have to be the opening
 *    words, not a note at the end.
 *  • The framing of each panel is repeated verbatim in the negatives. "Standing
 *    full body, not cropped, not sitting" and "the close-up is a tight crop,
 *    never a second full body" are the two rules that break most often.
 *  • The back panel is described as a photograph CROPPED at the neck — never as
 *    "a body without a head". The literal phrasing produces exactly the
 *    horrible thing it says, and is the kind of prompt a safety filter refuses.
 *
 * White seamless and flat even light are not decoration: the map carries the
 * PERSON and nothing else. A map shot in a room would drag that room's light
 * into every scene built from it afterwards.
 */
export const MAP_PANELS = [
  "PANEL 1, on the left — a tight head-and-shoulders close-up, facing the camera square-on, cropped " +
    "just below the shoulders. This panel is a CLOSE-UP and never a second full-body view.",
  "PANEL 2, in the middle — the same person standing upright and facing the camera, in a relaxed " +
    "neutral stance with both feet flat on the ground and arms hanging relaxed at their sides. Framed " +
    "head to toe with the whole body and BOTH FEET inside the panel. Standing, not sitting, not " +
    "crouching, not leaning, and not cropped at the legs.",
  // Described on its own terms. Anchored to panel 2 ("the same view with the top
  // cut off") it came back with the head twice: "standing back view" is a
  // strong prior and the comparison kept pulling it back to a whole figure.
  "PANEL 3, on the right — a BACK VIEW OF THE BODY ONLY, from directly behind. This panel is framed " +
    "from the TOP OF HER SHOULDERS down to her feet. HER HEAD IS NOT IN THIS PANEL: the picture " +
    "begins below her neck, and no part of her head — no face, no skull, no ears — appears anywhere " +
    "in it. It is an ordinary photograph of a person's back framed below the neck, the way a clothing " +
    "reference is shot; nothing is severed or injured, the head is simply outside the crop.",
] as const;

export function buildAvatarMapPrompt(): string {
  return [
    // Composition first — this is the clause the model reads hardest.
    "A character reference sheet (an avatar map) of the person in the attached photograph: three " +
      "separate panels side by side in one wide image, evenly spaced, each panel fully inside its own " +
      "space and not overlapping its neighbours. The two full-length panels are drawn at the same " +
      "scale as each other.",

    ...MAP_PANELS,

    "THE SAME PERSON IN EVERY PANEL. All three are the identical individual from the attached " +
      "photograph — the same bone structure, face shape and jawline, the same eye shape and colour, " +
      "the same nose and mouth, the same hairline, hair colour, length and cut, the same skin tone and " +
      "texture, the same age, the same build and proportions, and the same distinguishing marks, moles " +
      "and scars in the same places. They wear the SAME clothes and the same shoes in every panel. " +
      "This is one person photographed three times, never three similar-looking people.",

    "In every panel the expression is relaxed and neutral with the MOUTH CLOSED and lips together — " +
      "not smiling, not speaking, teeth not visible. A sheet full of open mouths teaches every later " +
      "step to draw one.",

    "Plain pure white seamless studio background behind all three panels, with the same flat, soft, " +
      "even light on each so nothing about the lighting changes from panel to panel. No room, no " +
      "furniture, no props, no shadows cast on a floor.",

    "Photorealistic photography of a real person — not an illustration, not a render, not stylised. " +
      "Keep the real skin texture, pores, tone unevenness and natural asymmetry of the attached " +
      "photograph. Do not beautify, slim, de-age or otherwise idealise them, and do not change their " +
      "clothes.",

    "Exactly one person in the image. No other people, no duplicate figures, no mannequins, no " +
      "reflections, no text, no labels, no captions, no numbers, no arrows, no watermarks and no " +
      "borders drawn around the panels.",

    // Repeated on purpose: these are the two that break.
    "To repeat, because these are the rules that break most often: the middle panel is a STANDING " +
      "full-body view, head to toe, both feet visible, not cropped and not seated; the RIGHT PANEL " +
      "SHOWS NO HEAD AT ALL — it stops at the neck and her hair is not in it; and the left panel is a " +
      "tight close-up, not a third full body.",

    NEGATIVE_PROMPT,
  ].join(" ");
}

/**
 * THE SCENE — that exact person, in the room they will talk from.
 *
 * This is the second half of the same idea. The map fixes WHO; the scene fixes
 * WHERE, and the whole difficulty is keeping the two from contaminating each
 * other: the map's white seamless is the most visually dominant thing in the
 * reference, and a model that copies it has thrown the room away.
 *
 * So each image is NAMED and given a job. That division is the mechanism — face
 * from one, world from the other, nothing borrowed the wrong way — and it is
 * the same contract the Avatar Narrator uses to place a persona into a room
 * plate, which is the one part of that tool verified against real generations.
 *
 * `plate` says whether a photograph of the actual room is attached. With one,
 * the lighting is not described but INHERITED, which is the only way to get the
 * room's real light rather than a plausible imitation of it.
 */
export function buildScenePrompt(opts: {
  environment: string;
  captureId?: string;
  /** True when a photograph of the real room is attached as the second image. */
  plate?: boolean;
}): string {
  const room = (opts.environment || "").trim();
  return [
    opts.plate
      ? "You are given two photographs. THE FIRST is a character reference sheet showing one person " +
        "from several angles — it is the IDENTITY, and nothing else about it matters. THE SECOND is a " +
        "photograph of the room — it is the SET."
      : "You are given a character reference sheet showing one person from several angles. It is the " +
        "IDENTITY, and nothing else about it matters.",

    // NOT "about to speak": that pulls the mouth open, which the framing rule
    // then forbids, and a model handed both picks one. The still is a
    // reference, and an open mouth in a reference propagates into every frame
    // rendered from it.
    "Produce ONE photograph of that person, seated in the room, looking into the camera.",

    "FROM THE REFERENCE SHEET take only the person: their exact face and bone structure, eye shape and " +
      "colour, nose, mouth, jawline, hairline, hair, skin tone and texture, age, build and every " +
      "distinguishing mark, plus their clothing. Take NOTHING else from it — not its white background, " +
      "not its panels, not its flat studio lighting, none of which appear in the result.",

    opts.plate
      ? "FROM THE ROOM PHOTOGRAPH take everything else, unchanged: the same room from the same camera " +
        "position, height and angle, the same focal length, the same perspective and the same depth of " +
        "field. Every object stays where it is. Do not redecorate, tidy, add or remove anything, and do " +
        "not reveal more of the room than that photograph shows."
      : room
        ? `THE ROOM: ${room}. Show enough of it behind her to be recognisably that place, softly out of focus.`
        : "THE ROOM: an ordinary lived-in home interior, visible and softly out of focus behind her.",

    // The lighting sentence is the point of the whole step.
    "THE ROOM'S OWN LIGHT FALLS ON HER, and it is the only light in the picture. Do not relight the " +
      "scene and do not add a lamp, softbox, rim light, edge light, kicker or backlight for her. The " +
      "light reaches her from the same direction it reaches everything else in the frame, with the same " +
      "colour and the same softness, leaving the side away from it in shadow. Her exposure matches the " +
      "room's, the room's colour cast sits on her skin and clothing, and the same grain and grade run " +
      "over her as over the rest of the picture.",

    "She must look PHOTOGRAPHED IN that room rather than pasted onto it: correct scale for the " +
      "furniture, properly seated in the space, contact shadows where she meets the chair, something in " +
      "the near foreground breaking an edge of the frame, and clear separation from the wall behind her.",

    FRAMING_RULE,
    findCapture(opts.captureId).spec,
    REALISM_RULES,
    NEGATIVE_PROMPT,
  ]
    .filter(Boolean)
    .join(" ");
}

// ── turning words (or a photo) into a spec ──────────────────────────────────

const SPEC_SHAPE =
  'Return STRICT JSON only: {"age":"...","presenting":"...","heritage":"...","build":"...",' +
  '"demeanour":"...","face":"...","eyes":"...","hair":"...","skin":"...","wardrobe":"...",' +
  '"imperfections":"..."}';

/**
 * The three identity fields are SHORT and the descriptive ones are long.
 *
 * Said only as "every field is a sentence", the writer put a paragraph about
 * posture into `presenting` and a clause about skin undertones into `heritage`
 * — which compose into the opening line and turned it into gibberish
 * ("A 34-year-old English with likely some South Asian ancestry, reflected in
 * warm olive-undertoned skin and dark colouring. A British woman sitting
 * slightly forward…"). The lengths are now stated per field.
 */
const SPEC_GUIDANCE = [
  "FIELD RULES, follow them exactly:",
  "• age — one number as a string, nothing else. Never a range: ranges average into blandness.",
  "• presenting — ONE OR TWO WORDS ONLY: 'woman', 'man', 'non-binary person'. No description here.",
  "• heritage — a SHORT phrase under ten words naming background and colouring. Not a sentence.",
  "• build — one sentence on height and frame.",
  "• demeanour — one sentence on posture and energy: what kind of moment this is. Never a",
  "  photogenic smile; a real person between thoughts.",
  "• face, eyes, hair, skin, wardrobe, imperfections — two or three sentences each of concrete",
  "  visual fact, never labels. 'Brown hair' is useless; 'dark brown, cut blunt at the collarbone,",
  "  parted slightly off-centre, tucked behind the left ear, with a few strands escaping at the",
  "  temple' is a person.",
  "skin must describe texture and tone unevenness, not colour alone — pores, shine, marks, redness.",
  "imperfections must name two or three specific ordinary flaws (a small scar, slightly dry lips, a",
  "crooked tooth that does not show, one eyelid heavier than the other, a mole, sun damage).",
  "Choose an ORDINARY-looking human being, not an attractive one: this is a real person, not a model.",
  FICTION_RULE,
  SPEC_SHAPE,
].join(" ");

const SENTENCE_SYSTEM =
  "You turn a one-line brief for an on-camera presenter into a complete, specific physical " +
  "description that an image model can draw twice and get the same person. " +
  "Fill in everything the brief leaves open with ordinary, believable choices that fit it. " +
  SPEC_GUIDANCE;

const VISION_SYSTEM =
  "You look at a reference photograph and write down the TYPE of person in it: age band, colouring, " +
  "build, face shape family, hair, and how they dress and carry themselves. " +
  "You are NOT identifying anyone and you must not name, guess at or allude to who they are. " +
  "You are writing a specification for a DIFFERENT, fictional person of the same type — so describe " +
  "the characteristics, then deliberately vary the specific face: the bone structure, nose, mouth and " +
  "eye spacing you write down must differ from the photograph's while staying plausible for someone " +
  "of that background and age. " +
  SPEC_GUIDANCE;

function parseSpec(raw: string): PersonaSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The description model did not return usable JSON.");
  }
  const spec = coerceSpec(parsed);
  if (!specIsUsable(spec)) {
    throw new Error("The description came back too thin to draw from — try a fuller sentence.");
  }
  return spec;
}

/** A one-line brief → a full spec. */
export async function specFromSentence(sentence: string, extra?: string): Promise<PersonaSpec> {
  const brief = (sentence || "").trim();
  if (!brief) throw new Error("Say who you want in a sentence.");
  if (!anthropicConfigured()) {
    throw new Error("No Anthropic API key — the description step needs one.");
  }
  const raw = await claudeChatJSON({
    // No "mini" in the name, so this routes to the research tier — writing a
    // face is the one text call in this flow whose quality shows up in the image.
    model: "gpt-4o",
    system: SENTENCE_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Brief: ${brief}` +
          (extra?.trim() ? `\nThey will always be filmed in: ${extra.trim()}` : "") +
          "\n\nReturn the JSON now.",
      },
    ],
  });
  return parseSpec(extractJsonish(raw));
}

/** A reference photo → a spec for someone of the same type (never the same person). */
export async function specFromReference(opts: {
  base64: string;
  /** Named as everywhere else in this module; Claude calls it media_type. */
  mimeType: string;
  /** The operator's sentence, if they gave one — it wins over the photo. */
  sentence?: string;
  environment?: string;
}): Promise<PersonaSpec> {
  if (!anthropicConfigured()) {
    throw new Error("No Anthropic API key — reading a reference photo needs one.");
  }
  const brief = (opts.sentence || "").trim();
  const raw = await claudeVisionLabeledJSON({
    system: VISION_SYSTEM,
    images: [{ label: "Reference photograph (type only):", data: opts.base64, mediaType: opts.mimeType }],
    userText:
      (brief
        ? `The operator also asked for: ${brief}. Where this and the photograph disagree, follow the operator.`
        : "Describe a fictional person of the same type as the photograph.") +
      (opts.environment?.trim() ? `\nThey will always be filmed in: ${opts.environment.trim()}` : "") +
      "\n\nReturn the JSON now.",
    purpose: "tutorial-avatar-reference",
  });
  return parseSpec(extractJsonish(raw));
}

/** Tolerate a fenced or chatty reply without importing the whole ai module. */
function extractJsonish(text: string): string {
  const t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

// ── drawing it ──────────────────────────────────────────────────────────────

/**
 * The image engines this can draw with.
 *
 * Nano Banana Pro is the default for one practical reason: it takes reference
 * images INLINE as base64, so the reference photo and the refine pass never
 * need a publicly fetchable URL — and the only hole in this lab's auth gate is
 * exactly such a URL. GPT Image 2 on apimart is offered beside it because it is
 * the engine the reel pipeline itself re-renders start frames with, so an
 * avatar made on it is the closest preview of what the pipeline will do.
 */
export interface PersonaEngine {
  id: string;
  label: string;
  hint: string;
  /** Which key it needs, for an honest "not configured" message. */
  key: "gemini" | "apimart";
}

export const PERSONA_ENGINES: PersonaEngine[] = [
  {
    id: "nano-banana-pro",
    label: "Nano Banana Pro",
    hint: "Gemini 3 Pro Image — sharpest, takes the reference inline. Best default.",
    key: "gemini",
  },
  {
    id: "nano-banana",
    label: "Nano Banana",
    hint: "Gemini 2.5 Flash Image — quicker and cheaper for rolling faces.",
    key: "gemini",
  },
  {
    id: "gpt-image-2",
    label: "GPT Image 2",
    hint: "apimart — the same engine the reel re-renders start frames with.",
    key: "apimart",
  },
];

export function findEngine(id: string | undefined): PersonaEngine {
  return PERSONA_ENGINES.find((e) => e.id === id) || PERSONA_ENGINES[0];
}

const CHAT_MODEL: Record<string, ChatImageModel> = {
  "nano-banana-pro": "pro",
  "nano-banana": "flash",
};

export interface PersonaImage {
  /** Base64 bytes, no data: prefix. */
  base64: string;
  mimeType: string;
  /** The exact prompt used — shown in the UI so a good roll is reproducible. */
  prompt: string;
}

/** One reference image travelling into an engine. */
export interface RefImage {
  base64: string;
  mimeType: string;
}

/**
 * Draw (or edit) one image on the chosen engine.
 *
 * Kept as the single transport for both the draw and the refine passes: the
 * only difference between them is the prompt and whether an image goes in, and
 * splitting them would give the refine path its own way to drift.
 */
export async function drawPersona(opts: {
  prompt: string;
  engineId?: string;
  images?: RefImage[];
  /**
   * The shape to ask for. Must be EXPLICIT wherever a reference is attached and
   * the output is a different shape from it: the map is 16:9 and the scene
   * built from that map is 9:16, and left on "auto" the scene inherits the
   * map's landscape shape and every reel is cut from a sideways portrait.
   */
  aspect?: ChatAspect;
}): Promise<PersonaImage> {
  const engine = findEngine(opts.engineId);
  const images = opts.images || [];
  // An edit with no stated shape keeps the source's, which is right for the
  // refine pass and wrong everywhere the caller knows better.
  const aspect: ChatAspect = opts.aspect ?? (images.length ? "auto" : "9:16");

  if (engine.key === "apimart") {
    return { ...(await apimartImage(opts.prompt, images, aspect)), prompt: opts.prompt };
  }
  const out = await generateChatImage({
    instruction: opts.prompt,
    images: images.map((i) => ({ mimeType: i.mimeType, data: Buffer.from(i.base64, "base64") })),
    model: CHAT_MODEL[engine.id] || "pro",
    aspect,
  });
  return { base64: out.base64, mimeType: out.mimeType, prompt: opts.prompt };
}

const APIMART_IMAGES = "https://api.apimart.ai/v1/images/generations";

/**
 * GPT Image 2 through apimart, in the shape the Python pipeline already uses
 * (scripts/make_talkinghead_frame.py): references ride as data URIs in
 * `image_urls`, and the result comes back as a hosted URL we then fetch.
 */
async function apimartImage(
  prompt: string,
  images: RefImage[],
  aspect: ChatAspect,
): Promise<{ base64: string; mimeType: string }> {
  const key = getApimartApiKey();
  if (!key) {
    throw new Error("No apimart API key — add it in Settings before drawing on GPT Image 2.");
  }
  const body: Record<string, unknown> = {
    model: "gpt-image-2",
    prompt,
    // apimart takes the ratio as `size`; "auto" means "say nothing".
    ...(aspect === "auto" ? {} : { size: aspect }),
    resolution: "2k",
  };
  if (images.length) {
    body.image_urls = images.map((i) => `data:${i.mimeType};base64,${i.base64}`);
  }
  let res: Response;
  try {
    res = await fetch(APIMART_IMAGES, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("apimart is unreachable.");
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `apimart returned ${res.status}${res.status === 401 ? " — the apimart key was rejected." : ""}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("apimart returned a non-JSON response.");
  }
  const inline = firstBase64(parsed);
  if (inline) return { base64: inline, mimeType: "image/png" };
  const url = firstImageUrl(parsed);
  if (!url) throw new Error("apimart returned no image.");
  const img = await fetch(url);
  if (!img.ok) throw new Error(`Could not download the generated image (${img.status}).`);
  const buf = Buffer.from(await img.arrayBuffer());
  return {
    base64: buf.toString("base64"),
    mimeType: img.headers.get("content-type") || "image/png",
  };
}

/** Walk an arbitrary response for the first image URL — the shape varies. */
export function firstImageUrl(obj: unknown): string | null {
  if (typeof obj === "string") {
    return /^https?:\/\//.test(obj) && /\.(png|jpe?g|webp)(\?|$)/i.test(obj) ? obj : null;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const u = firstImageUrl(v);
      if (u) return u;
    }
    return null;
  }
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      const u = firstImageUrl(v);
      if (u) return u;
    }
  }
  return null;
}

/** Some gateways answer with inline base64 instead of a URL. */
export function firstBase64(obj: unknown): string | null {
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    const direct = rec.b64_json ?? rec.b64 ?? rec.image_base64;
    if (typeof direct === "string" && direct.length > 100) return direct;
    for (const v of Object.values(rec)) {
      const b = firstBase64(v);
      if (b) return b;
    }
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const b = firstBase64(v);
      if (b) return b;
    }
  }
  return null;
}
