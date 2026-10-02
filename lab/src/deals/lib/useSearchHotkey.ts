/**
 * ⌘K / Ctrl+K focuses (and selects) the page's search box — the badge the
 * original drew next to it never had a key handler.
 */
import { useEffect, type RefObject } from 'react';

export const SEARCH_HOTKEY_LABEL: string = (() => {
  try { return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K'; } catch { return '⌘K'; }
})();

export function useSearchHotkey(ref: RefObject<HTMLInputElement>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        const el = ref.current;
        if (!el) return;
        e.preventDefault();
        el.focus();
        el.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ref, enabled]);
}
