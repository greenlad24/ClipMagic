import { useState } from 'react';
import { testKinoviApi, TestKinoviApiOutputType } from 'zite-endpoints-sdk';
import { Button } from '@/components/ui/button';
import { Activity, Copy, Check, ChevronDown, ChevronUp, Loader2, CheckCircle2, XCircle } from 'lucide-react';

type Result = TestKinoviApiOutputType;

export default function KinoviDebugPanel() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const runTest = async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await testKinoviApi({});
      setResult(r);
      setExpanded(true);
    } catch (e: any) {
      setResult({ success: false, apiKeyConfigured: false, diagnosis: e?.message ?? 'Unknown error calling test endpoint' });
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  };

  const copyRaw = () => {
    navigator.clipboard.writeText(result?.rawBody ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-card">
        <div className="flex items-center gap-2">
          {result
            ? result.success ? <CheckCircle2 className="w-4 h-4 text-primary" /> : <XCircle className="w-4 h-4 text-destructive" />
            : <Activity className="w-4 h-4 text-muted-foreground" />}
          <span className="text-sm font-medium text-foreground">Kinovi / Seedance API</span>
          {result && (
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${result.success ? 'bg-primary/20 text-primary' : 'bg-destructive/20 text-destructive'}`}>
              {result.success ? 'Working' : 'Failed'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {result && (
            <button onClick={() => setExpanded(e => !e)} className="p-1 text-muted-foreground hover:text-foreground transition-colors">
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
          <Button size="sm" variant="outline" onClick={runTest} disabled={loading} className="h-7 text-xs">
            {loading ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Testing…</> : 'Test API'}
          </Button>
        </div>
      </div>

      {result && expanded && (
        <div className="border-t border-border p-4 space-y-3 bg-muted/20">
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Diagnosis</p>
            <p className={`text-sm ${result.success ? 'text-foreground' : 'text-destructive'}`}>{result.diagnosis}</p>
          </div>
          {result.httpStatus !== undefined && (
            <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground">
              <span>HTTP {result.httpStatus}</span>
              {result.taskId && <span className="text-primary">task_id: {result.taskId}</span>}
              {!result.apiKeyConfigured && <span className="text-destructive">API key not configured</span>}
            </div>
          )}
          {result.rawBody && (
            <div className="relative">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Raw Response</p>
              <pre className="bg-card border border-border rounded-lg p-3 text-xs font-mono text-foreground overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                {result.rawBody.slice(0, 1200)}{result.rawBody.length > 1200 ? '\n…(truncated)' : ''}
              </pre>
              <button onClick={copyRaw} className="absolute top-7 right-2 flex items-center gap-1 px-2 py-1 text-xs bg-muted hover:bg-muted/80 rounded border border-border text-muted-foreground transition-colors">
                {copied ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy</>}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
