/**
 * Tutorial Studio persona prompts — the strings that decide whether an avatar
 * looks like a person or like an AI's idea of one.
 *
 * These are asserted rather than eyeballed for the same reason the Avatar
 * Narrator asserts its portrait prompt: every rule in here was earned by a
 * failed generation, and a rule that quietly disappears costs a roll to
 * rediscover. The image calls themselves are not tested — they are network.
 *
 *   npx tsx src/scripts/tutorial-persona.test.ts
 */
import assert from "node:assert/strict";
import {
  coerceSpec,
  specIsUsable,
  describePersona,
  buildPersonaPrompt,
  buildReferencedPersonaPrompt,
  buildRealismRefinePrompt,
  buildAvatarMapPrompt,
  buildScenePrompt,
  MAP_PANELS,
  findCapture,
  findEngine,
  sniffImage,
  readImageInput,
  firstImageUrl,
  firstBase64,
  FICTION_RULE,
  FRAMING_RULE,
  CAPTURE_LOOKS,
  PERSONA_ENGINES,
  type PersonaSpec,
} from "../tutorial/persona.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
  }
}

const SPEC: PersonaSpec = {
  age: "34",
  presenting: "woman",
  heritage: "Filipina-British",
  build: "Average height with narrow shoulders",
  demeanour: "Sitting slightly forward, mid-thought, glad to talk but not performing energy",
  face: "A soft oval face with a rounded jaw and a small nose",
  eyes: "Dark brown eyes, the left lid a little heavier than the right",
  hair: "Dark brown, cut blunt at the collarbone, parted off-centre",
  skin: "visible pores across the nose, uneven tone at the chin, a low sheen on the forehead",
  wardrobe: "a heavyweight oatmeal knit sweater with visible yarn",
  imperfections: "a small scar through the left eyebrow, slightly dry lips",
};

console.log("\nSpec handling");

check("coerceSpec fills every field, so a partial model reply cannot crash a prompt", () => {
  const spec = coerceSpec({ age: 40, face: "square jaw" });
  assert.equal(spec.age, "40");
  assert.equal(spec.face, "square jaw");
  assert.equal(spec.skin, "");
  assert.equal(spec.imperfections, "");
});

check("coerceSpec survives junk", () => {
  assert.equal(coerceSpec(null).presenting, "");
  assert.equal(coerceSpec("nope").face, "");
});

check("a spec without skin or face is not usable — it would render as an average", () => {
  assert.equal(specIsUsable(SPEC), true);
  assert.equal(specIsUsable({ ...SPEC, skin: "" }), false);
  assert.equal(specIsUsable({ ...SPEC, face: "" }), false);
  assert.equal(specIsUsable({ ...SPEC, presenting: "" }), false);
});

console.log("\ndescribePersona");

check("age is joined as '34-year-old', not used as a separator between fields", () => {
  // The Avatar Narrator shipped "36-year-old Black British-year-old man" for
  // weeks. Assert the exact opening so it cannot come back here.
  const out = describePersona(SPEC);
  assert.ok(out.startsWith("A 34-year-old woman. Filipina-British."), out.slice(0, 80));
  // The bug was "-year-old" used as a JOIN between fields, so it appeared once
  // per field. Exactly one occurrence is the invariant, not its absence.
  assert.equal(out.split("-year-old").length - 1, 1, out.slice(0, 120));
});

check("an empty age does not leave a dangling '-year-old'", () => {
  const out = describePersona({ ...SPEC, age: "" });
  assert.equal(out.includes("-year-old"), false);
  assert.ok(out.startsWith("A woman. Filipina-British."), out.slice(0, 60));
});

check("skin and imperfections are labelled, so the model cannot read them as clothing", () => {
  const out = describePersona(SPEC);
  assert.ok(out.includes("Skin: visible pores"), out);
  assert.ok(out.includes("Ordinary imperfections, all of them visible: a small scar"), out);
});

check("a field that already ends in a full stop does not compose into two", () => {
  // The writer punctuates some fields and not others; "…dark colouring.. Medium
  // height…" shipped in the first live run.
  const out = describePersona({
    ...SPEC,
    heritage: "Filipina-British.",
    skin: "visible pores across the nose.",
    wardrobe: "a heavy knit sweater.",
  });
  assert.equal(out.includes(".."), false, out);
  assert.ok(out.includes("Skin: visible pores across the nose."), out);
});

check("the demeanour sits with the body, before the face", () => {
  const out = describePersona(SPEC);
  assert.ok(out.includes("Sitting slightly forward"), out);
  assert.ok(out.indexOf("Sitting slightly forward") < out.indexOf("A soft oval face"));
});

check("empty optional fields are dropped rather than emitting bare full stops", () => {
  const out = describePersona({ ...SPEC, wardrobe: "", imperfections: "", heritage: "" });
  assert.equal(out.includes(".."), false);
  assert.equal(out.includes("Wearing ."), false);
});

console.log("\nbuildPersonaPrompt");

check("carries the realism spine: ordinary, asymmetric, pores, one person", () => {
  const p = buildPersonaPrompt({ spec: SPEC });
  for (const must of [
    "ORDINARY-looking person",
    "ASYMMETRIC",
    "visible pores",
    "One person only",
    "9:16",
    "mouth closed",
  ]) {
    assert.ok(p.includes(must), `missing: ${must}`);
  }
});

check("always states the fiction rule and the negatives", () => {
  const p = buildPersonaPrompt({ spec: SPEC });
  assert.ok(p.includes(FICTION_RULE));
  assert.ok(p.includes("Avoid: beauty retouching"), "negative prompt missing");
});

check("names a capture medium — the single biggest realism regression is omitting one", () => {
  const phone = buildPersonaPrompt({ spec: SPEC, captureId: "phone-selfie" });
  const camera = buildPersonaPrompt({ spec: SPEC, captureId: "camera-portrait" });
  assert.ok(phone.includes("front camera"), phone.slice(0, 200));
  assert.ok(camera.includes("35mm lens at f/2.8"));
  assert.notEqual(phone, camera);
});

check("an unknown capture id falls back to the phone look rather than emitting none", () => {
  assert.equal(findCapture("nope").id, CAPTURE_LOOKS[0].id);
  assert.ok(buildPersonaPrompt({ spec: SPEC, captureId: "nope" }).includes("front camera"));
});

check("empties the hands and forbids the mirror selfie — the first live roll was one", () => {
  // The first real generation came back as a wide, full-body mirror selfie with
  // a phone in her raised hand. This image is the identity reference the reel
  // re-renders from, so a phone in it becomes a phone where the mic should be.
  const p = buildPersonaPrompt({ spec: SPEC });
  assert.ok(p.includes("NOT a mirror selfie"));
  assert.ok(p.includes("she is holding nothing"));
  assert.ok(p.includes("no hand, arm or held object appears"));
  assert.ok(p.includes("MEDIUM-TIGHT PORTRAIT"));
});

check("framing is pinned BEFORE the camera, which is what invited the selfie", () => {
  const p = buildPersonaPrompt({ spec: SPEC, captureId: "phone-selfie" });
  assert.ok(p.indexOf(FRAMING_RULE) < p.indexOf("Shot on"), "framing must precede the camera");
});

check("the phone look does not imply anyone is holding the phone", () => {
  const p = buildPersonaPrompt({ spec: SPEC, captureId: "phone-selfie" });
  assert.ok(p.includes("PROPPED ON A SMALL STAND"));
  assert.equal(p.includes("held at arm's length"), false);
});

check("heritage is its own sentence, not wedged in front of the noun", () => {
  const out = describePersona({ ...SPEC, heritage: "English and Welsh, warm olive-toned complexion" });
  assert.ok(out.startsWith("A 34-year-old woman. English and Welsh, warm olive-toned complexion."), out.slice(0, 110));
});

check("the room is stated before the capture spec, so its light has somewhere to be", () => {
  const p = buildPersonaPrompt({ spec: SPEC, environment: "a warm cozy home with plants" });
  assert.ok(p.includes("a warm cozy home with plants"));
  assert.ok(p.indexOf("a warm cozy home") < p.indexOf("Shot on"), "room must precede the camera");
});

check("no room still puts them somewhere — a person nowhere is the cut-out look", () => {
  const p = buildPersonaPrompt({ spec: SPEC });
  assert.ok(p.includes("ordinary lived-in home interior"));
});

check("an empty spec is refused rather than sent as an empty prompt", () => {
  assert.throws(() => buildPersonaPrompt({ spec: coerceSpec({}) }), /empty/i);
});

console.log("\nbuildReferencedPersonaPrompt");

check("cites the attached photo and gives it a job — uncited, a model copies it", () => {
  const p = buildReferencedPersonaPrompt({ spec: SPEC });
  assert.ok(p.includes("TYPE REFERENCE"));
  assert.ok(p.includes("Do NOT copy the face"));
  assert.ok(p.includes("must be a DIFFERENT person"));
});

check("tells it what NOT to take beyond the face: background, framing, lighting", () => {
  const p = buildReferencedPersonaPrompt({ spec: SPEC });
  // The Avatar Narrator lost a room this exact way — the reference's own
  // background came along with the subject.
  assert.ok(p.includes("do not copy its background, its framing or its lighting"));
});

check("restates the framing LAST, because a photo beats an instruction given earlier", () => {
  const p = buildReferencedPersonaPrompt({ spec: SPEC });
  // Said once at the top, the framing lost to the reference's own wide seated
  // shot on a real roll. Assert it is repeated after the reference caveat.
  const caveat = p.indexOf("TYPE REFERENCE");
  assert.ok(p.lastIndexOf("MEDIUM-TIGHT PORTRAIT") > caveat, "framing must be restated after the caveat");
  assert.ok(p.includes("nothing about the attachment changes it"));
});

check("keeps the written description authoritative over the photo", () => {
  assert.ok(
    buildReferencedPersonaPrompt({ spec: SPEC }).includes("authoritative wherever the two disagree"),
  );
});

console.log("\nbuildRealismRefinePrompt");

check("locks identity BEFORE asking for anything — an edit that changes the face is the silent failure", () => {
  const p = buildRealismRefinePrompt();
  const lock = p.indexOf("KEEP THE PERSON EXACTLY");
  const ask = p.indexOf("Fix specifically");
  assert.ok(lock > -1 && ask > -1, "both halves must be present");
  assert.ok(lock < ask, "identity must be locked before the edit is asked for");
});

check("asks only about the photograph, never about who is in it", () => {
  const p = buildRealismRefinePrompt();
  assert.ok(p.includes("change nothing about WHO this is, only HOW IT WAS PHOTOGRAPHED"));
});

check("operator notes are appended without displacing the lock", () => {
  const p = buildRealismRefinePrompt("the light is too even");
  assert.ok(p.includes("Also: the light is too even."));
  assert.ok(p.indexOf("KEEP THE PERSON EXACTLY") < p.indexOf("Also:"));
});

console.log("\nbuildAvatarMapPrompt");

check("opens with the composition clause — image models weight early tokens hardest", () => {
  const p = buildAvatarMapPrompt();
  assert.ok(p.startsWith("A character reference sheet (an avatar map)"), p.slice(0, 80));
});

check("names all three panels: close-up, standing front full body, back view", () => {
  const p = buildAvatarMapPrompt();
  assert.equal(MAP_PANELS.length, 3);
  for (const panel of MAP_PANELS) assert.ok(p.includes(panel), "panel missing from the prompt");
  assert.ok(p.includes("PANEL 1") && p.includes("PANEL 2") && p.includes("PANEL 3"));
});

check("the back panel puts the head OUT OF FRAME, and says so twice", () => {
  // Three rolls to get this: "standing back view" is a strong prior, and
  // anchoring the panel to the full-body one ("the same view, cropped") kept
  // pulling the head back in. It is now described on its own terms and
  // repeated in the closing rules.
  const p = buildAvatarMapPrompt();
  assert.ok(p.includes("HER HEAD IS NOT IN THIS PANEL"));
  assert.ok(p.includes("RIGHT PANEL SHOWS NO HEAD AT ALL"));
});

check("never phrases the back panel as a body WITHOUT a head", () => {
  // The literal phrasing produces the literal thing, and is the kind of prompt
  // a safety filter refuses outright. It must always read as a CROP.
  const p = buildAvatarMapPrompt().toLowerCase();
  assert.equal(/body (missing|without) (its |a )?head/.test(p), false, "must not read as decapitation");
  assert.ok(p.includes("nothing is severed or injured"));
  assert.ok(p.includes("outside the crop"));
});

check("holds one identity across the panels and keeps every mouth closed", () => {
  const p = buildAvatarMapPrompt();
  assert.ok(p.includes("THE SAME PERSON IN EVERY PANEL"));
  assert.ok(p.includes("one person photographed three times, never three similar-looking people"));
  assert.ok(p.includes("MOUTH CLOSED"));
});

check("white seamless with flat even light — a map shot in a room poisons every later scene", () => {
  const p = buildAvatarMapPrompt();
  assert.ok(p.includes("pure white seamless studio background"));
  assert.ok(p.includes("No room, no furniture, no props"));
});

check("forbids the duplicate-figure and label failures sheets are prone to", () => {
  const p = buildAvatarMapPrompt();
  assert.ok(p.includes("Exactly one person in the image"));
  assert.ok(p.includes("no duplicate figures"));
  assert.ok(p.includes("no labels"));
});

console.log("\nbuildScenePrompt");

check("with a room photo, names both images and gives each a job", () => {
  const p = buildScenePrompt({ environment: "a cozy home", plate: true });
  assert.ok(p.includes("THE FIRST is a character reference sheet"));
  assert.ok(p.includes("THE SECOND is a photograph of the room"));
  assert.ok(p.includes("FROM THE ROOM PHOTOGRAPH take everything else, unchanged"));
});

check("without a room photo, describes the room instead of citing a second image", () => {
  const p = buildScenePrompt({ environment: "a cozy home with plants" });
  assert.equal(p.includes("THE SECOND"), false, "must not cite an image that was not sent");
  assert.ok(p.includes("THE ROOM: a cozy home with plants"));
});

check("refuses to take the sheet's white background into the scene", () => {
  // The sheet's white seamless is the most dominant thing in the reference,
  // and a model that copies it has thrown the room away.
  const p = buildScenePrompt({ environment: "a cozy home" });
  assert.ok(p.includes("not its white background, not its panels, not its flat studio lighting"));
});

check("the room's own light is the only light, and no rim light is allowed in", () => {
  const p = buildScenePrompt({ environment: "a cozy home" });
  assert.ok(p.includes("THE ROOM'S OWN LIGHT FALLS ON HER, and it is the only light"));
  assert.ok(p.includes("rim light"), "the rim light has to be refused by name");
  assert.ok(p.includes("Her exposure matches the room's"));
});

check("does not ask her to speak — the framing rule forbids the mouth it would open", () => {
  const p = buildScenePrompt({ environment: "a cozy home" });
  assert.equal(p.includes("about to speak"), false);
  assert.ok(p.includes("mouth closed") || p.includes("MOUTH CLOSED") || p.includes("Mouth closed"));
});

check("carries the framing rule, so the scene is a portrait and not a wide room shot", () => {
  const p = buildScenePrompt({ environment: "a cozy home" });
  assert.ok(p.includes("MEDIUM-TIGHT PORTRAIT"));
  assert.ok(p.includes("she is holding nothing"));
});

console.log("\nEngines and image input");

check("an unknown engine falls back to the inline-reference one", () => {
  assert.equal(findEngine("nope").id, PERSONA_ENGINES[0].id);
  assert.equal(findEngine(undefined).key, "gemini");
});

check("images are sniffed by magic number, not by what they claim to be", () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13])), "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])), "image/jpeg");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  assert.equal(sniffImage(webp), "image/webp");
  assert.equal(sniffImage(Buffer.from("not an image at all")), null);
});

check("readImageInput accepts a data: URL and a bare base64 alike", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]);
  const bare = png.toString("base64");
  assert.equal(readImageInput(bare).mimeType, "image/png");
  assert.equal(readImageInput(`data:image/png;base64,${bare}`).mimeType, "image/png");
});

check("a non-image is refused, whatever the data: URL claims", () => {
  const junk = Buffer.from("this is a text file").toString("base64");
  assert.throws(() => readImageInput(`data:image/png;base64,${junk}`), /not a PNG/);
  assert.throws(() => readImageInput(""), /required/);
});

console.log("\napimart response shapes");

check("finds the image URL wherever the gateway buries it", () => {
  assert.equal(
    firstImageUrl({ data: [{ url: "https://cdn.example.com/a.png" }] }),
    "https://cdn.example.com/a.png",
  );
  assert.equal(
    firstImageUrl({ result: { images: [{ image_url: "https://x.io/b.jpg?sig=1" }] } }),
    "https://x.io/b.jpg?sig=1",
  );
  assert.equal(firstImageUrl({ data: [{ url: "https://x.io/not-an-image" }] }), null);
});

check("prefers inline base64 when the gateway returns that instead", () => {
  const b64 = "A".repeat(200);
  assert.equal(firstBase64({ data: [{ b64_json: b64 }] }), b64);
  assert.equal(firstBase64({ data: [{ url: "https://x.io/a.png" }] }), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
