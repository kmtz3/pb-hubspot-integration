import { Router } from 'express';
import {
  getSyncConfig,
  updateSyncConfig,
  getHubSpotConfig,
  getPBConfig,
  getFieldMappingsDoc,
  saveFieldMappings,
  saveDealsFieldMappings,
  getFiltersDoc,
  saveAccountFilter,
  saveDealsFilter,
} from '../lib/firestore';
import type { AppConfig, SyncConfig } from '../types/sync';

export const router = Router();

router.get('/', async (_req, res) => {
  try {
    const [hubspot, productboard, sync, fieldMappings, filters] = await Promise.all([
      getHubSpotConfig(),
      getPBConfig(),
      getSyncConfig(),
      getFieldMappingsDoc(),
      getFiltersDoc(),
    ]);
    const config: AppConfig = {
      hubspot,
      productboard,
      sync,
      fieldMappings,
      filters,
    };
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// Phase 1 (D16): no read-side upcasting and no write-side acceptance of the
// old shape. The Phase 1 client + server deploy together; an old-shape body
// indicates a stale client that has missed the wipe-and-redeploy migration.
function detectLegacyShape(body: Partial<AppConfig> & { accountFilter?: unknown }): string | null {
  if ('accountFilter' in body) {
    return 'config.accountFilter is removed; send `filters.companies` instead (Phase 1 migration).';
  }
  if (body.fieldMappings && !('companies' in body.fieldMappings) && 'mappings' in (body.fieldMappings as object)) {
    return 'fieldMappings.mappings is removed; send `fieldMappings.companies` instead (Phase 1 migration).';
  }
  if (body.sync && typeof (body.sync as unknown as Record<string, unknown>).schedule === 'string') {
    return 'sync.schedule (enum) is replaced by sync.schedule.{companies,deals}; use `sync.legacySchedule` for the transitional accounts cadence picker (Phase 1 migration).';
  }
  return null;
}

router.patch('/', async (req, res) => {
  const body = req.body as Partial<AppConfig> & { accountFilter?: unknown };
  const legacy = detectLegacyShape(body);
  if (legacy) {
    return res.status(400).json({ error: legacy });
  }

  try {
    const currentSync = await getSyncConfig();

    // Reconcile Cloud Scheduler BEFORE writing Firestore. If the scheduler call
    // fails, we want the response to be 500 and the persisted schedule to stay
    // unchanged — otherwise a follow-up save sees scheduleChanged === false and
    // silently no-ops on the scheduler while returning 200.
    //
    // Phase 1 keeps the single companies scheduler job: the legacy enum fields
    // (`legacySchedule`, `legacyScheduleTime`, …) drive cron generation. Phase 6
    // splits this into two object-typed jobs sourced from `schedule.companies`
    // and `schedule.deals` cron strings (D7, D19, D22, D23).
    if (body.sync) {
      const next: SyncConfig = { ...currentSync, ...body.sync };
      const scheduleChanged =
        next.legacySchedule     !== currentSync.legacySchedule     ||
        next.legacyScheduleTime !== currentSync.legacyScheduleTime ||
        next.legacyScheduleDay  !== currentSync.legacyScheduleDay  ||
        next.legacyTimezone     !== currentSync.legacyTimezone;

      if (scheduleChanged && process.env.NODE_ENV === 'production') {
        await reconcileCloudScheduler(next);
      } else if (scheduleChanged) {
        console.log('would update Cloud Scheduler job (dev mode — skipped)');
      }
    }

    const writes: Promise<void>[] = [];
    if (body.sync) writes.push(updateSyncConfig(body.sync));
    if (body.fieldMappings?.companies) writes.push(saveFieldMappings(body.fieldMappings.companies));
    if (body.fieldMappings?.deals) writes.push(saveDealsFieldMappings(body.fieldMappings.deals));
    if (body.filters?.companies) writes.push(saveAccountFilter(body.filters.companies));
    if (body.filters?.deals) writes.push(saveDealsFilter(body.filters.deals));
    await Promise.all(writes);

    res.json({ ok: true });
  } catch (err) {
    // Log the full error to Cloud Run stdout so failed scheduler reconciles
    // are debuggable from Logs Explorer instead of only via the 500 response
    // body. gRPC errors from @google-cloud/scheduler hide field_violations on
    // non-enumerable props, so dump everything explicitly.
    const e = err as {
      message?: string; code?: number; details?: unknown;
      metadata?: unknown; statusDetails?: unknown; stack?: string;
    };
    console.error('[PATCH /api/config] save failed', {
      message: e.message,
      code: e.code,
      details: e.details,
      metadata: e.metadata,
      statusDetails: e.statusDetails,
      stack: e.stack,
    });
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

interface SchedulerEnv {
  project: string;
  region: string;
  jobName: string;
  parent: string;
  appUrl: string;
  schedulerSa: string;
  audience: string;
}

function readSchedulerEnv(): SchedulerEnv {
  // Trim every value: a stray space pasted into Cloud Run's env editor will
  // otherwise propagate into resource names and OIDC token claims, where it
  // produces silent auth/lookup failures rather than a clean error.
  const project = process.env.GCP_PROJECT_ID?.trim();
  const region = process.env.GCP_REGION?.trim();
  const rawJob = process.env.GCS_JOB_NAME?.trim();
  const appUrl = process.env.APP_URL?.trim();
  const schedulerSa = process.env.SCHEDULER_SA_EMAIL?.trim();

  const missing: string[] = [];
  if (!project) missing.push('GCP_PROJECT_ID');
  if (!region) missing.push('GCP_REGION');
  if (!rawJob) missing.push('GCS_JOB_NAME');
  if (!appUrl) missing.push('APP_URL');
  if (!schedulerSa || schedulerSa === 'unused@example.com') missing.push('SCHEDULER_SA_EMAIL');
  if (missing.length) {
    throw new Error(`Cloud Scheduler not configured: missing ${missing.join(', ')}`);
  }

  // GCS_JOB_NAME may be a short id ("pb-hubspot-sync-scheduler") or a full
  // resource path ("projects/.../locations/.../jobs/..."). Accept both.
  const jobName = rawJob!.startsWith('projects/')
    ? rawJob!
    : `projects/${project}/locations/${region}/jobs/${rawJob}`;

  return {
    project: project!,
    region: region!,
    jobName,
    parent: `projects/${project}/locations/${region}`,
    appUrl: appUrl!,
    schedulerSa: schedulerSa!,
    audience: process.env.SCHEDULER_OIDC_AUDIENCE ?? appUrl!,
  };
}

async function reconcileCloudScheduler(sync: SyncConfig): Promise<void> {
  const { CloudSchedulerClient } = await import('@google-cloud/scheduler');
  const client = new CloudSchedulerClient();
  const env = readSchedulerEnv();

  // Manual mode: pause an existing job; never auto-create one.
  if (!sync.legacySchedule || sync.legacySchedule === 'manual') {
    try {
      await client.pauseJob({ name: env.jobName });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    return;
  }

  const schedule = buildCronExpression(sync);
  const timeZone = sync.legacyTimezone ?? 'America/New_York';

  try {
    await client.updateJob({
      job: { name: env.jobName, schedule, timeZone },
      updateMask: { paths: ['schedule', 'time_zone'] },
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // Job doesn't exist yet — first save bootstraps it.
    await client.createJob({
      parent: env.parent,
      job: {
        name: env.jobName,
        schedule,
        timeZone,
        httpTarget: {
          uri: `${env.appUrl}/api/sync/run`,
          httpMethod: 'POST',
          body: Buffer.from(JSON.stringify({ trigger: 'scheduler' })),
          headers: { 'Content-Type': 'application/json' },
          oidcToken: {
            serviceAccountEmail: env.schedulerSa,
            audience: env.audience,
          },
        },
      },
    });
    return;
  }

  // Job existed and was updated. If a previous manual-mode save paused it,
  // resume so the new cron actually fires.
  try {
    await client.resumeJob({ name: env.jobName });
  } catch (err) {
    // FAILED_PRECONDITION on an already-enabled job is fine; ignore.
    if (isNotFound(err)) throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 5;
}

const DAY_OF_WEEK: Record<string, number> = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
  Friday: 5, Saturday: 6, Sunday: 0,
};

function buildCronExpression(sync: Partial<SyncConfig>): string {
  const [hour = '2', minute = '0'] = (sync.legacyScheduleTime ?? '02:00').split(':');
  switch (sync.legacySchedule) {
    case 'daily':   return `${minute} ${hour} * * *`;
    case 'weekly': {
      const dow = DAY_OF_WEEK[sync.legacyScheduleDay ?? 'Monday'] ?? 1;
      return `${minute} ${hour} * * ${dow}`;
    }
    case 'hourly':  return `0 * * * *`;
    case 'every15': return `*/15 * * * *`;
    default:        return `0 2 * * *`;
  }
}
