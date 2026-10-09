/*
 * Motion TEMPLATES runtime (2026-10-09) — the DOM-built motion-design templates Jake added from his
 * four reference clips (/opt/aieditor-work/reference/motion-2026-10-09/): verb_swap, tagline_build,
 * prompt_menu, prompt_card_3d (+ the hook PROMPT → RESULT sequence, MO05, which is prompt_card_3d with a
 * real result from the app's UI kit).
 *
 * Deterministic like engine.js: nothing runs on a clock; render.mjs calls window.__seek(frame) for
 * every output frame and screenshots it with a transparent page background.
 *
 * A template scene (built by aieditor/motiontemplates.py):
 *   { template: "<id>", width: 1920, height: 1080, scale, fps, first: 0, last: N-1,
 *     params: {...},            // the template's content + options (validated in Python against rules.json)
 *     beats: {name: seconds},   // narration-anchored moments, seconds from the clip's first frame
 *     duration: seconds,
 *     kf: {...},                // the MEASURED motion (keyframes.json "templates.<id>"; design-free)
 *     style: {...},             // the swappable look (motion/templates/<id>.style.json)
 *     kit: {...} | null }       // the app's UI kit (ui-kits/<app>/kit.json, inlined) or null = neutral box
 *
 * A template file registers   window.__TEMPLATES["<id>"] = { build(root, scene) -> state,
 *                                                            seek(state, t /* seconds *\/, scene) }
 * Units inside templates: seconds and px at 1920×1080 (the page is laid out at 1920×1080 and rendered at
 * scene.scale for 4K etc.).
 */
(function () {
  "use strict";

  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0, hi = 1, t = x;
      for (let i = 0; i < 50; i++) {
        const v = sx(t);
        if (Math.abs(v - x) < 1e-7) break;
        if (v < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return sy(t);
    };
  }
  const cache = new Map();
  function ease(e) {
    if (!e || e === "linear") return (x) => Math.min(1, Math.max(0, x));
    const k = e.join(",");
    if (!cache.has(k)) cache.set(k, bezier(...e));
    return cache.get(k);
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  // progress of a tween that starts at `start` (s) and lasts `dur` (s), eased
  function prog(t, start, dur, e) {
    if (dur <= 0) return t >= start ? 1 : 0;
    return ease(e)(clamp((t - start) / dur, 0, 1));
  }
  // value of a segment list [{start, dur, from, to, ease}] at t (held between / after segments)
  function track(t, segs, fallback) {
    if (!segs || !segs.length) return fallback;
    let v = segs[0].from;
    for (const s of segs) {
      if (t < s.start) break;
      v = lerp(s.from, s.to, prog(t, s.start, s.dur, s.ease));
    }
    return v;
  }
  // a {t: value} table, linear between keys, held outside
  function table(t, tab) {
    const T = tab._s || (tab._s = Object.entries(tab).filter(([k]) => k !== "_s").map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]));
    if (t <= T[0][0]) return T[0][1];
    if (t >= T[T.length - 1][0]) return T[T.length - 1][1];
    for (let i = 0; i < T.length - 1; i++) {
      if (t <= T[i + 1][0]) return lerp(T[i][1], T[i + 1][1], (t - T[i][0]) / (T[i + 1][0] - T[i][0]));
    }
    return T[T.length - 1][1];
  }
  function el(tag, css, parent, html) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }
  function addCss(text) {
    const s = document.createElement("style");
    s.textContent = text;
    document.head.appendChild(s);
    return s;
  }
  // {{key}} substitution for kit html (values are escaped unless the key ends with "_html")
  function fill(tpl, vals) {
    return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
      const v = vals[k] == null ? "" : String(vals[k]);
      return k.endsWith("_html") ? v : v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    });
  }
  function measure(text, font) {
    const c = measure._c || (measure._c = document.createElement("canvas").getContext("2d"));
    c.font = font;
    return c.measureText(text);
  }

  window.__TR = { ease, bezier, clamp, lerp, prog, track, table, el, addCss, fill, measure };
  window.__TEMPLATES = window.__TEMPLATES || {};
  window.__loadTemplate = function (scene) {
    document.body.style.cssText = "margin:0;background:transparent;overflow:hidden";
    const root = el("div", `position:absolute;left:0;top:0;width:${scene.width}px;height:${scene.height}px;overflow:hidden`, document.body);
    const T = window.__TEMPLATES[scene.template];
    if (!T) throw new Error(`unknown motion template ${scene.template}`);
    const state = T.build(root, scene);
    window.__seek = function (frame) {
      T.seek(state, frame / scene.fps, scene);
    };
    window.__seek(scene.first || 0);
  };
})();
