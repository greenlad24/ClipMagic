import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import BackgroundJobs from './components/BackgroundJobs';
import HomePage from './pages/HomePage';
import CreatePage from './pages/CreatePage';
import ProcessingPage from './pages/ProcessingPage';
import PreviewPage from './pages/PreviewPage';
import SetupPage from './pages/SetupPage';
import TimelineEditorPage from './pages/TimelineEditorPage';
import StoragePage from './pages/StoragePage';
import BulkPage from './pages/BulkPage';
import CutterPage from './pages/CutterPage';
import MemePage from './pages/MemePage';
import PostizSettingsPage from './pages/PostizSettingsPage';
import BulkSchedulerPage from './pages/BulkSchedulerPage';
import ThumbnailDesignerPage from './pages/ThumbnailDesignerPage';
import ImageGeneratorPage from './pages/ImageGeneratorPage';
import KeywordResearchPage from './pages/KeywordResearchPage';

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
        <Route path="/create" element={<CreatePage />} />
        <Route path="/project/:id/processing" element={<ProcessingPage />} />
        <Route path="/project/:id/preview" element={<PreviewRedirect />} />
        <Route path="/project/:id/timeline" element={<TimelineEditorPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/storage" element={<StoragePage />} />
        <Route path="/bulk" element={<BulkPage />} />
        <Route path="/cutter" element={<CutterPage />} />
        <Route path="/meme" element={<MemePage />} />
        <Route path="/settings/postiz" element={<PostizSettingsPage />} />
        <Route path="/bulk-scheduler" element={<BulkSchedulerPage />} />
        <Route path="/thumbnail-designer" element={<ThumbnailDesignerPage />} />
        <Route path="/image-generator" element={<ImageGeneratorPage />} />
        <Route path="/keyword-research" element={<KeywordResearchPage />} />
      </Routes>
      <BackgroundJobs />
      <Toaster theme="dark" />
    </BrowserRouter>
  );
}
