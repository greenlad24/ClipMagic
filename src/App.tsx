import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import HomePage from './pages/HomePage';
import ProcessingPage from './pages/ProcessingPage';
import PreviewPage from './pages/PreviewPage';
import SetupPage from './pages/SetupPage';
import TimelineEditorPage from './pages/TimelineEditorPage';
import StoragePage from './pages/StoragePage';

// Redirect /project/:id/preview → /project/:id/timeline
function PreviewRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/project/${id}/timeline`} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/project/:id/processing" element={<ProcessingPage />} />
        <Route path="/project/:id/preview" element={<PreviewRedirect />} />
        <Route path="/project/:id/timeline" element={<TimelineEditorPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/storage" element={<StoragePage />} />
      </Routes>
      <Toaster theme="dark" />
    </BrowserRouter>
  );
}
