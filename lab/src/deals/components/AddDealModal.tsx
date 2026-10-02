import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/deals/ui/dialog';
import { Button } from '@/deals/ui/button';
import { Input } from '@/deals/ui/input';
import { Label } from '@/deals/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/deals/ui/select';
import { apiCreateDeal, apiUpdateDeal, Deal, Confidence } from '@/deals/lib/supabase';
import { Stage } from '@/deals/lib/stages';
import { useStageLabels } from '@/deals/context/StageLabelsContext';
import { toast } from 'sonner';

interface AddDealModalProps {
  defaultStage?: Stage;
  onClose: () => void;
  onCreated: (deal: Deal) => void;
}

export default function AddDealModal({ defaultStage = 'new_requests', onClose, onCreated }: AddDealModalProps) {
  const { getStageLabel, dealStageKeys, productionStageKeys, isProductionStage } = useStageLabels();
  const [form, setForm] = useState({ client_name: '', client_email: '', project_name: '', estimated_value: '', currency: 'USD', confidence: 'medium' as Confidence, stage: defaultStage });
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleCreate = async () => {
    if (!form.client_name.trim() || !form.client_email.trim()) { toast.error('Client name and email are required'); return; }
    setSaving(true);
    try {
      const deal = await apiCreateDeal({
        client_name: form.client_name.trim(),
        client_email: form.client_email.trim(),
        project_name: form.project_name.trim() || null,
        estimated_value: form.estimated_value ? Number(form.estimated_value) : null,
        currency: form.currency,
        stage: form.stage,
        confidence: form.confidence,
        source: 'manual',
      });
      // createDeal has no in_production input: a deal created straight into a
      // production stage gets the flag the board would have set.
      const created = isProductionStage(form.stage)
        ? await apiUpdateDeal(deal.id, { in_production: true }).catch(() => deal)
        : deal;
      onCreated(created);
      toast.success('Deal created');
      onClose();
    } catch { toast.error('Failed to create deal'); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md border-border/40" style={{ background: 'hsl(var(--card))' }}>
        <DialogHeader>
          <DialogTitle className="text-foreground">New Deal</DialogTitle>
          <p className="sr-only">Fill in the details to create a new deal</p>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Client Name *</Label>
              <Input value={form.client_name} onChange={e => set('client_name', e.target.value)} placeholder="Acme Corp" className="bg-muted/30 border-border/50" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Client Email *</Label>
              <Input type="email" value={form.client_email} onChange={e => set('client_email', e.target.value)} placeholder="contact@acme.com" className="bg-muted/30 border-border/50" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Project Name</Label>
            <Input value={form.project_name} onChange={e => set('project_name', e.target.value)} placeholder="Optional" className="bg-muted/30 border-border/50" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs text-muted-foreground">Estimated Value</Label>
              <Input type="number" value={form.estimated_value} onChange={e => set('estimated_value', e.target.value)} placeholder="0" className="bg-muted/30 border-border/50" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Currency</Label>
              <Input value={form.currency} onChange={e => set('currency', e.target.value)} maxLength={3} className="bg-muted/30 border-border/50" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Stage</Label>
              <Select value={form.stage} onValueChange={v => set('stage', v)}>
                <SelectTrigger className="bg-muted/30 border-border/50"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {/* Live stages (custom + renamed), deal stages first */}
                  {dealStageKeys.map(k => <SelectItem key={k} value={k}>{getStageLabel(k, k)}</SelectItem>)}
                  {productionStageKeys.map(k => <SelectItem key={k} value={k}>{getStageLabel(k, k)} · Production</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Confidence</Label>
              <Select value={form.confidence} onValueChange={v => set('confidence', v)}>
                <SelectTrigger className="bg-muted/30 border-border/50"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-border/50">Cancel</Button>
          <Button onClick={handleCreate} disabled={saving} className="bg-primary text-primary-foreground">
            {saving ? 'Creating…' : 'Add Deal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
