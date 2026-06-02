/**
 * Shared helper: poll a Rendi FFmpeg command's status by calling
 * GET /v1/commands/{command_id} and persisting updates to the
 * Render Jobs and Projects tables.
 *
 * Used by both the polling endpoint and the webhook endpoint.
 */
import {
  RenderJobs,
  Projects,
} from 'zite-integrations-backend-sdk';
import { getRendiConfig, rendiHeaders } from './rendiConfig';

// ── Types ────────────────────────────────────────────────────────────────────

export type InternalStatus = 'Submitted' | 'Processing' | 'Done' | 'Error';

/** Rendi command statuses */
type RendiCommandStatus = 'QUEUED' | 'PROCESSING' | 'PREPARED_FFMPEG_COMMAND' | 'FAILED' | 'SUCCESS';

export interface RendiCommandResponse {
  command_id: string;
  status: RendiCommandStatus;
  processing_stage?: string | null;
  error_status?: string | null;
  error_message?: string | null;
  total_processing_seconds?: number | null;
  ffmpeg_command_run_seconds?: number | null;
  output_files?: Record<string, {
    file_id: string;
    storage_url?: string | null;
    duration?: number | null;
    width?: number | null;
    height?: number | null;
    size_mbytes?: number | null;
    codec?: string | null;
    pixel_format?: string | null;
    [k: string]: unknown;
  }> | null;
  [k: string]: unknown;
}

export interface VerifyResult {
  status: InternalStatus;
  terminal: boolean;
  outputUrl: string | null;
  subtitleAssUrl: string | null;
  renderingTime: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  outputDuration: number | null;
  errorMessage: string | null;
}

// ── Status Mapping ───────────────────────────────────────────────────────────

export function mapRendiStatus(rendiStatus: string): InternalStatus {
  const s = rendiStatus.toUpperCase();
  if (s === 'SUCCESS') return 'Done';
  if (s === 'FAILED') return 'Error';
  if (s === 'PROCESSING' || s === 'PREPARED_FFMPEG_COMMAND') return 'Processing';
  if (s === 'QUEUED') return 'Submitted';
  return 'Processing';
}

// ── Main Verify + Persist ────────────────────────────────────────────────────

/**
 * Poll Rendi for the command status, persist updates to the Render Jobs
 * record and (on terminal states) the parent Project record.
 */
export async function verifyAndPersist(
  jobRecordId: string,
  rendiCommandId: string,
  projectId: string | undefined,
): Promise<VerifyResult> {
  const config = getRendiConfig();

  const res = await fetch(
    `${config.baseUrl}/v1/commands/${encodeURIComponent(rendiCommandId)}`,
    { method: 'GET', headers: rendiHeaders(config) },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown');
    throw new Error(`Rendi status API returned ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as RendiCommandResponse;
  const mappedStatus = mapRendiStatus(data.status ?? '');
  const isTerminal = mappedStatus === 'Done' || mappedStatus === 'Error';

  // ── Extract output file info ────────────────────────────────────────────
  const out1 = data.output_files?.out_1;
  const outputUrl = out1?.storage_url ?? null;
  const outputWidth = typeof out1?.width === 'number' ? out1.width : null;
  const outputHeight = typeof out1?.height === 'number' ? out1.height : null;
  const outputDuration = typeof out1?.duration === 'number' ? out1.duration : null;
  const renderingTime = typeof data.total_processing_seconds === 'number'
    ? data.total_processing_seconds : null;

  // ── Persist to Render Jobs ──────────────────────────────────────────────
  const updates: Record<string, unknown> = { status: mappedStatus };

  if (outputUrl) updates.outputUrl = outputUrl;
  if (renderingTime !== null) updates.renderingTime = renderingTime;
  if (outputWidth !== null) updates.outputWidth = outputWidth;
  if (outputHeight !== null) updates.outputHeight = outputHeight;
  if (outputDuration !== null) updates.outputDuration = outputDuration;
  if (mappedStatus === 'Error') {
    updates.errorMessage = data.error_message || data.error_status || 'Unknown render error';
  }

  await RenderJobs.update({ id: jobRecordId, record: updates });

  // ── Update parent Project on terminal states ────────────────────────────
  if (isTerminal && projectId) {
    if (mappedStatus === 'Done' && outputUrl) {
      await Projects.update({
        id: projectId,
        record: { status: 'Complete', outputUrl },
      });
    } else if (mappedStatus === 'Error') {
      await Projects.update({ id: projectId, record: { status: 'Error' } });
    }
  }

  return {
    status: mappedStatus,
    terminal: isTerminal,
    outputUrl,
    subtitleAssUrl: null,
    renderingTime,
    outputWidth,
    outputHeight,
    outputDuration,
    errorMessage: mappedStatus === 'Error'
      ? (data.error_message || data.error_status || 'Unknown render error')
      : null,
  };
}
