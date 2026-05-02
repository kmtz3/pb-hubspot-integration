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
  await clearCollection('config');
  await clearCollection('cache');
});

// Re-import after app is initialized
async function getFirestoreFns() {
  return await import('../../src/lib/firestore');
}

describe('HubSpot config round-trip', () => {
  it('saves and reads hubspot config', async () => {
    const fns = await getFirestoreFns();
    await fns.saveHubSpotConfig({ connected: true, portalId: '12345', connectedAt: '2026-05-01T00:00:00Z' });
    const config = await fns.getHubSpotConfig();
    expect(config.connected).toBe(true);
    expect(config.portalId).toBe('12345');
  });
});

describe('Productboard config round-trip', () => {
  it('saves and reads productboard config', async () => {
    const fns = await getFirestoreFns();
    await fns.savePBConfig({ connected: true, workspaceName: 'Acme', connectedAt: '2026-05-01T00:00:00Z' });
    const config = await fns.getPBConfig();
    expect(config.connected).toBe(true);
    expect(config.workspaceName).toBe('Acme');
  });
});

describe('Sync config round-trip', () => {
  it('saves and reads sync config (Phase 1 partitioned shape)', async () => {
    const fns = await getFirestoreFns();
    await fns.updateSyncConfig({
      schedule: { companies: '0 2 * * *', deals: null },
      domainFallbackEnabled: false,
      inProgress: false,
    });
    const config = await fns.getSyncConfig();
    expect(config.schedule.companies).toBe('0 2 * * *');
    expect(config.schedule.deals).toBeNull();
    expect(config.domainFallbackEnabled).toBe(false);
  });

  it('preserves the unset partition under partial deep-merge', async () => {
    const fns = await getFirestoreFns();
    await fns.updateSyncConfig({ schedule: { companies: '0 2 * * *', deals: '*/15 * * * *' } });
    await fns.updateSyncConfig({ schedule: { companies: '0 5 * * *' } });
    const config = await fns.getSyncConfig();
    expect(config.schedule.companies).toBe('0 5 * * *');
    expect(config.schedule.deals).toBe('*/15 * * * *');
  });
});

describe('Field mappings round-trip', () => {
  it('saves and reads field mappings', async () => {
    const fns = await getFirestoreFns();
    const mappings = [
      { hubspotProperty: 'name', pbFieldId: 'name', pbFieldType: 'text' as const, enabled: true, locked: true },
    ];
    await fns.saveFieldMappings(mappings);
    const result = await fns.getFieldMappings();
    expect(result).toHaveLength(1);
    expect(result[0]!.hubspotProperty).toBe('name');
  });
});

describe('Account filter round-trip', () => {
  it('saves and reads account filter', async () => {
    const fns = await getFirestoreFns();
    const filter = {
      enabled: true,
      filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ' as const, value: 'customer' }] }],
    };
    await fns.saveAccountFilter(filter);
    const result = await fns.getAccountFilter();
    expect(result.enabled).toBe(true);
    expect(result.filterGroups[0]?.filters[0]?.value).toBe('customer');
  });
});

describe('Property cache round-trip', () => {
  it('stores and retrieves cached data within TTL', async () => {
    const fns = await getFirestoreFns();
    await fns.setCachedData('hs_properties', [{ name: 'domain', label: 'Domain', type: 'string', fieldType: 'text' }]);
    const cached = await fns.getCachedData('hs_properties');
    expect(cached).not.toBeNull();
    expect(cached!.data).toHaveLength(1);
    expect(new Date(cached!.cachedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
