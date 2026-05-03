import { buildContentHtml, buildDealNotePayload, evaluateRules } from '../../src/sync/dealNoteBuilder';
import type { HubSpotDeal } from '../../src/types/hubspot';
import type { BodyMapping, TagMapping, TagRule } from '../../src/types/sync';

function makeDeal(properties: Record<string, string | null>, id = 'deal-001'): HubSpotDeal {
  return {
    id,
    properties,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

describe('evaluateRules — operator coverage', () => {
  // The operator set must match `src/client/constants/operators.ts` exactly,
  // since the rule UI (Phase 5) picks from that list. Each branch below
  // corresponds to one operator.

  it('EQ matches case-sensitively', () => {
    const rules: TagRule[] = [{ field: 'dealstage', operator: 'EQ', value: 'closedwon', tagName: 'won' }];
    expect(evaluateRules(makeDeal({ dealstage: 'closedwon' }), rules)).toEqual(['won']);
    expect(evaluateRules(makeDeal({ dealstage: 'closedlost' }), rules)).toEqual([]);
  });

  it('NEQ inverts EQ', () => {
    const rules: TagRule[] = [{ field: 'dealstage', operator: 'NEQ', value: 'closedwon', tagName: 'not-won' }];
    expect(evaluateRules(makeDeal({ dealstage: 'qualified' }), rules)).toEqual(['not-won']);
    expect(evaluateRules(makeDeal({ dealstage: 'closedwon' }), rules)).toEqual([]);
  });

  it('LT / LTE / GT / GTE on numeric values', () => {
    const lt:  TagRule[] = [{ field: 'amount', operator: 'LT',  value: '100', tagName: 'small' }];
    const lte: TagRule[] = [{ field: 'amount', operator: 'LTE', value: '100', tagName: 'lte-100' }];
    const gt:  TagRule[] = [{ field: 'amount', operator: 'GT',  value: '100', tagName: 'big' }];
    const gte: TagRule[] = [{ field: 'amount', operator: 'GTE', value: '100', tagName: 'gte-100' }];

    const d50  = makeDeal({ amount:  '50' });
    const d100 = makeDeal({ amount: '100' });
    const d200 = makeDeal({ amount: '200' });

    expect(evaluateRules(d50,  lt )).toEqual(['small']);
    expect(evaluateRules(d100, lt )).toEqual([]);
    expect(evaluateRules(d100, lte)).toEqual(['lte-100']);
    expect(evaluateRules(d200, gt )).toEqual(['big']);
    expect(evaluateRules(d100, gte)).toEqual(['gte-100']);
  });

  it('BETWEEN matches inclusive numeric range', () => {
    const rules: TagRule[] = [{ field: 'amount', operator: 'BETWEEN', values: ['50', '150'], tagName: 'mid' }];
    expect(evaluateRules(makeDeal({ amount: '100' }), rules)).toEqual(['mid']);
    expect(evaluateRules(makeDeal({ amount:  '50' }), rules)).toEqual(['mid']);
    expect(evaluateRules(makeDeal({ amount: '150' }), rules)).toEqual(['mid']);
    expect(evaluateRules(makeDeal({ amount: '200' }), rules)).toEqual([]);
  });

  it('IN / NOT_IN match against value lists', () => {
    const inRule:  TagRule[] = [{ field: 'dealstage', operator: 'IN',     values: ['a', 'b'], tagName: 'in-list'  }];
    const notIn:  TagRule[] = [{ field: 'dealstage', operator: 'NOT_IN', values: ['a', 'b'], tagName: 'not-in-list' }];
    expect(evaluateRules(makeDeal({ dealstage: 'a' }), inRule)).toEqual(['in-list']);
    expect(evaluateRules(makeDeal({ dealstage: 'c' }), inRule)).toEqual([]);
    expect(evaluateRules(makeDeal({ dealstage: 'c' }), notIn)).toEqual(['not-in-list']);
    expect(evaluateRules(makeDeal({ dealstage: 'a' }), notIn)).toEqual([]);
  });

  it('HAS_PROPERTY / NOT_HAS_PROPERTY treat empty/null as not set', () => {
    const has:    TagRule[] = [{ field: 'description', operator: 'HAS_PROPERTY',     tagName: 'has' }];
    const notHas: TagRule[] = [{ field: 'description', operator: 'NOT_HAS_PROPERTY', tagName: 'not-has' }];
    expect(evaluateRules(makeDeal({ description: 'hello' }), has)).toEqual(['has']);
    expect(evaluateRules(makeDeal({ description: ''      }), has)).toEqual([]);
    expect(evaluateRules(makeDeal({ description: null    }), has)).toEqual([]);
    expect(evaluateRules(makeDeal({ description: ''      }), notHas)).toEqual(['not-has']);
    expect(evaluateRules(makeDeal({ description: 'x'     }), notHas)).toEqual([]);
  });

  it('CONTAINS_TOKEN / NOT_CONTAINS_TOKEN are case-insensitive substring checks', () => {
    const c:  TagRule[] = [{ field: 'description', operator: 'CONTAINS_TOKEN',     value: 'urgent', tagName: 'urgent' }];
    const nc: TagRule[] = [{ field: 'description', operator: 'NOT_CONTAINS_TOKEN', value: 'urgent', tagName: 'not-urgent' }];
    expect(evaluateRules(makeDeal({ description: 'This is URGENT' }), c)).toEqual(['urgent']);
    expect(evaluateRules(makeDeal({ description: 'standard'       }), c)).toEqual([]);
    expect(evaluateRules(makeDeal({ description: 'standard'       }), nc)).toEqual(['not-urgent']);
  });

  it('returns multiple tag names when multiple rules match', () => {
    const rules: TagRule[] = [
      { field: 'hs_is_closed_won',  operator: 'EQ', value: 'true', tagName: 'closed-won'  },
      { field: 'hs_is_closed_lost', operator: 'EQ', value: 'true', tagName: 'closed-lost' },
    ];
    expect(evaluateRules(makeDeal({ hs_is_closed_won: 'true', hs_is_closed_lost: 'false' }), rules)).toEqual(['closed-won']);
  });
});

describe('buildContentHtml', () => {
  const baseDeal = makeDeal({
    dealname: 'Acme renewal',
    amount: '50000',
    description: '<p>Customer wants <strong>more seats</strong></p>',
  });

  it('renders metadata style as a paragraph with bold label', () => {
    const html = buildContentHtml(baseDeal, [
      { hsField: 'amount', label: 'Amount', style: 'metadata', order: 1, enabled: true },
    ]);
    expect(html).toBe('<p><strong>Amount:</strong> 50000</p>');
  });

  it('renders longform style as h2 + sanitized div', () => {
    const html = buildContentHtml(baseDeal, [
      { hsField: 'description', label: 'Notes', style: 'longform', order: 1, enabled: true },
    ]);
    // sanitizeDescription's allowlist does NOT include <strong> — the tag is
    // stripped but the text content is preserved.
    expect(html).toContain('<h2>Notes</h2>');
    expect(html).toContain('Customer wants more seats');
    expect(html).toContain('<div>');
  });

  it('mixes metadata + longform in declared order', () => {
    const html = buildContentHtml(baseDeal, [
      { hsField: 'amount',      label: 'Amount', style: 'metadata', order: 2, enabled: true },
      { hsField: 'description', label: 'Notes',  style: 'longform', order: 1, enabled: true },
    ]);
    // Description (order 1) renders before amount (order 2).
    expect(html.indexOf('<h2>Notes</h2>')).toBeLessThan(html.indexOf('<strong>Amount:</strong>'));
  });

  it('skips disabled rows and rows whose value is missing', () => {
    const html = buildContentHtml(makeDeal({ dealname: 'foo', amount: null }), [
      { hsField: 'amount',   label: 'Amount',   style: 'metadata', order: 1, enabled: true  },
      { hsField: 'dealname', label: 'Disabled', style: 'metadata', order: 2, enabled: false },
    ]);
    expect(html).toBe('');
  });

  it('escapes HTML in metadata values', () => {
    const html = buildContentHtml(makeDeal({ dealname: '<script>alert(1)</script>' }), [
      { hsField: 'dealname', label: 'Title', style: 'metadata', order: 1, enabled: true },
    ]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('falls back to hsField as label when label is missing', () => {
    const html = buildContentHtml(makeDeal({ amount: '100' }), [
      { hsField: 'amount', style: 'metadata', order: 1, enabled: true },
    ]);
    expect(html).toBe('<p><strong>amount:</strong> 100</p>');
  });
});

describe('buildDealNotePayload', () => {
  const baseArgs = {
    deal: makeDeal({ dealname: 'Acme', dealstage: 'closedwon', amount: '500' }, 'deal-7'),
    companyPbUuid: 'pb-co-uuid',
    companyKey: null,
    recordId: 'deal-7',
    sourceUrl: 'https://app.hubspot.com/contacts/12345/deal/deal-7',
    tagMappings: [] as TagMapping[],
    bodyMappings: [] as BodyMapping[],
    rules: [] as TagRule[],
    staticTags: [] as string[],
    ownerEmail: null as string | null,
  };

  it('produces a textNote payload with name, recordId, customer link, and source url', () => {
    const { payload } = buildDealNotePayload(baseArgs);
    expect(payload.data.type).toBe('textNote');
    expect(payload.data.fields.name).toBe('Acme');
    expect(payload.data.metadata.source.recordId).toBe('deal-7');
    expect(payload.data.metadata.source.url).toContain('/deal/deal-7');
    expect(payload.data.relationships).toEqual([
      { type: 'customer', target: { id: 'pb-co-uuid', type: 'company' } },
    ]);
  });

  it('falls back to "Deal <id>" when dealname is missing', () => {
    const { payload } = buildDealNotePayload({
      ...baseArgs,
      deal: makeDeal({}, 'deal-99'),
    });
    expect(payload.data.fields.name).toBe('Deal deal-99');
  });

  it('emits unique sorted tag names from staticTags + rules + tagMappings', () => {
    const { tagsToProvision } = buildDealNotePayload({
      ...baseArgs,
      staticTags: ['hubspot-source'],
      rules: [{ field: 'dealstage', operator: 'EQ', value: 'closedwon', tagName: 'closed-won' }],
      tagMappings: [
        { hsField: 'dealstage', enabled: true },
      ],
    });
    expect(tagsToProvision).toEqual(['closed-won', 'closedwon', 'hubspot-source']);
  });

  it('drops "false" boolean values and includes "true" with the field name as the tag', () => {
    const { tagsToProvision } = buildDealNotePayload({
      ...baseArgs,
      deal: makeDeal({ hs_is_closed_won: 'true', hs_is_closed_lost: 'false' }),
      tagMappings: [
        { hsField: 'hs_is_closed_won',  enabled: true },
        { hsField: 'hs_is_closed_lost', enabled: true },
      ],
    });
    expect(tagsToProvision).toEqual(['hs_is_closed_won']);
  });

  it('omits owner field when ownerEmail is null', () => {
    const { payload } = buildDealNotePayload({ ...baseArgs, ownerEmail: null });
    expect(payload.data.fields.owner).toBeUndefined();
  });

  it('sets owner field when ownerEmail is provided', () => {
    const { payload } = buildDealNotePayload({ ...baseArgs, ownerEmail: 'a@b.com' });
    expect(payload.data.fields.owner).toEqual({ email: 'a@b.com' });
  });
});
