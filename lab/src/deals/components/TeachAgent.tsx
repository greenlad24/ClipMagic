/**
 * Teach the email agent (Agent page) — Jake 2026-10-02: "I want to add a
 * conversation between me and my partner and have the agent understand the
 * new rule."
 *
 *   TeachAgentPanel   paste a conversation (or write the rule) → "Understand it"
 *                     (one Opus call, nothing saved) → review / edit the rules it
 *                     understood → "Save rules". Below: Jake's rules, editable,
 *                     removable. The same rules can be taught in Slack by
 *                     starting a message with "rule:".
 *   LessonList        what it learned on its own, now editable / deletable.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Pencil, Sparkles, Trash2, X, MessageSquare, AlertTriangle } from 'lucide-react';
import {
  understandAgentRules, saveAgentRules, listAgentRules, updateAgentRule, retireAgentRule,
  updateAgentLesson, deleteAgentLesson, type AgentRule, type ProposedRule, type AgentLesson,
} from '@/deals/api';

const box = { background: 'var(--bg-panel)', border: '1px solid var(--border-color)' } as const;
const input = { background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' } as const;
const muted = { color: 'var(--text-muted)' } as const;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ScopeChip({ r }: { r: { scope: string; brand: string | null; stage: string | null } }) {
  const label = r.scope === 'brand' && r.brand ? r.brand : r.scope === 'stage' && r.stage ? r.stage : 'All emails';
  return <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--pill-blue-bg)', color: 'var(--pill-blue-text)' }}>{label}</span>;
}

function relative(iso: string): string {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

/* ── Teach + Jake's rules ─────────────────────────────────────────────────── */

export function TeachAgentPanel() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<{ summary: string; rules: ProposedRule[]; unclear: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState<AgentRule[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const load = useCallback(async () => {
    try { setRules((await listAgentRules()).rules); } catch { setRules([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const understand = async () => {
    setBusy(true);
    try { setProposal(await understandAgentRules({ text })); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!proposal?.rules.length) return;
    setSaving(true);
    try {
      const r = await saveAgentRules({ text, rules: proposal.rules });
      toast.success(`${r.rules.length} rule${r.rules.length === 1 ? '' : 's'} saved — the agent follows ${r.rules.length === 1 ? 'it' : 'them'} from its next email`);
      setProposal(null); setText(''); void load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };

  const patchProposal = (i: number, rule: string) => setProposal((p) => (p ? { ...p, rules: p.rules.map((r, j) => (j === i ? { ...r, rule } : r)) } : p));
  const dropProposal = (i: number) => setProposal((p) => (p ? { ...p, rules: p.rules.filter((_, j) => j !== i) } : p));

  const saveEdit = async (id: string) => {
    try { await updateAgentRule({ id, rule: editText }); setEditing(null); void load(); toast.success('Rule updated'); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (r: AgentRule) => {
    if (!window.confirm(`Remove this rule?\n\n${r.rule}`)) return;
    try { await retireAgentRule({ id: r.id }); void load(); }
    catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={'Paste a conversation with your partner — or just write the rule.\n\nJake: Agencies keep asking for Shorts bundles\nElad: Let\'s stop offering Shorts to agencies, only dedicated videos\nJake: Agreed, unless they\'re a returning brand'}
          className="w-full rounded-lg p-3 text-sm leading-relaxed resize-y outline-none"
          style={input}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => void understand()} disabled={busy || text.trim().length < 10}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3.5 py-2 rounded-lg disabled:opacity-50"
            style={{ background: 'hsl(var(--primary))', color: '#fff' }}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {busy ? 'Reading it…' : 'Understand it'}
          </button>
          <span className="text-[11px]" style={muted}>Nothing is saved until you check what it understood. In Slack: start a message in the agent's channel with <b>rule:</b></span>
        </div>
      </div>

      {proposal && (
        <div className="rounded-lg p-3 space-y-3" style={box}>
          {proposal.summary && <p className="text-sm" style={{ color: 'var(--text-primary)' }}><b>What you decided:</b> {proposal.summary}</p>}
          {proposal.rules.length === 0 ? (
            <p className="text-sm" style={muted}>It didn't find a decided rule in that. Add the decision and try again.</p>
          ) : (
            <ol className="space-y-2">
              {proposal.rules.map((r, i) => (
                <li key={i} className="space-y-1">
                  <div className="flex items-start gap-2">
                    <span className="text-xs font-semibold mt-2" style={muted}>{i + 1}.</span>
                    <textarea value={r.rule} onChange={(e) => patchProposal(i, e.target.value)} rows={2}
                      className="flex-1 rounded-md p-2 text-sm resize-y outline-none" style={input} />
                    <button onClick={() => dropProposal(i)} className="mt-2" style={muted} title="Leave this one out"><X size={14} /></button>
                  </div>
                  <div className="flex items-center gap-2 pl-5 flex-wrap">
                    <ScopeChip r={r} />
                    {r.overrides && <span className="text-[11px]" style={{ color: 'var(--pill-orange-text, #c2410c)' }}>Changes {r.overrides}</span>}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {proposal.unclear.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--pill-orange-text, #c2410c)' }}><AlertTriangle size={12} /> Not decided in the conversation — not saved:</p>
              <ul className="text-xs list-disc pl-5" style={muted}>{proposal.unclear.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button onClick={() => void save()} disabled={saving || !proposal.rules.length}
              className="inline-flex items-center gap-1.5 text-sm font-medium px-3.5 py-2 rounded-lg disabled:opacity-50"
              style={{ background: 'hsl(var(--primary))', color: '#fff' }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save {proposal.rules.length} rule{proposal.rules.length === 1 ? '' : 's'}
            </button>
            <button onClick={() => setProposal(null)} className="text-sm px-3 py-2" style={muted}>Discard</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider" style={muted}>Your rules {rules ? `(${rules.length})` : ''} — they override the rulebook</p>
        {rules === null ? <p className="text-sm" style={muted}>Loading…</p> : rules.length === 0 ? (
          <p className="text-sm" style={muted}>None yet.</p>
        ) : (
          <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
            {rules.map((r) => (
              <li key={r.id} className="rounded-lg p-3" style={box}>
                {editing === r.id ? (
                  <div className="space-y-2">
                    <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} className="w-full rounded-md p-2 text-sm resize-y outline-none" style={input} />
                    <div className="flex gap-2">
                      <button onClick={() => void saveEdit(r.id)} className="text-xs font-medium px-2.5 py-1 rounded-md" style={{ background: 'hsl(var(--primary))', color: '#fff' }}>Save</button>
                      <button onClick={() => setEditing(null)} className="text-xs px-2.5 py-1" style={muted}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm leading-snug" style={{ color: 'var(--text-primary)' }}>{r.rule}</p>
                )}
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <ScopeChip r={r} />
                  <span className="text-[11px] inline-flex items-center gap-1" style={muted}>{r.source === 'slack' ? <><MessageSquare size={10} /> From Slack</> : 'From the Lab'}</span>
                  {r.overrides && <span className="text-[11px]" style={muted}>· changes {r.overrides}</span>}
                  <span className="text-[11px] ml-auto" style={muted}>{relative(r.createdAt)}</span>
                  {editing !== r.id && <button onClick={() => { setEditing(r.id); setEditText(r.rule); }} style={muted} title="Edit"><Pencil size={13} /></button>}
                  <button onClick={() => void remove(r)} style={muted} title="Remove"><Trash2 size={13} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── What it learned on its own (editable) ────────────────────────────────── */

export function LessonList({ lessons, onChanged }: { lessons: AgentLesson[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const save = async (id: string) => {
    try { await updateAgentLesson({ id, lesson: editText }); setEditing(null); onChanged(); toast.success('Lesson updated'); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (l: AgentLesson) => {
    if (!window.confirm(`Delete this lesson?\n\n${l.lesson}`)) return;
    try { await deleteAgentLesson({ id: l.id }); onChanged(); }
    catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
      {lessons.map((l) => (
        <li key={l.id} className="rounded-lg p-3" style={box}>
          {editing === l.id ? (
            <div className="space-y-2">
              <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} className="w-full rounded-md p-2 text-sm resize-y outline-none" style={input} />
              <div className="flex gap-2">
                <button onClick={() => void save(l.id)} className="text-xs font-medium px-2.5 py-1 rounded-md" style={{ background: 'hsl(var(--primary))', color: '#fff' }}>Save</button>
                <button onClick={() => setEditing(null)} className="text-xs px-2.5 py-1" style={muted}>Cancel</button>
              </div>
            </div>
          ) : (
            <p className="text-sm leading-snug" style={{ color: 'var(--text-primary)' }}>{l.lesson}</p>
          )}
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--pill-gray-bg)', color: 'var(--pill-gray-text)' }}>{l.source === 'edit' ? 'From a draft edit' : 'From Slack'}</span>
            {l.brand && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--pill-blue-bg)', color: 'var(--pill-blue-text)' }}>{l.brand}</span>}
            {l.stage && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--pill-purple-bg)', color: 'var(--pill-purple-text)' }}>{l.stage}</span>}
            <span className="text-[11px] ml-auto" style={muted}>{relative(l.createdAt)}</span>
            {editing !== l.id && <button onClick={() => { setEditing(l.id); setEditText(l.lesson); }} style={muted} title="Edit"><Pencil size={13} /></button>}
            <button onClick={() => void remove(l)} style={muted} title="Delete"><Trash2 size={13} /></button>
          </div>
        </li>
      ))}
    </ul>
  );
}
