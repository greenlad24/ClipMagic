import { useState, useRef, useCallback } from 'react';
import { Upload, Film, Music2, Loader2, HardDrive } from 'lucide-react';
import { createProject } from 'zite-endpoints-sdk';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { extractAudio, uploadBlobToR2, uploadBlobToZite } from '@/utils/videoUtils';
import { validateNarrationMeta } from '@/utils/videoValidation';
import StoragePickerDialog, { type StoredFile } from '@/components/StoragePickerDialog';

interface Props {
  contextHint: string;
  accentColor: string;
  musicTrackId?: string;
  /** Per-video motion-graphics toggle (default on). */
  motionGraphics?: boolean;
  /** Per-video auto-screencast toggle (default on). */
  autoScreencast?: boolean;
  onProjectCreated: (projectId: string) => void;
}

function readVideoMeta(src: string, onDone?: () => void): Promise<{ duration: number; aspectRatio: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const { duration, videoWidth, videoHeight } = video;
      onDone?.();
      resolve({ duration, aspectRatio: videoWidth / videoHeight });
    };
    video.onerror = () => { onDone?.(); reject(new Error('Invalid video')); };
    video.src = src;
  });
}

async function getVideoMeta(file: File): Promise<{ duration: number; aspectRatio: number }> {
  const url = URL.createObjectURL(file);
  return readVideoMeta(url, () => URL.revokeObjectURL(url));
}

type Step = 'idle' | 'extracting' | 'uploading' | 'creating';

export default function UploadZone({ contextHint, accentColor, musicTrackId, motionGraphics = true, autoScreencast = true, onProjectCreated }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [progress, setProgress] = useState(0);
  const [chunkInfo, setChunkInfo] = useState({ done: 0, total: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!['video/mp4', 'video/quicktime'].includes(file.type)) {
      toast.error('Please upload an MP4 or MOV file'); return;
    }

    try {
      const { duration, aspectRatio } = await getVideoMeta(file);
      const err = validateNarrationMeta(duration, aspectRatio);
      if (err) { toast.error(err); return; }
    } catch { toast.error('Could not read video metadata — is the file a valid video?'); return; }

    // Step 1: Extract audio track (fast offline decode — 1–5 s)
    setStep('extracting'); setProgress(5);
    let audioUrl: string | undefined;
    try {
      const audioBlob = await extractAudio(file);
      setProgress(12);
      audioUrl = await uploadBlobToR2(
        audioBlob,
        file.name.replace(/\.[^.]+$/, '') + '_audio.wav',
      );
      setProgress(18);
    } catch (err) {
      // Non-fatal: Whisper will fall back to the first video chunk
      console.warn('Audio extraction/upload skipped:', err);
    }

    // Step 2: Upload the whole video as a single file (no chunking — the
    // self-hosted server has no 25 MB cap, so one file is simpler and keeps the
    // narration intact for rendering).
    setStep('uploading');
    setChunkInfo({ done: 0, total: 1 });
    let videoUrl: string;
    try {
      videoUrl = await uploadBlobToZite(file, file.name);
      setChunkInfo({ done: 1, total: 1 });
      setProgress(90);
    } catch (err: any) {
      toast.error('Video upload failed — ' + (err.message?.slice(0, 80) ?? 'please try again'));
      setStep('idle'); setProgress(0);
      return;
    }

    // Guard — if we somehow end up with no URL, bail out clearly
    if (!videoUrl) {
      toast.error('Upload produced no valid URL — please try again');
      setStep('idle'); setProgress(0);
      return;
    }

    // Step 3: Create project record (single narration file + extracted audio)
    setStep('creating'); setProgress(95);
    try {
      const { projectId } = await createProject({
        narrationUrl: videoUrl,
        contextHint: contextHint || undefined,
        accentColor,
        musicTrackId: musicTrackId || undefined,
        motionGraphics,
        autoScreencast,
        audioUrl,
        videoChunksJson: JSON.stringify([videoUrl]),
      });
      setProgress(100);
      onProjectCreated(projectId);
    } catch (err: any) {
      toast.error('Could not create project — ' + (err.message?.slice(0, 80) ?? 'please try again'));
      setStep('idle'); setProgress(0);
    }
  }, [contextHint, accentColor, musicTrackId, onProjectCreated]);

  // Reuse a file already in storage: no extract, no re-upload — just validate it
  // against the same vertical / 15–90s rules and create the project from its URL.
  const handleStored = useCallback(async (picked: StoredFile[]) => {
    const item = picked[0];
    if (!item?.url) return;

    setStep('creating'); setProgress(20);
    try {
      const { duration, aspectRatio } = await readVideoMeta(item.url);
      const err = validateNarrationMeta(duration, aspectRatio);
      if (err) { toast.error(err); setStep('idle'); setProgress(0); return; }
    } catch {
      toast.error('Could not read that file — it may not be a valid video.');
      setStep('idle'); setProgress(0); return;
    }

    setProgress(60);
    try {
      const { projectId } = await createProject({
        narrationUrl: item.url,
        contextHint: contextHint || undefined,
        accentColor,
        musicTrackId: musicTrackId || undefined,
        motionGraphics,
        autoScreencast,
        // No separately-extracted audio — the pipeline falls back to the video.
        videoChunksJson: JSON.stringify([item.url]),
      });
      setProgress(100);
      onProjectCreated(projectId);
    } catch (err: any) {
      toast.error('Could not create project — ' + (err.message?.slice(0, 80) ?? 'please try again'));
      setStep('idle'); setProgress(0);
    }
  }, [contextHint, accentColor, musicTrackId, motionGraphics, autoScreencast, onProjectCreated]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const isActive = step !== 'idle';

  const stepLabel =
    step === 'extracting' ? 'Extracting audio track…' :
    step === 'uploading'  ? 'Uploading video…' :
    step === 'creating'   ? 'Creating project…' : '';

  const StepIcon =
    step === 'extracting' ? <Music2 className="w-10 h-10 text-primary animate-pulse" /> :
    step === 'uploading'  ? <Film className="w-10 h-10 text-primary animate-pulse" /> :
    <Loader2 className="w-10 h-10 text-primary animate-spin" />;

  return (
    <>
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => !isActive && inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-14 flex flex-col items-center gap-4 transition-colors cursor-pointer
          ${isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/10 hover:border-primary/40'}`}
      >
        <input ref={inputRef} type="file" accept="video/mp4,video/quicktime" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />

        {isActive ? (
          <div className="flex flex-col items-center gap-3 w-full max-w-xs">
            {StepIcon}
            <p className="text-sm font-medium text-foreground text-center">{stepLabel}</p>
            <Progress value={progress} className="h-1.5 w-full" />
            <p className="text-xs text-muted-foreground">{progress}%</p>
          </div>
        ) : (
          <>
            <Upload className="w-10 h-10 text-muted-foreground" />
            <div className="text-center">
              <p className="font-semibold text-foreground text-lg">Drop your narration video here</p>
              <p className="text-sm text-muted-foreground mt-1">
                or click to browse · MP4 or MOV · 9:16 · 15–90 s · up to 500 MB
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm">Choose file</Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={(e) => { e.stopPropagation(); setPickerOpen(true); }}
              >
                <HardDrive className="w-3.5 h-3.5" /> Choose from storage
              </Button>
            </div>
          </>
        )}
      </div>

      <StoragePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleStored}
        description="Reuse a vertical narration you already uploaded — no re-upload needed."
      />
    </>
  );
}
