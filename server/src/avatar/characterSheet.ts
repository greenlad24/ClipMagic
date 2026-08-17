/**
 * The CHARACTER SHEET — one persona, twenty views, so the face survives a
 * change of room.
 *
 * THE PROBLEM THIS SOLVES. A persona is one photograph, and a photograph shows
 * a face from exactly one angle. Ask an image model to put that person in a
 * different room and it has to invent every angle it cannot see — so it invents
 * a similar person instead, and the channel's presenter quietly becomes someone
 * else the first time they turn their head. Handing the model twenty views of
 * the same face turns "imagine this person from another angle" into "copy the
 * one you were shown", which is a far easier instruction to obey.
 *
 * A sheet is generated ONCE per persona and reused for every placement. It is
 * an identity asset, not a render — the same role the portrait plays for the
 * video engine, one level up.
 *
 * WHAT GOES ON IT. Twenty head-and-shoulders views on a 5x4 grid: the angles a
 * presenter actually moves through while speaking, plus the profiles and the
 * back of the head that a model otherwise has to guess at. Deliberately NOT an
 * expression sheet — the mouth stays closed throughout, because a sheet full of
 * open mouths teaches the placement step to produce one, and an open mouth in
 * the source still is the classic lipsync tell.
 *
 * WHITE SEAMLESS, ON PURPOSE. The sheet carries the FACE and nothing else; the
 * room comes from the plate at placement time (see rooms.ts). A sheet shot in a
 * room would drag that room's light into every future placement.
 */
import { NEGATIVE_PROMPT } from "./look.js";

/** Rows of the grid, written the way the model has to read them. */
export const SHEET_ROWS = [
  "row 1 — five head-and-shoulders views turning left to right: full front facing the camera, " +
    "three-quarter turned slightly to their left, full left profile, three-quarter turned slightly to their " +
    "right, full right profile",
  "row 2 — the same five turns again but tilted: chin raised looking slightly up, chin lowered looking " +
    "slightly down, head tilted a little to one side, head tilted a little to the other side, and the back " +
    "of the head from behind",
  "row 3 — five closer views of the face: straight-on close-up, close-up three-quarter left, close-up " +
    "three-quarter right, close-up from slightly above, close-up from slightly below",
  "row 4 — five views showing more of them: chest-up front, chest-up three-quarter, waist-up front with " +
    "both hands visible and relaxed, waist-up three-quarter, and a full standing figure head to toe",
] as const;

/** How many cells the sheet has. Twenty is the grid, not a target to hit loosely. */
export const SHEET_VIEW_COUNT = 20;

/**
 * The instruction for turning ONE portrait into a twenty-view sheet.
 *
 * The whole prompt is really one sentence repeated in different words: this is
 * the SAME person. Everything else — the grid, the background, the lighting —
 * exists to remove any excuse the model has to draw someone else. Kept pure and
 * exported so the wording is pinned by a test.
 */
export function buildCharacterSheetPrompt(): string {
  return [
    "Using the person in the reference photograph, create a character reference sheet of THAT EXACT PERSON.",

    "THE SAME PERSON IN EVERY CELL. Every view is the identical individual from the reference photograph — " +
      "the same bone structure, the same face shape and jawline, the same eye shape and colour, the same nose, " +
      "the same mouth, the same hairline, hair colour and cut, the same skin tone, the same age, the same " +
      "beard or lack of one, and the same distinguishing marks, moles and scars in the same places. " +
      "They wear the same clothing in every cell. This must be recognisably one person photographed twenty " +
      "times, never a set of similar-looking people.",

    `LAYOUT: a clean grid of exactly ${SHEET_VIEW_COUNT} separate views, five columns across and four rows down, ` +
      "evenly spaced, each view fully inside its own cell and not overlapping its neighbours.",

    ...SHEET_ROWS.map((r) => `In ${r}.`),

    "In every view the expression is relaxed and neutral with the MOUTH CLOSED and lips together — not " +
      "smiling, not speaking, teeth not visible. Eyes open and looking in the direction the head faces.",

    "Plain pure white seamless studio background behind every view, with the same flat, soft, even lighting " +
      "on all twenty so nothing about the light changes from cell to cell.",

    "Photorealistic photography of a real person — not an illustration, not a render, not stylised. Keep the " +
      "real skin texture, pores and natural asymmetry from the reference photograph; do not beautify, slim, " +
      "de-age or otherwise idealise the face.",

    "No text, no labels, no captions, no numbers, no arrows, no watermarks, no borders around the cells, " +
      "no other people, no props and no furniture.",

    NEGATIVE_PROMPT,
  ].join(" ");
}

/**
 * The instruction for placing a sheeted persona into a room plate.
 *
 * TWO reference images arrive with this, and the model has to be told what each
 * one is FOR — handed two pictures with no explanation it will average them, or
 * treat the second as another view of the first. So image 1 is named as the
 * identity and image 2 as the set, and the prompt says which parts to take from
 * which. That division is the entire mechanism: face from one, world from the
 * other, and nothing borrowed the wrong way.
 *
 * The white background of the sheet is the specific trap here — it is the most
 * visually dominant thing in image 1, and a model that copies it has thrown the
 * room away. Hence the explicit instruction to take nothing but the person.
 */
export function buildPlacementPrompt(placement: string): string {
  return [
    "You are given two reference images. THE FIRST is a character reference sheet showing one person from " +
      "many angles — it is the IDENTITY, and nothing else about it matters. THE SECOND is a photograph of an " +
      "empty room — it is the SET.",

    "Produce a single photograph of the person from the first image, sitting in the room from the second.",

    "FROM THE FIRST IMAGE take only the person: their exact face and bone structure, eye shape and colour, " +
      "nose, mouth, jawline, hairline, hair, skin tone and texture, age, facial hair and every distinguishing " +
      "mark, plus their clothing. Take NOTHING else from it — not its white background, not its grid, not its " +
      "flat studio lighting, none of which appear in the result.",

    "FROM THE SECOND IMAGE take everything else, unchanged: the same room photographed from the same camera " +
      "position, height and angle, with the same focal length, the same perspective and the same depth of " +
      "field. Every object stays exactly where it is and looks the same. Do not redecorate, tidy, add or " +
      "remove anything, and do not reveal more of the room than that photograph shows.",

    placement,

    "THE ROOM'S LIGHT FALLS ON THEM. Do not relight the scene and do not add any lamp, softbox, rim light, " +
      "edge light, kicker or backlight for the person. The only light on them is the light already in that " +
      "room, arriving from the same direction it arrives from everywhere else in the picture, leaving the " +
      "side away from it in shadow. Their exposure matches the room's.",

    "They look directly into the lens with a relaxed, neutral expression, MOUTH CLOSED and lips together — " +
      "not smiling, not speaking, teeth not visible. Head upright, both shoulders in frame, hands away from " +
      "the face. They are in sharp focus and the room keeps the focus falloff it already has.",

    "They must look photographed in that room rather than pasted onto it: correct scale for the furniture, " +
      "properly seated in the space, the room's colour cast on their skin and clothing, contact shadows where " +
      "they meet the chair and the desk, and the same film grain and colour grade over them as over " +
      "everything else in the frame.",

    "Photorealistic photograph — not an illustration, not a render, not stylised. No text, no logos, no " +
      "watermarks, no other people.",

    NEGATIVE_PROMPT,
  ].join(" ");
}
