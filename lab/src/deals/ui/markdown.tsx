/**
 * Deal Organizer — Markdown renderer for chat answers.
 *
 * The original used the shared `Markdown` component (react-markdown +
 * remark-gfm + @tailwindcss/typography `prose`). None of those are installed
 * in the Lab, so this is a small GFM subset rendered straight to React
 * elements (no innerHTML): headings, paragraphs, **bold**, *italic*,
 * ~~strike~~, `code`, fenced code, [links](…), bare URLs, ordered/unordered
 * (nested) lists, task boxes, blockquotes, tables, horizontal rules and
 * <mark>…</mark>. Styling lives in markdown.css under `.prose`.
 */
import { Fragment, type ReactNode } from 'react';
import { cn } from './utils';
import './markdown.css';

// ── Inline ──────────────────────────────────────────────────────────────────
const INLINE = /(`[^`]+`)|(\*\*[^*]+?\*\*|__[^_]+?__)|(~~[^~]+?~~)|(<mark>[\s\S]+?<\/mark>)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*]*?\*|_[^_\s][^_]*?_)/;

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<del key={k}>{inline(tok.slice(2, -2), k)}</del>);
    else if (m[4]) out.push(<mark key={k}>{inline(tok.slice(6, -7), k)}</mark>);
    else if (m[5]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = /^(https?:|mailto:)/i.test(lm[2]) ? lm[2] : undefined;
      out.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer">{inline(lm[1], k)}</a>);
    } else if (m[6]) out.push(<a key={k} href={tok} target="_blank" rel="noopener noreferrer">{tok}</a>);
    else if (m[7]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

// ── Blocks ──────────────────────────────────────────────────────────────────
type ListItem = { text: string; children: string[] };

function parseList(lines: string[], key: string): ReactNode {
  const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[0])!;
  const ordered = /\d/.test(first[2]);
  const baseIndent = first[1].length;
  const items: ListItem[] = [];
  for (const line of lines) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (m && m[1].length <= baseIndent) items.push({ text: m[3], children: [] });
    else if (items.length) items[items.length - 1].children.push(line.slice(Math.min(baseIndent + 2, line.length - line.trimStart().length)));
  }
  const Tag = ordered ? 'ol' : 'ul';
  const start = ordered ? parseInt(first[2], 10) : undefined;
  return (
    <Tag key={key} start={start && start !== 1 ? start : undefined}>
      {items.map((it, i) => {
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(it.text);
        return (
          <li key={i}>
            {task ? <><input type="checkbox" checked={task[1] !== ' '} readOnly disabled className="mr-1.5 align-middle" />{inline(task[2], `${key}-${i}`)}</> : inline(it.text, `${key}-${i}`)}
            {it.children.some((c) => c.trim()) && blocks(it.children, `${key}-${i}c`)}
          </li>
        );
      })}
    </Tag>
  );
}

const splitRow = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function blocks(lines: string[], key = 'b'): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const isList = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    const k = `${key}-${n++}`;
    if (!line.trim()) { i++; continue; }
    // fenced code
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(<pre key={k}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const Tag = `h${h[1].length}` as 'h1';
      out.push(<Tag key={k}>{inline(h[2], k)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(<hr key={k} />); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={k}>{blocks(body, k)}</blockquote>);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : undefined));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(
        <div key={k} className="overflow-x-auto">
          <table>
            <thead><tr>{head.map((c, j) => <th key={j} style={{ textAlign: aligns[j] }}>{inline(c, `${k}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j} style={{ textAlign: aligns[j] }}>{inline(r[j] ?? '', `${k}r${ri}${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (isList(line)) {
      const body: string[] = [];
      while (i < lines.length && (isList(lines[i]) || /^\s{2,}\S/.test(lines[i]) || (!lines[i].trim() && i + 1 < lines.length && (isList(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))))) {
        body.push(lines[i++]);
      }
      out.push(parseList(body.filter((l) => l.trim()), k));
      continue;
    }
    // paragraph
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|>|```|~~~)/.test(lines[i]) && !isList(lines[i])) para.push(lines[i++]);
    if (!para.length) { para.push(lines[i++]); }
    out.push(
      <p key={k}>
        {para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p.replace(/\s{2,}$/, ''), `${k}-${j}`)}</Fragment>)}
      </p>,
    );
  }
  return out;
}

interface MarkdownProps {
  /** The markdown string to render. */
  children: string;
  /** Additional class names merged onto the prose wrapper. */
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return <div className={cn('prose max-w-none', className)}>{blocks(String(children ?? '').replace(/\r\n?/g, '\n').split('\n'))}</div>;
}

export default Markdown;
