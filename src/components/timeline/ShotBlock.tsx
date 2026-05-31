import { Link2, Sparkles, Youtube, Eye, Clock } from 'lucide-react';
import { TimelineShot } from './types';

export type DragMode = 'move' | 'resize-left' | 'resize-right';

const TYPE_STYLES: Record<string, string> = {
  'Talking Head': 'bg-primary/25 border-primary/50 hover:border-primary/80',
  'Screencast':   'bg-blue-500/20 border-blue-500/50 hover:border-blue-500/70',
  'B-Roll':       'bg-accent/50 border-accent/70 hover:border-accent',
  'Tactical B-Roll': 'bg-orange-500/20 border-orange-500/50 hover:border-orange-500/70',
  'Animation':    'bg-muted border-border hover:border-muted-foreground/50',
};

const SELECTED_STYLE = 'bg-primary/20 border-primary/80';

/** Small status dot shown in top-right corner for non-TH shots */
function StatusDot({ status, hasClip }: { status?: string; hasClip: boolean }) {
  if (!status || status === 'Pending') {
    return <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-400/80 shrink-0" title="Pending — no clip yet" />;
  }
  if (status === 'Capturing') {
    return <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-yellow-300 animate-pulse shrink-0" title="Generating…" />;
  }
  if (status === 'Done' && hasClip) {
    return <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400/80 shrink-0" title="Clip ready" />;
  }
  if (status === 'Done' && !hasClip) return null;
  if (status === 'Error') {
    return <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-destructive/80 shrink-0" title="Generation failed" />;
  }
  return null;
}

/** B-Roll source badge — link icon for marketing video, sparkle for AI-generated */
function BrollSourceBadge({ uiLabelsJson }: { uiLabelsJson?: string }) {
  let brollTrack: string | undefined;
  try {
    if (uiLabelsJson) {
      const labels = JSON.parse(uiLabelsJson);
      brollTrack = labels.brollTrack;
    }
  } catch { /* */ }

  if (!brollTrack) return null;

  const icon =
    brollTrack === 'pool'      ? <Youtube className="w-2.5 h-2.5 text-foreground/50" /> :
    brollTrack === 'marketing' ? <Link2 className="w-2.5 h-2.5 text-foreground/50" /> :
                                 <Sparkles className="w-2.5 h-2.5 text-foreground/50" />;

  const label =
    brollTrack === 'pool'      ? 'Source: Curated brand video (YouTube)' :
    brollTrack === 'marketing' ? 'Source: Marketing video' :
                                 'Source: AI-generated';

  return (
    <div className="absolute bottom-1 left-1" title={label}>
      {icon}
    </div>
  );
}

interface Props {
  shot: TimelineShot;
  left: number;
  width: number;
  height: number;
  isSelected: boolean;
  onClick: () => void;
  onDragStart: (e: React.MouseEvent, mode: DragMode) => void;
  /** When true, clicking the block toggles selection instead of editing */
  isSelectMode?: boolean;
  isChecked?: boolean;
  onToggle?: () => void;
}

export default function ShotBlock({
  shot, left, width, height, isSelected, onClick, onDragStart,
  isSelectMode, isChecked, onToggle,
}: Props) {
  const displayWidth = Math.max(12, width);
  const showDot = shot.shotType !== 'Talking Head';

  // Parse labels for tactical B-roll detection and narrator-first
  let isTacticalBroll = false;
  let hasNarratorFirst = false;
  let overlayDelaySec = 0;
  let hasNarratorReturn = false;
  let isRequired = false;
  try {
    if (shot.uiLabelsJson) {
      const lbl = JSON.parse(shot.uiLabelsJson);
      isTacticalBroll = lbl.brollMode === 'tactical_broll' || (shot.shotType === 'B-Roll' && lbl.brollTrack === 'generated');
      hasNarratorFirst = lbl.showNarratorFirst === true;
      overlayDelaySec = typeof lbl.overlayDelaySeconds === 'number' ? lbl.overlayDelaySeconds : 0;
      hasNarratorReturn = lbl.returnToNarratorBeforeEnd === true && (lbl.narratorReturnLeadSeconds ?? 0) > 0;
      isRequired = lbl.isRequiredTacticalBroll === true || lbl.isRequiredTacticalSlot === true;
    }
  } catch { /* */ }

  const effectiveType = isTacticalBroll ? 'Tactical B-Roll' : (shot.shotType ?? '');
  const showSourceBadge = (shot.shotType === 'B-Roll' || isTacticalBroll) && displayWidth > 40;

  const checkedStyle = isSelectMode && isChecked
    ? SELECTED_STYLE
    : (TYPE_STYLES[effectiveType] ?? TYPE_STYLES[shot.shotType ?? ''] ?? 'bg-muted border-border');

  const selectedRing = !isSelectMode && isSelected
    ? 'ring-1 ring-primary ring-offset-1 ring-offset-background z-10'
    : '';

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSelectMode) {
      onToggle?.();
    } else {
      onClick();
    }
  };

  const handleDragStart = (e: React.MouseEvent, mode: DragMode) => {
    if (isSelectMode) return; // disable dragging in select mode
    e.stopPropagation();
    e.preventDefault();
    onDragStart(e, mode);
  };

  return (
    <div
      className={`absolute top-1 rounded border select-none transition-colors ${checkedStyle} ${selectedRing} ${isSelectMode ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'}`}
      style={{ left, width: displayWidth, height }}
      onClick={handleClick}
      onMouseDown={e => {
        if (isSelectMode) return;
        e.stopPropagation();
        e.preventDefault();
        onDragStart(e, 'move');
      }}
    >
      {/* Checkbox (select mode) */}
      {isSelectMode && (
        <div className="absolute top-0.5 left-0.5 z-20 pointer-events-none">
          <div className={`w-3 h-3 rounded-sm border flex items-center justify-center transition-colors ${
            isChecked
              ? 'bg-primary border-primary'
              : 'bg-background/60 border-muted-foreground/40'
          }`}>
            {isChecked && (
              <svg className="w-2 h-2 text-primary-foreground" viewBox="0 0 10 10" fill="none">
                <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Left resize handle */}
      {!isSelectMode && (
        <div
          className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary/30 rounded-l z-10"
          onMouseDown={e => handleDragStart(e, 'resize-left')}
        />
      )}

      {/* Label */}
      {displayWidth > 28 && (
        <div className={`h-full flex items-center overflow-hidden pointer-events-none ${isSelectMode ? 'px-5' : 'px-2 pr-4'}`}>
          <span className="text-[9px] font-medium text-foreground/80 truncate leading-none">
            {shot.caption || shot.beat || (shot.shotType === 'Talking Head' ? 'TH' : shot.shotType?.slice(0, 2).toUpperCase())}
          </span>
        </div>
      )}

      {/* Status dot */}
      {showDot && !isSelectMode && <StatusDot status={shot.captureStatus} hasClip={!!shot.clipUrl} />}

      {/* Narrator-first + return indicators */}
      {!isSelectMode && displayWidth > 50 && (hasNarratorFirst || hasNarratorReturn) && (
        <div className="absolute bottom-0.5 right-1 flex items-center gap-0.5" title={`${hasNarratorFirst ? `Narr first ${overlayDelaySec.toFixed(1)}s` : ''}${hasNarratorReturn ? ' · return' : ''}`}>
          {hasNarratorFirst && <Eye className="w-2 h-2 text-blue-400/70" />}
          {hasNarratorReturn && <span className="text-[7px] text-purple-400/80">↩</span>}
        </div>
      )}

      {/* Tactical B-Roll badge + required indicator */}
      {isTacticalBroll && !isSelectMode && displayWidth > 40 && (
        <div className="absolute top-0.5 left-1 flex items-center gap-0.5" title={isRequired ? 'Required Tactical B-Roll' : 'Tactical B-Roll'}>
          <Sparkles className="w-2 h-2 text-orange-400/80" />
          {isRequired && displayWidth > 60 && <span className="text-[6px] text-orange-300 font-bold">REQ</span>}
        </div>
      )}

      {/* B-Roll source badge */}
      {showSourceBadge && !isTacticalBroll && !isSelectMode && <BrollSourceBadge uiLabelsJson={shot.uiLabelsJson} />}

      {/* Right resize handle */}
      {!isSelectMode && (
        <div
          className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary/30 rounded-r z-10"
          onMouseDown={e => handleDragStart(e, 'resize-right')}
        />
      )}
    </div>
  );
}
