/**
 * /ux-report/:jobId — ONE UX test laid out for print. The server prints this
 * page to the PDF inside the drawer's ⬇ Download zip (server scout/download.ts),
 * so it reuses the drawer's own pieces: `buildSteps` and the Markdown renderer.
 *
 *   1. Cover — tool, script, goal, the short version, when, how long, counts
 *   2. Key screenshots — K1… with their captions
 *   3. Findings — the tester's full report
 *   4. The process — every screenshot in order, the red ring where it clicked,
 *      what it did right before, and what it noted
 *
 * Light, A4-friendly, no Lab chrome. `data-report-ready` goes on the root once
 * every screenshot has decoded — the server waits for it before printing.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Markdown } from '@/deals/ui/markdown';
import { getJob, type ScoutEvent, type ScoutJobView } from './api';
import { buildSteps } from './UxFindingsDrawer';

const VIEW_W = 1280;
const VIEW_H = 900;

const CSS = `
html, body { background: #fff !important; }
.uxr { color: #16171b; font: 13px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; background: #fff; }
.uxr h1 { font-size: 26px; line-height: 1.2; margin: 0 0 6px; }
.uxr .eyebrow { text-transform: uppercase; letter-spacing: .12em; font-size: 11px; font-weight: 700; color: #b8860b; }
.uxr .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 18px 0; }
.uxr .meta div { border: 1px solid #e3e3e8; border-radius: 8px; padding: 8px 10px; }
.uxr .meta b { display: block; font-size: 16px; }
.uxr .meta span { color: #6b6b75; font-size: 11px; }
.uxr .box { border: 1px solid #e3e3e8; background: #fafafa; border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
.uxr .box p { margin: 4px 0; }
.uxr .section { break-before: page; }
.uxr .section > h2 { font-size: 20px; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 2px solid #ffd21e; }
.uxr .keys { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.uxr .keys figure { margin: 0; break-inside: avoid; border: 1px solid #e3e3e8; border-radius: 8px; padding: 6px; }
.uxr .keys img { width: 100%; display: block; border-radius: 4px; }
.uxr .keys figcaption { font-size: 11.5px; margin-top: 5px; color: #333; }
.uxr .k { display: inline-block; background: #ffd21e; color: #000; font-weight: 700; font-size: 10.5px; border-radius: 4px; padding: 1px 6px; margin-right: 6px; }
.uxr .md h1 { font-size: 19px; margin: 18px 0 8px; }
.uxr .md h2 { font-size: 16px; margin: 18px 0 6px; break-after: avoid; }
.uxr .md h3 { font-size: 14px; margin: 14px 0 4px; break-after: avoid; }
.uxr .md p { margin: 6px 0; }
.uxr .md ul, .uxr .md ol { margin: 6px 0; padding-left: 22px; }
.uxr .md ul { list-style: disc; } .uxr .md ol { list-style: decimal; }
.uxr .md li { margin: 2px 0; }
.uxr .md strong { font-weight: 650; }
.uxr .md code { background: #f1f1f4; border-radius: 4px; padding: 0 4px; font-size: 12px; }
.uxr .md pre { background: #f6f6f8; border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; }
.uxr .md table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 11.5px; }
.uxr .md th, .uxr .md td { border: 1px solid #dcdce2; padding: 5px 7px; text-align: left; vertical-align: top; }
.uxr .md th { background: #f3f3f6; }
.uxr .md tr { break-inside: avoid; }
.uxr .md blockquote { border-left: 3px solid #ffd21e; margin: 8px 0; padding: 2px 10px; color: #444; }
.uxr .md a { color: #8a6500; }
.uxr .step { break-inside: avoid; border: 1px solid #e3e3e8; border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; }
.uxr .step.key { border-color: #e6c200; background: #fffdf0; }
.uxr .step header { display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; color: #6b6b75; margin-bottom: 6px; }
.uxr .step header b { color: #16171b; }
.uxr .step header .t { margin-left: auto; font-family: ui-monospace, monospace; }
/* ~78% wide → two steps fit on an A4 page */
.uxr .shot { position: relative; width: 78%; margin: 0 auto 6px; border: 1px solid #e3e3e8; border-radius: 6px; overflow: hidden; }
.uxr .shot img { display: block; width: 100%; }
.uxr .ring { position: absolute; width: 22px; height: 22px; transform: translate(-50%, -50%); border-radius: 50%; border: 3px solid #e5322d; background: rgba(229,50,45,.25); box-shadow: 0 0 0 3px rgba(255,255,255,.8); }
.uxr .acts { margin: 4px 0; padding-left: 18px; }
.uxr .cap { color: #8a6500; font-weight: 600; font-size: 12px; margin: 4px 0; }
.uxr .note { background: #f4f4f7; border-radius: 6px; padding: 6px 9px; margin-top: 6px; font-size: 12px; white-space: pre-wrap; }
@page { size: A4; }
`;

function Shot({ url, click }: { url: string; click: { x: number; y: number } | null }) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const ring = click && nat && nat.w === VIEW_W && nat.h === VIEW_H;
  return (
    <div className="shot">
      <img src={url} alt="" onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {ring && <span className="ring" style={{ left: `${(click!.x / VIEW_W) * 100}%`, top: `${(click!.y / VIEW_H) * 100}%` }} />}
    </div>
  );
}

const dur = (a?: string | null, b?: string | null) => {
  if (!a || !b) return '—';
  const m = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

export default function UxReportPrint() {
  const { jobId = '' } = useParams<{ jobId: string }>();
  const [params] = useSearchParams();
  const [data, setData] = useState<{ view: ScoutJobView; events: ScoutEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // print in light — the Lab is dark by default
    document.documentElement.classList.remove('dark');
    let cancelled = false;
    (async () => {
      let view = await getJob(jobId, 0);
      const events = [...view.events];
      while (view.events.length >= 400) {
        view = await getJob(jobId, events[events.length - 1].seq);
        events.push(...view.events);
      }
      if (!cancelled) setData({ view, events });
    })().catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; };
  }, [jobId]);

  const steps = useMemo(() => (data ? buildSteps(data.events, data.view.job.keyShots.map((k) => k.file)) : []), [data]);

  // ready = every screenshot decoded (or failed — a missing picture must not hang the PDF)
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(async () => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('.uxr img')];
      await Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = i.onerror = () => r(null); }))));
      await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
      setReady(true);
    }, 50);
    return () => clearTimeout(t);
  }, [data]);

  if (error) return <div className="uxr" data-report-ready="1" data-report-error={error}><style>{CSS}</style>Couldn't load this UX test: {error}</div>;
  if (!data) return <div className="uxr"><style>{CSS}</style>Loading…</div>;
  const { job, tool } = data.view;
  const title = params.get('title') || `UX test · ${tool?.name ?? job.toolSlug}`;
  const notes = steps.reduce((n, s) => n + s.notes.length, 0);

  return (
    <div className="uxr" {...(ready ? { 'data-report-ready': '1' } : {})}>
      <style>{CSS}</style>

      <div className="eyebrow">UX test report</div>
      <h1>{title}</h1>
      <div style={{ color: '#6b6b75' }}>{tool?.name ?? job.toolSlug}{tool?.homeUrl ? ` · ${tool.homeUrl}` : ''}</div>
      <div className="meta">
        <div><b>{job.finishedAt ? new Date(job.finishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</b><span>Tested</span></div>
        <div><b>{dur(job.startedAt, job.finishedAt)}</b><span>Test length</span></div>
        <div><b>{steps.length}</b><span>Screenshots</span></div>
        <div><b>{job.keyShots.length}</b><span>Key moments · {notes} notes</span></div>
      </div>
      <div className="box">
        <p><b>Goal:</b> {job.goal}</p>
        {job.summary && <p><b>In short:</b> {job.summary}</p>}
      </div>
      <p style={{ color: '#6b6b75', fontSize: 12 }}>
        Contents: 1 · Key screenshots &nbsp; 2 · Findings &nbsp; 3 · The process — every step, with what the tester did (a red ring marks each click) and what it noted.
      </p>

      {job.keyShots.length > 0 && (
        <section className="section">
          <h2>1 · Key screenshots</h2>
          <div className="keys">
            {job.keyShots.map((k, i) => (
              <figure key={k.file}>
                {k.url && <img src={k.url} alt="" />}
                <figcaption><span className="k">K{i + 1}</span>{k.caption}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <h2>2 · Findings</h2>
        {job.report ? <Markdown className="md">{job.report}</Markdown> : <p>This test has no report.</p>}
      </section>

      <section className="section">
        <h2>3 · The process</h2>
        {steps.map((s, i) => (
          <article key={s.seq} className={`step${s.keyNo ? ' key' : ''}`}>
            <header>
              <b>Step {i + 1}</b>
              {s.keyNo && <span className="k">K{s.keyNo}</span>}
              <span>{s.title}</span>
              <span className="t">{new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            </header>
            {s.url && <Shot url={s.url} click={s.click} />}
            {s.actions.length > 0 && <ul className="acts">{s.actions.map((a, j) => <li key={j}>{a}</li>)}</ul>}
            {s.keyCaption && <p className="cap">{s.keyCaption}</p>}
            {s.notes.map((n, j) => <div key={j} className="note">{n}</div>)}
          </article>
        ))}
      </section>
    </div>
  );
}
