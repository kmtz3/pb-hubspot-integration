import type { HubSpotCompany, HubSpotProperty } from '../../src/types/hubspot';
import type { PBEntity } from '../../src/types/productboard';
import type { FieldMapping, SyncConfig, SyncRun } from '../../src/types/sync';

export function makeHubSpotCompany(overrides: Partial<HubSpotCompany> = {}): HubSpotCompany {
  return {
    id: 'hs-company-001',
    properties: {
      name: 'Acme Corp',
      domain: 'acme.com',
      industry: 'SOFTWARE',
      annualrevenue: '450000',
      numberofemployees: '150',
      lifecyclestage: 'customer',
      hs_lastmodifieddate: '1746748800000',
      ...overrides.properties,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

export function makePBEntity(overrides: Partial<PBEntity> = {}): PBEntity {
  return {
    id: 'pb-entity-uuid-001',
    type: 'company',
    fields: {
      name: 'Acme Corp',
      domain: 'acme.com',
    },
    metadata: {
      source: {
        system: 'hubspot',
        recordId: 'hs-company-001',
        url: 'https://app.hubspot.com/contacts/12345/company/hs-company-001',
      },
    },
    ...overrides,
  };
}

export function makeFieldMapping(overrides: Partial<FieldMapping> = {}): FieldMapping {
  return {
    hubspotProperty: 'annualrevenue',
    pbFieldId: 'custom_arr',
    pbFieldType: 'number',
    enabled: true,
    locked: false,
    ...overrides,
  };
}

export function makeSyncConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    schedule: 'daily',
    scheduleTime: '02:00',
    timezone: 'America/New_York',
    domainFallbackEnabled: true,
    inProgress: false,
    ...overrides,
  };
}

export function makeHubSpotProperty(overrides: Partial<HubSpotProperty> = {}): HubSpotProperty {
  return {
    name: 'annualrevenue',
    label: 'Annual revenue',
    type: 'number',
    fieldType: 'number',
    ...overrides,
  };
}

export function makeSyncRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 'run-001',
    startedAt: '2026-05-01T02:00:00Z',
    finishedAt: '2026-05-01T02:03:42Z',
    trigger: 'ui',
    status: 'success',
    stats: { fetched: 10, created: 2, updated: 7, skipped: 1, errors: 0 },
    errors: [],
    ...overrides,
  };
}
