/**
 * Auto-provisioning integration test: verifies new select-field values are created
 * in Productboard when the sync engine encounters an unknown enumeration value.
 *
 * Requires:
 *   TEST_INTEGRATION=true
 *   PB_API_KEY=<sandbox token>
 *   TEST_PB_SELECT_FIELD_ID=<id of a writable select field in your PB sandbox>
 *
 * The test creates a new value in the given field, syncs a company that
 * uses that value, then removes the created value in cleanup.
 */

const RUN =
  process.env.TEST_INTEGRATION === 'true' &&
  !!process.env.TEST_PB_SELECT_FIELD_ID;

import * as pbClient from '../../src/sync/productboard';
import * as hsClient from '../../src/sync/hubspot';
import * as firestoreLib from '../../src/lib/firestore';
import { runSync } from '../../src/sync/engine';
import { makeHubSpotCompany, makeFieldMapping, makeSyncConfig } from '../helpers/factories';

const FIELD_ID = process.env.TEST_PB_SELECT_FIELD_ID ?? 'not-set';
const TAG = `autoprov-test-${Date.now()}`;
const NEW_VALUE = `AutoProv ${TAG}`;

const HS_COMPANY = makeHubSpotCompany({
  id: `hs-autoprov-${TAG}`,
  properties: {
    name: `Auto-prov Test Co ${TAG}`,
    domain: `${TAG}.example.com`,
    // This custom prop will be mapped to the select field
    test_select_value: NEW_VALUE,
    hs_lastmodifieddate: String(Date.now()),
  },
});

const TEST_MAPPINGS = [
  makeFieldMapping({ hubspotProperty: 'name', pbFieldId: 'name', pbFieldType: 'text', locked: true }),
  makeFieldMapping({ hubspotProperty: 'domain', pbFieldId: 'domain', pbFieldType: 'text', locked: true }),
  makeFieldMapping({
    hubspotProperty: 'test_select_value',
    pbFieldId: FIELD_ID,
    pbFieldType: 'select',
    enabled: true,
    locked: false,
  }),
];

let createdPbId: string | null = null;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(() => {
  if (!RUN) return;
  if (!process.env.PB_API_KEY) throw new Error('PB_API_KEY must be set for integration tests');
});

afterAll(async () => {
  if (!RUN) return;

  // Clean up the entity
  if (createdPbId) {
    try {
      await pbClient.updateEntity(createdPbId, { data: { fields: {} } });
      console.info(`[cleanup] zeroed auto-prov test entity ${createdPbId}`);
    } catch (e) {
      console.warn(`[cleanup] could not clean PB entity ${createdPbId}:`, e);
    }
  }

  // Note: PB v2 does not expose a DELETE endpoint for field values.
  // The test value (AutoProv <TAG>) will remain in the field's option list.
  // For sandbox hygiene, periodically clean orphaned values via the PB UI.
  console.info(`[cleanup] field value "${NEW_VALUE}" in field ${FIELD_ID} must be removed manually via PB UI.`);
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
  writeSyncHistory: jest.fn().mockResolvedValue('autoprov-run-id'),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

(RUN ? describe : describe.skip)(
  'auto-provisioning select field values — real PB API',
  () => {
    beforeEach(() => {
      jest.mocked(hsClient.fetchCompanies).mockResolvedValue([HS_COMPANY]);
      jest.mocked(firestoreLib.getSyncConfig).mockResolvedValue(makeSyncConfig());
      jest.mocked(firestoreLib.getFieldMappings).mockResolvedValue(TEST_MAPPINGS);
      jest.mocked(firestoreLib.getAccountFilter).mockResolvedValue({ enabled: false, filterGroups: [] });
    });

    it('creates the new select value and syncs the entity without error', async () => {
      // Verify the value does NOT already exist before the test
      const before = await pbClient.listFieldValues(FIELD_ID);
      const alreadyExists = before.some(v => v.fields.name === NEW_VALUE);
      expect(alreadyExists).toBe(false);

      const stats = await runSync({ trigger: 'ui', runId: `autoprov-run-${TAG}` });

      expect(stats.created).toBe(1);
      expect(stats.errors).toBe(0);
    }, 30_000);

    it('created entity carries the provisioned select value', async () => {
      const all = await pbClient.listCompanies();
      const entity = all.find(e =>
        e.type === 'company' &&
        e.metadata?.source?.system === 'hubspot' &&
        e.metadata?.source?.recordId === HS_COMPANY.id
      );

      expect(entity).toBeDefined();
      createdPbId = entity!.id;

      // The field value should be set on the entity
      const fieldValue = entity!.fields[FIELD_ID];
      expect(fieldValue).toBeDefined();

      // Select fields return { name: '...' }
      if (typeof fieldValue === 'object' && fieldValue !== null && 'name' in fieldValue) {
        expect((fieldValue as { name: string }).name).toBe(NEW_VALUE);
      }
    }, 30_000);

    it('the new value now appears in the field definition', async () => {
      const values = await pbClient.listFieldValues(FIELD_ID);
      const found = values.find(v => v.fields.name === NEW_VALUE);
      expect(found).toBeDefined();
    }, 30_000);

    it('second sync re-uses the existing value (no duplicate created)', async () => {
      const beforeCount = (await pbClient.listFieldValues(FIELD_ID)).length;

      const stats = await runSync({ trigger: 'ui', runId: `autoprov-run2-${TAG}` });

      expect(stats.updated).toBe(1);
      expect(stats.errors).toBe(0);

      const afterCount = (await pbClient.listFieldValues(FIELD_ID)).length;
      expect(afterCount).toBe(beforeCount);
    }, 30_000);
  }
);
