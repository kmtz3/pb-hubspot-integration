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

// ── Notes (Phase 1 scaffold; CRUD lands in Phase 3) ──────────────────────────
//
// Deals sync as `textNote` records (D1 — `opportunityNote` cannot be created
// via the public API). Each note carries a `metadata.source.recordId` like
// `deal-<dealId>` or `deal-<dealId>::company-<companyId>` for the multi-
// company toggle (D6). The `::` separator is verified-safe in PB recordId
// roundtrip (live-tested 2026-05-02).

export interface ProductboardNote {
  id: string;
  fields: {
    name?: string;
    content?: string;
    tags?: ProductboardTagRef[];
    owner?: { email: string } | null;
    archived?: boolean;
    [key: string]: unknown;
  };
  metadata: {
    source?: {
      system: string;
      recordId: string;
      url?: string;
    };
  };
  // Relationships are NOT returned on the note resource itself; fetch them via
  // `GET /v2/notes/{id}/relationships` (D13 / live-tested constraint). Phase 4
  // populates this client-side when the engine needs the link list.
  relationships?: ProductboardNoteRelationship[];
}

// Note relationships are read/written via dedicated endpoints
// (`/v2/notes/{id}/relationships`). PATCH on the note itself does NOT accept
// relationship changes. GET responses use `target.type: 'product' | 'feature'`;
// POST writes require `target.type: 'link'` (read/write divergence — capture
// from GET, write back as `'link'`). No stable `id` field on responses;
// identity is `(target.type, target.id)`.
export interface ProductboardNoteRelationship {
  type: string;
  target: {
    id: string;
    type: string;
  };
}

// Productboard tags are select-validated in this workspace (D2). Tags missing
// at note-write time must be auto-provisioned via a list-first POST flow
// (mirrors `feedback_pb_value_dedup.md` — never trust POST idempotency).
export interface ProductboardTag {
  id: string;
  name: string;
}

// The ref shape PB returns inside a note's `fields.tags`. Distinct from
// `ProductboardTag` because list/create endpoints return a top-level shape;
// the note shape nests the same id+name without other tag metadata.
export interface ProductboardTagRef {
  id?: string;
  name: string;
}

// PB workspace member shape returned by GET /v2/members. Kept narrow — only
// the fields the sync flow actually reads (owner-skip detection in the deal
// note builder, owner gating in the company mapper). Live-tested 2026-05-03
// against `excellence-kmtz-1`.
export interface PBMember {
  id: string;
  email: string;       // lowercased before being stored
  name?: string;
  role: string;
  disabled: boolean;
  invitationPending: boolean;
}

// POST /v2/notes body shape for textNote. Mirrors the existing
// PBCreateEntityPayload pattern — wraps everything under `data`. Relationships
// are optional and set atomically at create time (a customer link to the deal's
// PB company; further `link`-type relationships are added via the dedicated
// /relationships endpoint later if needed).
export interface CreateNotePayload {
  data: {
    type: 'textNote';
    fields: {
      name: string;
      content?: string;
      tags?: ProductboardTagRef[];
      owner?: { email: string };
    };
    metadata: {
      source: {
        system: string;
        recordId: string;
        url?: string;
      };
    };
    relationships?: Array<{
      type: 'customer' | 'link';
      target: { id: string; type: 'user' | 'company' | 'link' };
    }>;
  };
}

// PATCH /v2/notes/{id} body shape. PB accepts either a `fields` replace or a
// granular `patch` array (set / clear / addItems / removeItems). The note
// PATCH endpoint does NOT accept `relationships` — those go through the
// dedicated /relationships routes (live-tested constraint).
export type NotePatchOp =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'clear'; path: string }
  | { op: 'addItems'; path: string; value: unknown[] }
  | { op: 'removeItems'; path: string; value: unknown[] };

export interface NotePatch {
  data: {
    fields?: Partial<CreateNotePayload['data']['fields']> & { archived?: boolean };
    patch?: NotePatchOp[];
  };
}
