import { useState, useRef, useCallback } from 'react';
import { Upload, Film, Music2, Loader2 } from 'lucide-react';
import { createProject } from 'zite-endpoints-sdk';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { extractAudio, uploadVideoChunks, uploadBlobToR2 } from '@/utils/videoUtils';

interface Props {
  contextHint: string;
  accentColor: string;
  musicTrackId?: string;
  onProjectCreated: (projectId: string) => void;
}

async function getVideoMeta(file: File): Promise<{ duration: number; aspectRatio: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const { duration, videoWidth, videoHeight } = video;
      URL.revokeObjectURL(url);
      resolve({ duration, aspectRatio: videoWidth / videoHeight });
    };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Invalid video')); };
    video.src = url;
  });
}

type Step = 'idle' | 'extracting' | 'uploading' | 'creating';

export default function UploadZone({ contextHint, accentColor, musicTrackId, onProjectCreated }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [progress, setProgress] = useState(0);
  const [chunkInfo, setChunkInfo] = useState({ done: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!['video/mp4', 'video/quicktime'].includes(file.type)) {
      toast.error('Please upload an MP4 or MOV file'); return;
    }

    try {
      const { duration, aspectRatio } = await getVideoMeta(file);
      if (aspectRatio > 0.7) { toast.error('Video must be vertical (9:16 aspect ratio)'); return; }
      if (duration < 15 || duration > 90) { toast.error('Video must be 15–90 seconds long'); return; }
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

    // Step 2: Upload video in 20 MB chunks
    setStep('uploading');
    let chunkUrls: string[] = [];
    try {
      chunkUrls = await uploadVideoChunks(file, (done, total) => {
        setChunkInfo({ done, total });
        setProgress(18 + Math.round((done / total) * 72));
      });
    } catch (err: any) {
      toast.error('Video upload failed — ' + (err.message?.slice(0, 80) ?? 'please try again'));
      setStep('idle'); setProgress(0);
      return;
    }

    // Guard — if we somehow end up with no chunk URLs, bail out clearly
    if (!chunkUrls.length || !chunkUrls[0]) {
      toast.error('Upload produced no valid URLs — please try again');
      setStep('idle'); setProgress(0);
      return;
    }

    // Step 3: Create project record
    setStep('creating'); setProgress(95);
    try {
      const { projectId } = await createProject({
        narrationUrl: chunkUrls[0],
        contextHint: contextHint || undefined,
        accentColor,
        musicTrackId: musicTrackId || undefined,
        audioUrl,
        videoChunksJson: JSON.stringify(chunkUrls),
      });
      setProgress(100);
      onProjectCreated(projectId);
    } catch (err: any) {
      toast.error('Could not create project — ' + (err.message?.slice(0, 80) ?? 'please try again'));
      setStep('idle'); setProgress(0);
    }
  }, [contextHint, accentColor, musicTrackId, onProjectCreated]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const isActive = step !== 'idle';

  const stepLabel =
    step === 'extracting' ? 'Extracting audio track…' :
    step === 'uploading'  ? `Uploading video — chunk ${chunkInfo.done} of ${chunkInfo.total}` :
    step === 'creating'   ? 'Creating project…' : '';

  const StepIcon =
    step === 'extracting' ? <Music2 className="w-10 h-10 text-primary animate-pulse" /> :
    step === 'uploading'  ? <Film className="w-10 h-10 text-primary animate-pulse" /> :
    <Loader2 className="w-10 h-10 text-primary animate-spin" />;

  return (
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
          <Button variant="secondary" size="sm">Choose file</Button>
        </>
      )}
    </div>
  );
}
