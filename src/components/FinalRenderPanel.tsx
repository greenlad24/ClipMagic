import { useState, useEffect, useCallback, useRef } from 'react';
import {
  submitRendiJob,
  pollRendiStatus,
  SubmitRendiJobOutputType,
  PollRendiStatusOutputType,
} from 'zite-endpoints-sdk';
import {
  Loader2, Film, CheckCircle2, XCircle, AlertTriangle, Download, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';

// ─── Status mapping ──────────────────────────────────────────────────────────

type RenderStage = 'idle' | 'submitting' | 'queued' | 'rendering' | 'finalizing' | 'done' | 'failed';

function apiStatusToStage(status: string): RenderStage {
  const s = status.toLowerCase();
  if (s === 'submitted') return 'queued';
  if (s === 'processing') return 'rendering';
  if (s === 'done') return 'done';
  if (s === 'error') return 'failed';
  return 'rendering';
}

const STAGE_LABELS: Record<RenderStage, string> = {
  idle: 'Ready',
  submitting: 'Submitting…',
  queued: 'Queued',
  rendering: 'Rendering',
  finalizing: 'Finalizing',
  done: 'Complete',
  failed: 'Failed',
};

function StageIcon({ stage }: { stage: RenderStage }) {
  if (stage === 'done') return <CheckCircle2 className="w-5 h-5 text-primary" />;
  if (stage === 'failed') return <XCircle className="w-5 h-5 text-destructive" />;
  if (stage === 'idle') return <Film className="w-5 h-5 text-muted-foreground" />;
  return <Loader2 className="w-5 h-5 text-primary animate-spin" />;
}

function stagePct(stage: RenderStage): number {
  if (stage === 'submitting') return 0.05;
  if (stage === 'queued') return 0.15;
  if (stage === 'rendering') return 0.5;
  if (stage === 'finalizing') return 0.85;
  if (stage === 'done') return 1;
  if (stage === 'failed') return 0;
  return 0;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface FinalRenderPanelProps {
  projectId: string;
  disabled?: boolean;
}

export default function FinalRenderPanel({ projectId, disabled }: FinalRenderPanelProps) {
  const [stage, setStage] = useState<RenderStage>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<SubmitRendiJobOutputType['diagnostics'] | null>(null);
  const [renderMeta, setRenderMeta] = useState<{
    renderingTime: number | null;
    outputWidth: number | null;
    outputHeight: number | null;
    outputDuration: number | null;
  } | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback((renderJobRecordId: string, intervalMs: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    recordIdRef.current = renderJobRecordId;

    const poll = async () => {
      try {
        const res: PollRendiStatusOutputType = await pollRendiStatus({ renderJobRecordId });
        const mapped = apiStatusToStage(res.status);

        if (mapped === 'rendering' && res.renderingTime && res.outputDuration &&
            res.renderingTime > res.outputDuration * 0.8) {
          setStage('finalizing');
        } else {
          setStage(mapped);
        }

        if (res.terminal) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;

          if (mapped === 'done') {
            setOutputUrl(res.outputUrl);
            setRenderMeta({
              renderingTime: res.renderingTime,
              outputWidth: res.outputWidth,
              outputHeight: res.outputHeight,
              outputDuration: res.outputDuration,
            });
            toast.success('Final render complete!');
          } else {
            setErrorMessage(res.errorMessage ?? 'Unknown render error');
            toast.error('Final render failed');
          }
        }
      } catch (e: any) {
        console.warn('[FinalRender] poll error:', e?.message);
      }
    };

    poll();
    pollRef.current = setInterval(poll, intervalMs);
  }, []);

  const handleSubmit = async () => {
    setShowConfirm(false);
    setStage('submitting');
    setErrorMessage(null);
    setOutputUrl(null);
    setDiagnostics(null);
    setRenderMeta(null);

    try {
      const res = await submitRendiJob({ projectId });
      setDiagnostics(res.diagnostics);
      setStage('queued');
      toast.success(`Render job submitted (${res.diagnostics.totalScenes} scenes)`);
      startPolling(res.renderJobRecordId, 5000);
    } catch (e: any) {
      setStage('failed');
      const msg = e?.message ?? 'Submission failed';
      setErrorMessage(msg);
      toast.error('Render submission failed');
    }
  };

  const isActive = stage !== 'idle' && stage !== 'done' && stage !== 'failed';
  const pct = stagePct(stage);

  if (stage === 'idle') {
    return (
      <>
        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs gap-1.5"
          onClick={() => setShowConfirm(true)}
          disabled={disabled}
          title="Submit a high-quality render via Rendi FFmpeg"
        >
          <Film className="w-3.5 h-3.5" />
          Final Render
        </Button>

        <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Submit Final Render?</AlertDialogTitle>
              <AlertDialogDescription>
                This will fetch the narration video from your Dropbox <strong>/Narration input</strong> folder
                (matched by project title) and send it to Rendi for high-quality FFmpeg server-side rendering.
                Output: H.264/AAC MP4, 1080×1920 vertical, with burned subtitles and background music.
                The render typically takes 2–8 minutes depending on video length.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleSubmit}>
                <Film className="w-4 h-4 mr-2" />
                Submit Render
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-card border border-border rounded-2xl p-8 w-[440px] shadow-xl flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
            stage === 'failed' ? 'bg-destructive/10' : 'bg-primary/10'
          }`}>
            <StageIcon stage={stage} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Final Render</p>
            <p className="text-xs text-muted-foreground">
              {STAGE_LABELS[stage]}
              {stage === 'rendering' && ' — server-side via Rendi FFmpeg'}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        {isActive && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{STAGE_LABELS[stage]}</span>
              <span className="text-primary font-mono">{(pct * 100).toFixed(0)}%</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-700"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {stage === 'submitting' && 'Validating assets, uploading subtitles, and submitting to Rendi…'}
              {stage === 'queued' && 'Your FFmpeg job is queued. Rendering will start shortly.'}
              {stage === 'rendering' && 'Rendi is compositing your video with FFmpeg. This usually takes 2–8 minutes.'}
              {stage === 'finalizing' && 'Almost done — encoding the final H.264 output.'}
            </p>
          </div>
        )}

        {/* Diagnostics */}
        {diagnostics && isActive && (
          <div className="bg-muted/60 rounded-lg p-3 space-y-1 text-[11px] font-mono text-muted-foreground">
            <div className="flex justify-between"><span>Scenes</span><span className="text-foreground">{diagnostics.totalScenes}</span></div>
            <div className="flex justify-between"><span>Subtitles</span><span className="text-foreground">{diagnostics.hasSubtitles ? `${diagnostics.srtLineCount} lines` : 'None'}</span></div>
            <div className="flex justify-between"><span>Music</span><span className="text-foreground">{diagnostics.hasMusic ? 'Yes (8% vol)' : 'No'}</span></div>
            <div className="flex justify-between"><span>Payload</span><span className="text-foreground">{diagnostics.estimatedPayloadKB} KB</span></div>
          </div>
        )}

        {/* Done */}
        {stage === 'done' && (
          <div className="space-y-4">
            <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Render complete!</p>
                <p className="text-xs text-muted-foreground">Your H.264/AAC 1080×1920 video is ready.</p>
              </div>
            </div>

            {renderMeta && (
              <div className="bg-muted/60 rounded-lg p-3 space-y-1 text-[11px] font-mono text-muted-foreground">
                {renderMeta.outputWidth && renderMeta.outputHeight && (
                  <div className="flex justify-between"><span>Resolution</span><span className="text-foreground">{renderMeta.outputWidth}×{renderMeta.outputHeight}</span></div>
                )}
                {renderMeta.outputDuration != null && (
                  <div className="flex justify-between"><span>Duration</span><span className="text-foreground">{renderMeta.outputDuration.toFixed(1)}s</span></div>
                )}
                {renderMeta.renderingTime != null && (
                  <div className="flex justify-between"><span>Render time</span><span className="text-foreground">{renderMeta.renderingTime.toFixed(1)}s</span></div>
                )}
              </div>
            )}

            {outputUrl && (
              <a
                href={outputUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <Download className="w-4 h-4" />
                Download Final Video
                <ExternalLink className="w-3 h-3 opacity-60" />
              </a>
            )}

            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => { setStage('idle'); setOutputUrl(null); setDiagnostics(null); setRenderMeta(null); }}
            >
              Close
            </Button>
          </div>
        )}

        {/* Failed */}
        {stage === 'failed' && (
          <div className="space-y-4">
            <div className="bg-destructive/5 border border-destructive/20 rounded-lg p-4 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-destructive">Render failed</p>
                  {errorMessage && (
                    <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                      {errorMessage}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => { setStage('idle'); setErrorMessage(null); setDiagnostics(null); }}
              >
                Close
              </Button>
              <Button
                size="sm"
                className="flex-1 gap-1.5"
                onClick={handleSubmit}
              >
                <Film className="w-3.5 h-3.5" />
                Retry
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
