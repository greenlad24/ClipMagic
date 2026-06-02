import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Download, Upload, FileJson } from 'lucide-react';
import { TimelineTemplate, TimelineShot } from './types';

interface Props {
  open: boolean;
  onClose: () => void;
  shots: TimelineShot[];
  duration: number;
  onImport: (template: TimelineTemplate) => void;
}

export default function TemplateDialog({ open, onClose, shots, duration, onImport }: Props) {
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const buildTemplate = (): TimelineTemplate => ({
    name: 'Exported Template',
    version: '1.0',
    description: `${shots.length} shots, ${duration.toFixed(0)}s`,
    shots: shots.map(s => ({
      shotType: s.shotType ?? 'Talking Head',
      beat: s.beat ?? 'Hook',
      startRatio: (s.startTime ?? 0) / Math.max(duration, 1),
      endRatio: (s.endTime ?? 1) / Math.max(duration, 1),
      transitionIn: s.transitionIn,
      sfxIn: s.sfxIn,
      captionPlaceholder: s.caption,
    })),
  });

  const handleDownload = () => {
    const blob = new Blob([JSON.stringify(buildTemplate(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'timeline-template.json'; a.click();
    URL.revokeObjectURL(url);
    toast.success('Template downloaded');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { setImportJson((ev.target?.result as string) ?? ''); setImportError(''); };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleApply = () => {
    setImportError('');
    try {
      const parsed = JSON.parse(importJson);
      if (!Array.isArray(parsed.shots)) throw new Error('Template must have a "shots" array');
      for (const s of parsed.shots) {
        if (!s.shotType || !s.beat) throw new Error('Each shot needs shotType and beat fields');
        if (typeof s.startRatio !== 'number' || typeof s.endRatio !== 'number')
          throw new Error('Each shot needs startRatio and endRatio (0–1)');
        if (s.startRatio >= s.endRatio) throw new Error('startRatio must be less than endRatio');
      }
      onImport(parsed as TimelineTemplate);
      setImportJson('');
      toast.success(`Template "${parsed.name ?? 'Unnamed'}" applied — ${parsed.shots.length} shots`);
      onClose();
    } catch (err: any) {
      setImportError(err.message ?? 'Invalid template JSON');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="w-4 h-4 text-primary" />
            Timeline Templates
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="export">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="export">Export Current</TabsTrigger>
            <TabsTrigger value="import">Import Template</TabsTrigger>
          </TabsList>

          <TabsContent value="export" className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Export this project's shot structure as a reusable JSON template. Media URLs are stripped — only timing, beat, transitions, and camera presets are saved. Share this file with others to apply the same editing structure to any project.
            </p>
            <pre className="text-[10px] bg-muted/30 rounded-lg p-3 overflow-auto max-h-52 text-foreground/70 font-mono leading-relaxed border border-border/50">
              {JSON.stringify(buildTemplate(), null, 2)}
            </pre>
            <Button onClick={handleDownload} className="w-full" size="sm">
              <Download className="w-3.5 h-3.5 mr-2" />Download timeline-template.json
            </Button>
          </TabsContent>

          <TabsContent value="import" className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Upload or paste a template JSON. Shots will be re-mapped to the template's structure by matching beat and type. Unmatched template slots become placeholder shots.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="w-3.5 h-3.5 mr-1.5" />Upload .json file
              </Button>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileUpload} />
            </div>
            <Textarea
              value={importJson}
              onChange={e => { setImportJson(e.target.value); setImportError(''); }}
              placeholder={'{\n  "name": "My Template",\n  "version": "1.0",\n  "shots": [\n    { "shotType": "Talking Head", "beat": "Hook", "startRatio": 0, "endRatio": 0.12, "transitionIn": "Hard Cut" }\n  ]\n}'}
              className="font-mono text-[10px] h-44 bg-muted/20 leading-relaxed"
            />
            {importError && <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">{importError}</p>}
            <Button onClick={handleApply} disabled={!importJson.trim()} className="w-full" size="sm">
              Apply Template to Project
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
