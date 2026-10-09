// PRIVACY BOXES FROM THE PAGE (RULEBOOK C7, Jake 2026-10-09): what the page itself says is private.
//
//   privacyBoxes(page, extraSelectors, scale) -> [{x, y, w, h, kind}]   capture px (CSS px × scale)
//   privacySampler({ scale, extra, every })   -> { tick(page, videoT), samples, flush(file, offsetS) }
//
// Boxes: input[type=password], input[type=email], [autocomplete*=email|cc-|tel], inputs/textareas whose
// VALUE is an email or a key, elements whose OWN text holds an email or a key (the exact text range,
// not the whole element), and the playbook's private_selectors (e.g. the account menu's email).
// "Jake Dawson" (the display name) is not private (ruled 2026-10-08); his email is.
//
// The recorders sample this every 0.25 s of RECORDED time while a segment records and write
// rec/privacy.json [{t, boxes}] in events.json's clock + coordinates; screencast/privacy.py merges it
// with OCR and blurs raw.mp4 before the camera. A failing evaluate never stops a recording: [] instead.
import fs from "node:fs";

export const PRIVATE_CSS = [
  "input[type=password]", "input[type=email]", "[autocomplete*=email]", "[autocomplete^='cc-']",
  "[autocomplete*=' cc-']", "[autocomplete*=tel]", "input[type=tel]",
];

// evaluated in the page (no closures over module scope)
function inPage(css, extra) {
  const EMAIL = /[A-Za-z0-9][A-Za-z0-9._%+\-]*@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g;
  const KEY = /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,})|(?:\b(?:api[ _-]?key|key|token|secret|bearer)\b[\s:="'`]{0,4})([A-Za-z0-9_\-.+\/=]{32,})/gi;
  const VW = innerWidth, VH = innerHeight;
  const out = [];
  const push = (r, kind) => {
    if (!r || r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= VH || r.left >= VW) return;
    out.push({ x: r.left, y: r.top, w: r.width, h: r.height, kind });
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05;
  };
  for (const [sel, kind] of [...css.map((c) => [c, "field"]), ...extra.map((c) => [c, "playbook"])]) {
    let els = [];
    try { els = document.querySelectorAll(sel); } catch { continue; }
    for (const el of els) {
      if (!visible(el)) continue;
      const k = kind === "field" ? (el.type === "password" ? "password" : el.type === "email" || /email/i.test(el.autocomplete || "") ? "email"
        : /tel/i.test(el.type + (el.autocomplete || "")) ? "phone" : "card") : kind;
      push(el.getBoundingClientRect(), k);
    }
  }
  // field values (an API key pasted into a plain text input)
  for (const el of document.querySelectorAll("input, textarea")) {
    const v = el.value || "";
    if (v.length < 6 || !visible(el)) continue;
    EMAIL.lastIndex = 0; KEY.lastIndex = 0;
    if (EMAIL.test(v)) push(el.getBoundingClientRect(), "email");
    else if (KEY.test(v)) push(el.getBoundingClientRect(), "key");
  }
  // own text: the matched range only (a long message bubble is not blurred whole)
  const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let n = 0;
  for (let node = tw.nextNode(); node && n < 50000; node = tw.nextNode(), n++) {
    const s = node.nodeValue;
    if (!s || s.length < 6 || (s.indexOf("@") < 0 && !/sk-|key|token|secret|bearer|ghp_|xox|AKIA|AIza/i.test(s))) continue;
    const el = node.parentElement;
    if (!el || !visible(el)) continue;
    for (const [re, kind] of [[EMAIL, "email"], [KEY, "key"]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        const a = m[1] ? m.index + m[0].lastIndexOf(m[1]) : m.index;
        try {
          range.setStart(node, a); range.setEnd(node, m.index + m[0].length);
          for (const r of range.getClientRects()) push(r, kind);
        } catch {}
      }
    }
  }
  return out;
}

export async function privacyBoxes(page, extraSelectors = [], scale = 1) {
  try {
    const raw = await Promise.race([
      page.evaluate(inPage, PRIVATE_CSS, (extraSelectors || []).filter((s) => typeof s === "string" && s)),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
    ]);
    const seen = new Set();
    return raw.map((b) => ({ x: Math.round(b.x * scale), y: Math.round(b.y * scale), w: Math.round(b.w * scale),
      h: Math.round(b.h * scale), kind: b.kind })).filter((b) => {          // a field found twice = one box
      const k = `${b.x},${b.y},${b.w},${b.h}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  } catch {
    return [];
  }
}

// selectors from the app's playbook (p2: playbook.private_selectors), passed by the job as JSON
export function privateSelectors(fromScript) {
  if (Array.isArray(fromScript)) return fromScript;
  try { const v = JSON.parse(process.env.AGENT_PRIVATE_SELECTORS || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

// one sampler per recorded segment: tick() on every recorded frame (it samples when the recorded clock
// crosses the next 0.25 s), flush() writes privacy.json with t = video seconds − offset (vrecord's pre-frames)
export function privacySampler({ scale = 1, extra = [], every = 0.25 } = {}) {
  const samples = [];
  let next = 0;
  return {
    samples,
    async tick(page, videoT) {
      if (videoT + 1e-6 < next) return;
      next = Math.floor(videoT / every + 1e-6) * every + every;
      samples.push({ t: videoT, boxes: await privacyBoxes(page, extra, scale) });
    },
    flush(file, offsetS = 0) {
      fs.writeFileSync(file, JSON.stringify(samples.map((s) => ({ t: +(s.t - offsetS).toFixed(4), boxes: s.boxes }))));
    },
  };
}
