import { buildDealNoteMaps, findExistingDealNote, parseDealRecordId } from '../../src/sync/dedup';
import type { ProductboardNote } from '../../src/types/productboard';

function note(id: string, recordId: string | undefined, archived = false): ProductboardNote {
  return {
    id,
    fields: { archived },
    metadata: recordId ? { source: { system: 'hubspot', recordId } } : {},
  };
}

describe('parseDealRecordId', () => {
  it('parses single-mode recordId', () => {
    expect(parseDealRecordId('deal-123')).toEqual({ dealId: '123', companyKey: null });
  });

  it('parses multi-mode recordId', () => {
    expect(parseDealRecordId('deal-123::company-456')).toEqual({ dealId: '123', companyKey: '456' });
  });

  it('returns null for non-deal recordIds', () => {
    expect(parseDealRecordId('hs-company-001')).toBeNull();
    expect(parseDealRecordId('unassigned-placeholder')).toBeNull();
  });

  it('returns null for malformed recordIds', () => {
    expect(parseDealRecordId('deal-')).toBeNull();
    expect(parseDealRecordId('deal-1::not-a-company')).toBeNull();
    expect(parseDealRecordId('deal-1::company-')).toBeNull();
    expect(parseDealRecordId('')).toBeNull();
  });
});

describe('buildDealNoteMaps', () => {
  it('indexes notes by dealId → (companyKey | null) → note', () => {
    const idx = buildDealNoteMaps([
      note('n-1', 'deal-7'),
      note('n-2', 'deal-7::company-A'),
      note('n-3', 'deal-7::company-B'),
      note('n-4', 'deal-9'),
    ]);
    expect(idx.get('7')?.size).toBe(3);
    expect(idx.get('7')?.get(null)?.id).toBe('n-1');
    expect(idx.get('7')?.get('A')?.id).toBe('n-2');
    expect(idx.get('7')?.get('B')?.id).toBe('n-3');
    expect(idx.get('9')?.get(null)?.id).toBe('n-4');
  });

  it('skips notes whose recordId is not a deal-note format', () => {
    const idx = buildDealNoteMaps([
      note('n-co', 'hs-company-001'),
      note('n-other', 'salesforce-deal-1'),
      note('n-empty', undefined),
    ]);
    expect(idx.size).toBe(0);
  });

  it('skips archived notes so the heal pass can recreate cleanly on the same run', () => {
    const idx = buildDealNoteMaps([
      note('n-active',   'deal-7', false),
      note('n-archived', 'deal-9', true),
    ]);
    expect(idx.has('7')).toBe(true);
    expect(idx.has('9')).toBe(false);
  });

  it('first-write-wins on duplicate recordIds', () => {
    const idx = buildDealNoteMaps([
      note('n-first',  'deal-7'),
      note('n-second', 'deal-7'),
    ]);
    expect(idx.get('7')?.get(null)?.id).toBe('n-first');
  });
});

describe('findExistingDealNote', () => {
  it('returns the note keyed by (dealId, companyKey)', () => {
    const idx = buildDealNoteMaps([
      note('n-1', 'deal-7'),
      note('n-2', 'deal-7::company-A'),
    ]);
    expect(findExistingDealNote('7', null, idx)?.id).toBe('n-1');
    expect(findExistingDealNote('7', 'A',  idx)?.id).toBe('n-2');
    expect(findExistingDealNote('7', 'B',  idx)).toBeUndefined();
    expect(findExistingDealNote('99', null, idx)).toBeUndefined();
  });
});
