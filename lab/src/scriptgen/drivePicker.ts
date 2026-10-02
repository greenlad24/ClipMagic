/**
 * Google's own Drive Picker, used to choose the folder scripts are exported
 * into — browsing the CONNECTED Google account's Drive (Jake 2026-10-02:
 * "choose the folder inside the new account").
 *
 * The export only holds the drive.file scope, which cannot list Drive at all.
 * The Picker is Google's answer to that: it shows the whole Drive in a Google
 * dialog, and the folder picked there is granted to this app (via appId), so
 * exports can create docs inside it.
 */

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gapi?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google?: any;
  }
}

let loading: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const done = () => window.gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('Google Picker failed to load')) });
    if (window.gapi) return done();
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.referrerPolicy = 'origin';
    s.async = true;
    s.onload = done;
    s.onerror = () => reject(new Error('Could not load Google’s picker (apis.google.com)'));
    document.head.appendChild(s);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/**
 * The Lab sends `Referrer-Policy: no-referrer`, and Google checks the Picker API
 * key's website restriction (lab.jakedaw.com) against the Referer — an empty one
 * is "API developer key is invalid" (2026-10-02). While the picker is open the
 * page sends its ORIGIN only (never a path); the previous policy comes back when
 * it closes. A <meta name="referrer"> set later in the document overrides the
 * header for requests made from then on.
 */
function withOriginReferrer(): () => void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
  const created = !meta;
  const previous = meta?.content ?? '';
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'referrer';
    document.head.appendChild(meta);
  }
  meta.content = 'strict-origin';
  return () => {
    if (created) meta!.remove();
    else meta!.content = previous;
  };
}

/** Opens the picker; resolves with the chosen folder, or null when cancelled. */
export async function pickDriveFolder(opts: { accessToken: string; apiKey: string; appId: string }): Promise<{ id: string; name: string } | null> {
  const restore = withOriginReferrer();
  try {
    return await openPicker(opts);
  } finally {
    restore();
  }
}

async function openPicker(opts: { accessToken: string; apiKey: string; appId: string }): Promise<{ id: string; name: string } | null> {
  // Never fail silently: if Google's script hangs (blocked by an extension or a
  // network rule), say so instead of leaving the button spinning.
  await Promise.race([
    loadPicker(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Google’s folder picker did not load in 20 seconds — an ad/privacy blocker may be blocking apis.google.com or docs.google.com for this site.')), 20000),
    ),
  ]);
  const g = window.google.picker;
  return new Promise((resolve, reject) => {
    const myDrive = new g.DocsView(g.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder')
      .setParent('root');
    const shared = new g.DocsView(g.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder')
      .setEnableDrives(true);
    const picker = new g.PickerBuilder()
      .addView(myDrive)
      .addView(shared)
      .enableFeature(g.Feature.SUPPORT_DRIVES)
      .setOAuthToken(opts.accessToken)
      .setDeveloperKey(opts.apiKey)
      .setAppId(opts.appId)
      .setTitle('Choose the folder for exported scripts')
      // The Lab sends no Referer (referrer-policy: no-referrer), so tell the
      // picker which site is asking explicitly.
      .setOrigin(window.location.origin)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .setCallback((data: any) => {
        if (data.action === g.Action.PICKED) {
          const doc = data.docs?.[0];
          resolve(doc ? { id: String(doc.id), name: String(doc.name ?? '') } : null);
        } else if (data.action === g.Action.CANCEL) {
          resolve(null);
        } else if (data.action === 'error' || data.action === g.Action.ERROR) {
          reject(new Error('Google’s picker reported an error — check the Picker API key and that the Google Picker API is enabled.'));
        }
      })
      .build();
    picker.setVisible(true);
  });
}
