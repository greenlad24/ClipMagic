/**
 * Recorded recipes for Skool's editing UI.
 *
 * A recipe is an ordered list of steps the operator demonstrated once — hover
 * this, click that, type here — stored as ELEMENT DESCRIPTORS rather than
 * coordinates. Coordinates break the moment a card moves, a list gets longer,
 * or the window is a different size; a descriptor survives all three.
 *
 * ⚠️ REPLAY VERIFIES BEFORE IT CLICKS, and that is the point of the whole file.
 * The failure this guards against is not "the selector was not found" — that
 * one is loud and easy. It is the selector matching the WRONG element and the
 * click landing somewhere plausible, which is how the engagement tool's two
 * worst bugs happened, both found in production. So each step records several
 * handles, replay reports which one it used, and a step that can only be found
 * by its most volatile handle says so instead of quietly proceeding.
 */
import { db } from "../db/index.js";
import type { ElementDescriptor } from "./console.js";

export type StepKind = "hover" | "click" | "type" | "key" | "navigate" | "wait";

export interface RecipeStep {
  kind: StepKind;
  /** What the operator was asked to do, in their words. For the audit trail. */
  label: string;
  /** The element this step acts on. Absent for type/key/navigate/wait. */
  target?: ElementDescriptor;
  /** For `type`: the literal text, or a `{{placeholder}}` the write path fills. */
  text?: string;
  /** For `key`: the key name. For `navigate`: the URL. */
  value?: string;
  /** For `wait`: milliseconds. */
  ms?: number;
}

export interface Recipe {
  /** Stable action name — "newCourse", "editCourse", "addPage". */
  name: string;
  /** What this recipe does, for a human reading the list. */
  description: string;
  steps: RecipeStep[];
  updatedAt: number;
}

function toRecipe(row: any): Recipe | null {
  if (!row) return null;
  let steps: RecipeStep[] = [];
  try {
    steps = JSON.parse(row.steps_json || "[]");
  } catch {
    steps = [];
  }
  return {
    name: row.name,
    description: row.description ?? "",
    steps: Array.isArray(steps) ? steps : [],
    updatedAt: row.updated_at ?? 0,
  };
}

export function saveRecipe(name: string, description: string, steps: RecipeStep[]): Recipe | null {
  db.prepare(
    `INSERT INTO skool_recipes (name, description, steps_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET description = excluded.description,
                                     steps_json  = excluded.steps_json,
                                     updated_at  = excluded.updated_at`,
  ).run(name, description, JSON.stringify(steps), Date.now());
  return getRecipe(name);
}

export function getRecipe(name: string): Recipe | null {
  return toRecipe(db.prepare(`SELECT * FROM skool_recipes WHERE name = ?`).get(name));
}

export function listRecipes(): Recipe[] {
  return (db.prepare(`SELECT * FROM skool_recipes ORDER BY name`).all() as any[])
    .map(toRecipe)
    .filter((r): r is Recipe => r !== null);
}

export function deleteRecipe(name: string): void {
  db.prepare(`DELETE FROM skool_recipes WHERE name = ?`).run(name);
}

/**
 * How a descriptor was matched on replay, weakest last.
 *
 * Reported rather than hidden: a step that used to match on `testId` and now
 * matches on `path` is a step about to break, and that is worth knowing before
 * it writes to a live classroom rather than after.
 */
export type MatchHandle = "testId" | "ariaLabel" | "text" | "roleText" | "class" | "path" | null;

export interface ResolveResult {
  found: boolean;
  handle: MatchHandle;
  /** Centre of the matched element, in CSS pixels. */
  x: number;
  y: number;
  /** What the matched element actually says — for confirming it is the right one. */
  text: string;
  /** How many elements matched. More than one is ambiguity worth surfacing. */
  matches: number;
}

/**
 * The in-page resolver, as a string.
 *
 * It is shipped as source and evaluated in the page because it has to run in
 * the browser's DOM, and keeping it in one place means the write path and the
 * teach preview resolve identically — a preview that resolved differently from
 * the real thing would be worse than no preview.
 */
export const RESOLVER_SOURCE = `(desc) => {
  const doc = document;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();

  const attempts = [];
  if (desc.testId) attempts.push(["testId", Array.from(doc.querySelectorAll('[data-testid="' + desc.testId + '"]'))]);
  if (desc.ariaLabel) attempts.push(["ariaLabel", Array.from(doc.querySelectorAll('[aria-label="' + desc.ariaLabel + '"]'))]);
  if (desc.text) {
    const wanted = norm(desc.text);
    const all = Array.from(doc.querySelectorAll(desc.tag || "*"));
    // Exact text, not "contains": a container holding the label also contains
    // the words, and clicking a container does nothing.
    attempts.push(["text", all.filter((el) => norm(el.textContent) === wanted)]);
    if (desc.role) {
      attempts.push(["roleText", Array.from(doc.querySelectorAll('[role="' + desc.role + '"]')).filter((el) => norm(el.textContent) === wanted)]);
    }
  }
  if (desc.classes && desc.classes.length) {
    try {
      attempts.push(["class", Array.from(doc.querySelectorAll("." + CSS.escape(desc.classes[0])))]);
    } catch (e) { /* a class that cannot be escaped is simply skipped */ }
  }
  if (desc.path) {
    const tags = String(desc.path).split(">");
    const leaf = tags[tags.length - 1];
    attempts.push(["path", Array.from(doc.querySelectorAll(leaf))]);
  }

  for (const [handle, raw] of attempts) {
    const els = raw.filter(visible);
    if (els.length === 0) continue;
    // nth only disambiguates when the handle is one that counts repeats.
    const el = els.length > 1 && desc.nth < els.length ? els[desc.nth] : els[0];
    const r = el.getBoundingClientRect();
    return {
      found: true,
      handle,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      matches: els.length,
    };
  }
  return { found: false, handle: null, x: 0, y: 0, text: "", matches: 0 };
}`;
