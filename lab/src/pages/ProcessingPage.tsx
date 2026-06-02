import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from 'zite-auth-sdk';
import { getProject, getShots, runPipeline, captureShots, pollBrollStatus, reviewEdit } from 'zite-endpoints-sdk';
import { GetProjectOutputType, GetShotsOutputType } from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';
import KinoviDebugPanel from '@/components/KinoviDebugPanel';
import { CheckCircle2, Circle, Loader2, AlertCircle, Film } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Project = GetProjectOutputType['project'];
type Shot = GetShotsOutputType['shots'][0];

const STEPS = [
  { label: 'Transcribe narration',           status: 'Transcribing', doneFrom: 'Directing' },
  { label: 'Generate beat-locked shot list', status: 'Directing',    doneFrom: 'Capturing' },
  { label: 'Generate shot media (AI)',       status: 'Capturing',    doneFrom: 'Complete'  },
];

const STATUS_ORDER = ['Uploading', 'Transcribing', 'Directing', 'Capturing', 'Rendering', 'Complete'];

function stepState(stepDoneFrom: string, currentStatus: string): 'done' | 'active' | 'pending' {
  const cur  = STATUS_ORDER.indexOf(currentStatus);
  const done = STATUS_ORDER.indexOf(stepDoneFrom);
  if (cur >= done) return 'done';
  if (cur === done - 1) return 'active';
  return 'pending';
}

const BEAT_COLORS: Record<string, string> = {
  Hook: 'bg-primary text-primary-foreground',
  CTA:  'bg-primary text-primary-foreground',
};
const TYPE_BADGES: Record<string, string> = {
  'Talking Head': 'bg-primary/20 text-primary',
  Screencast:     'bg-blue-500/20 text-blue-400',
  'B-Roll':       'bg-green-500/20 text-green-400',
  Animation:      'bg-purple-500/20 text-purple-400',
};

/** Determine which pipeline step to resume from based on current project state */
function getResumeStep(status: string, shots: Shot[]): 'pipeline' | 'capture' | 'render' {
  if (status === 'Capturing') return 'capture';

  if (status === 'Error') {
    if (shots.length > 0) return 'capture';
    return 'pipeline';
  }

  return 'pipeline';
}

export default function ProcessingPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project,      setProject]      = useState<Project | null>(null);
  const [shots,        setShots]        = useState<Shot[]>([]);
  const [error,        setError]        = useState('');
  const [dataLoaded,   setDataLoaded]   = useState(false);
  const [brollPolling, setBrollPolling] = useState(false);
  const [brollCounts,  setBrollCounts]  = useState({ pending: 0, done: 0, failed: 0 });

  const [reviewing, setReviewing] = useState(false);
  const pipelineStarted = useRef(false);
  const navigated       = useRef(false);
  const reviewRan       = useRef(false);
  const resumeStep      = useRef<'pipeline' | 'capture' | 'render' | null>(null);

  // Run the AI self-review (accuracy pass) once, then go to the editor. Review
  // failures are non-fatal — we still open the timeline.
  const finishToTimeline = useRef<() => Promise<void>>(async () => {});
  finishToTimeline.current = async () => {
    if (navigated.current) return;
    if (!reviewRan.current) {
      reviewRan.current = true;
      setReviewing(true);
      try {
        const r = await reviewEdit({ projectId: projectId! });
        console.log('[ProcessingPage] reviewEdit:', r);
        // The review may have queued new AI-generated clips — wait for them.
        // (reviewRan stays true, so the next finishToTimeline after this
        // polling round skips straight to the editor.)
        if (r && r.pendingBroll > 0) {
          setReviewing(false);
          setBrollCounts({ pending: r.pendingBroll, done: 0, failed: 0 });
          setBrollPolling(true);
          return;
        }
      } catch (e: any) {
        console.warn('[ProcessingPage] reviewEdit failed (non-fatal):', e?.message);
      } finally {
        setReviewing(false);
      }
    }
    if (!navigated.current) {
      navigated.current = true;
      navigate(`/project/${projectId}/timeline`);
    }
  };

  // ── Initial load — determines resume point before pipeline fires ────────────
  useEffect(() => {
    if (!user || !projectId) return;
    Promise.all([getProject({ projectId }), getShots({ projectId })]).then(
      ([{ project: p }, { shots: s }]) => {
        setProject(p);
        setShots(s);
        resumeStep.current = getResumeStep(p?.status ?? 'Uploading', s);
        setDataLoaded(true);
      }
    );
  }, [user, projectId]);

  // ── Background polling — keeps status indicators and shot list fresh ─────────
  useEffect(() => {
    if (!user || !projectId) return;
    const poll = setInterval(async () => {
      const [{ project: p }, { shots: s }] = await Promise.all([
        getProject({ projectId }),
        getShots({ projectId }),
      ]);
      setProject(p);
      setShots(s);
    }, 3000);
    return () => clearInterval(poll);
  }, [user, projectId]);

  // ── Orchestrate pipeline — waits for initial data load ─────────────────────
  useEffect(() => {
    if (!dataLoaded || !projectId || pipelineStarted.current) return;
    pipelineStarted.current = true;

    const step = resumeStep.current ?? 'pipeline';

    let chain: Promise<any>;
    if (step === 'capture') {
      chain = captureShots({ projectId });
    } else {
      chain = runPipeline({ projectId }).then(() => captureShots({ projectId }));
    }

    chain
      .then((result) => {
        // If B-Roll tasks were created (pending > 0), enter polling phase
        if (result && result.pendingBroll > 0) {
          setBrollCounts({ pending: result.pendingBroll, done: 0, failed: 0 });
          setBrollPolling(true);
        } else {
          finishToTimeline.current();
        }
      })
      .catch((err: any) => {
        setError(err.message ?? 'Pipeline failed. Please create a new project.');
      });
  }, [dataLoaded, projectId, navigate]);

  // ── B-Roll polling phase — calls pollBrollStatus every 5s ──────────────────
  useEffect(() => {
    if (!brollPolling || !projectId || navigated.current) return;

    const poll = setInterval(async () => {
      try {
        const result = await pollBrollStatus({ projectId });
        setBrollCounts(result);

        if (result.pending === 0) {
          clearInterval(poll);
          finishToTimeline.current();
        }
      } catch (e: any) {
        // Transient errors — keep polling
        console.warn('[ProcessingPage] pollBrollStatus error:', e?.message);
      }
    }, 5000);

    return () => clearInterval(poll);
  }, [brollPolling, projectId, navigate]);

  const status = project?.status ?? 'Uploading';
  const transcriptWords = (project?.transcript ?? '').split(' ').slice(0, 80).join(' ');

  const resumeLabel: Record<string, string> = {
    render:   'Resuming from capture…',
    capture:  'Resuming from capture…',
    pipeline: status === 'Error' ? 'Retrying pipeline…' : status + '…',
  };

  let headingText: string;
  if (reviewing) {
    headingText = 'AI reviewing the edit for accuracy…';
  } else if (brollPolling) {
    headingText = `Generating B-Roll video… (${brollCounts.pending} remaining)`;
  } else if (status === 'Error') {
    headingText = resumeStep.current ? resumeLabel[resumeStep.current] : 'Retrying…';
  } else if (resumeStep.current && resumeStep.current !== 'pipeline') {
    headingText = resumeLabel[resumeStep.current];
  } else {
    headingText = status + '…';
  }

  return (
    <Layout breadcrumb={project?.title ?? 'Processing…'}>
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Phase progress bar */}
        <div className="flex gap-1 mb-8">
          {(['Transcribe', 'Direct', 'Capture'] as const).map((phase, i) => {
            const startIdx = i + 1;
            const cur = STATUS_ORDER.indexOf(status);
            const phaseStatus = cur > startIdx ? 'done' : cur === startIdx ? 'active' : 'pending';
            return (
              <div
                key={phase}
                className={`flex items-center gap-2 px-3 py-2 text-xs font-medium flex-1 justify-center
                  ${i === 0 ? 'rounded-l-lg' : ''} ${i === 2 ? 'rounded-r-lg' : ''}
                  ${phaseStatus !== 'pending' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
              >
                {phaseStatus === 'active'
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : phaseStatus === 'done'
                  ? <CheckCircle2 className="w-3 h-3" />
                  : <Circle className="w-3 h-3" />}
                {i + 1}. {phase}
              </div>
            );
          })}
        </div>

        {/* B-Roll polling banner */}
        {brollPolling && (
          <div className="mb-6 flex items-center gap-3 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl">
            <Film className="w-5 h-5 text-green-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Generating B-Roll footage with Seedance AI</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {brollCounts.pending} shot{brollCounts.pending !== 1 ? 's' : ''} rendering · {brollCounts.done} done
                {brollCounts.failed > 0 ? ` · ${brollCounts.failed} failed` : ''}
                {' '}· checking every 5s…
              </p>
            </div>
            <Loader2 className="w-4 h-4 text-green-400 animate-spin shrink-0" />
          </div>
        )}

        {error && (
          <div className="mb-6 space-y-3">
            <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-xl">
              <AlertCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Pipeline failed</p>
                <p className="text-sm text-muted-foreground mt-0.5">{error}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate('/')}>
                  Start over
                </Button>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-2">Debug AI video generation (Kinovi / Seedance API):</p>
              <KinoviDebugPanel />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-8">
          {/* Left: step list */}
          <div>
            <h2 className="text-base font-semibold text-foreground mb-1">
              {headingText}
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              GPT director · AI image capture · render in browser
            </p>
            <div className="space-y-4">
              {STEPS.map((step) => {
                const state = stepState(step.doneFrom, status);
                return (
                  <div key={step.label} className={`flex items-start gap-3 ${state === 'pending' ? 'opacity-40' : ''}`}>
                    {state === 'done'
                      ? <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                      : state === 'active'
                      ? <Loader2 className="w-4 h-4 text-primary mt-0.5 shrink-0 animate-spin" />
                      : <Circle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />}
                    <p className="text-sm text-foreground">{step.label}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: live preview data */}
          <div className="space-y-4">
            {project?.transcript && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">
                  Transcript
                </p>
                <div className="bg-muted rounded-xl p-3 text-xs font-mono text-foreground leading-relaxed max-h-28 overflow-hidden">
                  {transcriptWords}{project.transcript.split(' ').length > 80 ? '…' : ''}
                </div>
              </div>
            )}
            {shots.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">
                  Shot list · {shots.length} shots
                </p>
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {shots.slice(0, 12).map((s) => (
                    <div key={s.id} className="flex items-center gap-2 px-2.5 py-2 bg-card border border-border rounded-lg text-xs">
                      <span className={`px-1.5 py-0.5 rounded font-mono font-bold text-xs ${BEAT_COLORS[s.beat ?? ''] ?? 'bg-muted text-muted-foreground'}`}>
                        {s.beat}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-xs ${TYPE_BADGES[s.shotType ?? ''] ?? 'bg-muted text-muted-foreground'}`}>
                        {s.shotType === 'Talking Head' ? 'TH' : s.shotType === 'Screencast' ? 'SC' : (s.shotType?.slice(0, 2).toUpperCase() ?? '?')}
                      </span>
                      <span className="font-mono text-muted-foreground">{s.startTime?.toFixed(2)}s</span>
                      <span className="flex-1 text-foreground truncate">{s.caption}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                        s.captureStatus === 'Done'      ? 'bg-primary/20 text-primary'       :
                        s.captureStatus === 'Capturing' ? 'bg-yellow-500/20 text-yellow-400' :
                        s.captureStatus === 'Error'     ? 'bg-destructive/20 text-destructive' :
                        'bg-muted text-muted-foreground'
                      }`}>{s.captureStatus ?? 'Pending'}</span>
                    </div>
                  ))}
                  {shots.length > 12 && (
                    <p className="text-xs text-muted-foreground text-center py-1">+{shots.length - 12} more</p>
                  )}
                </div>
              </div>
            )}
            {!project?.transcript && !shots.length && (
              <div className="flex flex-col items-center justify-center h-32 gap-2">
                <Loader2 className="w-6 h-6 text-primary animate-spin" />
                <p className="text-sm text-muted-foreground">Pipeline starting…</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
