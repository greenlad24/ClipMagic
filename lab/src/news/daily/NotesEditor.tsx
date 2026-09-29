/** Edit a slide's presenter notes (why it matters, key points, angle, time). */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { updateSlide } from '../api';

interface Props {
  slideId: string;
  whyItMatters: string;
  keyPoints: string[];
  talkingAngle: string;
  suggestedTimeSeconds: number;
  onSaved: () => void;
  onCancel?: () => void;
}

export function parseKeyPoints(raw?: string): string[] {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export default function NotesEditor({ slideId, whyItMatters, keyPoints, talkingAngle, suggestedTimeSeconds, onSaved, onCancel }: Props) {
  const [why, setWhy] = useState(whyItMatters);
  const [points, setPoints] = useState(keyPoints.join('\n'));
  const [angle, setAngle] = useState(talkingAngle);
  const [secs, setSecs] = useState(suggestedTimeSeconds);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const parsedPoints = points.split('\n').map(p => p.trim()).filter(Boolean);
      await updateSlide({
        slideId,
        whyItMatters: why,
        keyPoints: JSON.stringify(parsedPoints),
        talkingAngle: angle,
        suggestedTimeSeconds: secs,
      });
      toast.success('Notes saved');
      onSaved();
    } catch {
      toast.error('Failed to save notes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/60 p-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">🎯 Why it matters</label>
        <Textarea value={why} onChange={e => setWhy(e.target.value)} rows={3} className="text-sm" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">🔑 Key points (one per line)</label>
        <Textarea value={points} onChange={e => setPoints(e.target.value)} rows={4} className="text-sm" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">💡 Talking angle</label>
        <Textarea value={angle} onChange={e => setAngle(e.target.value)} rows={2} className="text-sm" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-medium text-muted-foreground">⏱ Suggested time (sec)</label>
        <Input type="number" value={secs} onChange={e => setSecs(Number(e.target.value))} className="w-24 text-sm" />
        <div className="ml-auto flex gap-2">
          {onCancel && <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>}
          <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save notes'}</Button>
        </div>
      </div>
    </div>
  );
}
