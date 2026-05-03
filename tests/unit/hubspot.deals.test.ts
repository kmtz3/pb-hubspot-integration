import { fetchDeals, fetchDealAssociations } from '../../src/sync/hubspot';
import type { HubSpotFilterGroup } from '../../src/types/hubspot';

// Use a fake token so getHubSpotToken() resolves without hitting Firestore.
beforeAll(() => { process.env.HUBSPOT_API_KEY = 'test-token'; });
afterAll(() => { delete process.env.HUBSPOT_API_KEY; });

// Helper: build a mock fetch that captures request bodies and returns an
// empty results page so the pagination loop terminates after one call.
function mockFetchCapture() {
  const calls: unknown[] = [];
  global.fetch = jest.fn().mockImplementation((_url: string, opts?: RequestInit) => {
    calls.push(opts?.body ? JSON.parse(opts.body as string) : null);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ results: [] }),
    } as unknown as Response);
  });
  return calls;
}

// Helper: build a mock fetch that returns a fixed body on every call.
function mockFetchReturn(body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

afterEach(() => jest.restoreAllMocks());

// ── fetchDeals: filter group construction ────────────────────────────────────

describe('fetchDeals filter group construction', () => {
  it('prepends pipeline filter to the default single group when no user groups provided', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'pipe-1' });

    const body = calls[0] as { filterGroups: Array<{ filters: Array<{ propertyName: string; operator: string; value?: string }> }> };
    expect(body.filterGroups).toHaveLength(1);
    expect(body.filterGroups[0].filters[0]).toMatchObject({
      propertyName: 'pipeline',
      operator: 'EQ',
      value: 'pipe-1',
    });
  });

  it('prepends stage IN filter directly after pipeline when stageIds are provided', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'pipe-1', stageIds: ['stage-a', 'stage-b'] });

    const filters = (calls[0] as { filterGroups: Array<{ filters: unknown[] }> }).filterGroups[0].filters;
    expect(filters[1]).toMatchObject({
      propertyName: 'dealstage',
      operator: 'IN',
      values: ['stage-a', 'stage-b'],
    });
  });

  it('omits the stage filter entirely when stageIds is empty', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'pipe-1', stageIds: [] });

    const filters = (calls[0] as { filterGroups: Array<{ filters: Array<{ propertyName: string }> }> }).filterGroups[0].filters;
    expect(filters.every(f => f.propertyName !== 'dealstage')).toBe(true);
  });

  it('appends incremental lastSyncAt filter when provided (and no backfill window)', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'pipe-1', lastSyncAt: 1746748800000 });

    const filters = (calls[0] as { filterGroups: Array<{ filters: unknown[] }> }).filterGroups[0].filters;
    expect(filters.at(-1)).toMatchObject({
      propertyName: 'hs_lastmodifieddate',
      operator: 'GT',
      value: '1746748800000',
    });
  });

  it('uses BETWEEN on hs_lastmodifieddate for backfill when windowField is default', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'pipe-1', windowFrom: 1_000_000, windowTo: 2_000_000 });

    const filters = (calls[0] as { filterGroups: Array<{ filters: unknown[] }> }).filterGroups[0].filters;
    expect(filters.at(-1)).toMatchObject({
      propertyName: 'hs_lastmodifieddate',
      operator: 'BETWEEN',
      value: '1000000',
      highValue: '2000000',
    });
  });

  it('uses BETWEEN on createdate when windowField="createdate"', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'pipe-1', windowFrom: 1_000_000, windowTo: 2_000_000, windowField: 'createdate' });

    const filters = (calls[0] as { filterGroups: Array<{ filters: unknown[] }> }).filterGroups[0].filters;
    expect(filters.at(-1)).toMatchObject({
      propertyName: 'createdate',
      operator: 'BETWEEN',
      value: '1000000',
      highValue: '2000000',
    });
  });

  it('backfill window takes priority over lastSyncAt when both provided', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'pipe-1', lastSyncAt: 999, windowFrom: 1_000_000, windowTo: 2_000_000 });

    const filters = (calls[0] as { filterGroups: Array<{ filters: Array<{ operator: string }> }> }).filterGroups[0].filters;
    // Should contain BETWEEN, not GT
    expect(filters.some(f => f.operator === 'BETWEEN')).toBe(true);
    expect(filters.some(f => f.operator === 'GT')).toBe(false);
  });

  it('ANDs mandatory + window filters into every user-provided filter group', async () => {
    const calls = mockFetchCapture();
    const userGroups: HubSpotFilterGroup[] = [
      { filters: [{ propertyName: 'amount', operator: 'GT', value: '10000' }] },
      { filters: [{ propertyName: 'amount', operator: 'LT', value: '500' }] },
    ];
    await fetchDeals({ pipelineId: 'pipe-1', filterGroups: userGroups, lastSyncAt: 1000 });

    const body = calls[0] as { filterGroups: Array<{ filters: Array<{ propertyName: string }> }> };
    expect(body.filterGroups).toHaveLength(2);
    // Pipeline filter is first in every group
    expect(body.filterGroups[0].filters[0].propertyName).toBe('pipeline');
    expect(body.filterGroups[1].filters[0].propertyName).toBe('pipeline');
    // User filter is preserved in each group
    expect(body.filterGroups[0].filters.some(f => f.propertyName === 'amount')).toBe(true);
    expect(body.filterGroups[1].filters.some(f => f.propertyName === 'amount')).toBe(true);
  });
});

// ── fetchDeals: backfill window filter shapes ────────────────────────────────

describe('fetchDeals backfill window filter shape', () => {
  it('sends no window filter when neither lastSyncAt nor windowFrom/To are provided', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'pipe-1' });

    const filters = (calls[0] as { filterGroups: Array<{ filters: Array<{ operator: string }> }> }).filterGroups[0].filters;
    // Only the pipeline filter; no incremental or BETWEEN filter
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({ propertyName: 'pipeline' });
  });

  it('uses string coercion for windowFrom and windowTo values', async () => {
    const calls = mockFetchCapture();
    await fetchDeals({ pipelineId: 'p', windowFrom: 1735689600000, windowTo: 1746748800000 });

    const filters = (calls[0] as { filterGroups: Array<{ filters: Array<{ value?: string; highValue?: string }> }> }).filterGroups[0].filters;
    const between = filters.find(f => (f as { operator: string }).operator === 'BETWEEN');
    expect(typeof between?.value).toBe('string');
    expect(typeof between?.highValue).toBe('string');
  });
});

// ── fetchDealAssociations: chunking + primary detection ──────────────────────

describe('fetchDealAssociations', () => {
  it('sends a single batch request for 1000 or fewer IDs', async () => {
    mockFetchReturn({ results: [] });
    const ids = Array.from({ length: 1000 }, (_, i) => String(i));
    await fetchDealAssociations(ids);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string) as { inputs: { id: string }[] };
    expect(body.inputs).toHaveLength(1000);
  });

  it('chunks 1001 IDs into two batch requests', async () => {
    const callBodies: unknown[] = [];
    global.fetch = jest.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      callBodies.push(opts?.body ? JSON.parse(opts.body as string) : null);
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({ results: [] }),
      } as unknown as Response);
    });

    const ids = Array.from({ length: 1001 }, (_, i) => String(i));
    await fetchDealAssociations(ids);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((callBodies[0] as { inputs: unknown[] }).inputs).toHaveLength(1000);
    expect((callBodies[1] as { inputs: unknown[] }).inputs).toHaveLength(1);
  });

  it('detects primary association via deal_to_company_primary label', async () => {
    mockFetchReturn({
      results: [
        {
          from: { id: 'deal-1' },
          to: [
            {
              toObjectId: 'company-A',
              associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 341, label: 'deal_to_company_primary' }],
            },
            {
              toObjectId: 'company-B',
              associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 342, label: 'deal_to_company' }],
            },
          ],
        },
      ],
    });

    const result = await fetchDealAssociations(['deal-1']);
    const assoc = result.get('deal-1')!;
    expect(assoc.primary).toBe('company-A');
    expect(assoc.all).toEqual(expect.arrayContaining(['company-A', 'company-B']));
    expect(assoc.all).toHaveLength(2);
  });

  it('leaves primary undefined when no association has the primary label', async () => {
    mockFetchReturn({
      results: [
        {
          from: { id: 'deal-2' },
          to: [
            { toObjectId: 'company-C', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 342, label: 'deal_to_company' }] },
          ],
        },
      ],
    });

    const result = await fetchDealAssociations(['deal-2']);
    const assoc = result.get('deal-2')!;
    expect(assoc.primary).toBeUndefined();
    expect(assoc.all).toEqual(['company-C']);
  });

  it('seeds deals absent from the batch response with an empty record', async () => {
    mockFetchReturn({ results: [] });

    const result = await fetchDealAssociations(['deal-99']);
    expect(result.get('deal-99')).toEqual({ all: [] });
  });

  it('returns a map keyed by deal ID covering all input IDs', async () => {
    mockFetchReturn({
      results: [
        { from: { id: 'deal-1' }, to: [{ toObjectId: 'co-1', associationTypes: [] }] },
      ],
    });

    const result = await fetchDealAssociations(['deal-1', 'deal-2']);
    expect(result.has('deal-1')).toBe(true);
    expect(result.has('deal-2')).toBe(true); // seeded as empty
  });
});
