import { Router } from 'express';
import { randomUUID } from 'crypto';
import { runSync, requestCancel } from '../sync/engine';
import { getSyncConfig, getSyncHistory, getSyncRun, updateSyncConfig } from '../lib/firestore';
import type { SseEmitter, SyncEvent } from '../types/sync';

export const router = Router();

// In-memory map of SSE emitters keyed by runId
const sseEmitters = new Map<string, SseEmitter>();

// A run that hasn't updated its lock in this long is treated as dead. Cloud
// Run can kill an instance after the request returns 200 (the actual sync
// runs in setImmediate background), so the inProgress flag occasionally gets
// orphaned. Real syncs are well under this; widen only if you observe a
// legitimate long-running case being preempted.
const STALE_LOCK_MS = 30 * 60 * 1000;

router.post('/run', async (req, res) => {
  try {
    const syncConfig = await getSyncConfig();
    if (syncConfig.inProgress) {
      const startedAt = syncConfig.inProgressStartedAt
        ? new Date(syncConfig.inProgressStartedAt).getTime()
        : 0;
      const ageMs = Date.now() - startedAt;
      if (startedAt && ageMs < STALE_LOCK_MS) {
        return res.status(409).json({ error: 'Sync already in progress' });
      }
      console.warn(
        `[/api/sync/run] clearing stale inProgress lock (started ${syncConfig.inProgressStartedAt ?? 'unknown'}, ${Math.round(ageMs / 1000)}s ago)`,
      );
    }

    const { trigger = 'ui' } = req.body as { trigger?: 'ui' | 'scheduler' };
    const runId = randomUUID();

    await updateSyncConfig({ inProgress: true, inProgressStartedAt: new Date().toISOString() });

    // Scheduler trigger: block until the sync completes. Cloud Run keeps the
    // instance alive while a request is open, so awaiting here prevents the
    // orphan-lock pattern we'd otherwise hit (response → instance scaled to
    // zero → setImmediate work killed). Avoids needing min-instances=1 +
    // always-on CPU. The scheduler attempt deadline must be ≥ expected sync
    // duration; Cloud Run's 3600s request timeout is the upper bound.
    if (trigger === 'scheduler') {
      try {
        await runSync({ trigger, runId });
        return res.json({ runId, completed: true });
      } catch (err) {
        console.error(`Scheduler sync ${runId} failed:`, err);
        return res.status(500).json({ runId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // UI trigger: kick off in setImmediate and return runId so the client can
    // subscribe to /stream for live progress. The active SSE connection from
    // the browser keeps the instance alive for the full sync duration. If the
    // user closes the tab mid-sync, the stale-lock fallback above recovers.
    const emitter: SseEmitter = (event) => {
      const fn = sseEmitters.get(runId);
      if (fn) fn(event);
    };

    setImmediate(async () => {
      try {
        await runSync({ trigger, runId, sseEmitter: emitter });
      } catch (err) {
        console.error(`Sync run ${runId} failed:`, err);
      } finally {
        sseEmitters.delete(runId);
      }
    });

    res.json({ runId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

router.delete('/runs/:id', (req, res) => {
  const { id } = req.params;
  const cancelled = requestCancel(id);
  res.status(202).json({ cancelled });
});

router.get('/runs/:id/stream', (req, res) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: SyncEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done') res.end();
  };

  sseEmitters.set(id, send);

  req.on('close', () => {
    sseEmitters.delete(id);
  });
});

router.get('/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 100);
    const runs = await getSyncHistory(limit);
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sync history' });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    const run = await getSyncRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sync run' });
  }
});
