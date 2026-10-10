/*
 * prompt_card_3d (MO04) + its RESULT stage (MO05 prompt → result, hook only) — from Jake's reference
 * /opt/aieditor-work/reference/motion-2026-10-09/motion4.mp4 (1920×1080, 30 fps, 7.72 s).
 *
 * A frosted prompt card on a soft grey plate, seen by a 3D camera: it whips in from a close tilted view, the
 * prompt types in, file chips fly in from beside the camera as icon tiles, the card grows a row at a time while the
 * camera keeps it centred (push-in, then pull-back), the tiles open into named pills, the prompt is sent (it moves
 * into a right-aligned bubble, "Working" + spinner), and the camera pushes through the card at the cut.
 * MO05 adds a "result" beat: the camera pans up / pulls back (measured entrance easing + a tilt bump) to the app's
 * REAL result (params.result — never invented; no result → no result stage).
 *
 * Motion = scene.kf (prompt_card_3d.kf.json, measured), look = scene.style (prompt_card_3d.style.json) or scene.kit
 * (a real app's UI kit: its composer at natural size, scaled to the reference card width; null = the neutral box,
 * which is itself written in the kit format, so there is ONE code path).
 *
 * Units: seconds; plane px at the resting scale (the card is 1034 px wide at s = 1, frame f60 of the reference).
 */
(function () {
  "use strict";
  const TR = window.__TR;
  const clamp = TR.clamp, lerp = TR.lerp;

  function normParams(scene) {
    const P = scene.params || {};
    const prompt = String(P.prompt || "").slice(0, 400);
    const chips = (Array.isArray(P.chips) ? P.chips : []).slice(0, 6).map((c) => {
      if (typeof c === "string") c = { name: c };
      const name = String(c.name || "file");
      let kind = String(c.kind || "").toLowerCase();
      if (!kind) {
        const ext = (name.split(".").pop() || "").toLowerCase();
        kind = /^(doc|docx|txt|md|rtf)$/.test(ext) ? "doc" : ext === "pdf" ? "pdf" : /^(xls|xlsx|csv)$/.test(ext) ? "xlsx" : /^(png|jpe?g|gif|webp|heic)$/.test(ext) ? "image" : "other";
      }
      if (!/^(doc|pdf|xlsx|image|other)$/.test(kind)) kind = "other";
      return { name, kind };
    });
    const r = P.result && typeof P.result === "object" ? P.result : null;
    const result = r && ((r.kind === "image" && r.src) || (r.kind === "text" && r.text)) ? r : null;
    return {
      prompt, chips, result,
      state_label: P.state_label != null ? String(P.state_label) : null,
      placeholder: P.placeholder != null ? String(P.placeholder) : null,
      backdrop: P.backdrop !== false,
      // params.tilt: {rx, ry, rz} degrees, clamped to ±10° per axis (templates/prompt_card_3d.md §7)
      tilt: P.tilt && typeof P.tilt === "object"
        ? Object.fromEntries(Object.entries(P.tilt).filter(([k, v]) => ["rx", "ry", "rz"].includes(k) && isFinite(v))
          .map(([k, v]) => [k, Math.max(-10, Math.min(10, Number(v)))]))
        : null,
      greeting: P.greeting != null ? String(P.greeting).slice(0, 40) : null,
    };
  }

  // ───────────────────────── the UI: kit adapter (neutral box = the style's own kit) ─────────────────────────
  function adapter(scene) {
    const S = scene.style;
    const kit = scene.kit && scene.kit.composer ? scene.kit : null;
    const K = kit || S.neutral;
    const app = String((kit && kit.app) || "neutral").replace(/[^a-z0-9_-]/gi, "");
    const cls = "kit-" + app;
    const scope = (css) => String(css || "").replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) =>
      `${a} ${sel.split(",").map((s) => (s.trim().startsWith(":root") ? `.${cls}` : `.${cls} ${s.trim()}`)).join(",")}{`);
    const KC = K.composer;
    const dark = kit ? String(kit.theme || "").toLowerCase() === "dark" : false;
    // parts a kit may lack → the neutral (generic, unbranded) part, re-coloured for a dark theme
    const N = S.neutral;
    const user = kit && kit.result && kit.result.user ? kit.result.user : null;
    const working = kit && kit.working ? kit.working : null;
    let css = scope(KC.css) + "\n" + (K.chip ? scope(K.chip.css) : "") + "\n" + (working ? scope(working.css) : "") + "\n" + (user ? scope(user.css) : "");
    if (!kit || !kit.chip) css += "\n" + scope(N.chip.css);
    if (!working || !user || !kit) css += "\n" + scope(N.working.css);
    if (kit && (!working || !user)) {
      css += `\n.${cls} .nb-thread{font-family:Inter,sans-serif}`;
      css += `\n.${cls} .nb-bubble{background:rgba(255,255,255,.08);color:inherit}\n.${cls} .nb-working{color:${dark ? "rgba(255,255,255,.55)" : "#7a777a"}}\n.${cls} .nb-spin svg{fill:currentColor}`;
    }
    const res = (kit && kit.result) || N.result;
    for (const k of ["image", "text"]) if (res[k] && res[k].css) css += "\n" + scope(res[k].css);
    css += `\n.${cls} .pc-caret{display:inline-block;width:2px;height:1.1em;margin-left:1px;vertical-align:-0.18em;background:currentColor}`;
    TR.addCss(css);
    const tokens = (kit && kit.tokens) || {};
    const tokenCss = Object.entries(tokens).filter(([k, v]) => k.startsWith("--") && typeof v === "string").map(([k, v]) => `${k}:${v}`).join(";");
    const num = (v, d) => (v == null || v === "" || isNaN(Number(v)) ? d : Number(v));
    let caretHtml = KC.caret_html || "";
    if (!caretHtml && KC.fill && typeof KC.fill.caret_html === "string") {
      const m = KC.fill.caret_html.match(/<span class=\\?"([^"\\]+)\\?"><\/span>/);
      if (m) caretHtml = `<span class="${m[1]}"></span>`;
    }
    if (!caretHtml) caretHtml = '<span class="pc-caret"></span>';
    const chipIcon = (kind) => (N.chip.icons[kind] || N.chip.icons.other);
    const chipKind = (kind) => (kit && kit.chip ? (kind === "image" ? "file" : "file") : kind); // no real thumbnails → file tiles
    const page = kit ? (kit.bg || tokens[Object.keys(tokens).find((k) => /-page$/.test(k))] || null) : null;
    return {
      kit, cls, KC, dark, tokenCss, page,
      W: num(KC.width, S.card.w),
      model: (KC.model || (kit && kit.model_label) || (kit ? "" : N.model)),
      placeholder: KC.placeholder || "",
      caretHtml,
      chipHtml(c) {
        const ch = (kit && kit.chip) || N.chip;
        return TR.fill(ch.html, { name: c.name, kind: chipKind(c.kind), icon_html: chipIcon(c.kind), thumb_html: "" });
      },
      workingHtml(text) {
        if (working) return TR.fill(working.html, { text });
        return TR.fill(N.working.html, { text });
      },
      bubbleHtml(text) {
        if (user) return TR.fill(user.html, { text, user_actions_html: "" });
        return TR.fill(N.bubble.html, { text });
      },
      stateHtml(text, label) {
        if (user && working) return `<div class="pc-thread">${this.bubbleHtml(text)}<div class="pc-wk" style="margin-top:12px">${this.workingHtml(label)}</div></div>`;
        return `<div class="nb-thread pc-thread">${this.bubbleHtml(text)}<div class="pc-wk">${this.workingHtml(label)}</div></div>`;
      },
      resultHtml(r, prompt) {
        const R = res[r.kind];
        if (!R) return "";
        const vals = { src: r.src || "", alt: r.alt || "", text_html: String(r.text || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])),
          actions_html: R.actions_html || "", text: r.text || "" };
        const head = kit && user ? TR.fill(user.html, { text: prompt, user_actions_html: user.user_actions_html || "" }) : "";
        return `<div class="pc-res-head" style="margin-bottom:${kit ? 18 : 0}px">${head}</div>` + TR.fill(R.html, vals);
      },
      workingText(p) {
        if (p.state_label) return p.state_label;
        if (working && working.texts) return (p.result && p.result.kind === "image" ? working.texts.image : working.texts.thinking) || "Working";
        return "Working";
      },
      layoutClass(nChips, prompt) {
        if (!kit) return nChips ? "has-chips" : "";
        const over = num(KC.multiline_over_px, 0);
        if (nChips || (over && TR.measure(prompt, `16px Inter`).width > over)) return "is-multiline";
        return "";
      },
    };
  }

  // offset of el inside anc in anc's natural (unscaled) px
  function offsetIn(el, anc) {
    const ar = anc.getBoundingClientRect(), er = el.getBoundingClientRect();
    const f = (anc.offsetWidth || ar.width) / (ar.width || 1);
    return { x: (er.left - ar.left) * f, y: (er.top - ar.top) * f, w: er.width * f, h: er.height * f };
  }

  function build(root, scene) {
    const p = normParams(scene);
    const S = scene.style, K = scene.kf, C = K.camera;
    const A = adapter(scene);
    // a kit without the app's real result view → no result stage (never another app's or a made-up result UI)
    if (p.result && A.kit && !(A.kit.result && A.kit.result[p.result.kind])) p.result = null;
    const k = S.card.w / A.W; // kit natural px → plane px
    // ── backdrop (screen space; the reference's plate does not move)
    if (p.backdrop) {
      if (A.kit) {
        TR.el("div", `position:absolute;inset:0;background:${A.page || "#000"}`, root);
        TR.el("div", `position:absolute;inset:0;background:url(${S.backdrop.plate}) center/100% 100% no-repeat;opacity:${S.backdrop.kit_mix.opacity};mix-blend-mode:${S.backdrop.kit_mix.blend}`, root);
      } else {
        TR.el("div", `position:absolute;inset:0;background:${S.backdrop.color} url(${S.backdrop.plate}) center/100% 100% no-repeat`, root);
      }
    }
    const exitWrap = TR.el("div", "position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:960px 540px", root);
    const stage = TR.el("div", `position:absolute;left:0;top:0;width:1920px;height:1080px;perspective:${C.perspective_px}px;perspective-origin:960px 540px`, exitWrap);
    const plane = TR.el("div", `position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:${C.origin[0]}px ${C.origin[1]}px`, stage);

    const cardW = S.card.w, cardLeft = C.origin[0] - cardW / 2;
    const prompt = p.prompt;
    const placeholder = p.placeholder != null ? p.placeholder : A.placeholder;
    const label = A.workingText(p);
    const kitChips = !!(A.kit && A.kit.chip);           // the kit draws its own attachments inside its composer
    const neutralChips = !kitChips;                      // else: the reference's own chip grid (above the text)
    const chipsHtml = p.chips.map((c, i) => `<span data-pc-chip="${i}" style="display:contents">${A.chipHtml(c)}</span>`).join("");
    const extraGrid = A.kit && !kitChips && p.chips.length
      ? `<div class="nb-chips pc-xchips" style="zoom:${1 / k};padding:25px 36px 0 44px;margin:0">${chipsHtml}</div>` : "";
    const vals = (over) => Object.assign({ prompt: "", placeholder, chips_html: A.kit ? (kitChips ? chipsHtml : "") : chipsHtml, caret_html: "", state_html: "",
      layout_class: A.layoutClass(!A.kit || kitChips ? p.chips.length : 0, prompt), model: A.model, model_label: A.model }, over);

    // card background (shadow + fill + rim); kits: the composer's own fill/radius moved here
    const bg = TR.el("div", "position:absolute;box-sizing:border-box", plane);
    const rim = A.kit ? null : TR.el("div", "position:absolute;inset:0;box-sizing:border-box;pointer-events:none", bg);

    function instance(v, extra) {
      const wrap = TR.el("div", `position:absolute;left:${cardLeft}px;top:0;width:${cardW}px`, plane);
      const inner = TR.el("div", `position:absolute;left:0;top:0;width:${A.W}px;transform:scale(${k});transform-origin:0 0;${A.tokenCss}`, wrap);
      inner.className = A.cls;
      inner.innerHTML = `<div class="pc-root">${extra || ""}${TR.fill(A.KC.html, v)}</div>`;
      const rootEl = inner.firstElementChild;
      return { wrap, inner, rootEl, comp: rootEl.lastElementChild };
    }
    const IT = instance(vals({ prompt: prompt }), extraGrid);
    // neutral: the sent prompt becomes a bubble INSIDE the card (the reference); kits: a thread ABOVE the composer
    // (the app's own layout after send), the composer empties
    const IW = A.kit ? null : instance(vals({ prompt: "", placeholder: "", state_html: A.stateHtml(prompt, label) }));
    let thread = null;
    if (A.kit) {
      thread = TR.el("div", `position:absolute;left:${cardLeft}px;top:0;width:${cardW}px`, plane);
      const tin = TR.el("div", `position:relative;width:${A.W}px;transform:scale(${k});transform-origin:0 0;${A.tokenCss}`, thread);
      tin.className = A.cls;
      tin.innerHTML = A.stateHtml(prompt, label);
      thread._in = tin;
    }

    // kit fill/radius → bg
    const cs = getComputedStyle(IT.comp);
    let radius = S.card.radius, fill = S.card.fill;
    if (A.kit) {
      radius = (parseFloat(cs.borderTopLeftRadius) || 24) * k;
      fill = cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? cs.backgroundColor : (A.page || "#222");
      const kitShadow = cs.boxShadow && cs.boxShadow !== "none" ? cs.boxShadow.replace(/(-?\d+(\.\d+)?)px/g, (m, n) => `${Number(n) * k}px`) : "";
      bg.style.cssText += `;background:${fill};border-radius:${radius}px;box-shadow:${S.card.shadow}${kitShadow ? "," + kitShadow : ""}`;
      IT.comp.style.background = "transparent"; IT.comp.style.boxShadow = "none"; IT.comp.style.borderColor = "transparent";
      if (A.dark) TR.addCss(`.${A.cls} .nb-chip{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16);box-shadow:none}.${A.cls} .nb-chip-name{color:inherit}.${A.cls} .pc-xchips{color:${(A.kit.tokens || {})["--cl-text"] || (A.kit.tokens || {})["--cg-text"] || "#eee"}}`);
    } else {
      bg.style.cssText += `;background:${fill};border-radius:${radius}px;box-shadow:${S.card.shadow},${S.card.inner_highlight}`;
      rim.style.cssText += `;border-radius:${radius}px;border:${S.card.rim_px}px solid transparent;border-top-color:${S.card.rim_top};border-left-color:${S.card.rim_left};-webkit-mask-image:${S.card.rim_mask};mask-image:${S.card.rim_mask}`;
    }

    // elements of the typing instance
    const q = (I, sel) => (sel ? I.inner.querySelector(sel) : null);
    const promptEl = q(IT, A.KC.prompt_sel) || IT.inner.querySelector("[class*=prompt]");
    const caret = document.createElement("span");
    caret.innerHTML = A.caretHtml;
    const caretEl = caret.firstElementChild || caret;
    // placeholder: per-character spans (fade left → right)
    let phChars = [];
    const phEl = placeholder ? [...IT.inner.querySelectorAll("span,div")].find((e) => e.children.length === 0 && e.textContent === placeholder && e !== promptEl) : null;
    if (phEl) {
      phEl.innerHTML = [...placeholder].map((ch) => `<span>${ch.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span>`).join("");
      phChars = [...phEl.children];
    }
    const mic = IT.inner.querySelector(".nb-mic"), arrow = IT.inner.querySelector(".nb-arrow");
    const chipWraps = p.chips.map((_, i) => IT.inner.querySelector(`[data-pc-chip="${i}"]`));
    const chipEls = chipWraps.map((w) => (w && w.firstElementChild) || w);
    const chipNames = chipEls.map((e) => (e ? e.querySelector(".nb-chip-name") : null));
    let stateEl, Hwork = 0;
    if (IW) {
      // the working instance: only its state is visible
      IW.rootEl.style.visibility = "hidden";
      const tx = IW.inner.querySelector(".nb-text"); if (tx) tx.style.display = "none"; // sent: the input row gives way to the thread
      stateEl = IW.inner.querySelector(".pc-thread");
      if (stateEl) stateEl.style.visibility = "visible";
      IW.inner.querySelectorAll("[data-pc-chip]").forEach((w) => { if (w.firstElementChild) w.firstElementChild.style.visibility = "hidden"; });
    } else stateEl = thread._in.querySelector(".pc-thread") || thread._in;
    const bubbleEl = stateEl ? (stateEl.querySelector(".nb-user,.cg-user") || stateEl.firstElementChild) : null;
    const wkEl = stateEl ? stateEl.querySelector(".pc-wk") : null;
    const spinEl = stateEl ? stateEl.querySelector(".nb-spin") : null;
    const sweepEl = stateEl ? stateEl.querySelector(".cg-working, [class*=shimmer]") : null;

    // ── layout: heights per chip count (natural px; chips REMOVED, :has() rules see them otherwise), slots
    const hOf = (el) => el.offsetHeight;
    const Hall = hOf(IT.rootEl);
    const slots = chipEls.map((e) => (e ? offsetIn(e, IT.rootEl) : { x: 0, y: 0, w: 75, h: 75 }));
    const anchors = chipWraps.map((w) => (w ? { parent: w.parentNode, next: w.nextSibling } : null));
    const Hk = [];
    for (let n = 0; n <= p.chips.length; n++) {
      chipWraps.forEach((w, i) => { if (w && i >= n) w.remove(); });
      const grid = n === 0 ? IT.inner.querySelector(".nb-chips") : null;
      const cls0 = !A.kit && n === 0 && IT.comp.classList.contains("has-chips");
      if (grid) grid.style.display = "none";
      if (cls0) IT.comp.classList.remove("has-chips");
      Hk.push(hOf(IT.rootEl));
      if (grid) grid.style.display = "";
      if (cls0) IT.comp.classList.add("has-chips");
      for (let i = chipWraps.length - 1; i >= 0; i--) { const w = chipWraps[i], a = anchors[i]; if (w && !w.isConnected) a.parent.insertBefore(w, a.next && a.next.isConnected ? a.next : null); }
    }
    // re-insert in order (anchors may have been removed siblings)
    chipWraps.forEach((w, i) => { const a = anchors[i]; if (w && a) a.parent.appendChild(w); });
    if (A.kit) {
      // a kit after send: the composer empties (no text, no attachments) and the thread sits above it
      const keepP = promptEl ? promptEl.textContent : "";
      chipWraps.forEach((w) => w && w.remove());
      const g = IT.inner.querySelector(".pc-xchips"); if (g) g.style.display = "none";
      const lc = vals({}).layout_class; if (lc) IT.comp.classList.remove(lc);
      if (promptEl) promptEl.textContent = "";
      if (phEl) phEl.style.visibility = "hidden";
      const Hempty = hOf(IT.rootEl);
      if (promptEl) promptEl.textContent = keepP;
      if (phEl) phEl.style.visibility = "";
      if (lc) IT.comp.classList.add(lc);
      if (g) g.style.display = "";
      chipWraps.forEach((w, i) => { const a = anchors[i]; if (w && a) a.parent.appendChild(w); });
      const tgap = 24;
      const th = thread._in.offsetHeight;
      thread._h = th * k; thread._gap = tgap * k;
      Hwork = Hempty; // the composer's own height after send
      thread.style.height = th * k + "px";
    } else Hwork = hOf(IW.rootEl);
    // bottom-anchored on the plane: the card's bottom edge stays at origin.y + H0/2
    const H0 = Hk[0] * k;
    const cardBottom = C.origin[1] + H0 / 2;
    IT.wrap.style.top = cardBottom - Hall * k + "px";
    if (IW) IW.wrap.style.top = cardBottom - Hwork * k + "px";
    bg.style.left = cardLeft + "px"; bg.style.width = cardW + "px";
    // rows (chips sharing a slot top) → growth events
    const rows = [];
    slots.forEach((s, i) => {
      const r = rows.find((rr) => Math.abs(rr.y - s.y) < 4);
      if (r) r.items.push(i); else rows.push({ y: s.y, items: [i] });
    });

    // ── result panel (MO05) — only from a REAL params.result
    let resWrap = null, resH = 0;
    if (p.result) {
      resWrap = TR.el("div", `position:absolute;left:${cardLeft}px;top:0;width:${cardW}px;opacity:0`, plane);
      const rbg = TR.el("div", `position:absolute;inset:0;border-radius:${radius}px;background:${A.kit ? (A.page || fill) : S.card.fill};box-shadow:${S.card.shadow}${A.kit ? "" : "," + S.card.inner_highlight}`, resWrap);
      if (!A.kit) TR.el("div", `position:absolute;inset:0;box-sizing:border-box;border-radius:${radius}px;border:${S.card.rim_px}px solid transparent;border-top-color:${S.card.rim_top};border-left-color:${S.card.rim_left};-webkit-mask-image:${S.card.rim_mask};mask-image:${S.card.rim_mask}`, rbg);
      const rin = TR.el("div", `position:relative;width:${A.W}px;transform:scale(${k});transform-origin:0 0;${A.tokenCss};box-sizing:border-box;padding:${A.kit ? 24 : 0}px`, resWrap);
      rin.className = A.cls;
      rin.innerHTML = A.resultHtml(p.result, prompt);
      const img = rin.querySelector("img");
      if (img && p.result.w && p.result.h) img.style.aspectRatio = `${p.result.w} / ${p.result.h}`;
      resH = rin.offsetHeight * k;
      resWrap.style.height = resH + "px";
      resWrap._rin = rin;
    }

    // optional greeting above the composer (kits that have one, e.g. Claude's new-chat page); fades when sent
    let greetEl = null;
    if (p.greeting && A.kit && A.kit.greeting && A.kit.greeting.html) {
      TR.addCss(String(A.kit.greeting.css || "").replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) => `${a} ${sel.split(",").map((s) => `.${A.cls} ${s.trim()}`).join(",")}{`));
      greetEl = TR.el("div", `position:absolute;left:${cardLeft}px;top:0;width:${A.W}px;transform-origin:0 100%;${A.tokenCss}`, plane);
      greetEl.className = A.cls;
      greetEl.innerHTML = TR.fill(A.kit.greeting.html, { greeting: p.greeting });
      greetEl.dataset.gap = String(Number(A.kit.greeting.baseline_above_composer) || 40);
    }
    const after = []; let seen = 0;
    rows.forEach((r) => { seen += r.items.length; r.items.forEach((i) => (after[i] = seen)); });
    const st = { chipH: chipEls.map((e, i) => (e && e.offsetHeight) || slots[i].h), chipK: extraGrid ? 1 : k, chipWraps, thread, neutralChips, greetEl, after, p, A, k, plane, exitWrap, bg, IT, IW, promptEl, caretEl, phChars, mic, arrow, chipEls, chipNames, slots, rows, Hk, Hall, Hwork,
      H0, cardBottom, cardLeft, cardW, bubbleEl, wkEl, spinEl, sweepEl, resWrap, resH };
    st.tl = timeline(scene, st);
    if (resWrap) resWrap.style.top = st.tl.resTop + "px";
    return st;
  }

  // ───────────────────────── timing (beats → every event) ─────────────────────────
  function timeline(scene, st) {
    const K = scene.kf, B = scene.beats || {}, R = K.ref, p = st.p;
    const has = (n) => B[n] != null && isFinite(Number(B[n]));
    const b = (n) => Number(B[n]);
    const T = {};
    T.in = has("in") ? b("in") : 0;
    T.type = has("type") ? b("type") : T.in + (R.beats.type - R.beats.in);
    const N = [...p.prompt].length;
    const Y = K.typing;
    T.out = has("out") ? b("out") : (scene.duration || R.duration) - K.camera.exit.dur;
    let rate = Y.rate_cps;
    const natEnd = T.type + N / rate;
    T.workGiven = has("working") || has("send");
    T.work0 = has("working") ? b("working") : has("send") ? b("send") : null;
    if (T.work0 != null) {
      const avail = T.work0 - Y.finish_before_working_s - T.type;
      if (N / rate > avail) rate = clamp(N / Math.max(avail, 1e-3), Y.rate_cps, Y.rate_max_cps);
      T.rate = rate;
      T.typeDur = Math.min(N / rate, Math.max(0.3, avail));
    } else { T.rate = rate; T.typeDur = N / rate; }
    T.typeEnd = T.type + T.typeDur;
    // chips
    const nC = p.chips.length, F = K.chips;
    T.chip = [];
    for (let i = 0; i < nC; i++) {
      if (has(`chip_${i}`)) T.chip.push(b(`chip_${i}`));
      else if (i === 0) T.chip.push(T.typeEnd + (R.beats.chip_0 - R.typing_end));
      else T.chip.push(T.chip[i - 1] + (R.chip_gaps_s[i - 1] != null ? R.chip_gaps_s[i - 1] : R.chip_gap_default_s));
    }
    T.land = T.chip.map((t) => t + F.flight.dur);
    // card growth per row
    T.grow = []; // {start, from, to}
    let prev = -1e9, nSeen = 0;
    const rowOf = [];
    st.rows.forEach((r, ri) => {
      r.items.forEach((i) => (rowOf[i] = ri));
      const last = Math.max(...r.items);
      const start = Math.max(T.land[last] + F.grow.after_last_land_s, prev + F.grow.min_spacing_s);
      const from = st.Hk[nSeen]; nSeen += r.items.length;
      T.grow.push({ start, from, to: st.Hk[nSeen], row: ri });
      prev = start;
    });
    T.expand = [];
    for (let i = 0; i < nC; i++) {
      const g = T.grow[rowOf[i]];
      T.expand.push(Math.max(g.start + F.expand.after_grow_s, i ? T.expand[i - 1] + F.expand.min_spacing_s : -1e9));
    }
    const lastEx = nC ? T.expand[nC - 1] + F.expand.dur : T.typeEnd + 0.6;
    T.work = T.work0 != null ? T.work0 : Math.max(lastEx - 0.03, T.typeEnd + 0.6);
    T.result = p.result ? (has("result") ? b("result") : T.work + 1.2) : null;
    // camera
    const Cm = K.camera;
    T.push = nC ? T.chip[0] + Cm.push.at : T.typeEnd - 0.17;
    T.pull = Math.max(T.work + Cm.pull.at, T.push + 0.6);
    T.pullDur = Math.max(0.4, Math.min(Cm.pull.dur, (T.result != null ? T.result : T.out) - T.pull));
    // result panel geometry (plane px): above the card, centred by the camera
    T.cardTopFinal = st.cardBottom - st.Hwork * st.k - (st.thread ? st.thread._gap + st.thread._h : 0);
    if (st.resWrap) {
      const S = scene.style;
      T.resTop = T.cardTopFinal - S.result_panel.gap_px - st.resH;
      const fit = (S.result_panel.max_h_frac * 1080) / st.resH;
      T.resS = Math.min(1.0, fit);
      T.resCy = T.resTop + st.resH / 2;
    }
    return T;
  }

  // the result image decodes after build (data URI): re-measure the panel once it has its real height
  function relayoutResult(st, scene) {
    const r = st.resWrap; if (!r || !r._rin) return;
    const h = r._rin.offsetHeight * st.k;
    if (Math.abs(h - st.resH) < 0.5) return;
    st.resH = h; r.style.height = h + "px";
    const S = scene.style, T = st.tl;
    T.resTop = T.cardTopFinal - S.result_panel.gap_px - h;
    T.resS = Math.min(1.0, (S.result_panel.max_h_frac * 1080) / h);
    T.resCy = T.resTop + h / 2;
    r.style.top = T.resTop + "px";
  }

  function seek(st, t, scene) {
    relayoutResult(st, scene);
    const K = scene.kf, S = scene.style, C = K.camera, T = st.tl, p = st.p, k = st.k;
    // ── card height (plane px) and growth progress
    let Hn = st.Hk[0];
    for (const g of T.grow) Hn = lerp(Hn, g.to, TR.prog(t, g.start, K.chips.grow.dur, K.chips.grow.ease)) + 0 * g.from;
    // (segments are sequential: recompute exactly)
    Hn = st.Hk[0];
    for (const g of T.grow) { const q = TR.prog(t, g.start, K.chips.grow.dur, K.chips.grow.ease); if (t >= g.start) Hn = lerp(g.from, g.to, q); }
    const W = K.working;
    const gw = TR.prog(t, T.work, W.grow_dur, W.grow_ease);
    const dWork = (st.Hwork - st.Hall) * k; // the shift of everything above the state (chips) when sent
    let Hcur = Hn * k + (st.Hwork * k - st.Hk[st.Hk.length - 1] * k) * gw;
    if (st.thread) {
      // kits: the app's composer reflows as you type and as files attach (it is a real UI); keep it bottom-anchored
      // at its live natural height, and ease the box over each attachment row with the measured growth curve
      const sent = t >= T.work + W.text_out_s;
      const N0 = [...p.prompt].length;
      const tq = clamp((t - T.type) / Math.max(T.typeDur, 1e-3), 0, 1);
      if (st.promptEl) st.promptEl.textContent = sent ? "" : [...p.prompt].slice(0, t < T.type ? 0 : Math.round(N0 * TR.ease(K.typing.ease)(tq))).join("");
      // each attachment opens its own room: the wrapper's height eases 0 → natural with its row's growth curve,
      // so the app's layout (text, tools) reflows smoothly; the chip itself flies in over it (overflow visible)
      st.chipWraps.forEach((w, i) => {
        if (!w) return;
        if (sent || t < T.chip[i]) { w.style.display = "none"; return; }
        const g = T.grow.find((gg) => st.rows[gg.row].items.includes(i));
        const qg = g ? TR.prog(t, g.start, K.chips.grow.dur, K.chips.grow.ease) : 1;
        w.style.cssText = `display:inline-block;vertical-align:top;overflow:visible;height:${st.chipH[i] * qg}px`;
      });
      const xg = st.IT.inner.querySelector(".pc-xchips");
      if (xg) xg.style.display = !sent && T.chip.some((c) => t >= c) ? "" : "none";
      const Hnat = st.IT.rootEl.offsetHeight;
      st.IT.wrap.style.top = st.cardBottom - Hnat * k + "px";
      Hcur = t < T.work ? Hnat * k : lerp(st.Hk[st.Hk.length - 1] * k, st.Hwork * k, gw);
      if (t >= T.work && !sent) st.IT.wrap.style.top = st.cardBottom - Hnat * k + "px";
    }
    // ── card bg
    st.bg.style.top = st.cardBottom - Hcur + "px";
    st.bg.style.height = Hcur + "px";
    const Hbox = Hcur; // the composer box itself
    if (st.thread) {
      // kits: the thread (bubble + working) sits above the emptied composer; the camera centres the whole group
      st.thread.style.top = (st.cardBottom - Hcur - st.thread._gap - st.thread._h) + "px";
      let to = 1;
      if (T.result != null) to = 1 - clamp((t - T.result) / K.result.composer_out_s, 0, 1);
      st.thread.style.opacity = String(to);
      Hcur += (st.thread._gap + st.thread._h) * gw;
    }

    if (st.greetEl) {
      const gh = st.greetEl.offsetHeight;
      st.greetEl.style.top = (st.cardBottom - Hcur - Number(st.greetEl.dataset.gap) * k - gh) + "px";
      st.greetEl.style.transform = `scale(${k})`;
      st.greetEl.style.opacity = String(1 - clamp((t - T.work) / 0.2, 0, 1));
    }
    // ── typing / placeholder / caret
    const N = [...p.prompt].length;
    const tp = clamp((t - T.type) / Math.max(T.typeDur, 1e-3), 0, 1);
    const nChars = t < T.type ? 0 : Math.round(N * TR.ease(K.typing.ease)(tp));
    if (st.promptEl && !st.thread) st.promptEl.textContent = [...p.prompt].slice(0, nChars).join(""); // (the caret goes INSIDE the prompt: a block prompt would push a sibling caret to its own line)
    const PH = K.placeholder;
    const ph0 = T.type + PH.at;
    st.phChars.forEach((e, i) => { e.style.opacity = String(1 - clamp((t - (ph0 + i * PH.stagger_s)) / PH.fade_s, 0, 1)); });
    const caretOn = t >= T.type && t < Math.min(T.typeEnd + K.caret.hide_after_typing_s, T.work);
    if (caretOn && st.promptEl) st.promptEl.appendChild(st.caretEl); else if (st.caretEl.isConnected) st.caretEl.remove();
    if (st.mic && st.arrow) {
      const a = clamp((t - (T.type + K.send_icon.swap_after_type_s)) / K.send_icon.fade_s, 0, 1);
      st.mic.style.opacity = String(1 - a); st.arrow.style.opacity = String(a);
    }
    // ── working: text out, bubble + label in, chips ride up
    const textOut = 1 - clamp((t - T.work) / W.text_out_s, 0, 1);
    const textEl = st.promptEl ? (st.thread ? st.promptEl : st.promptEl.parentElement) : null;
    if (textEl) textEl.style.opacity = String(textOut);
    if (st.bubbleEl) {
      const bi = TR.ease([0.2, 0.8, 0.5, 1.0])(clamp((t - T.work) / W.bubble_in_s, 0, 1));
      st.bubbleEl.style.opacity = String(bi);
      st.bubbleEl.style.transformOrigin = "100% 0";
      st.bubbleEl.style.transform = `scale(${lerp(W.bubble_from_scale, 1, bi)})`;
    }
    if (st.wkEl) {
      let lo = clamp((t - T.work - W.label_at) / W.label_in_s, 0, 1);
      if (T.result != null) lo *= 1 - clamp((t - T.result) / K.result.composer_out_s, 0, 1);
      st.wkEl.style.opacity = String(lo);
    }
    if (st.spinEl) st.spinEl.style.cssText = `display:inline-flex;transform:rotate(${Math.floor(((t - T.work) / W.spinner_period_s) * 6) * 60}deg)`;
    if (st.sweepEl && scene.kit && scene.kit.working && scene.kit.working.shimmer) {
      const sh = scene.kit.working.shimmer, ph = ((t - T.work) % sh.period_s + sh.period_s) % sh.period_s;
      const q = Math.floor(clamp(ph / sh.sweep_s, 0, 1) * sh.steps) / sh.steps;
      const from = parseFloat(sh.from), to = parseFloat(sh.to);
      st.sweepEl.style.setProperty(sh.var, `${lerp(from, to, q)}%`);
    }
    // ── chips
    const Fl = K.chips.flight, Ex = K.chips.expand;
    st.chipEls.forEach((e, i) => {
      if (!e) return;
      const t0 = T.chip[i];
      if (t < t0) { e.style.visibility = "hidden"; return; }
      e.style.visibility = "visible";
      const f = Fl.from[i % Fl.from.length];
      const q = TR.prog(t, t0, Fl.dur, Fl.ease), u = 1 - q;
      const tile = K.chips.tile_px;
      const sl = st.slots[i];
      e.style.transformOrigin = `${(st.neutralChips ? tile / 2 : sl.w / 2)}px ${sl.h / 2}px`;
      // where the chip sits: its final offset from the card top, measured from the card top it will have once its row
      // has grown (until then it pokes out above the card, like the reference's tiles), riding up as the card grows
      const after = st.Hk[st.after[i]] * k;
      const top = Math.min(st.cardBottom - Hbox, st.cardBottom - after);
      const ride = st.thread ? 0 : (top - (st.cardBottom - st.Hall * k)) / k;
      e.style.transform = `translateY(${ride}px) perspective(${C.perspective_px}px) translate3d(${(f.dx * u) / st.chipK}px,${(f.dy * u) / st.chipK}px,0) rotateX(${f.rx * u}deg) rotateY(${f.ry * u}deg) rotateZ(${f.rz * u}deg) scale(${lerp(f.s, 1, q)})`;
      e.style.opacity = Fl.fade_in_s > 0 ? String(clamp((t - t0) / Fl.fade_in_s, 0, 1)) : "1";
      if (st.thread && t >= T.work) e.style.opacity = String(textOut); // kits: attachments go with the message
      if (st.neutralChips) {
        const pe = TR.prog(t, T.expand[i], Ex.dur, Ex.ease);
        const inset = ((e.offsetWidth || sl.w) - tile) * (1 - pe);
        e.style.clipPath = `inset(0 ${inset}px 0 0 round 18px)`;
        // the flying tile is a brighter glass square; it settles to the pill's own fill as it opens
        const tb = st.A.dark ? S.card.tile_bg_dark : S.card.tile_bg, pb = st.A.dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.10)";
        e.style.background = pe < 1 ? `color-mix(in srgb, ${tb} ${Math.round((1 - pe) * 100)}%, ${pb})` : "";
        const nm = st.chipNames[i];
        if (nm) {
          const a = pe * 115;
          nm.style.webkitMaskImage = nm.style.maskImage = `linear-gradient(90deg,#000 ${a - 15}%,transparent ${a}%)`;
        }
      }
    });

    // ── camera
    const rest = Object.assign({}, C.rest, p.tilt || {});
    const en = C.entrance, qe = TR.prog(t, T.in + en.at, en.dur, en.ease), ue = 1 - qe;
    let s = lerp(en.from.s, rest.s, qe);
    let tx = lerp(en.from.tx, rest.tx, qe), ty = lerp(en.from.ty, rest.ty, qe);
    let rx = lerp(en.from.rx, rest.rx, qe), ry = lerp(en.from.ry, rest.ry, qe), rz = lerp(en.from.rz, rest.rz, qe);
    const pushQ = TR.prog(t, T.push, C.push.dur, C.push.ease);
    let sPush = lerp(1, C.push.s_to, pushQ);
    const sAtPull = lerp(1, C.push.s_to, TR.prog(T.pull, T.push, C.push.dur, C.push.ease));
    if (t >= T.pull) sPush = lerp(sAtPull, C.pull.s_to, TR.prog(t, T.pull, T.pullDur, C.pull.ease));
    s *= sPush;
    // keep the growing card centred
    ty += s * (Hcur - st.H0) / 2 * C.center_on_card.k;
    // MO05 result: pan up / pull back to the result panel, tilt bump
    if (T.result != null) {
      const Rk = K.result, qr = TR.prog(t, T.result, Rk.dur, Rk.ease);
      const sNow = s, sRes = Math.min(sNow, T.resS * rest.s);
      s = lerp(sNow, sRes, qr);
      const cardCy = st.cardBottom - Hcur / 2;
      ty = lerp(ty, (540 - C.origin[1]) + s * (C.origin[1] - T.resCy), qr);
      rx += Rk.tilt_rx * Math.sin(Math.PI * qr);
      if (st.resWrap) {
        st.resWrap.style.opacity = String(clamp(qr * 1.6, 0, 1));
        st.resWrap.style.transform = `translateY(${Rk.panel_from_dy * (1 - qr)}px)`;
      }
      void cardCy;
    }
    const eb = (C.entrance.blur_px || 0) * Math.pow(ue, 2);
    st.plane.style.filter = eb > 0.3 ? `blur(${eb}px)` : "";
    st.plane.style.transform = `translate(${tx}px,${ty}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`;
    // ── exit: push through the card (screen space), zoom blur
    const X = C.exit, qx = TR.prog(t, T.out + X.at, X.dur, X.ease);
    const ds = X.ds * qx;
    st.exitWrap.style.transform = ds > 0 ? `scale(${1 + ds})` : "";
    const blur = Math.min(X.blur_max_px, ds * X.blur_px_per_ds * Math.max(0, ds - 0.2));
    st.exitWrap.style.filter = blur > 0.3 ? `blur(${blur}px)` : "";
  }

  window.__TEMPLATES["prompt_card_3d"] = { build, seek, timeline };
})();
