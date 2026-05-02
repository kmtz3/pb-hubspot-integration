import { initializeApp, getApps, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let app: App;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST required — start with: firebase emulators:start --only firestore --project demo-local');
  }
  if (!getApps().length) {
    app = initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID ?? 'demo-local' });
  } else {
    app = getApps()[0]!;
  }
});

afterAll(async () => {
  if (app) await deleteApp(app).catch(() => {});
});

async function clearCollection(name: string): Promise<void> {
  const db = getFirestore();
  const snap = await db.collection(name).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  if (snap.docs.length) await batch.commit();
}

beforeEach(async () => {
  await clearCollection('syncHistory');
});

async function getFirestoreFns() {
  return await import('../../src/lib/firestore');
}

describe('syncHistory write + read', () => {
  it('writes a run and reads it back', async () => {
    const fns = await getFirestoreFns();
    const runId = await fns.writeSyncHistory({
      startedAt: '2026-05-01T02:00:00Z',
      finishedAt: '2026-05-01T02:03:00Z',
      trigger: 'ui',
      status: 'success',
      objectType: 'companies',
      mode: 'incremental',
      stats: { fetched: 100, created: 10, updated: 88, skipped: 2, errors: 0 },
      errors: [],
    });
    expect(typeof runId).toBe('string');

    const run = await fns.getSyncRun(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('success');
    expect(run!.stats.fetched).toBe(100);
    expect(run!.objectType).toBe('companies');
  });

  it('returns null for unknown runId', async () => {
    const fns = await getFirestoreFns();
    const result = await fns.getSyncRun('does-not-exist');
    expect(result).toBeNull();
  });

  it('paginates history ordered by startedAt desc', async () => {
    const fns = await getFirestoreFns();
    const base = { trigger: 'scheduler' as const, status: 'success' as const, objectType: 'companies' as const, mode: 'incremental' as const, stats: { fetched: 1, created: 1, updated: 0, skipped: 0, errors: 0 }, errors: [] };
    await fns.writeSyncHistory({ ...base, startedAt: '2026-05-01T01:00:00Z' });
    await fns.writeSyncHistory({ ...base, startedAt: '2026-05-01T03:00:00Z' });
    await fns.writeSyncHistory({ ...base, startedAt: '2026-05-01T02:00:00Z' });

    const history = await fns.getSyncHistory(3);
    expect(history).toHaveLength(3);
    expect(history[0]!.startedAt > history[1]!.startedAt).toBe(true);
  });

  it('respects the limit parameter', async () => {
    const fns = await getFirestoreFns();
    const base = { trigger: 'ui' as const, status: 'success' as const, objectType: 'companies' as const, mode: 'full' as const, stats: { fetched: 1, created: 0, updated: 1, skipped: 0, errors: 0 }, errors: [] };
    for (let i = 0; i < 5; i++) {
      await fns.writeSyncHistory({ ...base, startedAt: `2026-05-0${i + 1}T00:00:00Z` });
    }
    const history = await fns.getSyncHistory(2);
    expect(history).toHaveLength(2);
  });
});
