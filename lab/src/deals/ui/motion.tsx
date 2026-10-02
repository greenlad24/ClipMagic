/**
 * Deal Organizer — a tiny stand-in for the slice of framer-motion the original
 * app used (framer-motion is not installed in the Lab and cannot be added).
 *
 * Supported: `motion.div` / `motion.span` with `initial` → `animate` enter
 * transitions (opacity, x, y, scale, rotate, boxShadow), `animate` changes
 * (e.g. a rotating chevron, a dragged card's opacity), `whileHover`, and
 * `transition` ({duration, ease}). CSS transitions do the animating.
 *
 * Dropped (no visual equivalent without the library): `exit` animations
 * (elements unmount at once), height:auto expand/collapse (content just
 * appears), and `layout` / `layoutId` shared-layout moves. `AnimatePresence`
 * and `LayoutGroup` render their children unchanged.
 */
import {
  createContext, createElement, forwardRef, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';

type Target = Record<string, any>;
type Transition = { duration?: number; ease?: string | number[]; delay?: number };

const PresenceInitial = createContext(true);

export function AnimatePresence({ children, initial = true }: { children?: ReactNode; initial?: boolean; mode?: string }) {
  return <PresenceInitial.Provider value={initial}>{children}</PresenceInitial.Provider>;
}

export function LayoutGroup({ children }: { children?: ReactNode; id?: string }) {
  return <>{children}</>;
}

function easeCss(ease: Transition['ease']): string {
  if (Array.isArray(ease) && ease.length === 4) return `cubic-bezier(${ease.join(',')})`;
  switch (ease) {
    case 'easeIn': return 'ease-in';
    case 'easeOut': return 'ease-out';
    case 'linear': return 'linear';
    default: return 'ease-in-out';
  }
}

function toStyle(t: Target | undefined): CSSProperties {
  if (!t || typeof t !== 'object') return {};
  const s: CSSProperties = {};
  const tf: string[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (v === undefined) continue;
    switch (k) {
      case 'x': tf.push(`translateX(${typeof v === 'number' ? `${v}px` : v})`); break;
      case 'y': tf.push(`translateY(${typeof v === 'number' ? `${v}px` : v})`); break;
      case 'scale': tf.push(`scale(${v})`); break;
      case 'rotate': tf.push(`rotate(${typeof v === 'number' ? `${v}deg` : v})`); break;
      case 'opacity': s.opacity = v; break;
      case 'boxShadow': s.boxShadow = v; break;
      case 'backgroundColor': s.backgroundColor = v; break;
      case 'height': case 'width': break; // height:auto tweens are not reproduced
      default: break;
    }
  }
  if (tf.length) s.transform = tf.join(' ');
  return s;
}

type MotionProps = {
  initial?: Target | false;
  animate?: Target;
  exit?: Target;
  transition?: Transition;
  whileHover?: Target;
  whileTap?: Target;
  layout?: boolean | string;
  layoutId?: string;
  style?: CSSProperties;
  children?: ReactNode;
  onMouseEnter?: (e: any) => void;
  onMouseLeave?: (e: any) => void;
  [k: string]: any;
};

function makeMotion(tag: string) {
  const C = forwardRef<HTMLElement, MotionProps>(function MotionEl(props, ref) {
    const {
      initial, animate, exit: _exit, transition, whileHover, whileTap: _tap, layout: _layout, layoutId: _layoutId,
      style, children, onMouseEnter, onMouseLeave, ...rest
    } = props;
    const presenceInitial = useContext(PresenceInitial);
    const playEnter = presenceInitial && initial && typeof initial === 'object';
    const [entered, setEntered] = useState(!playEnter);
    const [hover, setHover] = useState(false);
    const raf = useRef<number>(0);

    useLayoutEffect(() => {
      if (entered) return;
      // Two frames: the first paints the `initial` state, the second transitions to `animate`.
      raf.current = requestAnimationFrame(() => {
        raf.current = requestAnimationFrame(() => setEntered(true));
      });
      return () => cancelAnimationFrame(raf.current);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => () => cancelAnimationFrame(raf.current), []);

    const dur = Math.round((transition?.duration ?? 0.2) * 1000);
    const delay = Math.round((transition?.delay ?? 0) * 1000);
    const ease = easeCss(transition?.ease);
    const t = ['opacity', 'transform', 'box-shadow', 'background-color']
      .map((p) => `${p} ${dur}ms ${ease} ${delay}ms`).join(', ');

    const base = entered ? toStyle(animate) : toStyle(initial as Target);
    const hov = hover && whileHover ? toStyle(whileHover) : {};
    const merged: CSSProperties = { ...style, ...base, ...hov, ['--dm-t' as any]: t };

    return createElement(
      tag,
      {
        ...rest,
        ref,
        'data-dm-motion': '',
        style: merged,
        onMouseEnter: (e: any) => { if (whileHover) setHover(true); onMouseEnter?.(e); },
        onMouseLeave: (e: any) => { if (whileHover) setHover(false); onMouseLeave?.(e); },
      },
      children,
    );
  });
  C.displayName = `motion.${tag}`;
  return C;
}

export const motion = {
  div: makeMotion('div'),
  span: makeMotion('span'),
  button: makeMotion('button'),
  li: makeMotion('li'),
};
