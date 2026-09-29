/**
 * Preview a slide: the audience view (rendered with the audience screen's own
 * light palette and background colour) beside the presenter notes, which can
 * be edited in place.
 */
import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Pencil } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import TweetView from '../components/TweetView';
import ArticleView from '../components/ArticleView';
import NotesEditor, { parseKeyPoints } from './NotesEditor';
import type { Slide } from './useDailyShow';
import './audience-preview.css';

const BG_KEY = 'ng-audience-bg'; // same key Settings writes and the audience page reads

interface Props {
  slide: Slide | null;
  onClose: () => void;
  onNotesUpdated: () => void;
}

export default function SlidePreviewDialog({ slide, onClose, onNotesUpdated }: Props) {
  const [editingNotes, setEditingNotes] = useState(false);
  useEffect(() => { setEditingNotes(false); }, [slide?.id]);
  if (!slide) return null;

  const keyPoints = parseKeyPoints(slide.keyPoints);
  const isTweet = slide.bestSourceType?.toLowerCase() === 'tweet';
  const content = (slide.fullContentHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const timeAgo = slide.publishedAt ? formatDistanceToNow(new Date(slide.publishedAt), { addSuffix: true }) : '';
  let bg = '#ffffff';
  try { bg = localStorage.getItem(BG_KEY) || bg; } catch { /* storage blocked */ }

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
            <div className="news-audience-preview rounded-xl p-3" style={{ background: bg }}>
              {isTweet ? (
                <TweetView sourceName={slide.bestSourceName || ''} sourceHandle={slide.bestSourceHandle} publishedAt={slide.publishedAt} content={content} heroImageUrl={slide.heroImageUrl} />
              ) : (
                <ArticleView sourceName={slide.bestSourceName || ''} sourceUrl={slide.bestSourceUrl} publishedAt={slide.publishedAt} topicLabel={slide.topicLabel || ''} content={content} heroImageUrl={slide.heroImageUrl} />
              )}
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
