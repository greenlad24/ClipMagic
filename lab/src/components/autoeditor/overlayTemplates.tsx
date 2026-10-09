import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The Auto Editor's overlay templates — human names, one-line descriptions and tiny
 * previews. The ids are the planner's (aieditor/director.py OVERLAY_TEMPLATES) plus the
 * six motion-design templates, which all live in the HOOK zone.
 *
 * Previews are self-contained CSS (no assets, no network) and stand still under
 * prefers-reduced-motion: every element's base style is its final, readable state and
 * the keyframes only run when motion is allowed.
 */

export type OverlayTemplateId =
  | 'lower_title'
  | 'link'
  | 'subscribe'
  | 'socials'
  | 'keyword'
  | 'list'
  | 'number'
  | 'question'
  | 'verb_swap'
  | 'tagline_build'
  | 'prompt_menu'
  | 'prompt_card_3d'
  | 'prompt_result'
  | 'prompt_highlight';

export interface OverlayTemplateInfo {
  id: OverlayTemplateId;
  name: string;
  description: string;
  /** where the planner may place it; undefined = anywhere on the A-roll */
  zone?: 'hook';
  /** one of the six motion-design templates */
  motion?: boolean;
  /** shows a prompt box → drawn in the real app's UI kit */
  promptBox?: boolean;
}

export const PROMPT_KIT_NOTE =
  "Prompt boxes use the real app's UI kit (ChatGPT, Claude…) — or a neutral box when the app has no kit.";

/** Mirrors aieditor rules.json motion_templates.enabled: the motion templates stay hidden until Jake approves them. */
export const MOTION_TEMPLATES_ENABLED = false;

export const OVERLAY_TEMPLATES: OverlayTemplateInfo[] = [
  { id: 'lower_title', name: 'Lower title', description: 'White text, lower centre, 1–2 short lines — the intro and a section’s opening line.' },
  { id: 'link', name: 'Link', description: '“Link in the description” — only when the speaker points to a link.' },
  { id: 'subscribe', name: 'Subscribe', description: 'The animated SUBSCRIBE → SUBSCRIBED button — only when the speaker asks.' },
  { id: 'socials', name: 'Socials', description: 'TikTok + Instagram icons — only when the speaker mentions following there.' },
  { id: 'keyword', name: 'Keyword', description: 'A punchy phrase the speaker says, line 2 in the accent — hook and punchlines.' },
  { id: 'list', name: 'List', description: '2–4 short items the speaker enumerates, anchored on the first one.' },
  { id: 'number', name: 'Number', description: 'A figure the speaker says, with label, prefix and suffix.' },
  { id: 'question', name: 'Question', description: 'The viewer question of the outro, as a lower-title line.' },
  {
    id: 'verb_swap', name: 'Verb swap', zone: 'hook', motion: true,
    description: '“Grok Bot can now <verb> X” on white — the verb rolls and swaps, each verb in its own colour.',
  },
  {
    id: 'tagline_build', name: 'Tagline build', zone: 'hook', motion: true,
    description: '“Every agent. One inbox.” word by word on a light-grey grid; blue dots settle as selection handles; a black bar wipes out.',
  },
  {
    id: 'prompt_menu', name: 'Prompt menu', zone: 'hook', motion: true, promptBox: true,
    description: 'A light composer opens its “/” Skills menu; the cursor hovers down the rows, picks one, and the menu folds back in.',
  },
  {
    id: 'prompt_card_3d', name: '3D prompt card', zone: 'hook', motion: true, promptBox: true,
    description: 'A tilted frosted prompt card on soft grey — the prompt types in, file chips fly in, the state turns “Working”.',
  },
  {
    id: 'prompt_result', name: 'Prompt → result (hook)', zone: 'hook', motion: true, promptBox: true,
    description: 'The 3D prompt card, then the app’s REAL result — hook only, the first ~40 s.',
  },
  {
    id: 'prompt_highlight', name: 'Prompt highlight', zone: 'hook', motion: true, promptBox: true,
    description: 'The app’s real prompt box while the camera pushes in and the prompt types; yellow marker sweeps the key phrases as they are said.',
  },
];

const BY_ID = new Map<string, OverlayTemplateInfo>(OVERLAY_TEMPLATES.map((t) => [t.id, t]));

export function overlayTemplate(id: string | null | undefined): OverlayTemplateInfo | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Human name for a plan's template id; unknown ids fall back to the raw id. */
export function overlayName(id: string | null | undefined): string {
  return overlayTemplate(id)?.name ?? String(id ?? '');
}

// ---------------------------------------------------------------- previews

const BLUE = '#1E88E5';
const ORANGE = '#FB8C00';
const GREEN = '#43A047';

/** one keyframe that fades a word in at `a`% and out at the end of the loop */
const wordIn = (name: string, a: number) =>
  `@keyframes ${name}{0%,${a}%{opacity:0;transform:translateY(3px)}${a + 7}%,82%{opacity:1;transform:none}90%,100%{opacity:0;transform:none}}`;

const CSS = `
.ovp{position:relative;width:112px;height:63px;overflow:hidden;border-radius:6px;flex:none;
  font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1;color:#111;
  box-shadow:inset 0 0 0 1px rgba(127,127,127,.25)}
.ovp *{box-sizing:border-box}
.ovp-abs{position:absolute}

/* verb swap */
.ovp-verbs{animation:ovp-verbs 4.5s cubic-bezier(.7,0,.2,1) infinite}
@keyframes ovp-verbs{0%,26%{transform:translateY(0)}33%,59%{transform:translateY(-10px)}66%,92%{transform:translateY(-20px)}100%{transform:translateY(-30px)}}

/* tagline build */
${wordIn('ovp-w1', 4)}${wordIn('ovp-w2', 14)}${wordIn('ovp-w3', 26)}${wordIn('ovp-w4', 36)}
.ovp-w1{animation:ovp-w1 4.5s ease-out infinite}.ovp-w2{animation:ovp-w2 4.5s ease-out infinite}
.ovp-w3{animation:ovp-w3 4.5s ease-out infinite}.ovp-w4{animation:ovp-w4 4.5s ease-out infinite}
.ovp-dot{animation:ovp-dot 4.5s cubic-bezier(.2,.8,.2,1) infinite}
@keyframes ovp-dot{0%,44%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.4)}56%,84%{opacity:1;transform:none}90%,100%{opacity:0;transform:none}}
.ovp-sel{animation:ovp-sel 4.5s ease-out infinite}
@keyframes ovp-sel{0%,52%{opacity:0}60%,84%{opacity:1}90%,100%{opacity:0}}
.ovp-bar{transform-origin:left center;transform:scaleX(0);animation:ovp-bar 4.5s cubic-bezier(.7,0,.3,1) infinite}
@keyframes ovp-bar{0%,80%{transform:scaleX(0)}92%,100%{transform:scaleX(1)}}

/* prompt menu */
.ovp-menu{transform-origin:left bottom;animation:ovp-menu 4.5s cubic-bezier(.6,0,.3,1) infinite}
@keyframes ovp-menu{0%,4%{opacity:0;transform:scaleY(.4)}12%,68%{opacity:1;transform:none}78%,100%{opacity:0;transform:scaleY(0)}}
.ovp-hi{transform:translateY(16px);animation:ovp-hi 4.5s ease-in-out infinite}
@keyframes ovp-hi{0%,18%{transform:translateY(0);background:#EEF0F3}28%,38%{transform:translateY(8px);background:#EEF0F3}48%,56%{transform:translateY(16px);background:#EEF0F3}60%,100%{transform:translateY(16px);background:#DCEBFB}}
.ovp-cur{transform:translate(0,16px);animation:ovp-cur 4.5s ease-in-out infinite}
@keyframes ovp-cur{0%,10%{opacity:0;transform:translate(12px,-6px)}18%{opacity:1;transform:translate(0,0)}28%,38%{transform:translate(0,8px)}48%,66%{opacity:1;transform:translate(0,16px)}74%,100%{opacity:0;transform:translate(0,16px)}}
.ovp-pick{animation:ovp-pick 4.5s ease-out infinite}
@keyframes ovp-pick{0%,74%{opacity:0;transform:translateX(-3px)}82%,96%{opacity:1;transform:none}100%{opacity:0;transform:none}}
.ovp-slash{opacity:0;animation:ovp-slash 4.5s steps(1) infinite}
@keyframes ovp-slash{0%,74%{opacity:1}75%,100%{opacity:0}}

/* 3D prompt card (also the first half of prompt -> result) */
.ovp-type{width:50px;animation:ovp-type var(--d,4.5s) steps(18) infinite}
@keyframes ovp-type{0%,6%{width:0}40%,100%{width:50px}}
.ovp-chip1{animation:ovp-chip1 var(--d,4.5s) cubic-bezier(.2,.9,.3,1.2) infinite}
.ovp-chip2{animation:ovp-chip2 var(--d,4.5s) cubic-bezier(.2,.9,.3,1.2) infinite}
@keyframes ovp-chip1{0%,42%{opacity:0;transform:translate(30px,-18px) rotate(12deg)}52%,100%{opacity:1;transform:none}}
@keyframes ovp-chip2{0%,48%{opacity:0;transform:translate(26px,-22px) rotate(-10deg)}58%,100%{opacity:1;transform:none}}
.ovp-send{opacity:0;animation:ovp-send var(--d,4.5s) steps(1) infinite}
@keyframes ovp-send{0%,64%{opacity:1}65%,100%{opacity:0}}
.ovp-work{animation:ovp-work var(--d,4.5s) steps(1) infinite}
@keyframes ovp-work{0%,64%{opacity:0}65%,100%{opacity:1}}
.ovp-pulse{animation:ovp-pulse .9s ease-in-out infinite}
@keyframes ovp-pulse{0%,100%{opacity:.35}50%{opacity:1}}

/* prompt -> result */
.ovp-result{animation:ovp-result 6s cubic-bezier(.6,0,.2,1) infinite}
@keyframes ovp-result{0%,70%{transform:translateY(105%)}78%,96%{transform:none}100%{transform:translateY(105%)}}

/* prompt highlight */
.ovp-push{animation:ovp-push 5s cubic-bezier(.4,0,.2,1) infinite}
@keyframes ovp-push{0%{transform:scale(1)}85%,100%{transform:scale(1.22)}}
.ovp-type2{width:74px;animation:ovp-type2 5s steps(26) infinite}
@keyframes ovp-type2{0%,4%{width:0}38%,100%{width:74px}}
.ovp-mark{background-image:linear-gradient(#FFE14D,#FFE14D);background-repeat:no-repeat;background-position:left center;
  background-size:100% 78%}
.ovp-mark1{animation:ovp-mark1 5s ease-out infinite}.ovp-mark2{animation:ovp-mark2 5s ease-out infinite}
@keyframes ovp-mark1{0%,42%{background-size:0% 78%}52%,100%{background-size:100% 78%}}
@keyframes ovp-mark2{0%,60%{background-size:0% 78%}70%,100%{background-size:100% 78%}}

@media (prefers-reduced-motion:reduce){.ovp,.ovp *{animation:none!important}}
`;

const abs = (s: CSSProperties): CSSProperties => ({ position: 'absolute', ...s });

function Frame({ bg, children, style }: { bg: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="ovp" style={{ background: bg, ...style }} aria-hidden>
      {children}
    </div>
  );
}

function VerbSwap() {
  const verb = (w: string, c: string) => (
    <div style={{ height: 10, color: c, fontWeight: 800 }}>{w}</div>
  );
  return (
    <Frame bg="#fff">
      <div style={abs({ left: 9, top: 26, display: 'flex', alignItems: 'flex-start', gap: 3, fontSize: 8, fontWeight: 700, whiteSpace: 'nowrap' })}>
        <span style={{ lineHeight: '10px' }}>Grok Bot can now</span>
        <span style={{ display: 'inline-block', height: 10, overflow: 'hidden', lineHeight: '10px' }}>
          <div className="ovp-verbs">
            {verb('code', BLUE)}
            {verb('draw', ORANGE)}
            {verb('talk', GREEN)}
            {verb('code', BLUE)}
          </div>
        </span>
        <span style={{ lineHeight: '10px' }}>X</span>
      </div>
    </Frame>
  );
}

function TaglineBuild() {
  const grid = 'linear-gradient(#dfe2e7 1px,transparent 1px),linear-gradient(90deg,#dfe2e7 1px,transparent 1px)';
  // the selection box around the tagline: x 14..98, y 22..41
  const box = { l: 14, t: 22, w: 84, h: 19 };
  const dot = (x: number, y: number, k: number) => (
    <span
      key={k}
      className="ovp-dot"
      style={
        {
          ...abs({ left: x - 2, top: y - 2, width: 4, height: 4, borderRadius: 4, background: BLUE, boxShadow: '0 0 0 1px #fff' }),
          '--dx': `${(56 - x) * 0.8}px`,
          '--dy': `${(31 - y) * 0.8}px`,
        } as CSSProperties
      }
    />
  );
  return (
    <Frame bg="#EEF0F3" style={{ backgroundImage: grid, backgroundSize: '8px 8px' }}>
      <span className="ovp-sel" style={abs({ left: box.l, top: box.t, width: box.w, height: box.h, border: `1px solid ${BLUE}` })} />
      <div style={abs({ left: 0, right: 0, top: 27, display: 'flex', justifyContent: 'center', gap: 3, fontSize: 8.5, fontWeight: 800, letterSpacing: -0.2 })}>
        <span className="ovp-w1">Every</span>
        <span className="ovp-w2">agent.</span>
        <span className="ovp-w3">One</span>
        <span className="ovp-w4">inbox.</span>
      </div>
      {[
        [box.l, box.t],
        [box.l + box.w, box.t],
        [box.l, box.t + box.h],
        [box.l + box.w, box.t + box.h],
      ].map(([x, y], k) => dot(x, y, k))}
      <span className="ovp-bar" style={abs({ left: 0, top: 0, width: '100%', height: '100%', background: '#0b0b0c' })} />
    </Frame>
  );
}

function PromptMenu() {
  const rows = ['Summarize', 'Write post', 'Research'];
  return (
    <Frame bg="#F4F5F7">
      {/* the "/" Skills menu */}
      <div
        className="ovp-menu"
        style={abs({ left: 10, top: 6, width: 58, height: 34, background: '#fff', border: '1px solid #e2e4e8', borderRadius: 4, boxShadow: '0 2px 6px rgba(0,0,0,.08)', padding: '3px 3px' })}
      >
        <div style={{ fontSize: 4.5, color: '#8a8f98', fontWeight: 600, height: 6 }}>/ Skills</div>
        <div style={{ position: 'relative' }}>
          <span className="ovp-hi" style={abs({ left: 0, right: 0, top: 0, height: 8, borderRadius: 2, background: '#DCEBFB' })} />
          {rows.map((r) => (
            <div key={r} style={{ position: 'relative', height: 8, fontSize: 5, lineHeight: '8px', paddingLeft: 3, color: '#2b2f36' }}>
              {r}
            </div>
          ))}
          {/* cursor */}
          <svg className="ovp-cur" width="7" height="9" viewBox="0 0 7 9" style={abs({ left: 40, top: 2 })}>
            <path d="M0.5 0.5 L0.5 7.5 L2.4 5.8 L3.6 8.4 L4.7 7.9 L3.5 5.4 L6 5.4 Z" fill="#111" stroke="#fff" strokeWidth="0.6" />
          </svg>
        </div>
      </div>
      {/* the composer */}
      <div
        style={abs({ left: 8, right: 8, bottom: 7, height: 13, background: '#fff', border: '1px solid #d9dce1', borderRadius: 7, display: 'flex', alignItems: 'center', padding: '0 4px', gap: 2 })}
      >
        <span style={{ position: 'relative', fontSize: 5.5, color: '#6b7280', width: 34, height: 7 }}>
          <span className="ovp-slash" style={abs({ left: 0, top: 0 })}>/</span>
          <span className="ovp-pick" style={abs({ left: 0, top: -1, fontSize: 5, color: BLUE, background: '#E8F1FC', borderRadius: 3, padding: '1px 3px' })}>
            Research
          </span>
        </span>
        <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: 8, background: '#111' }} />
      </div>
    </Frame>
  );
}

function CardScene({ dur }: { dur: string }) {
  const chip = (cls: string, label: string, left: number) => (
    <span
      className={cls}
      style={abs({ left, top: 17, fontSize: 4.2, padding: '1.5px 3px', borderRadius: 3, background: '#fff', border: '1px solid #dfe2e7', color: '#3b4048', whiteSpace: 'nowrap' })}
    >
      {label}
    </span>
  );
  return (
    <div style={{ ...abs({ inset: 0 }), perspective: 160, ['--d' as string]: dur } as CSSProperties}>
      <div
        style={abs({
          left: 19, top: 12, width: 74, height: 38, borderRadius: 6,
          background: 'rgba(255,255,255,.72)', border: '1px solid rgba(255,255,255,.95)',
          boxShadow: '0 8px 16px rgba(30,40,60,.14)', transform: 'rotateX(16deg) rotateY(-20deg) rotateZ(3deg)',
        })}
      >
        <div style={abs({ left: 5, top: 6, display: 'flex', alignItems: 'center', fontSize: 5, color: '#1f2328' })}>
          <span className="ovp-type" style={{ display: 'inline-block', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            Build me a landing page
          </span>
          <span style={{ width: 0.8, height: 6, background: '#1f2328', marginLeft: 0.5 }} />
        </div>
        {chip('ovp-chip1', 'brief.pdf', 5)}
        {chip('ovp-chip2', 'logo.png', 28)}
        <span style={abs({ right: 4, bottom: 4, height: 7, width: 26 })}>
          <span className="ovp-send" style={abs({ right: 0, top: 0, fontSize: 4.5, padding: '1.2px 4px', borderRadius: 4, background: '#111', color: '#fff' })}>
            Send
          </span>
          <span className="ovp-work" style={abs({ right: 0, top: 0, display: 'flex', alignItems: 'center', gap: 1.5, fontSize: 4.5, color: '#4b5563', whiteSpace: 'nowrap' })}>
            <span className="ovp-pulse" style={{ width: 3, height: 3, borderRadius: 3, background: BLUE }} />
            Working
          </span>
        </span>
      </div>
    </div>
  );
}

function PromptCard3D() {
  return (
    <Frame bg="radial-gradient(circle at 50% 40%,#f7f8fa,#dfe2e7)">
      <CardScene dur="4.5s" />
    </Frame>
  );
}

function PromptResult() {
  return (
    <Frame bg="radial-gradient(circle at 50% 40%,#f7f8fa,#dfe2e7)">
      <CardScene dur="6s" />
      {/* the app's real result — here, a stand-in landing page */}
      <div className="ovp-result" style={abs({ inset: 0, background: '#fff', padding: 4 })}>
        <div style={{ display: 'flex', gap: 1.5, marginBottom: 3 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <span key={c} style={{ width: 3, height: 3, borderRadius: 3, background: c }} />
          ))}
        </div>
        <div style={{ height: 17, borderRadius: 3, background: `linear-gradient(120deg,${BLUE},#7c4dff)`, marginBottom: 3 }} />
        <div style={{ display: 'flex', gap: 3 }}>
          {[0, 1, 2].map((k) => (
            <span key={k} style={{ flex: 1, height: 14, borderRadius: 2, background: '#eef0f3' }} />
          ))}
        </div>
        <span style={abs({ right: 4, top: 3, fontSize: 4.5, fontWeight: 700, padding: '1.5px 3px', borderRadius: 3, background: '#111', color: '#fff' })}>
          HOOK 0:00–0:40
        </span>
      </div>
    </Frame>
  );
}

function PromptHighlight() {
  return (
    <Frame bg="#1f1e1c">
      <div className="ovp-push" style={abs({ inset: 0, transformOrigin: '50% 55%' })}>
        {/* a dark Claude-style composer */}
        <div
          style={abs({ left: 10, right: 10, top: 18, height: 28, borderRadius: 7, background: '#2f2e2b', border: '1px solid #45433e', padding: '5px 6px' })}
        >
          <div style={{ fontSize: 5, color: '#ece9e1', lineHeight: '7px' }}>
            <span className="ovp-type2" style={{ display: 'inline-block', overflow: 'hidden', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
              <span className="ovp-mark ovp-mark1" style={{ color: '#1a1a1a' }}>Email</span> every{' '}
              <span className="ovp-mark ovp-mark2" style={{ color: '#1a1a1a' }}>unpaid invoice</span>
            </span>
          </div>
          <div style={abs({ left: 6, right: 6, bottom: 4, display: 'flex', alignItems: 'center', gap: 2 })}>
            <span style={{ fontSize: 5, color: '#a8a49b' }}>+</span>
            <span style={{ marginLeft: 'auto', width: 7, height: 7, borderRadius: 3, background: '#d97757' }} />
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** static mini-glyphs for the original templates (they sit over footage) */
function Classic({ id }: { id: OverlayTemplateId }) {
  const white: CSSProperties = { color: '#fff', fontWeight: 800, textShadow: '0 1px 2px rgba(0,0,0,.5)' };
  const body: Record<string, ReactNode> = {
    lower_title: (
      <div style={abs({ left: 0, right: 0, bottom: 9, textAlign: 'center', fontSize: 6.5, ...white })}>
        Hey everyone
        <div style={{ fontSize: 5, fontWeight: 600, marginTop: 1.5 }}>welcome back</div>
      </div>
    ),
    link: (
      <span style={abs({ left: 30, bottom: 10, fontSize: 5.5, padding: '2px 5px', borderRadius: 6, background: 'rgba(255,255,255,.92)', color: '#111', fontWeight: 700 })}>
        Link below ↓
      </span>
    ),
    subscribe: (
      <span style={abs({ left: 33, bottom: 10, fontSize: 6, padding: '2.5px 6px', borderRadius: 3, background: '#e62117', color: '#fff', fontWeight: 800 })}>
        SUBSCRIBE
      </span>
    ),
    socials: (
      <div style={abs({ left: 0, right: 0, bottom: 10, display: 'flex', justifyContent: 'center', gap: 4 })}>
        <span style={{ width: 11, height: 11, borderRadius: 3, background: '#111', boxShadow: 'inset 2px 0 #25f4ee, inset -2px 0 #fe2c55' }} />
        <span style={{ width: 11, height: 11, borderRadius: 3, background: 'linear-gradient(45deg,#feda75,#d62976,#4f5bd5)' }} />
      </div>
    ),
    keyword: (
      <div style={abs({ left: 0, right: 0, top: 20, textAlign: 'center', fontSize: 8, ...white })}>
        It’s free
        <div style={{ color: '#7dd3fc' }}>forever</div>
      </div>
    ),
    list: (
      <div style={abs({ left: 22, top: 14, fontSize: 5.5, lineHeight: '9px', ...white })}>
        <div>• Script</div>
        <div>• Record</div>
        <div>• Post</div>
      </div>
    ),
    number: (
      <div style={abs({ left: 0, right: 0, top: 13, textAlign: 'center', ...white })}>
        <div style={{ fontSize: 16 }}>$47</div>
        <div style={{ fontSize: 4.5, fontWeight: 600, marginTop: 1 }}>PER MONTH</div>
      </div>
    ),
    question: (
      <div style={abs({ left: 0, right: 0, bottom: 10, textAlign: 'center', fontSize: 5.5, ...white })}>
        What are you editing first?
      </div>
    ),
  };
  return <Frame bg="linear-gradient(160deg,#3a4150,#1d222b)">{body[id]}</Frame>;
}

export function OverlayPreview({ id }: { id: string }) {
  switch (id) {
    case 'verb_swap':
      return <VerbSwap />;
    case 'tagline_build':
      return <TaglineBuild />;
    case 'prompt_menu':
      return <PromptMenu />;
    case 'prompt_card_3d':
      return <PromptCard3D />;
    case 'prompt_result':
      return <PromptResult />;
    case 'prompt_highlight':
      return <PromptHighlight />;
    default:
      return BY_ID.has(id) ? <Classic id={id as OverlayTemplateId} /> : <Frame bg="#2a2f38">{null}</Frame>;
  }
}

/** The keyframes — render once wherever a preview may show. */
export function OverlayPreviewStyles() {
  return <style>{CSS}</style>;
}

/** The template catalog: every overlay the planner may place, with its preview. */
export function OverlayCatalog({ className }: { className?: string }) {
  const shown = OVERLAY_TEMPLATES.filter((t) => MOTION_TEMPLATES_ENABLED || !t.motion);
  return (
    <details className={cn('group rounded-md border border-border', className)}>
      <OverlayPreviewStyles />
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="text-foreground">Overlay templates ({shown.length})</span>
        <span className="truncate text-muted-foreground">what Claude can put on screen</span>
      </summary>
      <ul className="space-y-2 px-3 pb-3">
        {shown.map((t) => (
          <li key={t.id} className="flex items-start gap-2.5">
            <OverlayPreview id={t.id} />
            <div className="min-w-0 space-y-0.5">
              <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-foreground">
                {t.name}
                {t.motion && (
                  <span className="rounded bg-primary/15 px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-primary">motion</span>
                )}
                {t.zone && <span className="text-[10px] text-muted-foreground">zone: {t.zone}</span>}
              </p>
              <p className="text-[10.5px] leading-snug text-muted-foreground">{t.description}</p>
              {t.promptBox && <p className="text-[10px] leading-snug text-muted-foreground/80">{PROMPT_KIT_NOTE}</p>}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
