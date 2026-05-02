export type PBFieldType =
  | 'text'
  | 'richtext'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'boolean'
  // Member fields require a user identity (email → UUID) at write time and
  // can't be populated from a free-form HS string; we surface them so the UI
  // can label and gate them, but they aren't valid sync targets yet.
  | 'member'
  | 'multimember';

export type PBFieldValue =
  | string
  | number
  | boolean
  | { name: string }
  | { email: string }
  | Array<{ name: string }>
  | Array<{ email: string }>
  | null;

export interface PBFieldValueDefinition {
  id: string;
  fields: {
    name: string;
    color: string;
  };
}

export type PBFieldValuesCache = Map<string, Map<string, string>>;

export interface JSONSchema {
  type?: string;
  format?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  [key: string]: unknown;
}

export interface PBEntity {
  id: string;
  type: string;
  fields: Record<string, PBFieldValue>;
  metadata: {
    source?: {
      system: string;
      recordId: string;
      url?: string;
    };
  };
}

export interface PBCreateEntityPayload {
  data: {
    type: 'company';
    fields: Record<string, PBFieldValue>;
    metadata: {
      source: {
        system: string;
        recordId: string;
        url?: string;
      };
    };
  };
}

export interface PBUpdateEntityPayload {
  data: {
    fields?: Record<string, PBFieldValue>;
    patch?: Array<{
      op: 'set' | 'clear' | 'addItems' | 'removeItems';
      path: string;
      value?: Exclude<PBFieldValue, null>;
    }>;
    metadata?: {
      source: {
        system: string;
        recordId: string;
        url?: string;
      };
    };
  };
}

export interface PBFieldConstraints {
  maxLength?: number;
  minLength?: number;
  notBlank?: boolean;
  required?: boolean;
  minimum?: number;
  maximum?: number;
  maxScale?: number;
}

// Raw shape of GET /v2/entities/configurations?type[]=company — `fields` is a
// Record keyed by fieldId (e.g. "name", "domain", or a UUID), not an array.
// Each value carries id, name, path, schema, lifecycle, constraints, links.
export interface PBEntityConfigurationField {
  id: string;
  name: string;
  schema: JSONSchema;
  path?: string;
  lifecycle?: unknown;
  constraints?: PBFieldConstraints;
  links?: unknown;
}

export interface PBEntityConfiguration {
  type: string;
  fields: Record<string, PBEntityConfigurationField>;
}

// Flat shape we expose to the UI (and cache in Firestore).
export interface PBField {
  id: string;
  name: string;
  type: PBFieldType | null;
  schema: JSONSchema;
  constraints?: PBFieldConstraints;
}
