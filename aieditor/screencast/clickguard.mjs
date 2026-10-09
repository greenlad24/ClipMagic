// CLICK GUARD — the hard rules live in the code that clicks (architecture recommendation §3.7; RULEBOOK
// L4 / R10). Every recorder (agent_rec.mjs, vrecord.mjs, record.mjs) asks check() before a click, a
// double click, Enter on a focused control, a goto / open / reload, and typing into a payment field.
// The rules are DATA (clickguard.rules.json), shared word for word with aieditor/clickguard.py.
//
//   check(action, target, session) → { ok: true } | { ok: false, refused: "deny:<rule>", why }
//     action  { type, url?, goto?, key?, text?, target? }      (agent_rec actions / script steps)
//     target  { text, aria, title, testid, name, value, role, alt, href, autocomplete, id, placeholder, type }
//     session "logged_in" (a Scout copy: never pricing, billing, checkout, log out) | "outside" (a fresh,
//             never-logged-in Chrome: pricing is its job, but no log in, sign up, buy, subscribe, checkout)
//
// A refusal is a BEAT FAILURE: the caller reports it and never retries the same action. There is no
// action type for logging out anywhere, and an action type that names one is itself refused.
import fs from "node:fs";

export const RULES = JSON.parse(fs.readFileSync(new URL("./clickguard.rules.json", import.meta.url), "utf8"));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function phraseRe(p) {
  const words = String(p).toLowerCase().trim().split(/[\s_-]+/).filter(Boolean).map(esc);
  return new RegExp(`(?<![a-z0-9])${words.join("[\\s_-]*")}(?![a-z0-9])`, "i");
}
const RE = new Map();
const re = (p) => { if (!RE.has(p)) RE.set(p, phraseRe(p)); return RE.get(p); };
const reG = (p) => new RegExp(re(p).source, "gi");

export function normSession(s) {
  return ["outside", "public", "visitor"].includes(String(s || "").toLowerCase()) ? "outside" : "logged_in";
}

// the strings of a target the label rules look at (a long text is content, not a control's name)
export function labelsOf(target, action = {}) {
  const out = [];
  const t = target || {};
  for (const f of RULES.label_fields) {
    let v = t[f];
    if (v == null || v === "") continue;
    v = String(v).replace(/\s+/g, " ").trim();
    if (f === "text" && v.length > RULES.max_text_len) {
      v = String(t[f]).split("\n")[0].trim();
      if (v.length > RULES.max_text_len) continue;
    }
    out.push(v);
  }
  // the action's own wording: {target:"Log out"} / {text:"Share"} on a click
  if (action.target && typeof action.target === "string") out.push(action.target);
  if (action.text && action.type !== "type") out.push(String(action.text));
  if (action.click && typeof action.click === "object" && action.click.text) out.push(String(action.click.text));
  return out;
}

export function matchLabel(strings, deny, allow) {
  for (let s of strings) {
    s = String(s).toLowerCase();
    for (const a of allow) s = s.replace(reG(a), " ");
    for (const d of deny) if (re(d).test(s)) return d;
  }
  return null;
}

function segs(s) { return String(s || "").toLowerCase().split("/").map((x) => x.trim()).filter(Boolean); }
function contains(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((n, k) => hay[i + k] === n)) return true;
  return false;
}
export function parseUrl(u) {
  try { const x = new URL(u, "https://relative.invalid/"); return { host: x.hostname.toLowerCase(), path: x.pathname, frag: x.hash.replace(/^#\/?/, "") }; }
  catch { return { host: "", path: String(u), frag: "" }; }
}
export function matchUrl(url, rules) {
  if (!url) return null;
  const { host, path, frag } = parseUrl(url);
  for (const h of RULES.deny_hosts) if (host === h || host.endsWith("." + h)) return h;
  const p = segs(decodeURIComponent(path)), f = segs(decodeURIComponent(frag));
  for (const r of rules) {
    if (r.startsWith("#")) { if (contains(f, segs(r.slice(1)))) return r; }
    else if (contains(p, segs(r)) || contains(f, segs(r))) return r;
  }
  return null;
}

const ENTER = new Set(["enter", "numpadenter", " ", "space"]);
const refuse = (rule, why) => ({ ok: false, refused: `deny:${rule}`, why });

export function check(action, target = null, session = "logged_in") {
  const a = action || {};
  // an agent_rec action has a string type; a recorder script step is keyed ({goto}, {click}, {type: {...}})
  const type = (typeof a.type === "string" ? a.type
    : a.goto ? "goto" : a.click ? "click" : a.key ? "key" : a.type ? "type" : "").toLowerCase();
  const sess = normSession(session);
  for (const w of RULES.forbidden_action_words) {
    if (re(w).test(type)) return refuse("action-type", `no action may log out ("${a.type}")`);
  }
  const urlRules = sess === "outside" ? RULES.deny_urls_outside : RULES.deny_urls_logged_in;
  const labelRules = sess === "outside" ? [...RULES.deny_labels, ...RULES.outside_deny_labels] : RULES.deny_labels;
  const urls = [];
  if (["goto", "open", "reload"].includes(type)) urls.push(a.url ?? a.goto);
  if (typeof a.goto === "string" && !urls.includes(a.goto)) urls.push(a.goto);   // a click's forced destination
  if (["click", "dblclick", "key"].includes(type) && target?.href) urls.push(target.href);
  for (const u of urls) {
    const hit = matchUrl(u, urlRules);
    if (hit) return refuse(hit, `${sess === "outside" ? "the outside view" : "a logged-in browser"} never opens ${u}`);
  }
  if (["click", "dblclick"].includes(type) || (type === "key" && ENTER.has(String(a.key || "").toLowerCase()))) {
    const hit = matchLabel(labelsOf(target, type === "key" ? {} : a), labelRules, RULES.allow_labels);
    if (hit) return refuse(hit, `"${hit}" is never pressed (${sess})`);
  }
  if (type === "type" && target) {
    const f = [target.autocomplete, target.name, target.id, target.placeholder, target.aria, target.label, target.type]
      .filter(Boolean).map(String);
    if (matchLabel(f, RULES.payment_input, [])) return refuse("payment-input", "nothing is typed into a payment field");
  }
  return { ok: true };
}

// Runs IN THE PAGE (page.evaluate(describeInPage, q)): the element a click / key would hit, as check()'s
// target. q = {ref} (agent_rec's data-agent-ref) | {x, y} CSS px | {focused: true} | {selector}.
export function describeInPage(q) {
  let el = null;
  try {
    if (q.ref) el = document.querySelector(`[data-agent-ref="${q.ref}"]`);
    else if (q.selector) el = document.querySelector(q.selector);
    else if (q.focused) el = document.activeElement;
    else if (q.x != null) el = document.elementFromPoint(q.x, q.y);
  } catch (e) { el = null; }
  if (!el || el === document.body || el === document.documentElement) return null;
  const ctl = el.closest("a,button,[role=button],[role=menuitem],[role=link],[role=tab],[role=option],input,select,textarea,label") || el;
  const a = (ctl.closest && ctl.closest("a")) || null;
  const g = (e, k) => (e && e.getAttribute && e.getAttribute(k)) || "";
  return {
    tag: (ctl.tagName || "").toLowerCase(), text: (ctl.innerText || ctl.textContent || "").trim().slice(0, 400),
    aria: g(ctl, "aria-label") || g(el, "aria-label"), title: g(ctl, "title") || g(el, "title"),
    testid: g(ctl, "data-testid") || g(el, "data-testid"), name: g(ctl, "name"),
    value: ctl.tagName === "INPUT" && /^(submit|button)$/i.test(ctl.type || "") ? ctl.value : "",
    role: g(ctl, "role"), alt: g(el, "alt"), href: a ? a.href : "", autocomplete: g(ctl, "autocomplete"),
    id: ctl.id || "", placeholder: g(ctl, "placeholder"), type: g(ctl, "type"),
  };
}
