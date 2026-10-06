import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
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
import MemePage from './pages/MemePage';
import PostizSettingsPage from './pages/PostizSettingsPage';
import BulkSchedulerPage from './pages/BulkSchedulerPage';
import ThumbnailDesignerPage from './pages/ThumbnailDesignerPage';
import ImageGeneratorPage from './pages/ImageGeneratorPage';
import KeywordResearchPage from './pages/KeywordResearchPage';
import RenderQueuePage from './pages/RenderQueuePage';
import ScriptGeneratorPage from './pages/ScriptGeneratorPage';
import EngagementManagerPage from './pages/EngagementManagerPage';
import VideoPlannerPage from './pages/VideoPlannerPage';
import ChannelAuditPage from './pages/ChannelAuditPage';
import { dealOrganizerRoutes } from './deals/routes';
import SkoolManagerPage from './pages/SkoolManagerPage';
import SkoolEngagePage from './pages/SkoolEngagePage';
import EngagementRepliesPage from './pages/EngagementRepliesPage';
import AvatarNarratorPage from './pages/AvatarNarratorPage';
import TutorialStudioPage from './pages/TutorialStudioPage';
import DensityCheckPage from './pages/DensityCheckPage';
import VideoEditorPage from './pages/VideoEditorPage';
import AutoEditorPage from './pages/AutoEditorPage';
import CodeImportPage from './pages/CodeImportPage';
import NewsDashboardPage from './news/pages/DashboardPage';
import NewsAudiencePage from './news/pages/AudiencePage';
import NewsNotesPage from './news/pages/NotesPage';
import NewsDisplayPage from './news/pages/DisplayPage';
import NewsVideoPage from './news/pages/VideoPage';
import NewsTeleprompterPage from './news/pages/TeleprompterPage';
import NewsSettingsPage from './news/pages/SettingsPage';
import DeepDiveListPage from './news/deepdive/DeepDiveListPage';
import DeepDiveEditorPage from './news/deepdive/DeepDiveEditorPage';
import DeepDiveStagePage from './news/deepdive/DeepDiveStagePage';
import DeepDivePresenterPage from './news/deepdive/DeepDivePresenterPage';

// The Lab's floating Jobs panel, except on the AI News Stream pages — those
// are full-screen presenter/teleprompter views with their own bottom bars.
function LabJobs() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/news-gatherer') || pathname.startsWith('/deal-organizer')) return null;
  return <BackgroundJobs />;
}

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
        <Route path="/meme" element={<MemePage />} />
        <Route path="/render-queue" element={<RenderQueuePage />} />
        <Route path="/density" element={<DensityCheckPage />} />
        <Route path="/density/:id" element={<DensityCheckPage />} />
        <Route path="/auto-editor" element={<AutoEditorPage />} />
        <Route path="/auto-editor/:id" element={<AutoEditorPage />} />
        <Route path="/video-editor" element={<VideoEditorPage />} />
        <Route path="/video-editor/:id" element={<VideoEditorPage />} />
        <Route path="/settings/postiz" element={<PostizSettingsPage />} />
        <Route path="/bulk-scheduler" element={<BulkSchedulerPage />} />
        <Route path="/thumbnail-designer" element={<ThumbnailDesignerPage />} />
        <Route path="/image-generator" element={<ImageGeneratorPage />} />
        <Route path="/avatar-narrator" element={<AvatarNarratorPage />} />
        <Route path="/tutorial-studio" element={<TutorialStudioPage />} />
        <Route path="/keyword-research" element={<KeywordResearchPage />} />
        <Route path="/script-generator" element={<ScriptGeneratorPage />} />
        <Route path="/video-planner" element={<VideoPlannerPage />} />
        <Route path="/channel-audit" element={<ChannelAuditPage />} />
        <Route path="/skool" element={<SkoolManagerPage />} />
        <Route path="/skool/agent" element={<SkoolEngagePage />} />
        <Route path="/engagement" element={<EngagementManagerPage />} />
        <Route path="/engagement/replies" element={<EngagementRepliesPage />} />
        <Route path="/code-import" element={<CodeImportPage />} />
        {dealOrganizerRoutes}
        <Route path="/news-gatherer" element={<Navigate to="/news-gatherer/dashboard" replace />} />
        <Route path="/news-gatherer/dashboard" element={<NewsDashboardPage />} />
        <Route path="/news-gatherer/curate" element={<Navigate to="/news-gatherer/dashboard" replace />} />
        <Route path="/news-gatherer/present/audience" element={<NewsAudiencePage />} />
        <Route path="/news-gatherer/present/notes" element={<NewsNotesPage />} />
        <Route path="/news-gatherer/present/display" element={<NewsDisplayPage />} />
        <Route path="/news-gatherer/present/video" element={<NewsVideoPage />} />
        <Route path="/news-gatherer/present/teleprompter" element={<NewsTeleprompterPage />} />
        <Route path="/news-gatherer/settings" element={<NewsSettingsPage />} />
        <Route path="/news-gatherer/deep-dive" element={<DeepDiveListPage />} />
        <Route path="/news-gatherer/deep-dive/:id" element={<DeepDiveEditorPage />} />
        <Route path="/news-gatherer/deep-dive/:id/present" element={<DeepDiveStagePage />} />
        <Route path="/news-gatherer/deep-dive/:id/presenter" element={<DeepDivePresenterPage />} />
      </Routes>
      <LabJobs />
      <Toaster theme="dark" />
    </BrowserRouter>
  );
}
