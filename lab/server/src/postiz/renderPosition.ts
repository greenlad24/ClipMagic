/**
 * Shooting POSITION of a server render — the "T number".
 *
 * Jake shoots a batch of clips in one physical setup (a "position"), then moves
 * the camera and shoots the next batch. The source clips carry that setup in
 * their filename:
 *
 *   1787137810947_T7__253_Entry-Level_Squeeze.mp4
 *                 ^^ position 7
 *
 * A finished render loses that name — outputs are nanoids (`881WCnpAO8Nd….mp4`)
 * — so the position has to be recovered through the project that produced it:
 *
 *   z_projects.outputUrl  →  /api/outputs/<render>.mp4     (which render it made)
 *   z_projects.narrationUrl / videoChunksJson → /api/uploads/<fileId>
 *   files.original        →  the uploaded source filename  (which carries "T7")
 *
 * This matters because the drop sequencer's whole job is to keep two clips of
 * the same look off consecutive slots, and it derived "look" from the OUTPUT
 * filename — which for nanoid renders makes every clip its own look and the rule
 * vacuous. The position is the real grouping: two clips shot in the same setup
 * look near-identical in the feed, whatever they say.
 *
 * The pure parsing half is separated from the DB half so it can be unit-tested.
 */

/** Group key for a render whose position could not be recovered. */
export const POSITION_UNKNOWN = "no-position";

/**
 * Pull the position key out of an uploaded source filename. Matches a `T<n>`
 * token delimited by a separator (or the string edges), so it never fires on the
 * "T" inside a word. Returns "" when there is no position token.
 *
 * Examples:
 *   "1787137810947_T7__253_Entry-Level_Squeeze.mp4" → "t7"
 *   "T12 - hook.mp4"                                → "t12"
 *   "Entry-Level_Squeeze.mp4"                       → ""       (no token)
 *   "T-Shaped_Skills.mp4"                           → ""       (no digits)
 */
export function positionKeyFromOriginal(original: string | null | undefined): string {
  const name = String(original ?? "").trim();
  if (!name) return "";
  const m = name.match(/(?:^|[_\-. ])T(\d{1,3})(?:[_\-. ]|$)/i);
  return m ? `t${Number(m[1])}` : "";
}
