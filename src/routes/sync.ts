import { Router } from 'express';
import { randomUUID } from 'crypto';
import { runSync, requestCancel } from '../sync/engine';
import { getSyncConfig, getSyncHistory, getSyncRun, updateSyncConfig } from '../lib/firestore';
import type { ObjectType, SseEmitter, SyncEvent, SyncMode } from '../types/sync';

export const router = Router();

// Live SSE writer registered when the client's EventSource GET arrives.
const sseEmitters = new Map<string, SseEmitter>();

// Events emitted before the client's EventSource GET arrives are buffered
// here so the stream can drain them immediately on connect. Entries are
// removed once the 'done' event is either buffered or drained.
const sseBuffers = new Map<string, SyncEvent[]>();

// A run that hasn't updated its lock in this long is treated as dead. Cloud
// Run can kill an instance after the request returns 200 (the actual sync
// runs in setImmediate background), so the inProgress flag occasionally gets
// orphaned. Real syncs are well under this; widen only if you observe a
// legitimate long-running case being preempted.
const STALE_LOCK_MS = 30 * 60 * 1000;

interface SyncRunBody {
  trigger?: 'ui' | 'scheduler';
  // D24 — `objectType` is optional and defaults to `companies`, so existing
  // scheduler invocations and UI clients that don't yet send it keep working.
  objectType?: ObjectType;
  // Defaults to `incremental`. UI "Sync now" still produces a full sweep —
  // the engine maps `trigger === 'ui'` + no explicit mode to `'full'`.
  mode?: SyncMode;
  // Backfill window (deals, Phase 4). Ignored on companies runs.
  from?: number;
  to?: number;
  windowField?: 'hs_lastmodifieddate' | 'createdate';
}

function readObjectType(raw: unknown): ObjectType {
  return raw === 'deals' || raw === 'companies' ? raw : 'companies';
}

function readMode(raw: unknown): SyncMode | undefined {
  return raw === 'incremental' || raw === 'backfill' || raw === 'full' ? raw : undefined;
}

router.post('/run', async (req, res) => {
  try {
    const body = (req.body ?? {}) as SyncRunBody;
    const objectType = readObjectType(body.objectType);
    const mode = readMode(body.mode);

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

    const trigger = body.trigger ?? 'ui';
    const runId = randomUUID();

    await updateSyncConfig({ inProgress: true, inProgressStartedAt: new Date().toISOString() });

    const runOpts = {
      trigger,
      runId,
      objectType,
      ...(mode ? { mode } : {}),
      ...(body.from !== undefined ? { windowFrom: body.from } : {}),
      ...(body.to !== undefined ? { windowTo: body.to } : {}),
      ...(body.windowField ? { windowField: body.windowField } : {}),
    };

    // Scheduler trigger: block until the sync completes. Cloud Run keeps the
    // instance alive while a request is open, so awaiting here prevents the
    // orphan-lock pattern we'd otherwise hit (response → instance scaled to
    // zero → setImmediate work killed). Avoids needing min-instances=1 +
    // always-on CPU. The scheduler attempt deadline must be ≥ expected sync
    // duration; Cloud Run's 3600s request timeout is the upper bound.
    if (trigger === 'scheduler') {
      try {
        await runSync(runOpts);
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
    //
    // Events emitted before the client's EventSource GET arrives are buffered
    // in sseBuffers so the stream can drain them immediately on connect,
    // avoiding a race where a fast skip/complete run is never surfaced.
    sseBuffers.set(runId, []);

    const emitter: SseEmitter = (event) => {
      const fn = sseEmitters.get(runId);
      if (fn) {
        fn(event);
      } else {
        sseBuffers.get(runId)?.push(event);
      }
    };

    setImmediate(async () => {
      try {
        await runSync({ ...runOpts, sseEmitter: emitter });
      } catch (err) {
        console.error(`Sync run ${runId} failed:`, err);
      } finally {
        sseEmitters.delete(runId);
        sseBuffers.delete(runId);
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

  // Drain any events that fired before this GET arrived (race window between
  // POST /run returning and the client opening the EventSource).
  const buffered = sseBuffers.get(id);
  if (buffered) {
    for (const event of buffered) send(event);
    sseBuffers.delete(id);
    // If the sync already finished (done was in the buffer), the response is
    // already ended — don't register a live emitter for a completed run.
    if (res.writableEnded) return;
  }

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
