/**
 * Deal Organizer — light/dark theme.
 *
 * Ported from the Zite app, which set `html[data-theme]`. In the Lab the
 * theme lives in two classes on <html> (see ../theme.css): `dealorg` while
 * any Deal Organizer page is mounted, plus `dealorg-dark` in dark mode. Both
 * are removed when the user leaves the Deal Organizer, so the rest of the Lab
 * keeps its own theme.
 *
 * DARK IS THE DEFAULT (Jake, 2026-09-30). The toggle is kept and the choice
 * is remembered in localStorage under the original key.
 */
import { createContext, useContext, useLayoutEffect, useState } from 'react';
import '../theme.css';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
}

const STORAGE_KEY = 'deal-organizer-theme';

export const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  toggleTheme: () => {},
  setTheme: () => {},
});

function readStored(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function writeStored(t: Theme) {
  try { localStorage.setItem(STORAGE_KEY, t); } catch { /* private mode / blocked storage */ }
}

function apply(t: Theme) {
  const el = document.documentElement;
  el.classList.add('dealorg');
  el.classList.toggle('dealorg-dark', t === 'dark');
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);

  // Before paint, so the Lab's palette never flashes inside the Deal Organizer.
  useLayoutEffect(() => {
    apply(theme);
  }, [theme]);

  useLayoutEffect(() => {
    const el = document.documentElement;
    const prevTitle = document.title;
    document.title = 'Deal Organizer';
    return () => {
      el.classList.remove('dealorg', 'dealorg-dark');
      document.title = prevTitle;
    };
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    apply(t);
    writeStored(t);
  };

  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
