/**
 * The look — how a persona is *captured*, not just who they are.
 *
 * This module exists because of one finding that survived every other decision
 * in this tool: an image model left to infer how the footage was shot blends
 * every style it knows and produces the half-CGI face that reads as fake
 * instantly. Naming the medium — the camera, the lens, the light, the grain —
 * is the single largest contributor to whether the result passes as real.
 *
 * The second finding is why this matters more here than anywhere else in the
 * app: an audio-driven lipsync model ANIMATES the portrait, it does not improve
 * it. Every bit of realism the finished video will ever have is decided in the
 * still. So the prompt that makes the still is not decoration, it is the
 * product, and it is built here from four separable parts:
 *
 *   character  — who they are, in forensic detail (see CharacterSpec)
 *   medium     — how the footage was captured (see CAPTURE_MEDIUMS)
 *   rules      — what makes the still ANIMATABLE (portrait.ts PORTRAIT_RULES)
 *   negative   — what the model must not do (see NEGATIVE_PROMPT)
 *
 * A note on the tension baked into `rules`: flat frontal light is specified on
 * purpose, because a lipsync model cannot move a baked shadow — hard side light
 * slides across the face as the head turns. Flat light is also, unhelpfully,
 * one of the things that makes a face read as studio-fake. That trade is real
 * and it is the realism ceiling of animating a still; it is accepted here
 * deliberately rather than discovered later.
 */

/**
 * How the footage was captured. Named, not described, because these read as
 * shorthand the image models already understand — and because the operator
 * should be choosing between recognisable looks, not writing cinematography.
 */
export interface CaptureMedium {
  id: string;
  label: string;
  /** One line describing the register, for the UI. */
  hint: string;
  /** The prompt fragment. Written as camera direction — models follow it. */
  spec: string;
}

export const CAPTURE_MEDIUMS: CaptureMedium[] = [
  {
    id: "cinematic-studio",
    label: "Creator's studio — window light",
    hint: "Seated at the desk in a room they work in. Soft daylight, muted grade, no rim light.",
    /**
     * The brief this answers: "real in a real environment, not a disconnected
     * avatar headshot."
     *
     * A subject against a blurred backdrop reads as a cutout no matter how good
     * the face is, and no amount of grain or grade fixes it. What fixes it is
     * geometry and light behaving as if the room exists, so this spec is built
     * from the four cues that actually sell it — each one named explicitly
     * because a model will skip any of them if left to its own devices:
     *
     *   FOREGROUND    something out of focus between lens and subject. The
     *                 single strongest cue available: the camera is in the room
     *                 too, at a position, with things in front of it.
     *   LAYERS        near / subject / mid / far. "Background" is one plane and
     *                 reads as wallpaper.
     *   MOTIVATION    a visible source in shot that explains the light. Light
     *                 arriving from nowhere is what makes a composite look
     *                 composited.
     *   CONTACT       the subject physically among the furniture — forearms on
     *                 the desk, the desk edge crossing in front of them. Without
     *                 something they touch, they hover in the room.
     *
     * The rig is named as real gear — Sony FX30, Tamron 17-70mm f/2.8 — for the
     * same reason the mediums are named rather than described: image models have
     * seen a great deal of footage labelled with it, so the name carries more
     * than a paragraph of adjectives would. It also happens to be self-consistent
     * with the brief: a Super 35 sensor behind an f/2.8 zoom cannot obliterate a
     * background the way a fast full-frame prime does, so the room survives.
     * Choosing gear that renders the look wanted is doing half the prompting.
     *
     * ON THE ABSENCE OF A RIM LIGHT — the part most likely to get "fixed" back:
     * an earlier version of this spec demanded a bright cool rim, and it was
     * rejected as too much. The references are the reason it stays out. Both are
     * lit by a window and nothing else, and the separation is done entirely by
     * TONE and DEPTH: the face sits a little brighter than the wall, the room
     * falls out of focus behind it. That is why they read as a room someone
     * happens to be working in rather than a set someone was lit on. A rim light
     * is the single fastest way to lose that, so it is named as a negative here
     * rather than merely left unmentioned — an unlit shot is not the same
     * instruction as a shot with no edge light, and models will add one.
     */
    spec:
      "Shot on a Sony FX30 — a Super 35 / APS-C cinema camera — with a Tamron 17-70mm f/2.8 Di III-A VC zoom " +
      "set to 35mm and wide open at f/2.8, the camera at seated eye level and close to the subject. " +
      "Because it is a Super 35 sensor behind an f/2.8 zoom rather than a fast full-frame prime, the background " +
      "is softened but never dissolved: the room stays legible behind the subject. " +
      "The subject is seated at their desk in a real, lived-in creator's studio, in the roof space of a building " +
      "with a sloped ceiling — a room they obviously work in every day, not a set built for the shot. " +
      "THE ONLY LIGHT IS DAYLIGHT FROM A LARGE WINDOW just off camera to one side, which is itself visible at " +
      "the edge of the frame and slightly blown out. It is broad, soft, wrapping light that falls off gently " +
      "across the face and leaves no hard-edged shadow. " +
      "NO RIM LIGHT and no edge light of any kind — nothing outlining the hair, the jaw or the shoulders, no " +
      "kicker, no backlight, no lamp pointed at the subject, no second source. On the side away from the window " +
      "the subject is simply allowed to fall into the dark of the room. Nothing about the light may look " +
      "arranged: it reads as daylight that was already there before the camera was set up. " +
      "Separation comes from tone and depth rather than from an edge — the lit side of the face sits brighter " +
      "than the dark wall behind it, and the room falls gently out of focus. " +
      "The room reads in layers: in the near foreground, large and completely out of focus, the back of an open " +
      "laptop screen and the near edge of the desk crossing the bottom corner of the frame; the subject in the " +
      "midground with forearms resting on the desk; and behind them a wall painted near-black carrying the " +
      "ordinary evidence of work — a softly glowing neon sign, equipment cases and a light stand, a shelf, a " +
      "houseplant, all thrown well out of focus. " +
      "Finished the way that camera and lens actually render: 4K oversampled from 6K, crisp without looking " +
      "sharpened, with a fine even film grain. Graded cool, muted and LOW CONTRAST — desaturated, with a slight " +
      "green-cyan lean in the shadows, gently lifted milky blacks that are never crushed, soft highlight " +
      "roll-off, and natural warmth kept in the skin so the person reads warm against the cooler room. " +
      "A mild vignette. No punchy contrast, no heavy teal-and-orange grade, no glossy commercial polish, " +
      "no lens flare, no haze beams. " +
      "It should look like a quiet frame from a working filmmaker's own video — a real person sitting in their " +
      "own studio, photographed there, not cut out and placed in front of it.",
  },
  {
    id: "youtube-studio",
    label: "YouTube studio — cinematic",
    hint: "Shaped key, rim light, dark set with bokeh. The polished creator look.",
    spec:
      "Shot on a full-frame cinema camera with a 35mm lens at f/2.0 in a purpose-built video studio. " +
      "Cinematic three-point lighting: a large soft key just off-axis shaping one side of the face, gentle negative fill on the other " +
      "so the cheekbone reads, and a cool rim light separating the hair and shoulders from the background. " +
      "Behind the subject, a dark studio set falling into shadow with a few out-of-focus practical lights and a soft coloured glow, " +
      "thrown well out of focus by the shallow depth of field. " +
      "Filmic colour grade with lifted blacks, fine grain, natural skin tones, gentle highlight roll-off. " +
      "Looks like a frame from a well-lit YouTube video, not a render and not a flat studio headshot.",
  },
  {
    id: "daylight-interior",
    label: "Daylight interior",
    hint: "Warm, approachable — a competent colleague at their desk",
    spec:
      "Shot on a full-frame mirrorless camera with an 85mm lens at f/4, lit by soft north-facing window daylight from just behind the camera. " +
      "Natural colour, mild contrast, fine film grain, a faint sensor-noise floor in the shadows. Looks like a real photograph, not a render.",
  },
  {
    id: "studio-premium",
    label: "Premium studio",
    hint: "Controlled and authoritative — the tech-review register",
    spec:
      "Shot on a full-frame cinema camera with a 50mm prime at f/2.8, large softbox key just off the lens axis with a subtle fill, " +
      "deep neutral backdrop falling into shadow. Crisp micro-contrast, restrained colour grade, fine grain. Looks like real footage, not a render.",
  },
  {
    id: "phone-natural",
    label: "Phone, natural light",
    hint: "Unpolished and immediate — reads as a real person filming themselves",
    spec:
      "Shot on a modern smartphone front camera in ordinary room light, slight wide-angle perspective, mild lens softness at the edges, " +
      "a touch of digital noise and imperfect white balance. Deliberately unpolished — it should look like a real phone photo, not a studio portrait.",
  },
];

export function findMedium(id: string | undefined): CaptureMedium {
  return CAPTURE_MEDIUMS.find((m) => m.id === id) ?? CAPTURE_MEDIUMS[0];
}

/**
 * The character, in the detail the model actually needs.
 *
 * Generic descriptions ("a friendly presenter in her thirties") produce generic
 * faces — smooth, symmetrical, and immediately readable as AI. Realism lives in
 * specifics and especially in IMPERFECTIONS, so `skin` is a required field
 * rather than an optional flourish: pores, uneven tone, a stray mark. Every
 * field here ends up in the prompt verbatim.
 */
export interface CharacterSpec {
  /** e.g. "32" — an age, not a range; ranges average into blandness. */
  age: string;
  /** e.g. "woman", "man", "person". */
  presenting: string;
  /** Heritage/appearance, if the operator wants to fix it. Free text, optional. */
  heritage?: string;
  /** Face shape, jaw, nose, brow — the structure that makes a face specific. */
  face: string;
  /** Eyes and eyebrows. */
  eyes: string;
  /** Hair: cut, colour, and how it actually sits — including stray strands. */
  hair: string;
  /** REQUIRED. Pores, tone unevenness, marks. This is where realism lives. */
  skin: string;
  /** Wardrobe, with material and texture named. */
  wardrobe: string;
}

/**
 * What the model must not do. Kept separate from the positive prompt because
 * the failure modes are consistent across every image model worth using, and
 * because they are easy to forget one at a time.
 */
export const NEGATIVE_PROMPT =
  "Avoid: beauty retouching, skin smoothing, airbrushing, plastic or waxy skin, glamour lighting, " +
  "CGI or 3D render appearance, illustration or painterly style, exaggerated or cartoonish expression, " +
  "perfect facial symmetry, over-saturated colour, heavy vignetting, watermarks, text, logos.";

/** Compose the character half of the prompt from the structured spec. */
export function describeCharacter(spec: CharacterSpec): string {
  // "-year-old" is appended to the AGE, not used as a separator: joining all
  // three fields with it produced "36-year-old Black British-year-old man"
  // whenever a heritage was set — which both presets set.
  const who = [`${spec.age}-year-old`, spec.heritage, spec.presenting]
    .filter((s) => s && s.trim())
    .join(" ")
    .trim();
  return [
    `An original fictional ${who}, not resembling any real or public figure.`,
    spec.face,
    spec.eyes,
    spec.hair,
    `Real human skin: ${spec.skin}.`,
    `Wearing ${spec.wardrobe}.`,
  ]
    .map((s) => s.trim().replace(/\.?$/, "."))
    .join(" ");
}

/**
 * Presets — a complete, working character plus the medium that suits it.
 *
 * These are starting points to edit, not brand identities. Both are original
 * people; neither is modelled on anyone real. `explainer` is the spec that was
 * generated and visually verified on 2026-08-10 (pores, tone unevenness,
 * flyaway hair, real grain), so it is the known-good reference — change it only
 * against a new generation you have actually looked at.
 */
export interface LookPreset {
  id: string;
  label: string;
  hint: string;
  mediumId: string;
  character: CharacterSpec;
  /** Suggested narration voice for this register (Gemini TTS voice id). */
  voice: string;
}

export const LOOK_PRESETS: LookPreset[] = [
  {
    id: "explainer",
    label: "The explainer",
    hint: "Warm and approachable — how-to, productivity, software walkthroughs",
    mediumId: "daylight-interior",
    voice: "Kore",
    character: {
      age: "32",
      presenting: "woman",
      heritage: "Filipina-American",
      face:
        "Oval face with softly defined cheekbones, a slightly rounded jaw, and a small nose with a gently rounded tip",
      eyes: "Warm brown almond eyes with visible lower-lid texture, thick dark eyebrows with a natural uneven arch",
      hair:
        "Dark brown hair in a loose shoulder-length cut, tucked behind one ear, with a few stray flyaway strands catching the light",
      skin:
        "visible pores across the nose and cheeks, faint natural freckling under the eyes, a small mole near the left jawline, " +
        "slight unevenness in skin tone, a barely-there shine on the forehead and nose",
      wardrobe: "a soft oatmeal-coloured knit sweater with visible yarn texture",
    },
  },
  {
    id: "reviewer",
    label: "The reviewer",
    hint: "Controlled and authoritative — hardware, analysis, verdicts",
    mediumId: "studio-premium",
    voice: "Charon",
    character: {
      age: "36",
      presenting: "man",
      heritage: "Black British",
      face:
        "Angular face with a strong straight jawline, defined cheekbones, a broad nose with a slightly flattened bridge, and a close-trimmed beard",
      eyes: "Dark brown deep-set eyes under a level brow, with fine creases at the outer corners",
      hair: "Closely cropped black hair with a sharp hairline, a few grey strands at the temples",
      skin:
        "visible pores and natural texture across the forehead and cheeks, a faint scar above the right eyebrow, " +
        "slight unevenness in tone, a low natural sheen on the forehead",
      wardrobe: "a matte black crewneck in heavyweight cotton with a visible knit grain",
    },
  },
];

export function findPreset(id: string | undefined): LookPreset | undefined {
  return LOOK_PRESETS.find((p) => p.id === id);
}

/**
 * How much of the person is in frame — and therefore whether they have hands.
 *
 * This is not a taste setting, it follows from the engine. A LIPSYNC model
 * animates the still it is given: there are no arms in a chest-up portrait, so
 * asking for gestures produces either nothing or a smeared limb. A GENERATIVE
 * model draws the whole person each frame, so a wider shot gives it room to
 * gesture — and gesture is most of what separates a read that looks alive from
 * a talking head.
 */
export interface Framing {
  id: string;
  label: string;
  hint: string;
  /** Portrait direction: how the still is composed. */
  spec: string;
  /** Motion direction: what the body may do at render time. */
  motion: string;
}

export const FRAMINGS: Framing[] = [
  {
    id: "medium",
    label: "Medium shot — hands in frame",
    hint: "Waist up, room to gesture. For engines that generate the whole person.",
    spec:
      "Framing: medium shot from the waist up, the subject centred with a little headroom and clear space either side of the torso. " +
      "Both shoulders, the upper arms and the hands are within the frame, hands resting naturally and not touching the face.",
    motion:
      "Natural hand gestures that match the emphasis of the words — open palms, a small counting or pointing beat on a key phrase, " +
      "hands returning to a resting position between thoughts. Gestures stay within the frame and never cover the face or mouth. " +
      "Relaxed shoulders and a little upper-body movement as they speak.",
  },
  {
    id: "close",
    label: "Close-up — head and shoulders",
    hint: "Chest up, no hands. Required by lipsync engines that animate a still.",
    spec:
      "Framing: medium close-up, chest up, head centred with a little headroom. Both shoulders fully in frame. " +
      // Flat light lives HERE now rather than in the universal rules: it is a
      // requirement of animating a still, not of portraiture. A lipsync model
      // cannot move a baked shadow, so hard side light slides across the face
      // as the head turns.
      "Lighting: soft, even, frontal key with gentle fill — no hard shadows across the face, no strong side or rim light, no colour cast.",
    motion: "No hand gestures and no hands entering the frame. Movement is limited to the head and shoulders.",
  },
  {
    id: "environment",
    label: "Wide — the room is in shot",
    hint: "Three-quarter length, placed off-centre. For when the setting is half the point.",
    /**
     * Composition is what stops a wide shot being a headshot with wasted space.
     * A subject centred and filling the frame reads as a portrait however much
     * room is behind them; a subject placed off a third, with the space they are
     * standing in given room to exist, reads as a scene. Hence the thirds
     * placement and the explicit instruction to show where surfaces meet — a
     * floor line and a ceiling line are what tell the eye how big the room is.
     */
    spec:
      "Framing: wide medium shot, three-quarter length from mid-thigh up, the subject standing off-centre on a " +
      "vertical third with the room opening out to the other side of the frame. Generous headroom. " +
      "Enough of the space is visible to read it as a real room — the floor beneath them, the wall behind them " +
      "at a distance, and where those surfaces meet. " +
      // First generation cropped the hands at the wrist. The cut has to be named
      // as a place on the body, not implied by "three-quarter length".
      "The frame cuts at mid-thigh, well below the hands, so both hands are fully visible with clear space " +
      "beneath them — no hand is cropped by the bottom edge. Hands rest naturally and do not touch the face. " +
      // A wide shot in a 9:16 frame walks the subject backwards until the face is
      // a few dozen pixels. That is fatal here in a way it would not be for a
      // photograph: the video model animates this face, so it has to be resolved.
      "Despite the width, the camera stays close enough that the face reads clearly and its expression is " +
      "legible — the head occupies roughly a fifth of the frame height. Never a small distant figure in a big room.",
    motion:
      "Natural hand gestures that match the emphasis of the words — open palms, a small counting or pointing beat " +
      "on a key phrase, hands returning to a resting position between thoughts. A little weight shift and " +
      "upper-body movement as they speak, as a person standing in a room does. " +
      "Gestures stay within the frame and never cover the face or mouth.",
  },
];

export function findFraming(id: string | undefined): Framing {
  return FRAMINGS.find((f) => f.id === id) ?? FRAMINGS[0];
}

/**
 * The motion prompt handed to the lipsync/video model at render time.
 *
 * Two rules drive this, both learned the expensive way. First, small beats big:
 * these models keep a face coherent through subtle movement and fall apart
 * through large ones, so the direction asks for micro-expression, not
 * performance. Second, name the negatives — left alone the models add
 * exaggerated emotion, camera moves and background music, and every one of
 * those is a tell.
 */
/**
 * Turn "make her look a bit older" into an edit instruction the model obeys.
 *
 * The failure mode this exists to prevent is subtle and expensive: ask an image
 * model to change one thing about a face and it will happily return a DIFFERENT
 * PERSON who matches the description. For a persona built on identity across
 * hundreds of videos, that is not a bad edit, it is a broken product. So the
 * composed prompt spends most of its words on what must NOT change, and states
 * the requested change once.
 *
 * Kept pure and exported so the exact wording is pinned by a test — this is the
 * string that decides whether an edit preserves a face or replaces it.
 */
export function buildEditPrompt(instruction: string, medium?: CaptureMedium): string {
  const change = (instruction ?? "").trim();
  if (!change) throw new Error("Say what you want changed.");
  return [
    "Edit this photograph of a specific person. Keep it the SAME PERSON — identical facial structure, bone structure, " +
      "eye shape and colour, nose, mouth, jawline, hairline, skin tone and every distinguishing mark. The result must be " +
      "recognisably the same individual photographed again, not a similar-looking person.",
    `The ONLY change to make: ${change.replace(/\.?$/, ".")}`,
    "Everything not named in that change stays exactly as it is: the same framing, the same camera distance, the same " +
      "pose and head angle, the same lighting direction and quality, the same background, the same wardrobe.",
    medium?.spec,
    "Preserve the photographic realism: real skin texture and pores, no smoothing or retouching introduced by the edit, " +
      "no change in image style, no illustration or render look.",
    "Keep the MOUTH CLOSED and the expression relaxed and neutral, and keep both shoulders in frame.",
    NEGATIVE_PROMPT,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildScenePrompt(opts?: { medium?: CaptureMedium; extra?: string; framing?: Framing }): string {
  const framing = opts?.framing ?? FRAMINGS[0];
  const gestures = framing.id !== "close";
  return [
    "A person speaking directly to the camera in a calm, natural presenting style.",
    "Micro-expressions: small eyebrow movement, natural blinking at an irregular human rhythm, " +
      "slight head movement as they speak, a subtle shift of the eyes, relaxed breathing.",
    framing.motion,
    "Static locked-off camera, fixed framing, no camera movement, no zoom, no cuts.",
    opts?.extra?.trim(),
    // Gestures are wanted now, so they leave the negative list — but the things
    // that read as fake do not: theatrical faces, flailing, and the music bed
    // these models add unasked.
    "Avoid: exaggerated or theatrical facial expressions, " +
      (gestures ? "wild or repetitive flailing arm movement, " : "hand gestures entering frame, ") +
      "large lurching body movement, fast motion, camera movement, scene cuts, " +
      "added dialogue beyond the script, background music.",
  ]
    .filter(Boolean)
    .join(" ");
}
