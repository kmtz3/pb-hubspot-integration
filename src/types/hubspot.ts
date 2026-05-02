export interface HubSpotCompany {
  id: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

// HubSpot deals — Phase 2 wires the fetch path; Phase 1 just scaffolds the
// types so the engine dispatcher and dedup stubs compile.
export interface HubSpotDeal {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

export interface HubSpotStage {
  id: string;
  label: string;
  displayOrder: number;
  metadata?: { probability?: number };
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: HubSpotStage[];
}

// Per-deal company associations as returned by /crm/associations/v4 batch
// reads. `primary` is the HS company id flagged as the deal's primary
// association (label = `deal_to_company_primary`); `all` is every associated
// company id including the primary.
export interface DealCompanyAssociations {
  primary?: string;
  all: string[];
}

export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  options?: Array<{ label: string; value: string }>;
}

export interface HubSpotFilter {
  propertyName: string;
  operator:
    | 'EQ' | 'NEQ'
    | 'LT' | 'LTE' | 'GT' | 'GTE'
    | 'BETWEEN'
    | 'IN' | 'NOT_IN'
    | 'HAS_PROPERTY' | 'NOT_HAS_PROPERTY'
    | 'CONTAINS_TOKEN' | 'NOT_CONTAINS_TOKEN';
  value?: string;
  values?: string[];
  highValue?: string;
}

export interface HubSpotFilterGroup {
  filters: HubSpotFilter[];
}

export interface HubSpotSearchPayload {
  filterGroups: HubSpotFilterGroup[];
  properties: string[];
  limit: number;
  after?: number;
}
