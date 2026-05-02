import { buildCompanyMaps, findExistingEntity } from '../../src/sync/dedup';
import { makeHubSpotCompany, makePBEntity, makeSyncConfig } from '../helpers/factories';

describe('buildCompanyMaps', () => {
  it('indexes companies by metadata.source.recordId when system is hubspot', () => {
    const maps = buildCompanyMaps([
      makePBEntity({
        id: 'pb-001',
        metadata: { source: { system: 'hubspot', recordId: 'hs-001' } },
      }),
    ]);
    expect(maps.byRecordId.get('hs-001')).toBe('pb-001');
  });

  it('skips entities whose source system is not hubspot', () => {
    const maps = buildCompanyMaps([
      makePBEntity({
        id: 'pb-001',
        metadata: { source: { system: 'salesforce', recordId: 'sf-001' } },
      }),
    ]);
    expect(maps.byRecordId.size).toBe(0);
  });

  it('indexes companies by lower-cased domain', () => {
    const maps = buildCompanyMaps([
      makePBEntity({ id: 'pb-001', fields: { name: 'Acme', domain: 'Acme.COM' } }),
    ]);
    expect(maps.byDomain.get('acme.com')).toBe('pb-001');
  });

  it('keeps the first match when two companies share a domain', () => {
    const maps = buildCompanyMaps([
      makePBEntity({ id: 'pb-first',  fields: { name: 'A', domain: 'shared.com' } }),
      makePBEntity({ id: 'pb-second', fields: { name: 'B', domain: 'shared.com' } }),
    ]);
    expect(maps.byDomain.get('shared.com')).toBe('pb-first');
  });

  it('defensively skips entities whose type is not company', () => {
    const maps = buildCompanyMaps([
      makePBEntity({
        id: 'pb-sub-001',
        type: 'subfeature',
        metadata: { source: { system: 'hubspot', recordId: 'hs-leak' } },
      }),
    ]);
    expect(maps.byRecordId.size).toBe(0);
    expect(maps.byDomain.size).toBe(0);
  });
});

describe('findExistingEntity — primary path', () => {
  it('returns pbId when recordId is in the map', () => {
    const maps = buildCompanyMaps([
      makePBEntity({ id: 'pb-001', metadata: { source: { system: 'hubspot', recordId: 'hs-company-001' } } }),
    ]);
    const result = findExistingEntity(makeHubSpotCompany(), makeSyncConfig(), maps);
    expect(result).toEqual({ pbId: 'pb-001', resolvedViaFallback: false });
  });
});

describe('findExistingEntity — domain fallback', () => {
  it('falls back to domain when recordId misses', () => {
    const maps = buildCompanyMaps([
      makePBEntity({ id: 'pb-domain-001', fields: { name: 'Acme', domain: 'acme.com' }, metadata: { source: undefined } as any }),
    ]);
    const result = findExistingEntity(
      makeHubSpotCompany(),
      makeSyncConfig({ domainFallbackEnabled: true }),
      maps
    );
    expect(result).toEqual({ pbId: 'pb-domain-001', resolvedViaFallback: true });
  });

  it('returns null when fallback is disabled and recordId misses', () => {
    const maps = buildCompanyMaps([
      makePBEntity({ id: 'pb-domain-001', fields: { name: 'Acme', domain: 'acme.com' }, metadata: { source: undefined } as any }),
    ]);
    const result = findExistingEntity(
      makeHubSpotCompany(),
      makeSyncConfig({ domainFallbackEnabled: false }),
      maps
    );
    expect(result).toBeNull();
  });

  it('returns null when domain is empty and fallback is enabled', () => {
    const maps = buildCompanyMaps([
      makePBEntity({ id: 'pb-domain-001', fields: { name: 'Acme', domain: 'acme.com' }, metadata: { source: undefined } as any }),
    ]);
    const company = makeHubSpotCompany({ properties: { name: 'Acme', domain: '' } });
    const result = findExistingEntity(
      company,
      makeSyncConfig({ domainFallbackEnabled: true }),
      maps
    );
    expect(result).toBeNull();
  });

  it('returns null when both lookups miss', () => {
    const maps = buildCompanyMaps([
      makePBEntity({ id: 'pb-other', fields: { name: 'Other', domain: 'other.com' }, metadata: { source: undefined } as any }),
    ]);
    const result = findExistingEntity(
      makeHubSpotCompany(),
      makeSyncConfig({ domainFallbackEnabled: true }),
      maps
    );
    expect(result).toBeNull();
  });

  it('matches the HS domain case-insensitively', () => {
    const maps = buildCompanyMaps([
      makePBEntity({ id: 'pb-domain-001', fields: { name: 'Acme', domain: 'acme.com' }, metadata: { source: undefined } as any }),
    ]);
    const company = makeHubSpotCompany({ properties: { name: 'Acme', domain: 'ACME.com' } });
    const result = findExistingEntity(company, makeSyncConfig({ domainFallbackEnabled: true }), maps);
    expect(result).toEqual({ pbId: 'pb-domain-001', resolvedViaFallback: true });
  });
});
