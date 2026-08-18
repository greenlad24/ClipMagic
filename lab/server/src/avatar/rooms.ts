/**
 * ROOM PLATES — the one set every persona is filmed in.
 *
 * A plate is a photograph of the studio with nobody in it. They were made by
 * taking real frames from the reference videos and having an image model remove
 * the person and rebuild the room behind them, so what survives is only the set:
 * the light direction, the lens, the grade and the furniture. No likeness, no
 * legible signage, no branding.
 *
 * WHY A PLATE AND NOT A PROMPT. `look.ts` describes the room in words, and words
 * get you the right KIND of room — a different one every generation. Continuity
 * across a channel needs the SAME room: the same neon on the same wall, the same
 * window on the same side, the same shelf behind the same shoulder. A reference
 * image is the only thing that delivers that, because it is the room rather than
 * a description of one.
 *
 * WHERE A PLATE IS USED — both ends of the pipeline, which is the whole point:
 *   1. Making the persona. The portrait is generated INTO the plate, so the
 *      locked still already has them sitting in the room.
 *   2. Every video segment. The plate rides along with the portrait as a second
 *      reference image, so the engine is shown the room it must return to at the
 *      start and end of each clip rather than inferring it from the portrait.
 *
 * Step 2 matters more than it looks. Seedance generates each chunk of a long
 * script as a separate job, and a generative model handed only a person will
 * happily invent a slightly different room each time. Handing it the plate every
 * time is what keeps thirty segments in one place.
 *
 * NANO BANANA, NOT GPT IMAGE 2, for the portrait-into-plate step. Two concrete
 * reasons, not a preference: Gemini takes reference images as INLINE base64, so
 * a local plate needs no capability URL, where the Segmind path fetches an
 * `image` field server-side and would need one published for it; and the task
 * here is compositing a described person into a supplied scene, which is the
 * thing the editing models are built for.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { NEGATIVE_PROMPT } from "./look.js";

export interface RoomPlate {
  id: string;
  label: string;
  /** One line for the UI. */
  hint: string;
  /** Filename inside the reference directory. */
  file: string;
  /**
   * Where the presenter sits and what the camera sees, in the words the image
   * model needs. The plate carries the room; this carries the intent, because a
   * model given only an empty room will place a person anywhere in it.
   */
  placement: string;
}

export const ROOM_PLATES: RoomPlate[] = [
  {
    id: "studio-front",
    label: "Studio — front",
    hint: "Facing camera, near-black wall behind, window off to one side.",
    file: "studio-front.png",
    placement:
      "The presenter is seated in the chair that faces the camera, filling the same part of the frame the chair " +
      "occupies, with the near-black wall directly behind them.",
  },
  {
    id: "studio-front-close",
    label: "Studio — front, closer",
    hint: "The front set, camera in tighter. Bigger face = better mouth at 480p.",
    file: "studio-front-close.png",
    /**
     * A CROP of studio-front, not a re-render — so it is guaranteed to be the
     * identical room rather than a convincing imitation of it.
     *
     * It exists because of a measured failure: the first video off `studio-front`
     * put the head at ~105px in an 854x480 frame, leaving the mouth about 30px
     * wide. Seedance articulated it correctly — the frames show open, closed and
     * rounded shapes — but 30px cannot carry a mouth, so it read as mush. Face
     * size is a lipsync parameter, not a taste one, and a wide plate spends the
     * resolution on the room.
     */
    placement:
      "The presenter is seated in the chair facing the camera, filling the middle of the frame with their head " +
      "and shoulders well above the chair back, and the near-black wall directly behind them.",
  },
  {
    id: "studio-side",
    label: "Studio — side, with computer",
    hint: "At the desk with the laptop in the foreground, window to the right.",
    file: "studio-side.png",
    placement:
      "The presenter is seated at the desk behind the open laptop, turned towards the camera, with the laptop " +
      "staying large and out of focus in the near foreground and the room falling away past them.",
  },
  {
    id: "studio-gear",
    label: "Studio — gear wall",
    hint: "Lens shelves behind, window left, laptop out of focus at the right.",
    file: "studio-gear.png",
    placement:
      "The presenter is seated in the chair in the middle of the frame, facing the camera, with the shelves of " +
      "camera equipment behind them and the laptop staying out of focus in the near right foreground.",
  },
];

/** The directory plates live in — beside the portraits, not in the served tree. */
export function roomsDir(): string {
  return path.join(config.avatarDir, "reference");
}

export function findRoom(id: string | undefined | null): RoomPlate | null {
  if (!id) return null;
  return ROOM_PLATES.find((r) => r.id === id) ?? null;
}

/**
 * Absolute path to a plate, or null when the file is not on disk.
 *
 * Returning null rather than throwing is deliberate: a missing plate must
 * degrade to the ordinary text-described room, never fail a render. The plates
 * are data-directory assets, so a fresh install has none until they are made.
 */
export function roomPlateFile(id: string | undefined | null): string | null {
  const room = findRoom(id);
  if (!room) return null;
  const file = path.join(roomsDir(), room.file);
  return fs.existsSync(file) ? file : null;
}

/** Which plates actually exist right now — what the UI should offer. */
export function availableRooms(): Array<RoomPlate & { ready: boolean }> {
  return ROOM_PLATES.map((r) => ({ ...r, ready: !!roomPlateFile(r.id) }));
}

/**
 * The instruction for generating a persona INTO a plate.
 *
 * Almost all of it is about what must NOT change. Asked to put a person in a
 * room, an image model treats the room as a suggestion and re-renders it — a
 * similar room, relit, from a slightly different position. That is precisely the
 * failure this whole mechanism exists to prevent, so the room is pinned first,
 * hard, and the person described second.
 *
 * The lighting clause is the subtle one. The plate has a single window and no
 * edge light; a model adding a person will instinctively LIGHT them, and the
 * moment it does, they stop belonging to the room. So the direction is not
 * "light them well" but "let the room's own light fall on them".
 */
export function buildRoomPortraitPrompt(description: string, room: RoomPlate): string {
  const who = (description ?? "").trim();
  if (!who) throw new Error("Describe the presenter — age, look, clothing, and setting.");

  // No framing argument here on purpose: with a plate, the composition is
  // already decided by the photograph. A framing instruction could only fight
  // it — asking for a wide shot of a room photographed close just moves the
  // camera, which is the one thing that must not happen.
  return [
    "This photograph is a real room. Add ONE person to it and change nothing else.",

    "THE ROOM IS FIXED. Keep the exact same room, photographed from the exact same camera position, height and " +
      "angle, with the same focal length, the same perspective and the same depth of field. Every object stays " +
      "where it is and looks the same: the walls and their colour, the window and everything visible through it, " +
      "the desk, the chair, the shelves, the equipment, the plants, the glowing sign, the floor and the ceiling. " +
      "Do not redecorate, do not tidy, do not add or remove any object, and do not reveal any more of the room " +
      "than this photograph already shows.",

    "THE LIGHT IS FIXED. Do not relight the scene and do not add any lamp, softbox, rim light, edge light, " +
      "kicker or backlight for the person. The only light on them is the light already in this room, arriving " +
      "from the same direction it arrives from everywhere else in the picture — soft daylight from the window, " +
      "falling off gently, leaving the side away from it in shadow. Their exposure matches the room's.",

    `WHO TO ADD: ${who.replace(/\.?$/, ".")}`,

    room.placement,

    "They look directly into the lens with a relaxed, neutral expression, MOUTH CLOSED and lips together — not " +
      "smiling, not speaking, teeth not visible. Head upright and still, both shoulders in frame, hands not " +
      "touching the face. They are in sharp focus; the room keeps exactly the focus falloff it already has.",

    "They must look photographed in this room, not pasted onto it: correct scale for the furniture, feet and " +
      "body properly placed in the space, the room's colour cast on their skin and clothing, contact shadows " +
      "where they meet the chair and the desk, and the same film grain and colour grade over them as over " +
      "everything else in the frame.",

    "Photorealistic photograph — not an illustration, not a render, not stylised. Natural skin with real texture " +
      "and pores. No text, no logos, no watermarks, no other people.",

    NEGATIVE_PROMPT,
  ]
    .filter(Boolean)
    .join(" ");
}
