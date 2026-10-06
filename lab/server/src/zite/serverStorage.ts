/**
 * Storage page → "Whole server": every file on the host's root filesystem, and a
 * delete that really frees the space.
 *
 * ⚠️ THIS MODULE IS A THIN CLIENT, NOT THE GUARD. The Lab is a container and can
 * see neither the host filesystem nor delete from it, so all of it — the index, the
 * hard-link bookkeeping, every protection rule, the delete itself and its log — is
 * the `storage-agent` systemd service on the HOST (/opt/clipmagic/storage-agent).
 * We talk to it over HTTP on a unix socket bind-mounted at /storage-agent/agent.sock
 * (docker-compose.yml). Do not add path checks here thinking they protect anything:
 * the agent refuses on its own, so a check here could only drift from the real one.
 *
 * Deletes are two-step on purpose: `serverStoragePreview` returns what WOULD go
 * (every hard link, open-file holders, protected refusals) plus a plan id; only
 * `serverStorageDelete(planId)` acts, and the agent re-verifies everything against
 * the disk at that moment. Over 1 GB the agent requires confirm === "DELETE".
 *
 * Independent of the data-volume cards in storage.ts — their partition invariant is
 * untouched. The Lab's own volume shows up here as part of /var/lib/docker, which
 * the agent lists but never deletes from.
 */
import http from "node:http";
import { ZiteError } from "./store.js";

const SOCKET = process.env.STORAGE_AGENT_SOCKET || "/storage-agent/agent.sock";

function agentRequest<T>(method: "GET" | "POST", pathName: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path: pathName,
        timeout: timeoutMs,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let parsed: any;
          try {
            parsed = JSON.parse(text || "{}");
          } catch {
            reject(new Error(`Storage agent returned non-JSON (${res.statusCode})`));
            return;
          }
          if ((res.statusCode ?? 500) >= 400) {
            reject(new ZiteError({ code: "BAD_REQUEST", message: parsed?.error || `Storage agent error ${res.statusCode}` }));
            return;
          }
          resolve(parsed as T);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("The storage agent did not answer in time")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** A missing socket is a state the page explains, not an error toast. */
async function orUnavailable<T extends object>(fn: () => Promise<T>): Promise<T | { available: false; reason: string }> {
  try {
    return { available: true, ...(await fn()) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      return {
        available: false,
        reason: "The storage agent isn't running on the server (systemctl status storage-agent), so only The Lab's own data is shown.",
      };
    }
    throw e;
  }
}

const str = (v: unknown, max = 4096) => (typeof v === "string" && v.length <= max ? v : undefined);

export async function serverStorageSummary() {
  return orUnavailable(() => agentRequest<object>("GET", "/summary"));
}

export async function serverStorageTree(input: any) {
  const p = str(input?.path) ?? "/";
  return orUnavailable(() => agentRequest<object>("GET", `/tree?path=${encodeURIComponent(p)}`));
}

export async function serverStorageType(input: any) {
  const t = str(input?.type, 40) ?? "";
  return orUnavailable(() => agentRequest<object>("GET", `/type?type=${encodeURIComponent(t)}`));
}

export async function serverStorageRefresh() {
  return orUnavailable(() => agentRequest<object>("POST", "/refresh", {}));
}

export async function serverStorageLog(input: any) {
  const limit = Math.max(1, Math.min(200, Number(input?.limit) || 30));
  return orUnavailable(() => agentRequest<object>("GET", `/log?limit=${limit}`));
}

export async function serverStoragePreview(input: any) {
  const paths = Array.isArray(input?.paths) ? input.paths.filter((p: unknown) => typeof p === "string") : [];
  if (!paths.length) throw new ZiteError({ code: "BAD_REQUEST", message: "Nothing selected." });
  // Walking a big folder to find every hard link can take a while.
  return agentRequest<object>("POST", "/preview", { paths }, 5 * 60_000);
}

export async function serverStorageDelete(input: any) {
  const planId = str(input?.planId, 64);
  if (!planId) throw new ZiteError({ code: "BAD_REQUEST", message: "Review the selection first." });
  return agentRequest<object>(
    "POST",
    "/delete",
    // `__actor` is stamped by the /api/fn router from the signed-in session — it
    // overwrites anything the browser sent under that name.
    { planId, confirm: str(input?.confirm, 32), actor: str(input?.__actor, 200) ?? "lab" },
    15 * 60_000,
  );
}
