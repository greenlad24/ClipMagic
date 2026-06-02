import { useCallback, useRef, useState } from 'react';

export function useUndoRedo<T>(initial: T) {
  const history = useRef<T[]>([initial]);
  const pointer = useRef(0);
  const [, tick] = useState(0);

  /** Replace the entire history with a single entry (use after initial data load) */
  const reset = useCallback((next: T) => {
    history.current = [next];
    pointer.current = 0;
    tick(n => n + 1);
  }, []);

  /** Push a new state onto the history stack (for user edits) */
  const push = useCallback((next: T) => {
    history.current = history.current.slice(0, pointer.current + 1).concat([next]);
    pointer.current = history.current.length - 1;
    tick(n => n + 1);
  }, []);

  const undo = useCallback(() => {
    if (pointer.current > 0) { pointer.current--; tick(n => n + 1); }
  }, []);

  const redo = useCallback(() => {
    if (pointer.current < history.current.length - 1) { pointer.current++; tick(n => n + 1); }
  }, []);

  return {
    current: history.current[pointer.current],
    reset,
    push,
    undo,
    redo,
    canUndo: pointer.current > 0,
    canRedo: pointer.current < history.current.length - 1,
  };
}
