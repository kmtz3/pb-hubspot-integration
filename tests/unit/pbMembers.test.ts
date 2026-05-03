import { listPbMembers, buildPbMemberEmailSet } from '../../src/sync/productboard';

beforeAll(() => { process.env.PB_API_KEY = 'test-pb-token'; });
afterAll(() => { delete process.env.PB_API_KEY; });
afterEach(() => jest.restoreAllMocks());

function mockFetchSequence(pages: unknown[]) {
  let i = 0;
  global.fetch = jest.fn().mockImplementation(() => {
    const body = pages[Math.min(i++, pages.length - 1)];
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
}

describe('listPbMembers', () => {
  it('lowercases emails and follows pagination cursors', async () => {
    mockFetchSequence([
      {
        data: [
          { id: 'm-1', fields: { email: 'Klara@Productboard.com', name: 'Klara', role: 'admin', disabled: false, invitationPending: false } },
        ],
        links: { next: 'https://api.productboard.com/v2/members?pageCursor=abc' },
      },
      {
        data: [
          { id: 'm-2', fields: { email: 'BOB@example.com', name: 'Bob', role: 'maker', disabled: false, invitationPending: false } },
        ],
        links: { next: null },
      },
    ]);

    const out = await listPbMembers();
    expect(out.map(m => m.email)).toEqual(['klara@productboard.com', 'bob@example.com']);
    expect(out[0]).toMatchObject({ id: 'm-1', name: 'Klara', role: 'admin', disabled: false, invitationPending: false });
  });

  it('default options exclude disabled and pending-invite members at the URL level', async () => {
    let capturedUrl = '';
    global.fetch = jest.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({ data: [], links: { next: null } }),
      } as unknown as Response);
    });

    await listPbMembers();
    expect(capturedUrl).toContain('includeDisabled=false');
    expect(capturedUrl).toContain('includeInvited=false');
  });
});

describe('buildPbMemberEmailSet', () => {
  it('returns a Set of lowercased emails', async () => {
    mockFetchSequence([
      {
        data: [
          { id: 'm-1', fields: { email: 'Klara@Productboard.com', role: 'admin', disabled: false, invitationPending: false } },
          { id: 'm-2', fields: { email: 'bob@example.com', role: 'maker', disabled: false, invitationPending: false } },
        ],
        links: { next: null },
      },
    ]);

    const set = await buildPbMemberEmailSet();
    expect(set.has('klara@productboard.com')).toBe(true);
    expect(set.has('bob@example.com')).toBe(true);
    // Original-case lookup must NOT match — the set only contains lowercased.
    expect(set.has('Klara@Productboard.com')).toBe(false);
  });

  it('drops [redacted] entries so a token without members:pii:read does not blank-list everyone', async () => {
    mockFetchSequence([
      {
        data: [
          { id: 'm-1', fields: { email: '[redacted]', role: 'admin', disabled: false, invitationPending: false } },
          { id: 'm-2', fields: { email: 'real@example.com', role: 'admin', disabled: false, invitationPending: false } },
        ],
        links: { next: null },
      },
    ]);

    const set = await buildPbMemberEmailSet();
    expect(set.has('[redacted]')).toBe(false);
    expect(set.has('real@example.com')).toBe(true);
    expect(set.size).toBe(1);
  });
});
