import { useState, useEffect } from 'react';
import { useAuth } from 'zite-auth-sdk';
import { getServiceStatus } from 'zite-endpoints-sdk';
import { GetServiceStatusOutputType } from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';
import KinoviDebugPanel from '@/components/KinoviDebugPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CheckCircle2, XCircle, Copy, Check, Server, Film, Container, Terminal, AlertTriangle } from 'lucide-react';
import {
  CAPTURE_DOCKERFILE, CAPTURE_SERVER, CAPTURE_PACKAGE_JSON,
  RENDER_DOCKERFILE, RENDER_SERVER, RENDER_PACKAGE_JSON,
  DOCKER_COMPOSE, ENV_EXAMPLE, SETUP_COMMANDS,
} from '@/utils/serviceCode';

type Status = GetServiceStatusOutputType;

function CodeBlock({ code, fileName }: { code: string; fileName?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      {fileName && (
        <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border border-border border-b-0 rounded-t-xl">
          <span className="text-xs font-mono text-muted-foreground">{fileName}</span>
        </div>
      )}
      <pre className={`bg-card border border-border p-4 text-xs font-mono overflow-x-auto text-foreground whitespace-pre leading-relaxed ${fileName ? 'rounded-b-xl rounded-t-none' : 'rounded-xl'}`}>
        {code}
      </pre>
      <button
        onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 text-xs bg-muted hover:bg-muted/80 rounded border border-border text-muted-foreground transition-colors"
      >
        {copied ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy</>}
      </button>
    </div>
  );
}

function StatusCard({ label, configured, url }: { label: string; configured: boolean; url?: string }) {
  return (
    <div className={`flex items-center gap-3 p-4 rounded-xl border ${configured ? 'bg-primary/5 border-primary/20' : 'bg-destructive/5 border-destructive/20'}`}>
      {configured
        ? <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
        : <XCircle className="w-5 h-5 text-destructive shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground truncate">{configured && url ? url : 'Not configured — add the secret in the Zite Secrets panel'}</p>
      </div>
      <span className={`text-xs px-2 py-1 rounded font-medium shrink-0 ${configured ? 'bg-primary/20 text-primary' : 'bg-destructive/20 text-destructive'}`}>
        {configured ? 'Connected' : 'Missing'}
      </span>
    </div>
  );
}

export default function SetupPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    if (!user) return;
    getServiceStatus({}).then(setStatus).catch(() => {});
  }, [user]);

  return (
    <Layout breadcrumb="Service Setup">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">Service Setup Guide</h1>
          <p className="text-muted-foreground mt-1">
            Deploy the two Node.js microservices that power ShortStack's Playwright capture and FFmpeg render pipeline.
          </p>
        </div>

        {/* Connection status */}
        {status && (
          <div className="grid grid-cols-2 gap-3 mb-4">
            <StatusCard label="Playwright Capture Service" configured={status.captureConfigured} url={status.captureUrl} />
            <StatusCard label="FFmpeg Render Service" configured={status.renderConfigured} url={status.renderUrl} />
          </div>
        )}

        {/* Kinovi / Seedance AI diagnostic */}
        <div className="mb-8">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">AI Video Generation</p>
          <KinoviDebugPanel />
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="mb-6">
            <TabsTrigger value="overview"><Terminal className="w-3.5 h-3.5 mr-2" />Quick Start</TabsTrigger>
            <TabsTrigger value="capture"><Server className="w-3.5 h-3.5 mr-2" />Capture Service</TabsTrigger>
            <TabsTrigger value="render"><Film className="w-3.5 h-3.5 mr-2" />Render Service</TabsTrigger>
            <TabsTrigger value="deploy"><Container className="w-3.5 h-3.5 mr-2" />Deploy</TabsTrigger>
          </TabsList>

          {/* --- Overview --- */}
          <TabsContent value="overview" className="space-y-6">
            <div className="p-5 bg-card border border-border rounded-xl space-y-3">
              <h2 className="text-base font-semibold text-foreground">How it works</h2>
              <div className="grid grid-cols-2 gap-4 text-sm text-muted-foreground">
                <div className="space-y-2">
                  <p className="font-medium text-foreground">1. Playwright Capture Service</p>
                  <p>Receives a shot's target URL, selector, and time range. Launches a Chromium browser, navigates to the page, records the viewport for the exact duration, uploads the clip to S3-compatible storage, and returns the URL.</p>
                  <p className="font-mono text-xs">POST /capture → {"{"} clipUrl {"}"}</p>
                </div>
                <div className="space-y-2">
                  <p className="font-medium text-foreground">2. FFmpeg Render Service</p>
                  <p>Receives the full shot manifest (clips, narration, music, captions, transitions). Trims and scales each clip to 1080×1920, burns caption overlays, concatenates with transitions, mixes music with ducking, encodes H.264 30fps, and returns the final MP4 URL.</p>
                  <p className="font-mono text-xs">POST /render → {"{"} outputUrl {"}"}</p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <h2 className="text-base font-semibold text-foreground">Setup commands</h2>
              <CodeBlock code={SETUP_COMMANDS} />
            </div>
            <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">Storage</p>
              <p>Generated clips and rendered videos are stored in <strong className="text-foreground">Zite's built-in file storage</strong> — no S3 or R2 credentials required. The render service still needs S3 for its own output; set <code className="bg-muted px-1 rounded text-xs">S3_BUCKET</code> and AWS credentials in your <code className="bg-muted px-1 rounded text-xs">.env</code> for that service only.</p>
            </div>
          </TabsContent>

          {/* --- Capture Service --- */}
          <TabsContent value="capture" className="space-y-5">
            <div className="p-4 bg-card border border-border rounded-xl text-sm">
              <p className="font-medium text-foreground mb-1">API contract</p>
              <p className="text-muted-foreground">
                <code className="bg-muted px-1 rounded text-xs">POST /capture</code> — body: <code className="bg-muted px-1 rounded text-xs">{"{"} url, selector?, startTime, endTime, shotType {"}"}</code> — returns: <code className="bg-muted px-1 rounded text-xs">{"{"} clipUrl {"}"}</code>
              </p>
            </div>
            <CodeBlock code={CAPTURE_PACKAGE_JSON} fileName="capture-service/package.json" />
            <CodeBlock code={CAPTURE_DOCKERFILE} fileName="capture-service/Dockerfile" />
            <CodeBlock code={CAPTURE_SERVER} fileName="capture-service/server.js" />
          </TabsContent>

          {/* --- Render Service --- */}
          <TabsContent value="render" className="space-y-5">
            <div className="flex items-start gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl">
              <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
              <div className="text-sm">
                <p className="font-semibold text-foreground">Render service updated — redeploy required</p>
                <p className="text-muted-foreground mt-0.5">
                  The <code className="bg-muted px-1 rounded text-xs">server.js</code> below fixes a critical bug where FFmpeg failed with <em>"moov atom not found"</em> on multi-chunk videos. Copy the new code, replace your existing <code className="bg-muted px-1 rounded text-xs">render-service/server.js</code>, then run <code className="bg-muted px-1 rounded text-xs">docker compose up -d --build render</code>.
                </p>
              </div>
            </div>
            <div className="p-4 bg-card border border-border rounded-xl text-sm">
              <p className="font-medium text-foreground mb-1">API contract</p>
              <p className="text-muted-foreground">
                <code className="bg-muted px-1 rounded text-xs">POST /render</code> — body: full shot manifest — returns: <code className="bg-muted px-1 rounded text-xs">{"{"} outputUrl {"}"}</code>
              </p>
              <p className="text-muted-foreground mt-2">
                Requires <code className="bg-muted px-1 rounded text-xs">ffmpeg</code> on PATH (installed by the Dockerfile). The <code className="bg-muted px-1 rounded text-xs">node:20-slim</code> base image + <code className="bg-muted px-1 rounded text-xs">apt-get install ffmpeg</code> handles this.
              </p>
            </div>
            <CodeBlock code={RENDER_PACKAGE_JSON} fileName="render-service/package.json" />
            <CodeBlock code={RENDER_DOCKERFILE} fileName="render-service/Dockerfile" />
            <CodeBlock code={RENDER_SERVER} fileName="render-service/server.js" />
          </TabsContent>

          {/* --- Deploy --- */}
          <TabsContent value="deploy" className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">docker-compose.yml</h2>
              <p className="text-xs text-muted-foreground">Place this at the root of your project alongside <code className="bg-muted px-1 rounded">capture-service/</code> and <code className="bg-muted px-1 rounded">render-service/</code>.</p>
              <CodeBlock code={DOCKER_COMPOSE} fileName="docker-compose.yml" />
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">.env (copy as .env.example)</h2>
              <CodeBlock code={ENV_EXAMPLE} fileName=".env.example" />
            </div>

            <div className="p-5 bg-card border border-border rounded-xl space-y-3">
              <h2 className="text-sm font-semibold text-foreground">Connect to ShortStack</h2>
              <p className="text-sm text-muted-foreground">After your services are running and publicly accessible, add these two secrets in the <strong>Zite Secrets panel</strong> (Settings → Secrets):</p>
              <div className="space-y-2 font-mono text-xs">
                <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
                  <span className="text-muted-foreground w-56 shrink-0">ZITE_CAPTURE_SERVICE_URL</span>
                  <span className="text-foreground">http://your-server:3001</span>
                </div>
                <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
                  <span className="text-muted-foreground w-56 shrink-0">ZITE_RENDER_SERVICE_URL</span>
                  <span className="text-foreground">http://your-server:3002</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">The status indicators at the top of this page will turn green once both secrets are configured.</p>
            </div>

            <div className="p-4 bg-muted/30 border border-border rounded-xl text-sm text-muted-foreground">
              <p className="font-medium text-foreground mb-1">Hosting options</p>
              <p>Any server that can run Docker works — a $6/month VPS (Hetzner, DigitalOcean, fly.io), a home server, or a cloud VM. The Playwright service needs ~1 GB RAM; the render service needs ~512 MB + FFmpeg CPU time per render.</p>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
