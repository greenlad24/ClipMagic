import { useState, useEffect } from 'react';
import { useAuth } from '../auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import NewsShell from '../shell/NewsShell';
import { getConnections, type NewsConnection } from '../api';

const PRESETS = ['#ffffff', '#0f0f0f', '#1a1a2e', '#0d1117', '#f5f5f0'];
const BG_KEY = 'ng-audience-bg';
const SCHEDULE_KEY = 'ng-schedule-time';
const TZ_KEY = 'ng-schedule-tz';

export default function SettingsPage() {
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();
  const [connections, setConnections] = useState<NewsConnection[] | null>(null);
  const [bgColor, setBgColor] = useState(() => localStorage.getItem(BG_KEY) || '#ffffff');
  const [scheduleTime, setScheduleTime] = useState(() => localStorage.getItem(SCHEDULE_KEY) || '07:30');
  const [timezone, setTimezone] = useState(() => localStorage.getItem(TZ_KEY) || Intl.DateTimeFormat().resolvedOptions().timeZone);
  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);

  // Read the real state of each provider rather than asserting it in markup —
  // the page used to claim Gemini and Nitter were connected, and neither was
  // ever called.
  useEffect(() => {
    if (!user) return;
    getConnections()
      .then((r) => setConnections(r.connections))
      .catch(() => setConnections([]));
  }, [user]);

  if (authLoading || !user) return <NewsShell title="Settings"><div /></NewsShell>;

  const handleSave = () => {
    localStorage.setItem(BG_KEY, bgColor);
    localStorage.setItem(SCHEDULE_KEY, scheduleTime);
    localStorage.setItem(TZ_KEY, timezone);
    // Broadcast to audience page
    window.dispatchEvent(new StorageEvent('storage', { key: BG_KEY, newValue: bgColor }));
    toast.success('Settings saved');
  };

  return (
    <NewsShell title="Settings">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure collection schedule and presentation display.</p>
        </div>

        {/* Schedule */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Collection schedule</h2>
          <p className="text-sm text-muted-foreground">
            The collection job runs once per day at the time below. Use "Refresh" (step 1 of the Daily Show) to trigger it manually at any time.
          </p>
          <div className="flex gap-4">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Run daily at</Label>
              <Input type="time" value={scheduleTime} onChange={e => setScheduleTime(e.target.value)} className="w-32" />
            </div>
            <div className="space-y-1 flex-1">
              <Label className="text-xs text-muted-foreground">Timezone</Label>
              <Input value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="America/New_York" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Note: automated scheduling requires an external cron service hitting the refresh endpoint. This setting saves your preference for reference.
          </p>
        </section>

        {/* Audience background */}
        <section className="space-y-4 border-t border-border pt-6">
          <h2 className="text-sm font-semibold text-foreground">Audience screen background</h2>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md border border-border" style={{ backgroundColor: bgColor }} />
            <Input value={bgColor} onChange={e => setBgColor(e.target.value)} className="w-32 font-mono text-sm" maxLength={9} />
            <span className="text-xs text-muted-foreground">Applied live when you save</span>
          </div>
          <div className="flex gap-2">
            {PRESETS.map(p => (
              <button
                key={p}
                onClick={() => setBgColor(p)}
                className={`w-8 h-8 rounded-md border-2 transition-colors ${bgColor === p ? 'border-primary' : 'border-border'}`}
                style={{ backgroundColor: p }}
                title={p}
              />
            ))}
          </div>
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span className="font-mono bg-muted px-1.5 py-0.5 rounded">/news-gatherer/present/audience</span>
            <span>—</span>
            <a href="/news-gatherer/present/audience" target="_blank" className="text-primary hover:underline">Open audience URL ↗</a>
          </div>
        </section>

        {/* API connections */}
        <section className="space-y-3 border-t border-border pt-6">
          <h2 className="text-sm font-semibold text-foreground">API connections</h2>
          <div className="space-y-2">
            {connections === null ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">Checking connections…</div>
            ) : connections.map((c) => (
              <div key={c.name} className="flex items-start justify-between gap-4 px-4 py-3 bg-card border border-border rounded-lg">
                <div className="flex items-start gap-2">
                  {c.configured
                    ? <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                    : <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />}
                  <div>
                    <div className="text-sm text-foreground">{c.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{c.detail}</div>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{c.configured ? 'Connected' : 'Not set'}</span>
              </div>
            ))}
          </div>
        </section>

        <Button onClick={handleSave} className="mt-2">Save settings</Button>
      </div>
    </NewsShell>
  );
}
