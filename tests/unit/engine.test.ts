jest.mock('../../src/sync/hubspot');
jest.mock('../../src/sync/productboard');
jest.mock('../../src/sync/dedup');
jest.mock('../../src/lib/firestore');

import { runSync } from '../../src/sync/engine';
import { fetchCompanies } from '../../src/sync/hubspot';
import { createEntity, updateEntity, listCompanies, fetchEntityConfigurations } from '../../src/sync/productboard';
import { findExistingCompany, buildCompanyMaps } from '../../src/sync/dedup';
import {
  writeSyncHistory,
  updateSyncConfig,
  getSyncConfig,
  getFieldMappings,
  getAccountFilter,
  getHubSpotConfig,
  getPBConfig,
} from '../../src/lib/firestore';
import { makeHubSpotCompany, makePBEntity, makeSyncConfig, makeFieldMapping } from '../helpers/factories';
import { ApiError } from '../../src/sync/rateLimit';

const mockFetchCompanies    = jest.mocked(fetchCompanies);
const mockCreateEntity      = jest.mocked(createEntity);
const mockUpdateEntity      = jest.mocked(updateEntity);
const mockListCompanies     = jest.mocked(listCompanies);
const mockFetchPBFields     = jest.mocked(fetchEntityConfigurations);
const mockFindExisting      = jest.mocked(findExistingCompany);
const mockBuildCompanyMaps  = jest.mocked(buildCompanyMaps);
const mockWriteHistory      = jest.mocked(writeSyncHistory);
const mockUpdateSyncConfig  = jest.mocked(updateSyncConfig);
const mockGetSyncConfig     = jest.mocked(getSyncConfig);
const mockGetFieldMappings  = jest.mocked(getFieldMappings);
const mockGetAccountFilter  = jest.mocked(getAccountFilter);
const mockGetHubSpotConfig  = jest.mocked(getHubSpotConfig);
const mockGetPBConfig       = jest.mocked(getPBConfig);

const defaultMappings = [
  makeFieldMapping({ hubspotProperty: 'name',   pbFieldId: 'name',   pbFieldType: 'text', locked: true }),
  makeFieldMapping({ hubspotProperty: 'domain', pbFieldId: 'domain', pbFieldType: 'text', locked: true }),
];

beforeEach(() => {
  jest.resetAllMocks();
  process.env.DRY_RUN = 'true';
  mockGetSyncConfig.mockResolvedValue(makeSyncConfig());
  mockGetFieldMappings.mockResolvedValue(defaultMappings);
  mockGetAccountFilter.mockResolvedValue({ enabled: false, filterGroups: [] });
  // Both connections healthy by default — `checkConnectionsForSkip` short-circuits
  // the run with a 'skipped' status when either side is missing, which would
  // otherwise eat through every dispatch test below.
  mockGetHubSpotConfig.mockResolvedValue({ connected: true });
  mockGetPBConfig.mockResolvedValue({ connected: true });
  mockWriteHistory.mockResolvedValue('run-001');
  mockUpdateSyncConfig.mockResolvedValue(undefined);
  mockFetchCompanies.mockResolvedValue([]);
  mockListCompanies.mockResolvedValue([]);
  mockFetchPBFields.mockResolvedValue([]);
  mockBuildCompanyMaps.mockReturnValue({ byRecordId: new Map(), byDomain: new Map() });
});

afterEach(() => { delete process.env.DRY_RUN; });

describe('runSync', () => {
  it('returns zeroed stats when no companies fetched', async () => {
    const stats = await runSync({ trigger: 'ui', runId: 'r-test-001' });
    expect(stats).toMatchObject({ fetched: 0, created: 0, updated: 0 });
  });

  it('increments skipped in DRY_RUN mode instead of calling createEntity', async () => {
    mockFetchCompanies.mockResolvedValue([makeHubSpotCompany()]);
    mockFindExisting.mockReturnValue(null);

    const stats = await runSync({ trigger: 'ui', runId: 'r-test-002' });
    expect(mockCreateEntity).not.toHaveBeenCalled();
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
  });

  it('calls updateEntity for existing records when DRY_RUN is off', async () => {
    process.env.DRY_RUN = 'false';
    mockFetchCompanies.mockResolvedValue([makeHubSpotCompany()]);
    mockFindExisting.mockReturnValue({ pbId: 'pb-001', resolvedViaFallback: false });
    mockUpdateEntity.mockResolvedValue(undefined);

    await runSync({ trigger: 'ui', runId: 'r-test-003' });
    expect(mockUpdateEntity).toHaveBeenCalledWith('pb-001', expect.any(Object));
  });

  it('uses Productboard patch clear ops when HubSpot clears optional values', async () => {
    process.env.DRY_RUN = 'false';
    mockGetFieldMappings.mockResolvedValue([
      ...defaultMappings,
      makeFieldMapping({ hubspotProperty: 'description', pbFieldId: 'description', pbFieldType: 'text', enabled: true, locked: false }),
    ]);
    mockFetchCompanies.mockResolvedValue([
      makeHubSpotCompany({ properties: { name: 'Acme Corp', domain: 'acme.com', description: null } as any }),
    ]);
    mockFindExisting.mockReturnValue({ pbId: 'pb-001', resolvedViaFallback: false });
    mockUpdateEntity.mockResolvedValue(undefined);

    await runSync({ trigger: 'ui', runId: 'r-test-003-clear' });

    expect(mockUpdateEntity).toHaveBeenCalledWith('pb-001', {
      data: {
        patch: expect.arrayContaining([{ op: 'clear', path: 'description' }]),
      },
    });
  });

  it('rounds number values using Productboard field constraints before update', async () => {
    process.env.DRY_RUN = 'false';
    mockFetchPBFields.mockResolvedValue([
      {
        id: 'revenue',
        name: '[C] Revenue',
        type: 'number',
        schema: { type: 'number' },
        constraints: { maximum: 9999999999.99, maxScale: 2 },
      },
    ]);
    mockGetFieldMappings.mockResolvedValue([
      ...defaultMappings,
      makeFieldMapping({ hubspotProperty: 'annualrevenue', pbFieldId: 'revenue', pbFieldType: 'number', enabled: true, locked: false }),
    ]);
    mockFetchCompanies.mockResolvedValue([
      makeHubSpotCompany({ properties: { name: 'Acme Corp', domain: 'acme.com', annualrevenue: '2.56113' } }),
    ]);
    mockFindExisting.mockReturnValue({ pbId: 'pb-001', resolvedViaFallback: false });
    mockUpdateEntity.mockResolvedValue(undefined);

    await runSync({ trigger: 'ui', runId: 'r-test-003-number' });

    expect(mockUpdateEntity).toHaveBeenCalledWith('pb-001', {
      data: {
        patch: expect.arrayContaining([{ op: 'set', path: 'revenue', value: 2.56 }]),
      },
    });
  });

  it('omits null values from Productboard create fields', async () => {
    process.env.DRY_RUN = 'false';
    mockGetFieldMappings.mockResolvedValue([
      ...defaultMappings,
      makeFieldMapping({ hubspotProperty: 'description', pbFieldId: 'description', pbFieldType: 'text', enabled: true, locked: false }),
    ]);
    mockFetchCompanies.mockResolvedValue([
      makeHubSpotCompany({ properties: { name: 'Acme Corp', domain: 'acme.com', description: null } as any }),
    ]);
    mockFindExisting.mockReturnValue(null);
    mockCreateEntity.mockResolvedValue(makePBEntity());

    await runSync({ trigger: 'ui', runId: 'r-test-004-create-null' });

    expect(mockCreateEntity).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fields: expect.not.objectContaining({ description: expect.anything() }),
      }),
    }));
  });

  it('calls createEntity for new records when DRY_RUN is off', async () => {
    process.env.DRY_RUN = 'false';
    mockFetchCompanies.mockResolvedValue([makeHubSpotCompany()]);
    mockFindExisting.mockReturnValue(null);
    mockCreateEntity.mockResolvedValue(makePBEntity());

    await runSync({ trigger: 'ui', runId: 'r-test-004' });
    expect(mockCreateEntity).toHaveBeenCalled();
  });

  it('increments error counter and continues on per-company errors', async () => {
    process.env.DRY_RUN = 'false';
    mockFetchCompanies.mockResolvedValue([makeHubSpotCompany(), makeHubSpotCompany({ id: 'hs-002' })]);
    mockFindExisting
      .mockImplementationOnce(() => { throw new Error('PB API down'); })
      .mockReturnValueOnce(null);
    mockCreateEntity.mockResolvedValue(makePBEntity());

    const stats = await runSync({ trigger: 'ui', runId: 'r-test-005' });
    expect(stats.errors).toBe(1);
  });

  it('stores attempted payload and full API error in history when debug logging is enabled', async () => {
    process.env.DRY_RUN = 'false';
    mockGetSyncConfig.mockResolvedValue(makeSyncConfig({ debugLogging: true }));
    mockFetchCompanies.mockResolvedValue([makeHubSpotCompany()]);
    mockFindExisting.mockReturnValue({ pbId: 'pb-001', resolvedViaFallback: false });
    mockUpdateEntity.mockRejectedValue(new ApiError(
      'HTTP 400 — client error (no retry)',
      400,
      { errors: [{ detail: 'full Productboard error' }] }
    ));

    await runSync({ trigger: 'ui', runId: 'r-test-debug-001' });

    expect(mockWriteHistory).toHaveBeenCalledWith(expect.objectContaining({
      debugLogs: [
        expect.objectContaining({
          hsId: expect.any(String),
          action: 'update',
          pbId: 'pb-001',
          payload: expect.objectContaining({ data: expect.any(Object) }),
          error: expect.objectContaining({
            status: 400,
            responseBody: { errors: [{ detail: 'full Productboard error' }] },
          }),
        }),
      ],
    }));
  });

  it('does not store extended debug history when debug logging is disabled', async () => {
    process.env.DRY_RUN = 'false';
    mockFetchCompanies.mockResolvedValue([makeHubSpotCompany()]);
    mockFindExisting.mockReturnValue({ pbId: 'pb-001', resolvedViaFallback: false });
    mockUpdateEntity.mockRejectedValue(new Error('PB API down'));

    await runSync({ trigger: 'ui', runId: 'r-test-debug-002' });

    expect(mockWriteHistory).toHaveBeenCalledWith(expect.not.objectContaining({
      debugLogs: expect.anything(),
    }));
  });

  it('emits SSE progress events when sseEmitter is provided', async () => {
    mockFetchCompanies.mockResolvedValue([makeHubSpotCompany()]);
    mockFindExisting.mockReturnValue(null);

    const events: any[] = [];
    const emitter = (e: any) => events.push(e);

    await runSync({ trigger: 'ui', runId: 'r-test-006', sseEmitter: emitter });
    expect(events.some(e => e.type === 'progress' || e.type === 'done')).toBe(true);
  });

  it('writes sync history on completion', async () => {
    await runSync({ trigger: 'scheduler', runId: 'r-test-007' });
    expect(mockWriteHistory).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'scheduler' })
    );
  });

  it('always clears inProgress flag even on error', async () => {
    mockFetchCompanies.mockRejectedValue(new Error('fatal'));
    await expect(runSync({ trigger: 'ui', runId: 'r-test-008' })).rejects.toThrow('fatal');
    expect(mockUpdateSyncConfig).toHaveBeenCalledWith(
      expect.objectContaining({ inProgress: false })
    );
  });
});

// Phase 1 regression baseline (task 15). Pins the SSE event-type sequence the
// companies sync emits so any future engine refactor that reorders or drops
// emits fails the test rather than slipping through. The companion fixture
// file at tests/fixtures/sse-companies-baseline.json has the human-readable
// trace for diff context.
describe('runSync — SSE event-type sequence (Phase 1 baseline)', () => {
  it('emits records first, then a per-batch progress event, then done', async () => {
    process.env.DRY_RUN = 'false';
    const fakeCompanies = Array.from({ length: 7 }, (_, i) =>
      makeHubSpotCompany({ id: `hs-${i + 1}`, properties: { name: `Co ${i + 1}`, domain: `co${i + 1}.com` } })
    );
    mockFetchCompanies.mockResolvedValue(fakeCompanies);
    mockFindExisting.mockReturnValue(null);
    mockCreateEntity.mockResolvedValue(makePBEntity());

    const events: Array<{ type: string; status?: string }> = [];
    await runSync({
      trigger: 'ui',
      runId: 'r-test-sse-baseline',
      sseEmitter: (e: any) => events.push({ type: e.type, ...(e.status ? { status: e.status } : {}) }),
    });

    const types = events.map(e => e.type);
    // 7 records, 2 progress events (5 + 2 in CONCURRENCY=5 batches), 1 done.
    const recordCount   = types.filter(t => t === 'record').length;
    const progressCount = types.filter(t => t === 'progress').length;
    const doneCount     = types.filter(t => t === 'done').length;
    expect(recordCount).toBe(7);
    expect(progressCount).toBe(2);
    expect(doneCount).toBe(1);

    // Last event is always `done`.
    expect(types[types.length - 1]).toBe('done');

    // Every `progress` event has at least one `record` event before it in the
    // same batch — i.e. records flush before progress.
    let seenRecordSinceLastProgress = false;
    for (const t of types) {
      if (t === 'record')   seenRecordSinceLastProgress = true;
      if (t === 'progress') {
        expect(seenRecordSinceLastProgress).toBe(true);
        seenRecordSinceLastProgress = false;
      }
    }
  });
});

describe('runSync — dispatcher (Phase 1)', () => {
  it('routes objectType=companies to the companies path and writes a companies history record', async () => {
    await runSync({ trigger: 'scheduler', runId: 'r-dispatch-companies', objectType: 'companies' });
    expect(mockFetchCompanies).toHaveBeenCalled();
    expect(mockWriteHistory).toHaveBeenCalledWith(
      expect.objectContaining({ objectType: 'companies', mode: expect.any(String) })
    );
  });

  it('defaults objectType to companies when omitted (D24)', async () => {
    await runSync({ trigger: 'scheduler', runId: 'r-dispatch-default' });
    expect(mockFetchCompanies).toHaveBeenCalled();
    expect(mockWriteHistory).toHaveBeenCalledWith(
      expect.objectContaining({ objectType: 'companies' })
    );
  });

  it('throws "not yet implemented" for objectType=deals (lands in Phase 4)', async () => {
    await expect(
      runSync({ trigger: 'scheduler', runId: 'r-dispatch-deals', objectType: 'deals' })
    ).rejects.toThrow(/not yet implemented/i);
    expect(mockFetchCompanies).not.toHaveBeenCalled();
    expect(mockWriteHistory).not.toHaveBeenCalled();
  });
});
