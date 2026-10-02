/**
 * Kanban drag-and-drop for the Deals and Deadlines boards: cards between
 * columns, and column reordering.
 *
 * Two input paths, one outcome:
 *  • Mouse — native HTML5 DnD. Each column is its own drop target and sets the
 *    highlight from its own dragover (the original used a pointer-events:none
 *    overlay, so "Drop here" never showed).
 *  • Touch — HTML5 DnD doesn't work on phones, so: long-press (350 ms, finger
 *    still) picks the card/column up, a ghost follows the finger, the board
 *    auto-scrolls near its edges, and lifting drops it on the column under the
 *    finger. Moving the finger before the long-press fires is a normal scroll.
 *
 * No libraries — only DOM touch events (non-passive touchmove so the page
 * doesn't scroll while something is being dragged).
 */
import { useMemo, useRef, useState } from 'react';
import type React from 'react';

export type DragItem<D> = { type: 'card'; deal: D } | { type: 'column'; stage: string };

interface Options<D> {
  onCardDrop: (deal: D, stage: string) => void;
  onColumnDrop: (fromStage: string, toStage: string) => void;
}

const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE = 8;
const EDGE = 60;
const MAX_SPEED = 16;

/** Phones/tablets: native `draggable` would fight the touch path (iOS drag), so it's off there. */
export const TOUCH_ONLY: boolean = (() => {
  try { return window.matchMedia('(hover: none) and (pointer: coarse)').matches; } catch { return false; }
})();

function stageAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest('[data-stage]')?.getAttribute('data-stage') ?? null;
}

export function useBoardDnd<D>(options: Options<D>) {
  const optsRef = useRef(options);
  optsRef.current = options;

  const [dragType, setDragType] = useState<'card' | 'column' | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const api = useMemo(() => {
    let item: DragItem<D> | null = null;
    let suppressClickUntil = 0;

    const begin = (it: DragItem<D>) => { item = it; setDragType(it.type); };
    const reset = () => { item = null; setDragType(null); setOverStage(null); };
    const finish = (stage: string | null) => {
      const it = item;
      reset();
      if (!it || !stage) return;
      if (it.type === 'card') optsRef.current.onCardDrop(it.deal, stage);
      else if (it.stage !== stage) optsRef.current.onColumnDrop(it.stage, stage);
    };

    // ── Touch ────────────────────────────────────────────────────────────────
    type TouchState = {
      item: DragItem<D>; src: HTMLElement; timer: number; raf: number;
      startX: number; startY: number; x: number; y: number; offX: number; offY: number;
      active: boolean; ghost: HTMLElement | null; over: string | null;
      prevSrcOpacity: string; prevSnap: string; prevUserSelect: string;
    };
    let ts: TouchState | null = null;

    const setOver = (s: string | null) => {
      if (!ts || ts.over === s) return;
      ts.over = s;
      setOverStage(s);
    };

    const cleanup = () => {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onCancel);
      window.removeEventListener('contextmenu', onContextMenu, true);
      if (!ts) return;
      clearTimeout(ts.timer);
      cancelAnimationFrame(ts.raf);
      ts.ghost?.remove();
      if (ts.active) {
        ts.src.style.opacity = ts.prevSrcOpacity;
        if (boardRef.current) boardRef.current.style.scrollSnapType = ts.prevSnap;
        document.body.style.userSelect = ts.prevUserSelect;
      }
      ts = null;
    };

    const tick = () => {
      if (!ts || !ts.active) return;
      const board = boardRef.current;
      if (board) {
        const r = board.getBoundingClientRect();
        const speed = (dist: number) => Math.ceil(MAX_SPEED * Math.min(1, (EDGE - dist) / EDGE));
        let dx = 0, dy = 0;
        if (ts.x < r.left + EDGE) dx = -speed(ts.x - r.left);
        else if (ts.x > r.right - EDGE) dx = speed(r.right - ts.x);
        if (ts.y < r.top + EDGE) dy = -speed(ts.y - r.top);
        else if (ts.y > r.bottom - EDGE) dy = speed(r.bottom - ts.y);
        if (dx || dy) {
          board.scrollBy(dx, dy);
          setOver(stageAt(ts.x, ts.y));
        }
      }
      ts.raf = requestAnimationFrame(tick);
    };

    const activate = () => {
      if (!ts) return;
      const s = ts;
      s.active = true;
      begin(s.item);
      try { navigator.vibrate?.(12); } catch { /* unsupported */ }
      const r = s.src.getBoundingClientRect();
      s.offX = s.startX - r.left;
      s.offY = s.startY - r.top;
      const ghost = s.src.cloneNode(true) as HTMLElement;
      Object.assign(ghost.style, {
        position: 'fixed', left: '0px', top: '0px', margin: '0', width: `${r.width}px`,
        height: `${r.height}px`, pointerEvents: 'none', zIndex: '9999', opacity: '0.92',
        boxShadow: '0 12px 32px rgba(0,0,0,0.35)', borderRadius: '10px',
        transform: `translate(${r.left}px, ${r.top}px) rotate(1.5deg) scale(1.03)`,
        transition: 'none',
      } as Partial<CSSStyleDeclaration>);
      ghost.removeAttribute('data-stage');
      ghost.querySelectorAll('[data-stage]').forEach(n => n.removeAttribute('data-stage'));
      document.body.appendChild(ghost);
      s.ghost = ghost;
      s.prevSrcOpacity = s.src.style.opacity;
      s.src.style.opacity = '0.35';
      s.prevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';
      if (boardRef.current) {
        s.prevSnap = boardRef.current.style.scrollSnapType;
        boardRef.current.style.scrollSnapType = 'none';
      }
      setOver(stageAt(s.x, s.y));
      s.raf = requestAnimationFrame(tick);
    };

    function onMove(e: TouchEvent) {
      if (!ts) return;
      const t = e.touches[0];
      if (!t) return;
      ts.x = t.clientX;
      ts.y = t.clientY;
      if (!ts.active) {
        // Moved before the long-press fired → it's a scroll, let the browser have it.
        if (Math.hypot(ts.x - ts.startX, ts.y - ts.startY) > MOVE_TOLERANCE) cleanup();
        return;
      }
      if (e.cancelable) e.preventDefault();
      if (ts.ghost) {
        ts.ghost.style.transform = `translate(${ts.x - ts.offX}px, ${ts.y - ts.offY}px) rotate(1.5deg) scale(1.03)`;
      }
      setOver(stageAt(ts.x, ts.y));
    }

    function onEnd(e: TouchEvent) {
      if (!ts) return;
      if (!ts.active) { cleanup(); return; } // a tap: the normal click follows
      if (e.cancelable) e.preventDefault(); // no synthetic click on the card
      suppressClickUntil = Date.now() + 500;
      const target = ts.over;
      cleanup();
      finish(target);
    }

    function onCancel() {
      const wasActive = ts?.active;
      cleanup();
      if (wasActive) reset();
    }

    function onContextMenu(e: Event) {
      if (ts) e.preventDefault(); // Android long-press menu
    }

    const touchStart = (it: DragItem<D>) => (e: React.TouchEvent<HTMLElement>) => {
      if (e.touches.length !== 1) { cleanup(); return; }
      const target = e.target as HTMLElement;
      if (target.closest('button, input, textarea, select, a, [data-no-drag]')) return;
      cleanup();
      const t = e.touches[0];
      ts = {
        item: it, src: e.currentTarget, timer: 0, raf: 0,
        startX: t.clientX, startY: t.clientY, x: t.clientX, y: t.clientY, offX: 0, offY: 0,
        active: false, ghost: null, over: null, prevSrcOpacity: '', prevSnap: '', prevUserSelect: '',
      };
      ts.timer = window.setTimeout(activate, LONG_PRESS_MS);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onCancel);
      window.addEventListener('contextmenu', onContextMenu, true);
    };

    return {
      // HTML5 (mouse)
      cardDragStart: (deal: D) => (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', 'deal'); } catch { /* Firefox needs data to start */ }
        begin({ type: 'card', deal });
      },
      columnDragStart: (stage: string) => (e: React.DragEvent) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', 'stage'); } catch { /* ignore */ }
        begin({ type: 'column', stage });
      },
      columnDragOver: (stage: string) => (e: React.DragEvent) => {
        if (!item) return; // not our drag (a file, text …)
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOverStage(prev => (prev === stage ? prev : stage));
      },
      columnDrop: (stage: string) => (e: React.DragEvent) => {
        if (!item) return;
        e.preventDefault();
        finish(stage);
      },
      dragEnd: () => { if (item) reset(); },
      // Touch
      cardTouchStart: (deal: D) => touchStart({ type: 'card', deal }),
      columnTouchStart: (stage: string) => touchStart({ type: 'column', stage }),
      /** True right after a touch drop, so the card's click doesn't open the drawer. */
      clickSuppressed: () => Date.now() < suppressClickUntil,
    };
  }, []);

  return { ...api, dragType, overStage, boardRef };
}

export type BoardDnd<D> = ReturnType<typeof useBoardDnd<D>>;
