import { Router } from 'express';
import {
  getSyncConfig,
  updateSyncConfig,
  getFieldMappings,
  saveFieldMappings,
  getAccountFilter,
  saveAccountFilter,
  getHubSpotConfig,
  getPBConfig,
} from '../lib/firestore';
import type { AppConfig, SyncConfig } from '../types/sync';

export const router = Router();

router.get('/', async (_req, res) => {
  try {
    const [hubspot, productboard, sync, mappings, accountFilter] = await Promise.all([
      getHubSpotConfig(),
      getPBConfig(),
      getSyncConfig(),
      getFieldMappings(),
      getAccountFilter(),
    ]);
    const config: AppConfig = {
      hubspot,
      productboard,
      sync,
      fieldMappings: { mappings },
      accountFilter,
    };
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load config' });
  }
});

router.patch('/', async (req, res) => {
  const body = req.body as Partial<AppConfig>;
  try {
    const currentSync = await getSyncConfig();
    const promises: Promise<void>[] = [];

    if (body.sync) {
      promises.push(updateSyncConfig(body.sync));

      // Detect schedule change and update Cloud Scheduler in production
      const scheduleChanged =
        body.sync.schedule !== currentSync.schedule ||
        body.sync.scheduleTime !== currentSync.scheduleTime ||
        body.sync.timezone !== currentSync.timezone;

      if (scheduleChanged && process.env.NODE_ENV === 'production') {
        promises.push(updateCloudScheduler(body.sync));
      } else if (scheduleChanged) {
        console.log('would update Cloud Scheduler job (dev mode — skipped)');
      }
    }

    if (body.fieldMappings?.mappings) {
      promises.push(saveFieldMappings(body.fieldMappings.mappings));
    }

    if (body.accountFilter) {
      promises.push(saveAccountFilter(body.accountFilter));
    }

    await Promise.all(promises);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

async function updateCloudScheduler(sync: Partial<SyncConfig>): Promise<void> {
  const { CloudSchedulerClient } = await import('@google-cloud/scheduler');
  const client = new CloudSchedulerClient();
  const jobName = process.env.GCS_JOB_NAME!;
  const region = process.env.GCP_REGION ?? 'us-central1';
  const project = process.env.GCP_PROJECT_ID!;

  const cronExpr = buildCronExpression(sync);
  const name = `projects/${project}/locations/${region}/jobs/${jobName}`;

  await client.updateJob({
    job: {
      name,
      schedule: cronExpr,
      timeZone: sync.timezone ?? 'America/New_York',
    },
    updateMask: { paths: ['schedule', 'time_zone'] },
  });
}

const DAY_OF_WEEK: Record<string, number> = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
  Friday: 5, Saturday: 6, Sunday: 0,
};

function buildCronExpression(sync: Partial<SyncConfig>): string {
  const [hour = '2', minute = '0'] = (sync.scheduleTime ?? '02:00').split(':');
  switch (sync.schedule) {
    case 'daily':   return `${minute} ${hour} * * *`;
    case 'weekly': {
      const dow = DAY_OF_WEEK[sync.scheduleDay ?? 'Monday'] ?? 1;
      return `${minute} ${hour} * * ${dow}`;
    }
    case 'hourly':  return `0 * * * *`;
    case 'every15': return `*/15 * * * *`;
    default:        return `0 2 * * *`;
  }
}
