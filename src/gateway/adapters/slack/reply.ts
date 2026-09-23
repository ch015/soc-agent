/** Send Slack thread replies (progress, result, clarification). */
import type { Job, ProgressEvent, ResultPayload } from '../../job/types.js';

const SLACK_API_BASE = 'https://slack.com/api';

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

/**
 * Post a new message to a Slack thread.
 */
export async function postThreadReply(
  botToken: string,
  channel: string,
  threadTs: string,
  text: string,
  blocks?: unknown[],
): Promise<SlackApiResponse> {
  const body: Record<string, unknown> = {
    channel,
    thread_ts: threadTs,
    text,
  };
  if (blocks) body.blocks = blocks;

  const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as SlackApiResponse;
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error}`);
  }
  return data;
}

/**
 * Update an existing Slack message.
 */
export async function updateMessage(
  botToken: string,
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[],
): Promise<SlackApiResponse> {
  const body: Record<string, unknown> = {
    channel,
    ts,
    text,
  };
  if (blocks) body.blocks = blocks;

  const response = await fetch(`${SLACK_API_BASE}/chat.update`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as SlackApiResponse;
  if (!data.ok) {
    throw new Error(`Slack chat.update failed: ${data.error}`);
  }
  return data;
}

/**
 * Send a progress update to the Slack thread.
 */
export async function sendProgressReply(
  botToken: string,
  job: Job,
  progress: ProgressEvent,
): Promise<void> {
  const channel = job.callback.channel;
  const threadTs = job.callback.threadTs;
  if (!channel || !threadTs) throw new Error('Slack callback channel and threadTs are required');

  const text = `🔄 ${progress.phase}${progress.percent > 0 ? ` (${progress.percent}%)` : ''}${progress.detail ? ` — ${progress.detail}` : ''}`;
  await postThreadReply(botToken, channel, threadTs, text);
}

/**
 * Send a result reply to the Slack thread based on payload type.
 */
export async function sendResultReply(
  botToken: string,
  job: Job,
  payload: ResultPayload,
): Promise<void> {
  const channel = job.callback.channel;
  const threadTs = job.callback.threadTs;
  if (!channel || !threadTs) throw new Error('Slack callback channel and threadTs are required');

  let text: string;

  switch (payload.type) {
    case 'completed':
      text = `✅ 검토 완료.\n${payload.summary ?? ''}`;
      if (payload.reportUrl) {
        text += `\n📄 전문 보기: ${payload.reportUrl}`;
      }
      break;

    case 'clarification':
      text = `❓ 추가 정보가 필요합니다:\n${(payload.questions ?? []).map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
      break;

    case 'failed':
      text = `⚠️ 검토 실패: ${payload.error ?? '알 수 없는 오류'}`;
      break;

    case 'cancelled':
      text = '🚫 검토가 취소되었습니다.';
      break;

    case 'progress':
      text = `🔄 ${payload.phase ?? '진행 중'}${payload.percent != null ? ` (${payload.percent}%)` : ''}`;
      break;

    default:
      text = `Job ${job.id} status update: ${payload.type}`;
  }

  await postThreadReply(botToken, channel, threadTs, text);
}

/**
 * Send the initial "접수됨" acknowledgement.
 */
export async function sendAcknowledgement(
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<void> {
  await postThreadReply(botToken, channel, threadTs, '✓ 접수됨. 검토를 시작합니다.');
}
