/*
 * prompt_menu (MO03) — a composer's "/" menu: the cursor glides in, hovers down the rows (each row highlights and
 * the composer previews "/<row>"), clicks the picked row, the menu shrinks away while the composer re-centres and
 * shows the committed "/<row>", then the cursor travels to the send button.
 * Reference: /opt/aieditor-work/reference/motion-2026-10-09/motion3.mp4 (spec: reference-specs/prompt_menu.md).
 *
 * Motion = scene.kf (prompt_menu.kf.json, measured), look = scene.style (prompt_menu.style.json) or scene.kit
 * (a real app's UI kit; null = the neutral box, the reference's own design).
 *
 * params: items [{label, icon?}] | [string] (3-8), pick (index), trigger "/", menu_title "Skills",
 *         placeholder_prefix "/", after_label "Add context", footer_label "All sources", backdrop true, cursor true
 * beats:  in, hover_<i> (optional), pick, out
 */
(function () {
  "use strict";
  const TR = window.__TR;

  const SVG = {
    lib: (c, w) => `<svg viewBox="0 0 37 32" width="100%" height="100%" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="29" rx="2.2"/><rect x="10.5" y="1.5" width="9" height="29" rx="2.2"/><path d="M20.3 4.2 L26.2 2.1 Q28 1.5 28.7 3.3 L35.4 26.6 Q35.9 28.5 34.1 29.1 L30.4 30.3 Q28.6 30.9 28 29.1 Z"/></svg>`,
    plus: (c, w) => `<svg viewBox="0 0 29 30" width="100%" height="100%" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"><path d="M14.5 1.5v27M1.5 15h26"/></svg>`,
    clip: (c, w) => `<svg viewBox="2.2 1.6 19.6 21.6" width="100%" height="100%" fill="none" stroke="${c}" stroke-width="${w / 2}" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
    globe: (c, w) => `<svg viewBox="1 1 22 22" width="100%" height="100%" fill="none" stroke="${c}" stroke-width="${w / 2}" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`,
    at: (c) => `<svg viewBox="1.5 1.5 21 21" width="100%" height="100%" fill="none" stroke="${c}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>`,
    arrow: (c, w, h) => `<svg viewBox="0 0 40 ${h}" width="40" height="${h}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"><path d="M20 ${h - 3}V3M5 18 20 3l15 15"/></svg>`,
  };
  const CURSOR_PTS = "0,0 0,88 21,69 40,103 53,97 36,62 64,61";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Row icons: small flat inline SVGs in the spirit of the reference's colour emoji (no emoji font is shipped).
  // name → svg body (viewBox 0 0 24 24). Aliases below. An item icon may also be inline <svg>, or "none".
  const IC = {
    mic: '<rect x="6.5" y="1" width="11" height="14" rx="5.5" fill="#a3a9af"/><rect x="6.5" y="1" width="11" height="14" rx="5.5" fill="none" stroke="#4b4f54" stroke-width="1"/><path d="M7.4 4h9.2M6.8 6.5h10.4M6.8 9h10.4M6.8 11.5h10.4M7.6 14h8.8" stroke="#4b4f54" stroke-width=".9"/><path d="M10.2 15h3.6v4h-3.6z" fill="#6b7075"/><path d="M7 21.5h10" stroke="#4b4f54" stroke-width="2.2" stroke-linecap="round"/><path d="M12 19v2.5" stroke="#4b4f54" stroke-width="1.8"/>',
    cabinet: '<rect x="2.5" y="1" width="19" height="22" rx="2" fill="#7d8389"/><rect x="4.2" y="2.7" width="15.6" height="8.6" rx="1" fill="#a9afb5"/><rect x="4.2" y="12.7" width="15.6" height="8.6" rx="1" fill="#a9afb5"/><rect x="9" y="5.6" width="6" height="2" rx=".6" fill="#4b4f54"/><rect x="9" y="15.6" width="6" height="2" rx=".6" fill="#4b4f54"/>',
    search: '<path d="M10.2 13.8 3.2 20.8" stroke="#3b3f44" stroke-width="3.2" stroke-linecap="round"/><circle cx="14.5" cy="9.5" r="6.6" fill="#cfe6f5" stroke="#4b4f54" stroke-width="2"/><path d="M11.5 7.2a3.6 3.6 0 0 1 3-1.7" stroke="#fff" stroke-width="1.4" stroke-linecap="round" fill="none"/>',
    rocket: '<path d="M7.5 16.5c-2 .2-3.6 1.8-4 6 4.2-.4 5.8-2 6-4z" fill="#f59f1b"/><path d="M5.5 13.5 2 12.5l3.5-4.3 4 .3zM10.5 18.5l1 3.5 4.3-3.5-.3-4z" fill="#d93a2b"/><path d="M6.5 15.2 8.8 17.5c5.8-2.4 11.7-8.6 13.2-16-7.4 1.5-13.6 7.4-15.5 13.7z" fill="#e6e9ec" stroke="#8a9096" stroke-width=".8"/><circle cx="15.2" cy="8.8" r="2.3" fill="#3d8fd8" stroke="#55606a" stroke-width=".9"/>',
    mail: '<rect x="1.5" y="5" width="21" height="14" rx="1.6" fill="#eef1f4" stroke="#b7bec5" stroke-width=".9"/><path d="M1.8 5.5 12 13l10.2-7.5" fill="none" stroke="#b7bec5" stroke-width=".9"/><rect x="9.2" y="8.2" width="5.6" height="8" rx=".8" fill="#5b9be0"/><path d="M13.3 9.8h-2.6v4.8h2.6M10.7 12.2h2.2" stroke="#fff" stroke-width="1.1" fill="none"/>',
    doc: '<path d="M5 1.5h9.5L19 6v16.5H5z" fill="#fff" stroke="#9aa0a6" stroke-width="1"/><path d="M14.5 1.5V6H19" fill="#e3e6e9" stroke="#9aa0a6" stroke-width="1"/><path d="M8 10h8M8 13h8M8 16h8M8 19h5" stroke="#9aa0a6" stroke-width="1.1"/>',
    chart: '<rect x="2" y="2" width="20" height="20" rx="2.5" fill="#fff" stroke="#c4c9ce" stroke-width="1"/><rect x="5" y="12" width="3.4" height="7" fill="#e5533d"/><rect x="10.3" y="7" width="3.4" height="12" fill="#3d8fd8"/><rect x="15.6" y="10" width="3.4" height="9" fill="#38b26a"/>',
    calendar: '<rect x="2.5" y="3.5" width="19" height="18" rx="2" fill="#fff" stroke="#c4c9ce" stroke-width="1"/><path d="M2.5 5.5a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2V9h-19z" fill="#e5533d"/><text x="12" y="19" font-size="8.5" font-family="Inter,sans-serif" font-weight="700" fill="#3b3f44" text-anchor="middle">17</text>',
    bolt: '<path d="M14 1.5 4.5 13.5h6l-1.5 9 10-12.5h-6.2z" fill="#f7c21b" stroke="#d99a06" stroke-width=".8" stroke-linejoin="round"/>',
    star: '<path d="m12 2 2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8L2.2 9.1l6.9-.8z" fill="#f7c21b" stroke="#d99a06" stroke-width=".8" stroke-linejoin="round"/>',
    code: '<rect x="3" y="4" width="18" height="12" rx="1.5" fill="#3b3f44"/><rect x="4.5" y="5.5" width="15" height="9" fill="#5b9be0"/><path d="M1 18h22l-1.5 2.5h-19z" fill="#9aa0a6"/><path d="m9.5 8-2 2 2 2M14.5 8l2 2-2 2" stroke="#fff" stroke-width="1.2" fill="none"/>',
    chat: '<path d="M3 4.5h18a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H10l-5 4v-4H3A1.5 1.5 0 0 1 1.5 16V6A1.5 1.5 0 0 1 3 4.5z" fill="#e9eef3" stroke="#9aa6b2" stroke-width="1"/><circle cx="7.5" cy="11" r="1.3" fill="#7d8389"/><circle cx="12" cy="11" r="1.3" fill="#7d8389"/><circle cx="16.5" cy="11" r="1.3" fill="#7d8389"/>',
    image: '<rect x="2" y="4" width="20" height="16" rx="1.5" fill="#c58b4a"/><rect x="3.8" y="5.8" width="16.4" height="12.4" fill="#bfe0f7"/><path d="m3.8 18.2 5-6 3.5 4 2.5-2.5 5.4 4.5z" fill="#4caf6a"/><circle cx="16" cy="9" r="1.7" fill="#f7c21b"/>',
    video: '<rect x="2.5" y="9" width="19" height="12" rx="1" fill="#3b3f44"/><path d="m2.5 5.5 18-3.5.8 3.5-18 3.5z" fill="#3b3f44"/><path d="m6 4.8 2 3M11 3.8l2 3M16 2.9l2 3" stroke="#fff" stroke-width="1.3"/>',
    gear: '<path d="M10.3 1.8h3.4l.5 2.8 2 .9 2.4-1.6 2.4 2.4-1.6 2.4.9 2 2.8.5v3.4l-2.8.5-.9 2 1.6 2.4-2.4 2.4-2.4-1.6-2 .9-.5 2.8h-3.4l-.5-2.8-2-.9-2.4 1.6-2.4-2.4 1.6-2.4-.9-2-2.8-.5v-3.4l2.8-.5.9-2-1.6-2.4 2.4-2.4 2.4 1.6 2-.9z" fill="#9aa0a6"/><circle cx="12" cy="12" r="3.6" fill="#fff"/>',
    user: '<circle cx="12" cy="8" r="4.8" fill="#7d8389"/><path d="M3 22c0-5 4-8 9-8s9 3 9 8z" fill="#7d8389"/>',
    folder: '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h6l2 2.5h9A1.5 1.5 0 0 1 22 8v11.5a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 19.5z" fill="#5b9be0"/><path d="M2 9h20v10.5a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 19.5z" fill="#79b2ec"/>',
    check: '<rect x="2" y="2" width="20" height="20" rx="4" fill="#38b26a"/><path d="m6.5 12.5 3.5 3.5 7.5-8" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    pen: '<path d="M16.5 2.5 21.5 7.5 8.5 20.5 3.5 21l.5-5z" fill="#f7c21b" stroke="#c48a06" stroke-width=".8"/><path d="m16.5 2.5 5 5-2 2-5-5z" fill="#e5733d"/><path d="m4 16 4.5 4.5-5 .5z" fill="#f2d3a2"/>',
    globe: '<circle cx="12" cy="12" r="10" fill="#5b9be0"/><path d="M7 6c2 1 2 3 0 4.5s-1 4 1.5 4.5 1 4 2.5 6M15 3.5c-1 2 1 3 3 3s2 3 .5 4.5-1 4 1.5 4" fill="none" stroke="#4caf6a" stroke-width="2.6" stroke-linecap="round"/>',
    idea: '<path d="M12 1.8a7 7 0 0 0-4 12.7V17h8v-2.5a7 7 0 0 0-4-12.7z" fill="#f7d33b" stroke="#d99a06" stroke-width=".8"/><rect x="8.3" y="17.6" width="7.4" height="3" rx=".8" fill="#9aa0a6"/><path d="M10 22.3h4" stroke="#7d8389" stroke-width="1.6" stroke-linecap="round"/>',
    book: '<path d="M4 3.5A1.5 1.5 0 0 1 5.5 2H20v17H5.5A1.5 1.5 0 0 0 4 20.5z" fill="#3d7fd0"/><path d="M4 20.5A1.5 1.5 0 0 1 5.5 19H20v3H5.5A1.5 1.5 0 0 1 4 20.5z" fill="#eef1f4" stroke="#9aa6b2" stroke-width=".7"/><rect x="8" y="6" width="8" height="2.2" rx=".5" fill="#a9cbf2"/>',
    megaphone: '<path d="M3 9.5h4l10-6v17l-10-6H3z" fill="#e5533d"/><path d="M5 14.5l1.5 6h3l-1-6z" fill="#b8392a"/><path d="M19.5 9.5c1.3 1.3 1.3 3.7 0 5" stroke="#9aa0a6" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    target: '<circle cx="12" cy="12" r="10" fill="#e5533d"/><circle cx="12" cy="12" r="7" fill="#fff"/><circle cx="12" cy="12" r="4" fill="#e5533d"/><circle cx="12" cy="12" r="1.5" fill="#fff"/>',
    sparkles: '<path d="m10 3 1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8zM18 13l.9 2.6 2.6.9-2.6.9L18 20l-.9-2.6-2.6-.9 2.6-.9z" fill="#f7c21b"/>',
    money: '<path d="M8.5 4h7l-2 3.5h-3z" fill="#4caf6a"/><path d="M10.5 7.5h3c4 2.5 7 6.5 7 10a4 4 0 0 1-4 4h-5a4 4 0 0 1-4-4c0-3.5 3-7.5 3-10z" fill="#5cc27e"/><text x="12" y="18.5" font-size="8" font-family="Inter,sans-serif" font-weight="700" fill="#fff" text-anchor="middle">$</text>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L11.8 5.8M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4" fill="none" stroke="#7d8389" stroke-width="2.4" stroke-linecap="round"/>',
    lock: '<path d="M7 10V7.5a5 5 0 0 1 10 0V10" fill="none" stroke="#9aa0a6" stroke-width="2.4"/><rect x="4" y="10" width="16" height="12" rx="2" fill="#f7c21b"/><circle cx="12" cy="15.5" r="1.8" fill="#8a6500"/>',
    robot: '<path d="M12 1.5v3" stroke="#7d8389" stroke-width="1.6"/><circle cx="12" cy="1.8" r="1.3" fill="#e5533d"/><rect x="3.5" y="5" width="17" height="14" rx="3.5" fill="#b7bec5"/><rect x="6" y="8" width="12" height="6.5" rx="2" fill="#3b3f44"/><circle cx="9.3" cy="11.2" r="1.4" fill="#6fd0ff"/><circle cx="14.7" cy="11.2" r="1.4" fill="#6fd0ff"/><rect x="8.5" y="16.3" width="7" height="1.4" rx=".7" fill="#7d8389"/>',
    home: '<path d="M2.5 11.5 12 3l9.5 8.5" fill="none" stroke="#b8392a" stroke-width="2.2" stroke-linejoin="round"/><path d="M5 10.5 12 4.5l7 6V21H5z" fill="#f2d3a2"/><rect x="10" y="14.5" width="4" height="6.5" fill="#8a5a2b"/>',
    trophy: '<path d="M7 3h10v6a5 5 0 0 1-10 0z" fill="#f7c21b"/><path d="M7 5H3.5c0 3 1.5 5 3.8 5.3M17 5h3.5c0 3-1.5 5-3.8 5.3" fill="none" stroke="#d99a06" stroke-width="1.5"/><rect x="10.8" y="13.5" width="2.4" height="4" fill="#d99a06"/><rect x="7.5" y="17.5" width="9" height="3.5" rx=".8" fill="#8a5a2b"/>',
    clipboard: '<rect x="4" y="3.5" width="16" height="19" rx="1.8" fill="#c58b4a"/><rect x="6" y="6" width="12" height="14.5" fill="#fff"/><rect x="8.5" y="2" width="7" height="3.5" rx="1" fill="#9aa0a6"/><path d="M8.5 10h7M8.5 13h7M8.5 16h5" stroke="#9aa0a6" stroke-width="1.1"/>',
    tag: '<path d="M2.5 3.5v8l10 10 9-9-10-10h-8z" fill="#f2c27a" stroke="#c48a06" stroke-width=".8"/><circle cx="7" cy="7.5" r="1.7" fill="#fff" stroke="#c48a06" stroke-width=".8"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3" fill="#7d8389"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5c0 1.7-3.6 3-8 3S4 6.7 4 5z" fill="#9aa0a6"/><path d="M4 10c0 1.7 3.6 3 8 3s8-1.3 8-3M4 15c0 1.7 3.6 3 8 3s8-1.3 8-3" fill="none" stroke="#6b7075" stroke-width=".9"/>',
    music: '<path d="M9 18V5l11-2.5v13" fill="none" stroke="#3d7fd0" stroke-width="2"/><ellipse cx="6.5" cy="18.5" rx="3.3" ry="2.6" fill="#3d7fd0"/><ellipse cx="17.5" cy="16" rx="3.3" ry="2.6" fill="#3d7fd0"/>',
    phone: '<rect x="6" y="1.5" width="12" height="21" rx="2.5" fill="#3b3f44"/><rect x="7.5" y="4" width="9" height="15" fill="#79b2ec"/><circle cx="12" cy="20.8" r=".9" fill="#9aa0a6"/>',
    cart: '<path d="M1.5 3h3l2.5 12h12l2.5-8.5H6" fill="none" stroke="#7d8389" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.4 7.5h14l-2 6.5H7.7z" fill="#b7bec5"/><circle cx="9" cy="19.5" r="1.8" fill="#3b3f44"/><circle cx="17" cy="19.5" r="1.8" fill="#3b3f44"/>',
    brain: '<path d="M12 4c-1-2-5-2-6 0-2.5 0-3.5 2.5-2.5 4.5C1.5 10 2 14 4 14.5c-.5 2.5 1.5 4.5 4 4 1 2 3 2 4 .5 1 1.5 3 1.5 4-.5 2.5.5 4.5-1.5 4-4 2-.5 2.5-4.5.5-6 1-2 0-4.5-2.5-4.5-1-2-5-2-6 0z" fill="#f4a3b4" stroke="#d76b84" stroke-width=".9"/><path d="M12 4v15M8 8c1.5 1 1.5 3 0 4M16 8c-1.5 1-1.5 3 0 4" fill="none" stroke="#d76b84" stroke-width=".9"/>',
  };
  const ALIAS = { microphone: "mic", files: "cabinet", filing: "cabinet", magnifier: "search", research: "search",
    launch: "rocket", email: "mail", envelope: "mail", document: "doc", page: "doc", analytics: "chart", lightning: "bolt",
    laptop: "code", message: "chat", picture: "image", film: "video", settings: "gear", person: "user", done: "check",
    write: "pen", web: "globe", bulb: "idea", magic: "sparkles", list: "clipboard", house: "home", agent: "robot",
    table: "cabinet",
    // the reference's emoji (and a few common ones) → the nearest glyph
    "🎙️": "mic", "🎙": "mic", "🗄️": "cabinet", "🗄": "cabinet", "🔍": "search", "🔎": "search", "🚀": "rocket", "📧": "mail",
    "✉️": "mail", "📄": "doc", "📊": "chart", "📅": "calendar", "⚡": "bolt", "⭐": "star", "💻": "code", "💬": "chat",
    "🖼️": "image", "🎬": "video", "⚙️": "gear", "👤": "user", "📁": "folder", "✅": "check", "✏️": "pen", "🌐": "globe",
    "💡": "idea", "📘": "book", "📣": "megaphone", "🎯": "target", "✨": "sparkles", "💰": "money", "🔗": "link", "🔒": "lock",
    "🤖": "robot", "🏠": "home", "🏆": "trophy", "📋": "clipboard", "🏷️": "tag", "🗃️": "database", "🎵": "music", "📱": "phone",
    "🛒": "cart", "🧠": "brain" };
  const ICON_CYCLE = ["doc", "bolt", "search", "rocket", "mail", "idea", "chart", "target"];
  const svgIcon = (name) => `<svg viewBox="0 0 24 24" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${IC[name]}</svg>`;

  function iconHtml(icon, i, kitItems, label) {
    if (kitItems) {
      const hit = kitItems.find((k) => k && k.label && String(k.label).toLowerCase() === String(label).toLowerCase());
      if (hit && hit.icon_html) return hit.icon_html;
    }
    if (icon === "none") return "";
    if (icon && /^\s*<svg/i.test(icon)) return icon;
    const key = icon == null ? "" : String(icon).trim();
    const name = IC[key.toLowerCase()] ? key.toLowerCase() : ALIAS[key.toLowerCase()] || ALIAS[key];
    return svgIcon(name || ICON_CYCLE[i % ICON_CYCLE.length]);
  }

  const CHECK_SVG = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>';
  const CHEV_SVG = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m8 5 5 5-5 5"/></svg>';
  // which of the kit's menus this clip opens: "menu" (the + / tools menu), "slash_menu" ("/" commands), "model_picker"
  function kitSource(kit, name) {
    if (!kit) return null;
    if (name === "slash_menu" && kit.slash_menu && kit.menu && kit.menu.html)
      return Object.assign({}, kit.menu, { items: kit.slash_menu.items || [], anchor: kit.slash_menu.anchor || kit.menu.anchor, gap: kit.slash_menu.gap != null ? kit.slash_menu.gap : kit.menu.gap });
    if (name === "model_picker" && kit.model_picker && kit.model_picker.html) {
      const mp = kit.model_picker;
      return { model: true, css: mp.css, html: String(mp.html).replace("{{rows_html}}", "{{items_html}}"), item_html: mp.row_html, hover_class: mp.hover_class || "cg-hover",
        anchor: mp.anchor || "below", gap: mp.gap != null ? mp.gap : 4, align: "model",
        items: (mp.models || []).map((m) => ({ label: m.label, sub: m.sub || "", checked: !!m.checked })),
        vars: { mode: mp.mode || "", chevron_html: mp.chevron_html || CHEV_SVG }, check_html: mp.check_html || CHECK_SVG };
    }
    return kit.menu && kit.menu.html ? kit.menu : null;
  }

  function normParams(scene) {
    const p = Object.assign({ trigger: "/", menu_title: "Skills", placeholder_prefix: "/", after_label: "Add context",
      footer_label: "All sources", backdrop: true, cursor: true, pick: 0, menu: true, prompt: "" }, scene.params || {});
    p.menu = p.menu !== false;
    p.prompt = String(p.prompt || "");
    if (p.items === "kit") {
      const src = kitSource(scene.kit, p.menu_source) || {};
      p.items = (src.items || []).map((x) => ({ label: x.label, desc: x.desc, sub: x.sub, checked: x.checked }));
    }
    let items = p.items && p.items.length ? p.items : [{ label: "Messaging House Skill", icon: "mic" }, { label: "Task Filing Skill", icon: "cabinet" },
      { label: "Research and Insights PMM Review", icon: "search" }, { label: "GTM Plan Skill", icon: "rocket" }, { label: "Email Draft Skill", icon: "mail" }];
    items = items.map((it) => (typeof it === "string" ? { label: it } : { label: String(it.label || ""), icon: it.icon, desc: it.desc, sub: it.sub, checked: it.checked }));
    p.items = items;
    p.pick = Math.max(0, Math.min(items.length - 1, Number(p.pick) || 0));
    return p;
  }

  // ───────────────────────────── timeline (pure numbers, from beats + kf) ─────────────────────────────
  function timeline(scene, p) {
    const K = scene.kf, B = scene.beats || {}, H = K.hover, TY = K.typing || { rate_cps: 71, ease: [0.9, 0.9, 0.7, 0.9], caret_hide_after_s: 0.47, start_after_pan_s: 0.1, start_after_in_s: 0.3, out_after_typing_s: 0.3 };
    const typeDur = p.prompt ? p.prompt.length / TY.rate_cps : 0;
    if (!p.menu) {
      // composer only: the prompt types in, then the cursor glides in and clicks send on 'out'
      const tin = B.in != null ? B.in : 0;
      const ts = B.type != null ? Number(B.type) : tin + TY.start_after_in_s;
      const te = ts + typeDur;
      const out = B.out != null ? Math.max(Number(B.out), te) : te + TY.out_after_typing_s + 0.183;
      const dur = scene.duration != null ? scene.duration : out + K.out.hold_after_click_s;
      return { tin, h: [], pick: Infinity, out, dur, ts, te, TY, noMenu: true };
    }
    const n = p.pick + 1;
    const tin = B.in != null ? B.in : 0;
    const h = new Array(n).fill(null);
    for (let i = 0; i < n; i++) if (B["hover_" + i] != null) h[i] = Number(B["hover_" + i]);
    let pick = B.pick != null ? Number(B.pick) : null;
    if (pick == null) {
      if (h[n - 1] != null) pick = h[n - 1] + H.pick_after_last_hover_s;
      else pick = tin + H.first_after_in_s + (n - 1) * H.mean_interval_s + H.pick_after_last_hover_s;
    }
    if (h[n - 1] == null) h[n - 1] = pick - H.pick_after_last_hover_s;
    if (h[0] == null) h[0] = Math.min(tin + H.first_after_in_s, h[n - 1] - (n - 1) * H.min_interval_s);
    // fill gaps linearly between known neighbours
    for (let i = 1; i < n - 1; i++) {
      if (h[i] != null) continue;
      let j = i + 1;
      while (h[j] == null) j++;
      const a = i - 1;
      for (let k = i; k < j; k++) h[k] = h[a] + ((h[j] - h[a]) * (k - a)) / (j - a);
      i = j - 1;
    }
    for (let i = 1; i < n; i++) h[i] = Math.max(h[i], h[i - 1] + H.min_interval_s * 0.5);
    pick = Math.max(pick, h[n - 1] + 0.05);
    const ts = B.type != null ? Math.max(Number(B.type), pick) : pick + K.collapse.composer_pan.dur + TY.start_after_pan_s;
    const te = ts + typeDur;
    const outMin = Math.max(pick + K.collapse.composer_pan.dur, p.prompt ? te + TY.out_after_typing_s : 0);
    const out = B.out != null ? Math.max(Number(B.out), outMin) : Math.max(pick + K.out.default_after_pick_s, outMin);
    const dur = scene.duration != null ? scene.duration : out + K.out.hold_after_out_s;
    return { tin, h, pick, out, dur, ts, te, TY };
  }

  // ───────────────────────────── neutral look (the reference's own composer) ─────────────────────────────
  function buildNeutral(group, scene, p) {
    const S = scene.style, C = S.composer, M = S.menu, R = M.rows, FF = S.font_family;
    const comp = TR.el("div", `position:absolute;left:0;top:0;width:${C.w}px;height:${C.h}px;border-radius:${C.radius}px;background:${C.bg};box-shadow:${C.shadow};`, group);
    // chip "Add context"
    const ch = C.chip;
    const chip = TR.el("div", `position:absolute;left:${ch.x}px;top:${ch.y}px;height:${ch.h}px;box-sizing:border-box;border:${ch.border};border-radius:${ch.radius}px;display:flex;align-items:center;padding:0 ${ch.pad_r}px 0 ${ch.pad_l}px;gap:${ch.gap}px;white-space:nowrap;`, comp);
    TR.el("div", `width:${ch.icon_px}px;height:${ch.icon_px}px;flex:none`, chip, SVG.at(ch.icon_color));
    TR.el("span", `font:${ch.weight} ${ch.font_px}px ${FF};color:${ch.color};letter-spacing:${ch.tracking_em}em;line-height:1`, chip, esc(p.after_label));
    if (!p.after_label) chip.style.display = "none";
    // text line
    const T = C.text;
    const slash = TR.el("div", `position:absolute;white-space:nowrap;font:${T.weight} ${T.font_px}px ${FF};line-height:1;letter-spacing:${T.tracking_em}em;color:${T.slash_color}`, comp, esc(p.trigger));
    const label = TR.el("div", `position:absolute;white-space:nowrap;font:${T.weight} ${T.font_px}px ${FF};line-height:1;letter-spacing:${T.tracking_em}em;color:${T.preview_color}`, comp, "");
    // the typed prompt (after the pick, or alone with menu:false): wraps; the first line continues after the label
    const typedEl = TR.el("div", `position:absolute;white-space:pre-wrap;overflow-wrap:break-word;font:${T.commit_weight} ${T.font_px}px ${FF};line-height:1.3;letter-spacing:${T.tracking_em}em;color:${T.commit_color};width:${C.w - T.x - (T.right_pad || 70)}px`, comp, "");
    if (!p.menu) slash.style.display = "none";
    // footer
    const F = C.footer;
    TR.el("div", `position:absolute;left:${F.clip.x}px;top:${F.clip.y}px;width:${F.clip.w}px;height:${F.clip.h}px`, comp, SVG.clip(F.icon_color, F.icon_stroke));
    TR.el("div", `position:absolute;left:${F.globe.x}px;top:${F.globe.y}px;width:${F.globe.w}px;height:${F.globe.h}px`, comp, SVG.globe(F.icon_color, F.icon_stroke));
    const foot = TR.el("div", `position:absolute;white-space:nowrap;font:${F.weight} ${F.font_px}px ${FF};line-height:1;color:${F.color}`, comp, esc(p.footer_label));
    const SD = C.send;
    const send = TR.el("div", `position:absolute;left:${C.w - SD.cx_from_right - SD.d / 2}px;top:${C.h - SD.cy_from_bottom - SD.d / 2}px;width:${SD.d}px;height:${SD.d}px;border-radius:50%;background:${SD.bg};display:flex;align-items:center;justify-content:center`, comp, SVG.arrow(SD.arrow_color, SD.arrow_stroke, SD.arrow_h));

    // menu
    const n = p.items.length;
    const menuH = R.first_band_top + (n - 1) * R.pitch + R.band_h + R.bottom_pad;
    const menu = TR.el("div", `position:absolute;left:${M.x}px;top:0;width:${M.min_w}px;height:${menuH}px;border-radius:${M.radius}px;background:${M.bg};box-shadow:${M.shadow};transform-origin:50% 100%;`, group);
    const HD = M.header;
    const title = TR.el("div", `position:absolute;white-space:nowrap;font:${HD.weight} ${HD.font_px}px ${FF};line-height:1;color:${HD.color}`, menu, esc(p.menu_title));
    const lib = TR.el("div", `position:absolute;top:${HD.lib.y}px;width:${HD.lib.w}px;height:${HD.lib.h}px`, menu, SVG.lib(HD.icon_color, HD.icon_stroke));
    const plus = TR.el("div", `position:absolute;top:${HD.plus.y}px;width:${HD.plus.w}px;height:${HD.plus.h}px`, menu, SVG.plus(HD.icon_color, HD.plus_stroke || HD.icon_stroke));
    const band = TR.el("div", `position:absolute;left:${R.band_x}px;height:${R.band_h}px;border-radius:${R.band_radius}px;background:${R.hover_bg};display:none`, menu);
    const rows = p.items.map((it, i) => {
      const top = R.first_band_top + i * R.pitch;
      const ic = TR.el("div", `position:absolute;left:${R.icon_cx - R.icon_px}px;top:${top + R.band_h / 2 - R.icon_px}px;width:${R.icon_px * 2}px;height:${R.icon_px * 2}px;display:flex;align-items:center;justify-content:center;line-height:1`, menu, iconHtml(it.icon, i, null, it.label));
      const svg = ic.querySelector("svg");
      if (svg) { svg.setAttribute("width", R.icon_px); svg.setAttribute("height", R.icon_px); }
      const tx = TR.el("div", `position:absolute;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:${R.weight} ${R.font_px}px ${FF};line-height:1.3;letter-spacing:${R.tracking_em}em;color:${R.color}`, menu, esc(it.label));
      return { top, tx };
    });

    const font = (w, px) => `${w} ${px}px Inter`;
    const metr = (w, px) => {
      const m = TR.measure("Hlk", font(w, px));
      const fa = m.fontBoundingBoxAscent, fd = m.fontBoundingBoxDescent;
      return { asc: m.actualBoundingBoxAscent, base: (px - (fa + fd)) / 2 + fa };
    };
    const lsb = (s, w, px) => TR.measure(s, font(w, px)).actualBoundingBoxLeft || 0;
    // place a line-height:1 text div so that its ink top (ascender) is at y and its ink left at x
    const place = (elm, x, y, s, w, px, lh) => {
      const m = metr(w, px);
      const extra = ((lh || 1) - 1) * px / 2;
      elm.style.left = x + lsb(s, w, px) + "px";
      elm.style.top = y + m.asc - m.base - extra + "px";
    };
    let menuW = M.min_w;
    const layoutText = () => {
      // menu width grows to the longest label (never past the composer)
      let longest = 0;
      for (const it of p.items) longest = Math.max(longest, TR.measure(it.label, font(R.weight, R.font_px)).width);
      menuW = Math.min(C.w - 2 * M.x, Math.max(M.min_w, R.text_x + longest + R.right_pad));
      menu.style.width = menuW + "px";
      band.style.width = menuW - R.band_x - R.band_r_inset + "px";
      place(title, HD.title_x, HD.title_cap_top, p.menu_title, HD.weight, HD.font_px);
      lib.style.left = menuW - HD.lib.x_from_right + "px";
      plus.style.left = menuW - HD.plus.x_from_right + "px";
      const capOff = R.ink_top_in_band; // reference: row ink top sits ~23 px below its band top
      rows.forEach((r, i) => {
        place(r.tx, R.text_x, r.top + capOff, p.items[i].label, R.weight, R.font_px, 1.3);
        r.tx.style.maxWidth = menuW - R.text_x - 40 + "px";
      });
      place(slash, T.x, T.cap_top, p.trigger, T.weight, T.font_px);
      place(foot, F.label_x, F.label_cap_top, p.footer_label, F.weight, F.font_px);
    };
    const geo = { compW: C.w, compH: C.h, menuH, overlap: M.overlap, menuX: M.x };
    let lastKey = "";
    return {
      geo,
      layout() {
        layoutText();
        if (!p.menu) { menu.style.display = "none"; comp.style.top = "0px"; return { menuW, compY: 0, menuY: 0, menuH: 0 }; }
        comp.style.top = menuH - M.overlap + "px";
        return { menuW, compY: menuH - M.overlap, menuY: 0 };
      },
      rowBand(i) { return { x: R.band_x, y: R.first_band_top + i * R.pitch, w: menuW - R.band_x - R.band_r_inset, h: R.band_h, pitch: R.pitch }; },
      sendCenter() { return { x: C.w - SD.cx_from_right, y: C.h - SD.cy_from_bottom, d: SD.d }; },
      menu, comp,
      setState(hover, text, committed, typed, caret) {
        const key = hover + "|" + text + "|" + committed + "|" + typed + "|" + caret;
        if (key === lastKey) return;
        lastKey = key;
        if (typed || caret) {
          let indent = 0;
          const x0 = p.menu ? parseFloat(slash.style.left) : T.x;
          if (text && committed) {
            const lw = TR.measure(text, font(T.commit_weight, T.font_px)).width;
            indent = parseFloat(label.style.left || x0) + lw + TR.measure(" ", font(T.commit_weight, T.font_px)).width - x0;
          }
          place(typedEl, p.menu ? x0 - lsb(p.trigger, T.weight, T.font_px) : T.x, T.cap_top, "H", T.commit_weight, T.font_px, 1.3);
          if (p.menu) typedEl.style.left = x0 + "px";
          typedEl.style.textIndent = indent + "px";
          typedEl.innerHTML = esc(typed) + (caret ? `<span style="display:inline-block;width:${T.caret_w || 2.5}px;height:0.8em;margin-left:2px;vertical-align:-0.08em;background:${T.caret_color || T.commit_color}"></span>` : "");
        } else typedEl.innerHTML = "";
        if (hover == null || committed) band.style.display = hover == null ? "none" : "block";
        else band.style.display = "block";
        if (hover != null) band.style.top = R.first_band_top + hover * R.pitch + "px";
        label.textContent = text ? text : "";
        label.style.color = committed ? T.commit_color : T.preview_color;
        label.style.fontWeight = committed ? T.commit_weight : T.weight;
        slash.style.color = committed ? T.slash_color_after : T.slash_color;
        if (text) {
          const m = TR.measure(p.trigger, font(T.weight, T.font_px));
          const slashInkR = T.x + (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0);
          place(label, slashInkR + T.label_gap, T.cap_top, text, committed ? T.commit_weight : T.weight, T.font_px);
        }
      },
    };
  }

  // ───────────────────────────── kit look (a real app's UI) ─────────────────────────────
  function buildKit(group, scene, p) {
    const kit = scene.kit, KC = kit.composer, S = scene.style;
    const num = (v, d) => (v == null || v === "" || isNaN(Number(v)) ? d : Number(v));
    // a kit without a captured menu: a plain menu drawn ONLY from the kit's own tokens (surface / border / text /
    // radius, the composer's font) — logged in the spec as "menu derived from kit tokens, not captured"
    const tokenMenu = () => {
      const tk = kit.tokens || {};
      const pick = (re, d) => { const e = Object.entries(tk).find(([kk]) => re.test(kk)); return e ? `var(${e[0]})` : d; };
      const dark = String(kit.theme || "").toLowerCase() === "dark";
      const surf = pick(/-(menu|surface|composer)$/, dark ? "#2a2a2a" : "#fff"), bord = pick(/-(menu-border|border)$/, "rgba(127,127,127,0.25)");
      const text = pick(/-text$/, dark ? "#eee" : "#111"), muted = pick(/-(muted|text-2)$/, dark ? "#aaa" : "#666");
      return {
        derived: true, anchor: "above", gap: 8, hover_class: "pm-hover",
        css: `.pm-menu{box-sizing:border-box;width:${num(KC.width, 700)}px;padding:6px;background:${surf};border:1px solid ${bord};border-radius:14px;font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:20px;color:${text};-webkit-font-smoothing:antialiased;box-shadow:0 6px 24px rgba(0,0,0,0.25)}
.pm-head{padding:6px 10px 4px;font-size:12px;color:${muted}}
.pm-head:empty{display:none}
.pm-item{display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border-radius:9px;white-space:nowrap}
.pm-item.pm-hover{background:${dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)"}}
.pm-ic{width:18px;display:flex;justify-content:center;font-size:15px}
.pm-desc{color:${muted}}`,
        html: `<div class="pm-menu"><div class="pm-head">{{title}}</div>{{items_html}}</div>`,
        item_html: `<div class="pm-item">{{icon_html}}<span>{{label}}</span><span class="pm-desc">{{desc}}</span></div>`,
      };
    };
    const KM = kitSource(kit, p.menu_source) || tokenMenu();
    const cls = "kit-" + String(kit.app || "app").replace(/[^a-z0-9_-]/gi, "");
    const scope = (css) => String(css || "").replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) =>
      `${a} ${sel.split(",").map((s) => (s.trim().startsWith(":root") ? `.${cls}` : `.${cls} ${s.trim()}`)).join(",")}{`);
    TR.addCss(scope(KC.css) + "\n" + (KM ? scope(KM.css) : "") + "\n" + (kit.chip && kit.chip.css ? scope(kit.chip.css) : "") + "\n" + (kit.greeting && kit.greeting.css ? scope(kit.greeting.css) : ""));
    const KW = num(KC.width, S.composer.w), KH = num(KC.height, 100);
    const k = S.composer.w / KW;
    const tokens = kit.tokens || {};
    const tokenCss = Object.entries(tokens).filter(([kk, v]) => kk.startsWith("--") && typeof v === "string").map(([kk, v]) => `${kk}:${v}`).join(";");
    const compWrap = TR.el("div", `position:absolute;left:0;top:0;width:${S.composer.w}px;height:${KH * k}px`, group);
    const compIn = TR.el("div", `position:absolute;left:0;top:0;width:${KW}px;height:${KH}px;transform:scale(${k});transform-origin:0 0;${tokenCss}`, compWrap);
    compIn.className = cls;
    // the app's greeting (e.g. Claude's "Evening, Jake") above the composer: under an "above" menu it is covered while
    // the menu is open and revealed by the collapse — like the reference's "Add context" chip under its menu
    let greet = null;
    const G = kit.greeting && kit.greeting.html && p.greeting !== false ? kit.greeting : null;
    if (G) {
      greet = TR.el("div", `position:absolute;left:0;top:0;width:${KW}px;transform-origin:0 0;transform:scale(${k});${tokenCss}`, group);
      greet.className = cls;
      greet.innerHTML = TR.fill(G.html, { greeting: typeof p.greeting === "string" ? p.greeting : G.default || "" });
    }
    const anchor = (KM && KM.anchor) || "above";
    const menuWrap = TR.el("div", `position:absolute;left:0;top:0;transform-origin:50% ${anchor === "below" ? "0%" : "100%"}`, group);
    const menuIn = TR.el("div", `position:absolute;left:0;top:0;transform:scale(${k});transform-origin:0 0;${tokenCss}`, menuWrap);
    menuIn.className = cls;
    const kitItems = KM && KM.items;
    const kitHit = (label) => (kitItems || []).find((x) => x && x.label && String(x.label).toLowerCase() === String(label).toLowerCase());
    const itemsHtml = p.items.map((it, i) => {
      const h = TR.fill(KM ? KM.item_html : `<div style="display:flex;gap:12px;align-items:center;padding:8px 14px">{{icon_html}}<span>{{label}}</span></div>`,
        { icon_html: `<span class="pm-ic" style="display:inline-flex;width:1.25em;height:1.25em;align-items:center;justify-content:center">${iconHtml(it.icon, i, kitItems, it.label)}</span>`, label: it.label, desc: it.desc != null ? it.desc : (kitHit(it.label) || {}).desc || "",
          sub: it.sub || "", check_html: `<span class="pm-check" style="display:inline-flex;opacity:${it.checked ? 1 : 0}">${KM.check_html || CHECK_SVG}</span>` });
      return `<div data-pm-row="${i}" style="display:contents">${h}</div>`;
    }).join("");
    menuIn.innerHTML = TR.fill(KM ? KM.html : `<div style="background:#fff;border-radius:16px;padding:8px;min-width:360px">{{items_html}}</div>`,
      Object.assign({ items_html: itemsHtml, title: p.menu_title }, KM.vars || {}));
    const rowEls = p.items.map((_, i) => {
      const w = menuIn.querySelector(`[data-pm-row="${i}"]`);
      return (w && w.firstElementChild) || w;
    });
    const hoverCls = (KM && KM.hover_class) || "pm-hover";
    if (!KM || !KM.hover_class) TR.addCss(`.${cls} .pm-hover{background:rgba(0,0,0,0.05)}`);
    const offsetIn = (elm, anc) => {
      // position in the ancestor's natural (untransformed) px, independent of any scale on the way
      const ar = anc.getBoundingClientRect(), er = elm.getBoundingClientRect();
      const f = (anc.offsetWidth || ar.width) / (ar.width || 1);
      return { x: (er.left - ar.left) * f, y: (er.top - ar.top) * f, w: er.width * f, h: er.height * f };
    };
    const cm = /\.([a-z0-9]+-caret)\b/i.exec(String(KC.css || ""));
    const caretCls = cm ? `<span class="${cm[1]}"></span>` : "";
    let lastKey = "";
    let L = { menuW: 300, menuH: 300, compY: 0, menuY: 0 };
    const gap = KM ? num(KM.gap, 8) : 8;
    const geo = { compW: S.composer.w, compH: KH * k, menuH: 300, overlap: 0, menuX: 0 };
    const api = {
      geo,
      layout() {
        // natural menu size (untransformed) → group-local px
        const t = menuWrap.style.transform; menuWrap.style.transform = "none";
        const me = menuIn.firstElementChild || menuIn;
        const mw = me.offsetWidth * k, mh = me.offsetHeight * k;
        const rr = rowEls.map((e) => (e ? offsetIn(e, me) : null));
        menuWrap.style.transform = t;
        const menuH = mh, menuW = mw;
        const ce = compIn.firstElementChild;
        if (ce && ce.offsetHeight) { geo.compH = ce.offsetHeight * k; compWrap.style.height = geo.compH + "px"; }
        geo.menuH = menuH;
        const ox = KM && KM.align === "model" ? (KW - me.offsetWidth - num(KM.right_inset, 96)) * k : KM ? num(KM.offset_x, 0) * k : 0;
        menuWrap.style.width = menuW + "px"; menuWrap.style.height = menuH + "px";
        menuWrap.style.left = ox + "px";
        geo.menuX = ox;
        if (!p.menu) {
          menuWrap.style.display = "none"; compWrap.style.top = "0px";
          if (greet) greet.style.top = -(num(G.baseline_above_composer, 39) + 0.8 * (greet.offsetHeight || 30)) * k + "px";
          L = { menuW: 0, menuH: 0, compY: 0, menuY: 0, rows: [] };
          return L;
        }
        if (api.frozen && greet) greet.style.top = api.frozen.compY - (num(G.baseline_above_composer, 39) + 0.8 * (greet.offsetHeight || 30)) * k + "px";
        if (api.frozen) { menuWrap.style.top = api.frozen.menuY + "px"; compWrap.style.top = api.frozen.compY + "px"; return Object.assign({}, api.frozen, { rows: rr }); }
        if (anchor === "below") {
          L = { menuW, menuH, compY: 0, menuY: geo.compH + gap * k, rows: rr };
          geo.overlap = -(gap * k);
        } else {
          L = { menuW, menuH, compY: menuH + gap * k, menuY: 0, rows: rr };
          geo.overlap = -(gap * k);
        }
        menuWrap.style.top = L.menuY + "px";
        compWrap.style.top = L.compY + "px";
        // a menu that opens below tucks BEHIND the composer while it collapses (the composer may grow on the pick)
        compWrap.style.zIndex = anchor === "below" ? 2 : 0; menuWrap.style.zIndex = 1;
        if (greet) {
          const gh = greet.offsetHeight || 30;
          greet.style.zIndex = 0;
          greet.style.top = L.compY - (num(G.baseline_above_composer, 39) + 0.8 * gh) * k + "px";
        }
        return L;
      },
      rowBand(i) {
        const r = L.rows && L.rows[i];
        if (!r) return { x: 0, y: i * 40 * k, w: L.menuW, h: 40 * k, pitch: 40 * k };
        return { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k, pitch: r.h * k };
      },
      sendCenter() {
        const e = KC.send_sel && Array.from(compIn.querySelectorAll(KC.send_sel)).find((x) => x.getBoundingClientRect().width > 0);
        if (e) { const o = offsetIn(e, compIn); return { x: (o.x + o.w / 2) * k, y: (o.y + o.h / 2) * k, d: Math.max(o.w, o.h) * k }; }
        return { x: S.composer.w - 60 * k, y: geo.compH - 40 * k, d: 40 * k };
      },
      menu: menuWrap, comp: compWrap,
      setState(hover, text, committed, typed, caret) {
        const key = hover + "|" + text + "|" + committed + "|" + typed + "|" + caret;
        if (key === lastKey) return;
        lastKey = key;
        rowEls.forEach((e, i) => e && e.classList.toggle(hoverCls, i === hover));
        let prompt = p.trigger, placeholder = "", chips = "", state = "";
        const ck = (p.chip && p.chip.kind) || (KM.model ? "none" : null);
        if (KM.model) rowEls.forEach((e, i) => { const c = e && e.querySelector(".pm-check"); if (c) c.style.opacity = (committed ? i === p.pick : p.items[i].checked) ? 1 : 0; });
        // real apps do not preview a hovered row in the composer; the reference's neutral box does (params.preview)
        if (text && !committed && p.preview === true) { prompt = ""; placeholder = p.placeholder_prefix + text; }
        if (text && committed) {
          if (ck === "none") prompt = "";
          else if (ck === "indicator") {
            prompt = "";
            const c = p.chip || {};
            state = `<div class="pm-indicator" style="position:absolute;${c.style || "left:52px;bottom:12px"};height:32px;display:flex;align-items:center;gap:6px;padding:0 10px;border-radius:8px;font:500 13px Inter,sans-serif;color:${c.color || "#5ea8ff"};background:${c.bg || "rgba(94,168,255,0.14)"}">${c.icon_html || ""}${esc(c.name || text)}</div>`;
          } else if ((ck === "image" || ck === "file") && kit.chip && kit.chip.html) {
            const c = p.chip || {};
            chips = TR.fill(kit.chip.html, { name: c.name || text, kind: ck, icon_html: "", thumb_html: c.thumb_src ? `<img src="${c.thumb_src}" alt="">` : "" });
            prompt = "";
          } else if (kit.chip && kit.chip.html) { chips = TR.fill(kit.chip.html, { name: text, kind: "skill", icon_html: (kitHit(text) || {}).icon_html || "", thumb_html: "" }); prompt = ""; }
          else prompt = p.placeholder_prefix + text;
        }
        if (!/\{\{\s*placeholder/.test(KC.html) && placeholder) { prompt = p.trigger; placeholder = ""; }
        if (!p.menu) prompt = "";
        if (typed || caret) { prompt = (prompt && committed ? prompt + " " : "") + (typed || ""); placeholder = ""; }
        compIn.innerHTML = TR.fill(KC.html, { prompt, placeholder: placeholder || (prompt || chips ? "" : KC.placeholder || ""), chips_html: chips, state_html: state, caret_html: caret ? (KC.caret_html || caretCls || '<span class="pm-caret" style="display:inline-block;width:1.5px;height:1.05em;margin-left:1px;vertical-align:-0.15em;background:currentColor"></span>') : "", layout_class: (KC.multiline_over_px && TR.measure(prompt, `${num(KC.font_size, 16)}px Inter`).width > num(KC.multiline_over_px, 1e9)) ? "is-multiline" : "", model: KC.model || kit.model_label || "", model_label: kit.model_label || KC.model || "" });
      },
    };
    return api;
  }

  function cursorSvg(st) {
    return `<svg viewBox="-8 -8 80 120" width="80" height="120" style="overflow:visible;filter:${st.shadow}"><polygon points="${CURSOR_PTS}" fill="${st.fill}" stroke="${st.outline}" stroke-width="${st.outline_px}" stroke-linejoin="round" paint-order="stroke"/></svg>`;
  }

  function build(root, scene) {
    const p = normParams(scene);
    const S = scene.style, K = scene.kf, W = scene.width, Hh = scene.height;
    const kitPage = scene.kit && (scene.kit.backdrop || scene.kit.bg || Object.entries(scene.kit.tokens || {}).filter(([kk]) => /-page$/.test(kk)).map(([, v]) => v)[0]);
    if (p.backdrop) TR.el("div", `position:absolute;inset:0;background:${kitPage || S.backdrop}`, root);
    const stage = TR.el("div", "position:absolute;left:0;top:0;width:100%;height:100%", root);
    const group = TR.el("div", "position:absolute;left:0;top:0;transform-origin:0 0", stage);
    const ui = scene.kit && scene.kit.composer ? buildKit(group, scene, p) : buildNeutral(group, scene, p);
    const cur = TR.el("div", "position:absolute;left:0;top:0;width:80px;height:120px;transform-origin:8px 8px;display:none", stage, cursorSvg(S.cursor));
    if (!p.cursor) cur.style.visibility = "hidden";
    return { p, ui, group, stage, cur, tl: timeline(scene, p), W, H: Hh };
  }

  function quant(t, scene) {
    const K = scene.kf;
    if (!K.quantize_fps || !(scene.fps > K.quantize_fps + 1e-6)) return t;
    const q = K.quantize_fps, ph = K.quantize_phase_s || 0;
    return Math.max(0, Math.floor((t - ph) * q + 1e-3) / q + ph);
  }

  // rows table lookup: [[t, ...vals]] linear, held outside
  function tab(t, rows, col) {
    if (t <= rows[0][0]) return rows[0][col];
    for (let i = 0; i < rows.length - 1; i++) {
      if (t <= rows[i + 1][0]) return TR.lerp(rows[i][col], rows[i + 1][col], (t - rows[i][0]) / (rows[i + 1][0] - rows[i][0]));
    }
    return rows[rows.length - 1][col];
  }

  function seek(st, tRaw, scene) {
    const K = scene.kf, S = scene.style, p = st.p, tl = st.tl, ui = st.ui;
    const t = quant(tRaw, scene);
    const visible = tRaw >= tl.tin - 1e-6 && tRaw < tl.dur + 1e-6;
    st.stage.style.opacity = visible ? 1 : 0;
    const L = ui.layout();
    const g = ui.geo;
    const CP = K.collapse;
    // the layout before the click (the composer may change size when the pick commits — kits): centring + pan start
    // are computed from it so nothing jumps on the click
    if (!st.pre || t < tl.pick) st.pre = { L: Object.assign({}, L), compH: g.compH, menuH: g.menuH };
    if ("frozen" in ui || ui.geo) ui.frozen = t >= tl.pick ? st.pre.L : null;
    const P0 = st.pre;
    // group scale (only shrinks when the menu is very tall) + centring
    const groupH = Math.max(P0.L.compY + P0.compH, P0.L.menuY + (P0.L.menuH || P0.menuH) * (scene.kit && scene.kit.composer ? 1 : 0));
    const s = Math.min(1, (S.layout.max_group_h_frac * st.H) / groupH);
    const gx = st.W / 2 - (s * g.compW) / 2 + S.layout.center_dx;
    const gy0 = st.H / 2 - (s * groupH) / 2 + S.layout.center_dy;
    // collapse
    const compCy0 = gy0 + s * (P0.L.compY + P0.compH / 2);
    const compCy1 = st.H / 2 + CP.composer_pan.final_center_dy_frac_comp_h * g.compH * s;
    const pan = TR.prog(t, tl.pick + CP.composer_pan.start, CP.composer_pan.dur, CP.composer_pan.ease === "linear" ? null : CP.composer_pan.ease);
    const gy = gy0 + (compCy1 - compCy0) * pan;
    st.group.style.transform = `translate(${gx}px,${gy}px) scale(${s})`;
    const ms = CP.menu_scale;
    const msc = TR.lerp(ms.from, ms.to, TR.prog(t, tl.pick + ms.start, ms.dur, ms.ease === "linear" ? null : ms.ease));
    ui.menu.style.transform = `scale(${msc})`;
    ui.menu.style.visibility = t >= tl.pick + CP.menu_opacity.hide_at_s ? "hidden" : "visible";

    // hover + composer text
    let hover = null;
    for (let i = 0; i < tl.h.length; i++) if (t >= tl.h[i] - 1e-6) hover = i;
    const committed = t >= tl.pick + CP.text_commit_s - 1e-6;
    if (committed) hover = p.pick;
    let typed = "", caret = false;
    if (p.prompt && t >= tl.ts - 1e-6) {
      const u = tl.te > tl.ts ? TR.ease(tl.TY.ease)(TR.clamp((t - tl.ts) / (tl.te - tl.ts), 0, 1)) : 1;
      typed = p.prompt.slice(0, Math.round(u * p.prompt.length));
      caret = t < tl.te + (tl.TY.caret_hide_after_s || 0.47);
    }
    ui.setState(p.menu ? hover : null, hover == null || !p.menu ? "" : p.items[hover].label, committed, typed, caret);

    // cursor (screen space; not part of the panning group)
    const C = K.cursor;
    const restOf = (i) => {
      const b = ui.rowBand(i);
      const j = i < C.rest.x_frac_menu_w.length ? i : 2 + ((i - 2) % 3);
      const lx = g.menuX + C.rest.x_frac_menu_w[j] * L.menuW;
      const ly = L.menuY + b.y + C.rest.y_frac_pitch[j] * b.pitch;
      return { x: gx + s * lx, y: gy0 + s * ly };
    };
    let pos = null, alpha = 1;
    const E = C.entry.table;
    const sendEnd = (panned) => {
      const sc = ui.sendCenter();
      const ce = { x: gx + s * sc.x, y: gy0 + (panned ? compCy1 - compCy0 : 0) + s * (L.compY + sc.y) };
      return { x: ce.x + C.send.end_offset_frac_of_button[0] * sc.d * s, y: ce.y + C.send.end_offset_frac_of_button[1] * sc.d * s };
    };
    if (tl.noMenu) {
      // composer only: the measured entry glide, landing on the send button on 'out' (the click)
      const h0 = tl.out - E[E.length - 1][0];
      if (t >= h0 + E[0][0] - 1e-6) {
        const r = sendEnd(false), te = t - h0;
        pos = { x: r.x + s * tab(te, E, 1), y: r.y + s * tab(te, E, 2) };
        alpha = tab(te, E, 3);
      }
    } else if (t >= tl.h[0] + E[0][0] - 1e-6) {
      const r0 = restOf(0);
      const te = t - tl.h[0];
      alpha = tab(te, E, 3);
      // position at time tt using the entry and hops < upto (a hop starts from wherever the cursor is then, so
      // tightly packed beats never make it jump)
      const posAt = (tt, upto) => {
        let q = { x: r0.x + s * tab(tt - tl.h[0], E, 1), y: r0.y + s * tab(tt - tl.h[0], E, 2) };
        for (let i = 1; i < upto; i++) {
          const hs = tl.h[i] - K.hover.switch_after_hop_start_s;
          if (tt < hs) break;
          const d = C.hop.durations_s[(i - 1) % C.hop.durations_s.length];
          const a = posAt(hs, i), b = restOf(i);
          const u = TR.clamp((tt - hs) / d, 0, 1);
          q = { x: TR.lerp(a.x, b.x, u), y: TR.lerp(a.y, b.y, u) };
        }
        return q;
      };
      pos = posAt(t, tl.h.length);
      if (t >= tl.out) {
        const a = posAt(tl.out, tl.h.length);
        const end = sendEnd(true);
        const ts = t - tl.out;
        pos = { x: TR.lerp(a.x, end.x, tab(ts, C.send.table, 1)), y: TR.lerp(a.y, end.y, tab(ts, C.send.table, 2)) };
      }
    }
    if (pos && p.cursor) {
      st.cur.style.display = "block";
      st.cur.style.opacity = alpha;
      st.cur.style.transform = `translate(${pos.x - 8}px,${pos.y - 8}px) scale(${s * (S.cursor.w / 64)})`;
    } else st.cur.style.display = "none";
  }

  window.__TEMPLATES = window.__TEMPLATES || {};
  window.__TEMPLATES.prompt_menu = { build, seek, timeline: (scene) => timeline(scene, normParams(scene)) };
})();
