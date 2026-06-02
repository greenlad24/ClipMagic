import { useState, useEffect } from 'react';
import { updateShot, recaptureShot } from 'zite-endpoints-sdk';
import { GetShotsOutputType } from 'zite-endpoints-sdk';
import { toast } from 'sonner';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

type Shot = GetShotsOutputType['shots'][0];

interface Props {
  shot: Shot | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const TRANSITIONS = ['Hard Cut', 'Whip Pan', 'Cross Dissolve'];

export default function ShotEditDialog({ shot, isOpen, onClose, onSaved }: Props) {
  const [caption, setCaption] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [targetSelector, setTargetSelector] = useState('');
  const [transitionIn, setTransitionIn] = useState('Hard Cut');
  const [saving, setSaving] = useState(false);
  const [recapturing, setRecapturing] = useState(false);

  useEffect(() => {
    if (shot) {
      setCaption(shot.caption ?? '');
      setTargetUrl(shot.targetUrl ?? '');
      setTargetSelector(shot.targetSelector ?? '');
      setTransitionIn(shot.transitionIn ?? 'Hard Cut');
    }
  }, [shot]);

  if (!shot) return null;

  const isTH = shot.shotType === 'Talking Head';

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateShot({
        shotId: shot.id,
        caption,
        targetUrl: targetUrl || undefined,
        targetSelector: targetSelector || undefined,
        transitionIn,
      });
      toast.success('Shot saved');
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error(err.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleRecapture = async () => {
    setRecapturing(true);
    try {
      await recaptureShot({ shotId: shot.id });
      toast.success('Shot re-captured!');
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error(err.message ?? 'Re-capture failed');
    } finally {
      setRecapturing(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            Edit Shot
            <span className="text-xs font-normal px-2 py-0.5 bg-muted rounded text-muted-foreground">
              {shot.beat} · {shot.shotType}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="caption" className="text-xs text-muted-foreground">Caption (max 3 words)</Label>
            <Input
              id="caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="e.g. watch this"
              className="bg-muted/30"
            />
          </div>

          {!isTH && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="targetUrl" className="text-xs text-muted-foreground">Target URL</Label>
                <Input
                  id="targetUrl"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://app.example.com/page"
                  className="bg-muted/30 font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="targetSelector" className="text-xs text-muted-foreground">
                  CSS Selector <span className="text-muted-foreground/50">(optional — scrolls to element)</span>
                </Label>
                <Input
                  id="targetSelector"
                  value={targetSelector}
                  onChange={(e) => setTargetSelector(e.target.value)}
                  placeholder="#submit-button, .feature-section"
                  className="bg-muted/30 font-mono text-xs"
                />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Transition In</Label>
            <Select value={transitionIn} onValueChange={setTransitionIn}>
              <SelectTrigger className="bg-muted/30">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSITIONS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="flex gap-2 sm:justify-between">
          {!isTH && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRecapture}
              disabled={recapturing || saving}
              title="Re-record this shot via the Playwright service"
            >
              {recapturing
                ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Re-capture
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving || recapturing}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || recapturing}>
              {saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
