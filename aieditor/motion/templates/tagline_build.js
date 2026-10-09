/*
 * tagline_build (MO02) — a short tagline builds word by word ("Every agent. One inbox.") while blue dots fly in
 * from scattered points along Manhattan legs and merge into the 4 corner handles of a selection box around it;
 * 7 frames after the last word the grid cuts away and the text + box push in; on "out" a dark dock rail fades in at
 * the right frame edge and the 4 handles accelerate into its tab, each landing as a spinner ring; hard cut.
 * Reference: /opt/aieditor-work/reference/motion-2026-10-09/motion2.mp4 (spec: reference-specs/tagline_build.md).
 *
 * Motion = scene.kf (tagline_build.kf.json, measured), look = scene.style (tagline_build.style.json).
 * params: words (string or [string], 2-8 words, one line), backdrop true, dots true, wipe true
 * beats:  word_0 .. word_{n-1} (each word pops on its spoken word), out (rail fades in, handles fly into it)
 */
(function () {
  "use strict";
  const TR = window.__TR;
  const CORNERS = ["TL", "TR", "BL", "BR"];

  // [t, a, b, c...] rows, linear between rows, held outside
  function rowsAt(rows, t) {
    if (t <= rows[0][0]) return rows[0].slice(1);
    const last = rows[rows.length - 1];
    if (t >= last[0]) return last.slice(1);
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i], b = rows[i + 1];
      if (t <= b[0]) {
        const p = (t - a[0]) / (b[0] - a[0]);
        return a.slice(1).map((v, k) => TR.lerp(v, b[k + 1], p));
      }
    }
    return last.slice(1);
  }

  function normParams(scene) {
    const p = Object.assign({ backdrop: true, dots: true, wipe: true }, scene.params || {});
    let w = p.words == null ? "Every agent. One inbox." : p.words;
    if (Array.isArray(w)) w = w.join(" ");
    p.words = String(w).trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!p.words.length) p.words = ["Every", "agent.", "One", "inbox."];
    return p;
  }

  // when everything happens (seconds from the clip's first frame)
  function timeline(scene, n) {
    const K = scene.kf, b = scene.beats || {};
    const st = K.words.stagger_s;
    const tw = [];
    for (let i = 0; i < n; i++) {
      const v = b["word_" + i];
      if (v != null && isFinite(v)) tw.push(Math.max(i ? tw[i - 1] : 0, Number(v)));
      else tw.push(i ? tw[i - 1] + (st[(i - 1) % st.length] != null ? st[(i - 1) % st.length] : K.words.default_stagger_s) : 0);
    }
    const push = Math.max(tw[n - 1] + K.push.after_last_word_s, tw[0] + K.push.min_after_word0_s);
    let out = b.out != null && isFinite(b.out) ? Math.max(Number(b.out), push) : push + K.out.default_after_push_s;
    let end = out + K.out.cut_after_out_s;
    if (scene.duration != null && isFinite(scene.duration)) {
      end = Number(scene.duration);
      if (b.out == null) out = Math.max(push, end - K.out.cut_after_out_s);
    }
    return { tw, push, out, end };
  }

  function scaleAt(K, tp) {
    if (tp <= 0) return 1;
    const tab = K.push.measured_scale_per_frame, fps = 60;
    const f = tp * fps;
    let s;
    if (f < tab.length - 1) {
      const i = Math.floor(f);
      s = TR.lerp(tab[i], tab[i + 1], f - i);
    } else {
      s = tab[tab.length - 1] + K.push.k_per_s * (tp - (tab.length - 1) / fps);
    }
    return Math.min(K.push.max_scale, s);
  }

  function layout(state) {
    const { scene, S, p } = state;
    const fam = S.font_family, wt = S.font_weight;
    const probe = (F) => `${wt} ${F}px ${fam}`;
    const capRatio = TR.measure("H", probe(100)).actualBoundingBoxAscent / 100;
    let F = S.cap_h_px / capRatio;
    const ls = S.letter_spacing_em;
    const c = document.createElement("canvas").getContext("2d");
    const measureAt = (F) => {
      c.font = probe(F);
      c.letterSpacing = `${ls * F}px`;
      const text = p.words.join(" ");
      const m = c.measureText(text);
      return { m, F };
    };
    let { m } = measureAt(F);
    let inkW = m.actualBoundingBoxRight + m.actualBoundingBoxLeft;
    const maxW = Math.min(S.max_ink_w_px, S.max_ink_w_frac_w * scene.width);
    if (inkW > maxW) {
      F *= maxW / inkW;
      ({ m } = measureAt(F));
      inkW = m.actualBoundingBoxRight + m.actualBoundingBoxLeft;
    }
    const capH = capRatio * F;
    const cx = scene.width / 2 + S.ink_center_dx_px, cy = scene.height / 2 + S.ink_center_dy_px;
    const originX = cx - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    const baseY = cy + capH / 2;
    const fa = m.fontBoundingBoxAscent, fd = m.fontBoundingBoxDescent;
    const lineH = Math.ceil(fa + fd) + 4;
    const topY = baseY - ((lineH - (fa + fd)) / 2 + fa);
    // word spans
    state.group.innerHTML = "";
    state.wordEls = [];
    let prefix = "";
    p.words.forEach((w, i) => {
      if (i) prefix += " ";
      const x = originX + (prefix ? c.measureText(prefix).width : 0);
      const wm = c.measureText(w);
      const ox = (wm.actualBoundingBoxRight - wm.actualBoundingBoxLeft) / 2; // ink centre, from the span origin
      const oy = baseY - capH / 2 - topY;
      const e = TR.el("span", `position:absolute;left:${x}px;top:${topY}px;height:${lineH}px;line-height:${lineH}px;` +
        `white-space:pre;font:${wt} ${F}px ${fam};letter-spacing:${ls * F}px;color:${S.text_color};` +
        `transform-origin:${ox}px ${oy}px;visibility:hidden;font-kerning:normal`, state.group, "");
      e.textContent = w;
      state.wordEls.push(e);
      prefix += w;
    });
    const U = capH;
    const inkL = originX - m.actualBoundingBoxLeft, inkR = originX + m.actualBoundingBoxRight;
    const R = scene.kf.rect;
    state.geo = {
      U, cx, cy, capH, F,
      rect: {
        TL: [inkL - R.pad_left_U * U, baseY - capH - R.pad_top_U * U],
        TR: [inkR + R.pad_right_U * U, baseY - capH - R.pad_top_U * U],
        BL: [inkL - R.pad_left_U * U, baseY + R.pad_bottom_U * U],
        BR: [inkR + R.pad_right_U * U, baseY + R.pad_bottom_U * U],
      },
    };
    state.group.style.transformOrigin = `${cx}px ${cy}px`;
    state.fontOk = document.fonts ? document.fonts.check(probe(F)) : true;
  }

  function build(root, scene) {
    const S = scene.style, K = scene.kf;
    const p = normParams(scene);
    const state = { scene, S, K, p, root };
    state.tl = timeline(scene, p.words.length);
    root.style.overflow = "hidden";
    if (p.backdrop) {
      const B = S.backdrop;
      state.bg = TR.el("div", `position:absolute;inset:0;background:${B.radial},${B.base}`, root);
      const g = B.grid, o = g.offset_px;
      state.grid = TR.el("div", `position:absolute;left:${o}px;top:${o}px;width:${scene.width - o}px;height:${scene.height - o}px;` +
        `background-image:linear-gradient(to right, ${g.color} 0 ${g.line_px}px, transparent ${g.line_px}px),` +
        `linear-gradient(to bottom, ${g.color} 0 ${g.line_px}px, transparent ${g.line_px}px);` +
        `background-size:${g.pitch_px}px ${g.pitch_px}px`, root);
    }
    state.group = TR.el("div", "position:absolute;left:0;top:0;width:100%;height:100%", root);
    // rail + tab + rings
    if (p.wipe) {
      const Rl = S.rail, T = Rl.tab, W = scene.width, H = scene.height;
      const rx = Rl.x_px, tx = rx - T.w_px, ty = T.cy_px - T.h_px / 2, by = T.cy_px + T.h_px / 2, r = T.radius_px, f = T.fillet_px;
      const d = `M${W} 0 H${rx} V${ty - f} Q${rx} ${ty} ${rx - f} ${ty} H${tx + r} Q${tx} ${ty} ${tx} ${ty + r} V${by - r} ` +
        `Q${tx} ${by} ${tx + r} ${by} H${rx - f} Q${rx} ${by} ${rx} ${by + f} V${H} H${W} Z`;
      state.rail = TR.el("div", `position:absolute;inset:0;opacity:0`, root,
        `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="position:absolute;left:0;top:0">` +
        `<g class="tab" style="transform-origin:${rx}px ${T.cy_px}px"><path d="${d}" fill="${Rl.color}"/></g>` +
        `<rect x="${rx}" y="0" width="1" height="${H}" fill="${Rl.seam}"/></svg>`);
      state.tab = state.rail.querySelector(".tab");
      const G = S.ring, circ = Math.PI * (G.d_px - G.stroke_px);
      state.rings = [0, 1, 2, 3].map((i) => {
        const cyR = T.cy_px + (i - 1.5) * G.pitch_px, rr = (G.d_px - G.stroke_px) / 2;
        const e = TR.el("div", `position:absolute;left:${G.x_px - G.d_px / 2}px;top:${cyR - G.d_px / 2}px;width:${G.d_px}px;height:${G.d_px}px;visibility:hidden`, root,
          `<svg width="${G.d_px}" height="${G.d_px}" viewBox="0 0 ${G.d_px} ${G.d_px}"><circle cx="${G.d_px / 2}" cy="${G.d_px / 2}" r="${rr}" fill="none" ` +
          `stroke="${G.color}" stroke-width="${G.stroke_px}" stroke-linecap="round" stroke-dasharray="${(circ * G.arc_deg) / 360} ${circ}" ` +
          `transform="rotate(${200 - G.arc_deg / 2} ${G.d_px / 2} ${G.d_px / 2})"/></svg>`);
        return e;
      });
    }
    if (p.dots) {
      const dot = (cls) => TR.el("div", `position:absolute;left:0;top:0;border-radius:50%;background:${S.dot_color};visibility:hidden;will-change:transform`, root);
      state.feeders = K.dots.feeders.map((fd) => ({ fd, e: dot() }));
      state.handles = {};
      CORNERS.forEach((c) => (state.handles[c] = dot()));
    }
    // fonts load asynchronously: kick the load (document.fonts.ready waits for it); seek re-lays out once it lands
    try { document.fonts.load(`${S.font_weight} 100px ${S.font_family}`); } catch (e) { /* ignore */ }
    layout(state);
    return state;
  }

  // handle centre/diameter at t (before any exit flight)
  function handleHome(state, c, t) {
    const { K, geo, tl } = state, U = geo.U, H = K.handles[c];
    const [hx, hy] = geo.rect[c];
    if (t < tl.push) {
      const [dx, dy, d] = rowsAt(H.gather, t - tl.tw[0]);
      return [hx + dx * U, hy + dy * U, d * U];
    }
    const tp = t - tl.push, s = scaleAt(K, tp);
    const [dx, dy] = rowsAt(H.push, tp);
    return [geo.cx + s * (hx - geo.cx) + dx * U, geo.cy + s * (hy - geo.cy) + dy * U, K.dots.handle_d_end_U * U];
  }

  function place(e, x, y, d) {
    e.style.visibility = "visible";
    e.style.width = e.style.height = `${d}px`;
    e.style.transform = `translate(${x - d / 2}px, ${y - d / 2}px)`;
  }

  function seek(state, t, scene) {
    const { K, S, p, tl } = state;
    if (!state.fontOk && document.fonts && document.fonts.check(`${S.font_weight} 100px ${S.font_family}`)) layout(state);
    const geo = state.geo, U = geo.U;
    const live = t >= tl.tw[0] - 1e-6 && t < tl.end - 1e-4;
    state.root.style.visibility = live ? "visible" : "hidden";
    if (!live) return;
    if (state.grid) state.grid.style.visibility = t < tl.push ? "visible" : "hidden";
    // words
    const W = K.words;
    state.wordEls.forEach((e, i) => {
      if (t < tl.tw[i] - 1e-6) { e.style.visibility = "hidden"; return; }
      const s = TR.lerp(W.scale_from, 1, TR.prog(t, tl.tw[i], W.dur_s, W.ease));
      e.style.visibility = "visible";
      e.style.transform = `scale(${s})`;
    });
    const s = scaleAt(K, t - tl.push);
    state.group.style.transform = `scale(${s})`;
    // rail
    const O = K.out;
    if (state.rail) {
      const a = TR.prog(t, tl.out, O.rail_fade.dur_s, O.rail_fade.ease);
      state.rail.style.opacity = a;
      state.tab.style.transform = `scale(${TR.lerp(O.rail_fade.tab_scale_from, 1, a)})`;
    }
    // feeders
    if (state.feeders) {
      const tg = t - tl.tw[0];
      state.feeders.forEach(({ fd, e }) => {
        if (tg >= fd.merge_s) { e.style.visibility = "hidden"; return; }
        const [dx, dy] = rowsAt(fd.table, tg);
        const [hx, hy] = geo.rect[fd.corner];
        place(e, hx + dx * U, hy + dy * U, K.dots.feeder_d_U * U);
      });
    }
    // handles (+ exit flights into the rail's ring slots)
    CORNERS.forEach((c) => {
      const X = K.handles[c].exit;
      const launch = tl.out + X.launch_after_out_s, land = launch + X.dur_s;
      const ring = state.rings ? state.rings[X.slot] : null;
      if (ring) {
        if (t >= land - 1e-6) {
          const g = TR.prog(t, land, O.ring.grow_s, O.ring.ease);
          ring.style.visibility = "visible";
          ring.style.transform = `rotate(${TR.lerp(O.ring.rot_from_deg, 0, g)}deg) scale(${TR.lerp(O.ring.scale_from, 1, g)})`;
        } else ring.style.visibility = "hidden";
      }
      if (!state.handles) return;
      const e = state.handles[c];
      if (!p.wipe || t < launch) { const [x, y, d] = handleHome(state, c, t); place(e, x, y, d); return; }
      if (t >= land - 1e-6) { e.style.visibility = "hidden"; return; }
      const [x0, y0] = handleHome(state, c, launch);
      const G = S.ring, slotX = G.x_px, slotY = S.rail.tab.cy_px + (X.slot - 1.5) * G.pitch_px;
      const q = (t - launch) / X.dur_s;
      let px, py;
      if (X.progress_table) [px, py] = rowsAt(X.progress_table, q);
      else { px = TR.ease(X.ease_x)(q); py = TR.ease(X.ease_y)(q); }
      const d = TR.table(px, Object.fromEntries(O.flight_size_U_by_xprogress.map(([k, v]) => [k, v]))) * U;
      place(e, TR.lerp(x0, slotX, px), TR.lerp(y0, slotY, py), d);
    });
  }

  window.__TEMPLATES = window.__TEMPLATES || {};
  window.__TEMPLATES["tagline_build"] = { build, seek };
})();
