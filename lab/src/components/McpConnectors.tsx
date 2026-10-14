/**
 * The Lab's public ChatGPT connectors (MCP servers outside the sign-in gate —
 * server mcp/youtube.ts, mcp/media.ts), shown on Settings to the signed-in
 * operator only (Jake 2026-10-14). The address IS the key, so it starts hidden.
 */
import { useEffect, useState } from 'react';
import { Copy, Eye, EyeOff, Plug } from 'lucide-react';
import { toast } from 'sonner';
import { getMcpConnectors } from 'zite-endpoints-sdk';

type Connector = { id: string; name: string; url: string; tools: string };

export default function McpConnectors() {
  const [items, setItems] = useState<Connector[] | null>(null);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  useEffect(() => { getMcpConnectors({}).then((r) => setItems(r.connectors)).catch(() => setItems([])); }, []);
  if (!items?.length) return null;

  const copy = async (c: Connector) => {
    try { await navigator.clipboard.writeText(c.url); toast.success(`${c.name} address copied`); }
    catch { setShown((s) => ({ ...s, [c.id]: true })); toast.error('Copy blocked — select the address and copy it.'); }
  };
  const masked = (u: string) => u.replace(/\/([\w-]{20,})$/, (_, t: string) => `/${t.slice(0, 4)}${'•'.repeat(18)}`);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold"><Plug className="h-4 w-4 text-primary" /> ChatGPT connectors</div>
      <p className="mb-3 text-xs text-muted-foreground">
        Add one in ChatGPT: Settings → Apps &amp; Connectors → Advanced → Developer mode on → Create — paste the address, Authentication: <b>No authentication</b>.
        The address is the password: keep it private.
      </p>
      <div className="space-y-3">
        {items.map((c) => (
          <div key={c.id} className="rounded-md border border-border bg-background p-3">
            <p className="text-sm font-medium text-foreground">{c.name}</p>
            <p className="mb-2 text-xs text-muted-foreground">{c.tools}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground" title={shown[c.id] ? c.url : undefined}>{shown[c.id] ? c.url : masked(c.url)}</code>
              <button type="button" onClick={() => setShown((s) => ({ ...s, [c.id]: !s[c.id] }))} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title={shown[c.id] ? 'Hide' : 'Show'}>
                {shown[c.id] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <button type="button" onClick={() => void copy(c)} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"><Copy className="h-3.5 w-3.5" /> Copy</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
