import { useState, useRef, useEffect } from 'react';
import { Loader2, Paperclip, Send, X } from 'lucide-react';
import { lookupThread, generateReply, sendReply, LookupThreadOutputType } from '@/deals/api';
// Lab port: zitejs/upload → the Lab's own upload shim (POST /api/uploads; returns { fileUrl }).
import { uploadFile } from 'zite-file-upload-sdk';
import { toast } from 'sonner';
import { toastDraftSaved } from '@/deals/lib/draftToast';
import ThreadPreviewCard from './thread/ThreadPreviewCard';
import ReplyDraftCard from './thread/ReplyDraftCard';

type ThreadMatch = LookupThreadOutputType['matches'][0];

type PanelState =
  | { step: 'loading' }
  | { step: 'no_match'; keyword: string }
  | { step: 'multi_match'; matches: ThreadMatch[]; keyword: string }
  | { step: 'preview'; match: ThreadMatch; prevMatches: ThreadMatch[] | null; prevKeyword: string }
  | { step: 'context'; match: ThreadMatch }
  | { step: 'generating'; match: ThreadMatch; context: string; fileUrls: string[] }
  | { step: 'draft'; match: ThreadMatch; draft: string; contradiction: string | null; lastMessageId: string; lastReferences: string; lastSubject: string; editedDraft: string }
  | { step: 'sent'; match: ThreadMatch; gmailUrl?: string };

interface Props {
  searchTerm: string;
  onSearchAgain: () => void;
}

export default function ThreadComposePanel({ searchTerm, onSearchAgain }: Props) {
  const [state, setState] = useState<PanelState>({ step: 'loading' });
  const [contextInput, setContextInput] = useState('');
  const [fileUrls, setFileUrls] = useState<string[]>([]);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    lookupThread({ searchTerm }).then(({ matches, keyword }) => {
      const kw = keyword || searchTerm;
      if (!matches.length) setState({ step: 'no_match', keyword: kw });
      else if (matches.length === 1) setState({ step: 'preview', match: matches[0], prevMatches: null, prevKeyword: kw });
      else setState({ step: 'multi_match', matches, keyword: kw });
    }).catch(() => setState({ step: 'no_match', keyword: searchTerm }));
  }, [searchTerm]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFile(true);
    try {
      const { fileUrl } = await uploadFile({ data: file, filename: file.name });
      setFileUrls(prev => [...prev, fileUrl]);
      setFileNames(prev => [...prev, file.name]);
    } catch { /* ignore */ } finally {
      setUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleContextSubmit = async () => {
    if (state.step !== 'context' || !contextInput.trim()) return;
    const match = state.match;
    setState({ step: 'generating', match, context: contextInput, fileUrls });
    try {
      const result = await generateReply({
        threadId: match.threadId,
        firstName: match.clientName.split(' ')[0] || 'there',
        companyName: match.clientName,
        projectName: match.projectName,
        stage: match.stage,
        toEmail: match.toEmail,
        userContext: contextInput,
        fileUrls,
      });
      setState({
        step: 'draft',
        match,
        draft: result.draft,
        contradiction: result.contradiction,
        lastMessageId: result.lastMessageId,
        lastReferences: result.lastReferences,
        lastSubject: result.lastSubject,
        editedDraft: result.draft,
      });
    } catch {
      setState({ step: 'context', match });
    }
  };

  const handleRegenerate = async (steeringNote: string) => {
    if (state.step !== 'draft') return;
    const match = state.match;
    const prevDraft = state.editedDraft;
    const { lastMessageId, lastReferences, lastSubject } = state;
    setState({ step: 'generating', match, context: contextInput, fileUrls });
    try {
      const result = await generateReply({
        threadId: match.threadId,
        firstName: match.clientName.split(' ')[0] || 'there',
        companyName: match.clientName,
        projectName: match.projectName,
        stage: match.stage,
        toEmail: match.toEmail,
        userContext: contextInput,
        fileUrls,
        steeringNote,
      });
      setState({ step: 'draft', match, draft: result.draft, contradiction: result.contradiction, lastMessageId, lastReferences, lastSubject, editedDraft: result.draft });
    } catch {
      setState({ step: 'draft', match, draft: prevDraft, contradiction: null, lastMessageId, lastReferences, lastSubject, editedDraft: prevDraft });
    }
  };

  const handleSend = async () => {
    if (state.step !== 'draft') return;
    setIsSending(true);
    try {
      // Lab port: NEVER SENDS — the server saves the reply as a Gmail draft.
      const res = await sendReply({
        dealId: state.match.dealId,
        threadId: state.match.threadId,
        toEmail: state.match.toEmail,
        lastMessageId: state.lastMessageId,
        lastReferences: state.lastReferences,
        subject: state.lastSubject,
        draftText: state.editedDraft,
      });
      setState({ step: 'sent', match: state.match, gmailUrl: res.gmailUrl });
      toastDraftSaved(`Reply to ${state.match.clientName.split(' ')[0] || 'them'} saved as a Gmail draft`, res.gmailUrl);
    } catch (e: any) {
      /* stay on draft */
      toast.error(`Could not save the draft: ${e?.message ?? 'unknown error'}`);
    } finally {
      setIsSending(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (state.step === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 size={14} className="animate-spin" />
        <span>{searchTerm ? `Fetching latest threads for "${searchTerm}"…` : 'Loading your threads…'}</span>
      </div>
    );
  }

  if (state.step === 'no_match') {
    return (
      <div className="text-sm text-muted-foreground">
        {state.keyword
          ? <>No threads found matching <span className="font-medium text-foreground">"{state.keyword}"</span>.{' '}</>
          : <>No email threads found.{' '}</>
        }
        <button onClick={onSearchAgain} className="text-primary underline">Search again?</button>
      </div>
    );
  }

  if (state.step === 'multi_match') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-foreground font-medium">
          Found {state.matches.length} thread{state.matches.length !== 1 ? 's' : ''} for{' '}
          {state.keyword ? <span className="text-primary">"{state.keyword}"</span> : 'your search'}
        </p>
        <div className="max-h-[420px] overflow-y-auto space-y-1.5 pr-0.5">
          {state.matches.map((match, i) => (
            <button
              key={match.threadId}
              onClick={() => setState({ step: 'preview', match, prevMatches: state.matches, prevKeyword: state.keyword })}
              className="w-full text-left p-3 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                <span className="text-sm font-medium text-foreground truncate flex-1">{match.lastSubject || match.projectName || match.clientName}</span>
                {match.hasDeal && match.stage && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary shrink-0">{match.stage}</span>
                )}
                {!match.hasDeal && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">no deal</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground pl-6 flex items-center gap-1">
                {match.lastMessageIsDraft
                  ? <span className="text-amber-700 font-medium">✏ Draft (unsent)</span>
                  : match.lastMessageFrom
                }
                {' · '}{match.messageCount} msg{match.messageCount !== 1 ? 's' : ''}
                {match.lastMessageDate ? ` · ${new Date(match.lastMessageDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
              </p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (state.step === 'preview') {
    const { match, prevMatches, prevKeyword } = state;
    return (
      <ThreadPreviewCard
        match={match}
        onApprove={() => setState({ step: 'context', match })}
        onReject={onSearchAgain}
        onBack={prevMatches
          ? () => setState({ step: 'multi_match', matches: prevMatches, keyword: prevKeyword })
          : undefined}
      />
    );
  }

  if (state.step === 'context') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-foreground">
          What do you want to share in this reply? Paste text, drop a link, or attach a file.
        </p>
        <div className="border border-border rounded-xl bg-card p-3 space-y-2">
          <textarea
            value={contextInput}
            onChange={e => setContextInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleContextSubmit(); }}
            placeholder="e.g. Here's the invoice link: https://… — confirm upload date is June 18"
            rows={3}
            className="w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none leading-relaxed"
          />
          {fileNames.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {fileNames.map((name, i) => (
                <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground flex items-center gap-1">
                  <Paperclip size={9} /> {name}
                  <button onClick={() => { setFileNames(prev => prev.filter((_, j) => j !== i)); setFileUrls(prev => prev.filter((_, j) => j !== i)); }}>
                    <X size={9} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2">
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingFile}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {uploadingFile ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />}
                {uploadingFile ? 'Uploading…' : 'Attach file'}
              </button>
            </div>
            <button
              onClick={handleContextSubmit}
              disabled={!contextInput.trim()}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
            >
              <Send size={12} /> Generate draft
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">⌘+Enter to generate</p>
      </div>
    );
  }

  if (state.step === 'generating') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 size={14} className="animate-spin" />
        <span>Drafting reply for {state.match.projectName || state.match.clientName}…</span>
      </div>
    );
  }

  if (state.step === 'draft') {
    const firstName = state.match.clientName.split(' ')[0] || 'them';
    return (
      <ReplyDraftCard
        draft={state.editedDraft}
        contradiction={state.contradiction}
        toName={firstName}
        company={state.match.projectName || state.match.clientName}
        isSending={isSending}
        isSent={false}
        onSend={handleSend}
        onEdit={(newText) => setState({ ...state, editedDraft: newText })}
        onRegenerate={handleRegenerate}
        onCancel={onSearchAgain}
      />
    );
  }

  if (state.step === 'sent') {
    return (
      <ReplyDraftCard
        draft=""
        contradiction={null}
        toName={state.match.clientName.split(' ')[0] || 'them'}
        company={state.match.projectName || state.match.clientName}
        isSending={false}
        isSent={true}
        gmailUrl={state.gmailUrl}
        onSend={() => {}}
        onEdit={() => {}}
        onRegenerate={() => {}}
        onCancel={() => {}}
      />
    );
  }

  return null;
}
