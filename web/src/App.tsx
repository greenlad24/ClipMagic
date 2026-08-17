import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import AvatarNarratorPage from '@/pages/AvatarNarratorPage';

/**
 * One tool, one route. `/avatar-narrator` is kept as the canonical path (the
 * page links to it internally) with `/` redirecting there, so nothing inside
 * the page had to change when it was lifted out of the lab.
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/avatar-narrator" replace />} />
        <Route path="/avatar-narrator" element={<AvatarNarratorPage />} />
        <Route path="*" element={<Navigate to="/avatar-narrator" replace />} />
      </Routes>
      <Toaster theme="dark" />
    </BrowserRouter>
  );
}
