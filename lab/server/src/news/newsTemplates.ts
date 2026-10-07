/**
 * The AI News deck templates (Jake, 2026-10-07: "the AI news presentation
 * templates should have different templates — minimalistic, beautiful but
 * different templates from the deep dives"). The design itself lives in the
 * web (src/news/daily/stage/newsTemplates.ts); the server only validates the
 * id stored on `news_decks.template`. A deck still holding a Deep Dive
 * template id (picked before 2026-10-07) is drawn in the default news template.
 */
export const NEWS_TEMPLATES = ["studio", "wire", "bulletin", "nightdesk", "lilac", "evergreen", "sandstone", "signal", "glacier", "ember"] as const;
export type NewsTemplateId = (typeof NEWS_TEMPLATES)[number];

export const isNewsTemplate = (v: unknown): v is NewsTemplateId => typeof v === "string" && (NEWS_TEMPLATES as readonly string[]).includes(v);

/** '' / null = the default; a known id = itself; anything else = undefined (reject). */
export function newsTemplateInput(v: unknown): string | undefined {
  if (v === "" || v === null) return "";
  return isNewsTemplate(v) ? v : undefined;
}
