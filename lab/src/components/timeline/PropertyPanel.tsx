import { useState } from 'react';
import { TimelineShot, CameraKeyframe } from './types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Plus, Trash2, RefreshCw, Sparkles, ImageIcon, Tag, Quote, Clock, Cpu, Library, Eye, AlertTriangle } from 'lucide-react';
import { recaptureShot, generateShot, updateShot } from 'zite-endpoints-sdk';
import { toast } from 'sonner';

const TRANSITIONS = ['Hard Cut', 'Whip Pan', 'Cross Dissolve'];
const SFX_OPTIONS = ['Impact', 'Whoosh', 'Pop', 'Click', 'Riser'];

const CAMERA_PRESETS: Record<string, CameraKeyframe[]> = {
  none:      [],
  slow:      [{ t: 0, zoom: 1, panX: 0, panY: 0 }, { t: 1, zoom: 1.07, panX: 0, panY: -0.02 }],
  push:      [{ t: 0, zoom: 1, panX: 0, panY: 0 }, { t: 0.5, zoom: 1.1, panX: 0, panY: -0.03 }, { t: 1, zoom: 1.18, panX: 0, panY: -0.05 }],
  fast:      [{ t: 0, zoom: 1, panX: 0, panY: 0 }, { t: 0.3, zoom: 1.2, panX: 0.01, panY: -0.04 }, { t: 1, zoom: 1.28, panX: 0, panY: -0.07 }],
  snap:      [{ t: 0, zoom: 1, panX: 0, panY: 0 }, { t: 0.15, zoom: 1.35, panX: 0.02, panY: -0.06 }, { t: 1, zoom: 1.3, panX: 0, panY: -0.05 }],
  'pull back': [{ t: 0, zoom: 1.2, panX: 0, panY: -0.04 }, { t: 1, zoom: 1.0, panX: 0, panY: 0 }],
};

interface Props {
  shot: TimelineShot | null;
  onShotChange: (updates: Partial<TimelineShot>) => void;
  onDeleteShot?: (shotId: string) => void;
}

function KeyframeRow({ kf, idx, onUpdate, onDelete }: { kf: CameraKeyframe; idx: number; onUpdate: (f: keyof CameraKeyframe, v: number) => void; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-1 text-[10px]">
      <span className="font-mono text-muted-foreground w-7 shrink-0">{(kf.t * 100).toFixed(0)}%</span>
      <input type="number" value={kf.zoom.toFixed(2)} step={0.01} min={1} max={2}
        onChange={e => onUpdate('zoom', parseFloat(e.target.value) || 1)}
        className="w-14 h-5 bg-muted/40 rounded px-1 text-foreground border border-border/50 focus:outline-none focus:ring-1 focus:ring-primary font-mono" />
      <span className="text-muted-foreground/50">zoom</span>
      <button onClick={onDelete} className="ml-auto text-muted-foreground/50 hover:text-destructive"><Trash2 className="w-3 h-3" /></button>
    </div>
  );
}

/** Small inline capture-status badge */
function StatusBadge({ status, clipUrl }: { status?: string; clipUrl?: string }) {
  if (!status || status === 'Pending') return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">Pending</span>
  );
  if (status === 'Capturing') return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-medium animate-pulse">Generating…</span>
  );
  if (status === 'Done' && clipUrl) return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">Clip ready</span>
  );
  if (status === 'Error') return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive font-medium">Failed</span>
  );
  return null;
}

export default function PropertyPanel({ shot, onShotChange, onDeleteShot }: Props) {
  const [recapturing, setRecapturing] = useState(false);
  const [generating, setGenerating] = useState(false);

  if (!shot) {
    return (
      <div className="w-52 shrink-0 border-l border-border flex items-center justify-center p-4 bg-card/30">
        <p className="text-[11px] text-muted-foreground text-center leading-relaxed">Select a shot block<br />to edit its properties</p>
      </div>
    );
  }

  const isTH = shot.shotType === 'Talking Head';
  const isSC = shot.shotType === 'Screencast';
  const isBR = shot.shotType === 'B-Roll';
  let labels: Record<string, any> = {};
  try { if (shot.uiLabelsJson) labels = JSON.parse(shot.uiLabelsJson); } catch { /* */ }
  const keyframes: CameraKeyframe[] = labels.cameraKeyframes ?? [];
  const seedanceAiPrompt: string = labels.seedanceAiPrompt ?? labels.veo3Prompt ?? '';
  const rationale: string = labels.rationale ?? '';
  const matchKeywords: string[] = Array.isArray(labels.matchKeywords) ? labels.matchKeywords : [];
  const transcriptSnippet: string = labels.transcriptSnippet ?? '';
  const clipStartOffset: number | undefined = typeof labels.clipStartOffset === 'number' ? labels.clipStartOffset : undefined;
  const clipEndOffset: number | undefined = typeof labels.clipEndOffset === 'number' ? labels.clipEndOffset : undefined;
  const retrievalConfidence: number | undefined = typeof labels.retrievalConfidence === 'number' ? labels.retrievalConfidence : undefined;
  const matchReason: string = labels.matchReason ?? '';
  const overlayDelay: number | undefined = typeof labels.overlayDelaySeconds === 'number' ? labels.overlayDelaySeconds : undefined;
  const showNarratorFirst: boolean = labels.showNarratorFirst === true;
  const visualIntent: string = labels.visualIntent ?? shot.visualIntent ?? '';
  const isTacticalBroll = labels.brollMode === 'tactical_broll' || (isBR && labels.brollTrack === 'generated');
  const brollReason: string = labels.brollReason ?? '';
  const avoidedScreencastBecause: string = labels.avoidedScreencastBecause ?? '';
  const isRequiredTacticalSlot: boolean = labels.isRequiredTacticalSlot === true || labels.isRequiredTacticalBroll === true;
  const tacticalPlacementReason: string = labels.tacticalPlacementReason ?? '';
  const returnToNarratorBeforeEnd: boolean = labels.returnToNarratorBeforeEnd === true;
  const narratorReturnLeadSeconds: number | undefined = typeof labels.narratorReturnLeadSeconds === 'number' ? labels.narratorReturnLeadSeconds : undefined;
  const brollSource: 'generated' | 'pool' | 'stock' | undefined =
    labels.brollTrack === 'generated' ? 'generated'
    : labels.brollTrack === 'stock' ? 'stock'
    : labels.brollTrack === 'pool' ? 'pool'
    : undefined;
  const stockQuery: string = labels.stockQuery ?? '';

  const setLabels = (next: Record<string, any>) => onShotChange({ uiLabelsJson: JSON.stringify(next) });
  const setKeyframes = (kfs: CameraKeyframe[]) => setLabels({ ...labels, cameraKeyframes: kfs });
  const addKf = () => {
    const t = keyframes.length ? Math.min(1, keyframes[keyframes.length - 1].t + (1 - keyframes[keyframes.length - 1].t) / 2) : 0.5;
    setKeyframes([...keyframes, { t, zoom: 1.1, panX: 0, panY: 0 }]);
  };

  const handleRecapture = async () => {
    setRecapturing(true);
    try { await recaptureShot({ shotId: shot.id }); toast.success('Re-capture queued'); }
    catch (e: any) { toast.error(e.message ?? 'Failed'); }
    finally { setRecapturing(false); }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    onShotChange({ captureStatus: 'Capturing' });
    try {
      const result = await generateShot({ shotId: shot.id });
      if (!result.success) {
        onShotChange({ captureStatus: 'Error' });
        toast.error('Generation failed');
        return;
      }

      const finalUrl = result.clipUrl;

      if (finalUrl) {
        // Screencast / direct URL — mark Done immediately
        await updateShot({ shotId: shot.id, clipUrl: finalUrl, captureStatus: 'Done' });
        onShotChange({ clipUrl: finalUrl, captureStatus: 'Done' });
        toast.success('Clip generated!');
      } else if (result.kinoviTaskId) {
        // B-Roll — Kinovi task created, shot stays in Capturing until pollBrollStatus resolves it
        onShotChange({ captureStatus: 'Capturing' });
        toast.success('B-Roll generation started — check back in a moment');
      } else {
        onShotChange({ captureStatus: 'Done' });
        toast.success('Shot updated');
      }
    } catch (e: any) {
      onShotChange({ captureStatus: 'Error' });
      toast.error(e.message ?? 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const hasClip = !!shot.clipUrl;

  return (
    <div className="w-52 shrink-0 border-l border-border overflow-y-auto bg-card/30">
      <div className="p-3 space-y-3.5">
        <div className="pb-2 border-b border-border/50">
          <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Selected Shot</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
              isTH ? 'bg-primary/20 text-primary' :
              isSC ? 'bg-blue-500/20 text-blue-400' :
              isTacticalBroll ? 'bg-orange-500/20 text-orange-400' :
              'bg-accent/20 text-accent-foreground'
            }`}>
              {isTacticalBroll ? 'Tactical B-Roll' : shot.shotType}
            </span>
            <p className="text-xs font-semibold text-foreground">{shot.beat}</p>
            {!isTH && <StatusBadge status={shot.captureStatus} clipUrl={shot.clipUrl} />}
          </div>
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{(shot.startTime ?? 0).toFixed(2)}s – {(shot.endTime ?? 0).toFixed(2)}s</p>
          {visualIntent && (
            <div className="flex items-center gap-1 mt-1">
              <span className="text-[9px] text-muted-foreground">Intent:</span>
              <span className="text-[9px] text-foreground/80 font-medium">{visualIntent}</span>
            </div>
          )}
        </div>

        {/* ── Director's note: why this visual was chosen ── */}
        {rationale && (
          <div className="space-y-1 p-2.5 bg-primary/8 border border-primary/20 rounded-lg">
            <div className="flex items-center gap-1">
              <Quote className="w-2.5 h-2.5 text-primary shrink-0" />
              <span className="text-[9px] font-semibold text-primary uppercase tracking-wider">Director's note</span>
            </div>
            <p className="text-[10px] text-foreground/80 leading-relaxed">{rationale}</p>
          </div>
        )}

        {/* ── Three-phase overlay timing (all non-TH shots) ── */}
        {!isTH && (showNarratorFirst || overlayDelay !== undefined || returnToNarratorBeforeEnd) && (
          <div className="space-y-1.5 p-2 bg-indigo-500/8 border border-indigo-500/20 rounded-lg">
            <p className="text-[9px] font-semibold text-indigo-400 uppercase tracking-wider">Overlay Timing</p>
            {/* Phase 1: narrator-first */}
            <div className="flex items-center gap-1">
              <span className="text-[9px] w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
              <span className="text-[9px] text-foreground/80">
                {showNarratorFirst ? `👤 Narrator first · ${(overlayDelay ?? 0).toFixed(1)}s` : '👤 Overlay immediate'}
              </span>
            </div>
            {/* Phase 2: overlay visible */}
            <div className="flex items-center gap-1">
              <span className="text-[9px] w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              <span className="text-[9px] text-foreground/80">🎬 Overlay visible</span>
              {clipStartOffset !== undefined && (
                <span className="text-[9px] font-mono text-muted-foreground">{clipStartOffset.toFixed(1)}s{clipEndOffset !== undefined ? `→${clipEndOffset.toFixed(1)}s` : ''}</span>
              )}
            </div>
            {/* Phase 3: narrator-return */}
            {returnToNarratorBeforeEnd && narratorReturnLeadSeconds !== undefined && narratorReturnLeadSeconds > 0 && (
              <div className="flex items-center gap-1">
                <span className="text-[9px] w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" />
                <span className="text-[9px] text-foreground/80">👤 Return to narrator · {narratorReturnLeadSeconds.toFixed(1)}s before end</span>
              </div>
            )}
          </div>
        )}

        {/* Clip preview thumbnail */}
        {!isTH && shot.clipUrl && (
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Current Clip</Label>
            <div className="relative w-full rounded-md overflow-hidden bg-black border border-border/50" style={{ aspectRatio: '9/16', maxHeight: 72 }}>
              <img
                src={shot.clipUrl}
                alt="clip preview"
                className="absolute inset-0 w-full h-full object-cover"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
              <div className="absolute inset-0 flex items-end justify-start p-1 pointer-events-none">
                <ImageIcon className="w-3 h-3 text-white/40" />
              </div>
            </div>
          </div>
        )}

        {/* ── Screencast retrieval context ── */}
        {isSC && (matchKeywords.length > 0 || transcriptSnippet || retrievalConfidence !== undefined) && (
          <div className="space-y-2 p-2.5 bg-blue-500/8 border border-blue-500/20 rounded-lg">
            <p className="text-[9px] font-semibold text-blue-400 uppercase tracking-wider">Screencast Retrieval</p>

            {retrievalConfidence !== undefined && (
              <div className="flex items-center gap-1">
                <Sparkles className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                <span className="text-[9px] text-muted-foreground">Confidence</span>
                <span className={`text-[9px] font-mono font-semibold ${retrievalConfidence >= 0.7 ? 'text-emerald-400' : retrievalConfidence >= 0.5 ? 'text-amber-400' : 'text-red-400'}`}>{(retrievalConfidence * 100).toFixed(0)}%</span>
                {retrievalConfidence < 0.5 && <AlertTriangle className="w-2.5 h-2.5 text-amber-400" />}
              </div>
            )}

            {matchReason && (
              <p className="text-[9px] text-foreground/60 leading-relaxed">💡 {matchReason}</p>
            )}

            {transcriptSnippet && (
              <div className="space-y-0.5">
                <div className="flex items-center gap-1">
                  <Quote className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                  <span className="text-[9px] text-muted-foreground font-medium uppercase tracking-wide">Transcript</span>
                </div>
                <p className="text-[10px] text-foreground/80 leading-relaxed italic">"{transcriptSnippet}"</p>
              </div>
            )}

            {matchKeywords.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Tag className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                  <span className="text-[9px] text-muted-foreground font-medium uppercase tracking-wide">Match keywords</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {matchKeywords.map((kw, i) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 bg-blue-500/15 text-blue-300 rounded-full font-medium">{kw}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── B-Roll / Tactical B-Roll / Stock context ── */}
        {isBR && (seedanceAiPrompt || brollSource || isTacticalBroll || stockQuery) && (
          <div className={`space-y-2 p-2.5 rounded-lg ${brollSource === 'stock' ? 'bg-emerald-500/8 border border-emerald-500/20' : isTacticalBroll ? 'bg-orange-500/8 border border-orange-500/20' : 'bg-violet-500/8 border border-violet-500/20'}`}>
            <div className="flex items-center justify-between">
              <p className={`text-[9px] font-semibold uppercase tracking-wider ${brollSource === 'stock' ? 'text-emerald-400' : isTacticalBroll ? 'text-orange-400' : 'text-violet-400'}`}>
                {brollSource === 'stock' ? '🎞 Stock footage' : isTacticalBroll ? '⚡ Tactical B-Roll' : 'AI B-Roll'}
              </p>
              {brollSource && (
                <div className="flex items-center gap-1">
                  {brollSource === 'generated'
                    ? <><Cpu className="w-2.5 h-2.5 text-violet-400" /><span className="text-[9px] text-violet-400 font-medium">AI Generated</span></>
                    : brollSource === 'stock'
                    ? <><Library className="w-2.5 h-2.5 text-emerald-400" /><span className="text-[9px] text-emerald-400 font-medium">Pexels stock</span></>
                    : <><Library className="w-2.5 h-2.5 text-emerald-400" /><span className="text-[9px] text-emerald-400 font-medium">From Pool</span></>
                  }
                </div>
              )}
            </div>
            {brollSource === 'stock' && stockQuery && (
              <p className="text-[9px] text-foreground/60 leading-relaxed">Stock search: "{stockQuery}"</p>
            )}
            {seedanceAiPrompt && (
              <p className="text-[10px] text-foreground/80 leading-relaxed">{seedanceAiPrompt}</p>
            )}
            {isTacticalBroll && isRequiredTacticalSlot && (
              <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300 font-bold uppercase tracking-wider">Required Slot</span>
            )}
            {isTacticalBroll && tacticalPlacementReason && (
              <div className="space-y-0.5">
                <span className="text-[9px] text-orange-300/80 font-medium">Placement reason:</span>
                <p className="text-[9px] text-foreground/60 leading-relaxed">{tacticalPlacementReason}</p>
              </div>
            )}
            {isTacticalBroll && brollReason && (
              <div className="space-y-0.5">
                <span className="text-[9px] text-orange-300/80 font-medium">Why B-Roll:</span>
                <p className="text-[9px] text-foreground/60 leading-relaxed">{brollReason}</p>
              </div>
            )}
            {isTacticalBroll && avoidedScreencastBecause && (
              <div className="space-y-0.5">
                <span className="text-[9px] text-orange-300/80 font-medium">Screencast avoided:</span>
                <p className="text-[9px] text-foreground/60 leading-relaxed">{avoidedScreencastBecause}</p>
              </div>
            )}
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">Caption</Label>
          <Input value={shot.caption ?? ''} onChange={e => onShotChange({ caption: e.target.value })}
            placeholder="max 3 words" className="h-7 text-xs bg-muted/20" />
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">Transition In</Label>
          <Select value={shot.transitionIn ?? 'Hard Cut'} onValueChange={v => onShotChange({ transitionIn: v })}>
            <SelectTrigger className="h-7 text-xs bg-muted/20"><SelectValue /></SelectTrigger>
            <SelectContent>{TRANSITIONS.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">SFX In</Label>
          <Select value={shot.sfxIn ?? 'none'} onValueChange={v => onShotChange({ sfxIn: v === 'none' ? undefined : v })}>
            <SelectTrigger className="h-7 text-xs bg-muted/20"><SelectValue placeholder="None" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {SFX_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {!isTH && (
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Target URL</Label>
            <Input value={shot.targetUrl ?? ''} onChange={e => onShotChange({ targetUrl: e.target.value || undefined })}
              placeholder="https://…" className="h-7 text-xs bg-muted/20 font-mono" />
          </div>
        )}

        {isTH && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] text-muted-foreground">Camera Keyframes</Label>
              <button onClick={addKf} className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"><Plus className="w-3 h-3" /></button>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {Object.keys(CAMERA_PRESETS).map(name => (
                <button key={name} onClick={() => setKeyframes(CAMERA_PRESETS[name])}
                  className="text-[9px] px-1 py-0.5 bg-muted rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground capitalize truncate transition-colors">
                  {name}
                </button>
              ))}
            </div>
            {keyframes.length === 0
              ? <p className="text-[10px] text-muted-foreground/50 italic">Static (no keyframes)</p>
              : keyframes.map((kf, i) => (
                <KeyframeRow key={i} kf={kf} idx={i}
                  onUpdate={(f, v) => setKeyframes(keyframes.map((k, j) => j === i ? { ...k, [f]: v } : k))}
                  onDelete={() => setKeyframes(keyframes.filter((_, j) => j !== i))}
                />
              ))
            }
          </div>
        )}



        {/* Generate / Regenerate button — non-TH shots only */}
        {!isTH && (
          <div className="space-y-1.5 pt-0.5">
            <Button
              size="sm"
              className="w-full h-7 text-xs gap-1.5"
              onClick={handleGenerate}
              disabled={generating}
            >
              {generating
                ? <><RefreshCw className="w-3 h-3 animate-spin" /> Generating…</>
                : <><Sparkles className="w-3 h-3" /> {hasClip ? 'Regenerate clip' : 'Generate clip'}</>
              }
            </Button>
            <Button variant="outline" size="sm" className="w-full h-7 text-xs gap-1.5" onClick={handleRecapture} disabled={recapturing}>
              <RefreshCw className={`w-3 h-3 ${recapturing ? 'animate-spin' : ''}`} />
              Re-capture shot
            </Button>
          </div>
        )}

        {/* Delete shot */}
        {onDeleteShot && (
          <div className="pt-1 border-t border-border/30">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full h-7 text-xs gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="w-3 h-3" />
                  Delete shot
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this shot?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete the <strong>{shot?.shotType} · {shot?.beat}</strong> shot from the timeline and database. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => shot && onDeleteShot(shot.id)}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>
    </div>
  );
}
