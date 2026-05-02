/**
 * Round-trip integration test: mock HubSpot input, real Productboard API.
 *
 * Requires:
 *   TEST_INTEGRATION=true
 *   PB_API_KEY=<sandbox token>
 *   FIRESTORE_EMULATOR_HOST=localhost:8080  (or real Firestore with FIRESTORE_PROJECT_ID)
 *
 * Each run creates then deletes a test entity in your PB sandbox workspace.
 */

const RUN = process.env.TEST_INTEGRATION === 'true';

import * as pbClient from '../../src/sync/productboard';
import * as hsClient from '../../src/sync/hubspot';
import * as firestoreLib from '../../src/lib/firestore';
import { runSync } from '../../src/sync/engine';
import { makeHubSpotCompany, makeFieldMapping, makeSyncConfig } from '../helpers/factories';

// Unique tag so we can always identify and clean up test data
const TAG = `integration-test-${Date.now()}`;

const TEST_COMPANY = makeHubSpotCompany({
  id: `hs-test-${TAG}`,
  properties: {
    name: `Integration Test Co ${TAG}`,
    domain: `${TAG}.example.com`,
    annualrevenue: '100000',
    hs_lastmodifieddate: String(Date.now()),
  },
});

const TEST_MAPPINGS = [
  makeFieldMapping({ hubspotProperty: 'name',   pbFieldId: 'name',   pbFieldType: 'text', locked: true }),
  makeFieldMapping({ hubspotProperty: 'domain', pbFieldId: 'domain', pbFieldType: 'text', locked: true }),
];

const TEST_CONFIG = makeSyncConfig({ domainFallbackEnabled: true, inProgress: false });

let createdPbId: string | null = null;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(() => {
  if (!RUN) return;
  if (!process.env.PB_API_KEY) throw new Error('PB_API_KEY must be set for integration tests');
});

afterAll(async () => {
  if (!RUN || !createdPbId) return;
  try {
    await pbClient.updateEntity(createdPbId, { data: { fields: {} } });
    // PB v2 has no DELETE entity endpoint — we zero the fields and leave it;
    // a nightly cleanup job in your sandbox can handle true deletion.
    console.info(`[cleanup] zeroed test entity ${createdPbId}`);
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
  writeSyncHistory: jest.fn().mockResolvedValue('test-run-id'),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

(RUN ? describe : describe.skip)('round-trip sync — real PB API', () => {
  beforeEach(() => {
    jest.mocked(hsClient.fetchCompanies).mockResolvedValue([TEST_COMPANY]);
    jest.mocked(firestoreLib.getSyncConfig).mockResolvedValue(TEST_CONFIG);
    jest.mocked(firestoreLib.getFieldMappings).mockResolvedValue(TEST_MAPPINGS);
    jest.mocked(firestoreLib.getAccountFilter).mockResolvedValue({ enabled: false, filterGroups: [] });
  });

  it('creates a new PB entity on first sync', async () => {
    const stats = await runSync({ trigger: 'ui', runId: `test-run-create-${TAG}` });

    expect(stats.created).toBe(1);
    expect(stats.errors).toBe(0);

    // Verify entity exists in PB — client-side filter, see dedup.ts.
    const all = await pbClient.listCompanies();
    const entity = all.find(e =>
      e.type === 'company' &&
      e.metadata?.source?.system === 'hubspot' &&
      e.metadata?.source?.recordId === TEST_COMPANY.id
    );

    expect(entity).toBeDefined();
    expect(entity!.fields['name']).toBe(TEST_COMPANY.properties.name);

    createdPbId = entity!.id;
  }, 30_000);

  it('updates the existing PB entity on second sync', async () => {
    if (!createdPbId) {
      pending('previous test must pass first');
      return;
    }

    const updatedCompany = makeHubSpotCompany({
      ...TEST_COMPANY,
      properties: {
        ...TEST_COMPANY.properties,
        name: `Updated ${TEST_COMPANY.properties.name}`,
      },
    });
    jest.mocked(hsClient.fetchCompanies).mockResolvedValue([updatedCompany]);

    const stats = await runSync({ trigger: 'ui', runId: `test-run-update-${TAG}` });

    expect(stats.updated).toBe(1);
    expect(stats.created).toBe(0);
    expect(stats.errors).toBe(0);

    const all = await pbClient.listCompanies();
    const entity = all.find(e =>
      e.type === 'company' &&
      e.metadata?.source?.system === 'hubspot' &&
      e.metadata?.source?.recordId === TEST_COMPANY.id
    );

    expect(entity!.fields['name']).toBe(updatedCompany.properties.name);
  }, 30_000);

  it('produces no changes when HubSpot returns no companies', async () => {
    jest.mocked(hsClient.fetchCompanies).mockResolvedValue([]);

    const stats = await runSync({ trigger: 'scheduler', runId: `test-run-empty-${TAG}` });

    expect(stats.fetched).toBe(0);
    expect(stats.created).toBe(0);
    expect(stats.updated).toBe(0);
  }, 30_000);
});
