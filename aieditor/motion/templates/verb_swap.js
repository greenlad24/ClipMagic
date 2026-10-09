/*
 * verb_swap — "Grok Bot can now ⟨search|read|analyze⟩ X" (reference motion1.mp4, 2026-10-09).
 * The line builds word by word (hard pops, the whole line drifting left into place), then the verb
 * swaps on each verb beat: the text + colour switch hard ON the beat while every word's x eases
 * from the line laid out with the old verb to the line laid out with the new one (re-centring).
 * Motion = scene.kf (verb_swap.kf.json), look = scene.style (verb_swap.style.json).
 *
 * params: prefix (string, 1-6 words), verbs [{text, colour?}] (2-4), suffix (string, 0-3 words),
 *         backdrop (bool, default true), align ("centre" | "left")
 * beats:  in, word_1..word_{n-1} (optional, prefix words), verb_0..verb_{n-1}, out (optional)
 */
(function () {
  "use strict";
  const TR = window.__TR;

  function words(s) {
    return String(s || "").trim().split(/\s+/).filter(Boolean);
  }

  function timing(scene) {
    const kf = scene.kf, P = scene.params || {}, b = scene.beats || {};
    const td = kf.timing_defaults;
    const pre = words(P.prefix);
    const nv = (P.verbs || []).length;
    const tin = b.in != null ? b.in : 0;
    const v = [];
    v[0] = b.verb_0 != null ? b.verb_0 : tin + td.in_to_verb0_s;
    for (let i = 1; i < nv; i++) v[i] = b["verb_" + i] != null ? b["verb_" + i] : v[i - 1] + td.verb_spacing_s;
    // prefix words: own beats if given, else the measured offsets (reference has 4 words) or the mean stagger,
    // never later than verb_0 - min gap
    const w = [];
    const latest = v[0] - td.last_prefix_word_to_verb0_min_s;
    for (let k = 0; k < pre.length; k++) {
      let t;
      if (k === 0) t = tin;
      else if (b["word_" + k] != null) t = b["word_" + k];
      else if (pre.length === td.prefix_word_offsets_s.length) t = tin + td.prefix_word_offsets_s[k];
      else t = tin + k * td.prefix_word_stagger_s;
      w.push(Math.max(tin, Math.min(t, latest)));
    }
    const out = b.out != null ? b.out : scene.duration != null ? scene.duration : v[nv - 1] + td.hold_after_last_verb_s;
    return { tin, w, v, out };
  }

  function build(root, scene) {
    const P = scene.params || {}, st = scene.style;
    const W = scene.width, H = scene.height;
    const backdrop = P.backdrop !== false;
    if (backdrop) TR.el("div", `position:absolute;inset:0;background:${st.background}`, root);
    const verbs = (P.verbs || []).map((v, i) => ({
      text: typeof v === "string" ? v : v.text,
      colour: (typeof v === "object" && v.colour) || st.verb_colours[i % st.verb_colours.length],
    }));
    const pre = words(P.prefix), suf = words(P.suffix);
    let fs = st.font_size_frac * H;
    const font = (size) => `font-family:"${st.font_family}";font-weight:${st.font_weight};font-size:${size}px;letter-spacing:${st.tracking_em}em;white-space:pre;line-height:1`;
    const layer = TR.el("div", `position:absolute;left:0;top:0;width:${W}px;height:${H}px`, root);
    const mk = (text, colour) => TR.el("span", `position:absolute;left:0;top:0;${font(fs)};color:${colour};will-change:transform`, layer, null);
    const preEls = pre.map((t) => { const e = mk(t, st.text_colour); e.textContent = t; return e; });
    const verbEl = mk("", verbs[0].colour);
    const sufEls = suf.map((t) => { const e = mk(t, st.text_colour); e.textContent = t; return e; });
    // measuring box (hidden): one inline-block per string + a 0-height baseline probe
    const meas = TR.el("div", `position:absolute;left:0;top:0;visibility:hidden`, root);
    return { W, H, fs, font, verbs, pre, suf, layer, preEls, verbEl, sufEls, meas, layout: null };
  }

  // layout of the full line for every verb state: x of each word (left edge), slot centre of the verb
  function measure(s, scene) {
    const st = scene.style, P = scene.params || {};
    // re-measured on every seek: build() and the first seek run before the webfont has loaded,
    // so any cached layout could hold fallback-font widths (cheap: a few words)
    const widthOf = (text, size) => {
      s.meas.innerHTML = "";
      const e = TR.el("span", `display:inline-block;${s.font(size)}`, s.meas);
      e.textContent = text;
      // letter-spacing adds one trailing track after the last glyph; drop it from the advance
      return e.getBoundingClientRect().width - st.tracking_em * size;
    };
    const lineFor = (verb, size) => {
      const sp = st.word_space_em * size;
      const items = [...s.pre.map((t) => ({ t, k: "p" })), { t: verb, k: "v" }, ...s.suf.map((t) => ({ t, k: "s" }))];
      let x = 0;
      for (const it of items) { it.w = widthOf(it.t, size); it.x = x; x += it.w + sp; }
      return { items, width: x - sp };
    };
    // fit: shrink the font when the widest state would overflow
    let fs = st.font_size_frac * s.H;
    const maxW = st.max_line_width_frac * s.W;
    const widest = Math.max(...s.verbs.map((v) => lineFor(v.text, fs).width));
    if (widest > maxW) fs = fs * maxW / widest;
    // baseline offset of a line-height:1 span
    s.meas.innerHTML = "";
    const probeWrap = TR.el("div", `${s.font(fs)}`, s.meas);
    probeWrap.textContent = "X";
    const probe = TR.el("span", "display:inline-block;width:0;height:0;vertical-align:baseline", probeWrap);
    const baseOff = probe.getBoundingClientRect().top - probeWrap.getBoundingClientRect().top;
    const cx = st.centre_x_frac * s.W, left = st.left_margin_frac * s.W;
    const states = s.verbs.map((v) => {
      const L = lineFor(v.text, fs);
      const x0 = P.align === "left" ? left : cx - L.width / 2;
      const pre = [], suf = [];
      let slot = 0, vw = 0, lastW = 0;
      for (const it of L.items) {
        if (it.k === "p") { pre.push(x0 + it.x); lastW = it.w; }
        else if (it.k === "s") suf.push(x0 + it.x);
        else { slot = x0 + it.x + it.w / 2; vw = it.w; }
      }
      return { pre, suf, slot, vw, lastW };
    });
    s.meas.innerHTML = "";
    for (const e of [...s.preEls, s.verbEl, ...s.sufEls]) e.style.fontSize = fs + "px";
    s.fs = fs;
    s.layout = { fs, states, top: st.baseline_y_frac * s.H - baseOff };
    return s.layout;
  }

  function seek(s, t, scene) {
    const kf = scene.kf;
    t += 1e-4; // a frame that lands exactly on a beat shows the beat's step (5/30 s < 0.16666667 in floats)
    const L = measure(s, scene);
    const T = timing(scene);
    const fs = L.fs, nv = s.verbs.length;
    // current layout: state 0, then each swap blended in sequence
    let pre = L.states[0].pre.slice(), suf = L.states[0].suf.slice(), slot = L.states[0].slot;
    let cur = 0;
    for (let i = 1; i < nv; i++) {
      const sw = (kf.swap.measured && kf.swap.measured[i - 1]) || kf.swap;
      const p = TR.prog(t, T.v[i] - sw.lead_s, sw.dur_s, sw.ease);
      const S = L.states[i];
      pre = pre.map((x, k) => TR.lerp(x, S.pre[k], p));
      suf = suf.map((x, k) => TR.lerp(x, S.suf[k], p));
      slot = TR.lerp(slot, S.slot, p);
      if (t >= T.v[i] + (kf.swap.text_switch_s || 0)) cur = i;
    }
    const vw = L.states[cur].vw;
    // overlap guard (generalisation only — never triggers at the reference's own content): mid-swap a long
    // verb in a shrinking slot (or a long new verb in a still-narrow slot) must not run into its neighbours;
    // push the prefix left / suffix right just enough to keep kf.swap.min_gap_em between advance boxes
    const g = (kf.swap.min_gap_em || 0) * fs;
    if (pre.length) {
      const over = pre[pre.length - 1] + L.states[0].lastW - (slot - vw / 2 - g);
      if (over > 0) pre = pre.map((x) => x - over);
    }
    if (suf.length) {
      const over = slot + vw / 2 + g - suf[0];
      if (over > 0) suf = suf.map((x) => x + over);
    }
    // build motion
    const d = kf.drift;
    const drift = d.dx_em * fs * (1 - TR.prog(t, T.tin + d.start_s, d.dur_s, d.ease));
    const wi = kf.word_in, vi = kf.verb_in;
    const vin = 1 - TR.prog(t, T.v[0] + vi.start_s, vi.dur_s, vi.ease);
    const gone = t >= T.out;
    const place = (e, x, vis) => {
      e.style.opacity = vis && !gone ? "1" : "0";
      e.style.transform = `translate(${x.toFixed(3)}px,${L.top.toFixed(3)}px)`;
    };
    s.preEls.forEach((e, k) => {
      const tw = T.w[k];
      const extra = k === 0 ? 0 : wi.dx_em * fs * (1 - TR.prog(t, tw + wi.start_s, wi.dur_s, wi.ease));
      place(e, pre[k] + drift + extra, t >= tw);
    });
    const vOn = t >= T.v[0];
    const v = s.verbs[cur];
    if (s.verbEl.textContent !== v.text) s.verbEl.textContent = v.text;
    s.verbEl.style.color = v.colour;
    place(s.verbEl, slot - vw / 2 + drift + vi.verb_dx_em * fs * vin, vOn);
    s.sufEls.forEach((e, k) => place(e, suf[k] + drift + vi.suffix_dx_em * fs * vin, vOn));
  }

  window.__TEMPLATES["verb_swap"] = { build, seek, timing };
})();
