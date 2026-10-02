/**
 * After a reply is saved as a Gmail DRAFT (the default) or SENT from the Lab
 * (a Send button Jake clicked), show where it is.
 */
import { toast } from 'sonner';

export function openInGmail(gmailUrl?: string | null) {
  if (gmailUrl) window.open(gmailUrl, '_blank', 'noopener,noreferrer');
}

export function toastDraftSaved(message: string, gmailUrl?: string | null) {
  toast.success(message, {
    description: 'Nothing was sent. Review it in Gmail and send it from there.',
    duration: 10000,
    ...(gmailUrl ? { action: { label: 'Open in Gmail', onClick: () => openInGmail(gmailUrl) } } : {}),
  });
}

export function toastSent(message: string, gmailUrl?: string | null) {
  toast.success(message, {
    duration: 8000,
    ...(gmailUrl ? { action: { label: 'Open in Gmail', onClick: () => openInGmail(gmailUrl) } } : {}),
  });
}
