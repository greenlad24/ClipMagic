/*
 * Auto Editor motion engine — frame-exact, deterministic graphics.
 *
 * Every number the recipes use was MEASURED off the reference video frame by frame
 * (Jake 2026-10-04: "all of the animations should match exactly the reference in
 * keyframes"; specs in /opt/aieditor-work/reference/specs/). Nothing here runs in real
 * time: render.mjs calls window.__seek(frame) for every frame and screenshots it with a
 * transparent background, so frame N is identical on every render.
 *
 * A scene: { width, height, fps, frames, layers: [layer…] }
 * A text layer: { id, text, font: {family, weight, size, tracking(em)}, fill: "#fff" |
 *   {gradient: {stops: [[pos, colour]…], drift: {amp, period}}}, shadow?: {x, y, sigma, alpha},
 *   place: {quad: [[x,y]×4 TL TR BR BL]} | {x, y, align: left|centre|right} (x,y = ink box
 *   top-left/centre…), tracks: {opacity, tx, ty, scale, blurX, blurY}, motionBlur?: {shutter: 360},
 *   visible?: [firstFrame, lastFrame] }
 * A box layer (kind "box"): { box: {frame: [x0,y0,x1,y1]…} (linear between keys), radius:
 *   px | {ofHeight: r}, fill?: css colour, glass?: {blur} (blurs the BACKDROP — needs
 *   scene.backdrop), rim?: {colour, width, glow}, beams?: {colour, length, speed(px/f), width,
 *   glow}, tracks: {opacity, blur} }.
 * A sparkle layer (kind "sparkle"): { box: {frame: [x0,y0,x1,y1]…} (the pair incl. glow),
 *   angle: track (deg), colour, glow } — a big + a small four-point star.
 * scene.backdrop: "file:///…/f%05d.png" → each frame is drawn over that image (opaque
 *   output; used for glass, and by replica tests).
 * A track: a number | {tween: [{start, dur, from, to, ease: [x1,y1,x2,y2]}…]} |
 *   {table: {frame: value…}} (linear between listed frames, held outside). Units: px for
 *   tx/ty (or "em" when unit: "em"), frames for start/dur (fractional allowed).
 */
(function () {
  "use strict";

  // ---- easing: CSS cubic-bezier, solved exactly (Newton + bisection) ----
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const e = sx(t) - x, d = dx(t);
        if (Math.abs(e) < 1e-7) return sy(t);
        if (Math.abs(d) < 1e-6) break;
        t -= e / d;
      }
      let lo = 0, hi = 1;
      t = x;
      for (let i = 0; i < 40; i++) {
        const v = sx(t);
        if (Math.abs(v - x) < 1e-7) break;
        if (v < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return sy(t);
    };
  }
  const easeCache = new Map();
  function ease(e) {
    if (!e) return (x) => x;
    const k = e.join(",");
    if (!easeCache.has(k)) easeCache.set(k, bezier(...e));
    return easeCache.get(k);
  }

  // ---- tracks ----
  function valueAt(track, f, fallback) {
    if (track === undefined || track === null) return fallback;
    if (typeof track === "number") return track;
    if (track.tween) {
      let v = track.tween[0].from;
      for (const s of track.tween) {
        if (f < s.start) break;
        const p = s.dur > 0 ? Math.min(1, (f - s.start) / s.dur) : 1;
        v = s.from + (s.to - s.from) * ease(s.ease)(p);
      }
      return v;
    }
    if (track.table) {
      // ⚠️ look values up by the ORIGINAL key string: Python writes 2.0 as "2.0", and
      // table[Number("2.0")] reads table["2"] → undefined → NaN → the layer vanished
      const T = track._sorted || (track._sorted = Object.entries(track.table).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]));
      if (f <= T[0][0]) return T[0][1];
      if (f >= T[T.length - 1][0]) return T[T.length - 1][1];
      for (let i = 0; i < T.length - 1; i++) {
        if (f >= T[i][0] && f <= T[i + 1][0]) {
          const [ka, a] = T[i], [kb, b] = T[i + 1];
          return a + (b - a) * ((f - ka) / (kb - ka));
        }
      }
    }
    return fallback;
  }

  // ---- homography: rect (0,0,w,h) -> quad, as a CSS matrix3d ----
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]];
      [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) {
        const m = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= m * A[i][c];
        b[r] -= m * b[i];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }
  function rectToQuad(w, h, q) {
    const src = [[0, 0], [w, 0], [w, h], [0, h]];
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = q[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const [a, bb, c, d, e, f, g, hh] = solve(A, b);
    // column-major 4x4
    return `matrix3d(${a},${d},0,${g},${bb},${e},0,${hh},0,0,1,0,${c},${f},0,1)`;
  }

  // ---- text layers are drawn on a canvas so the ink box is exact ----
  const SS = 2; // supersampling of the text canvas
  // typed text (prompt bars): explicit lines ("\n"), pitch L.typing.pitch px; the box is
  // the layout box (font ascent/descent), so it does not jump as characters appear
  function makeTyped(L) {
    const f = L.font, ty = L.typing;
    const fontCss = `${f.weight || 400} ${f.size}px "${f.family}"`;
    const meas = document.createElement("canvas").getContext("2d");
    meas.font = fontCss;
    meas.letterSpacing = `${(f.tracking || 0) * f.size}px`;
    const lines = L.text.split("\n");
    const m0 = meas.measureText("Hg");
    const asc = m0.fontBoundingBoxAscent, desc = m0.fontBoundingBoxDescent;
    const w = Math.max(...lines.map((l) => meas.measureText(l).width));
    const h = asc + desc + (lines.length - 1) * ty.pitch;
    const pad = Math.ceil(f.size * 0.6);
    const cv = L._cv || (L._cv = document.createElement("canvas"));
    cv.width = Math.ceil((w + 2 * pad) * SS);
    cv.height = Math.ceil((h + 2 * pad) * SS);
    cv.style.cssText = `position:absolute;left:0;top:0;width:${w + 2 * pad}px;height:${h + 2 * pad}px;transform-origin:0 0;will-change:transform,opacity,filter`;
    // x of every character (prefix widths: kerning-correct)
    let idx = 0;
    const glyphs = [];
    lines.forEach((l, li) => {
      for (let j = 0; j < l.length; j++) glyphs.push({ ch: l[j], x: meas.measureText(l.slice(0, j)).width, line: li, i: idx++ });
      idx++; // the line break counts as a typed character
    });
    return { cv, text: L.text, fontCss, inkL: 0, asc, w, h, pad, tracking: (f.tracking || 0) * f.size, glyphs, typed: true };
  }

  function paintTyped(L, T, f) {
    const ctx = T.cv.getContext("2d");
    ctx.setTransform(SS, 0, 0, SS, 0, 0);
    ctx.clearRect(0, 0, T.cv.width, T.cv.height);
    ctx.font = T.fontCss;
    ctx.letterSpacing = `${T.tracking}px`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = L.fill || "#fff";
    // linear typing (measured on the reference: no ease, no caret); glyph i appears at
    // start + i / cpf and fades in over `fade` frames
    const ty = L.typing;
    for (const g of T.glyphs) {
      const a = (f - (ty.start + g.i / ty.cpf)) / (ty.fade || 1.5);
      if (a <= 0) continue;
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillText(g.ch, T.pad + g.x, T.pad + T.asc + g.line * ty.pitch);
    }
    ctx.globalAlpha = 1;
  }

  function makeText(L, text) {
    if (L.typing) return makeTyped(L);
    const f = L.font;
    const fontCss = `${f.weight || 700} ${f.size}px "${f.family}"`;
    const meas = document.createElement("canvas").getContext("2d");
    meas.font = fontCss;
    meas.letterSpacing = `${(f.tracking || 0) * f.size}px`;
    const m = meas.measureText(text);
    // ink box (cap-height box for an all-caps line); letterSpacing adds trailing space: trim it
    const trail = (f.tracking || 0) * f.size;
    const inkL = -m.actualBoundingBoxLeft, inkR = m.actualBoundingBoxRight - Math.max(0, trail);
    const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
    const sw = L.stroke ? L.stroke.width / 2 : 0;
    const w = inkR - inkL + 2 * sw, h = asc + desc + 2 * sw;
    const pad = Math.ceil(f.size * 0.6 + (L.shadow ? L.shadow.sigma * 3 + 10 : 0));
    const cv = L._cv || (L._cv = document.createElement("canvas"));
    cv.width = Math.ceil((w + 2 * pad) * SS);
    cv.height = Math.ceil((h + 2 * pad) * SS);
    cv.style.cssText = `position:absolute;left:0;top:0;width:${w + 2 * pad}px;height:${h + 2 * pad}px;transform-origin:0 0;will-change:transform,opacity,filter`;
    return { cv, text, fontCss, inkL: inkL - sw, asc: asc + sw, w, h, pad, tracking: (f.tracking || 0) * f.size };
  }

  function paintText(L, T, f) {
    if (T.typed) return paintTyped(L, T, f);
    const ctx = T.cv.getContext("2d");
    ctx.setTransform(SS, 0, 0, SS, 0, 0);
    ctx.clearRect(0, 0, T.cv.width, T.cv.height);
    ctx.font = T.fontCss;
    ctx.letterSpacing = `${T.tracking}px`;
    ctx.textBaseline = "alphabetic";
    const x0 = T.pad - T.inkL, y0 = T.pad + T.asc;
    let fill = L.fill || "#fff";
    let mesh = null;
    if (typeof fill === "object" && fill.mesh) {
      // reference pink: a horizontal base (magenta ends, hot-red core) with soft highlight
      // blobs (pale pink / yellow) drifting across the word — read off the reference's
      // "= $250" hold frame by frame (8830–8919). Blob tracks: {frame: [x, y, alpha]} in
      // ink-box units (0..1), radius in ink heights.
      mesh = fill.mesh;
      const g = ctx.createLinearGradient(T.pad, 0, T.pad + T.w, 0);
      for (const [p, c] of mesh.base) g.addColorStop(p, c);
      fill = g;
    } else if (typeof fill === "object" && fill.gradient) {
      const G = fill.gradient;
      // stops are laid over the ink width; drift slides the whole gradient sideways
      const drift = G.drift ? G.drift.amp * Math.sin((2 * Math.PI * f) / G.drift.period + (G.drift.phase || 0)) : 0;
      const gx0 = T.pad + drift * T.w, gx1 = T.pad + T.w + drift * T.w;
      const g = ctx.createLinearGradient(gx0, 0, gx1, 0);
      for (const [p, c] of G.stops) g.addColorStop(Math.min(1, Math.max(0, p)), c);
      fill = g;
    }
    // a stroke in the fill colour thickens the glyphs: the reference's type is heavier
    // than the font's own boldest weight (fitted per family against settled frames)
    const sw = L.stroke ? L.stroke.width : 0;
    // extrude: the glyph is also drawn slid along (dx, dy) in ≤0.5 px steps — the
    // reference's faux-bold grows strokes toward the bottom-right, not evenly
    const ex = L.extrude || { dx: 0, dy: 0 };
    const steps = Math.ceil(Math.max(Math.abs(ex.dx), Math.abs(ex.dy)) * 2);
    const draw = () => {
      for (let i = 1; i <= steps; i++) ctx.fillText(T.text, x0 + (ex.dx * i) / steps, y0 + (ex.dy * i) / steps);
      if (sw > 0) {
        ctx.lineJoin = "round";
        ctx.lineWidth = sw;
        ctx.strokeStyle = fill;
        ctx.strokeText(T.text, x0, y0);
      }
      ctx.fillText(T.text, x0, y0);
    };
    if (mesh) {
      const tmp = T.tmp || (T.tmp = document.createElement("canvas"));
      tmp.width = T.cv.width; tmp.height = T.cv.height;
      const main = ctx;
      const t = tmp.getContext("2d");
      t.setTransform(SS, 0, 0, SS, 0, 0);
      t.font = T.fontCss; t.letterSpacing = `${T.tracking}px`; t.textBaseline = "alphabetic";
      t.fillStyle = fill;
      const sw2 = L.stroke ? L.stroke.width : 0;
      for (let i = 1; i <= steps; i++) t.fillText(T.text, x0 + (ex.dx * i) / steps, y0 + (ex.dy * i) / steps);
      if (sw2 > 0) { t.lineJoin = "round"; t.lineWidth = sw2; t.strokeStyle = fill; t.strokeText(T.text, x0, y0); }
      t.fillText(T.text, x0, y0);
      t.globalCompositeOperation = "source-atop";
      for (const bl of mesh.blobs || []) {
        const [bx, by, ba] = blobAt(bl, f);
        if (ba <= 0.001) continue;
        const cx = T.pad + bx * T.w, cy = T.pad + by * T.h, r = bl.radius * T.h;
        const rg = t.createRadialGradient(cx, cy, 0, cx, cy, r);
        rg.addColorStop(0, rgba(bl.colour, ba));
        rg.addColorStop(0.45, rgba(bl.colour, ba * 0.75));
        rg.addColorStop(1, rgba(bl.colour, 0));
        t.fillStyle = rg;
        t.fillRect(0, 0, T.cv.width / SS, T.cv.height / SS);
      }
      main.save();
      main.setTransform(1, 0, 0, 1, 0, 0);
      if (L.shadow) {
        main.shadowColor = L.shadow.colour ? rgba(L.shadow.colour, L.shadow.alpha) : `rgba(0,0,0,${L.shadow.alpha})`;
        main.shadowBlur = L.shadow.sigma * 2 * SS;
        main.shadowOffsetX = L.shadow.x * SS;
        main.shadowOffsetY = L.shadow.y * SS;
      }
      main.drawImage(tmp, 0, 0);
      main.restore();
    } else if (L.shadow) {
      ctx.save();
      ctx.shadowColor = L.shadow.colour ? rgba(L.shadow.colour, L.shadow.alpha) : `rgba(0,0,0,${L.shadow.alpha})`;
      ctx.shadowBlur = L.shadow.sigma * 2 * SS; // canvas shadowBlur = 2σ
      ctx.shadowOffsetX = L.shadow.x * SS;
      ctx.shadowOffsetY = L.shadow.y * SS;
      ctx.fillStyle = fill;
      draw();
      ctx.restore();
    } else {
      ctx.fillStyle = fill;
      draw();
    }
  }

  function rgba(c, a) {
    return `rgba(${[1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(",")},${a})`;
  }
  // a blob's [x, y, alpha] at frame f: a keyframe table, or a slow procedural wander
  function blobAt(bl, f) {
    if (bl.track) {
      const ks = Object.keys(bl.track).map(Number).sort((a, b) => a - b);
      if (f <= ks[0]) return bl.track[ks[0]];
      if (f >= ks[ks.length - 1]) return bl.track[ks[ks.length - 1]];
      for (let i = 0; i < ks.length - 1; i++)
        if (f <= ks[i + 1]) {
          const u = (f - ks[i]) / (ks[i + 1] - ks[i]), s = u * u * (3 - 2 * u);
          return bl.track[ks[i]].map((v, j) => v + (bl.track[ks[i + 1]][j] - v) * s);
        }
    }
    const w = bl.wander, T2 = 2 * Math.PI * f;
    return [0.5 + w.ax * Math.sin(T2 / w.px + w.phx), 0.5 + w.ay * Math.sin(T2 / w.py + w.phy),
            Math.max(0, w.a0 + w.a1 * Math.sin(T2 / w.pa + w.pha))];
  }
  function mix(a, b, t) {
    const h = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const A = h(a), B = h(b);
    return "rgb(" + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",") + ")";
  }

  // directional blur via SVG filters (CSS blur() is isotropic)
  let svgDefs = null, filterN = 0;
  function blurFilter(sx, sy) {
    if (sx < 0.05 && sy < 0.05) return "none";
    if (!svgDefs) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
      svg.style.position = "absolute";
      svgDefs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.appendChild(svgDefs);
      document.body.appendChild(svg);
    }
    const id = `mb${filterN++}`;
    const fe = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    fe.setAttribute("id", id);
    fe.setAttribute("x", "-50%"); fe.setAttribute("y", "-50%");
    fe.setAttribute("width", "200%"); fe.setAttribute("height", "200%");
    fe.setAttribute("color-interpolation-filters", "sRGB");
    const g = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    g.setAttribute("stdDeviation", `${sx.toFixed(2)} ${sy.toFixed(2)}`);
    fe.appendChild(g);
    svgDefs.appendChild(fe);
    return `url(#${id})`;
  }

  // ---- count-up: { from, to, start, dur, ease, prefix, suffix, pad, decimals } ----
  // measured on the reference (REACH 1,200→48,000): easeInOutCubic, Math.round, en-US grouping
  function textAt(L, f) {
    const c = L.count;
    if (!c) return L.text;
    const p = c.dur > 0 ? Math.min(1, Math.max(0, (f - c.start) / c.dur)) : 1;
    const v = c.from + (c.to - c.from) * ease(c.ease || [0.65, 0, 0.35, 1])(p);
    const d = c.decimals || 0;
    let num = (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    if (c.pad) num = num.padStart(c.pad, "0");
    return (c.prefix || "") + num + (c.suffix || "");
  }

  let scene = null;
  const built = [];

  // ---- shapes (boxes, sparkles) are DOM/SVG: rounded corners, glow and backdrop blur ----
  const boxCache = new WeakMap();
  function boxAt(tab, f) {
    // same original-key rule as valueAt's tables
    let T = boxCache.get(tab);
    if (!T) { T = Object.entries(tab).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]); boxCache.set(tab, T); }
    if (f <= T[0][0]) return T[0][1];
    if (f >= T[T.length - 1][0]) return T[T.length - 1][1];
    for (let i = 0; i < T.length - 1; i++)
      if (f <= T[i + 1][0]) {
        const u = (f - T[i][0]) / (T[i + 1][0] - T[i][0]);
        return T[i][1].map((v, j) => v + (T[i + 1][1][j] - v) * u);
      }
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function makeShape(L) {
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;left:0;top:0;box-sizing:border-box;will-change:transform,opacity,filter";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible";
    el.appendChild(svg);
    document.body.appendChild(el);
    return { el, svg };
  }
  function star(cx, cy, r, pinch) {
    // four-point star: tips at r, waist at r*pinch (concave sides)
    const w = r * pinch;
    return `M${cx},${cy - r} Q${cx + w * 0.25},${cy - w * 0.25} ${cx + r},${cy} Q${cx + w * 0.25},${cy + w * 0.25} ${cx},${cy + r} ` +
      `Q${cx - w * 0.25},${cy + w * 0.25} ${cx - r},${cy} Q${cx - w * 0.25},${cy - w * 0.25} ${cx},${cy - r}Z`;
  }
  function seekShape(L, S, f) {
    const vis = !L.visible || (f >= L.visible[0] && f <= L.visible[1]);
    const tr = L.tracks || {};
    const op = vis ? valueAt(tr.opacity, f, 1) : 0;
    const [x0, y0, x1, y1] = boxAt(L.box, f);
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const el = S.el, st = el.style;
    st.opacity = String(Math.max(0, Math.min(1, op)));
    st.display = op <= 0.001 ? "none" : "block";
    const bs = valueAt(tr.scale, f, 1);
    st.transformOrigin = "50% 50%";
    st.transform = `translate(${x0 + valueAt(tr.tx, f, 0)}px,${y0 + valueAt(tr.ty, f, 0)}px) scale(${bs})`;
    st.width = `${w}px`; st.height = `${h}px`;
    const blur = valueAt(tr.blur, f, 0);
    st.filter = blur > 0.05 ? `blur(${blur}px)` : "none";
    S.svg.setAttribute("width", w); S.svg.setAttribute("height", h);
    if (L.kind === "box") {
      const r = typeof L.radius === "object" ? L.radius.ofHeight * h : (L.radius || 0);
      st.borderRadius = `${r}px`;
      st.background = L.fill || "transparent";
      if (L.image) { st.backgroundImage = `url("${L.image}")`; st.backgroundSize = "100% 100%"; }
      st.overflow = "hidden";
      st.backdropFilter = L.glass ? `blur(${L.glass.blur}px)` : "none";
      const rim = L.rim;
      st.boxShadow = rim ? `0 0 0 ${rim.width}px ${rim.colour}, 0 0 ${rim.glow}px ${rim.colour}` : (L.shadow || "none");
      let html = "";
      if (L.beams) {
        // two glow segments orbiting clockwise along the rim (reference: ~7 px/frame)
        const B = L.beams, per = 2 * (w + h) - (8 - 2 * Math.PI) * r;
        const len = Math.min(B.length, per / 2 - 1), gap = per / 2 - len;
        const off = -(f * B.speed) % per;
        html = `<defs><filter id="bg${L.id}" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="${B.glow}"/></filter></defs>` +
          `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${B.colour}" stroke-width="${B.width}" ` +
          `stroke-dasharray="${len} ${gap}" stroke-dashoffset="${off}" filter="url(#bg${L.id})"/>` +
          `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${B.colour}" stroke-width="${B.width / 2}" ` +
          `stroke-dasharray="${len} ${gap}" stroke-dashoffset="${off}"/>`;
      }
      S.svg.innerHTML = html;
      // tint: a solid colour laid over the card's content (the reference's pink silhouette
      // that dissolves into the card), amount from its own track
      if (L.tint) {
        if (!S.tint) { S.tint = document.createElement("div"); S.tint.style.cssText = "position:absolute;inset:0"; el.insertBefore(S.tint, S.svg); }
        S.tint.style.background = L.tint.colour;
        S.tint.style.opacity = String(Math.max(0, Math.min(1, valueAt(L.tint.track, f, 0))));
      }
    } else if (L.kind === "sparkle") {
      // the pair fills its tracked box: a small star lower-left, a big one right (a pair
      // 1.6 u wide, 1 u tall); `angle` turns it (−90° = big on top, the reference's
      // vertical phase). u comes from the box's long side, less the glow.
      const a = valueAt(tr.angle, f, 0), g = L.glow || 0;
      const cx = w / 2, cy = h / 2;
      const rad = (a * Math.PI) / 180, c = Math.abs(Math.cos(rad)), sn = Math.abs(Math.sin(rad));
      const u = Math.max(1, Math.min((w - 2 * g) / (1.6 * c + sn), (h - 2 * g) / (c + 1.6 * sn)));
      const big = star(cx + 0.3 * u, cy, 0.5 * u, 0.5), small = star(cx - 0.5 * u, cy + 0.15 * u, 0.3 * u, 0.5);
      S.svg.innerHTML = `<defs><filter id="sg${L.id}" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${g / 2}"/></filter></defs>` +
        `<g transform="rotate(${a} ${cx} ${cy})"><path d="${big} ${small}" fill="${L.colour || "#fff"}" filter="url(#sg${L.id})" opacity="0.8"/>` +
        `<path d="${big} ${small}" fill="${L.colour || "#fff"}"/></g>`;
    }
  }

  window.__load = async function (sc) {
    scene = sc;
    document.documentElement.style.cssText = `width:${sc.width}px;height:${sc.height}px;background:transparent`;
    document.body.style.cssText = `margin:0;width:${sc.width}px;height:${sc.height}px;position:relative;overflow:hidden;background:${sc.background || "transparent"}`;
    await document.fonts.ready;
    if (sc.backdrop) {
      const img = document.createElement("img");
      img.style.cssText = `position:absolute;left:0;top:0;width:${sc.width}px;height:${sc.height}px`;
      document.body.appendChild(img);
      built.backdrop = img;
    }
    for (const L of sc.layers) {
      if (L.kind === "box" || L.kind === "sparkle") { built.push({ L, S: makeShape(L) }); continue; }
      if (L.font) await document.fonts.load(`${L.font.weight || (L.typing ? 400 : 700)} ${L.font.size}px "${L.font.family}"`, L.count ? textAt(L, Infinity) : L.text);
      // a count-up anchors on its FINAL text's ink box (left/centre/right per place.align)
      let T = makeText(L, L.count ? textAt(L, Infinity) : L.text);
      if (L.place && L.place.maxWidth && !L.place.group && T.w > L.place.maxWidth) {
        // a line too wide for the frame shrinks to fit (layout rule, not motion: em-based
        // travel shrinks with it, px travel stays)
        L.font = { ...L.font, size: (L.font.size * L.place.maxWidth) / T.w };
        T = makeText(L, L.count ? textAt(L, Infinity) : L.text);
      }
      T.final = { w: T.w, h: T.h };
      document.body.appendChild(T.cv);
      built.push({ L, T });
    }
    // character lines (reference 2 titles animate PER CHARACTER): layers with place.chars
    // = {line, i, x, baseline, align} sit at their glyph's PEN position — the advance of
    // line.slice(0, i), so kerning and spaces are exactly the whole line's — on one baseline
    for (const b of built) {
      const c = b.T && b.L.place && b.L.place.chars;
      if (!c) continue;
      const m = document.createElement("canvas").getContext("2d");
      m.font = b.T.fontCss;
      m.letterSpacing = `${b.T.tracking}px`;
      const full = m.measureText(c.line).width;
      const x0 = c.align === "left" ? c.x : c.align === "right" ? c.x - full : c.x - full / 2;
      const pen = x0 + m.measureText(c.line.slice(0, c.i)).width;
      b.L.place = { ...b.L.place, x: pen + b.T.inkL, y: c.baseline - b.T.asc, align: "left" };
    }
    // word flow: text layers with place.group are laid out side by side (in layer order)
    // by their MEASURED ink widths, gap = place.gap em, the line aligned at place.x
    const groups = {};
    for (const b of built) if (b.T && b.L.place && b.L.place.group) (groups[b.L.place.group] ||= []).push(b);
    for (const g of Object.values(groups)) {
      const gap = (b) => (b.L.place.gap ?? 0.28) * b.L.font.size;
      let total = g.reduce((s, b, i) => s + b.T.final.w + (i ? gap(b) : 0), 0);
      const p0 = g[0].L.place;
      if (p0.maxWidth && total > p0.maxWidth) {
        const k = p0.maxWidth / total;
        for (const b of g) {
          b.L.font = { ...b.L.font, size: b.L.font.size * k };
          b.T = makeText(b.L, b.L.text);
          b.T.final = { w: b.T.w, h: b.T.h };
          document.body.appendChild(b.T.cv);
        }
        total = g.reduce((s, b, i) => s + b.T.final.w + (i ? gap(b) : 0), 0);
      }
      let x = p0.align === "centre" ? p0.x - total / 2 : p0.align === "right" ? p0.x - total : p0.x;
      for (const b of g) {
        b.L.place = { ...b.L.place, x, align: "left" };
        x += b.T.final.w + gap(b);
      }
    }
    return true;
  };

  window.__seek = async function (f) {
    if (svgDefs) svgDefs.textContent = "";
    filterN = 0;
    if (built.backdrop) {
      const img = built.backdrop;
      img.src = scene.backdrop.replace(/%0(\d)d/, (_, n) => String(Math.round(f)).padStart(Number(n), "0"));
      await img.decode();
    }
    for (const B of built) {
      const L = B.L;
      if (B.S) { seekShape(L, B.S, f); continue; }
      if (L.count) {
        const t = textAt(L, f);
        if (t !== B.T.text) { const fin = B.T.final; B.T = makeText(L, t); B.T.final = fin; }
      }
      const T = B.T;
      const vis = !L.visible || (f >= L.visible[0] && f <= L.visible[1]);
      const em = L.font.size;
      const unit = (tr) => (tr && tr.unit === "em" ? em : 1);
      const tr = L.tracks || {};
      const op = vis ? valueAt(tr.opacity, f, 1) : 0;
      const tx = valueAt(tr.tx, f, 0) * unit(tr.tx);
      const ty = valueAt(tr.ty, f, 0) * unit(tr.ty);
      const sc = valueAt(tr.scale, f, 1);
      let bx = valueAt(tr.blurX, f, 0) * unit(tr.blurX);
      let by = valueAt(tr.blurY, f, 0) * unit(tr.blurY);
      if (L.motionBlur) {
        // 360° shutter: the exposure spans the whole previous frame interval; a box of
        // travel d has σ = d/√12 (measured on the reference: σy ≈ Δy/√12)
        // one OUTPUT frame interval, in reference frames (0.8 at 30 fps output)
        const s = ((L.motionBlur.shutter || 360) / 360) * (scene.fps / (scene.outFps || scene.fps));
        const px = valueAt(tr.tx, f - s, 0) * unit(tr.tx), py = valueAt(tr.ty, f - s, 0) * unit(tr.ty);
        bx = Math.hypot(bx, Math.abs(tx - px) / Math.sqrt(12));
        by = Math.hypot(by, Math.abs(ty - py) / Math.sqrt(12));
      }
      paintText(L, T, f);
      // place: the ink box (inside the padded canvas) onto a quad or a point
      const W = T.w, H = T.h, P = T.pad;
      let base;
      if (L.place.quad) {
        const q = L.place.quad;
        // extend the ink->quad homography to the padded canvas by mapping the padded rect
        const m = rectToQuadPadded(W, H, P, q);
        base = m;
      } else {
        const al = L.place.align || "left";
        const x = al === "centre" ? L.place.x - W / 2 : al === "right" ? L.place.x - W : L.place.x;
        base = `translate(${x - P}px,${L.place.y - P}px)`;
      }
      // scale about the ink centre, motion in screen space
      const cx = P + W / 2, cy = P + H / 2;
      T.cv.style.transform = `translate(${tx}px,${ty}px) ${base} translate(${cx}px,${cy}px) scale(${sc}) translate(${-cx}px,${-cy}px)`;
      T.cv.style.opacity = String(Math.max(0, Math.min(1, op)));
      T.cv.style.filter = blurFilter(bx, by);
    }
    return true;
  };

  // homography for the padded canvas: map the ink rect corners to the quad, then
  // express it in padded-canvas coordinates (ink rect sits at (P,P))
  function rectToQuadPadded(W, H, P, q) {
    const src = [[P, P], [P + W, P], [P + W, P + H], [P, P + H]];
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = q[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const [a, bb, c, d, e, f, g, hh] = solve(A, b);
    return `matrix3d(${a},${d},0,${g},${bb},${e},0,${hh},0,0,1,0,${c},${f},0,1)`;
  }
  window.__rectToQuad = rectToQuad;
  window.__textAt = textAt; // tests
  // ink boxes (px) of every layer at its final text — used to size fonts to a measured box
  window.__inks = () => built.filter((b) => b.T).map(({ L, T }) => ({ id: L.id, w: T.final ? T.final.w : T.w, h: T.final ? T.final.h : T.h }));
})();
