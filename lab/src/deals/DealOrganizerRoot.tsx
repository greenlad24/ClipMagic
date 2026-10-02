/**
 * Deal Organizer — app root inside the Lab: the original App.tsx providers
 * (ThemeProvider → StageLabelsProvider) around the original AppLayout, whose
 * <Outlet/> renders the page routes from ./routes.tsx. SyncProvider holds the
 * one shared Gmail sync (status, "Sync now", reload-on-finish). The Lab's own
 * BrowserRouter and <Toaster/> are reused; theme.css restyles the toasts to the
 * Deal Organizer palette while it is open (a second Toaster would double them).
 */
import { ThemeProvider } from './context/ThemeContext';
import { StageLabelsProvider } from './context/StageLabelsContext';
import { SyncProvider } from './context/SyncContext';
import AppLayout from './components/AppLayout';

export default function DealOrganizerRoot() {
  return (
    <ThemeProvider>
      <StageLabelsProvider>
        <SyncProvider>
          <AppLayout />
        </SyncProvider>
      </StageLabelsProvider>
    </ThemeProvider>
  );
}
