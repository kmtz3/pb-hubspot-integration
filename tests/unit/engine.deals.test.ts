import { computeDealTargets, existingTagNames, unionTagNames } from '../../src/sync/engine';
import type { HubSpotDeal } from '../../src/types/hubspot';
import type { ProductboardNote } from '../../src/types/productboard';

function deal(id = 'd-1'): HubSpotDeal {
  return { id, properties: {}, createdAt: '', updatedAt: '' };
}

describe('computeDealTargets — multi-company recordId algorithm', () => {
  const placeholder = 'pb-unassigned';

  it('single mode: one target, recordId `deal-<id>`, primary company resolves', () => {
    const targets = computeDealTargets(
      deal('77'),
      { primary: 'hs-co-1', all: ['hs-co-1'] },
      false,
      new Map([['hs-co-1', 'pb-co-1']]),
      placeholder,
    );
    expect(targets).toEqual([{ companyKey: null, recordId: 'deal-77', pbCompanyUuid: 'pb-co-1' }]);
  });

  it('single mode + multiple associations: uses primary, falls back to first', () => {
    const targets = computeDealTargets(
      deal('77'),
      { all: ['hs-co-1', 'hs-co-2'] },
      false,
      new Map([['hs-co-1', 'pb-co-1'], ['hs-co-2', 'pb-co-2']]),
      placeholder,
    );
    expect(targets).toEqual([{ companyKey: null, recordId: 'deal-77', pbCompanyUuid: 'pb-co-1' }]);
  });

  it('single mode + no associations: lands on the unassigned placeholder', () => {
    const targets = computeDealTargets(
      deal('77'),
      { all: [] },
      false,
      new Map(),
      placeholder,
    );
    expect(targets).toEqual([{ companyKey: null, recordId: 'deal-77', pbCompanyUuid: placeholder }]);
  });

  it('multi mode + 1 association: still single target (toggle short-circuits)', () => {
    const targets = computeDealTargets(
      deal('77'),
      { primary: 'hs-co-1', all: ['hs-co-1'] },
      true,
      new Map([['hs-co-1', 'pb-co-1']]),
      placeholder,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].companyKey).toBeNull();
  });

  it('multi mode + N associations: one target per company, recordId `deal-<id>::company-<co>`', () => {
    const targets = computeDealTargets(
      deal('77'),
      { primary: 'hs-co-1', all: ['hs-co-1', 'hs-co-2'] },
      true,
      new Map([['hs-co-1', 'pb-co-1'], ['hs-co-2', 'pb-co-2']]),
      placeholder,
    );
    expect(targets).toEqual([
      { companyKey: 'hs-co-1', recordId: 'deal-77::company-hs-co-1', pbCompanyUuid: 'pb-co-1' },
      { companyKey: 'hs-co-2', recordId: 'deal-77::company-hs-co-2', pbCompanyUuid: 'pb-co-2' },
    ]);
  });

  it('multi mode + a company that is missing from PB falls back to placeholder', () => {
    const targets = computeDealTargets(
      deal('77'),
      { all: ['hs-co-1', 'hs-co-missing'] },
      true,
      new Map([['hs-co-1', 'pb-co-1']]),
      placeholder,
    );
    expect(targets[1].pbCompanyUuid).toBe(placeholder);
  });
});

describe('unionTagNames — D10 union-on-PATCH semantics', () => {
  it('returns the union, sorted, deduped, never subtracting', () => {
    expect(unionTagNames(['a', 'b', 'c'], ['b', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('preserves all existing tags even when no new ones are requested', () => {
    expect(unionTagNames(['x', 'y'], [])).toEqual(['x', 'y']);
  });

  it('drops empty strings on either side', () => {
    expect(unionTagNames(['', 'a'], ['', 'b'])).toEqual(['a', 'b']);
  });
});

describe('existingTagNames', () => {
  it('returns deduped names from the note tags array', () => {
    const note: ProductboardNote = {
      id: 'n-1',
      fields: {
        tags: [
          { id: 't-1', name: 'foo' },
          { id: 't-2', name: 'bar' },
          { id: 't-3', name: 'foo' }, // duplicate name
        ],
      },
      metadata: {},
    };
    expect(existingTagNames(note).sort()).toEqual(['bar', 'foo']);
  });

  it('returns an empty array when fields.tags is missing', () => {
    expect(existingTagNames({ id: 'n-1', fields: {}, metadata: {} })).toEqual([]);
  });
});
