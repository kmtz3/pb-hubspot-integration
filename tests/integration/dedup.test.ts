/**
 * Dedup integration test: verifies domain-fallback matching against a real PB entity.
 *
 * Requires:
 *   TEST_INTEGRATION=true
 *   PB_API_KEY=<sandbox token>
 *
 * Creates a PB entity with no source metadata, then syncs a HubSpot company
 * with matching domain. Verifies the fallback match fires and recordId is written back.
 */

const RUN = process.env.TEST_INTEGRATION === 'true';

import * as pbClient from '../../src/sync/productboard';
import * as hsClient from '../../src/sync/hubspot';
import * as firestoreLib from '../../src/lib/firestore';
import { runSync } from '../../src/sync/engine';
import { makeHubSpotCompany, makeFieldMapping, makeSyncConfig } from '../helpers/factories';

const TAG = `dedup-test-${Date.now()}`;
const DOMAIN = `${TAG}.example.com`;

const HS_COMPANY = makeHubSpotCompany({
  id: `hs-dedup-${TAG}`,
  properties: {
    name: `Dedup Test Co ${TAG}`,
    domain: DOMAIN,
    hs_lastmodifieddate: String(Date.now()),
  },
});

const TEST_MAPPINGS = [
  makeFieldMapping({ hubspotProperty: 'name',   pbFieldId: 'name',   pbFieldType: 'text', locked: true }),
  makeFieldMapping({ hubspotProperty: 'domain', pbFieldId: 'domain', pbFieldType: 'text', locked: true }),
];

let createdPbId: string | null = null;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!RUN) return;
  if (!process.env.PB_API_KEY) throw new Error('PB_API_KEY must be set for integration tests');

  // Create a PB entity manually — no source metadata, just name + domain
  const entity = await pbClient.createEntity({
    data: {
      type: 'company',
      fields: { name: HS_COMPANY.properties.name, domain: DOMAIN },
      // intentionally no metadata.source — simulates an entity created before sync
    },
  });
  createdPbId = entity.id;
});

afterAll(async () => {
  if (!RUN || !createdPbId) return;
  try {
    await pbClient.updateEntity(createdPbId, { data: { fields: {} } });
    console.info(`[cleanup] zeroed dedup test entity ${createdPbId}`);
  } catch (e) {
    console.warn(`[cleanup] could not clean PB entity ${createdPbId}:`, e);
  }
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../src/sync/hubspot', () => ({
  ...jest.requireActual('../../src/sync/hubspot'),
  fetchCompanies: jest.fn(),
}));

jest.mock('../../src/lib/firestore', () => ({
  ...jest.requireActual('../../src/lib/firestore'),
  getSyncConfig: jest.fn(),
  getFieldMappings: jest.fn(),
  getAccountFilter: jest.fn(),
  updateSyncConfig: jest.fn().mockResolvedValue(undefined),
  writeSyncHistory: jest.fn().mockResolvedValue('dedup-run-id'),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

(RUN ? describe : describe.skip)('dedup — domain fallback, real PB API', () => {
  beforeEach(() => {
    jest.mocked(hsClient.fetchCompanies).mockResolvedValue([HS_COMPANY]);
    jest.mocked(firestoreLib.getSyncConfig).mockResolvedValue(
      makeSyncConfig({ domainFallbackEnabled: true })
    );
    jest.mocked(firestoreLib.getFieldMappings).mockResolvedValue(TEST_MAPPINGS);
    jest.mocked(firestoreLib.getAccountFilter).mockResolvedValue({ enabled: false, filterGroups: [] });
  });

  it('matches entity via domain fallback when no source recordId exists', async () => {
    const stats = await runSync({ trigger: 'ui', runId: `dedup-run-${TAG}` });

    // Should have updated (not created) via fallback
    expect(stats.updated).toBe(1);
    expect(stats.created).toBe(0);
    expect(stats.errors).toBe(0);
  }, 30_000);

  it('writes recordId back to the matched entity', async () => {
    // After the sync above, primary match should now work — verify via the
    // client-side map built from listCompanies (PB's `filter.metadata` is
    // still WIP — see dedup.ts).
    const all = await pbClient.listCompanies();
    const match = all.find(e =>
      e.type === 'company' &&
      e.metadata?.source?.system === 'hubspot' &&
      e.metadata?.source?.recordId === HS_COMPANY.id
    );

    expect(match).toBeDefined();
    expect(match!.id).toBe(createdPbId);
  }, 30_000);

  it('does NOT fallback when domainFallbackEnabled is false', async () => {
    // Reset source recordId so primary match won't fire on this fresh company
    const freshCompany = makeHubSpotCompany({
      id: `hs-nofallback-${TAG}`,
      properties: { name: `No-fallback Test ${TAG}`, domain: `nofallback-${TAG}.example.com` },
    });
    jest.mocked(hsClient.fetchCompanies).mockResolvedValue([freshCompany]);
    jest.mocked(firestoreLib.getSyncConfig).mockResolvedValue(
      makeSyncConfig({ domainFallbackEnabled: false })
    );

    const stats = await runSync({ trigger: 'ui', runId: `dedup-nofallback-${TAG}` });

    // No domain fallback → creates a new entity
    expect(stats.created).toBe(1);
    expect(stats.updated).toBe(0);

    // Cleanup this extra entity
    const all = await pbClient.listCompanies();
    const created = all.find(e =>
      e.type === 'company' &&
      e.metadata?.source?.system === 'hubspot' &&
      e.metadata?.source?.recordId === freshCompany.id
    );
    if (created) {
      await pbClient.updateEntity(created.id, { data: { fields: {} } }).catch(() => {});
    }
  }, 30_000);
});
