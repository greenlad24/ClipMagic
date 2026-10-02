/**
 * Deep Dive v2 — "Run it live": the demo agent drives the real product right
 * now, and its screen streams onto the stage (Jake, 2026-10-02: "Both" —
 * recorded while building, runnable live). Polls the Scout run about once a
 * second; L or Esc closes it and the show carries on where it was.
 *
 * Sharp rule: the agent's screenshots are 1280×900, so the screen is never
 * drawn wider than that many device pixels.
 */
import { useEffect, useState } from 'react';
import { getLiveDeepDiveDemo, startLiveDeepDiveDemo, type LiveDemoState } from '../api';

export default function LiveDemo({ diveId, onClose }: { diveId: string; onClose: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [st, setSt] = useState<LiveDemoState | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    startLiveDeepDiveDemo(diveId).then((r) => alive && setJobId(r.jobId)).catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [diveId]);

  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => getLiveDeepDiveDemo(jobId)
      .then((s) => { if (!alive) return; setSt(s); if (s.status === 'queued' || s.status === 'running') t = setTimeout(tick, 1100); })
      .catch(() => { if (alive) t = setTimeout(tick, 2500); });
    void tick();
    return () => { alive = false; clearTimeout(t); };
  }, [jobId]);

  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const maxW = (st?.w ?? 1280) / dpr;
  const label = err ? 'Could not start' : !st || st.status === 'queued' ? 'Starting the agent…' : st.status === 'running' ? 'LIVE · AI agent' : st.status === 'done' ? 'Done' : `Stopped (${st.status})`;

  return (
    <section className="dd2-ch on" style={{ position: 'absolute', inset: 0, zIndex: 20 }}>
      <div className="dd2-wrap">
        <div className="dd2-head">
          <div className="dd2-num" style={{ background: 'var(--yellow)', color: '#000' }}>●</div>
          <div>
            <div className="dd2-eyebrow">Live demo · happening now</div>
            <h2 className="dd2-h">The AI is <span className="dd2-it">using it now<svg viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden><path d="M4 14 C 80 4, 160 18, 296 8" /></svg></span>.</h2>
          </div>
          <div className="dd2-island"><span className="q">Steps</span><span className="d3"><i /><i /><i /></span><span className="a">{st?.steps ?? 0}</span></div>
        </div>
        <div className="dd2-stage">
          <div className="dd2-body">
            <div className="dd2-screenbox"><div className="dd2-screen" style={{ maxWidth: maxW, ['--ar' as string]: (st?.w ?? 1280) / (st?.h ?? 900) } as React.CSSProperties}>
              {st?.shot && <img key={st.shot} src={st.shot} alt="The agent's screen" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />}
              {st?.click && (
                <div className="dd2-cursor" style={{ left: `${(st.click[0] / st.w) * 100}%`, top: `${(st.click[1] / st.h) * 100}%` }}>
                  <svg viewBox="0 0 24 24"><path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.7 L11 13.4 L17.5 13.4 Z" fill="#fff" stroke="#000" strokeWidth="1.4" strokeLinejoin="round" /></svg>
                </div>
              )}
              <span className="dd2-live agent"><i />{label}</span>
              {(st?.caption || err || st?.error) && <div className="dd2-cap"><div key={st?.caption}><small>The agent</small>{err || st?.error || st?.caption}</div></div>}
              {!st?.shot && !err && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--mute)', fontSize: 'calc(var(--u) * 1.4)' }}>Opening the product…</div>}
            </div></div>
          </div>
        </div>
      </div>
      <button onClick={onClose} style={{ position: 'absolute', right: 16, top: 16, background: 'rgba(0,0,0,.6)', border: '1px solid #333', borderRadius: 8, color: '#aaa', padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>Close (L)</button>
    </section>
  );
}
