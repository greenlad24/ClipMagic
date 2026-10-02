// All data now goes through Zite Database via backend endpoints
import {
  getDeals, GetDealsOutputType,
  createDeal, CreateDealOutputType,
  updateDeal,
  getComments, GetCommentsOutputType,
  addComment, AddCommentOutputType,
  getActions, GetActionsOutputType,
  addAction, AddActionOutputType,
  updateActionStatus,
} from '@/deals/api';

import { Stage } from './stages';
export type { Stage };

export type Confidence = 'high' | 'medium' | 'low';

/**
 * Additive server fields (card autofill, 2026-09-30): `deadline_date` = the date
 * parsed from the free-text `deadline`; `card_asof` = the latest email the
 * auto-filled card is based on; `fields_source` = { field: 'ai' | 'human' }.
 */
export interface DealAutoFields {
  deadline_date?: string | null;
  deadline_parsed_from?: string | null;
  card_asof?: string | null;
  card_filled_at?: string | null;
  fields_source?: Record<string, string>;
}
export type Deal = GetDealsOutputType['deals'][0] & { stage: Stage; confidence: Confidence | null } & DealAutoFields;
export type Comment = GetCommentsOutputType['comments'][0];
/** `source: 'auto'` = kept up to date from the email thread. */
export type Action = GetActionsOutputType['actions'][0] & { status: 'pending' | 'in_progress' | 'done'; source?: string | null; status_by?: string | null; updated_at?: string | null };

export async function fetchDeals(): Promise<Deal[]> {
  const { deals } = await getDeals({});
  return deals as Deal[];
}

export async function apiCreateDeal(data: {
  client_name: string; client_email: string; project_name?: string | null;
  description?: string | null; estimated_value?: number | null; currency?: string;
  stage?: string; confidence?: string | null; source?: string | null;
  source_email_id?: string | null; source_thread_id?: string | null;
}): Promise<Deal> {
  const { deal } = await createDeal(data) as CreateDealOutputType;
  return deal as Deal;
}

export async function apiUpdateDeal(id: string, updates: Partial<{
  client_name: string; client_email: string; project_name: string | null;
  description: string | null; estimated_value: number | null; currency: string;
  stage: string; confidence: string | null; source: string | null; archived: boolean;
  about: string | null; opportunity: string | null; key_details: string | null;
  contact_info: string | null; links_text: string | null; files_text: string | null;
  next_steps: string | null; thread_link: string | null; last_scanned_at: string | null; deadline: string | null; in_production?: boolean;
}>): Promise<Deal> {
  const { deal } = await updateDeal({ id, updates });
  return deal as Deal;
}

export async function fetchComments(dealId: string): Promise<Comment[]> {
  const { comments } = await getComments({ dealId });
  return comments;
}

export async function apiAddComment(dealId: string, content: string, author = 'You'): Promise<Comment> {
  const { comment } = await addComment({ dealId, content, author }) as AddCommentOutputType;
  return comment;
}

export async function fetchActions(dealId: string): Promise<Action[]> {
  const { actions } = await getActions({ dealId });
  return actions as Action[];
}

export async function apiAddAction(dealId: string, content: string): Promise<Action> {
  const { action } = await addAction({ dealId, content }) as AddActionOutputType;
  return action as Action;
}

export async function apiUpdateActionStatus(id: string, status: Action['status']): Promise<void> {
  await updateActionStatus({ id, status });
}
