/**
 * UX Scout — the command line Claude Code drives the browser with.
 *
 * Runs INSIDE the lab container (the host wrapper /usr/local/bin/scout does
 * `docker exec … node dist/scout/cli.js`), signs its own session cookie and
 * calls /api/scout/* on localhost — so the browser stays owned by the server
 * process and nothing is opened outside the sign-in gate.
 *
 * The job comes from $SCOUT_JOB (set by the runner). Screenshot paths are
 * printed as HOST paths ($SCOUT_HOST_DATA replaces /data) so Claude Code can
 * open them with its Read tool.
 */
import { readFileSync } from "node:fs";
import { signSession, SESSION_COOKIE } from "../auth/session.js";

const BASE = process.env.SCOUT_API || `http://127.0.0.1:${process.env.PORT || 9090}/api/scout`;
const EMAIL = process.env.SCOUT_SESSION_EMAIL || "jakedawsonbusiness@gmail.com";
const DATA = process.env.DATA_DIR || "/data";
const HOST_DATA = process.env.SCOUT_HOST_DATA || "";

const hostPath = (p: string | null | undefined) => (p && HOST_DATA && p.startsWith(DATA) ? HOST_DATA + p.slice(DATA.length) : p ?? "");

async function call(fn: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${signSession(EMAIL, "UX Scout")}` },
    body: JSON.stringify(body ?? {}),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j;
}

const USAGE = `scout — drive the UX Scout browser (job from $SCOUT_JOB)

  shot                          screenshot of the current page
  goto <url> | back | forward | reload
  read [--all]                  interactive elements with [ref_N] handles + their centre @x,y
  text                          the page's visible text
  click <ref_N>                 click an element from \`read\`  (add --double)
  click <x> <y>                 click a point in the 1280x900 screenshot  (--double | --right)
  hover <ref_N> | hover <x> <y>
  type <text…>                  type at the focused field (click it first)
  key <combo> [repeat]          Enter, Tab, Escape, Backspace, ctrl+a, shift+Tab …
  scroll <up|down|left|right> [amount 1-15] [x y]
  wait <seconds>                up to 300 — use it for generations/renders, then \`shot\`
  zoom <x0> <y0> <x1> <y1>      sharper crop of part of the screen
  tabs | tab <n>                list / switch tabs (new tabs are followed automatically)
  upload <ref_N> <file>         upload one of the job's assets (see \`claim\`/status)
  note <text…>                  progress line Jake sees live in the Lab
  keep <caption…> [--file NNNN.jpg]   mark the latest (or a given) screenshot as a key shot
  finish <report.md> [--summary "<one line>"]   (host wrapper pipes the file)
  fail <reason…>
  status | claim`;

function parseFlags(args: string[]) {
  const flags = new Set(args.filter((a) => a.startsWith("--") && !a.includes("=")));
  return { flags, rest: args.filter((a) => !a.startsWith("--")) };
}

async function act(job: string, a: Record<string, unknown>) {
  const r = await call("act", { jobId: job, act: a });
  if (r.cancelled) { console.log(r.message); process.exit(3); }
  const lines = [`${r.ok ? "OK" : "FAILED"}: ${r.message}`];
  if (r.title || r.url) lines.push(`page: ${r.title ?? ""} — ${r.url ?? ""}`);
  if (r.output) lines.push("", r.output);
  if (r.file) lines.push(`SCREENSHOT: ${hostPath(r.file)}  (open it with Read)`);
  console.log(lines.join("\n"));
  if (!r.ok) process.exit(1);
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const job = process.env.SCOUT_JOB || "";
  const { flags, rest } = parseFlags(argv);
  const needJob = () => { if (!job) throw new Error("SCOUT_JOB is not set."); return job; };
  const num = (s: string | undefined, name: string) => { const n = Number(s); if (!Number.isFinite(n)) throw new Error(`${name} must be a number`); return n; };
  const isRef = (s: string | undefined) => !!s && /^ref_\d+$|^\d+$/.test(s) && rest.length === 1;

  switch (cmd) {
    case undefined: case "help": case "-h": case "--help": console.log(USAGE); return;
    case "claim": { const r = await call("claim", {}); console.log(JSON.stringify(r.job ? { ...r, dir: hostPath(r.dir) } : r)); return; }
    case "status": { console.log(JSON.stringify(await call("status", { jobId: rest[0] || needJob() }))); return; }
    case "stopped": { await call("stopped", { jobId: rest[0] || needJob() }); return; }
    case "shot": case "screenshot": return act(needJob(), { action: "screenshot" });
    case "goto": return act(needJob(), { action: "goto", url: rest[0] });
    case "back": case "forward": case "reload": return act(needJob(), { action: cmd });
    case "read": return act(needJob(), { action: "read", all: flags.has("--all") });
    case "text": return act(needJob(), { action: "text" });
    case "tabs": return act(needJob(), { action: "tabs" });
    case "tab": return act(needJob(), { action: "tab", index: num(rest[0], "tab") });
    case "click":
      if (isRef(rest[0])) return act(needJob(), { action: "click_ref", ref: rest[0].startsWith("ref_") ? rest[0] : `ref_${rest[0]}`, double: flags.has("--double") });
      return act(needJob(), { action: "click", x: num(rest[0], "x"), y: num(rest[1], "y"), double: flags.has("--double"), button: flags.has("--right") ? "right" : "left" });
    case "hover":
      if (isRef(rest[0])) return act(needJob(), { action: "hover_ref", ref: rest[0].startsWith("ref_") ? rest[0] : `ref_${rest[0]}` });
      return act(needJob(), { action: "hover", x: num(rest[0], "x"), y: num(rest[1], "y") });
    case "type": return act(needJob(), { action: "type", text: argv.join(" ") });
    case "key": return act(needJob(), { action: "key", combo: rest[0], repeat: rest[1] ? num(rest[1], "repeat") : 1 });
    case "scroll": return act(needJob(), { action: "scroll", direction: rest[0] ?? "down", amount: rest[1] ? num(rest[1], "amount") : 3, ...(rest[3] ? { x: num(rest[2], "x"), y: num(rest[3], "y") } : {}) });
    case "wait": return act(needJob(), { action: "wait", seconds: num(rest[0], "seconds") });
    case "zoom": return act(needJob(), { action: "zoom", x0: num(rest[0], "x0"), y0: num(rest[1], "y0"), x1: num(rest[2], "x1"), y1: num(rest[3], "y1") });
    case "upload": return act(needJob(), { action: "upload", ref: rest[0]?.startsWith("ref_") ? rest[0] : `ref_${rest[0]}`, file: rest.slice(1).join(" ") });
    case "note": { await call("note", { jobId: needJob(), text: argv.join(" ") }); console.log("noted"); return; }
    case "keep": {
      const fi = argv.indexOf("--file");
      const file = fi >= 0 ? argv[fi + 1] : undefined;
      const caption = argv.filter((_, i) => i !== fi && i !== fi + 1).join(" ");
      const r = await call("keep", { jobId: needJob(), caption, file });
      console.log(`kept as ${r.id} (${r.keyShots} key shots)`);
      return;
    }
    case "finish": {
      const si = argv.indexOf("--summary");
      const summary = si >= 0 ? argv[si + 1] : undefined;
      const src = argv.find((a, i) => !a.startsWith("--") && i !== si + 1);
      const report = !src || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
      await call("finish", { jobId: needJob(), report, summary });
      console.log("Report saved. The Scout is done — stop now.");
      return;
    }
    case "fail": { await call("fail", { jobId: needJob(), error: argv.join(" ") }); console.log("Marked failed."); return; }
    default: console.error(`Unknown command "${cmd}".\n\n${USAGE}`); process.exit(2);
  }
}

main().catch((e) => { console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
