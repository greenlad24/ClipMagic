/**
 * UX Scout — log in to a tool once, in the server's browser.
 *
 * Shows the server's Chromium live (a screenshot after every step). Click on
 * the picture to click there; type in the box and press Send; the keys row
 * covers Enter/Tab/Backspace/Escape. 2FA works the same way. The session stays
 * in that tool's own profile, so every later Scout starts logged in.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Check, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { addTool, consoleAct, importSession, listTools, markLoggedIn, removeTool, type ConsoleAct, type ConsoleResult, type ScoutTool } from './api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToolsChanged?: (tools: ScoutTool[]) => void;
  initialSlug?: string | null;
}

export default function ScoutLoginDialog({ open, onOpenChange, onToolsChanged, initialSlug }: Props) {
  const [tools, setTools] = useState<ScoutTool[]>([]);
  const [slug, setSlug] = useState<string | null>(initialSlug ?? null);
  const [frame, setFrame] = useState<ConsoleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [cookieText, setCookieText] = useState('');
  const [storageText, setStorageText] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await listTools();
      setTools(r.tools);
      onToolsChanged?.(r.tools);
      return r.tools;
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not load the tools'); return []; }
  }, [onToolsChanged]);

  useEffect(() => { if (open) { void refresh(); setSlug(initialSlug ?? null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const tool = tools.find((t) => t.slug === slug) ?? null;

  const act = useCallback(async (a: ConsoleAct) => {
    if (!slug) return;
    setBusy(true);
    try {
      const r = await consoleAct(slug, a);
      setFrame(r);
      if (r.url) setUrl(r.url);
      if (!r.ok) toast.error(r.message);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'The browser did not answer'); }
    finally { setBusy(false); }
  }, [slug]);

  // Opening a tool: go to its home page.
  useEffect(() => {
    if (open && tool) void act({ action: 'goto', url: tool.homeUrl });
    else setFrame(null);
  }, [open, tool?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const onImageClick = (e: MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void act({ action: 'click_frac', xFrac: (e.clientX - r.left) / r.width, yFrac: (e.clientY - r.top) / r.height });
  };

  const create = async () => {
    try {
      const r = await addTool(newName, newUrl);
      setNewName(''); setNewUrl('');
      await refresh();
      setSlug(r.tool.slug);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not add the tool'); }
  };

  const done = async () => {
    if (!slug) return;
    try { await markLoggedIn(slug); await refresh(); toast.success(`${tool?.name} is ready for the Scout`); setSlug(null); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save'); }
  };

  const doImport = async () => {
    if (!slug) return;
    setBusy(true);
    try {
      const r = await importSession(slug, cookieText, storageText);
      setFrame(r.result);
      if (r.result.url) setUrl(r.result.url);
      toast.success(`Imported ${r.cookies} cookie${r.cookies === 1 ? '' : 's'}${r.storageKeys ? ` and ${r.storageKeys} saved login item${r.storageKeys === 1 ? '' : 's'}` : ''} — check the picture shows you logged in`);
      setCookieText(''); setStorageText(''); setPasteOpen(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not import the session'); }
    finally { setBusy(false); }
  };

  const remove = async (t: ScoutTool) => {
    if (!window.confirm(`Remove ${t.name}? Its saved login is deleted too.`)) return;
    try { await removeTool(t.slug); await refresh(); if (slug === t.slug) setSlug(null); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not remove it'); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[96vw] max-h-[94vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tool ? `Log in to ${tool.name}` : 'Tool logins for the UX Scout'}</DialogTitle>
          <DialogDescription>
            {tool
              ? 'This is the server’s browser, live. Click on the picture to click there, type below, and finish the login (2FA included). Then press “I’m logged in”.'
              : 'The Scout uses each AI tool in its own browser profile on the server. Log in once per tool — use a test account if you have one. The login is kept for every later Scout.'}
          </DialogDescription>
        </DialogHeader>

        {!tool ? (
          <div className="space-y-4">
            <ul className="divide-y divide-border rounded-lg border border-border">
              {tools.length === 0 && <li className="p-3 text-sm text-muted-foreground">No tools yet — add the first one below.</li>}
              {tools.map((t) => (
                <li key={t.slug} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{t.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{t.homeUrl}</p>
                  </div>
                  <span className={cn('text-xs', t.loggedInAt ? 'text-emerald-500' : 'text-muted-foreground')}>
                    {t.loggedInAt ? `Logged in ${new Date(t.loggedInAt).toLocaleDateString()}` : 'Not logged in yet'}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setSlug(t.slug)}>{t.loggedInAt ? 'Check / re-login' : 'Log in'}</Button>
                  <button onClick={() => void remove(t)} className="text-muted-foreground hover:text-destructive" title="Remove"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
            <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
              <div className="space-y-1"><Label>Tool name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Higgsfield" /></div>
              <div className="space-y-1"><Label>Its website</Label><Input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="higgsfield.ai" /></div>
              <Button onClick={() => void create()} disabled={!newName.trim() || !newUrl.trim()}><Plus className="mr-1 h-4 w-4" /> Add and log in</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSlug(null)}><ArrowLeft className="mr-1 h-4 w-4" /> All tools</Button>
              <Input className="min-w-0 flex-1" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void act({ action: 'goto', url }); }} />
              <Button size="sm" variant="outline" onClick={() => void act({ action: 'goto', url })} disabled={busy}>Go</Button>
              <Button size="sm" variant="outline" onClick={() => void act({ action: 'back' })} disabled={busy}>Back</Button>
              <Button size="sm" variant="outline" onClick={() => void act({ action: 'screenshot' })} disabled={busy} title="Refresh the picture"><RefreshCw className="h-4 w-4" /></Button>
            </div>
            <div className="relative overflow-hidden rounded-lg border border-border bg-black">
              {frame?.image
                ? <img ref={imgRef} src={`data:image/jpeg;base64,${frame.image}`} onClick={onImageClick} className={cn('block w-full cursor-crosshair select-none', busy && 'opacity-60')} alt="The server's browser" draggable={false} />
                : <div className="flex aspect-[1280/900] items-center justify-center text-sm text-muted-foreground">{busy ? 'Opening…' : 'No picture yet'}</div>}
              {busy && <Loader2 className="absolute right-3 top-3 h-5 w-5 animate-spin text-white" />}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="min-w-0 flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder="Click a field in the picture, then type here and press Send"
                onKeyDown={(e) => { if (e.key === 'Enter' && text) { void act({ action: 'type', text }); setText(''); } }} type="text" autoComplete="off" />
              <Button size="sm" onClick={() => { void act({ action: 'type', text }); setText(''); }} disabled={busy || !text}>Send</Button>
              {['Enter', 'Tab', 'Backspace', 'Escape'].map((k) => (
                <Button key={k} size="sm" variant="outline" onClick={() => void act({ action: 'key', combo: k })} disabled={busy}>{k}</Button>
              ))}
              <Button size="sm" variant="outline" onClick={() => void act({ action: 'scroll', direction: 'up' })} disabled={busy}>↑</Button>
              <Button size="sm" variant="outline" onClick={() => void act({ action: 'scroll', direction: 'down' })} disabled={busy}>↓</Button>
            </div>
            <p className="text-[11px] text-muted-foreground">Passwords you type go straight to the server’s browser — they’re not stored by the Lab. “Sign in with Google” may be blocked in this browser; an email + password or magic-link login works best.</p>
            <div className="rounded-lg border border-border p-3">
              <button type="button" onClick={() => setPasteOpen((o) => !o)} className="text-xs font-medium text-foreground underline-offset-2 hover:underline">
                {pasteOpen ? '▾' : '▸'} Can’t log in here? Paste your session from your own browser
              </button>
              {pasteOpen && (
                <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                  <p>Some tools block logins from servers (Linearity answers 403). Log in to {tool.name} in <b>your own browser</b> (Firefox or Chrome), then bring the session over — once:</p>
                  <ol className="list-decimal space-y-1 pl-4">
                    <li><b>Cookies:</b> install Cookie-Editor (<a href="https://addons.mozilla.org/firefox/addon/cookie-editor/" target="_blank" rel="noreferrer" className="underline">Firefox</a> · <a href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm" target="_blank" rel="noreferrer" className="underline">Chrome</a>). On the logged-in {tool.name} tab, click its icon → Export → JSON (it's copied), and paste it below.</li>
                    <li><b>Saved login (needed for many apps):</b> on the same tab press F12 → Console. Paste this line and press Enter — <b>Firefox</b> blocks the first paste: type <code className="rounded bg-muted px-1 text-foreground">allow pasting</code>, press Enter, then paste again. Then paste the result below:
                      <code className="mt-1 block select-all rounded bg-muted p-1.5 font-mono text-[11px] text-foreground">{'copy(JSON.stringify({origin: location.origin, local: {...localStorage}}))'}</code>
                    </li>
                  </ol>
                  <Label className="text-xs">Cookies (JSON export)</Label>
                  <textarea value={cookieText} onChange={(e) => setCookieText(e.target.value)} rows={3} className="w-full rounded-md border border-input bg-background p-2 font-mono text-[11px]" placeholder='[{"name": "...", "value": "...", "domain": ".linearity.io", ...}]' />
                  <Label className="text-xs">Saved login (what the console copied)</Label>
                  <textarea value={storageText} onChange={(e) => setStorageText(e.target.value)} rows={3} className="w-full rounded-md border border-input bg-background p-2 font-mono text-[11px]" placeholder='{"origin": "https://cloud.linearity.io", "local": {...}}' />
                  <p>This is your live session — it stays in this tool’s private browser on the Lab server and isn’t shown or sent anywhere else.</p>
                  <Button size="sm" onClick={() => void doImport()} disabled={busy || (!cookieText.trim() && !storageText.trim())}>Import session</Button>
                </div>
              )}
            </div>
            <div className="flex justify-end"><Button onClick={() => void done()}><Check className="mr-1 h-4 w-4" /> I’m logged in</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
