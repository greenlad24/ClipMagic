/**
 * Download a Gmail attachment through getEmailAttachment (base64) — the same
 * path the email viewer uses. Read-only: nothing is sent or changed.
 */
import { getEmailAttachment } from '@/deals/api';

type AttRef = { messageId: string; attachmentId: string; accountEmail: string; name: string; mimeType?: string };

async function attachmentBlob(att: AttRef): Promise<Blob> {
  const res = await getEmailAttachment({ messageId: att.messageId, attachmentId: att.attachmentId, accountEmail: att.accountEmail });
  const bytes = atob(res.data);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: att.mimeType || res.mimeType || 'application/octet-stream' });
}

export async function downloadAttachment(att: AttRef): Promise<void> {
  const blob = await attachmentBlob(att);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = att.name || 'attachment';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/**
 * Open a PDF (or image) in a new tab from a blob URL. The tab is opened
 * synchronously (inside the click) so popup blockers allow it, then pointed at
 * the blob once the bytes arrive.
 */
export async function previewAttachment(att: AttRef): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const blob = await attachmentBlob({ ...att, mimeType: att.mimeType || (/\.pdf$/i.test(att.name) ? 'application/pdf' : undefined) });
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  } catch (e) {
    tab?.close();
    throw e;
  }
}
