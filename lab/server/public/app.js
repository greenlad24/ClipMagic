/* ClipMagic bulk editor — vanilla JS, no build step.
 *
 * Flow: upload many videos → set template defaults → edit per-video (table or
 * CSV) → render all through the batch API → live dashboard with retry + zip.
 *
 * Each row in `state.items` carries per-video overrides; at render time we merge
 * template + overrides into one RenderManifest per video and POST them as a
 * single batch.
 */
const API = location.origin;

const state = {
  step: "upload",
  picked: [],          // File[] chosen but not yet uploaded
  uploaded: [],        // { id, original, url, duration, width, height, size }
  music: null,         // uploaded music file or null
  items: [],           // per-video edit rows (built after upload)
  template: {},        // template defaults
  batchId: null,
  poll: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmtSize = (b) => b > 1e9 ? (b/1e9).toFixed(2)+" GB" : b > 1e6 ? (b/1e6).toFixed(1)+" MB" : (b/1e3).toFixed(0)+" KB";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const baseName = (n) => n.replace(/\.[^.]+$/, "");

// ── Health ────────────────────────────────────────────────────────────────
async function health() {
  try {
    const h = await (await fetch(`${API}/health`)).json();
    $("#health").textContent = `● online · ${h.concurrency} workers · ${h.queue.queued} queued`;
  } catch { $("#health").textContent = "● offline"; }
}
health(); setInterval(health, 5000);

// ── Step navigation ─────────────────────────────────────────────────────────
const STEPS = ["upload", "template", "edit", "render"];
function canEnter(step) {
  if (step === "template" || step === "edit") return state.uploaded.length > 0;
  if (step === "render") return state.items.length > 0;
  return true;
}
function goto(step) {
  if (!canEnter(step)) return;
  state.step = step;
  $$(".view").forEach((v) => v.classList.remove("show"));
  $(`#view-${step}`).classList.add("show");
  $$(".step").forEach((s) => s.classList.toggle("active", s.dataset.step === step));
  const idx = STEPS.indexOf(step);
  $("#backBtn").disabled = idx === 0;
  $("#nextBtn").disabled = idx === STEPS.length - 1 || !canEnter(STEPS[idx + 1]);
  $("#nextBtn").textContent = idx === STEPS.length - 1 ? "Done" : "Next →";
  if (step === "edit") renderEditTable();
  if (step === "render") renderDash();
  updateFootNote();
}
$$(".step").forEach((s) => (s.onclick = () => goto(s.dataset.step)));
$("#backBtn").onclick = () => goto(STEPS[Math.max(0, STEPS.indexOf(state.step) - 1)]);
$("#nextBtn").onclick = () => {
  const idx = STEPS.indexOf(state.step);
  if (idx < STEPS.length - 1) {
    if (state.step === "template") captureTemplate();
    goto(STEPS[idx + 1]);
  }
};
function updateFootNote() {
  const n = $("#footNote");
  if (state.uploaded.length === 0) n.textContent = "Upload videos to begin.";
  else if (state.step === "upload") n.textContent = `${state.uploaded.length} uploaded. Continue to the template.`;
  else if (state.step === "render") n.textContent = state.batchId ? "Rendering…" : "Press Render all to start.";
  else n.textContent = `${state.uploaded.length} videos ready.`;
  $("#editCount").textContent = state.items.length;
  $("#tplCount").textContent = state.uploaded.length;
}

// ── STEP 1: upload ──────────────────────────────────────────────────────────
const drop = $("#drop"), picker = $("#picker");
drop.onclick = () => picker.click();
["dragover","dragenter"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("hot"); }));
["dragleave","drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", (ev) => addFiles(ev.dataTransfer.files));
picker.addEventListener("change", () => addFiles(picker.files));

function addFiles(list) {
  for (const f of list) if (f.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name)) state.picked.push(f);
  renderPickList();
}
function renderPickList() {
  const el = $("#fileList"); el.innerHTML = "";
  const rows = [];
  state.picked.forEach((f, i) => {
    rows.push(`<div class="file"><span class="name">${esc(f.name)}</span>
      <span class="sz">${fmtSize(f.size)}</span>
      <button class="ghost sm" data-rm="${i}">✕</button></div>`);
  });
  state.uploaded.forEach((u) => {
    rows.push(`<div class="file"><span class="name">${esc(u.original)}</span>
      <span class="sz">${fmtSize(u.size)}${u.duration ? " · "+u.duration.toFixed(1)+"s" : ""}</span>
      <span class="st s-completed status">uploaded</span></div>`);
  });
  el.innerHTML = rows.join("");
  el.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { state.picked.splice(+b.dataset.rm, 1); renderPickList(); }));
  $("#uploadBtn").disabled = state.picked.length === 0;
  $("#clearBtn").disabled = state.picked.length === 0;
  $("#uploadCount").textContent = `${state.picked.length} pending · ${state.uploaded.length} uploaded`;
}
$("#clearBtn").onclick = () => { state.picked = []; renderPickList(); };

$("#uploadBtn").onclick = async () => {
  $("#uploadBtn").disabled = true; $("#clearBtn").disabled = true;
  const all = state.picked.slice();
  $("#upBarWrap").style.display = "block";
  const CHUNK = 20; let done = 0;
  try {
    for (let i = 0; i < all.length; i += CHUNK) {
      const slice = all.slice(i, i + CHUNK);
      $("#uploadMsg").textContent = `uploading ${done + 1}–${Math.min(done + slice.length, all.length)} of ${all.length}…`;
      const files = await uploadChunk(slice, (loaded, total) => {
        const frac = (done + (loaded / total) * slice.length) / all.length;
        $("#upBar").style.width = Math.round(frac * 100) + "%";
      });
      state.uploaded.push(...files);
      done += slice.length;
    }
    state.picked = [];
    $("#upBar").style.width = "100%";
    $("#uploadMsg").textContent = `✓ uploaded ${state.uploaded.length} file(s)`;
    rebuildItems();
    renderPickList();
    updateFootNote();
    $("#nextBtn").disabled = false;
  } catch (e) {
    $("#uploadMsg").textContent = "upload failed: " + e.message;
    $("#uploadBtn").disabled = false;
  }
};

// XHR upload for real progress on a chunk of files.
function uploadChunk(files, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/api/uploads`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText).files);
      else reject(new Error(xhr.responseText || ("HTTP " + xhr.status)));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(form);
  });
}

$("#musicPick").addEventListener("change", async () => {
  const f = $("#musicPick").files[0];
  if (!f) return;
  $("#musicMsg").textContent = "uploading music…";
  try {
    const files = await uploadChunk([f], () => {});
    state.music = files[0];
    $("#musicMsg").textContent = `✓ ${state.music.original} — applied to all videos`;
  } catch (e) { $("#musicMsg").textContent = "failed: " + e.message; }
});

// ── STEP 2: template ────────────────────────────────────────────────────────
$("#t_preset").addEventListener("change", () => {
  const v = $("#t_preset").value;
  if (!v) return;
  const [w, h] = v.split("x");
  $("#t_w").value = w; $("#t_h").value = h;
});
function captureTemplate() {
  state.template = {
    width: +$("#t_w").value || 1080,
    height: +$("#t_h").value || 1920,
    fps: +$("#t_fps").value || 30,
    format: $("#t_fmt").value,
    namePat: $("#t_namePat").value || "{{name}}",
    caption: $("#t_cap").value.trim(),
    capDur: +$("#t_capDur").value || 4,
    musicVolume: +$("#t_mvol").value,
  };
}
$("#toEditBtn").onclick = () => { captureTemplate(); goto("edit"); };

// Build per-video edit rows once, preserving any prior edits by file id.
function rebuildItems() {
  const prev = new Map(state.items.map((it) => [it.id, it]));
  state.items = state.uploaded.map((u, i) => {
    const old = prev.get(u.id);
    return old || {
      id: u.id,
      source: u.original,
      url: u.url,
      duration: u.duration || 0,
      width: u.width, height: u.height,
      outputName: "",   // blank → template pattern
      caption: "",      // blank → template caption
      trimStart: "",
      trimEnd: "",
    };
  });
}

// ── STEP 3: edit table ──────────────────────────────────────────────────────
function renderEditTable() {
  const tb = $("#editBody"); tb.innerHTML = "";
  state.items.forEach((it, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td title="${esc(it.source)}" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.source)}</td>
      <td><input data-f="outputName" data-i="${i}" value="${esc(it.outputName)}" placeholder="${esc(defaultName(it, i))}"/></td>
      <td><input data-f="caption" data-i="${i}" value="${esc(it.caption)}" placeholder="${esc(state.template.caption || "—")}"/></td>
      <td class="num"><input data-f="trimStart" data-i="${i}" value="${esc(it.trimStart)}" placeholder="0"/></td>
      <td class="num"><input data-f="trimEnd" data-i="${i}" value="${esc(it.trimEnd)}" placeholder="${it.duration ? it.duration.toFixed(1) : "end"}"/></td>
      <td class="muted">${it.duration ? it.duration.toFixed(1) + "s" : "?"}</td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll("input").forEach((inp) => {
    inp.oninput = () => { state.items[+inp.dataset.i][inp.dataset.f] = inp.value; };
  });
}
function defaultName(it, i) {
  const pat = state.template.namePat || "{{name}}";
  return fill(pat, { name: baseName(it.source), index: i + 1 }) || baseName(it.source);
}
function fill(s, vars) {
  return String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? "")).trim();
}

// Apply-one-value-to-all helper
$("#applyAllBtn").onclick = () => {
  const field = prompt("Apply to ALL videos — which field?\n(caption, trimStart, trimEnd, outputName)");
  if (!field || !["caption","trimStart","trimEnd","outputName"].includes(field)) return;
  const val = prompt(`Value for "${field}" on all ${state.items.length} videos:`, "");
  if (val === null) return;
  state.items.forEach((it) => (it[field] = val));
  renderEditTable();
};

// CSV import / export
$("#importCsvBtn").onclick = () => $("#csvFile").click();
$("#csvFile").addEventListener("change", async () => {
  const f = $("#csvFile").files[0]; if (!f) return;
  const text = await f.text();
  applyCsv(text);
  renderEditTable();
});
function applyCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return;
  const byName = new Map(state.items.map((it) => [baseName(it.source).toLowerCase(), it]));
  rows.forEach((row, idx) => {
    let it = null;
    if (row.name) it = byName.get(String(row.name).toLowerCase());
    if (!it) it = state.items[idx];
    if (!it) return;
    for (const f of ["outputName","caption","trimStart","trimEnd"]) if (row[f] !== undefined && row[f] !== "") it[f] = row[f];
    for (const f of ["width","height","fps","musicVolume"]) if (row[f] !== undefined && row[f] !== "") it["_" + f] = row[f];
  });
}
$("#exportCsvBtn").onclick = () => {
  const head = ["name","outputName","caption","trimStart","trimEnd"];
  const lines = [head.join(",")];
  state.items.forEach((it) => {
    lines.push([baseName(it.source), it.outputName, it.caption, it.trimStart, it.trimEnd]
      .map((v) => `"${String(v ?? "").replace(/"/g,'""')}"`).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "clipmagic-edits.csv"; a.click();
};
// Minimal CSV parser (quoted fields, escaped quotes).
function parseCsv(text) {
  const rows = []; let field = "", row = [], q = false;
  const pushF = () => { row.push(field); field = ""; };
  const pushR = () => { pushF(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") pushF();
    else if (c === "\r") {}
    else if (c === "\n") pushR();
    else field += c;
  }
  if (field.length || row.length) pushR();
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((v) => v.trim() !== "")).map((r) => {
    const o = {}; head.forEach((h, i) => (o[h] = (r[i] ?? "").trim())); return o;
  });
}

$("#toRenderBtn").onclick = () => goto("render");

// ── STEP 4: render ──────────────────────────────────────────────────────────
function buildManifest(it, i) {
  const t = state.template;
  const W = +(it._width || t.width), H = +(it._height || t.height), FPS = +(it._fps || t.fps);
  const dur = it.duration && it.duration > 0 ? it.duration : 10;
  const trimStart = parseFloat(it.trimStart) || 0;
  const trimEnd = parseFloat(it.trimEnd) || 0;
  const visible = trimEnd > trimStart ? trimEnd - trimStart : Math.max(0.1, dur - trimStart);
  const capText = (it.caption || t.caption || "").trim();
  const filledCap = fill(capText, { name: baseName(it.source), index: i + 1 });
  const capDur = Math.min(visible, t.capDur || 4);
  const subtitles = filledCap
    ? [{ start: 0, end: capDur, words: [{ text: filledCap, start: 0, end: capDur, emphasis: true }] }]
    : [];
  const mvol = it._musicVolume !== undefined ? +it._musicVolume : t.musicVolume;
  return {
    version: 1,
    projectId: "bulk_" + it.id,
    width: W, height: H, fps: FPS,
    format: t.format || "mp4",
    durationSeconds: dur,
    narration: { videoUrl: it.url, chunkUrls: [], trimStart, trimEnd: trimEnd > trimStart ? trimEnd : 0 },
    music: state.music ? { audioUrl: state.music.url, volume: mvol } : null,
    scenes: [],
    subtitles,
    subtitleStyle: { fontFamily: "DejaVu Sans Bold", fontSize: Math.round(W * 0.05),
      position: "bottom-center", outlineColor: "#000000", outlineWidth: 6,
      lineColor: "#FFFFFF", wordColor: "#c084fc", allCaps: true, maxWordsPerLine: 4 },
  };
}
function buildBatchItems() {
  const ext = (state.template.format || "mp4");
  return state.items.map((it, i) => {
    const name = (it.outputName && fill(it.outputName, { name: baseName(it.source), index: i + 1 })) || defaultName(it, i);
    return { name, outputName: `${name.replace(/[^a-zA-Z0-9-_]+/g, "_")}.${ext}`, manifest: buildManifest(it, i) };
  });
}

$("#renderBtn").onclick = async () => {
  $("#renderBtn").disabled = true;
  try {
    const items = buildBatchItems();
    const res = await fetch(`${API}/api/batches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("#batchName").value || "batch", items }),
    });
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    state.batchId = j.batchId;
    $("#downloadAll").href = `${API}/api/batches/${j.batchId}/download`;
    startPolling();
  } catch (e) {
    alert("Render failed: " + e.message);
    $("#renderBtn").disabled = false;
  }
};

$("#retryFailedBtn").onclick = async () => {
  if (!state.batchId) return;
  await fetch(`${API}/api/batches/${state.batchId}/retry-failed`, { method: "POST" });
  startPolling();
};

function startPolling() { if (state.poll) clearInterval(state.poll); state.poll = setInterval(refreshDash, 1000); refreshDash(); }

async function refreshDash() {
  if (!state.batchId) return;
  let b;
  try { b = await (await fetch(`${API}/api/batches/${state.batchId}`)).json(); } catch { return; }
  renderDash(b);
  const total = b.items.length;
  $("#summary").innerHTML =
    `<span class="muted">done</span> <b style="color:var(--ok)">${b.completed}</b>
     <span class="muted">active</span> <b style="color:var(--warn)">${b.active}</b>
     <span class="muted">queued</span> <b>${b.queued}</b>
     <span class="muted">failed</span> <b style="color:var(--err)">${b.failed}</b>
     <span class="muted">/ ${total}</span>`;
  $("#downloadAll").style.display = b.completed > 0 ? "inline" : "none";
  $("#retryFailedBtn").style.display = b.failed > 0 ? "inline-block" : "none";
  if (b.completed + b.failed >= total) { clearInterval(state.poll); state.poll = null; $("#renderBtn").disabled = false; }
}

function renderDash(b) {
  const tb = $("#dash");
  if (!b) {
    // pre-render preview from the edit list
    tb.innerHTML = state.items.map((it, i) =>
      `<tr><td>${i+1}</td><td>${esc(defaultName(it, i))}</td>
       <td><span class="status s-queued">not started</span></td>
       <td><div class="bar"><i></i></div></td><td class="muted">—</td></tr>`).join("");
    return;
  }
  tb.innerHTML = b.items.map((it) => {
    const pct = Math.round((it.progress || 0) * 100);
    const out = it.outputUrl ? `<a class="dl" href="${it.outputUrl}" target="_blank">view ⬇</a>` : '<span class="muted">—</span>';
    const err = it.status === "failed" && it.error ? `<div class="err-text" title="${esc(it.error)}">${esc(it.error)}</div>` : "";
    return `<tr>
      <td>${it.index + 1}</td>
      <td>${esc(it.name)}${err}</td>
      <td><span class="status s-${it.status}">${it.status}</span></td>
      <td><div class="bar"><i style="width:${pct}%"></i></div></td>
      <td>${out}</td></tr>`;
  }).join("");
}

// init
goto("upload");
