import { Suspense, useState } from 'react';
import { Outlet, NavLink, Link, useLocation } from 'react-router-dom';
import { Home, KanbanSquare, Mail, BarChart2, Settings, Layers3, CalendarClock, Bot } from 'lucide-react';
import { useAuth } from '@/deals/auth';

// Lab port: every path lives under /deal-organizer (Home is the index), and
// the new sponsorship email Agent gets its own item. Settings stays active on
// /deal-organizer/connections, which is Settings opened at Connections.
const BASE = '/deal-organizer';

const NAV = [{
  section: 'Main',
  items: [
    { to: BASE,                icon: Home,          label: 'Home' },
    { to: `${BASE}/deadlines`, icon: CalendarClock, label: 'Deadlines' },
    { to: `${BASE}/deals`,     icon: KanbanSquare,  label: 'Deals' },
    { to: `${BASE}/emails`,    icon: Mail,          label: 'Emails' },
    { to: `${BASE}/agent`,     icon: Bot,           label: 'Agent' },
  ]
}, {
  section: 'Insights',
  items: [{ to: `${BASE}/analytics`, icon: BarChart2, label: 'Analytics' }]
}, {
  section: 'System',
  items: [{ to: `${BASE}/settings`, icon: Settings, label: 'Settings' }]
}];

const MOBILE_NAV = [
  { to: BASE,                icon: Home,          label: 'Home' },
  { to: `${BASE}/deadlines`, icon: CalendarClock, label: 'Deadlines' },
  { to: `${BASE}/deals`,     icon: KanbanSquare,  label: 'Deals' },
  { to: `${BASE}/emails`,    icon: Mail,          label: 'Emails' },
  { to: `${BASE}/agent`,     icon: Bot,           label: 'Agent' },
  { to: `${BASE}/analytics`, icon: BarChart2,     label: 'Analytics' },
  { to: `${BASE}/settings`,  icon: Settings,      label: 'Settings' },
];

/** NavLink's own match, plus Settings ↔ Connections. Home matches only itself. */
function useIsActive() {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/+$/, '') || '/';
  return (to: string) => {
    if (to === BASE) return path === BASE || path === `${BASE}/home`;
    if (to === `${BASE}/settings`) return path.startsWith(`${BASE}/settings`) || path.startsWith(`${BASE}/connections`);
    return path === to || path.startsWith(`${to}/`);
  };
}

const COLLAPSED_W = 64;
const EXPANDED_W  = 220;

export default function AppLayout() {
  const { user, isLoading, loginWithRedirect } = useAuth();
  const [hovered, setHovered] = useState(false);
  const isActive = useIsActive();

  if (isLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    loginWithRedirect({ redirectUrl: window.location.href });
    return (
      <div className="h-screen w-screen flex items-center justify-center" style={{ background: 'var(--bg-page)' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Redirecting to login…</p>
        </div>
      </div>
    );
  }

  const initial     = (user.firstName?.[0] ?? user.email[0]).toUpperCase();
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email.split('@')[0];

  return (
    <div
      className="h-screen w-screen flex overflow-hidden"
      style={{ background: 'var(--bg-page)' }}
    >
      <div
        className="w-full flex overflow-hidden items-stretch h-full"
        style={{ background: 'var(--bg-page)' }}
      >
        {/* ── Sidebar wrapper — reserves COLLAPSED_W on desktop; hidden on mobile ── */}
        <div id="app-sidebar-wrapper" style={{ width: COLLAPSED_W, flexShrink: 0, position: 'relative' }}>
          <aside
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              position: 'absolute',
              top: 0, left: 0, bottom: 0,
              width: hovered ? EXPANDED_W : COLLAPSED_W,
              transition: 'width 200ms ease',
              zIndex: 50,
              background: 'hsl(var(--primary))',
              borderTopLeftRadius: 28,
              borderBottomLeftRadius: 28,
              boxShadow: 'rgba(0,0,0,0.2) 2px 0px 20px',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Logo */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '28px 16px 4px', overflow: 'hidden',
            }}>
              <Link to="/" title="Back to the Lab" style={{
                width: 32, height: 32, borderRadius: 10,
                background: 'rgba(255,255,255,0.20)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <Layers3 size={15} className="text-white" />
              </Link>
              {hovered && (
                <span style={{ fontWeight: 700, fontSize: 16, color: 'white', whiteSpace: 'nowrap' }}>
                  Deal Organizer
                </span>
              )}
            </div>

            {/* Nav */}
            <nav style={{ flex: 1, padding: '0 8px', overflowY: 'auto', overflowX: 'hidden' }}>
              {NAV.map(({ section, items }) => (
                <div key={section}>
                  {hovered ? (
                    <p style={{
                      fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.15em', color: 'rgba(255,255,255,0.55)',
                      margin: '22px 0 6px', paddingLeft: 14, whiteSpace: 'nowrap',
                    }}>
                      {section}
                    </p>
                  ) : (
                    <div style={{ marginTop: 16 }} />
                  )}

                  {items.map(({ to, icon: Icon, label }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={to === BASE}
                      style={() => ({
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: hovered ? 'flex-start' : 'center',
                        gap: hovered ? 12 : 0,
                        padding: hovered ? '9px 14px' : '9px 0',
                        margin: '2px 0',
                        cursor: 'pointer',
                        borderRadius: 10,
                        background: isActive(to) ? 'rgba(255,255,255,0.20)' : undefined,
                        color: 'white',
                        fontSize: 14,
                        fontWeight: 500,
                        textDecoration: 'none',
                        transition: 'background 0.12s',
                        whiteSpace: 'nowrap',
                      })}
                      className={() => isActive(to) ? '' : 'hover:bg-white/10'}
                    >
                      <Icon size={18} style={{ flexShrink: 0 }} />
                      {hovered && <span>{label}</span>}
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>

            {/* User block */}
            <div style={{ padding: '16px 12px 20px', borderTop: '1px solid rgba(255,255,255,0.15)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: hovered ? 'flex-start' : 'center' }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'white', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, color: 'hsl(var(--primary))',
                }}>
                  {initial}
                </div>
                {hovered && (
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: 'white', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {displayName}
                    </p>
                    <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {user.email}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>

        {/* Main content area */}
        <main id="app-main-content" className="flex-1 overflow-hidden flex flex-col min-h-0 self-stretch" style={{ background: 'var(--bg-shell)' }}>
          <Suspense fallback={
            <div className="flex-1 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          }>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* ── Mobile bottom tab bar (hidden on desktop via CSS) ── */}
      <nav id="mobile-tab-bar" style={{ display: 'none' }}>
        {MOBILE_NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === BASE}
            className={() => isActive(to) ? 'mobile-tab-active' : ''}
          >
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
