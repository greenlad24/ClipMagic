/**
 * Deal Organizer — the route list for the Lab's App.tsx.
 *
 *   import { dealOrganizerRoutes } from './deals/routes';
 *   …
 *   <Routes>
 *     …
 *     {dealOrganizerRoutes}
 *   </Routes>
 *
 * Everything lives under /deal-organizer. The pages are lazy-loaded, so the
 * Deal Organizer (and its theme CSS) costs nothing until it is opened.
 *
 *   /deal-organizer                 Home — AI chat (modes A–D)      (was /home)
 *   /deal-organizer/deals           Deals kanban                    (was /deals)
 *   /deal-organizer/deals/:dealId   …with that deal's workspace open (was /deals/:dealId)
 *   /deal-organizer/deadlines       Production pipeline             (was /deadlines)
 *   /deal-organizer/emails          Emails                          (was /emails)
 *   /deal-organizer/analytics       Analytics                       (was /analytics)
 *   /deal-organizer/agent           Sponsorship email agent         (new)
 *   /deal-organizer/settings        Settings (incl. Connections)    (was /settings)
 *   /deal-organizer/connections     Settings, scrolled to Connections — the Gmail
 *                                   OAuth round trip returns here (?gmail=…)
 * The original /gmail-callback page is gone: the Lab owns the Gmail OAuth.
 */
import { lazy, Suspense } from 'react';
import { Navigate, Route } from 'react-router-dom';

const DealOrganizerRoot = lazy(() => import('./DealOrganizerRoot'));
const HomePage = lazy(() => import('./pages/HomePage'));
const DealsPage = lazy(() => import('./pages/DealsPage'));
const DeadlinesPage = lazy(() => import('./pages/DeadlinesPage'));
const EmailsPage = lazy(() => import('./pages/EmailsPage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const AgentPage = lazy(() => import('./pages/AgentPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

function RootFallback() {
  return (
    <div className="h-screen w-screen flex items-center justify-center" style={{ background: '#0B0E17' }}>
      <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#FF7420', borderTopColor: 'transparent' }} />
    </div>
  );
}

export const dealOrganizerRoutes = (
  <>
    <Route path="/deal-organizer" element={<LazyRoot />}>
      <Route index element={<HomePage />} />
      <Route path="home" element={<Navigate to="/deal-organizer" replace />} />
      <Route path="deals" element={<DealsPage />} />
      <Route path="deals/:dealId" element={<DealsPage />} />
      <Route path="deadlines" element={<DeadlinesPage />} />
      <Route path="emails" element={<EmailsPage />} />
      <Route path="analytics" element={<AnalyticsPage />} />
      <Route path="agent" element={<AgentPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="connections" element={<SettingsPage section="connections" />} />
      <Route path="*" element={<Navigate to="/deal-organizer" replace />} />
    </Route>
  </>
);

function LazyRoot() {
  return (
    <Suspense fallback={<RootFallback />}>
      <DealOrganizerRoot />
    </Suspense>
  );
}
