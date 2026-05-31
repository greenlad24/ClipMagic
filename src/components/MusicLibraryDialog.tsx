import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { getMusicTracks, saveMusicTrack, deleteMusicTrack } from 'zite-endpoints-sdk';
import { uploadBlobToR2 } from '@/utils/videoUtils';
import { GetMusicTracksOutputType } from 'zite-endpoints-sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Trash2, Music, Upload, CheckCircle2, Loader2 } from 'lucide-react';

type Track = GetMusicTracksOutputType['tracks'][0];
const MOODS = ['Tech', 'Cinematic', 'Urgent', 'Corporate', 'Hype', 'Warm'];

interface Props { open: boolean; onClose: () => void; onTracksChange: () => void; }

export default function MusicLibraryDialog({ open, onClose, onTracksChange }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ name: '', bpm: '', key: '', duration: '', mood: [] as string[] });
  const [audioFile, setAudioFile] = useState<File | null>(null);

  const reload = async () => {
    const { tracks: t } = await getMusicTracks({});
    setTracks(t);
  };

  useEffect(() => { if (open) reload(); }, [open]);

  const toggleMood = (m: string) =>
    setForm((f) => ({ ...f, mood: f.mood.includes(m) ? f.mood.filter((x) => x !== m) : [...f.mood, m] }));

  const handleSubmit = async () => {
    if (!audioFile || !form.name || !form.bpm) { toast.error('Name, BPM and audio file are required'); return; }
    setUploading(true);
    try {
      const audioUrl = await uploadBlobToR2(audioFile, audioFile.name);
      await saveMusicTrack({
        trackName: form.name,
        audioUrl,
        bpm: parseFloat(form.bpm),
        key: form.key || undefined,
        mood: form.mood.length ? form.mood : ['Tech', 'Cinematic'],
        durationSeconds: form.duration ? parseFloat(form.duration) : undefined,
      });
      toast.success(`"${form.name}" added to library`);
      setForm({ name: '', bpm: '', key: '', duration: '', mood: [] });
      setAudioFile(null);
      await reload();
      onTracksChange();
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to save track');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string, name?: string) => {
    await deleteMusicTrack({ trackId: id });
    toast.success(`"${name ?? 'Track'}" removed`);
    await reload();
    onTracksChange();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg bg-card border-border">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Music className="w-4 h-4 text-primary" /> Music Library</DialogTitle></DialogHeader>

        <div className="space-y-2 max-h-44 overflow-y-auto">
          {tracks.length === 0 && <p className="text-sm text-muted-foreground py-2">No tracks yet. Upload your first track below.</p>}
          {tracks.map((t) => (
            <div key={t.id} className="flex items-center gap-3 p-2.5 bg-muted rounded-lg">
              {t.analysisStatus === 'Ready' ? <CheckCircle2 className="w-4 h-4 text-primary shrink-0" /> : <Loader2 className="w-4 h-4 text-muted-foreground shrink-0 animate-spin" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{t.trackName}</p>
                <p className="text-xs text-muted-foreground">{t.bpm} BPM{t.key ? ` · ${t.key}` : ''}{t.durationSeconds ? ` · ${Math.round(t.durationSeconds)}s` : ''}</p>
              </div>
              <Button variant="ghost" size="icon" className="shrink-0 h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => handleDelete(t.id, t.trackName)}><Trash2 className="w-3.5 h-3.5" /></Button>
            </div>
          ))}
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Add track</p>
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs">Track name *</Label><Input placeholder="Tech Pulse" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="mt-1 h-8 text-sm" /></div>
            <div><Label className="text-xs">BPM *</Label><Input type="number" placeholder="124" value={form.bpm} onChange={(e) => setForm((f) => ({ ...f, bpm: e.target.value }))} className="mt-1 h-8 text-sm" /></div>
            <div><Label className="text-xs">Key (optional)</Label><Input placeholder="F minor" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} className="mt-1 h-8 text-sm" /></div>
            <div><Label className="text-xs">Duration (seconds)</Label><Input type="number" placeholder="90" value={form.duration} onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))} className="mt-1 h-8 text-sm" /></div>
          </div>
          <div>
            <Label className="text-xs">Mood tags</Label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {MOODS.map((m) => (
                <Badge key={m} variant={form.mood.includes(m) ? 'default' : 'secondary'} className="cursor-pointer text-xs" onClick={() => toggleMood(m)}>{m}</Badge>
              ))}
            </div>
          </div>
          <div>
            <Label className="text-xs">WAV / MP3 file *</Label>
            <label className="mt-1 flex items-center gap-2 px-3 py-2 bg-muted border border-border rounded-lg cursor-pointer hover:border-primary/40 transition-colors">
              <Upload className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{audioFile ? audioFile.name : 'Choose audio file…'}</span>
              <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setAudioFile(f); }} />
            </label>
          </div>
          <Button onClick={handleSubmit} disabled={uploading} className="w-full">
            {uploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Uploading…</> : 'Add track'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
