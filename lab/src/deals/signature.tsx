/**
 * Jake's email footer (Jake 2026-10-01): it must ALWAYS read
 *   Best regards, / Jake Dawson / Website / Email / YouTube / Partner
 * with each link ON the word, never "Website <https://…>" next to it.
 * Drafts store the footer as "Label <url>" lines (that's how the server turns
 * them into <a href>Label</a> in the Gmail HTML part); these helpers render it
 * that way in the Lab and keep it out of the editable text.
 */
import type { ReactNode } from 'react';

const LINK_LINE = /^\s*([A-Za-z][A-Za-z ]{0,30}) <((?:https?:\/\/|mailto:)[^\s>]+|[\w.+-]+@[\w.-]+\.\w+)>\s*$/;
const SIGN_OFF = /^\s*(best regards|best|regards|kind regards|thanks|thank you|cheers),?\s*$/i;

const hrefOf = (target: string) => (/^(https?:|mailto:)/.test(target) ? target : `mailto:${target}`);

/** Split a draft into the editable body and its trailing footer ("" when there is none). */
export function splitSignature(text: string): { body: string; signature: string } {
  const lines = text.replace(/\s+$/, '').split('\n');
  let i = lines.length;
  while (i > 0 && LINK_LINE.test(lines[i - 1])) i--;
  if (i === lines.length) return { body: text, signature: '' };
  // Include "Jake Dawson" and the sign-off line above the links.
  for (let k = 0; k < 2 && i > 0; k++) {
    const l = lines[i - 1].trim();
    if (!l || l.length > 40) break;
    i--;
    if (SIGN_OFF.test(l)) break;
  }
  return { body: lines.slice(0, i).join('\n').replace(/\s+$/, ''), signature: lines.slice(i).join('\n') };
}

/** Render text with every "Label <url>" line shown as the label, linked. */
export function LinkedText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  text.split('\n').forEach((line, i) => {
    if (i) out.push('\n');
    const m = line.match(LINK_LINE);
    out.push(m ? <a key={i} href={hrefOf(m[2])} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{m[1]}</a> : line);
  });
  return <>{out}</>;
}

/** The footer shown under an editable draft: added automatically when the draft is saved. */
export function SignatureFooter({ signature }: { signature: string }) {
  if (!signature) return null;
  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90 px-3">
      <LinkedText text={signature} />
      <p className="text-[10px] text-muted-foreground mt-1">Signature added automatically when saved</p>
    </div>
  );
}
