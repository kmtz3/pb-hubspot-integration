import {
  listTags,
  createTag,
  ensureTagsExist,
} from '../../src/sync/productboard';
import type { ProductboardTag } from '../../src/types/productboard';

beforeAll(() => { process.env.PB_API_KEY = 'test-pb-token'; });
afterAll(() => { delete process.env.PB_API_KEY; });
afterEach(() => jest.restoreAllMocks());

function mockFetchSequence(responses: Array<{ status?: number; body: unknown }>) {
  let i = 0;
  const calls: string[] = [];
  global.fetch = jest.fn().mockImplementation((url: string) => {
    calls.push(url);
    const r = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve({
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: new Headers(),
      json: () => Promise.resolve(r.body),
    } as unknown as Response);
  });
  return calls;
}

describe('listTags', () => {
  it('paginates /v2/entities/fields/tags/values and projects to {id, name}', async () => {
    mockFetchSequence([
      {
        body: {
          data: [
            { id: 't-1', fields: { name: 'closed-won', color: 'green' } },
            { id: 't-2', fields: { name: 'closed-lost', color: 'red' } },
          ],
          links: { next: null },
        },
      },
    ]);

    const out = await listTags();
    expect(out).toEqual([
      { id: 't-1', name: 'closed-won' },
      { id: 't-2', name: 'closed-lost' },
    ]);
  });
});

describe('createTag', () => {
  it('POSTs /v2/entities/fields/tags/values and returns the new {id, name}', async () => {
    const calls = mockFetchSequence([
      { status: 201, body: { data: { id: 'tag-new-123' } } },
    ]);

    const out = await createTag('hubspot-test');

    expect(out).toEqual({ id: 'tag-new-123', name: 'hubspot-test' });
    expect(calls[0]).toContain('/v2/entities/fields/tags/values');
  });
});

describe('ensureTagsExist', () => {
  it('populates the cache from listTags() on first call when the cache is empty', async () => {
    mockFetchSequence([
      {
        body: {
          data: [
            { id: 't-1', fields: { name: 'closed-won', color: 'green' } },
            { id: 't-2', fields: { name: 'closed-lost', color: 'red' } },
          ],
          links: { next: null },
        },
      },
    ]);

    const cache = new Map<string, ProductboardTag>();
    const out = await ensureTagsExist(['closed-won'], cache);

    expect(out.get('closed-won')).toEqual({ id: 't-1', name: 'closed-won' });
    expect(cache.size).toBe(2); // both pre-existing tags loaded
  });

  it('auto-provisions unknown names via POST and caches the result', async () => {
    mockFetchSequence([
      { status: 201, body: { data: { id: 't-new' } } },
    ]);
    const cache = new Map<string, ProductboardTag>([['known', { id: 't-1', name: 'known' }]]);

    const out = await ensureTagsExist(['known', 'unknown-tag-name'], cache);

    expect(out.size).toBe(2);
    expect(out.get('known')).toEqual({ id: 't-1', name: 'known' });
    expect(out.get('unknown-tag-name')).toEqual({ id: 't-new', name: 'unknown-tag-name' });
    expect(cache.get('unknown-tag-name')).toEqual({ id: 't-new', name: 'unknown-tag-name' });
  });

  it('drops a tag whose POST fails (logs warning, survives the call)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchSequence([
      { status: 400, body: { errors: [{ title: 'invalid name' }] } },
    ]);
    const cache = new Map<string, ProductboardTag>([['known', { id: 't-1', name: 'known' }]]);

    const out = await ensureTagsExist(['known', 'will-fail'], cache);

    expect(out.size).toBe(1);
    expect(out.get('known')).toEqual({ id: 't-1', name: 'known' });
    expect(out.has('will-fail')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('will-fail'));
    warn.mockRestore();
  });

  it('skips empty / whitespace-only names without making them part of the result', async () => {
    const cache = new Map<string, ProductboardTag>([['known', { id: 't-1', name: 'known' }]]);
    const out = await ensureTagsExist(['known', '', '   '], cache);
    expect(Array.from(out.keys())).toEqual(['known']);
  });

  it('reuses an already-populated cache without re-fetching', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const cache = new Map<string, ProductboardTag>([['a', { id: 't-a', name: 'a' }]]);

    await ensureTagsExist(['a'], cache);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
