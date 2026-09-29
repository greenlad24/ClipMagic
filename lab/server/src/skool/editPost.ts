/**
 * Append a paragraph to a post that is already published.
 *
 * Jake, 2026-09-28: "update the latest posts with the new links to each
 * lesson's page" — the new-video announcements went out before their classroom
 * pages existed, so they link the video and older lessons but not the lesson
 * built from the video itself.
 *
 * APPEND ONLY. The existing body is never cleared or retyped: `appendBody`
 * sends the caret to the end of the document and pastes there, so the worst a
 * failure can do is leave the edit unsaved. Mapped live 2026-09-28: the post's
 * "•••" (next to the bell, rightmost text-less control above the title) →
 * "Edit" → the post turns into an inline editor → SAVE (greyed out until the
 * body changes) / CANCEL.
 *
 * Verified from Skool's payload afterwards, not from the SAVE click: the new
 * link must be in the body AND the original body must still be there — an edit
 * that "worked" by replacing the post would pass the first check alone.
 *
 * Editing does not re-email members; only a new post with the email switch does.
 */
import { withSkoolPage } from "./browser.js";
import { appendBody, chooseMenuItem, clickButton, focusBody, type ActionResult } from "./actions.js";
import { readPost } from "./community.js";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The post's own "•••": rightmost small text-less control above its title. */
async function openPostMenu(title: string): Promise<ActionResult> {
  const spot = (await withSkoolPage(async (page) =>
    page.evaluate((wanted: string) => {
      const doc: any = (globalThis as any).document;
      const win: any = globalThis;
      const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
      const heads = (Array.from(doc.querySelectorAll("*")) as any[]).filter(
        (e) => norm(e.textContent) === norm(wanted) && e.getBoundingClientRect().height > 0,
      );
      heads.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      const head = heads[0];
      if (!head) return { ok: false, why: "the post title is not on the page" };
      const h = head.getBoundingClientRect();
      const btns = (Array.from(doc.querySelectorAll("*")) as any[]).filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 20 || r.width > 56 || r.height < 20 || r.height > 56) return false;
        if (norm(e.textContent) !== "") return false;
        if (win.getComputedStyle?.(e)?.cursor !== "pointer" && e.tagName !== "BUTTON") return false;
        // Same card: above the title by at most ~80px, and within its column.
        return r.bottom <= h.top + 4 && r.top >= h.top - 90 && r.left >= h.left && r.left <= h.left + 760;
      });
      btns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      const b = btns[0];
      if (!b) return { ok: false, why: "no menu button beside the title" };
      const r = b.getBoundingClientRect();
      return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, title),
  )) as { ok: boolean; x?: number; y?: number; why?: string } | null;
  if (!spot?.ok) return { ok: false, detail: `Could not open the post's menu: ${spot?.why ?? "browser unavailable"}.` };
  await withSkoolPage(async (page) => page.mouse.click(spot.x!, spot.y!, { delay: 40 }));
  await settle(900);
  return { ok: true, detail: "Opened the post's menu." };
}

export interface AppendResult {
  ok: boolean;
  detail: string;
  steps: string[];
  image?: string;
}

export async function appendToPost(
  communityUrl: string,
  slug: string,
  text: string,
  opts: { dryRun?: boolean; mustContain?: string } = {},
): Promise<AppendResult> {
  const steps: string[] = [];
  const fail = (d: string): AppendResult => ({ ok: false, detail: d, steps });

  // Also navigates to the post, which is where the edit happens.
  const before = await readPost(communityUrl, slug);
  if (!before.post) return fail(`Could not read the post: ${before.error ?? "no post"}`);
  if (!before.post.byMe) return fail("That post is not ours — refusing to edit it.");
  const marker = opts.mustContain ?? "";
  if (marker && before.post.body.includes(marker)) {
    return { ok: true, detail: "Already carries that link — left alone.", steps };
  }
  steps.push(`Read "${before.post.title}" (${before.post.body.length} chars)`);

  for (const s of [
    () => openPostMenu(before.post!.title),
    () => chooseMenuItem("Edit"),
  ]) {
    const r = await s();
    steps.push(r.detail);
    if (!r.ok) return fail(r.detail);
  }
  await settle(800);

  // A new empty paragraph at the end first, so the paste cannot merge into the
  // last sentence. `appendBody` then focuses and goes to the end again — which
  // is now this empty paragraph.
  if (!(await focusBody())) {
    await clickButton("Cancel");
    return fail("The post's editor did not open.");
  }
  await withSkoolPage(async (page) => {
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    // Two: the posts separate paragraphs with an empty one (measured in the
    // editor), and a single newline inside a paste is collapsed.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
  });
  // One paste per line with a real Enter between them, so "…copy:" and the
  // link sit on separate lines the way "Watch it here:" + link do.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await withSkoolPage(async (page) => page.keyboard.press("Enter"));
    if (!lines[i].trim()) continue;
    const written = await appendBody(lines[i]);
    steps.push(written.detail);
    if (!written.ok) {
      await clickButton("Cancel");
      return fail(written.detail);
    }
  }

  if (opts.dryRun) {
    const image = (await withSkoolPage(async (page) =>
      Buffer.from(await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64"),
    )) as string | null;
    const c = await clickButton("Cancel");
    steps.push(`Dry run — ${c.detail}`);
    return { ok: true, detail: "Dry run: appended in the editor, then cancelled. Nothing saved.", steps, image: image ?? undefined };
  }

  const saved = await clickButton("SAVE");
  steps.push(saved.detail);
  if (!saved.ok) return fail(saved.detail);
  await settle(2000);

  const after = await readPost(communityUrl, slug);
  const body = after.post?.body ?? "";
  const keptStart = body.startsWith(before.post.body.slice(0, 80));
  const hasNew = marker ? body.includes(marker) : body.length > before.post.body.length;
  steps.push(`Read back: ${body.length} chars (was ${before.post.body.length})`);
  if (!hasNew) return fail("Saved, but the new text is not in the post afterwards.");
  if (!keptStart || body.length < before.post.body.length) {
    return fail("⚠️ Saved, but the original body did not survive intact — check the post by hand.");
  }
  return { ok: true, detail: "Appended and verified from the post itself.", steps };
}
