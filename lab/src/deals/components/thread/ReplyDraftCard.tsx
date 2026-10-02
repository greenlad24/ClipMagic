import { useState } from 'react';
import { Send, Edit2, RefreshCw, X, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { Textarea } from '@/deals/ui/textarea';
import { LinkedText, SignatureFooter, splitSignature } from '@/deals/signature';

interface Props {
  draft: string;
  contradiction: string | null;
  toName: string;
  company: string;
  isSending: boolean;
  isSent: boolean;
  /** Lab port: where the saved Gmail draft opens (after "Save as Gmail draft"). */
  gmailUrl?: string;
  onSend: () => void;
  onEdit: (newText: string) => void;
  onRegenerate: (steeringNote: string) => void;
  onCancel: () => void;
}

export default function ReplyDraftCard({
  draft, contradiction, toName, company, isSending, isSent, gmailUrl,
  onSend, onEdit, onRegenerate, onCancel,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() => splitSignature(draft).body);
  const sig = splitSignature(draft).signature;
  const [regenerating, setRegenerating] = useState(false);
  const [steeringInput, setSteeringInput] = useState('');

  const handleSaveEdit = () => {
    onEdit(sig ? `${editText.replace(/\s+$/, '')}\n\n${sig}` : editText);
    setEditing(false);
  };

  const handleRegenerate = () => {
    onRegenerate(steeringInput);
    setRegenerating(false);
    setSteeringInput('');
  };

  if (isSent) {
    return (
      <div className="border border-border rounded-xl bg-card p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="w-5 h-5 rounded-full bg-green-500/15 flex items-center justify-center">
            <Check size={11} className="text-green-600" />
          </div>
          Reply to {toName} · {company} saved as a Gmail draft — not sent.
          {gmailUrl && (
            <a href={gmailUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline font-medium">Open in Gmail</a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-xl bg-card p-4 space-y-3">
      <p className="text-xs text-muted-foreground font-medium">Draft reply to {toName} · {company}</p>

      {contradiction && (
        <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2.5 text-xs text-yellow-700 [.dealorg-dark_&]:text-yellow-400">
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
          {contradiction}
        </div>
      )}

      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={editText}
            onChange={e => setEditText(e.target.value)}
            className="text-xs font-mono leading-relaxed min-h-[160px] bg-muted/50"
          />
          <SignatureFooter signature={sig} />
          <div className="flex gap-2">
            <button onClick={handleSaveEdit} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground">Save</button>
            <button onClick={() => { setEditing(false); setEditText(splitSignature(draft).body); }} className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-foreground">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="bg-muted rounded-lg p-3 text-sm text-foreground leading-relaxed whitespace-pre-wrap"><LinkedText text={draft} /></div>
      )}

      {regenerating && (
        <div className="flex gap-2 items-center">
          <input
            autoFocus
            value={steeringInput}
            onChange={e => setSteeringInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleRegenerate()}
            placeholder="Direction? e.g. shorter, more formal, mention the deadline…"
            className="flex-1 text-xs bg-muted border border-border rounded-lg px-3 py-1.5 text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50"
          />
          <button onClick={handleRegenerate} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground">Go</button>
          <button onClick={() => setRegenerating(false)} className="text-xs text-muted-foreground px-2">Cancel</button>
        </div>
      )}

      {!editing && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onSend}
            disabled={isSending}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
          >
            {isSending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            {isSending ? 'Saving…' : 'Save as Gmail draft'}
          </button>
          <button
            onClick={() => { setEditing(true); setEditText(splitSignature(draft).body); }}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted"
          >
            <Edit2 size={12} /> Edit
          </button>
          <button
            onClick={() => setRegenerating(true)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted"
          >
            <RefreshCw size={12} /> Regenerate
          </button>
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <X size={12} /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}
