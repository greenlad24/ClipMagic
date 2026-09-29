import { useEffect } from 'react';
import './theme.css';

/** Switch the document to the app's own light palette while this page is open. */
export function useNewsTheme(): void {
  useEffect(() => {
    const el = document.documentElement;
    el.classList.add('news-theme');
    const prevTitle = document.title;
    document.title = 'AI News Stream';
    return () => {
      el.classList.remove('news-theme');
      document.title = prevTitle;
    };
  }, []);
}
