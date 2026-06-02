import { continueRender, delayRender, staticFile } from "remotion";

/**
 * Load the bundled Montserrat faces (the SAME files the burned-in captions use,
 * in server/assets/fonts, copied into remotion/public/fonts) so motion graphics
 * match the video's typography exactly. We block the render with delayRender
 * until the faces are ready, so the first frames never fall back to a system
 * font (a common cause of "the title looks slightly off" auto-generated tells).
 */
let loaded = false;

export function loadFonts(): void {
  if (loaded || typeof document === "undefined") return;
  loaded = true;
  const handle = delayRender("Loading Montserrat faces");

  const faces: Array<{ family: string; weight: string; url: string }> = [
    { family: "Montserrat", weight: "800", url: staticFile("fonts/Mont-ExtraBold.ttf") },
    { family: "Montserrat", weight: "700", url: staticFile("fonts/Mont-SemiBoldItalic.ttf") },
  ];

  Promise.all(
    faces.map(async (f) => {
      const face = new FontFace(f.family, `url(${f.url})`, { weight: f.weight });
      await face.load();
      (document.fonts as FontFaceSet).add(face);
    }),
  )
    .then(() => continueRender(handle))
    // Never hang the render on a font hiccup — fall back to the system stack.
    .catch(() => continueRender(handle));
}
