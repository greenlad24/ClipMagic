import { useState, useMemo } from 'react';
import { Link2, ChevronDown, ChevronUp, FileText, Play, Image as ImageIcon, Globe, Download, RefreshCw, Paperclip, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { downloadAttachment } from '@/deals/lib/attachments';
import { Deal, Comment, Action } from '@/deals/lib/supabase';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/deals/ui/tooltip';
import { GetThreadOutputType } from '@/deals/api';

type ThreadMessage = GetThreadOutputType['messages'][0];

interface LinkInfo {
  url: string;
  domain: string;
  title: string;
  type: 'image' | 'video' | 'document' | 'link';
  faviconUrl: string;
  embedId?: string;
  embedProvider?: 'youtube' | 'loom';
  fromThread?: boolean;
}

interface AttachmentInfo {
  name: string;
  mimeType: string;
  attachmentId: string;
  size: number;
  messageId: string;
}

const URL_REGEX = /(https?:\/\/[^\s<>"')[\]]+)/g;
const EXCLUDE = ['mail.google.com/mail', 'accounts.google.com', 'support.google.com', 'unsubscribe', 'click.', 'tracking.', 'open.', 'email.', 'links.', 'mailchi.mp'];
const DOC_EXTS = /\.(pdf|doc|docx|zip|mp4|xls|xlsx|ppt|pptx|csv)(\?|#|$)/i;
const IMG_EXTS  = /\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i;

function shouldInclude(url: string): boolean {
  return !EXCLUDE.some(e => url.includes(e));
}

function parseLink(url: string, fromThread = false): LinkInfo | null {
  try {
    const u = new URL(url);
    const domain = u.hostname.replace(/^www\./, '');
    const clean = url.split('?')[0].split('#')[0];

    let type: LinkInfo['type'] = 'link';
    let embedId: string | undefined;
    let embedProvider: LinkInfo['embedProvider'];

    if (IMG_EXTS.test(clean)) {
      type = 'image';
    } else if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
      type = 'video';
      embedProvider = 'youtube';
      embedId = domain.includes('youtu.be')
        ? u.pathname.slice(1).split('?')[0]
        : u.searchParams.get('v') ?? undefined;
    } else if (domain.includes('loom.com')) {
      type = 'video';
      embedProvider = 'loom';
      embedId = u.pathname.match(/\/(share|embed)\/([a-zA-Z0-9]+)/)?.[2];
    } else if (DOC_EXTS.test(clean)) {
      type = 'document';
    }

    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    const title = last
      .replace(/[-_]/g, ' ')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim() || domain;

    return { url, domain, title, type, faviconUrl: `https://www.google.com/s2/favicons?domain=${domain}&sz=16`, embedId, embedProvider, fromThread };
  } catch { return null; }
}

function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_REGEX) ?? []).filter(shouldInclude))];
}

function formatFileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  deal: Deal;
  comments: Comment[];
  actions: Action[];
  threadMessages?: ThreadMessage[];
  /** The mailbox the thread was read from (needed to download attachments). */
  threadAccountEmail?: string;
  fetchingThread?: boolean;
  onFetchThread?: () => Promise<void>;
}

const ICON_MAX = 8;

function TypeIcon({ link }: { link: LinkInfo }) {
  const [imgError, setImgError] = useState(false);
  if (link.type === 'video') return <Play size={14} className="text-primary" />;
  if (link.type === 'document') return <FileText size={14} className="text-muted-foreground" />;
  if (link.type === 'image') return <ImageIcon size={14} className="text-muted-foreground" />;
  if (!imgError) {
    return (
      <img
        src={link.faviconUrl} alt="" width={14} height={14}
        onError={() => setImgError(true)}
        style={{ display: 'block' }}
      />
    );
  }
  return <Globe size={14} className="text-muted-foreground" />;
}

export default function LinksMediaSection({ deal, comments, actions, threadMessages = [], threadAccountEmail = '', fetchingThread, onFetchThread }: Props) {
  const [open, setOpen] = useState(false);

  const dealLinks = useMemo(() => {
    const allText = [
      deal.description ?? '',
      ...comments.map(c => c.content),
      ...actions.map(a => a.content),
    ].join(' ');
    const urls = extractUrls(allText);
    return urls.map(u => parseLink(u, false)).filter((l): l is LinkInfo => l !== null);
  }, [deal.description, comments, actions]);

  const threadLinks = useMemo(() => {
    if (!threadMessages.length) return [];
    const allText = threadMessages.map(m => `${m.body} ${m.bodyHtml}`).join(' ');
    const urls = extractUrls(allText);
    const dealUrlSet = new Set(dealLinks.map(l => l.url));
    return urls
      .filter(u => !dealUrlSet.has(u))
      .map(u => parseLink(u, true))
      .filter((l): l is LinkInfo => l !== null);
  }, [threadMessages, dealLinks]);

  const threadAttachments = useMemo((): AttachmentInfo[] => {
    if (!threadMessages.length) return [];
    return threadMessages.flatMap(msg =>
      msg.attachments.map(a => ({ ...a, messageId: msg.id }))
    );
  }, [threadMessages]);

  const allLinks = useMemo(() => [...dealLinks, ...threadLinks], [dealLinks, threadLinks]);

  const visible = allLinks.slice(0, ICON_MAX);
  const overflow = allLinks.length - ICON_MAX;
  const hasThreadData = threadMessages.length > 0;
  const totalCount = allLinks.length + threadAttachments.length;

  return (
    <TooltipProvider delayDuration={300}>
      <div>
        {/* Section header */}
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-2 group flex-1 min-w-0"
          >
            <Link2 size={14} className="text-primary flex-shrink-0" />
            <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Links &amp; Media
            </span>
            {totalCount > 0 && (
              <span className="text-[10px] font-bold bg-muted text-muted-foreground rounded-full px-1.5 py-0.5">
                {totalCount}
              </span>
            )}
            {open
              ? <ChevronUp size={13} className="text-muted-foreground/50 ml-auto" />
              : <ChevronDown size={13} className="text-muted-foreground/50 ml-auto" />
            }
          </button>

          {/* Fetch from thread button */}
          {onFetchThread && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onFetchThread}
                  disabled={fetchingThread}
                  className="ml-2 flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md hover:bg-muted transition-colors disabled:opacity-50"
                  title="Fetch files & links from email thread"
                >
                  <RefreshCw size={11} className={`text-muted-foreground ${fetchingThread ? 'animate-spin' : ''}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {fetchingThread ? 'Fetching thread…' : 'Fetch files & links from email thread'}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Collapsed icon pills row */}
        {!open && allLinks.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
              {visible.map((link, i) => (
                <Tooltip key={i}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
                      className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors flex-shrink-0 border ${link.fromThread ? 'bg-primary/5 border-primary/20 hover:bg-primary/15' : 'bg-muted hover:bg-primary/10 border-border/50'}`}
                    >
                      <TypeIcon link={link} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    <p className="font-medium">{link.title}</p>
                    <p className="text-muted-foreground">{link.domain}</p>
                    {link.fromThread && <p className="text-primary/70">From email thread</p>}
                  </TooltipContent>
                </Tooltip>
              ))}
              {overflow > 0 && (
                <button
                  onClick={() => setOpen(true)}
                  className="h-7 px-2 rounded-md bg-muted text-[11px] text-muted-foreground hover:bg-muted/80 transition-colors border border-border/50"
                >
                  +{overflow} more
                </button>
              )}
              {threadAttachments.length > 0 && !open && (
                <button
                  onClick={() => setOpen(true)}
                  className="h-7 px-2 rounded-md bg-primary/5 border border-primary/20 text-[11px] text-primary hover:bg-primary/15 transition-colors flex items-center gap-1"
                >
                  <Paperclip size={10} />
                  {threadAttachments.length} file{threadAttachments.length !== 1 ? 's' : ''}
                </button>
              )}
            </div>
        )}

        {/* Expanded full list */}
        <div className={`overflow-hidden transition-all duration-300 ${open ? 'max-h-[700px] mt-2' : 'max-h-0'}`}>
          {allLinks.length === 0 && threadAttachments.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-xs text-muted-foreground/40 mb-2">No links from this contact yet</p>
              {onFetchThread && !hasThreadData && (
                <button
                  onClick={onFetchThread}
                  disabled={fetchingThread}
                  className="text-xs text-primary hover:text-primary/70 flex items-center gap-1.5 mx-auto"
                >
                  <RefreshCw size={11} className={fetchingThread ? 'animate-spin' : ''} />
                  {fetchingThread ? 'Fetching…' : 'Fetch from email thread'}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {/* Thread attachments at the top */}
              {threadAttachments.length > 0 && (
                <div className="mb-2">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 px-2.5 mb-1 flex items-center gap-1.5">
                    <Paperclip size={9} /> Attachments ({threadAttachments.length})
                  </p>
                  {threadAttachments.map((att, i) => (
                    <AttachmentRow key={i} attachment={att} accountEmail={threadAccountEmail} />
                  ))}
                </div>
              )}

              {/* Links */}
              {allLinks.length > 0 && (
                <>
                  {threadAttachments.length > 0 && (
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 px-2.5 mb-1 flex items-center gap-1.5">
                      <Link2 size={9} /> Links ({allLinks.length})
                    </p>
                  )}
                  {allLinks.map((link, i) => (
                    <LinkRow key={i} link={link} />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function LinkRow({ link }: { link: LinkInfo }) {
  const [imgError, setImgError] = useState(false);
  const isDownloadable = DOC_EXTS.test(link.url.split('?')[0]);

  return (
    <div
      onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
      title={link.url}
      className={`group/row flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer ${link.fromThread ? 'border-l-2 border-primary/20' : ''}`}
    >
      <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-md bg-muted overflow-hidden">
        {link.type === 'image' && !imgError ? (
          <img src={link.url} alt="" className="w-full h-full object-cover" onError={() => setImgError(true)} loading="lazy" />
        ) : link.type === 'video' ? (
          <Play size={15} className="text-primary" />
        ) : link.type === 'document' ? (
          <FileText size={15} className="text-muted-foreground" />
        ) : link.type === 'image' && imgError ? (
          <ImageIcon size={15} className="text-muted-foreground" />
        ) : (
          <img src={link.faviconUrl} alt="" width={16} height={16} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground truncate">{link.domain}</p>
        <p className="text-[11px] font-medium text-foreground/80 truncate">{link.title}</p>
        {link.fromThread && <p className="text-[10px] text-primary/50">From thread</p>}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity flex-shrink-0">
        {isDownloadable && (
          <a href={link.url} download onClick={e => e.stopPropagation()}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="Download">
            <Download size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

function AttachmentRow({ attachment, accountEmail }: { attachment: AttachmentInfo; accountEmail: string }) {
  const [downloading, setDownloading] = useState(false);
  const ext = attachment.name.split('.').pop()?.toLowerCase() ?? '';
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
  const isVideo = ['mp4', 'mov', 'avi', 'mkv'].includes(ext);
  const isPdf = ext === 'pdf';

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadAttachment({ ...attachment, accountEmail });
    } catch {
      toast.error(`Failed to download ${attachment.name}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={downloading}
      title={`Download ${attachment.name}`}
      className="group/att w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-muted/50 transition-colors disabled:cursor-wait"
    >
      <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-md bg-primary/5 border border-primary/10">
        {isImage ? <ImageIcon size={14} className="text-primary/60" />
          : isVideo ? <Play size={14} className="text-primary/60" />
          : isPdf ? <FileText size={14} className="text-primary/60" />
          : <Paperclip size={14} className="text-primary/60" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-medium text-foreground/80 truncate">{attachment.name}</p>
        <p className="text-[10px] text-muted-foreground/60">{formatFileSize(attachment.size)}</p>
      </div>
      <span className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded text-muted-foreground group-hover/att:text-foreground">
        {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
      </span>
    </button>
  );
}
