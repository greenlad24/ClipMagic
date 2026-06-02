import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProjects, getMusicTracks, deleteProject } from 'zite-endpoints-sdk';
import { GetProjectsOutputType, GetMusicTracksOutputType } from 'zite-endpoints-sdk';
import { useAuth } from 'zite-auth-sdk';
import Layout from '@/components/Layout';
import UploadZone from '@/components/UploadZone';
import ProjectCard from '@/components/ProjectCard';
import MusicLibraryDialog from '@/components/MusicLibraryDialog';
import PromoVideosDialog from '@/components/PromoVideosDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Library, Settings, Trash2, CheckSquare, Square, X, Video, HardDrive, Scissors } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';

type Project = GetProjectsOutputType['projects'][0];
type Track = GetMusicTracksOutputType['tracks'][0];

const ACCENT_PRESETS = ['#FFD60A', '#00D4FF', '#FF3366', '#00FF88'];

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showPromoVideos, setShowPromoVideos] = useState(false);
  const [contextHint, setContextHint] = useState('');
  const [accentColor, setAccentColor] = useState('#FFD60A');
  const [selectedTrackId, setSelectedTrackId] = useState('auto');

  // Selection / delete state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<string[] | null>(null); // IDs to confirm delete
  const [isDeleting, setIsDeleting] = useState(false);

  const loadData = useCallback(async () => {
    if (!user) return;
    const [{ projects: p }, { tracks: t }] = await Promise.all([getProjects({}), getMusicTracks({})]);
    setProjects(p);
    setTracks(t.filter((tr) => tr.analysisStatus === 'Ready'));
  }, [user]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleProjectCreated = (projectId: string) => navigate(`/project/${projectId}/processing`);

  const readyTracks = tracks.filter((t) => t.analysisStatus === 'Ready');

  // Selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(projects.map((p) => p.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  // Delete flow
  const confirmDelete = (ids: string[]) => setDeleteTarget(ids);

  const executeDelete = async () => {
    if (!deleteTarget || deleteTarget.length === 0) return;
    setIsDeleting(true);
    try {
      await deleteProject({ projectIds: deleteTarget });
      setProjects((prev) => prev.filter((p) => !deleteTarget.includes(p.id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        deleteTarget.forEach((id) => next.delete(id));
        return next;
      });
      const count = deleteTarget.length;
      toast.success(`${count} short${count > 1 ? 's' : ''} deleted`);
      if (selectedIds.size > 0 && deleteTarget.every((id) => selectedIds.has(id))) {
        exitSelectionMode();
      }
    } catch {
      toast.error('Failed to delete. Please try again.');
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <Layout>
      <Toaster />
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="text-center mb-10 relative">
          <h1 className="text-3xl font-bold text-foreground mb-2">Turn your narration into a Short</h1>
          <p className="text-muted-foreground">Drop a vertical video (9:16 · 15–90s). The AI locks it to the formula — beat-synced cuts, screencasts, captions.</p>
          <div className="absolute top-0 right-0 flex items-center gap-4">
            <Link
              to="/bulk"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Video className="w-3.5 h-3.5" />
              Bulk videos
            </Link>
            <Link
              to="/cutter"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Scissors className="w-3.5 h-3.5" />
              Narration Cutter
            </Link>
            <Link
              to="/storage"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <HardDrive className="w-3.5 h-3.5" />
              Files
            </Link>
            <Link
              to="/setup"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Settings className="w-3.5 h-3.5" />
              Setup
            </Link>
          </div>
        </div>

        <UploadZone
          contextHint={contextHint}
          accentColor={accentColor}
          musicTrackId={selectedTrackId === 'auto' ? undefined : selectedTrackId}
          onProjectCreated={handleProjectCreated}
        />

        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setShowPromoVideos(true)}>
            <Video className="w-3.5 h-3.5" />
            Promo Video Library
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-5">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">What's this about? <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Input placeholder='e.g. "Gemini 3 builds entire UIs"' value={contextHint} onChange={(e) => setContextHint(e.target.value)} className="text-sm" />
            <p className="text-xs text-muted-foreground mt-1">Leave blank — AI detects from audio.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Caption accent color</label>
            <div className="flex items-center gap-2">
              {ACCENT_PRESETS.map((c) => (
                <button key={c} onClick={() => setAccentColor(c)} className={`w-6 h-6 rounded-full border-2 transition-all ${accentColor === c ? 'border-foreground scale-110' : 'border-transparent'}`} style={{ backgroundColor: c }} />
              ))}
              <Input value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="w-24 text-xs font-mono h-7" maxLength={7} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Music track</label>
            <div className="flex gap-2">
              <Select value={selectedTrackId} onValueChange={setSelectedTrackId}>
                <SelectTrigger className="flex-1 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (match mood)</SelectItem>
                  {readyTracks.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.trackName} · {t.bpm} BPM</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon" onClick={() => setShowLibrary(true)} title="Manage library">
                <Library className="w-4 h-4" />
              </Button>
            </div>
            {readyTracks.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">No tracks yet. <button className="underline" onClick={() => setShowLibrary(true)}>Add one</button></p>
            )}
          </div>
        </div>

        {projects.length > 0 && (
          <div className="mt-12">
            {/* Section header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground">Recent shorts</h2>
              <div className="flex items-center gap-2">
                {selectionMode ? (
                  <>
                    <button
                      onClick={selectedIds.size === projects.length ? clearSelection : selectAll}
                      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {selectedIds.size === projects.length
                        ? <><CheckSquare className="w-3.5 h-3.5" /> Deselect all</>
                        : <><Square className="w-3.5 h-3.5" /> Select all</>
                      }
                    </button>
                    {selectedIds.size > 0 && (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => confirmDelete(Array.from(selectedIds))}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete {selectedIds.size}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs gap-1"
                      onClick={exitSelectionMode}
                    >
                      <X className="w-3.5 h-3.5" /> Cancel
                    </Button>
                  </>
                ) : (
                  <button
                    onClick={() => setSelectionMode(true)}
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <CheckSquare className="w-3.5 h-3.5" />
                    Select
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(p.id)}
                  onToggleSelect={toggleSelect}
                  onDeleteSingle={(id) => confirmDelete([id])}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <MusicLibraryDialog
        open={showLibrary}
        onClose={() => setShowLibrary(false)}
        onTracksChange={loadData}
      />

      <PromoVideosDialog open={showPromoVideos} onClose={() => setShowPromoVideos(false)} />

      {/* Confirm delete dialog */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.length === 1 ? 'this short' : `${deleteTarget?.length} shorts`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the {deleteTarget?.length === 1 ? 'short' : 'selected shorts'} and all associated shots. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
