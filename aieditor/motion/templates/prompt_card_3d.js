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
      return { name, kind, thumb: c.thumb ? String(c.thumb) : null };
    });
    const r = P.result && typeof P.result === "object" ? P.result : null;
    const result = r && ((r.kind === "image" && r.src) || (r.kind === "text" && r.text) || (r.kind === "artifact" && r.html)) ? r : null;
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
      end_on_click: P.end_on_click != null ? !!P.end_on_click : null, // null → the look's default (Claude: on)
      // "whip" (the reference's entrance) | "cut" (crisp from frame 0; default for the MO05 prompt → result hook)
      entrance: P.entrance === "cut" || P.entrance === "whip" ? P.entrance : (result ? "cut" : "whip"),
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
    // round 4: a per-app look (style.looks[app] + kf.looks[app]) — not for the MO05 artifact view (Jake likes it as is)
    const P0 = scene.params || {};
    const artView = !!(P0.result && P0.result.kind === "artifact");
    const look = kit && kit.chip && S.looks && S.looks[app] && !artView
      ? Object.assign({}, S.looks[app], { motion: (scene.kf.looks && scene.kf.looks[app]) || {} }) : null;
    if (look) {
      const lw = num(look.composer_w_css, num(KC.width, S.card.w));
      TR.addCss(`.${cls} .cl-composer{width:${lw}px !important}\n.${cls} .cl-input.pc-look-in{display:flex !important;flex-direction:column !important;flex-wrap:nowrap !important;gap:0 !important;padding-top:12.75px !important}` +
        `\n.${cls} .cl-input.pc-look-in .cl-prompt{order:0 !important;margin-top:0 !important;width:auto !important;overflow:hidden}` +
        `\n.${cls} .pc-attrow{order:-1;display:flex;flex-wrap:wrap;gap:${num(look.att_gap_css, 8)}px;overflow:visible;flex:none}` +
        `\n.${cls} .pc-att{display:block;flex:none;line-height:0}\n.${cls} .pc-att .clk-chip{display:block}\n.${cls} .pc-ph{display:block;width:100%;height:100%}`);
    }
    // kits: an image chip shows its REAL thumbnail when params give one (data URI), else the kit's file tile
    // (round 4 look: an image chip with no picture shows a neutral placeholder photo, never a blank file card)
    const chipKind = (c) => (kit && kit.chip ? (c.thumb || (look && look.image_placeholder && c.kind === "image") ? "image" : "file") : c.kind);
    const page = kit ? (kit.bg || tokens[Object.keys(tokens).find((k) => /-page$/.test(k))] || null) : null;
    return {
      kit, cls, KC, dark, tokenCss, page, look,
      W: look ? num(look.composer_w_css, num(KC.width, S.card.w)) : num(KC.width, S.card.w),
      cardW: look ? num(look.card_w, S.card.w) : S.card.w,
      model: (KC.model || (kit && kit.model_label) || (kit ? "" : N.model)),
      placeholder: KC.placeholder || "",
      caretHtml,
      chipHtml(c) {
        const ch = (kit && kit.chip) || N.chip;
        const ext = (String(c.name).match(/\.([a-z0-9]{1,5})$/i) || [, ""])[1];
        return TR.fill(ch.html, { name: c.name, kind: chipKind(c), icon_html: chipIcon(c.kind), ext, meta: "",
          thumb_html: c.thumb ? `<img src="${String(c.thumb).replace(/"/g, "&quot;")}" alt="">`
            : (look && look.image_placeholder && c.kind === "image" ? `<span class="pc-ph">${look.placeholder_svg || ""}</span>` : "") });
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
    // Claude (kits with a conversation recipe): after the click the composer docks at the bottom, the user bubble
    // appears top-right and the REAL reply streams in under it (round 3). The artifact view stays as approved.
    const convMode = !!(A.kit && A.kit.conversation && A.kit.message && A.kit.result && A.kit.result.user &&
      (!p.result || p.result.kind === "text") && (p.end_on_click != null ? p.end_on_click : A.kit.app === "claude") &&
      !(A.look && !p.result)); // round 4: with no result the Claude look ENDS on the click (no dock into the greeting)
    const msgMode = !convMode && !!(p.result && A.kit && A.kit.message && /^(text|artifact)$/.test(p.result.kind));
    if (p.result && !msgMode && (A.kit ? !(A.kit.result && A.kit.result[p.result.kind]) : p.result.kind === "artifact")) p.result = null;
    const endOnClick = p.end_on_click != null ? p.end_on_click : !!(A.kit && A.kit.app === "claude");
    const k = A.cardW / A.W; // kit natural px → plane px (round 4: the Claude look has its own, readable, card width)
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

    const cardW = A.cardW, cardLeft = C.origin[0] - cardW / 2;
    const prompt = p.prompt;
    const placeholder = p.placeholder != null ? p.placeholder : A.placeholder;
    const label = A.workingText(p);
    const kitChips = !!(A.kit && A.kit.chip);           // the kit draws its own attachments inside its composer
    const neutralChips = !kitChips;                      // else: the reference's own chip grid (above the text)
    const chipsHtml = A.look
      ? (p.chips.length ? `<div class="pc-attrow">${p.chips.map((c, i) => `<span data-pc-chip="${i}" class="pc-att">${A.chipHtml(c)}</span>`).join("")}</div>` : "")
      : p.chips.map((c, i) => `<span data-pc-chip="${i}" style="display:contents">${A.chipHtml(c)}</span>`).join("");
    const extraGrid = A.kit && !kitChips && p.chips.length
      ? `<div class="nb-chips pc-xchips" style="zoom:${1 / k};padding:25px 36px 0 44px;margin:0;display:grid;grid-template-columns:408px 408px;column-gap:21px;row-gap:18px">${chipsHtml}</div>` : "";
    const vals = (over) => Object.assign({ prompt: "", placeholder, chips_html: A.kit ? (kitChips ? chipsHtml : "") : chipsHtml, caret_html: "", state_html: "",
      layout_class: A.layoutClass(!A.kit || kitChips ? p.chips.length : 0, prompt), model: A.model, model_label: A.model }, over);

    // card background (shadow + fill + rim); kits: the composer's own fill/radius moved here
    const bg = TR.el("div", "position:absolute;box-sizing:border-box", plane);
    const rim = A.kit ? null : TR.el("div", "position:absolute;inset:0;box-sizing:border-box;pointer-events:none", bg);
    const late = A.kit || !S.card.fill_late ? null : TR.el("div", `position:absolute;inset:0;border-radius:${S.card.radius}px;background:${S.card.fill_late};opacity:0;pointer-events:none`, bg);
    const entGlow = A.kit || !S.card.fill_entrance ? null : TR.el("div", `position:absolute;inset:0;border-radius:${S.card.radius}px;background:${S.card.fill_entrance};opacity:0;pointer-events:none`, bg);
    const pushGlow = A.kit || !S.card.fill_push ? null : TR.el("div", `position:absolute;inset:0;border-radius:${S.card.radius}px;background:${S.card.fill_push};opacity:0;pointer-events:none`, bg);

    function instance(v, extra) {
      const wrap = TR.el("div", `position:absolute;left:${cardLeft}px;top:0;width:${cardW}px`, plane);
      const inner = TR.el("div", `position:absolute;left:0;top:0;width:${A.W}px;transform:scale(${k});transform-origin:0 0;${A.tokenCss}`, wrap);
      inner.className = A.cls;
      inner.innerHTML = `<div class="pc-root" style="display:flow-root">${extra || ""}${TR.fill(A.KC.html, v)}</div>`;
      const rootEl = inner.firstElementChild;
      return { wrap, inner, rootEl, comp: rootEl.lastElementChild };
    }
    const IT = instance(vals({ prompt: prompt }), extraGrid);
    if (A.look) { const ci = IT.inner.querySelector(".cl-input"); if (ci) ci.classList.add("pc-look-in"); }
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
    // a comment marker before each chip keeps its place in the kit's markup while it is detached for measuring
    const anchors = chipWraps.map((w) => { if (!w) return null; const c = document.createComment("pc-chip"); w.before(c); return c; });
    const putBack = (w, i) => { if (w && anchors[i] && !w.isConnected) anchors[i].after(w); };
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
      chipWraps.forEach(putBack);
    }

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
      chipWraps.forEach(putBack);
      const tgap = 24;
      const th = thread._in.offsetHeight;
      thread._h = th * k; thread._gap = tgap * k;
      Hwork = Hempty; // the composer's own height after send
      thread.style.height = th * k + "px";
    } else Hwork = hOf(IW.rootEl);
    let textDrop = 0, textBox = null;
    if (!A.kit && p.chips.length) {
      textBox = IT.inner.querySelector(".nb-text");
      const foot = IT.inner.querySelector(".nb-foot");
      const gapWith = foot.getBoundingClientRect().top - textBox.getBoundingClientRect().bottom;
      IT.comp.classList.remove("has-chips");
      const gapWithout = foot.getBoundingClientRect().top - textBox.getBoundingClientRect().bottom;
      IT.comp.classList.add("has-chips");
      textDrop = gapWithout - gapWith;
    }
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
    if (p.result && !msgMode) {
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
    const rowOf = []; rows.forEach((r, ri) => r.items.forEach((i) => (rowOf[i] = ri)));
    const after = []; let seen = 0;
    rows.forEach((r) => { seen += r.items.length; r.items.forEach((i) => (after[i] = seen)); });
    const st = { late, pushGlow, entGlow, textDrop, textBox, rowOf, root, chipH: chipEls.map((e, i) => (e && e.offsetHeight) || slots[i].h), chipK: extraGrid ? 1 : k, chipWraps, thread, neutralChips, greetEl, after, p, A, k, plane, exitWrap, bg, IT, IW, promptEl, caretEl, phChars, mic, arrow, chipEls, chipNames, slots, rows, Hk, Hall, Hwork,
      H0, cardBottom, cardLeft, cardW, bubbleEl, wkEl, spinEl, sweepEl, resWrap, resH, endOnClick, msgMode };
    // the cursor that clicks send (end_on_click) — prompt_menu's sprite + measured glide (kf.cursor)
    if (endOnClick) {
      const CS = S.cursor;
      st.cur = TR.el("div", `position:absolute;left:0;top:0;width:80px;height:120px;transform-origin:8px 8px;visibility:hidden;z-index:9`, root,
        `<svg viewBox="-8 -8 80 120" width="80" height="120" style="overflow:visible;filter:${CS.shadow}"><polygon points="${CS.points}" fill="${CS.fill}" stroke="${CS.outline}" stroke-width="${CS.outline_px}" stroke-linejoin="round" paint-order="stroke"/></svg>`);
      st.sendEl = (A.KC.send_sel && IT.inner.querySelector(A.KC.send_sel)) || IT.inner.querySelector(".nb-send");
    }
    if (msgMode) buildMessage(root, scene, st);
    st.conv = convMode;
    if (convMode) { if (thread) thread.style.display = "none"; buildConv(root, scene, st); }
    st.look = A.look;
    if (A.look) buildLook(scene, st);
    st.tl = timeline(scene, st);
    if (A.look) lookLines(scene, st);
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
    // round 4 (Claude look): the files are attached FIRST (from the 'type' beat), then the prompt is typed — unless
    // the narration's chip_i beats put them after typing starts (then the box grows upward with them)
    const LM = st.look ? st.look.motion : null;
    let preChip = null;
    if (LM && p.chips.length) {
      const given = p.chips.some((_, i) => has(`chip_${i}`));
      if (!given && LM.attach_first) {
        T.attach = Math.max(T.type, T.in + (LM.attach_after_in_s || 0));
        preChip = p.chips.map((_, i) => T.attach + i * LM.attach_stagger_s);
        T.type = preChip[preChip.length - 1] + Math.max(LM.tile_pop.dur, LM.row_grow.dur) + LM.type_after_attach_s;
      }
    }
    const Y = K.typing;
    T.out = has("out") ? b("out") : (scene.duration || R.duration) - K.camera.exit.dur;
    let rate = Y.rate_cps;
    const natEnd = T.type + N / rate;
    T.workGiven = has("working") || has("send");
    T.work0 = has("working") ? b("working") : has("send") ? b("send") : null;
    if (st.endOnClick) {
      // the clip ends on the cursor's click on send (Jake 2026-10-10, Claude look): the click takes the 'working' slot
      T.work0 = has("click") ? b("click") : has("send") ? b("send") : has("working") ? b("working") : null;
      // round 4 (Claude look, no result): no click beat → the click lands hold_after_click_s before the clip ends
      if (T.work0 == null && st.look && !p.result && scene.duration) T.work0 = Math.max(T.type + 0.6, scene.duration - K.cursor_click.hold_after_click_s);
    }
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
      if (preChip) T.chip.push(preChip[i]);
      else if (has(`chip_${i}`)) T.chip.push(b(`chip_${i}`));
      else if (LM && i > 0) T.chip.push(T.chip[i - 1] + LM.attach_stagger_s);
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
    if (st.endOnClick) {
      T.click = st.tl0click = T.work0 != null ? T.work0 : Math.max(lastEx + 0.3, T.typeEnd + 0.8);
      T.work = st.conv ? T.click : 1e9; // no 'working' state above the card (conv: the composer empties on the click)
      if (!has("out")) T.out = 1e9; // hard cut at the clip end (hold_after_click_s after the click)
    }
    T.result = p.result ? (has("result") ? b("result") : (st.conv ? T.click + K.conversation.stream_after_click_s : st.endOnClick ? T.click + K.cursor_click.result_after_click_s : T.work + 1.2)) : null;
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
    const gw = TR.prog(t, T.work + (st.thread || st.conv ? 0 : W.grow_delay_s || 0), W.grow_dur, W.grow_ease);
    const dWork = (st.Hwork - st.Hall) * k; // the shift of everything above the state (chips) when sent
    let Hcur = Hn * k + (st.Hwork * k - st.Hk[st.Hk.length - 1] * k) * gw;
    let HgreetK = null; // round 4 look: the box height the greeting sits on (frozen at the click)
    if (st.look) {
      // round 4 (Claude look): attachments open their row ABOVE the text (analytic heights, no tile ever over the text),
      // new prompt lines open over line_grow.dur; the card stays bottom-anchored
      if (st.HclickK == null) st.HclickK = lookLayout(st, Math.min(T.work, 1e8), scene) * k;
      const Hnat = lookLayout(st, t, scene);
      st.IT.wrap.style.top = st.cardBottom - Hnat * k + "px";
      // (conv: the box holds its click height until its text + tiles have faded, THEN empties — round 3c shrank it
      // under the still-visible tiles, which stuck out above the card while it docked)
      const gwL = st.conv ? TR.prog(t, T.work + W.text_out_s, W.grow_dur, W.grow_ease) : gw;
      Hcur = t < T.work ? Hnat * k : lerp(st.HclickK, st.Hwork * k, gwL);
      HgreetK = t < T.work ? Hcur : st.HclickK;
    } else if (st.thread) {
      // kits: the app's composer reflows as you type and as files attach (it is a real UI); keep it bottom-anchored
      // at its live natural height, and ease the box over each attachment row with the measured growth curve
      const sent = t >= T.work + W.text_out_s;
      const N0 = [...p.prompt].length;
      const tq = clamp((t - T.type) / Math.max(T.typeDur, 1e-3), 0, 1);
      if (st.promptEl) st.promptEl.textContent = sent ? "" : [...p.prompt].slice(0, t < T.type ? 0 : Math.round(N0 * TR.ease(K.typing.ease)(tq))).join("");
      // each attachment opens its own room: the wrapper's height eases 0 → natural with its row's growth curve,
      // so the app's layout (text, tools) reflows smoothly; the chip itself flies in over it (overflow visible)
      st.chipWraps.forEach((w) => { if (w) w.style.display = "none"; });
      const xg0 = st.IT.inner.querySelector(".pc-xchips"); if (xg0) xg0.style.display = "none";
      st.HtextK = st.IT.rootEl.offsetHeight * k; // the box with the typed text only (camera centres on this; attachments grow upward)
      st.chipWraps.forEach((w, i) => {
        if (!w) return;
        if (sent || t < T.chip[i]) { w.style.display = "none"; return; }
        const g = T.grow.find((gg) => st.rows[gg.row].items.includes(i));
        const qg = g ? TR.prog(t, g.start, K.chips.grow.dur, K.chips.grow.ease) : 1;
        w.style.cssText = `display:inline-block;vertical-align:top;overflow:visible;height:${Math.round(st.chipH[i] * qg)}px`; // whole px: offsetHeight is an integer, so a fractional room made the bottom-anchored text bob ±1 px
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
    // per-phase glass track: the lower-left glow comes in with the push and holds (round 3b); round 3c adds a
    // left-edge glow that is only there while the chips arrive (in with the push, out shortly after the pull starts)
    if (st.late) st.late.style.opacity = String(TR.prog(t, T.push, K.camera.push.dur, K.camera.push.ease));
    if (st.entGlow) {
      // the glass reads brighter while the card whips in (rectified ours-ref: -6..-16 levels f10-f13, ~0 by f22)
      const GE = S.card.fill_entrance_track;
      st.entGlow.style.opacity = String(p.entrance === "cut" ? 0 : 1 - TR.prog(t, T.in + GE.hold_s, GE.out_dur_s, GE.ease));
    }
    if (st.pushGlow) {
      const GT = S.card.fill_push_track;
      const gin = TR.prog(t, T.push, GT.in_dur_s, GT.ease), gout = TR.prog(t, T.pull + GT.out_after_pull_s, GT.out_dur_s, GT.ease);
      st.pushGlow.style.opacity = String(gin * (1 - gout));
    }
    if (st.thread && !st.conv) {
      // kits: the thread (bubble + working) sits above the emptied composer; the camera centres the whole group
      st.thread.style.top = (st.cardBottom - Hcur - st.thread._gap - st.thread._h) + "px";
      let to = 1;
      if (T.result != null) to = 1 - clamp((t - T.result) / K.result.composer_out_s, 0, 1);
      st.thread.style.opacity = String(to);
      Hcur += (st.thread._gap + st.thread._h) * gw;
    }

    if (st.greetEl) {
      const gh = st.greetEl.offsetHeight;
      st.greetEl.style.top = (st.cardBottom - (HgreetK != null ? HgreetK : Hcur) - Number(st.greetEl.dataset.gap) * k - gh) + "px";
      st.greetEl.style.transform = `scale(${k})`;
      st.greetEl.style.opacity = String((1 - clamp((t - T.work) / 0.2, 0, 1)) * (T.result != null && st.msgMode ? 1 - clamp((t - T.result) / K.message.card_out_s, 0, 1) : 1));
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
    // neutral card with chips: the prompt drops toward the footer while the first chip row opens (measured)
    if (!st.thread && st.textDrop && st.textBox && T.grow.length) {
      const q0 = t < T.grow[0].start ? 0 : TR.prog(t, T.grow[0].start, K.chips.grow.dur, K.chips.grow.ease);
      st.textBox.style.transform = `translateY(${-st.textDrop * (1 - q0)}px)`;
    }
    // ── chips
    const Fl = K.chips.flight, Ex = K.chips.expand;
    if (st.look) {
      // round 4: each tile pops in its own slot from its top centre, its scale clamped to the room opened so far
      const TP = st.look.motion.tile_pop, sentL = st.conv && t >= T.work + W.text_out_s;
      st.chipEls.forEach((e, i) => {
        if (!e) return;
        if (t < T.chip[i] || sentL) { e.style.visibility = "hidden"; return; }
        const r = st.lookRows[st.rowOf[i]];
        const frac = clamp((st.lookRoom - r.top) / r.h, 0, 1);
        const sc = Math.min(lerp(TP.from_scale, 1, TR.prog(t, T.chip[i], TP.dur, TP.ease)), frac);
        e.style.visibility = sc > 0.01 ? "visible" : "hidden";
        e.style.transformOrigin = "50% 0";
        e.style.transform = sc < 1 ? `scale(${sc})` : "";
        e.style.opacity = String(clamp((t - T.chip[i]) / TP.fade_s, 0, 1) * (st.conv && t >= T.work ? textOut : 1));
      });
    }
    if (!st.look) st.chipEls.forEach((e, i) => {
      if (!e) return;
      const t0 = T.chip[i];
      if (t < t0) { e.style.visibility = "hidden"; return; }
      e.style.visibility = "visible";
      const f = st.A.kit && Fl.kit_from ? Fl.kit_from : Fl.from[i % Fl.from.length];
      const q = TR.prog(t, t0, Fl.dur, Fl.ease), u = 1 - q;
      const tile = K.chips.tile_px;
      const sl = st.slots[i];
      e.style.transformOrigin = `${(st.neutralChips ? tile / 2 : sl.w / 2)}px ${sl.h / 2}px`;
      // where the chip sits (re-measured 2026-10-10 on motion4 f84-f166, rectified): a tile lands where its slot WILL
      // be, but lower by the rooms that have not opened yet (its own row and every row below it) — so it first lies
      // over the text/footer, then rises into its slot as the card grows row by row
      let pend = 0;
      let parkX = 0, parkY = 0;
      if (!st.thread) {
        for (const g of T.grow) {
          const qg = t < g.start ? 0 : TR.prog(t, g.start, K.chips.grow.dur, K.chips.grow.ease);
          if (g.row >= st.rowOf[i]) pend += (g.to - g.from) * k * (1 - qg);
        }
        // the tile first parks off its slot (measured per chip), then glides in on its own clock
        const pk = (K.chips.park && K.chips.park[i]) || [0, 0], PR = K.chips.park_resolve || { after_land_s: 0, dur: 0.3, ease: null };
        const qp = TR.prog(t, T.land[i] + PR.after_land_s, PR.dur, PR.ease);
        parkX = pk[0] * (1 - qp); parkY = pk[1] * (1 - qp);
      }
      // + the working growth: when sent, everything above the state rides up with the card top (neutral card)
      const ride = (pend + parkY) / k - (st.thread ? 0 : (st.Hwork - st.Hall) * gw);
      const pe0 = st.neutralChips ? TR.prog(t, T.expand[i], Ex.dur, Ex.ease) : 1;
      const land = st.neutralChips ? K.chips.tile_land_scale : 1;
      const sc = lerp(f.s, land, q) * lerp(1, 1 / land, pe0);
      e.style.transform = `translate(${parkX / k}px,${ride}px) perspective(${Fl.perspective_px || C.perspective_px}px) translate3d(${(f.dx * u) / st.chipK}px,${(f.dy * u) / st.chipK}px,0) rotateX(${f.rx * u}deg) rotateY(${f.ry * u}deg) rotateZ(${f.rz * u}deg) scale(${sc})`;
      { const fi = st.A.kit ? (Fl.kit_fade_in_s || 0) : Fl.fade_in_s; e.style.opacity = fi > 0 ? String(clamp((t - t0) / fi, 0, 1)) : "1"; }
      if (st.thread && t >= T.work) e.style.opacity = String(textOut); // kits: attachments go with the message
      if (st.neutralChips) {
        const pe = TR.prog(t, T.expand[i], Ex.dur, Ex.ease);
        // tile → pill: the pill (fill, border and name together) wipes open to the right behind a soft edge
        const wFull = e.offsetWidth || sl.w, soft = Ex.soft_edge_px * Math.min(1, pe * 6);
        const wNow = tile + (wFull - tile) * pe;
        e.style.clipPath = `inset(0 ${Math.max(0, wFull - wNow - soft)}px 0 0 round 18px)`;
        e.style.webkitMaskImage = e.style.maskImage = soft > 0.5 ? `linear-gradient(90deg,#000 ${wNow}px,transparent ${wNow + soft}px)` : "";
        // the flying tile is a brighter glass square; it settles to the pill's own fill as it opens
        const tb = st.A.dark ? S.card.tile_bg_dark : S.card.tile_bg, pb = st.A.dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.10)";
        e.style.background = pe < 1 ? `color-mix(in srgb, ${tb} ${Math.round((1 - pe) * 100)}%, ${pb})` : "";
        const nm = st.chipNames[i];
        if (nm) nm.style.opacity = String(clamp(pe * 3, 0, 1));
      }
    });

    // ── camera
    const rest = Object.assign({}, C.rest, p.tilt || {});
    const en = C.entrance, cut = p.entrance === "cut";
    const qe = cut ? 1 : TR.prog(t, T.in + en.at, en.dur, en.ease), ue = 1 - qe;
    // per-parameter entrance tracks (round 3: fitted on the tracked pose; the settle tail is long)
    const noOver = !!(st.look && st.look.motion.entrance_no_overshoot); // round 4: Claude look, no overshoot (ease y in [0,1])
    const etr = (key) => {
      const tr = en.tracks && en.tracks[key];
      if (cut) return rest[key];
      if (!tr) return lerp(en.from[key], rest[key], qe);
      const e = noOver && tr.ease ? tr.ease.map((v, j) => (j % 2 ? clamp(v, 0, 1) : v)) : tr.ease;
      // round 4: the bigger Claude card starts the whip at the reference card's apparent size
      const from = key === "s" && st.look && st.look.motion.entrance_same_apparent_size ? Math.max(1, tr.from * scene.style.card.w / st.cardW) : tr.from;
      return lerp(from, rest[key], TR.prog(t, T.in + tr.at, tr.dur, e));
    };
    let s = etr("s"), tx = etr("tx"), ty = etr("ty"), rx = etr("rx"), ry = etr("ry"), rz = etr("rz");
    const pushQ = TR.prog(t, T.push, C.push.dur, C.push.ease);
    const LP = st.look && st.look.motion.push ? st.look.motion.push : null; // round 4: the Claude look has no push-in
    const pushTo = LP ? LP.s_to : C.push.s_to;
    let sPush = lerp(1, pushTo, pushQ);
    const sAtPull = lerp(1, pushTo, TR.prog(T.pull, T.push, C.push.dur, C.push.ease));
    if (t >= T.pull) sPush = lerp(sAtPull, C.pull.s_to, TR.prog(t, T.pull, T.pullDur, C.pull.ease));
    s *= sPush;
    // the push also drops the card slightly (tracked), returned by the pull
    {
      const pushAt = TR.prog(Math.min(t, T.pull), T.push, C.push.dur, C.push.ease);
      const back = t >= T.pull ? TR.prog(t, T.pull, T.pullDur, C.pull.ease) : 0;
      ty += ((LP ? LP.ty_add : C.push.ty_add) || 0) * pushAt * (1 - back);
    }
    // keep the growing card centred
    // kits with a thread (ChatGPT): at the send the basis moves from the typed box to the whole group (box + thread)
    // along the working growth, starting from the full typed box — a hard switch jumped 60 px and bounced back (round 3c)
    let basis = Hcur;
    if (st.look) {
      // round 4: centre the whole group (greeting + composer incl. its attachments); frozen from the click on
      basis = HgreetK + (st.greetEl ? (Number(st.greetEl.dataset.gap) + st.greetEl.offsetHeight) * k : 0);
    } else if (st.A.kit && st.HtextK != null) {
      if (st.conv || t < T.work) basis = st.HtextK;
      else {
        if (st.HtextFull == null && st.promptEl) {
          const keep = st.promptEl.textContent, hid = [...st.chipWraps, st.IT.inner.querySelector(".pc-xchips")].filter(Boolean).map((e) => [e, e.style.display]);
          hid.forEach(([e]) => (e.style.display = "none")); st.promptEl.textContent = p.prompt;
          st.HtextFull = st.IT.rootEl.offsetHeight * st.k;
          st.promptEl.textContent = keep; hid.forEach(([e, d]) => (e.style.display = d));
        }
        const W2 = K.working, gw2 = TR.prog(t, T.work, W2.grow_dur, W2.grow_ease);
        // Hcur is linear in the growth progress: aim straight at its end value so the box moves one way only
        const Hend = st.thread && !st.conv ? st.Hwork * st.k + st.thread._gap + st.thread._h : Hcur;
        basis = lerp(st.HtextFull != null ? st.HtextFull : st.HtextK, Hend, gw2);
      }
    }
    ty += s * (basis - st.H0) / 2 * C.center_on_card.k;
    if (!st.A.kit) ty += (K.working.ty_adjust_px || 0) * TR.prog(t, T.work + (K.working.grow_delay_s || 0), K.working.grow_dur, K.working.grow_ease);
    // MO05 result: pan up / pull back to the result panel, tilt bump
    if (st.conv) {
      // card → docked composer (screen space), tilt flattens; the conversation view comes in behind it
      const CV = K.conversation, qm = TR.prog(t, T.click + (CV.move_after_click_s || 0), CV.move_dur_s, CV.move_ease);
      if (t >= T.click && !st.clickRect && !st._inner) { st._inner = true; seek(st, T.click, scene); st.clickRect = st.bg.getBoundingClientRect(); st._inner = false; }
      if (t >= T.click && st.clickRect) {
        rx *= 1 - qm; ry *= 1 - qm; rz *= 1 - qm;
        st.convMove = qm;
      } else st.convMove = 0;
      seekConv(st, t, scene);
    } else if (T.result != null && st.msgMode) {
      // Claude-style result: the conversation view (kit.message) comes in around the sent card (same ease + tilt
      // language); the card sinks toward the docked composer and fades
      const M = K.message, qr = TR.prog(t, T.result, K.result.dur, K.result.ease);
      s *= lerp(1, M.card_to_scale, qr); ty += M.card_drop_px * qr;
      st.plane.style.opacity = String(1 - clamp((t - T.result) / M.card_out_s, 0, 1));
      seekMessage(st, t, scene, qr);
    } else if (T.result != null) {
      const Rk = K.result, qr = TR.prog(t, T.result, Rk.pan_dur || Rk.dur, Rk.pan_ease || Rk.ease);
      const sNow = s, sRes = Math.min(sNow, T.resS * rest.s);
      s = lerp(sNow, sRes, qr);
      const cardCy = st.cardBottom - Hcur / 2;
      ty = lerp(ty, (540 - C.origin[1]) + s * (C.origin[1] - T.resCy), qr);
      rx += (Rk.pan_tilt_rx != null ? Rk.pan_tilt_rx : Rk.tilt_rx) * Math.sin(Math.PI * qr);
      if (st.resWrap) {
        st.resWrap.style.opacity = String(clamp((t - T.result) / (Rk.panel_fade_s || 0.3), 0, 1));
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
    if (st.conv && st.convMove > 0 && st.clickRect) {
      // map the card's LIVE box (after this frame's camera) onto the docked composer, by the move progress
      st.exitWrap.style.transform = "";
      const r = st.bg.getBoundingClientRect(), D = st.dockRect, qm = st.convMove;
      const sc = lerp(1, D.w / r.width, qm);
      const bx = r.left + r.width / 2, by = r.bottom;           // anchor: bottom centre of the card
      st.exitWrap.style.transformOrigin = `${bx}px ${by}px`;
      st.exitWrap.style.transform = `translate(${(D.x + D.w / 2 - bx) * qm}px,${(D.y + D.h - by) * qm}px) scale(${sc})`;
      st.exitWrap.style.filter = "";
      st.exitWrap.style.opacity = String(1 - clamp((t - T.click - (K.conversation.move_after_click_s || 0) - K.conversation.move_dur_s + K.conversation.card_fade_s) / K.conversation.card_fade_s, 0, 1));
    }
    if (st.look && st.sendEl) { st.sendEl.style.transform = ""; st.sendEl.style.filter = ""; } // the cursor aims at the unpressed button
    if (st.cur) seekCursor(st, t, scene, s);
    if (st.look && st.sendEl && st.endOnClick && T.click != null) {
      // round 4: the send button's pressed state on the click (then released; the clip holds or docks)
      const PM = st.look.motion.press, PS = st.look.press;
      const a = TR.prog(t, T.click, PM.down_s, [0.2, 0.8, 0.5, 1.0]) * (1 - TR.prog(t, T.click + PM.down_s + PM.hold_s, PM.up_s, [0.4, 0.0, 0.2, 1.0]));
      st.sendEl.style.transform = a > 0 ? `scale(${lerp(1, PS.scale, a)})` : "";
      st.sendEl.style.filter = a > 0 ? `brightness(${lerp(1, PS.brightness, a)})` : "";
    }
  }

  // ───────────────────────── round 4: the Claude look's composer layout ─────────────────────────
  function nCharsAt(scene, st, t) {
    const T = st.tl, N = [...st.p.prompt].length;
    return t < T.type ? 0 : Math.round(N * TR.ease(scene.kf.typing.ease)(clamp((t - T.type) / Math.max(T.typeDur, 1e-3), 0, 1)));
  }
  function buildLook(scene, st) {
    const gap = Number(st.look.att_gap_css) || 8;
    st.attRow = st.IT.inner.querySelector(".pc-attrow");
    st.attBelow = st.look.att_below_css != null ? Number(st.look.att_below_css) : 12;
    let top = 0;
    st.lookRows = st.rows.map((r, ri) => {
      const h = Math.max(...r.items.map((i) => st.chipH[i] || 120));
      const row = { top: top + (ri ? gap : 0), h, gap: ri ? gap : 0, items: r.items };
      top = row.top + h;
      return row;
    });
    st.lookRoom = 0;
  }
  // after the timeline: row start times + the prompt's line-growth events (heights measured per typed prefix, with
  // the caret while it shows), so a new line opens over line_grow.dur instead of snapping
  function lookLines(scene, st) {
    const T = st.tl, K = scene.kf, el = st.promptEl;
    st.lookRows.forEach((r) => (r.start = Math.min(...r.items.map((i) => T.chip[i]))));
    st.lines = null;
    if (!el) return;
    const chars = [...st.p.prompt], N = chars.length;
    el.style.height = "";
    const hOf = (n, caret) => {
      el.textContent = chars.slice(0, n).join("");
      if (caret) el.appendChild(st.caretEl);
      const v = parseFloat(getComputedStyle(el).height);
      if (st.caretEl.isConnected) st.caretEl.remove();
      return v;
    };
    const withC = [];
    for (let n = 0; n <= N; n++) withC.push(hOf(n, true));
    const no0 = hOf(0, false), noN = hOf(N, false);
    el.textContent = "";
    const caretOff = Math.min(T.typeEnd + K.caret.hide_after_typing_s, T.work);
    const hAt = (t) => {
      const n = nCharsAt(scene, st, t);
      return t >= T.type && t < caretOff ? withC[n] : n === 0 ? no0 : n >= N ? noN : withC[n];
    };
    const ev = [], h0 = hAt(0);
    let prev = h0;
    const tEnd = Math.min(caretOff, T.typeEnd + 5) + 0.05;
    for (let t = 0; t <= tEnd; t += 1 / 240) { const h = hAt(t); if (Math.abs(h - prev) > 0.01) { ev.push({ t, dh: h - prev }); prev = h; } }
    st.lines = { h0, ev };
  }
  // sets the composer's DOM for time t (attachment room, typed text, prompt height); returns its natural height
  function lookLayout(st, t, scene) {
    const T = st.tl, LM = st.look.motion, p = st.p;
    const sent = st.conv && t >= T.work + scene.kf.working.text_out_s;
    let room = 0, q0 = 0;
    st.lookRows.forEach((r, ri) => { const q = TR.prog(t, r.start, LM.row_grow.dur, LM.row_grow.ease); if (!ri) q0 = q; room += q * (r.h + r.gap); });
    st.lookRoom = room;
    if (st.attRow) {
      st.attRow.style.display = sent ? "none" : "";
      st.attRow.style.height = room + "px";
      st.attRow.style.marginBottom = st.attBelow * q0 + "px";
    }
    const el = st.promptEl;
    if (el) {
      el.textContent = sent ? "" : [...p.prompt].slice(0, nCharsAt(scene, st, t)).join("");
      if (sent || !st.lines) el.style.height = "";
      else {
        let h = st.lines.h0;
        for (const e of st.lines.ev) h += e.dh * TR.prog(t, e.t, LM.line_grow.dur, LM.line_grow.ease);
        el.style.height = h + "px";
      }
    }
    return parseFloat(getComputedStyle(st.IT.rootEl).height);
  }

  // ── the cursor (end_on_click): prompt_menu's measured entry glide (kf.cursor_click.entry, t relative to the click,
  // dx/dy px from the rest point) landing on the send button; no press feedback (measured: none in prompt_menu)
  function seekCursor(st, t, scene, s) {
    const K = scene.kf, CC = K.cursor_click, T = st.tl, tab = CC.entry.table;
    const tr = t - T.click + tab[tab.length - 1][0];
    if (tr < tab[0][0] || !st.sendEl) { st.cur.style.visibility = "hidden"; return; }
    // (round 3c) after the click the cursor rides with the send button as the composer docks (it used to freeze in
    // screen space at the click: its glide tail went up while the card went down — a 4-5 px opposite motion)
    const convFade = st.conv && t > T.click ? 1 - clamp((t - T.click - 0.6) / 0.3, 0, 1) : 1;
    const r = st.sendEl.getBoundingClientRect();
    const d = r.width, rx = r.left + d / 2 + CC.end_offset_frac_of_button[0] * d, ry = r.top + r.height / 2 + CC.end_offset_frac_of_button[1] * d;
    let row = tab[tab.length - 1];
    for (let i = 0; i < tab.length - 1; i++) {
      if (tr <= tab[i + 1][0]) { const u = (tr - tab[i][0]) / (tab[i + 1][0] - tab[i][0]); row = tab[i].map((v, j) => lerp(v, tab[i + 1][j], u)); break; }
    }
    const sc = s * (scene.style.cursor.w / 64);
    let a = row[3];
    if (T.result != null) a *= 1 - clamp((t - T.result) / CC.fade_on_result_s, 0, 1);
    a *= convFade;
    st.cur.style.visibility = a > 0.001 ? "visible" : "hidden";
    st.cur.style.opacity = String(a);
    st.cur.style.transform = `translate(${rx + row[1] * sc - 8}px,${ry + row[2] * sc - 8}px) scale(${sc})`;
  }

  // ───────────────────────── MO05 in a kit's conversation view (kit.message; Claude) ─────────────────────────
  // Markdown → HTML for the REAL reply text (headings, paragraphs, lists, tables, bold/italic, inline code, fenced
  // code, rules). Nothing is added or reworded; links show their text. Each top-level block is one .pc-blk.
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function inline(s) {
    const codes = [];
    let h = esc(s).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="pc-link">$1</span>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
    return h.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
  }
  function mdToBlocks(md, opts) {
    const L = String(md).replace(/\r/g, "").split("\n"), out = [];
    let i = 0;
    const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
    while (i < L.length) {
      const l = L[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      const fence = l.match(/^```\s*([\w-]*)/);
      if (fence) {
        const body = []; i++;
        while (i < L.length && !/^```/.test(L[i])) body.push(L[i++]);
        i++;
        if (opts && opts.artifact && /^html?$/i.test(fence[1])) out.push(opts.artifact);
        else if (opts && opts.code && opts.code(fence[1], body.join("\n"))) out.push(opts.code(fence[1], body.join("\n")));
        else out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }
      const hd = l.match(/^(#{1,6})\s+(.*)$/);
      if (hd) { out.push(`<h${hd[1].length}>${inline(hd[2])}</h${hd[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^\s*\|/.test(l)) {
        const rows = [];
        while (i < L.length && /^\s*\|/.test(L[i])) rows.push(L[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
        out.push(`<table>${body.map((r, ri) => `<tr>${cells(r).map((c) => (ri === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("")}</table>`);
        continue;
      }
      if (isList(l)) {
        const ordered = /^\s*\d/.test(l), items = [];
        const start = ordered ? parseInt(l.trim(), 10) : 1;
        while (i < L.length && (isList(L[i]) || (/^\s{2,}\S/.test(L[i]) && items.length))) {
          const m = L[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m) items.push(`<li class="pc-ind${Math.min(2, Math.floor(m[1].length / 2))}">${inline(m[3])}</li>`);
          else items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, `<br>${inline(L[i].trim())}</li>`);
          i++;
          if (i < L.length && /^\s*$/.test(L[i]) && i + 1 < L.length && isList(L[i + 1]) && /^\s*\d/.test(L[i + 1]) === ordered) i++;
        }
        out.push(ordered ? `<ol start="${start}">${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }
      const para = [];
      while (i < L.length && !/^\s*$/.test(L[i]) && !/^```|^#{1,6}\s|^\s*\|/.test(L[i]) && !isList(L[i])) para.push(inline(L[i++]));
      out.push(`<p>${para.join("<br>")}</p>`);
    }
    return out.map((b) => `<div class="pc-blk">${b}</div>`).join("");
  }

  function buildMessage(root, scene, st) {
    const kit = scene.kit, M = kit.message, S = scene.style, r = st.p.result, cls = st.A.cls;
    const scope = (css) => String(css || "").replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) =>
      `${a} ${sel.split(",").map((s) => `.${cls} ${s.trim()}`).join(",")}{`);
    const art = r.kind === "artifact";
    const SM = S.message;
    TR.addCss(scope(M.css) + "\n" + scope(SM.md_css) + (art ? "\n" + scope(SM.artifact_css) : ""));
    const tok = Object.entries(Object.assign({}, kit.tokens || {}, M.tokens || {})).filter(([k2, v]) => k2.startsWith("--")).map(([k2, v]) => `${k2}:${v}`).join(";");
    const outer = TR.el("div", "position:absolute;left:0;top:0;width:1920px;height:1080px;opacity:0;transform-origin:960px 540px", root);
    // round 3: text replies are laid out with CSS zoom (crisp glyphs at screen size). A transform scale on top of the
    // kit's will-change layer rasterised the reply at 1× and upscaled it (Jake: "blurry"). The artifact view keeps the
    // round-2 path unchanged (Jake likes it as it is).
    const inner = TR.el("div", art ? `position:absolute;left:0;top:0;width:${M.view_w}px;height:${M.view_h}px;transform:scale(${1920 / M.view_w});transform-origin:0 0;${tok}`
      : `position:absolute;left:0;top:0;width:${M.view_w}px;height:${M.view_h}px;zoom:${1920 / M.view_w};${tok}`, outer);
    if (!art) TR.addCss(`.${cls} .clm-col{will-change:auto}`);
    inner.className = cls;
    let title = "";
    if (art) { const m = String(r.html).match(/<title>([^<]*)<\/title>/i); title = r.title || (m ? m[1].trim() : ""); }
    const card = art ? `<div class="pc-artcard"><span class="pc-artcard-ic">${SM.artifact_icon}</span><span><span class="pc-artcard-t">${esc(title)}</span><span class="pc-artcard-s">${esc(SM.artifact_kind_label)}</span></span></div>` : "";
    inner.innerHTML = TR.fill(M.html, { content_html: mdToBlocks(r.text || "", { artifact: card }), title: "", placeholder: M.placeholder,
      model_label: kit.model_label || "", disclaimer: M.disclaimer });
    const view = inner.firstElementChild;
    const msg = inner.querySelector(M.text_sel);
    if (msg) msg.classList.add("pc-md");
    let panel = null;
    if (art) {
      view.classList.add("pc-art");
      panel = TR.el("div", "", view);
      panel.className = "pc-artpanel";
      panel.innerHTML = `<div class="pc-arthead"><span class="pc-arttitle">${esc(title)}</span><span class="pc-arttabs"><span class="on">${esc(SM.artifact_tabs[0])}</span><span>${esc(SM.artifact_tabs[1])}</span></span></div>`;
      const fr = document.createElement("iframe");
      fr.className = "pc-artframe";
      fr.setAttribute("sandbox", "allow-scripts");
      fr.srcdoc = r.html; // the REAL generated HTML, rendered as-is
      panel.appendChild(fr);
    }
    st.msg = { outer, inner, view, panel, col: inner.querySelector(M.scroll_sel), blocks: msg ? [...msg.querySelectorAll(":scope > .pc-blk")] : [], maxScroll: null };
  }

  function seekMessage(st, t, scene, qr) {
    const K = scene.kf, M = K.message, KM = scene.kit.message, T = st.tl, m = st.msg;
    m.outer.style.opacity = String(clamp(qr * 1.6, 0, 1));
    m.outer.style.transform = qr < 1 ? `perspective(${K.camera.perspective_px}px) rotateX(${K.result.tilt_rx * (1 - qr)}deg) scale(${lerp(M.view_from_scale, 1, qr)})` : "";
    const r0 = T.result + M.reveal_at_s;
    m.blocks.forEach((b, i) => { b.style.opacity = String(clamp((t - r0 - i * M.block_stagger_s) / M.block_fade_s, 0, 1)); });
    if (m.maxScroll == null && m.col) {
      const top = parseFloat(getComputedStyle(m.col).top) || 0;
      m.maxScroll = Math.max(0, top + m.col.offsetHeight - (KM.dock_top - KM.after_text_gap));
    }
    if (m.col) {
      const sc = Math.min(m.maxScroll || 0, Math.max(0, t - T.result - M.scroll_after_s) * M.scroll_css_px_per_s);
      m.col.style.transform = `translateY(${-sc}px)`;
    }
    if (m.panel) {
      const qa = TR.prog(t, T.result + M.artifact_at_s, M.artifact_dur_s, K.result.ease);
      m.panel.style.transform = `translateX(${(1 - qa) * 100}%)`;
    }
  }

  // ───────────────────────── Claude conversation after send (round 3; kit.conversation recipe) ─────────────────────────
  function buildConv(root, scene, st) {
    const kit = scene.kit, M = kit.message, S = scene.style, cls = st.A.cls, p = st.p;
    const scope = (css) => String(css || "").replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) =>
      `${a} ${sel.split(",").map((s) => `.${cls} ${s.trim()}`).join(",")}{`);
    const R = kit.result;
    TR.addCss([M.css, R.user && R.user.css, R.text && R.text.css, kit.working && kit.working.css, kit.code && kit.code.css, S.message.md_css, S.conversation.css]
      .filter(Boolean).map(scope).join("\n"));
    const tok = Object.entries(Object.assign({}, kit.tokens || {}, kit.tokens_v2 || {}, M.tokens || {})).filter(([k2]) => k2.startsWith("--")).map(([k2, v]) => `${k2}:${v}`).join(";");
    // behind the card (the card docks INTO this view's composer)
    const outer = document.createElement("div");
    outer.style.cssText = "position:absolute;left:0;top:0;width:1920px;height:1080px;opacity:0";
    root.insertBefore(outer, st.exitWrap);
    const inner = TR.el("div", `position:absolute;left:0;top:0;width:${M.view_w}px;height:${M.view_h}px;zoom:${1920 / M.view_w};${tok}`, outer);
    inner.className = cls;
    inner.innerHTML = TR.fill(M.html, { content_html: "", title: "", placeholder: M.placeholder, model_label: kit.model_label || "", disclaimer: M.disclaimer });
    const col = inner.querySelector(M.scroll_sel);
    const msg = col.querySelector(M.text_sel); if (msg) msg.style.display = "none";
    const sp0 = col.querySelector(".clm-spark"); if (sp0) sp0.style.display = "none";
    const th = document.createElement("div"); th.className = "pc-conv"; col.prepend(th);
    // the user's turn: attachments (the kit's tiles) above the bubble, right-aligned
    const att = p.chips.length ? `<div class="pc-conv-att">${p.chips.map((c) => st.A.chipHtml(c)).join("")}</div>` : "";
    th.innerHTML = `<div class="pc-conv-user">${att}${TR.fill(R.user.html, { text: p.prompt, user_actions_html: "" })}</div>`;
    const work = TR.el("div", "", th); work.className = "pc-conv-work";
    const label = (kit.working && kit.working.texts && kit.working.texts.thinking) || "Thinking";
    work.innerHTML = kit.working ? TR.fill(kit.working.html, { text: label, sub: "" }) : "";
    let reply = null, words = [], tops = [];
    if (p.result && R.text) {
      reply = TR.el("div", "", th); reply.className = "pc-conv-reply";
      const code = (lang, body) => kit.code ? TR.fill(kit.code.html, { lang: lang || "", code_html: esc(body) }) : null;
      reply.innerHTML = TR.fill(R.text.html, { text_html: mdToBlocks(p.result.text, { code }) });
      const md = reply.querySelector(".clk-reply-md"); if (md) md.classList.add("pc-md");
      // words → spans (the stream reveals them in order; nothing is rewritten)
      const walker = document.createTreeWalker(md || reply, NodeFilter.SHOW_TEXT);
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const n of nodes) {
        if (!n.nodeValue) continue;
        const parts = n.nodeValue.split(/(\s+)/), frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
          const sp = document.createElement("span"); sp.textContent = part; frag.appendChild(sp); words.push(sp);
        }
        n.parentNode.replaceChild(frag, n);
      }
      const cr = col.getBoundingClientRect(), z = 1920 / M.view_w;
      tops = words.map((w) => { const r = w.getBoundingClientRect(); return (r.bottom - cr.top) / z; });
    }
    st.cv = { outer, col, user: th.querySelector(".pc-conv-user"), work, reply, words, tops, spark: reply ? reply.querySelector(".clk-reply-spark") : null,
      sweep: work.querySelector(".clk-work-title"), wspark: work.querySelector(".clk-work-spark"),
      visBottom: M.dock_top - M.after_text_gap - (parseFloat(getComputedStyle(col).top) || 96), shown: -1 };
    const z = 1920 / M.view_w, comp = kit.message.css.match(/\.clm-comp\{[^}]*left:([\d.]+)px;top:([\d.]+)px;[^}]*width:([\d.]+)px;height:([\d.]+)px/);
    const dockTop = Number((M.css.match(/\.clm-dock\{[^}]*top:([\d.]+)px/) || [, 750])[1]);
    st.dockRect = comp ? { x: Number(comp[1]) * z, y: (dockTop + Number(comp[2])) * z, w: Number(comp[3]) * z, h: Number(comp[4]) * z } : { x: 536.5, y: 914.6, w: 847, h: 121.5 };
  }

  function seekConv(st, t, scene) {
    const K = scene.kf, CV = K.conversation, T = st.tl, c = st.cv, kit = scene.kit;
    c.outer.style.opacity = String(clamp((t - T.click) / CV.view_in_s, 0, 1));
    const qu = TR.prog(t, T.click + CV.user_at_s, CV.user_in_s, K.result.ease);
    c.user.style.opacity = String(qu);
    c.user.style.transform = `translateY(${CV.user_rise_px * (1 - qu)}px)`;
    // working (spark + label with the kit's sweep) until the stream starts
    const w0 = T.click + CV.working_at_s, w1 = T.result != null ? T.result : 1e9;
    const wo = clamp((t - w0) / 0.2, 0, 1) * (1 - clamp((t - w1) / 0.15, 0, 1));
    c.work.style.opacity = String(wo);
    c.work.style.display = t >= w1 + 0.15 ? "none" : "";
    const sh = kit.working && kit.working.shimmer;
    if (sh && c.sweep) {
      const ph = ((t - w0) % sh.period_s + sh.period_s) % sh.period_s;
      c.sweep.style.setProperty(sh.var, `${lerp(parseFloat(sh.from), parseFloat(sh.to), clamp(ph / sh.sweep_s, 0, 1))}%`);
    }
    const rot = `${((t - T.click) / CV.spark_period_s) * 360}deg`;
    if (c.wspark) c.wspark.style.setProperty("--cl-spark-rot", rot);
    // the REAL reply streams word by word; the newest ~10 characters sit at the kit's tail opacity (clip 6)
    if (c.reply) {
      const n = t < T.result ? 0 : Math.min(c.words.length, Math.floor((t - T.result) * CV.stream_wps));
      if (n !== c.shown) {
        let tailChars = 0;
        const tailN = kit.result.text.stream ? kit.result.text.stream.tail_chars : 10;
        for (let i = 0; i < c.words.length; i++) {
          const w = c.words[i];
          if (i >= n) { w.style.display = "none"; continue; }
          w.style.display = "";
          w.classList.remove("clk-tail");
        }
        for (let i = n - 1; i >= 0 && tailChars < tailN && n < c.words.length; i--) { c.words[i].classList.add("clk-tail"); tailChars += c.words[i].textContent.length + 1; }
        // blocks with nothing revealed yet are hidden (no empty code frames / bullets ahead of the stream)
        c.reply.querySelectorAll(".pc-blk").forEach((b) => { b.style.display = b.querySelector("span:not([style*='none'])") ? "" : "none"; });
        c.shown = n;
      }
      c.reply.style.display = t >= T.result ? "" : "none";
      if (c.spark) c.spark.style.setProperty("--cl-spark-rot", rot);
      // keep the stream's end above the dock: target from the precomputed word bottoms, smoothed over a window
      const target = (tt) => {
        const k = tt < T.result ? 0 : Math.min(c.words.length, (tt - T.result) * CV.stream_wps);
        if (k <= 0) return 0;
        const i = Math.min(c.tops.length - 1, Math.floor(k));
        return Math.max(0, c.tops[i] + CV.spark_room_css - c.visBottom);
      };
      let acc = 0; const N = 8;
      const t0s = T.click + (CV.move_after_click_s || 0) + CV.move_dur_s + (CV.scroll_after_dock_s || 0);
      for (let j = 0; j < N; j++) { const tj = t - (CV.scroll_smooth_s * j) / (N - 1); acc += tj < t0s ? 0 : target(tj); }
      c.col.style.transform = `translateY(${-acc / N}px)`;
    }
  }

  window.__TEMPLATES["prompt_card_3d"] = { build, seek, timeline };
})();
