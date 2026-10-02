/**
 * One slide in the Rundown: drag handle + move up/down (touch-friendly
 * reorder), position, star, headline + meta, source-type badge, Preview,
 * Edit notes (inline), Remove.
 */
import { formatDistanceToNow } from 'date-fns';
import { Star, X, Eye, Pencil, GripVertical, ArrowUp, ArrowDown } from 'lucide-react';
import NotesEditor, { parseKeyPoints } from './NotesEditor';
import type { Slide } from './useDailyShow';
import { slideHasVideo } from '../api';

interface Props {
  slide: Slide;
  index: number;
  count: number;
  editing: boolean;
  isDragOver: boolean;
  onStar: (id: string, val: boolean) => void;
  onDelete: (id: string) => void;
  onPreview: (slide: Slide) => void;
  onEditToggle: (id: string | null) => void;
  onNotesUpdated: () => void;
  onMove: (from: number, to: number) => void;
  onDragStart: (idx: number) => void;
  onDragOver: (idx: number) => void;
  onDrop: (idx: number) => void;
  onDragEnd: () => void;
}

const iconBtn = 'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent';

export default function RundownItem({
  slide, index, count, editing, isDragOver,
  onStar, onDelete, onPreview, onEditToggle, onNotesUpdated, onMove, onDragStart, onDragOver, onDrop, onDragEnd,
}: Props) {
  const timeAgo = slide.publishedAt ? formatDistanceToNow(new Date(slide.publishedAt), { addSuffix: true }) : '';
  const isArticle = slide.bestSourceType?.toLowerCase() === 'article';
  const sourceLabel = isArticle ? slide.bestSourceName : `@${slide.bestSourceHandle || slide.bestSourceName}`;

  return (
    <div
      className={`rounded-lg border bg-card transition-colors ${isDragOver ? 'border-primary/60 bg-primary/5' : 'border-border'}`}
      draggable={!editing}
      onDragStart={() => onDragStart(index)}
      onDragOver={e => { e.preventDefault(); onDragOver(index); }}
      onDrop={() => onDrop(index)}
      onDragEnd={onDragEnd}
    >
      <div className="flex items-center gap-2 p-2.5">
        <GripVertical className="hidden h-4 w-4 shrink-0 cursor-grab text-muted-foreground sm:block" aria-hidden />
        <span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground">{index + 1}</span>
        <button onClick={() => onStar(slide.id, !slide.favorited)} className="shrink-0 p-0.5" title={slide.favorited ? 'Unstar' : 'Star'}>
          <Star className={`h-4 w-4 ${slide.favorited ? 'fill-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`} />
        </button>
        <button className="min-w-0 flex-1 text-left" onClick={() => onPreview(slide)} title="Preview">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground" data-slide-title>{slide.topicLabel}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            <span className={`mr-1.5 rounded px-1 py-px ${isArticle ? 'bg-blue-500/15 text-blue-300' : 'bg-sky-500/15 text-sky-300'}`}>
              {isArticle ? 'Article' : 'Tweet'}
            </span>
            {slideHasVideo(slide) && (
              <span className={`mr-1.5 rounded px-1 py-px ${slide.videoTier === 'product' ? 'bg-violet-500/15 text-violet-300' : 'bg-red-500/15 text-red-300'}`} data-video-badge={slide.videoTier || 'official'}
                title={`${slide.videoTier === 'product' ? "The company's own demo of the product (no launch video for this news)" : slide.videoTier === 'manual' ? 'Video set by hand' : "The company's launch video for this news"}: ${slide.videoTitle || ''}${slide.videoChannel ? ` · ${slide.videoChannel}` : ''}`}>
                {slide.videoTier === 'product' ? '▶ product demo' : slide.videoTier === 'manual' ? '▶ video' : '▶ launch video'}
              </span>
            )}
            Best: {sourceLabel}{timeAgo && ` · ${timeAgo}`}
            {slide.suggestedTimeSeconds ? ` · ${slide.suggestedTimeSeconds}s` : ''}
            {slide.sourcesCount ? ` · ${slide.sourcesCount} source${slide.sourcesCount > 1 ? 's' : ''}` : ''}
          </p>
        </button>
        <div className="flex shrink-0 items-center">
          <button className={iconBtn} onClick={() => onMove(index, index - 1)} disabled={index === 0} title="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
          <button className={iconBtn} onClick={() => onMove(index, index + 1)} disabled={index === count - 1} title="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
          <button className={iconBtn} onClick={() => onPreview(slide)} title="Preview"><Eye className="h-3.5 w-3.5" /></button>
          <button className={`${iconBtn} ${editing ? 'bg-primary/10 text-primary' : ''}`} onClick={() => onEditToggle(editing ? null : slide.id)} title="Edit notes">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button className={`${iconBtn} hover:text-destructive`} onClick={() => onDelete(slide.id)} title="Remove slide"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {editing && (
        <div className="px-2.5 pb-2.5">
          <NotesEditor
            slideId={slide.id}
            whyItMatters={slide.whyItMatters || ''}
            keyPoints={parseKeyPoints(slide.keyPoints)}
            talkingAngle={slide.talkingAngle || ''}
            suggestedTimeSeconds={slide.suggestedTimeSeconds || 90}
            onSaved={() => { onEditToggle(null); onNotesUpdated(); }}
            onCancel={() => onEditToggle(null)}
          />
        </div>
      )}
    </div>
  );
}
