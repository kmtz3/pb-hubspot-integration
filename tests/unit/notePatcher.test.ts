jest.mock('../../src/sync/productboard');

import * as pbClient from '../../src/sync/productboard';
import { patchDealNoteContent, unlinkPatchRelink } from '../../src/sync/notePatcher';
import { ApiError } from '../../src/sync/rateLimit';
import type { NotePatch } from '../../src/types/productboard';

const mockPatch     = jest.mocked(pbClient.patchDealNote);
const mockGetRels   = jest.mocked(pbClient.getDealNoteRelationships);
const mockUnlink    = jest.mocked(pbClient.unlinkDealNoteRelationship);
const mockRelink    = jest.mocked(pbClient.relinkDealNoteRelationship);

beforeEach(() => {
  jest.resetAllMocks();
});

const fullPatch: NotePatch = {
  data: {
    fields: { name: 'Updated', content: '<p>new body</p>', tags: [{ name: 'a' }] },
  },
};

const contentLockedError = new ApiError(
  'HTTP 422',
  422,
  { errors: [{ code: 'validation.forbidden', source: { pointer: '/data/fields/content' }, detail: 'Cannot update content for notes with linked features' }] },
);

describe('patchDealNoteContent — happy path', () => {
  it('PATCHes the full payload and returns "patched"', async () => {
    mockPatch.mockResolvedValue({ id: 'n-1', fields: {}, metadata: {} });
    const result = await patchDealNoteContent('n-1', fullPatch, { forceContentUpdates: false });
    expect(result.status).toBe('patched');
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockGetRels).not.toHaveBeenCalled();
  });
});

describe('patchDealNoteContent — content-lock 422 in safe mode', () => {
  it('drops content and retries the PATCH with the remaining fields', async () => {
    mockPatch
      .mockRejectedValueOnce(contentLockedError)
      .mockResolvedValueOnce({ id: 'n-1', fields: {}, metadata: {} });

    const result = await patchDealNoteContent('n-1', fullPatch, { forceContentUpdates: false });

    expect(result.status).toBe('patched-without-content');
    expect(mockPatch).toHaveBeenCalledTimes(2);
    const secondCallPatch = mockPatch.mock.calls[1][1];
    expect(secondCallPatch.data.fields).not.toHaveProperty('content');
    expect(secondCallPatch.data.fields).toMatchObject({ name: 'Updated', tags: expect.any(Array) });
    // Critically: the relationship endpoints are NEVER called in safe mode.
    expect(mockGetRels).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockRelink).not.toHaveBeenCalled();
  });

  it('skips the retry PATCH entirely when content was the only field', async () => {
    mockPatch.mockRejectedValueOnce(contentLockedError);
    const onlyContent: NotePatch = { data: { fields: { content: '<p>x</p>' } } };
    const result = await patchDealNoteContent('n-1', onlyContent, { forceContentUpdates: false });
    expect(result.status).toBe('patched-without-content');
    expect(mockPatch).toHaveBeenCalledTimes(1); // only the failed first attempt
  });

  it('rethrows non-content-lock errors', async () => {
    const other = new ApiError('HTTP 500', 500, { errors: [{ code: 'system.internalServerError' }] });
    mockPatch.mockRejectedValueOnce(other);
    await expect(patchDealNoteContent('n-1', fullPatch, { forceContentUpdates: false })).rejects.toBe(other);
  });
});

describe('patchDealNoteContent — content-lock 422 in force mode', () => {
  it('unlinks every link relationship, PATCHes content, then re-links them in the original order', async () => {
    mockPatch
      .mockRejectedValueOnce(contentLockedError) // first attempt fails
      .mockResolvedValueOnce({ id: 'n-1', fields: {}, metadata: {} }); // post-unlink succeeds
    mockGetRels.mockResolvedValue([
      { type: 'link',     target: { id: 'feat-1', type: 'feature' } },
      { type: 'link',     target: { id: 'feat-2', type: 'product' } },
      { type: 'customer', target: { id: 'pb-co',  type: 'company' } }, // must be left alone
    ]);
    mockUnlink.mockResolvedValue(undefined);
    mockRelink.mockResolvedValue(undefined);

    const result = await patchDealNoteContent('n-1', fullPatch, { forceContentUpdates: true });

    expect(result.status).toBe('patched-via-relink');
    expect(result.linksRecycled).toBe(2);
    expect(mockUnlink).toHaveBeenCalledTimes(2);
    expect(mockUnlink).toHaveBeenNthCalledWith(1, 'n-1', 'feat-1');
    expect(mockUnlink).toHaveBeenNthCalledWith(2, 'n-1', 'feat-2');
    expect(mockRelink).toHaveBeenCalledTimes(2);
    expect(mockRelink).toHaveBeenNthCalledWith(1, 'n-1', 'feat-1');
    expect(mockRelink).toHaveBeenNthCalledWith(2, 'n-1', 'feat-2');
    // The customer-type relationship is never touched.
  });
});

describe('unlinkPatchRelink (direct)', () => {
  it('does nothing extra when there are no link relationships to recycle', async () => {
    mockGetRels.mockResolvedValue([
      { type: 'customer', target: { id: 'pb-co', type: 'company' } },
    ]);
    mockPatch.mockResolvedValue({ id: 'n-1', fields: {}, metadata: {} });

    const result = await unlinkPatchRelink('n-1', fullPatch);
    expect(result.linksRecycled).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockRelink).not.toHaveBeenCalled();
  });
});
