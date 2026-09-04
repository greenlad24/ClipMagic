/**
 * Exporting a finished script to a Google Doc.
 *
 * SCOPE IS `drive.file`, DELIBERATELY. That grant covers only files this app
 * itself creates — it cannot read, edit or delete anything else in the Drive,
 * so connecting it does not hand the lab the keys to Jake's documents. The
 * broader `drive` scope would make folder browsing easier and is not worth it;
 * this mirrors the read-only posture of the YouTube Analytics client, which
 * refuses an over-broad grant before the token reaches disk.
 *
 * The consequence to know about: `drive.file` cannot LIST files it did not
 * create. Auto-numbering therefore reads what it can see and takes the DB's
 * high-water mark as a floor, so a number can never be reused even when Drive
 * hides a doc that was made by hand.
 */
import { getGoogleDocsOAuth, setGoogleDocsHighWater, getGoogleDocsHighWater } from "../settings/postizSecrets.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";
const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";

/** The only grant this feature ever asks for. */
export const GDOCS_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * Everything this module is allowed to call. A URL outside the list throws
 * rather than being sent — the same guard the analytics client uses, for the
 * same reason: a future edit must not be able to quietly widen what a stored
 * credential reaches.
 */
const ALLOWED_ENDPOINTS = [UPLOAD_ENDPOINT, FILES_ENDPOINT];

export class DocsScopeError extends Error {}

/**
 * Refuse a grant wider than `drive.file` BEFORE it is stored. A token that can
 * delete a Drive must not be storable at all, not merely unused.
 */
export function assertDriveFileScope(granted: string | undefined): void {
  const scopes = (granted || "").split(/\s+/).filter(Boolean);
  const extra = scopes.filter((s) => s !== GDOCS_SCOPE && !/^openid$|userinfo\.(email|profile)$/.test(s));
  if (extra.length > 0) {
    throw new DocsScopeError(`Refusing a grant that also includes: ${extra.join(", ")}`);
  }
}

export function googleDocsConfigured(): boolean {
  const c = getGoogleDocsOAuth();
  return Boolean(c?.clientId && c?.clientSecret && c?.refreshToken);
}

/** Exchange the stored refresh token for a short-lived access token. */
async function accessToken(): Promise<string> {
  const creds = getGoogleDocsOAuth();
  if (!creds?.clientId || !creds.clientSecret) {
    throw new Error("Google Docs export is not configured. Add the client ID and secret in Settings.");
  }
  if (!creds.refreshToken) {
    throw new Error("Google Docs export is not connected yet. Connect it in Settings.");
  }
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string };
  if (!r.ok || !j.access_token) {
    throw new Error(`Google refused the token refresh (${j.error || r.status}). Reconnect it in Settings.`);
  }
  // Re-check on every refresh: a grant can be widened out from under us by a
  // re-consent elsewhere, and this is the last point before we spend it.
  assertDriveFileScope(j.scope);
  return j.access_token;
}

function assertAllowed(url: string): void {
  if (!ALLOWED_ENDPOINTS.some((e) => url.startsWith(e))) {
    throw new DocsScopeError(`Refusing to call a Drive endpoint outside the allow-list: ${url}`);
  }
}

/** A folder id out of whatever Jake pasted — a bare id, or any Drive folder URL. */
export function parseFolderId(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  const fromUrl = raw.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || raw.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (fromUrl) return fromUrl[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(raw) ? raw : null;
}

/** `01 - Title`, zero-padded to two so a folder sorts correctly up to 99. */
export function docName(n: number, title: string): string {
  const clean = (title || "Untitled").replace(/\s+/g, " ").trim().slice(0, 180);
  return `${String(n).padStart(2, "0")} - ${clean}`;
}

/** The leading number of an existing doc name, if it has one. */
export function leadingNumber(name: string): number | null {
  const m = (name || "").match(/^\s*(\d{1,3})\s*-\s*/);
  return m ? Number(m[1]) : null;
}

/**
 * The next number for this folder.
 *
 * Two sources, because neither is sufficient alone: Drive knows about docs this
 * app created, and the stored high-water mark covers the ones `drive.file`
 * cannot see. Taking the max of both means a number is never reused, which
 * matters more than the sequence being gapless.
 */
export async function nextDocNumber(folderId: string, token: string): Promise<number> {
  let highest = getGoogleDocsHighWater(folderId);
  try {
    const url = `${FILES_ENDPOINT}?${new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(name)",
      pageSize: "200",
      orderBy: "name desc",
    })}`;
    assertAllowed(url);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const j = (await r.json()) as { files?: Array<{ name?: string }> };
      for (const f of j.files ?? []) {
        const n = leadingNumber(f.name ?? "");
        if (n !== null && n > highest) highest = n;
      }
    }
    // A failed listing is not fatal — the high-water mark alone still yields a
    // number that has never been used.
  } catch {
    /* fall through to the stored floor */
  }
  return highest + 1;
}

/**
 * Create the doc.
 *
 * One multipart upload: plain text in, `application/vnd.google-apps.document`
 * out, so Drive does the conversion and no second Docs API call (or wider
 * scope) is needed.
 */
export async function exportScriptToDoc(opts: {
  folderId: string;
  title: string;
  body: string;
}): Promise<{ docId: string; docUrl: string; name: string; number: number }> {
  const folderId = parseFolderId(opts.folderId);
  if (!folderId) {
    throw new Error("That doesn't look like a Google Drive folder — paste the folder's URL or its id.");
  }
  if (!opts.body.trim()) {
    throw new Error("There is nothing to export: the script is empty.");
  }
  const token = await accessToken();
  const number = await nextDocNumber(folderId, token);
  const name = docName(number, opts.title);

  const boundary = `clipmagic-${Date.now()}`;
  const metadata = {
    name,
    parents: [folderId],
    mimeType: "application/vnd.google-apps.document",
  };
  const multipart =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
    `${opts.body}\r\n` +
    `--${boundary}--`;

  const url = `${UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name`;
  assertAllowed(url);
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipart,
  });
  const text = await r.text();
  if (!r.ok) {
    // Drive's own message is the useful part — a bare 404 here almost always
    // means the folder id is wrong or belongs to another account.
    throw new Error(`Google refused to create the doc (${r.status}): ${text.slice(0, 300)}`);
  }
  const j = JSON.parse(text) as { id?: string; name?: string };
  if (!j.id) throw new Error("Google created no document and gave no reason.");

  // Record the number BEFORE returning: a crash after this point costs a gap in
  // the sequence, which is harmless, whereas forgetting it would reuse a number.
  setGoogleDocsHighWater(folderId, number);

  return {
    docId: j.id,
    docUrl: `https://docs.google.com/document/d/${j.id}/edit`,
    name: j.name || name,
    number,
  };
}
