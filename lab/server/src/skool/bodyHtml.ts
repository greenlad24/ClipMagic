/**
 * Turning an authored lesson body into structured HTML.
 *
 * The lessons were written as plain text: none of the 136 contains a markdown
 * heading. Structure is carried by conventions instead — a line fenced in
 * dashes, a line wrapped in `=== … ===`, a capitalised line, a run of `- `
 * bullets. Typing that into Skool produces a wall of paragraphs, because those
 * conventions mean nothing to a rich-text editor.
 *
 * Skool's editor builds real headings from PASTED HTML, so this module is where
 * the conventions become `<h1>`/`<h2>`/`<h3>`/`<ul>`/`<ol>`. Jake asked for the
 * organised format to survive the write; this is the whole of that promise.
 *
 * ⚠️ IT IS A HEURISTIC, AND HEURISTICS PROMOTE THE WRONG LINE. Every rule below
 * was chosen against the real corpus and the outline of every lesson is
 * previewable before anything is written — `renderOutline` exists for exactly
 * that. Prefer leaving a line as a paragraph over inventing a heading.
 */

/** A rule line: dashes, equals or underscores and nothing else. Decoration. */
const RULE = /^[-=_]{8,}$/;

/** `=== SECTION ===` — content between the fences, not a bare rule. */
const FENCED = /^={2,}\s*(\S.*?)\s*={2,}$/;

/** A capitalised line: no lowercase letters, long enough not to be an acronym. */
const CAPS = /^[A-Z0-9][A-Z0-9 '’",&.\-—:()\/?!]{5,}$/;

const BULLET = /^[-*•]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One block of a rendered lesson.
 *
 * Each variant carries a SINGLE literal `kind`, deliberately. Grouping them
 * (`kind: "ul" | "ol"`) reads more compactly and then does not narrow: checking
 * `b.kind === "ul"` cannot remove a member that might still be `"ol"`, so every
 * later branch still sees `items`-shaped blocks and `b.text` fails to compile.
 */
export type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "code"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

/** Markdown headings, once the lessons are authored with explicit structure. */
const MD_HEADING = /^(#{1,3})\s+(.*)$/;

/**
 * `[label](url)`, and `![alt](url)` for an image.
 *
 * The URL must be http(s): a relative or `javascript:` target has no business
 * arriving from a scraped body, and matching only absolute web URLs means a
 * prompt template containing `[SUBJECT] (something)` cannot be read as a link.
 */
const MD_LINK = /(!)?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

/** A fenced code block: ``` on its own line, opening and closing. */
const FENCE = /^\s*```/;

/**
 * Inline formatting inside a line of text.
 *
 * Jake, 2026-07-31: "all bolded principles (not titles) will be bolded" — so
 * `**like this**` becomes real `<strong>`, which is how a principle reads as a
 * principle rather than as one more sentence. Escaping happens FIRST: the
 * markers are matched against escaped text so a stray `<` in a lesson cannot
 * open a tag.
 */
function inline(s: string): string {
  return esc(s)
    // ⚠️ LINKS BEFORE THE OTHER MARKERS, and only ever on ESCAPED text. A body
    // imported from a Skool POST is mostly links — 208 of them across the 86
    // Community Resources posts, and the blueprint download is the whole point
    // of most of those pages. Without this the reader sees the literal
    // characters `[Make.com](http://Make.com)` and the resource is unreachable.
    // Bare URLs are deliberately NOT auto-linked: the authored lessons are full
    // of prose that mentions a domain, and turning those into anchors is a
    // change to 136 live pages nobody asked for.
    .replace(MD_LINK, (_m, bang: string | undefined, label: string, url: string) =>
      bang ? `<img src="${url}" alt="${label}">` : `<a href="${url}">${label || url}</a>`)
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^`])`([^`]+)`/g, "$1<code>$2</code>");
}

/**
 * Parse the body into blocks.
 *
 * Two decisions carry most of the weight:
 *
 * 1. **A numbered line is a heading only when it stands alone.** In "25
 *    Advanced ChatGPT Features" each feature is a numbered section header with
 *    prose beneath it; in another lesson four consecutive numbered lines are
 *    genuinely a list. Run length tells them apart, and it also keeps siblings
 *    consistent: `3. CUSTOM INSTRUCTIONS (set once, applies forever)` is not
 *    capitalised, so a caps-only rule would have made it a list item while its
 *    fourteen siblings became headings.
 *
 * 2. **Fenced and rule-wrapped lines outrank capitalisation.** A line the author
 *    deliberately decorated is a section (h2); a merely capitalised line is a
 *    lesser one (h3). That ordering means shouting inside a paragraph cannot
 *    outrank a real section break.
 */
export function parseBody(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];

  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };

  let firstHeadingDone = false;
  const heading = (level: "h2" | "h3", t: string) => {
    flushPara();
    // The first structural line of a lesson is its title — h1, once.
    blocks.push({ kind: blocks.length === 0 && !firstHeadingDone ? "h1" : level, text: t });
    firstHeadingDone = true;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // ⚠️ A FENCED BLOCK IS COPIED VERBATIM, INCLUDING ITS BLANK LINES. Jake:
    // "all prompt templates or full prompts will be in a code block." A prompt
    // template is the one thing on the page a member will select and copy, so
    // its line breaks and its [BRACKETS] are the content — reflowing it into a
    // paragraph, or letting `**` inside it turn bold, would ruin the thing it
    // is there to be.
    if (FENCE.test(line)) {
      flushPara();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !FENCE.test(lines[j].trim()); j++) body.push(lines[j]);
      blocks.push({ kind: "code", text: body.join("\n") });
      i = j; // past the closing fence
      continue;
    }

    if (!line) {
      flushPara();
      continue;
    }

    // Explicit markdown wins over every convention below it: once a lesson is
    // authored with real headings there is nothing left to infer.
    const md = line.match(MD_HEADING);
    if (md) {
      flushPara();
      const level = md[1].length === 1 ? "h1" : md[1].length === 2 ? "h2" : "h3";
      blocks.push({ kind: level as "h1" | "h2" | "h3", text: md[2] });
      firstHeadingDone = true;
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      continue; // decoration; the line it fences is handled on its own turn
    }

    const fenced = line.match(FENCED);
    if (fenced) {
      heading("h2", fenced[1]);
      continue;
    }

    // Wrapped in rule lines above or below → a section the author marked out.
    const above = (lines[i - 1] ?? "").trim();
    const below = (lines[i + 1] ?? "").trim();
    if ((RULE.test(above) || RULE.test(below)) && !BULLET.test(line)) {
      heading("h2", line);
      continue;
    }

    // Runs of bullets / numbers become lists; a lone numbered line is a header.
    const asBullet = line.match(BULLET);
    if (asBullet) {
      flushPara();
      const items: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = lines[j].trim().match(BULLET);
        if (!m) break;
        items.push(m[1]);
      }
      blocks.push({ kind: "ul", items });
      i = j - 1;
      continue;
    }

    const asNumber = line.match(NUMBERED);
    if (asNumber) {
      const items: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = lines[j].trim().match(NUMBERED);
        if (!m) break;
        items.push(m[1]);
      }
      if (items.length >= 2) {
        flushPara();
        blocks.push({ kind: "ol", items });
        i = j - 1;
      } else {
        heading("h3", line);
      }
      continue;
    }

    if (CAPS.test(line)) {
      heading("h3", line);
      continue;
    }

    para.push(line);
  }
  flushPara();
  return blocks;
}

/**
 * Drop a lesson's own title line from the top of its body.
 *
 * ⚠️ SKOOL ALREADY RENDERS THE PAGE TITLE. A body that opens with `# Prompting
 * Google Gemini` therefore shows it twice, one line apart, which is the first
 * thing Jake noticed on an otherwise finished page. Stripped here rather than
 * left to the prompt: every future author would have to remember, and one
 * forgetting means a page that has to be rewritten.
 *
 * Only a LEADING `#` heading goes — a `#` further down is a section the author
 * meant, and headings inside a fenced template are not headings at all.
 */
export function stripLeadingTitle(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return text;
  if (!/^#\s+\S/.test(lines[i].trim())) return text;
  lines.splice(0, i + 1);
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.join("\n");
}

/** Render ONE block, so a body can be pasted a block at a time. */
export function blockToHtml(b: Block): string {
  if (b.kind === "ul" || b.kind === "ol") {
    return `<${b.kind}>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${b.kind}>`;
  }
  // esc, never inline(): inside a template `**` and backticks are literal.
  // ⚠️ `<pre>` ALONE, NOT `<pre><code>`. A single paste of a whole lesson
  // truncated at the first `<pre><code>` — title, first heading, first template,
  // then nothing — so the nested form is what the editor chokes on. `<pre>` keeps
  // the line breaks, which is the part a member copying a prompt depends on.
  if (b.kind === "code") return `<pre>${esc(b.text)}</pre>`;
  return `<${b.kind}>${inline(b.text)}</${b.kind}>`;
}

/** How many headings and code blocks a body asks for — the target to verify against. */
export function wantedStructure(text: string): { headings: number; code: number } {
  const blocks = parseBody(text);
  return {
    headings: blocks.filter((b) => b.kind === "h1" || b.kind === "h2" || b.kind === "h3").length,
    code: blocks.filter((b) => b.kind === "code").length,
  };
}

/** Render blocks as the HTML that goes on the clipboard. */
export function bodyToHtml(text: string): string {
  const out: string[] = [];
  for (const b of parseBody(text)) {
    if (b.kind === "ul" || b.kind === "ol") {
      out.push(`<${b.kind}>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${b.kind}>`);
    } else if (b.kind === "code") {
      // esc, never inline(): inside a template `**` and backticks are literal.
      out.push(blockToHtml(b)); // one renderer for code, so the two cannot drift
    } else if (b.kind === "h1" || b.kind === "h2" || b.kind === "h3" || b.kind === "p") {
      out.push(`<${b.kind}>${inline(b.text)}</${b.kind}>`);
    }
  }
  return out.join("\n");
}

/**
 * Roughly how many characters a body will PUT ON SCREEN.
 *
 * ⚠️ NOT `text.length`. A paste is verified by how far the editor's character
 * count moved, and link syntax is source characters that render to little or
 * nothing: `[label](url)` shows only the label, and `![alt](url)` shows no text
 * at all. One imported page carrying eight images measured at 0.52 of its
 * source length — under the 0.6 floor — so a complete, correct paste would have
 * been rejected as truncated, and the retry would have failed the same way
 * forever. Lives beside MD_LINK so the two cannot drift apart.
 *
 * A body with no links is unchanged by this, which is every authored lesson.
 */
export function visibleLength(text: string): number {
  return text.replace(MD_LINK, (_m, bang: string | undefined, label: string) => (bang ? "" : label)).length;
}

/** How many headings the HTML carries, so a paste can be checked for structure. */
export function headingCount(text: string): number {
  return parseBody(text).filter((b) => b.kind === "h1" || b.kind === "h2" || b.kind === "h3").length;
}

/** A human-readable outline, for eyeballing the promotions before writing. */
export function renderOutline(text: string): string {
  return parseBody(text)
    .map((b) => {
      if (b.kind === "ul") return `      • list of ${b.items.length}`;
      if (b.kind === "ol") return `      1. numbered list of ${b.items.length}`;
      if (b.kind === "code") return `      [code block, ${b.text.split("\n").length} lines]`;
      if (b.kind === "p") return `      ¶ ${b.text.slice(0, 58)}`;
      if (b.kind === "h1") return `${b.text.slice(0, 60)}`.replace(/^/, "H1 ");
      const indent = b.kind === "h2" ? "  " : "    ";
      return `${indent}${b.kind.toUpperCase()} ${b.text.slice(0, 60)}`;
    })
    .join("\n");
}
