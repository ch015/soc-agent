/** SSE streaming for job progress. GET /jobs/:id/stream */
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { PgPool } from '../job/store.js';
import { getJob, getJobEventsSince } from '../job/store.js';
import { isTerminal } from '../job/lifecycle.js';
import { getConfig } from '../config.js';

/**
 * SSE handler for job event streaming.
 * Supports Last-Event-ID for reconnection.
 * Sends heartbeat every 30s.
 */
export function handleJobStream(pool: PgPool) {
  return async (c: Context) => {
    const jobId = c.req.param('id');
    const job = await getJob(pool, jobId);
    if (!job) {
      return c.json({ error: 'Job not found' }, 404);
    }

    // Verify tenant ownership (strict: auth middleware always sets tenantId)
    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId') as string | undefined;
    if (!tenantId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (job.tenantId !== tenantId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const lastEventId = parseInt(c.req.header('Last-Event-ID') ?? '0', 10) || 0;
    const heartbeatMs = getConfig().SSE_HEARTBEAT_INTERVAL_MS;

    return streamSSE(c, async (stream) => {
      let currentLastId = lastEventId;
      let jobTerminated = isTerminal(job.status);

      // Send any events since Last-Event-ID (replay on reconnect)
      const missed = await getJobEventsSince(pool, jobId, currentLastId);
      for (const event of missed) {
        await stream.writeSSE({
          id: String(event.id),
          event: event.eventType,
          data: JSON.stringify(event.payload),
        });
        currentLastId = event.id;
        if (event.eventType === 'completed' || event.eventType === 'failed') {
          jobTerminated = true;
        }
      }

      if (jobTerminated) {
        return;
      }

      // Poll loop with heartbeat
      const pollInterval = 1000;
      let heartbeatTimer = 0;

      while (!stream.aborted) {
        await new Promise((r) => setTimeout(r, pollInterval));
        heartbeatTimer += pollInterval;

        // Fetch new events
        const events = await getJobEventsSince(pool, jobId, currentLastId);
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.id),
            event: event.eventType,
            data: JSON.stringify(event.payload),
          });
          currentLastId = event.id;
          if (event.eventType === 'completed' || event.eventType === 'failed') {
            jobTerminated = true;
          }
        }

        if (jobTerminated) {
          return;
        }

        // Heartbeat (comment-only, no data frame)
        if (heartbeatTimer >= heartbeatMs) {
          await stream.write(': heartbeat\n\n');
          heartbeatTimer = 0;
        }
      }
    });
  };
}

/**
 * Format a single SSE event string (used by tests and utilities).
 */
export function formatSSE(event: { id?: string; event?: string; data: string }): string {
  const lines: string[] = [];
  if (event.id) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  lines.push(`data: ${event.data}`);
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

/**
 * Format a heartbeat comment.
 */
export function formatHeartbeat(): string {
  return ': heartbeat\n\n';
}
