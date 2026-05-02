export interface HubSpotCompany {
  id: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
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
