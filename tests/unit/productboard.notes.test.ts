import {
  listHubspotDealNotes,
  createDealNote,
  patchDealNote,
  getDealNoteRelationships,
  unlinkDealNoteRelationship,
  relinkDealNoteRelationship,
  setDealNoteCustomer,
  getOrCreateUnassignedCompany,
} from '../../src/sync/productboard';

beforeAll(() => { process.env.PB_API_KEY = 'test-pb-token'; });
afterAll(() => { delete process.env.PB_API_KEY; });
afterEach(() => jest.restoreAllMocks());

interface Capture { url: string; method: string; body: unknown }

function mockFetchSequence(responses: Array<{ status?: number; body: unknown }>) {
  const captures: Capture[] = [];
  let i = 0;
  global.fetch = jest.fn().mockImplementation((url: string, opts: RequestInit = {}) => {
    captures.push({
      url,
      method: (opts.method ?? 'GET').toUpperCase(),
      body: opts.body ? JSON.parse(opts.body as string) : null,
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve({
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: new Headers(),
      json: () => Promise.resolve(r.body),
    } as unknown as Response);
  });
  return captures;
}

describe('listHubspotDealNotes', () => {
  it('paginates with metadata source filter and concatenates pages', async () => {
    const captures = mockFetchSequence([
      {
        body: {
          data: [{ id: 'note-1', fields: {}, metadata: { source: { system: 'hubspot', recordId: 'deal-1' } } }],
          links: { next: 'https://api.productboard.com/v2/notes?metadata[source][system]=hubspot&pageCursor=abc' },
        },
      },
      {
        body: {
          data: [{ id: 'note-2', fields: {}, metadata: { source: { system: 'hubspot', recordId: 'deal-2' } } }],
          links: { next: null },
        },
      },
    ]);

    const notes = await listHubspotDealNotes();

    expect(notes).toHaveLength(2);
    expect(notes[0].id).toBe('note-1');
    expect(notes[1].id).toBe('note-2');
    expect(captures[0].url).toBe('https://api.productboard.com/v2/notes?metadata[source][system]=hubspot');
    // Second call follows links.next verbatim — the v2 cursor lives in the URL,
    // not as a query param the client constructs.
    expect(captures[1].url).toContain('pageCursor=abc');
  });
});

describe('createDealNote', () => {
  it('POSTs to /v2/notes with the supplied payload and returns the created note', async () => {
    const captures = mockFetchSequence([
      { body: { data: { id: 'note-new', fields: {}, metadata: { source: { system: 'hubspot', recordId: 'deal-99' } } } } },
    ]);

    const out = await createDealNote({
      data: {
        type: 'textNote',
        fields: { name: 'Acme deal', content: '<p>body</p>' },
        metadata: { source: { system: 'hubspot', recordId: 'deal-99' } },
        relationships: [{ type: 'customer', target: { id: 'pb-co-uuid', type: 'company' } }],
      },
    });

    expect(out.id).toBe('note-new');
    expect(captures[0]).toMatchObject({ url: 'https://api.productboard.com/v2/notes', method: 'POST' });
    const body = captures[0].body as { data: { type: string; relationships: Array<{ type: string }> } };
    expect(body.data.type).toBe('textNote');
    expect(body.data.relationships[0].type).toBe('customer');
  });
});

describe('patchDealNote', () => {
  it('PATCHes /v2/notes/{id} with the supplied patch body', async () => {
    const captures = mockFetchSequence([
      { body: { data: { id: 'note-1', fields: { name: 'updated' }, metadata: {} } } },
    ]);

    await patchDealNote('note-1', {
      data: { patch: [{ op: 'set', path: 'name', value: 'updated' }] },
    });

    expect(captures[0]).toMatchObject({
      url: 'https://api.productboard.com/v2/notes/note-1',
      method: 'PATCH',
    });
  });
});

describe('relationships endpoints', () => {
  it('GET /relationships returns the data array', async () => {
    mockFetchSequence([
      { body: { data: [{ type: 'link', target: { id: 'feat-1', type: 'feature' } }] } },
    ]);
    const rels = await getDealNoteRelationships('note-1');
    expect(rels).toEqual([{ type: 'link', target: { id: 'feat-1', type: 'feature' } }]);
  });

  it('DELETE /relationships/link/{targetId} for unlink', async () => {
    const captures = mockFetchSequence([{ status: 204, body: null }]);
    await unlinkDealNoteRelationship('note-1', 'feat-1');
    expect(captures[0]).toMatchObject({
      url: 'https://api.productboard.com/v2/notes/note-1/relationships/link/feat-1',
      method: 'DELETE',
    });
  });

  it('POST /relationships writes target.type as the literal "link" (read/write divergence)', async () => {
    const captures = mockFetchSequence([{ body: { data: {} } }]);
    await relinkDealNoteRelationship('note-1', 'feat-1');
    expect(captures[0].method).toBe('POST');
    expect(captures[0].body).toEqual({
      data: { type: 'link', target: { id: 'feat-1', type: 'link' } },
    });
  });

  it('PUT /relationships/customer replaces the customer link (used by heal pass)', async () => {
    const captures = mockFetchSequence([{ body: { data: { type: 'customer', target: { id: 'pb-co', type: 'company' } } } }]);
    await setDealNoteCustomer('note-1', { type: 'company', id: 'pb-co' });
    expect(captures[0]).toMatchObject({
      url: 'https://api.productboard.com/v2/notes/note-1/relationships/customer',
      method: 'PUT',
    });
    expect(captures[0].body).toEqual({
      data: { target: { type: 'company', id: 'pb-co' } },
    });
  });
});

describe('getOrCreateUnassignedCompany', () => {
  it('returns the existing placeholder uuid when the lookup hits', async () => {
    mockFetchSequence([
      {
        body: {
          data: [
            { id: 'pb-uuid-existing', type: 'company', fields: { name: 'Unassigned …' }, metadata: { source: { system: 'hubspot', recordId: 'unassigned-placeholder' } } },
          ],
          links: { next: null },
        },
      },
    ]);

    const res = await getOrCreateUnassignedCompany();
    expect(res).toEqual({ pbUuid: 'pb-uuid-existing' });
  });

  it('creates the placeholder when the lookup misses', async () => {
    const captures = mockFetchSequence([
      { body: { data: [], links: { next: null } } },               // lookup miss
      { body: { data: { id: 'pb-uuid-new', type: 'company', fields: {}, metadata: { source: { system: 'hubspot', recordId: 'unassigned-placeholder' } } } } }, // create response
    ]);

    const res = await getOrCreateUnassignedCompany();

    expect(res).toEqual({ pbUuid: 'pb-uuid-new' });
    expect(captures).toHaveLength(2);
    expect(captures[1].method).toBe('POST');
    const createBody = captures[1].body as { data: { type: string; fields: { name: string }; metadata: { source: { recordId: string } } } };
    expect(createBody.data.type).toBe('company');
    expect(createBody.data.metadata.source.recordId).toBe('unassigned-placeholder');
    // No tag in the create payload — see feedback_pb_tag_provisioning_unavailable.md.
    expect(createBody.data.fields).not.toHaveProperty('tags');
  });
});
