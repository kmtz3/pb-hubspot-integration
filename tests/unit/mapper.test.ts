import {
  schemaToToken,
  coerceFieldValue,
  buildFieldsPayload,
  buildPatchOperations,
  stripNullFieldValues,
} from '../../src/sync/mapper';
import { makeHubSpotCompany, makeFieldMapping } from '../helpers/factories';

describe('schemaToToken', () => {
  it('maps string to text', () => expect(schemaToToken({ type: 'string' })).toBe('text'));
  it('maps string+date to date', () => expect(schemaToToken({ type: 'string', format: 'date' })).toBe('date'));
  it('maps number to number', () => expect(schemaToToken({ type: 'number' })).toBe('number'));
  it('maps boolean to boolean', () => expect(schemaToToken({ type: 'boolean' })).toBe('boolean'));
  it('maps object with name/id/color to select', () =>
    expect(schemaToToken({ type: 'object', properties: { name: {}, id: {}, color: {} } })).toBe('select'));
  it('maps array items with name/id/color to multiselect', () =>
    expect(schemaToToken({ type: 'array', items: { properties: { name: {}, id: {}, color: {} } } })).toBe('multiselect'));
  it('returns null for unknown type', () =>
    expect(schemaToToken({ type: 'unknown' } as any)).toBeNull());
  it('maps string+format=richtext to richtext', () =>
    expect(schemaToToken({ type: 'string', format: 'richtext' })).toBe('richtext'));
  it('maps string with contentMediaType to richtext', () =>
    expect(schemaToToken({ type: 'string', contentMediaType: 'text/html' } as any)).toBe('richtext'));
});

describe('coerceFieldValue', () => {
  it('wraps string in object for select', () =>
    expect(coerceFieldValue('SOFTWARE', 'select')).toEqual({ name: 'SOFTWARE' }));
  it('wraps string in array of objects for multiselect', () =>
    expect(coerceFieldValue('SOFTWARE', 'multiselect')).toEqual([{ name: 'SOFTWARE' }]));
  it('passes string through for text', () =>
    expect(coerceFieldValue('SOFTWARE', 'text')).toBe('SOFTWARE'));
  it('coerces number to string for text', () =>
    expect(coerceFieldValue(450000, 'text')).toBe('450000'));
  it('parses string to number for number', () =>
    expect(coerceFieldValue('450000', 'number')).toBe(450000));
  it('returns null for non-numeric string when target is number', () =>
    expect(coerceFieldValue('not-a-number', 'number')).toBeNull());
  it('coerces true to string', () =>
    expect(coerceFieldValue(true, 'text')).toBe('true'));
  it('coerces false to string', () =>
    expect(coerceFieldValue(false, 'text')).toBe('false'));
  it('returns null for null input', () =>
    expect(coerceFieldValue(null, 'text')).toBeNull());
  it('returns null for undefined input', () =>
    expect(coerceFieldValue(undefined, 'text')).toBeNull());

  it('wraps plain text in <p> for richtext', () =>
    expect(coerceFieldValue('Hello world', 'richtext')).toBe('<p>Hello world</p>'));
  it('escapes HTML special chars in plain text richtext', () =>
    expect(coerceFieldValue('A & B < C', 'richtext')).toBe('<p>A &amp; B &lt; C</p>'));
  it('preserves newlines as <br/> for plain-text richtext', () =>
    expect(coerceFieldValue('line1\nline2', 'richtext')).toBe('<p>line1<br/>line2</p>'));
  it('keeps allowed tags but strips disallowed ones for richtext', () => {
    const out = coerceFieldValue('<p>ok <script>bad()</script></p>', 'richtext');
    expect(out).toContain('<p>ok ');
    expect(out).not.toContain('<script');
  });
  it('returns null for empty string richtext', () =>
    expect(coerceFieldValue('', 'richtext')).toBeNull());

  it('keeps an already-ISO date as YYYY-MM-DD', () =>
    expect(coerceFieldValue('2024-03-15', 'date')).toBe('2024-03-15'));
  it('strips the time component from an ISO datetime', () =>
    expect(coerceFieldValue('2024-03-15T00:00:00Z', 'date')).toBe('2024-03-15'));
  it('strips the time component from an ISO datetime with ms', () =>
    expect(coerceFieldValue('2024-03-15T12:34:56.789Z', 'date')).toBe('2024-03-15'));
  it('formats a ms-epoch number string as YYYY-MM-DD (UTC)', () =>
    expect(coerceFieldValue('1710460800000', 'date')).toBe('2024-03-15'));
  it('formats a ms-epoch number as YYYY-MM-DD (UTC)', () =>
    expect(coerceFieldValue(1710460800000, 'date')).toBe('2024-03-15'));
  it('returns null for unparseable date strings', () =>
    expect(coerceFieldValue('not-a-date', 'date')).toBeNull());
  it('returns null for empty-string date', () =>
    expect(coerceFieldValue('', 'date')).toBeNull());
});

describe('buildFieldsPayload', () => {
  it('includes enabled mappings', () => {
    const company = makeHubSpotCompany();
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'annualrevenue', pbFieldId: 'custom_arr', pbFieldType: 'number', enabled: true, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings);
    expect(result['custom_arr']).toBe(450000);
  });

  it('rounds number mappings to the Productboard max scale', () => {
    const company = makeHubSpotCompany({ properties: { annualrevenue: '2.56113' } });
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'annualrevenue', pbFieldId: 'revenue', pbFieldType: 'number', enabled: true, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings, {
      fieldConstraintsById: new Map([['revenue', { maxScale: 2 }]]),
    });
    expect(result['revenue']).toBe(2.56);
  });

  it('skips number mappings outside Productboard min/max constraints', () => {
    const company = makeHubSpotCompany({ properties: { annualrevenue: '90189270000' } });
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'annualrevenue', pbFieldId: 'revenue', pbFieldType: 'number', enabled: true, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings, {
      fieldConstraintsById: new Map([['revenue', { maximum: 9999999999.99, maxScale: 2 }]]),
    });
    expect(result['revenue']).toBeUndefined();
  });

  it('always includes locked mappings regardless of enabled flag', () => {
    const company = makeHubSpotCompany({ properties: { name: 'Acme Corp', domain: 'acme.com' } });
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'name', pbFieldId: 'name', pbFieldType: 'text', enabled: false, locked: true }),
      makeFieldMapping({ hubspotProperty: 'domain', pbFieldId: 'domain', pbFieldType: 'text', enabled: false, locked: true }),
    ];
    const result = buildFieldsPayload(company, mappings);
    expect(result['name']).toBe('Acme Corp');
    expect(result['domain']).toBe('acme.com');
  });

  it('skips disabled unlocked mappings', () => {
    const company = makeHubSpotCompany();
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'annualrevenue', pbFieldId: 'custom_arr', pbFieldType: 'number', enabled: false, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings);
    expect(result['custom_arr']).toBeUndefined();
  });

  it('skips mappings with empty pbFieldId', () => {
    const company = makeHubSpotCompany();
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'annualrevenue', pbFieldId: '', pbFieldType: 'number', enabled: true, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('includes null when coercion fails so Productboard clears optional fields', () => {
    const company = makeHubSpotCompany({ properties: { bad_date: 'not-a-date' } });
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'bad_date', pbFieldId: 'required_date', pbFieldType: 'date', enabled: true, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings);
    expect(result['required_date']).toBeNull();
  });

  it('includes null for unresolved owner-id mappings so optional fields clear', () => {
    const company = makeHubSpotCompany({ properties: { hubspot_owner_id: '12345' } });
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'hubspot_owner_id', pbFieldId: 'owner', pbFieldType: 'member', enabled: true, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings, { ownerIdToEmail: new Map() });
    expect(result['owner']).toBeNull();
  });

  it('omits nulls for non-clearable Productboard fields', () => {
    const company = makeHubSpotCompany({ properties: { industry_source: null } as any });
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'industry_source', pbFieldId: 'required_industry', pbFieldType: 'text', enabled: true, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings, { nonClearableFieldIds: new Set(['required_industry']) });
    expect(result['required_industry']).toBeUndefined();
  });

  it('omits unresolved owner-id nulls for non-clearable Productboard fields', () => {
    const company = makeHubSpotCompany({ properties: { hubspot_owner_id: '12345' } });
    const mappings = [
      makeFieldMapping({ hubspotProperty: 'hubspot_owner_id', pbFieldId: 'owner', pbFieldType: 'member', enabled: true, locked: false }),
    ];
    const result = buildFieldsPayload(company, mappings, {
      ownerIdToEmail: new Map(),
      nonClearableFieldIds: new Set(['owner']),
    });
    expect(result['owner']).toBeUndefined();
  });
});

describe('stripNullFieldValues', () => {
  it('removes null values for create payloads', () => {
    expect(stripNullFieldValues({ name: 'Acme', empty: null })).toEqual({ name: 'Acme' });
  });
});

describe('buildPatchOperations', () => {
  it('turns values into set ops and nulls into clear ops', () => {
    expect(buildPatchOperations({ name: 'Acme', industry: null })).toEqual([
      { op: 'set', path: 'name', value: 'Acme' },
      { op: 'clear', path: 'industry' },
    ]);
  });

  it('does not clear non-clearable fields', () => {
    expect(buildPatchOperations(
      { industry: null, description: null },
      new Set(['industry'])
    )).toEqual([{ op: 'clear', path: 'description' }]);
  });
});
