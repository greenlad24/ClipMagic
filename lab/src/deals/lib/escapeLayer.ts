/**
 * Scoped Escape handling for stacked overlays (deal workspace → merge modal …).
 *
 * The original had every overlay listen on `window`, so one Esc in the merge
 * modal also closed the deal drawer underneath. Here only the TOPMOST
 * registered layer gets the key, and never when something else already handled
 * it: Radix dialogs/menus/selects call preventDefault on the Esc they consume,
 * and ui/floating stops its propagation. Esc typed inside a text field belongs
 * to that field (cancel an inline edit), not to the overlay.
 */
import { useEffect, useRef } from 'react';

type Layer = { id: number; fn: () => void };
const stack: Layer[] = [];
let nextId = 1;
let bound = false;

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (isEditable(e.target)) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.fn();
}

/** Register an Escape handler for as long as `active` is true (default: while mounted). */
export function useEscapeLayer(fn: () => void, active = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { id: nextId++, fn: () => fnRef.current() };
    stack.push(layer);
    if (!bound) { window.addEventListener('keydown', onKeyDown); bound = true; }
    return () => {
      const i = stack.findIndex(l => l.id === layer.id);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0 && bound) { window.removeEventListener('keydown', onKeyDown); bound = false; }
    };
  }, [active]);
}
