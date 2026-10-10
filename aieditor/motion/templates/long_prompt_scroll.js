/*
 * long_prompt_scroll (MO07) — a LONG structured prompt / message in the app's conversation view: the camera starts on
 * the whole app, zooms IN hard until the message text fills the frame, then SCROLLS down the text; a YELLOW MARKER
 * sweeps each key phrase on the beat where the narration says it; the highlights accumulate and stay.
 * Reference: /opt/aieditor-work/reference/motion-2026-10-09/motion6.mov (Claude.ai dark chat, one long assistant
 * message; spec: reference-specs/long_prompt_scroll.md). Sibling of prompt_highlight (MO06, short prompts in the
 * composer) — same marker colour / text colour language.
 *
 * Motion = scene.kf (long_prompt_scroll.kf.json, measured), look = scene.style (long_prompt_scroll.style.json) +
 * the app's MESSAGE view from its UI kit: scene.kit.message (ui-kits/<app>/message.json → kit.message). A kit without
 * a message view but with result.text (the app's own answer view, e.g. ChatGPT) shows the text in that view;
 * kit null → a NEUTRAL dark document view (no logo, no header, no composer) — never another app's UI.
 *
 * params: prompt (the full text, "\n" line breaks; section headings are just lines), phrases [exact substrings, in
 *         order], app, title (chat title in the header; "" = none), zoom_target (null = measured; {scale, x, y} with
 *         x/y the zoom pivot in frame fractions), backdrop (true)
 * beats:  in, zoom (optional), hl_0..hl_{n-1} (the narration word of each phrase), out (optional hard cut)
 *
 * READING-SPEED LIMIT (enforced here): a scroll move never runs faster on average than kf.scroll.max_lines_per_s
 * message lines per second (the reference's own move: 17.6 lines in 1.40 s), with the measured ease. A phrase's sweep
 * starts on its beat once the phrase is fully inside the visible band; when the beats would need a faster scroll
 * (or a move before the previous highlight has settled), the template keeps the speed limit, starts that sweep LATE
 * and reports it: state.warnings, window.__lpsWarnings and console.warn("long_prompt_scroll: …").
 */
(function () {
  "use strict";
  const TR = window.__TR;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function normParams(scene) {
    const p = Object.assign({ prompt: "", phrases: [], title: "", zoom_target: null, backdrop: true }, scene.params || {});
    p.prompt = String(p.prompt || "").replace(/\r\n?/g, "\n");
    let ph = p.phrases;
    if (typeof ph === "string") ph = [ph];
    const ranges = [], missing = [];
    let from = 0;
    for (const s0 of (ph || []).map(String)) {
      const s = s0;
      let a = p.prompt.indexOf(s, from);
      if (a < 0) a = p.prompt.indexOf(s);
      if (a < 0 || !s.trim().length) { missing.push(s); continue; }
      ranges.push({ a, b: a + s.length, text: s });
      from = a + s.length;
    }
    ranges.sort((x, y) => x.a - y.a);
    p.ranges = ranges;
    p.missing = missing;
    return p;
  }

  // ───────────────────────────── the plan (pure numbers) ─────────────────────────────
  // geo: { k0, lineSv, phrases: [{top, bot, pieces:n}] (start-view px at scroll 0), appMax, textBottom }
  function plan(scene, p, geo) {
    const K = scene.kf, S = scene.style, B = scene.beats || {}, L = S.layout;
    const W = scene.width || 1920, H = scene.height || 1080;
    const n = geo.phrases.length, warnings = [];
    const tin = B.in != null ? Number(B.in) : 0;
    const Zk = K.zoom;
    // zoom: scale + pivot (measured unless zoom_target), shrunk so the text column fits the frame
    const zt = p.zoom_target || {};
    let Z = zt.scale != null ? Number(zt.scale) : Zk.scale;
    let px = (zt.x != null ? Number(zt.x) : Zk.pivot[0]) * W, py = (zt.y != null ? Number(zt.y) : Zk.pivot[1]) * H;
    const colL = geo.colLeft, colR = geo.colLeft + geo.colWidth;
    while (Z > 1.0 && (px + Z * (colL - px) < L.fit_margin || px + Z * (colR - px) > W - L.fit_margin)) Z -= 0.01;
    Z = Math.max(1, Z);
    // beats
    const hl = [];
    let zoomStart = B.zoom != null ? Math.max(tin, Number(B.zoom)) : tin + Zk.start_after_in_s;
    const b0 = B.hl_0 != null ? Number(B.hl_0) : null;
    if (b0 != null && b0 - Zk.sweep_after_zoom_start_s < zoomStart) zoomStart = Math.max(tin + Zk.min_start_after_in_s, b0 - Zk.sweep_after_zoom_start_s);
    const zoomDur = Zk.dur_s, zoomEnd = zoomStart + zoomDur;
    for (let i = 0; i < n; i++) {
      let v = B["hl_" + i] != null ? Number(B["hl_" + i]) : null;
      if (v == null) v = i === 0 ? zoomStart + Zk.sweep_after_zoom_start_s : hl[i - 1] + K.sweep.fallback_spacing_s;
      hl.push(v);
    }
    // the start scroll: phrase 0 lands at the measured reading position after the zoom
    let S0 = 0;
    const Y0 = L.first_phrase_top_y;
    if (n) {
      const top0 = geo.phrases[0].top;
      S0 = top0 - py - (Y0 - py) / Z;
      const S0c = Math.min(Math.max(0, S0), geo.appMax);
      if (Math.abs(S0c - S0) > 0.5 && Z > 1.001) {
        // the app cannot scroll that far → move the zoom pivot instead (the camera aims at the phrase)
        py = TR.clamp((Z * (top0 - S0c) - Y0) / (Z - 1), 0, H);
      }
      S0 = S0c;
    }
    const sy = (y, s) => py + Z * (y - s - py);
    // vis: fully inside the visible band (a sweep may run); placed: inside the reading area (no scroll needed)
    const vis = (i, s) => sy(geo.phrases[i].top, s) >= L.band_top && sy(geo.phrases[i].bot, s) <= L.band_bot;
    const placed = (i, s) => sy(geo.phrases[i].top, s) >= L.band_top && sy(geo.phrases[i].bot, s) <= L.place_bot;
    // the furthest the camera may scroll: the message end no higher than the rest line
    const Smax = Math.max(S0, geo.textBottom - py - (L.rest_bottom_y - py) / Z);
    const moves = [];
    const Sat = (t) => {
      let v = S0;
      for (const m of moves) {
        if (t < m.start) break;
        v = TR.lerp(m.from, m.to, TR.prog(t, m.start, m.dur, K.scroll.ease));
      }
      return v;
    };
    // first time ≥ t0 at which phrase i is fully visible under the moves so far (null = never)
    const visibleFrom = (i, t0) => {
      const last = moves.length ? moves[moves.length - 1].start + moves[moves.length - 1].dur : t0;
      const step = 1 / 240;
      for (let t = t0; t <= Math.max(t0, last) + step; t += step) if (vis(i, Sat(t))) return t;
      return null;
    };
    const sweeps = [];
    let chain = -1e9, lastEnd = zoomEnd, tFree = zoomEnd;
    for (let i = 0; i < n; i++) {
      const P = geo.phrases[i];
      if ((P.bot - P.top) * Z > L.band_bot - L.band_top) warnings.push(`hl_${i}: the phrase is taller than the frame at zoom ${Z.toFixed(2)} — shorten it`);
      let earliest = Math.max(chain, i === 0 ? zoomStart + Zk.sweep_after_zoom_start_s : -1e9);
      let start;
      const want = Math.max(hl[i], earliest);
      let tv = i === 0 ? want : visibleFrom(i, Math.min(want, tFree));
      if (i === 0 || (tv != null && placed(i, Sat(1e9)))) {
        start = Math.max(want, tv == null ? want : tv);
      } else {
        // a scroll move: group the next phrases that fit between the top line and the rest line together
        let j = i;
        while (j + 1 < n && (geo.phrases[j + 1].bot - P.top) * Z <= L.rest_bottom_y - L.top_y) j++;
        const Scur = Sat(1e9);
        let St = geo.phrases[j].bot - py - (L.rest_bottom_y - py) / Z;
        St = Math.max(St, P.bot - py - (L.band_bot - py) / Z);       // at least: phrase i fully inside the band
        St = Math.min(St, P.top - py - (L.top_y - py) / Z);           // never past phrase i's top line
        St = Math.max(0, Math.min(St, Math.max(Smax, P.bot - py - (L.rest_bottom_y - py) / Z)));
        const lines = Math.abs(St - Scur) / geo.lineSv;
        const dur = Math.max(K.scroll.min_dur_s, lines / K.scroll.max_lines_per_s);
        // when does phrase i enter the band during the move (relative)
        let tEnter = dur;
        for (let k = 0; k <= 400; k++) {
          const tt = (dur * k) / 400;
          if (vis(i, TR.lerp(Scur, St, TR.prog(tt, 0, dur, K.scroll.ease)))) { tEnter = tt; break; }
        }
        const ideal = want - Math.max(tEnter, K.scroll.lead_s);
        const earliestMove = Math.max(tFree, lastEnd + K.scroll.min_dwell_after_sweep_s);
        const mStart = Math.max(ideal, earliestMove);
        moves.push({ start: mStart, dur, from: Scur, to: St, lines, group: [i, j] });
        tFree = mStart + dur;
        start = Math.max(want, mStart + tEnter);
      }
      const late = start - hl[i];
      if (late > K.sweep.late_tol_s) {
        warnings.push(`hl_${i} starts ${late.toFixed(2)} s after its beat — the beats ask for a scroll faster than the reading limit ` +
          `(${K.scroll.max_lines_per_s} lines/s) or for overlapping sweeps; space the phrases further apart`);
      }
      const pieces = [];
      for (let m = 0; m < P.pieces; m++) pieces.push(start + m * K.sweep.piece_offset_s);
      sweeps.push({ start, pieces, late: Math.max(0, late) });
      chain = pieces[pieces.length - 1] + K.sweep.piece_offset_s;
      lastEnd = pieces[pieces.length - 1] + K.sweep.dur_s;
    }
    return { tin, Z, px, py, S0, zoomStart, zoomDur, zoomEnd, moves, sweeps, hl, warnings, Sat,
      lastSweepEnd: sweeps.length ? lastEnd : zoomEnd, out: B.out != null ? Number(B.out) : null };
  }

  // ───────────────────────────── build ─────────────────────────────
  function scopeCss(css, cls) {
    return String(css || "").replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) =>
      `${a} ${sel.split(",").map((s) => (s.trim().startsWith(":root") ? `.${cls}` : `.${cls} ${s.trim()}`)).join(",")}{`);
  }

  function build(root, scene) {
    const p = normParams(scene), S = scene.style, K = scene.kf;
    const W = scene.width, H = scene.height;
    const kit = scene.kit || null;
    const mode = kit && kit.message ? "message" : kit && kit.result && kit.result.text ? "result" : "neutral";
    const cls = mode === "neutral" ? "lps-neutral" : "kit-" + String(kit.app || "app").replace(/[^a-z0-9_-]/gi, "");
    const tokens = Object.assign({}, mode !== "neutral" ? kit.tokens || {} : {}, mode === "message" ? kit.message.tokens || {} : {});
    const tokenCss = Object.entries(tokens).filter(([k, v]) => k.startsWith("--") && typeof v === "string").map(([k, v]) => `${k}:${v}`).join(";");
    const contentHtml = `<span class="lps-t">${esc(p.prompt)}</span>`;

    let viewW, viewH, k0, html, scrollSel, textSel, dockTop = null, bgCol;
    if (mode === "message") {
      const M = kit.message;
      TR.addCss(scopeCss(M.css, cls));
      viewW = M.view_w; viewH = M.view_h; k0 = M.screen_px_per_css || W / viewW;
      html = TR.fill(M.html, { content_html: contentHtml, title: p.title != null && String(p.title).trim() ? String(p.title) : M.title_default || "",
        placeholder: M.placeholder || "", model_label: kit.model_label || "", disclaimer: M.disclaimer || "" });
      scrollSel = M.scroll_sel; textSel = M.text_sel; dockTop = M.dock_top;
      bgCol = tokens["--cl-bg"] || kit.bg || S.neutral.bg;
    } else if (mode === "result") {
      // the app's own answer view (no dedicated message view in the kit yet): its page + its answer block
      const R = kit.result.text, N = S.neutral;
      TR.addCss(scopeCss(R.css, cls));
      viewW = N.view_w; viewH = N.view_h; k0 = W / viewW;
      bgCol = tokens["--cg-page"] || kit.bg || N.bg;
      const colW = R.width || 768;
      html = `<div style="position:relative;width:${viewW}px;height:${viewH}px;overflow:hidden;background:${bgCol}">` +
        `<div class="lps-col" style="position:absolute;left:${(viewW - colW) / 2}px;top:${N.col_top}px;width:${colW}px">` +
        TR.fill(R.html, { text_html: contentHtml, actions_html: "" }) + `</div></div>`;
      scrollSel = ".lps-col"; textSel = R.text_sel || ".cg-md";
    } else {
      const N = S.neutral;
      viewW = N.view_w; viewH = N.view_h; k0 = W / viewW; bgCol = N.bg;
      TR.addCss(`.${cls} .lps-msg{position:relative;font-family:'${N.font}',Georgia,serif;font-size:${N.font_size}px;line-height:${N.line_height}px;color:${N.text};white-space:pre-wrap;overflow-wrap:break-word;-webkit-font-smoothing:antialiased}`);
      html = `<div style="position:relative;width:${viewW}px;height:${viewH}px;overflow:hidden;background:${N.bg}">` +
        `<div class="lps-col" style="position:absolute;left:${N.col_left}px;top:${N.col_top}px;width:${N.col_width}px"><div class="lps-msg">${contentHtml}</div></div></div>`;
      scrollSel = ".lps-col"; textSel = ".lps-msg";
    }

    const backdrop = p.backdrop !== false ? TR.el("div", `position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:${bgCol}`, root) : null;
    const stage = TR.el("div", `position:absolute;left:0;top:0;width:${viewW}px;height:${viewH}px;transform-origin:0 0;${tokenCss}`, root);
    stage.className = cls;
    stage.innerHTML = html;
    const scrollEl = stage.querySelector(scrollSel), textEl = stage.querySelector(textSel);
    textEl.style.position = "relative";
    const tNode = textEl.querySelector(".lps-t").firstChild;
    const hlLayer = TR.el("div", "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none", textEl);
    const tcs = getComputedStyle(textEl);
    const fontSpec = `${tcs.fontStyle} ${tcs.fontWeight} ${tcs.fontSize} ${tcs.fontFamily}`;
    // start loading the message font now so render.mjs's document.fonts.ready waits for it (layout is measured after)
    try { if (document.fonts) document.fonts.load(fontSpec, p.prompt.slice(0, 200) || "A"); } catch (e) { /* no FontFaceSet */ }
    const st = { p, S, K, W, H, root, stage, scrollEl, textEl, tNode, hlLayer, k0, viewW, viewH, dockTop, mode, fontSpec, plan: null, key: null };
    window.__lpsWarnings = [];
    return st;
  }

  // ───────────────────────────── layout measurement (after the fonts are in) ─────────────────────────────
  function measure(st, scene) {
    const { p, S, textEl, scrollEl, stage, tNode, k0 } = st;
    stage.style.transform = "none";
    scrollEl.style.transform = "none";
    const base = textEl.getBoundingClientRect(), vb = stage.getBoundingClientRect();
    const cs = getComputedStyle(textEl);
    const fontPx = parseFloat(cs.fontSize) || 16, lineH = parseFloat(cs.lineHeight) || fontPx * 1.5;
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const fm = TR.measure("Hg", font);
    const fAsc = fm.fontBoundingBoxAscent;
    const HL = S.highlight, em = fontPx;
    const textTop = base.top - vb.top, textLeft = base.left - vb.left;   // css px in the view (scroll 0)
    const colEl = scrollEl;
    const colBottom = colEl.getBoundingClientRect().bottom - vb.top;
    const r = document.createRange();
    const phrases = [], boxes = [];
    for (const R of p.ranges) {
      // per-character line grouping (robust across wraps), trimmed of the spaces at the wrap
      const rows = [];
      for (let c = R.a; c < R.b; c++) {
        r.setStart(tNode, c); r.setEnd(tNode, c + 1);
        const q = r.getClientRects()[0];
        if (!q) continue;
        const top = q.top - base.top;
        let row = rows.find((x) => Math.abs(x.top - top) < lineH * 0.5);
        if (!row) { row = { top, chars: [] }; rows.push(row); }
        row.chars.push({ c, l: q.left - base.left, r: q.right - base.left, ch: p.prompt[c] });
      }
      rows.sort((x, y) => x.top - y.top);
      const pcs = [];
      for (const row of rows) {
        let a = 0, b = row.chars.length - 1;
        while (a <= b && /\s/.test(row.chars[a].ch)) a++;
        while (b >= a && /\s/.test(row.chars[b].ch)) b--;
        if (a > b) continue;
        const txt = row.chars.slice(a, b + 1).map((x) => x.ch).join("");
        const ink = TR.measure(txt, font);
        const baseline = row.top + fAsc;
        const x0 = row.chars[a].l - HL.pad_left_em * em, x1 = row.chars[b].r + HL.pad_right_em * em;
        const y0 = baseline - ink.actualBoundingBoxAscent - HL.pad_top_em * em;
        const y1 = baseline + Math.max(ink.actualBoundingBoxDescent + HL.pad_bottom_em * em, HL.min_below_baseline_em * em);
        pcs.push({ x0, x1, y0, y1 });
      }
      boxes.push(pcs);
      const top = pcs.length ? Math.min(...pcs.map((q) => q.y0)) : 0, bot = pcs.length ? Math.max(...pcs.map((q) => q.y1)) : 0;
      phrases.push({ top: k0 * (textTop + top), bot: k0 * (textTop + bot), pieces: Math.max(1, pcs.length) });
    }
    const appMax = st.dockTop != null ? Math.max(0, k0 * (colBottom + 24 - st.dockTop)) : Infinity;
    const geo = { k0, lineSv: k0 * lineH, phrases, appMax, textBottom: k0 * (textTop + textEl.offsetHeight),
      colLeft: k0 * textLeft, colWidth: k0 * textEl.offsetWidth };
    // the highlight boxes: a clipped yellow box holding a dark CLONE of the text element (same classes → the kit's own
    // css lays it out identically), built once
    st.hlLayer.innerHTML = "";
    const proto = textEl.cloneNode(true);
    for (const x of [...proto.children]) if (!x.classList.contains("lps-t")) x.remove();
    proto.style.cssText += `;position:absolute;margin:0;width:${cs.width};color:${HL.text_color};-webkit-text-fill-color:${HL.text_color}`;
    st.pieceEls = boxes.map((pcs) => pcs.map((q) => {
      const box = TR.el("div", `position:absolute;left:${q.x0}px;top:${q.y0}px;width:0px;height:${q.y1 - q.y0}px;overflow:hidden;` +
        `border-radius:${HL.radius_em * em}px;background:${HL.color};display:none`, st.hlLayer);
      const c = proto.cloneNode(true);
      c.style.left = -q.x0 - parseFloat(cs.borderLeftWidth || 0) + "px";
      c.style.top = -q.y0 - parseFloat(cs.borderTopWidth || 0) + "px";
      box.appendChild(c);
      return { box, w: q.x1 - q.x0 };
    }));
    stage.style.transform = "";
    return geo;
  }

  function seek(st, t, scene) {
    const ready = !document.fonts || (document.fonts.status === "loaded" && document.fonts.check(st.fontSpec));
    const key = ready + ":" + st.textEl.offsetHeight + ":" + st.textEl.offsetWidth;
    if (!st.plan || st.key !== key) {
      st.geo = measure(st, scene);
      st.plan = plan(scene, st.p, st.geo);
      st.key = key;
      st.warnings = st.plan.warnings.concat(st.p.missing.map((s) => `phrase not in the prompt (dropped): "${s.slice(0, 40)}"`));
      window.__lpsWarnings = st.warnings;
      window.__lpsPlan = { Z: st.plan.Z, pivot: [st.plan.px, st.plan.py], S0: st.plan.S0, zoomStart: st.plan.zoomStart,
        moves: st.plan.moves, sweeps: st.plan.sweeps, appMax: st.geo.appMax, phrases: st.geo.phrases };
      if (ready) for (const w of st.warnings) console.warn("long_prompt_scroll: " + w);
    }
    const P = st.plan, K = st.K;
    const dur = scene.duration != null ? Number(scene.duration) : null;
    const gone = t < P.tin - 1e-6 || (P.out != null && t >= P.out) || (dur != null && t > dur + 1e-6);
    st.root.style.visibility = gone ? "hidden" : "visible";
    if (gone) return;
    // camera: zoom about the pivot + the scroll (app scroll up to its limit, then a camera pan)
    const z = 1 + (P.Z - 1) * TR.prog(t, P.zoomStart, P.zoomDur, K.zoom.ease);
    const Sv = P.Sat(t);
    const appS = Math.min(Sv, st.geo.appMax), pan = Sv - appS;
    st.scrollEl.style.transform = `translateY(${-appS / st.k0}px)`;
    st.stage.style.transform = `translate(${P.px * (1 - z)}px,${P.py * (1 - z) - z * pan}px) scale(${z * st.k0})`;
    // marker sweeps (accumulate, stay)
    for (let i = 0; i < st.pieceEls.length; i++) {
      const sw = P.sweeps[i];
      st.pieceEls[i].forEach((pc, m) => {
        const pr = TR.prog(t, sw.pieces[m], K.sweep.dur_s, K.sweep.ease);
        pc.box.style.display = pr > 0 ? "block" : "none";
        if (pr > 0) pc.box.style.width = pc.w * pr + "px";
      });
    }
  }

  window.__TEMPLATES = window.__TEMPLATES || {};
  window.__TEMPLATES.long_prompt_scroll = { build, seek, _plan: plan, _norm: normParams };
})();
