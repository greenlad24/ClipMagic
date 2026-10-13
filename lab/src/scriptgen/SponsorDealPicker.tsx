/**
 * Sponsored video → pick the Deal Organizer deal (Jake 2026-10-02).
 *
 * Only deals in production (the Deadlines page) are offered, searchable by
 * name. Picking one reads EVERYTHING about it on the server
 * (scriptgen/dealBrief.ts: every email, the email agent's notes, contracts and
 * briefs — PDFs read by Claude — linked docs, and videos transcribed), then
 * shows the sponsor brief and at least five angles. The chosen angle and the
 * brief ride into every stage of the script.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Handshake, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  searchSponsorDeals, startDealBrief, getDealBrief,
  type SponsorDealOption, type DealBriefJob, type DealAngle,
} from 'zite-endpoints-sdk';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const fmtN = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/** The angle's measured YouTube demand + titles modelled on what ranks (briefs from 2026-10-13). */
function DemandLine({ a }: { a: DealAngle }) {
  const [open, setOpen] = useState(false);
  if (!a.targetSearch) return null;
  const others = (a.coveredSearches ?? []).filter((c) => c.keyword !== a.targetSearch);
  return (
    <div className="mt-1 space-y-1 rounded border border-primary/20 bg-primary/5 p-1.5 text-[11px]">
      <p className="text-foreground">
        🔎 <b>"{a.targetSearch}"</b>
        {a.monthlySearches ? <> · <b>{fmtN(a.monthlySearches)}</b> YouTube searches/mo</> : a.monthlySearches === 0 ? ' · under 750/mo' : ' · not measured'}
        {a.usMonthlySearches ? <span className="text-muted-foreground"> (US {fmtN(a.usMonthlySearches)})</span> : null}
        {a.growthPct != null && <span className={a.growthPct >= 0 ? 'text-emerald-400' : 'text-red-400'}> · {a.growthPct >= 0 ? '↑' : '↓'}{Math.abs(a.growthPct)}% this month</span>}
        {a.competition != null && <span className="text-muted-foreground"> · competition {a.competition}/100</span>}
      </p>
      {!!a.tam && others.length > 0 && (
        <p className="text-muted-foreground">Addressable: <b className="text-foreground">{fmtN(a.tam)}</b>/mo across {others.length + 1} searches — also {others.slice(0, 5).map((c) => `"${c.keyword}"`).join(', ')}{others.length > 5 ? '…' : ''}</p>
      )}
      {a.timely && <p className="text-muted-foreground">📰 {a.timely}</p>}
      {a.titleOptions && a.titleOptions.length > 0 && (
        <div className="text-foreground">
          <b>Titles:</b> {a.titleOptions.map((t, i) => <span key={i} className="mr-1.5 inline-block rounded bg-background px-1 py-0.5">{t}</span>)}
        </div>
      )}
      {(a.titlePattern || (a.rankingTitles?.length ?? 0) > 0) && (
        <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setOpen((v) => !v); } }} className="inline-flex cursor-pointer items-center gap-0.5 text-primary hover:underline">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} How the top videos title it
        </span>
      )}
      {open && (
        <div className="space-y-0.5 pl-3 text-muted-foreground">
          {a.titlePattern && <p className="text-foreground">{a.titlePattern}</p>}
          {(a.rankingTitles ?? []).map((v) => (
            <p key={v.videoId}>
              <a href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-foreground hover:underline">{v.title}</a>
              {' '}— {fmtN(v.views)} views · {v.channel}{v.subscribers != null ? ` (${fmtN(v.subscribers)} subs)` : ''}{v.publishedAt ? ` · ${v.publishedAt.slice(0, 7)}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export interface SponsorDealSelection { dealId: string; briefId: string; angle: number; brand: string; dealName: string; angleInfo: DealAngle; videoBrief: string }

interface Props {
  idea: string;
  value: SponsorDealSelection | null;
  onChange: (sel: SponsorDealSelection | null) => void;
  disabled?: boolean;
}

function List({ title, items }: { title: string; items?: string[] | null }) {
  if (!items?.length) return null;
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-xs text-foreground">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}

export default function SponsorDealPicker({ idea, value, onChange, disabled }: Props) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<SponsorDealOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [deal, setDeal] = useState<SponsorDealOption | null>(null);
  const [job, setJob] = useState<DealBriefJob | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  // Production deals, filtered as Jake types.
  useEffect(() => {
    if (deal) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try { setOptions((await searchSponsorDeals({ q })).deals); } catch { setOptions([]); }
      finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, deal]);

  const watch = (briefId: string) => {
    if (poll.current) clearInterval(poll.current);
    const tick = async () => {
      try {
        const j = await getDealBrief({ briefId });
        setJob(j);
        if (j.status !== 'running' && poll.current) { clearInterval(poll.current); poll.current = null; }
      } catch { /* keep polling */ }
    };
    void tick();
    poll.current = setInterval(tick, 2500);
  };

  const pick = async (d: SponsorDealOption, fresh = false) => {
    setDeal(d); setJob(null); onChange(null);
    try {
      const r = await startDealBrief({ dealId: d.id, idea, fresh });
      watch(r.briefId);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not read the deal'); }
  };

  const clear = () => { if (poll.current) clearInterval(poll.current); setDeal(null); setJob(null); onChange(null); };

  const b = job?.result ?? null;
  const choose = (i: number) => {
    if (!deal || !job || !b) return;
    onChange({ dealId: deal.id, briefId: job.id, angle: i, brand: b.sponsor.brand || deal.brand || deal.name, dealName: deal.name, angleInfo: b.angles[i], videoBrief: b.videoBriefs?.[i] ?? '' });
  };

  if (!deal) {
    return (
      <div className="mt-1.5 space-y-1.5 rounded-lg border border-border p-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sponsors in production…" className="pl-8" disabled={disabled} />
        </div>
        <div className="max-h-56 overflow-y-auto">
          {searching && !options.length && <p className="p-2 text-xs text-muted-foreground">Searching…</p>}
          {!searching && !options.length && <p className="p-2 text-xs text-muted-foreground">{q ? 'No deal in production matches that.' : 'No deals in production (the Deadlines page is empty).'}</p>}
          {options.map((o) => (
            <button key={o.id} type="button" onClick={() => void pick(o)} disabled={disabled}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
              <Handshake className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-foreground">{o.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">{o.brand ?? o.client} · {o.stage}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1.5 space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <Handshake className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{deal.name}</span>
        {job?.status !== 'running' && <button type="button" onClick={() => void pick(deal, true)} title="Read everything again (new emails, files)" className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>}
        <button type="button" onClick={clear} title="Pick another deal" className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </div>

      {(!job || job.status === 'running') && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {job?.progress ?? 'Starting…'} <span className="ml-auto">emails · agent notes · contracts · briefs · videos</span></p>
      )}
      {job?.status === 'failed' && (
        <div className="flex items-center gap-2 text-xs text-destructive">{job.error}<Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void pick(deal, true)}>Try again</Button></div>
      )}

      {b && job?.status === 'done' && (
        <>
          <p className="text-xs leading-relaxed text-foreground">{b.summary}</p>
          <button type="button" onClick={() => setDetailsOpen((o) => !o)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} The video brief and what was read
          </button>
          {detailsOpen && (
            <div className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-2">
              {b.brandBrief ? (
                <div className="space-y-0.5 sm:col-span-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">The brand's brief (as they sent it — this goes in the Brief box)</p>
                  <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-background p-2 font-sans text-xs text-foreground">{b.brandBrief}</pre>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground sm:col-span-2">The brand never sent a brief — the Brief box gets the summary below instead.</p>
              )}
              <List title="Key messages" items={b.brief.keyMessages} />
              <List title="Must say" items={b.brief.mustSay} />
              <List title="Must show" items={b.brief.mustShow} />
              <List title="Must NOT say" items={b.brief.mustNotSay} />
              <List title="CTA / links / codes" items={[b.brief.cta, ...b.sponsor.links, ...b.sponsor.codes].filter(Boolean) as string[]} />
              <List title="Content rules" items={b.contentRules} />
              <List title="Still open about the video" items={b.gaps} />
              <div className="space-y-0.5 sm:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Read</p>
                <ul className="space-y-0.5 text-xs">
                  {job.sources.map((s, i) => (
                    <li key={i} className={s.read ? 'text-foreground' : 'text-muted-foreground'}>{s.read ? '✓' : '✗'} {s.label}{s.note ? ` — ${s.note}` : ''}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <p className="pt-1 text-xs font-semibold text-foreground">Pick an angle ({b.angles.length}) — it fills the Brief box with the video brief for that angle</p>
          {b.demand && (
            <p className={cn('rounded border px-2 py-1.5 text-[11px]', b.demand.note ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-border bg-muted/40 text-muted-foreground')}>
              {b.demand.source === 'vidiq'
                ? <>Ranked by YouTube demand: {b.demand.measured} searches measured with vidIQ (monthly YouTube searches) from {b.demand.seeds.length} seeds{b.demand.fromCache ? ` (${b.demand.fromCache} from the 7-day cache)` : ''}{b.demand.titles === 'youtube' ? ' · titles modelled on the videos ranking now' : ''}.</>
                : <>Not ranked by demand.</>}
              {b.demand.note && <> {b.demand.note}</>}
            </p>
          )}
          <div className="space-y-1.5">
            {b.angles.map((a, i) => {
              const on = value?.briefId === job.id && value.angle === i;
              return (
                <button key={i} type="button" onClick={() => choose(i)} disabled={disabled}
                  className={cn('w-full rounded-lg border p-2.5 text-left transition-colors', on ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40')}>
                  <div className="flex items-start gap-2">
                    <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>{on && <Check className="h-3 w-3" />}</span>
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm font-medium text-foreground">{i === 0 && <span className="mr-1 text-[10px] font-semibold uppercase text-primary">Best</span>}{a.title} <span className="text-[10px] font-normal text-muted-foreground">· {a.bestFor}</span></p>
                      <p className="text-xs text-foreground">{a.premise}</p>
                      <p className="text-[11px] text-muted-foreground"><b>Hook:</b> {a.hook}</p>
                      <p className="text-[11px] text-muted-foreground"><b>Product moment:</b> {a.productMoment}</p>
                      <p className="text-[11px] text-muted-foreground"><b>Why:</b> {a.why} · <b>Risk:</b> {a.risk}</p>
                      <DemandLine a={a} />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
