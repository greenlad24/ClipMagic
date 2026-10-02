/**
 * The ORIGINAL 25 stages — only a fallback now (StageLabelsContext uses it if
 * getStages fails, and for the colours of built-in keys). Screens read the live
 * stage list + labels from StageLabelsContext (the Emails page pills still read
 * this array — that page is being redesigned).
 */
export type Stage =
  | 'rejected'
  | 'poor_fit_now'
  | 'to_follow_up_with'
  | 'new_requests'
  | 'potential_future_collaboration'
  | 'started_negotiation_no_answer'
  | 'contract_negotiation'
  | 'waiting_for_invoice'
  | 'waiting_for_payment'
  | 'contract_signed'
  | 'invoice_created_sent'
  | 'in_research'
  | 'need_to_script'
  | 'script_in_review'
  | 'script_fixes'
  | 'need_to_film'
  | 'in_video_editing'
  | 'video_draft_submitted'
  | 'reviewed_require_fixes'
  | 'video_fixed_sent'
  | 'second_review'
  | 'video_ready_publish'
  | 'second_invoice_sent'
  | 'second_invoice_paid'
  | 'completed';

export interface StageConfig {
  value: Stage;
  label: string;
  shortLabel: string;
  cssVar: string;
}

export const STAGES: StageConfig[] = [
  { value: 'rejected',                      label: 'Rejected',                               shortLabel: 'Rejected',        cssVar: 'rejected' },
  { value: 'poor_fit_now',                  label: 'Poor Fit Now',                           shortLabel: 'Poor Fit',        cssVar: 'poor-fit' },
  { value: 'to_follow_up_with',             label: 'To Follow Up With',                      shortLabel: 'Follow Up',       cssVar: 'follow-up' },
  { value: 'new_requests',                  label: 'New Requests',                           shortLabel: 'New',             cssVar: 'new-requests' },
  { value: 'potential_future_collaboration',label: 'Potential Future Collaboration',          shortLabel: 'Future Collab',   cssVar: 'future-collab' },
  { value: 'started_negotiation_no_answer', label: 'Started Negotiation (But Did Not Answer)',shortLabel: 'No Answer',       cssVar: 'no-answer' },
  { value: 'contract_negotiation',          label: 'Date/Contract Negotiation',              shortLabel: 'Negotiation',     cssVar: 'negotiation' },
  { value: 'waiting_for_invoice',           label: 'Waiting For Invoice',                    shortLabel: 'Invoice',         cssVar: 'invoice' },
  { value: 'waiting_for_payment',           label: 'Waiting For Payment',                    shortLabel: 'Payment',         cssVar: 'payment' },
  // ── Production pipeline ──
  { value: 'contract_signed',               label: 'Contract Signed',                        shortLabel: 'Signed',          cssVar: 'contract-signed' },
  { value: 'invoice_created_sent',          label: 'Created Invoice & Sent',                 shortLabel: 'Invoice Sent',    cssVar: 'invoice-sent' },
  { value: 'in_research',                   label: 'In Research',                            shortLabel: 'Research',        cssVar: 'research' },
  { value: 'need_to_script',                label: 'Need To Script',                         shortLabel: 'To Script',       cssVar: 'scripting' },
  { value: 'script_in_review',              label: 'Script In Review',                       shortLabel: 'Script Review',   cssVar: 'script-review' },
  { value: 'script_fixes',                  label: 'Script Fixes',                           shortLabel: 'Script Fixes',    cssVar: 'script-fixes' },
  { value: 'need_to_film',                  label: 'Need To Film (Script Confirmed)',         shortLabel: 'To Film',         cssVar: 'filming' },
  { value: 'in_video_editing',              label: 'In Video Editing',                        shortLabel: 'Editing',         cssVar: 'video-editing' },
  { value: 'video_draft_submitted',         label: 'Video Draft Submitted',                  shortLabel: 'Draft',           cssVar: 'draft' },
  { value: 'reviewed_require_fixes',        label: 'Reviewed & Require Fixes',               shortLabel: 'Need Fixes',      cssVar: 'need-fixes' },
  { value: 'video_fixed_sent',              label: 'Video Fixed Sent',                       shortLabel: 'Fix Sent',        cssVar: 'video-fixed' },
  { value: 'second_review',                 label: '2nd Review',                             shortLabel: '2nd Review',      cssVar: 'second-review' },
  { value: 'video_ready_publish',           label: 'Video Ready For Publish',                shortLabel: 'Ready',           cssVar: 'ready-publish' },
  { value: 'second_invoice_sent',           label: '2nd Invoice Sent',                       shortLabel: '2nd Invoice',     cssVar: 'second-invoice' },
  { value: 'second_invoice_paid',           label: '2nd Invoice Paid',                       shortLabel: '2nd Paid',        cssVar: 'second-paid' },
  { value: 'completed',                     label: 'Completed',                              shortLabel: 'Completed',       cssVar: 'completed' },
];

export function sc(cssVar: string) {
  return `hsl(var(--stage-${cssVar}))`;
}
