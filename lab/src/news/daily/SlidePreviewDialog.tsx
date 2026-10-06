/**
 * Preview a slide: the audience view — the story as the stage shows it
 * (cover, then each beat; daily/stage, 2026-10-06), steppable here with the
 * arrows under it — beside the presenter notes, which can be edited in place.
 */
import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ChevronLeft, ChevronRight, Pencil, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { findSlideVideo, setSlideVideo, slideMedia } from '../api';
import NotesEditor, { parseKeyPoints } from './NotesEditor';
import type { Slide } from './useDailyShow';
import { StoryThumb } from './stage/StoryShow';
import { beatLabel, storyBeats, storyStage } from './stage/story';
import { templateFor } from '../deepdive/templates';
import { useBubbleSettings } from '../deepdive/bubble';

interface Props {
  slide: Slide | null;
  /** Its place in the show (1-based), for the scenes' number badge. */
  number?: number;
  /** The deck's template id ('' = Jake's brand) — the preview is drawn in it. */
  template?: string;
  onClose: () => void;
  onNotesUpdated: () => void;
}

export default function SlidePreviewDialog({ slide, number = 1, template = '', onClose, onNotesUpdated }: Props) {
  // The safe frame the show screens keep for the camera bubble, so the preview matches them.
  const [bubble] = useBubbleSettings();
  const [editingNotes, setEditingNotes] = useState(false);
  const [videoBusy, setVideoBusy] = useState<'' | 'find' | 'set'>('');
  const [videoLink, setVideoLink] = useState('');
  const [beat, setBeat] = useState(0);
  useEffect(() => { setEditingNotes(false); setVideoLink(''); setBeat(0); }, [slide?.id]);
  if (!slide) return null;
  const stage = storyStage(slide);
  const beats = storyBeats(stage);

  const keyPoints = parseKeyPoints(slide.keyPoints);
  const timeAgo = slide.publishedAt ? formatDistanceToNow(new Date(slide.publishedAt), { addSuffix: true }) : '';
  const slideId = slide.id;
  const media = slideMedia(slide);
  const findVideo = async () => {
    setVideoBusy('find');
    try {
      const r = await findSlideVideo({ slideId });
      if (!r.checked) toast.info(r.reason);
      else toast.success(r.kind ? (r.tier === 'product' ? "No launch video — found the company's product demo" : 'Found the launch video') : 'No video for this story');
      onNotesUpdated();
    } catch (e: any) { toast.error(e?.message || 'Video search failed'); }
    finally { setVideoBusy(''); }
  };
  const setVideo = async (videoId: string | null) => {
    setVideoBusy('set');
    try {
      await setSlideVideo({ slideId, videoId });
      toast.success(videoId ? 'Video set' : 'Video removed');
      setVideoLink('');
      onNotesUpdated();
    } catch (e: any) { toast.error(e?.message || 'Could not set the video'); }
    finally { setVideoBusy(''); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-6 text-base">{slide.topicLabel}</DialogTitle>
          <DialogDescription className="text-xs">
            {slide.bestSourceName}{timeAgo && ` · ${timeAgo}`} · score {slide.avgRelevanceScore} · {slide.suggestedTimeSeconds}s
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Audience view</p>
            <div data-story-preview>
              <StoryThumb slide={slide} beat={beat} number={number} live template={templateFor(template, 'v2')} bubble={bubble} />
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setBeat((b) => Math.max(0, b - 1))} disabled={beat <= 0} aria-label="Previous beat">
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">Beat {Math.min(beat, beats - 1) + 1} / {beats}</span>
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setBeat((b) => Math.min(beats - 1, b + 1))} disabled={beat >= beats - 1} aria-label="Next beat">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{beatLabel(stage, Math.min(beat, beats - 1))}</span>
            </div>
            {stage.fallback && (
              <p className="mt-1.5 text-[11px] leading-snug text-amber-300/90">
                No visuals built for this story yet — it shows its key points. Use “Make visuals” in Selections (keeps the script).
              </p>
            )}

            {/* Official release video — full screen on demand (Shift on the presenter), never on a beat. */}
            <div className="mt-3 rounded-lg border border-border p-2.5" data-video-panel>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Story video</p>
                <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={findVideo} disabled={!!videoBusy}>
                  <Search className="h-3 w-3" /> {videoBusy === 'find' ? 'Searching…' : 'Find video'}
                </Button>
              </div>
              {media ? (
                <div className="mt-2 flex items-center gap-2.5">
                  <a href={slide.videoId ? `https://www.youtube.com/watch?v=${slide.videoId}` : media.src} target="_blank" rel="noopener noreferrer" className="shrink-0">
                    {slide.videoId
                      ? <img src={`https://i.ytimg.com/vi/${slide.videoId}/mqdefault.jpg`} alt="" className="h-12 w-20 rounded object-cover" />
                      : <span className="flex h-12 w-20 items-center justify-center rounded bg-muted text-[10px] uppercase text-muted-foreground">{media.kind}</span>}
                  </a>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">▶ {slide.videoTitle || media.kind}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <span className={`mr-1 rounded px-1 ${slide.videoTier === 'product' ? 'bg-violet-500/15 text-violet-300' : 'bg-red-500/15 text-red-300'}`} data-video-tier>
                        {slide.videoTier === 'product' ? 'product demo' : slide.videoTier === 'manual' ? 'set by hand' : 'launch video'}
                      </span>
                      {slide.videoChannel}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 text-xs" onClick={() => setVideo(null)} disabled={!!videoBusy}>
                    <X className="h-3 w-3" /> Remove video
                  </Button>
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">No video — this story shows its slides only.</p>
              )}
              {slide.videoReason && <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{slide.videoReason}</p>}
              <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (videoLink.trim()) void setVideo(videoLink.trim()); }}>
                <Input value={videoLink} onChange={(e) => setVideoLink(e.target.value)} placeholder="Paste a YouTube, Vimeo or .mp4 link" className="h-7 text-xs" />
                <Button type="submit" variant="secondary" size="sm" className="h-7 shrink-0 text-xs" disabled={!!videoBusy || !videoLink.trim()}>
                  Use this link instead
                </Button>
              </form>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Presenter notes</p>
              {!editingNotes && (
                <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setEditingNotes(true)}>
                  <Pencil className="h-3 w-3" /> Edit notes
                </Button>
              )}
            </div>
            {editingNotes ? (
              <NotesEditor
                slideId={slide.id}
                whyItMatters={slide.whyItMatters || ''}
                keyPoints={keyPoints}
                talkingAngle={slide.talkingAngle || ''}
                suggestedTimeSeconds={slide.suggestedTimeSeconds || 90}
                onSaved={() => { setEditingNotes(false); onNotesUpdated(); }}
                onCancel={() => setEditingNotes(false)}
              />
            ) : (
              <div className="space-y-4 rounded-lg border border-border p-3">
                <div>
                  <p className="mb-1 text-xs font-semibold text-foreground">🎯 WHY IT MATTERS</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">{slide.whyItMatters || '—'}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold text-foreground">🔑 KEY POINTS</p>
                  <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                    {keyPoints.map((pt, i) => <li key={i}>{pt}</li>)}
                  </ul>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold text-foreground">💡 TALKING ANGLE</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">{slide.talkingAngle || '—'}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
