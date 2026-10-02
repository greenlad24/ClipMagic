// All values are CSS variable references — adapts to light/dark theme automatically
export const E = {
  outerBg:       'var(--bg-page)',
  panel1:        'var(--bg-sidebar-2)',
  panel2:        'var(--bg-panel)',
  panel3:        'var(--bg-panel-alt)',
  cardBg:        'hsl(var(--card))',
  cardHover:     'var(--bg-card-hover)',
  cardActive:    'var(--bg-card-active)',
  cardBgMe:      'var(--bg-card-me)',
  border:        'var(--border-color)',
  borderLight:   'var(--border-light)',
  textPrimary:   'var(--text-primary)',
  textSecondary: 'var(--text-secondary)',
  textMuted:     'var(--text-muted)',
  textBody:      'var(--text-primary)',
  accent:        '#FF7420',
  accentLight:   'var(--accent-bg)',
  accentBorder:  'var(--accent-border)',
  accentOrange:  'var(--accent-orange)',
  replyBg:       'var(--bg-sidebar-2)',
  unreadBg:      'var(--bg-card-hover)',
  sepLine:       'var(--border-light)',
};

const AVATAR_COLORS = ['#4C6EF5','#7C3AED','#0EA5E9','#10B981','#F59E0B','#EF4444','#EC4899','#8B5CF6'];

export function domainColor(s: string): string {
  let h = 0;
  for (const c of s) h = (h << 5) - h + c.charCodeAt(0);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// Returns theme-aware pill colors via CSS variables
export function darkPill(cssVar: string): { bg: string; text: string } {
  if (cssVar === 'completed') return { bg: 'var(--pill-green-bg)', text: 'var(--pill-green-text)' };
  if (['new-requests','contract-negotiation','negotiation','invoice','payment'].includes(cssVar))
    return { bg: 'var(--pill-orange-bg)', text: 'var(--pill-orange-text)' };
  if (['rejected','poor-fit','need-fixes'].includes(cssVar))
    return { bg: 'var(--pill-red-bg)', text: 'var(--pill-red-text)' };
  if (['scripting','filming','draft','script-review','script-fixes'].includes(cssVar))
    return { bg: 'var(--pill-purple-bg)', text: 'var(--pill-purple-text)' };
  if (['future-collab','research'].includes(cssVar))
    return { bg: 'var(--pill-blue-bg)', text: 'var(--pill-blue-text)' };
  return { bg: 'var(--pill-gray-bg)', text: 'var(--pill-gray-text)' };
}
