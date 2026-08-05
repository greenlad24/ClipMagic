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
import ScriptGeneratorPage from './pages/ScriptGeneratorPage';
import EngagementManagerPage from './pages/EngagementManagerPage';
import VideoPlannerPage from './pages/VideoPlannerPage';
import ChannelAuditPage from './pages/ChannelAuditPage';
import SkoolManagerPage from './pages/SkoolManagerPage';
import SkoolEngagePage from './pages/SkoolEngagePage';
import EngagementRepliesPage from './pages/EngagementRepliesPage';

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
        <Route path="/script-generator" element={<ScriptGeneratorPage />} />
        <Route path="/video-planner" element={<VideoPlannerPage />} />
        <Route path="/channel-audit" element={<ChannelAuditPage />} />
        <Route path="/skool" element={<SkoolManagerPage />} />
        <Route path="/skool/agent" element={<SkoolEngagePage />} />
        <Route path="/engagement" element={<EngagementManagerPage />} />
        <Route path="/engagement/replies" element={<EngagementRepliesPage />} />
      </Routes>
      <BackgroundJobs />
      <Toaster theme="dark" />
    </BrowserRouter>
  );
}
