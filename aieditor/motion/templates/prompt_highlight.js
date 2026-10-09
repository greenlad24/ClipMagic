/*
 * prompt_highlight (MO06) — the app's prompt box: the camera pushes in on the composer while a long prompt types,
 * and a YELLOW MARKER sweeps over each key phrase on the beat where the narration says it.
 * Reference: /opt/aieditor-work/reference/motion-2026-10-09/motion5.mov (Claude.ai dark composer, screen-captured
 * from YouTube; spec: reference-specs/prompt_highlight.md).
 *
 * Motion = scene.kf (prompt_highlight.kf.json, measured), look = scene.style (prompt_highlight.style.json) +
 * scene.kit (the app's UI kit; null = a neutral dark box, never another app's UI).
 *
 * params: prompt (string), phrases [string] (exact substrings, in prompt order), app, push_in (scale, null = measured),
 *         greeting (null = kit default), backdrop (true), pretyped (chars already in the box at "type"; null = auto)
 * beats:  in, type, hl_0..hl_{n-1} (when the phrase's first word is spoken), out (optional: hard cut)
 */
(function () {
  "use strict";
  const TR = window.__TR;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function normParams(scene) {
    const p = Object.assign({ prompt: "", phrases: [], push_in: null, greeting: null, backdrop: true, pretyped: null }, scene.params || {});
    p.prompt = String(p.prompt || "");
    let ph = p.phrases;
    if (typeof ph === "string") ph = [ph];
    // phrase char ranges, in prompt order (a phrase that is not a substring is dropped — Python refuses it first)
    const ranges = [];
    let from = 0;
    for (const s of (ph || []).map(String)) {
      let a = p.prompt.indexOf(s, from);
      if (a < 0) a = p.prompt.indexOf(s);
      if (a < 0 || !s.length) continue;
      ranges.push({ a, b: a + s.length, text: s });
      from = a + s.length;
    }
    ranges.sort((x, y) => x.a - y.a);
    p.ranges = ranges;
    return p;
  }

  // ───────────────────────────── timeline (pure numbers from beats + kf) ─────────────────────────────
  function timeline(scene, p) {
    const K = scene.kf, B = scene.beats || {};
    const n = p.ranges.length, L = p.prompt.length;
    const tin = B.in != null ? Number(B.in) : 0;
    const cps = K.type.cps, lag = K.type.lag_s;
    // the beats of the highlights (missing → measured spacing)
    const hl = [];
    for (let i = 0; i < n; i++) {
      let v = B["hl_" + i] != null ? Number(B["hl_" + i]) : null;
      if (v == null) v = i === 0 ? tin + K.sweep.fallback_first_after_in_s : hl[i - 1] + K.sweep.fallback_spacing_s;
      hl.push(v);
    }
    // typing start + text already in the box
    const tType = B.type != null ? Math.max(tin, Number(B.type)) : tin;
    let c0;
    if (p.pretyped != null) c0 = Math.max(0, Math.min(L, Math.round(Number(p.pretyped))));
    else if (B.type != null && B.type > tin + 0.05) c0 = 0;
    else if (n) {
      // auto: as much text as needed so the first phrase lands on its beat at the natural rate (snapped back to a word start)
      c0 = Math.floor(p.ranges[0].b - cps * (hl[0] - lag - tType));
      c0 = Math.max(0, Math.min(p.ranges[0].a, c0));
      while (c0 > 0 && !/\s/.test(p.prompt[c0 - 1])) c0--;
    } else c0 = 0;
    // knots of the typing schedule: natural rate, sped up (≤ max_cps) only where a phrase would miss its beat
    const knots = [[tType, c0]];
    for (let i = 0; i < n; i++) {
      const cur = knots[knots.length - 1], e = p.ranges[i].b;
      if (e <= cur[1]) continue;
      const nat = cur[0] + (e - cur[1]) / cps, dl = hl[i] - lag;
      if (nat > dl) knots.push([Math.max(dl, cur[0] + (e - cur[1]) / K.type.max_cps), e]);
      else knots.push([nat, e]);
    }
    { const cur = knots[knots.length - 1]; if (cur[1] < L) knots.push([cur[0] + (L - cur[1]) / cps, L]); }
    const charsAt = (t) => {
      if (t < knots[0][0]) return c0;
      for (let k = 0; k < knots.length - 1; k++) {
        const [ta, ca] = knots[k], [tb, cb] = knots[k + 1];
        if (t < tb) return Math.min(L, Math.floor(ca + (cb - ca) * ((t - ta) / Math.max(1e-6, tb - ta)) + 1e-6));
      }
      return L;
    };
    const timeOf = (c) => {   // when char count c is reached
      if (c <= c0) return knots[0][0];
      for (let k = 0; k < knots.length - 1; k++) {
        const [ta, ca] = knots[k], [tb, cb] = knots[k + 1];
        if (c <= cb) return ta + (tb - ta) * ((c - ca) / Math.max(1e-6, cb - ca));
      }
      return knots[knots.length - 1][0];
    };
    const typedEnd = knots[knots.length - 1][0];
    // camera push: ends when the first sweep starts
    const P = K.push;
    let pushEnd = n ? hl[0] : tin + P.fallback_start_after_in_s + P.dur_s;
    let pushDur = Math.max(P.min_dur_s, Math.min(P.dur_s, pushEnd - tin - P.min_start_after_in_s));
    let pushStart = Math.max(tin + P.min_start_after_in_s, pushEnd - pushDur);
    pushEnd = pushStart + pushDur;
    // sweeps (piece timing is laid out at seek time, when the line pieces are known)
    const sweepStart = [];
    for (let i = 0; i < n; i++) sweepStart.push(Math.max(hl[i], timeOf(p.ranges[i].b) + K.sweep.after_typed_s, i === 0 ? pushEnd : 0));
    return { tin, tType, c0, knots, charsAt, timeOf, typedEnd, hl, pushStart, pushDur, pushEnd, sweepStart,
      out: B.out != null ? Number(B.out) : null };
  }

  // ───────────────────────────── build ─────────────────────────────
  function build(root, scene) {
    const p = normParams(scene), S = scene.style, K = scene.kf, kit = scene.kit && scene.kit.composer ? scene.kit : null;
    const tl = timeline(scene, p);
    const W = scene.width, H = scene.height;
    const cls = kit ? "kit-" + String(kit.app || "app").replace(/[^a-z0-9_-]/gi, "") : "ph-neutral";
    const tokens = kit ? kit.tokens || {} : {};
    const tokenCss = Object.entries(tokens).filter(([k, v]) => k.startsWith("--") && typeof v === "string").map(([k, v]) => `${k}:${v}`).join(";");
    const scope = (css) => String(css || "").replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) =>
      `${a} ${sel.split(",").map((s) => (s.trim().startsWith(":root") ? `.${cls}` : `.${cls} ${s.trim()}`)).join(",")}{`);

    const bgTok = Object.entries(tokens).find(([k2]) => /-(page|bg)$/.test(k2));
    const bgCol = kit ? kit.bg || (bgTok && bgTok[1]) || S.backdrop : S.neutral.bg;
    const backdrop = p.backdrop !== false ? TR.el("div", `position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:${bgCol}`, root) : null;
    const cam = TR.el("div", `position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0`, root);
    const stage = TR.el("div", `position:absolute;left:0;top:0;transform-origin:0 0;${tokenCss}`, cam);
    stage.className = cls;

    let compW, promptEl, composerEl, sugEl = null, greetEl = null, fontPx, lineH;
    // the text is laid out IN FULL from the start (the reference reveals characters into a fixed layout: a word never
    // jumps lines while it is typed); the unrevealed rest is invisible. A hidden copy is the geometry source.
    const prefixHtml = '<span class="ph-text"></span><span class="ph-rest" style="visibility:hidden"></span>' +
      '<div class="ph-measure" style="position:absolute;left:0;top:0;width:100%;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word"></div>';
    if (kit) {
      TR.addCss(scope(kit.composer.css) + "\n" + (kit.greeting ? scope(kit.greeting.css) : "") + "\n" + (kit.suggestions ? scope(kit.suggestions.css) : ""));
      compW = kit.composer.width;
      const col = TR.el("div", `position:absolute;left:0;top:0;width:${compW}px`, stage);
      const model = kit.composer.model || kit.model_label || "";
      col.innerHTML = TR.fill(kit.composer.html, { prompt: "", placeholder: "", chips_html: "", state_html: "", caret_html: "",
        layout_class: kit.composer.multiline_class || (kit.composer.height_multiline ? "is-multiline" : ""), model, model_label: model });
      composerEl = col.firstElementChild;
      promptEl = col.querySelector(kit.composer.prompt_sel || ".cl-prompt");
      // an inline prompt span (e.g. inside a text row) → its block container holds the text
      if (promptEl && getComputedStyle(promptEl).display === "inline") {
        const blk = promptEl.parentElement;
        for (const ch of [...blk.children]) ch.style.display = "none";
        promptEl.textContent = "\u200b";            // the kit's own state rules see a non-empty prompt (send button)
        promptEl = blk;
      }
      promptEl.style.whiteSpace = "pre-wrap";
      promptEl.style.overflowWrap = "break-word";
      promptEl.style.textOverflow = "clip";
      if (kit.suggestions) {
        const items = (kit.suggestions.items || []).map((it) => TR.fill(kit.suggestions.item_html, { label: it.label, w: it.w || "" })).join("");
        sugEl = TR.el("div", `margin-top:${kit.suggestions.gap_below_composer || 14}px`, col, TR.fill(kit.suggestions.html, { items_html: items }));
      }
      if (kit.greeting) {
        const g = p.greeting != null && String(p.greeting).trim() ? String(p.greeting) : kit.greeting.default || "";
        greetEl = TR.el("div", `position:absolute;left:0;top:0;width:${compW}px`, stage,
          TR.fill(kit.greeting.html, { greeting: g }) );
        const t = greetEl.querySelector(".cl-greet-text") || greetEl;
        t.insertAdjacentHTML("beforeend", '<span class="ph-bl" style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>');
      }
    } else {
      const N = S.neutral;
      compW = N.width;
      TR.addCss(`.${cls} .ph-comp{box-sizing:border-box;width:${N.width}px;background:${N.surface};border:1px solid ${N.border};border-radius:${N.radius}px;font-family:${N.font},sans-serif;-webkit-font-smoothing:antialiased}
.${cls} .ph-in{padding:12.75px 25px 0 18px}
.${cls} .ph-prompt{position:relative;font-size:${N.font_size}px;line-height:${N.line_height}px;color:${N.text};white-space:pre-wrap;overflow-wrap:break-word;min-height:${N.line_height}px}
.${cls} .ph-row{position:relative;height:32px;margin:4.8px 18px 11px 18px}
.${cls} .ph-plus{position:absolute;left:7px;top:7px;width:18px;height:18px}
.${cls} .ph-send{position:absolute;right:0;top:0;width:32px;height:32px;border-radius:16px;background:${N.send};display:flex;align-items:center;justify-content:center}
.${cls} .cl-placeholder{color:${N.muted}}`);
      const col = TR.el("div", `position:absolute;left:0;top:0;width:${compW}px`, stage);
      col.innerHTML = `<div class="ph-comp"><div class="ph-in"><div class="ph-prompt"></div></div><div class="ph-row">` +
        `<svg class="ph-plus" viewBox="0 0 18 18" fill="none" stroke="${N.muted}" stroke-width="1.3" stroke-linecap="round"><path d="M9 1v16M1 9h16"/></svg>` +
        `<div class="ph-send"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14V2M2.6 7.4L8 2l5.4 5.4"/></svg></div></div></div>`;
      composerEl = col.firstElementChild;
      promptEl = col.querySelector(".ph-prompt");
    }
    promptEl.style.position = "relative";
    promptEl.style.overflow = "visible";
    { const keep = [...promptEl.children].filter((c2) => c2.style.display === "none"); promptEl.innerHTML = prefixHtml; for (const c2 of keep) promptEl.appendChild(c2); }
    const textEl = promptEl.querySelector(".ph-text"), restEl = promptEl.querySelector(".ph-rest"), measureEl = promptEl.querySelector(".ph-measure");
    restEl.textContent = p.prompt;
    measureEl.textContent = p.prompt || " ";
    const cs = getComputedStyle(promptEl);
    const padL = parseFloat(cs.paddingLeft) || 0, padT = parseFloat(cs.paddingTop) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const contentW = promptEl.clientWidth - padL - padR;
    Object.assign(measureEl.style, { left: padL + "px", top: padT + "px", width: contentW + "px" });
    fontPx = parseFloat(cs.fontSize) || 16;
    lineH = parseFloat(cs.lineHeight) || fontPx * 1.5;
    const em = fontPx;
    const HL = S.highlight, CA = S.caret;
    const caret = TR.el("div", `position:absolute;left:0;top:0;width:${Math.max(0.6, CA.width_em * em)}px;background:${CA.color};display:none`, promptEl);
    const placeholder = TR.el("div", `position:absolute;left:0;top:0;white-space:nowrap;display:none`, promptEl,
      esc(kit ? kit.composer.placeholder : S.neutral.placeholder));
    placeholder.className = "cl-placeholder";
    { const mt = Object.entries(tokens).find(([k2]) => /-(muted|text-2)$/.test(k2)); placeholder.style.color = mt ? mt[1] : S.neutral.muted; }
    const hlLayer = TR.el("div", `position:absolute;left:0;top:0;width:0;height:0;overflow:visible`, promptEl);

    const st = { p, tl, S, K, kit, cam, stage, composerEl, promptEl, textEl, restEl, measureEl, caret, placeholder, hlLayer, em, lineH,
      greetEl, compW, W, H, root, lastC: -1, contentW, padL, padT, laid: false };
    layout(st);
    return st;
  }

  // layout-dependent numbers (line count of every prefix → growth events; the push-in fit). Re-run once the web fonts
  // have loaded (build runs before document.fonts.ready; a fallback font wraps differently).
  function layout(st) {
    const { p, tl, S, K, kit, promptEl, textEl, composerEl, greetEl, compW, W, H, lineH } = st;
    st.laid = document.fonts ? document.fonts.status === "loaded" : true;
    const L = p.prompt.length;
    const linesOf = new Array(L + 1).fill(1);
    const lineOfChar = (i) => {   // 0-based visual line of char i in the full layout
      const r = document.createRange(), node = st.measureEl.firstChild;
      r.setStart(node, i); r.setEnd(node, i + 1);
      const rs = [...r.getClientRects()].filter((q) => q.width > 0.01);
      const q = rs.length ? rs[rs.length - 1] : r.getBoundingClientRect();
      const base = promptEl.getBoundingClientRect();
      const sc = base.width / promptEl.offsetWidth || 1;
      return Math.max(0, Math.floor(((q.top + q.height / 2 - base.top) / sc - st.padT) / lineH));
    };
    const keepH = promptEl.style.height;
    promptEl.style.height = "";
    for (let c = 1; c <= L; c++) linesOf[c] = /\s/.test(p.prompt[c - 1]) ? linesOf[c - 1] : lineOfChar(c - 1) + 1;
    st.lineOfChar = lineOfChar;
    // a line change at char c → growth event at the time that char appears
    const grows = [];
    for (let c = Math.max(1, tl.c0 + 1); c <= L; c++) if (linesOf[c] > linesOf[c - 1]) grows.push({ t: tl.timeOf(c), from: linesOf[c - 1], to: linesOf[c] });
    st.grows = grows;
    st.linesStart = linesOf[tl.c0];
    st.maxLines = linesOf[L];
    // base placement (screen px at push scale 1) + the end-of-push fit
    const k0 = S.layout.composer_w / compW;
    st.k0 = k0;
    st.T0x = S.layout.composer_cx - k0 * compW / 2;
    st.T0y = S.layout.composer_top;
    st.piv = [K.push.pivot[0] * W, K.push.pivot[1] * H];
    promptEl.style.height = st.maxLines * lineH + "px";
    const fullH = composerEl.parentNode.offsetHeight;
    let gTop = 0;
    if (greetEl) {
      greetEl.style.top = "0px";
      const bl = greetEl.querySelector(".ph-bl");
      const sc = greetEl.getBoundingClientRect().width / greetEl.offsetWidth || 1;
      const blY = (bl.getBoundingClientRect().top - greetEl.getBoundingClientRect().top) / sc;
      gTop = -(kit.greeting.baseline_above_composer || 39) - blY;
      greetEl.style.top = gTop + "px";
    }
    let push = p.push_in != null ? Number(p.push_in) : K.push.scale;
    const m = S.layout.fit_margin, piv = st.piv;
    // vertical: the composer (at its full text) ends centred where the reference's ends (layout.end_centre_y)
    const compH = composerEl.offsetHeight;
    const t0y = (s) => (S.layout.end_centre_y != null ? piv[1] + (S.layout.end_centre_y - piv[1] - s * k0 * compH / 2) / s : S.layout.composer_top);
    const fits = (s) => {
      const sc = k0 * s;
      st.T0y = t0y(s);
      const x0 = piv[0] + s * (st.T0x - piv[0]), y0 = piv[1] + s * (st.T0y - piv[1]);
      return x0 >= m && x0 + compW * sc <= W - m && y0 + (gTop - 10) * sc >= m && y0 + fullH * sc <= H - m;
    };
    while (push > 1.0 && !fits(push)) push -= 0.01;
    st.push = Math.max(1, push);
    st.T0y = t0y(st.push);
    st.fullH = fullH;
    promptEl.style.height = keepH;
  }

  // the line pieces of char range [a,b) in prompt-local px (unscaled)
  function pieces(st, a, b) {
    const node = st.measureEl.firstChild;
    if (!node || b > node.length) return [];
    const r = document.createRange();
    r.setStart(node, a); r.setEnd(node, b);
    const base = st.promptEl.getBoundingClientRect();
    const sc = base.width / st.promptEl.offsetWidth || 1;
    const rows = [];
    for (const q of r.getClientRects()) {
      if (q.width < 0.5) continue;
      const top = (q.top - base.top) / sc, left = (q.left - base.left) / sc, right = (q.right - base.left) / sc, h = q.height / sc;
      const row = rows.find((x) => Math.abs(x.top - top) < h * 0.5);
      if (row) { row.left = Math.min(row.left, left); row.right = Math.max(row.right, right); }
      else rows.push({ top, left, right, h });
    }
    rows.sort((x, y) => x.top - y.top);
    // line-box top from the glyph content box (centred in the line box)
    return rows.map((x) => ({ lineTop: x.top - (st.lineH - x.h) / 2, left: x.left, right: x.right }));
  }

  function seek(st, t, scene) {
    const { tl, K, S, p } = st;
    if (!st.laid) layout(st);
    const dur = scene.duration != null ? Number(scene.duration) : null;
    const gone = t < tl.tin - 1e-6 || (tl.out != null && t >= tl.out) || (dur != null && t > dur + 1e-6);
    st.root.style.visibility = gone ? "hidden" : "visible";
    if (gone) return;

    // camera
    const ps = TR.prog(t, tl.pushStart, tl.pushDur, K.push.ease);
    const s = 1 + (st.push - 1) * ps;
    const sc = st.k0 * s;
    const tx = st.piv[0] + s * (st.T0x - st.piv[0]), ty = st.piv[1] + s * (st.T0y - st.piv[1]);
    st.stage.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`;

    // typing
    const c = tl.charsAt(t);
    if (c !== st.lastC) { st.textEl.textContent = p.prompt.slice(0, c); st.restEl.textContent = p.prompt.slice(c); st.lastC = c; }
    st.placeholder.style.display = c === 0 ? "block" : "none";
    const caretOn = t >= tl.tType - 1e-6 && t < tl.typedEnd + K.type.caret_hide_after_s;
    st.caret.style.display = caretOn ? "block" : "none";
    if (caretOn) {
      // right edge of the last typed char (or the start of the box), full line-box tall less a little
      let x = 0, ln = 0;
      if (c > 0) {
        const r = document.createRange(), node = st.measureEl.firstChild;
        r.setStart(node, 0); r.setEnd(node, c);            // the typed prefix: its last line fragment ends at the caret
        const rs = [...r.getClientRects()].filter((q) => q.width > 0.01);
        const q = rs.length ? rs.reduce((m2, q2) => (q2.top > m2.top + 1 || (Math.abs(q2.top - m2.top) <= 1 && q2.right > m2.right) ? q2 : m2)) : r.getBoundingClientRect();
        const base = st.promptEl.getBoundingClientRect(), k = base.width / st.promptEl.offsetWidth || 1;
        x = (q.right - base.left) / k - st.padL; ln = Math.floor(((q.top + q.height / 2 - base.top) / k - st.padT) / st.lineH);
      }
      const h = st.em * S.caret.height_em;
      st.caret.style.height = h + "px";
      st.caret.style.left = (st.padL + x + S.caret.gap_em * st.em) + "px";
      st.caret.style.top = (st.padT + ln * st.lineH + (st.lineH - h) / 2) + "px";
    }

    // composer height (animated line growth)
    let lines = st.linesStart;
    for (const g of st.grows) {
      const a = g.t - K.grow.lead_s;
      if (t >= a) lines = g.from + (g.to - g.from) * TR.prog(t, a, K.grow.dur_s, K.grow.ease);
    }
    st.promptEl.style.height = lines * st.lineH + "px";

    // highlights
    const HL = S.highlight, em = st.em;
    let html = "";
    let prevEnd = -1e9;
    for (let i = 0; i < p.ranges.length; i++) {
      const R = p.ranges[i];
      let t0 = Math.max(tl.sweepStart[i], prevEnd);
      if (c < R.b) { prevEnd = Math.max(prevEnd, t0); continue; }
      const ps2 = pieces(st, R.a, R.b);
      let tt = t0;
      for (let j = 0; j < ps2.length; j++) {
        const q = ps2[j];
        const x0 = q.left - HL.pad_left_em * em, x1 = q.right + HL.pad_right_em * em, y0 = q.lineTop + HL.top_em * em, hh = HL.height_em * em;
        const w = x1 - x0;
        const d = TR.clamp((w / em) * K.sweep.s_per_em, K.sweep.min_s, K.sweep.max_s);
        const pr = TR.prog(t, tt, d, K.sweep.ease);
        if (pr > 0) {
          const ww = w * pr;
          html += `<div style="position:absolute;left:${x0}px;top:${y0}px;width:${ww}px;height:${hh}px;overflow:hidden;border-radius:${HL.radius_em * em}px;background:${HL.color}">` +
            `<div style="position:absolute;left:${st.padL - x0}px;top:${st.padT - y0}px;width:${st.contentW}px;white-space:pre-wrap;overflow-wrap:break-word;color:${HL.text_color}">${esc(p.prompt.slice(0, c))}<span style="visibility:hidden">${esc(p.prompt.slice(c))}</span></div></div>`;
        }
        tt += d + (j < ps2.length - 1 ? K.sweep.line_gap_s : 0);
      }
      prevEnd = tt;
    }
    if (st._hl !== html) { st.hlLayer.innerHTML = html; st._hl = html; }
  }

  window.__TEMPLATES = window.__TEMPLATES || {};
  window.__TEMPLATES.prompt_highlight = { build, seek, _timeline: timeline, _norm: normParams };
})();
