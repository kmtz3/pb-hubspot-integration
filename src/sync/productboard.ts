import type {
  PBEntity,
  PBCreateEntityPayload,
  PBUpdateEntityPayload,
  PBFieldValueDefinition,
  PBEntityConfiguration,
  PBEntityConfigurationField,
  PBField,
  PBMember,
  ProductboardNote,
  ProductboardNoteRelationship,
  ProductboardTag,
  CreateNotePayload,
  NotePatch,
} from '../types/productboard';
import { getSecret } from '../lib/secrets';
import { getPBConfig } from '../lib/firestore';
import { memoizeWithTtl } from '../lib/processCache';
import type { ScopeCheck } from '../types/sync';
import { withRetry, parsePBHeaders, shouldBackOffPB, type ApiResponse } from './rateLimit';
import { schemaToToken } from './mapper';

const BASE = 'https://api.productboard.com';
const BACKOFF_PAUSE_MS = 200;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Mirrors getHubSpotToken — env var override, then Firestore-stored secret
// resource name. See hubspot.ts for the rationale.
export async function getPBToken(): Promise<string> {
  if (process.env.PB_API_KEY) return process.env.PB_API_KEY;
  const config = await getPBConfig();
  if (config.tokenSecretName) return getSecret(config.tokenSecretName);
  throw new Error('Productboard is not connected — configure a token in the Connect tab.');
}

// Accepts either a path (`/v2/...`) or an absolute URL — PB v2 cursor
// pagination returns `links.next` as a full URL, and PBToolkit's pattern is
// to follow it verbatim rather than extracting a cursor token. Passing the
// next URL through `encodeURIComponent` as a `pageCursor` value is rejected
// by PB with "The pagination cursor format is invalid".
async function pbRequest<T>(pathOrUrl: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const token = await getPBToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    },
  });
  const data = await res.json().catch(() => null) as T;
  return { status: res.status, headers: res.headers as unknown as Headers, data };
}

// Paginated walk of every company in the workspace. Used to build the dedup
// maps client-side (recordId → pbId, domain → pbId) at sync start.
//
// TODO(pb): when PB delivers `filter.metadata.source.recordId` on
// `/v2/entities/search` (currently flagged "not yet active" in the v2 docs and
// silently ignored by the live API), replace the `byRecordId` map lookup in
// `dedup.ts` with a per-record search to skip this full-walk cost.
export async function listCompanies(): Promise<PBEntity[]> {
  type Page = { data: PBEntity[]; links?: { next?: string | null } };
  const all: PBEntity[] = [];
  let nextUrl: string | null = '/v2/entities?type[]=company';

  while (nextUrl) {
    const page: Page = await withRetry(() => pbRequest<Page>(nextUrl!));
    all.push(...(page.data ?? []));
    nextUrl = page.links?.next ?? null;
  }

  return all;
}

export async function createEntity(payload: PBCreateEntityPayload): Promise<PBEntity> {
  const data = await withRetry(() =>
    pbRequest<{ data: PBEntity }>('/v2/entities', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  );
  return data.data;
}

export async function updateEntity(pbId: string, payload: PBUpdateEntityPayload): Promise<void> {
  await withRetry(() =>
    pbRequest<unknown>(`/v2/entities/${pbId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
  );
}

export async function listFieldValues(fieldId: string): Promise<PBFieldValueDefinition[]> {
  type PageResponse = { data: PBFieldValueDefinition[]; links: { next: string | null } };
  const all: PBFieldValueDefinition[] = [];
  let nextUrl: string | null = `/v2/entities/fields/${fieldId}/values`;

  while (nextUrl) {
    const page: PageResponse = await withRetry(() => pbRequest<PageResponse>(nextUrl!));
    all.push(...page.data);
    nextUrl = page.links?.next ?? null;
  }

  return all;
}

export async function createFieldValue(
  fieldId: string,
  name: string,
  isStatusField = false
): Promise<{ id: string }> {
  if (isStatusField) {
    console.debug(`createFieldValue: skipping STATUS field ${fieldId}`);
    return { id: '' };
  }

  const data = await withRetry(() =>
    pbRequest<{ data: { id: string } }>(`/v2/entities/fields/${fieldId}/values`, {
      method: 'POST',
      body: JSON.stringify({ data: { fields: { name } } }),
    })
  );
  return { id: data.data.id };
}

// PB system fields that we never sync from HubSpot — they're managed by PB
// itself (archive state) or derived (notes-count is a count of notes attached
// to the company, surfaced as `name: "Notes"` with a number schema and
// erroneously-writeable lifecycle flags) — surfacing them in the dropdown is
// just noise.
const EXCLUDED_PB_FIELD_IDS = new Set(['archived', 'notes-count']);

// Threshold for treating a `type: 'string'` field as rich-text. PB's
// configurations endpoint does NOT expose a type token (text vs rich_text),
// so we infer from constraints.maxLength: plain-text customs cap at 2000,
// while every rich-text field — including the standard `description` and
// `specification` — caps in the hundreds of thousands (PB OpenAPI documents
// `RichTextFieldValue.maxLength = 524288`; live API often returns 1048576).
const RICH_TEXT_MAX_LENGTH_THRESHOLD = 100_000;

function isRichTextField(def: PBEntityConfigurationField): boolean {
  if (def.schema?.type !== 'string') return false;
  if (def.schema.format === 'richtext' || def.schema.format === 'rich-text') return true;
  if ('contentMediaType' in def.schema) return true;
  const maxLength = def.constraints?.maxLength;
  return typeof maxLength === 'number' && maxLength >= RICH_TEXT_MAX_LENGTH_THRESHOLD;
}

// Workspace member directory (D20) — used to gate `member`/`multimember`
// writes for companies AND owner-skip detection for deal notes (Phase 4).
// Single source of truth across both flows so we never disagree on "is this
// email a real PB workspace member".
//
// Defaults to `disabled=false&invitationPending=false` — pending invites and
// disabled accounts are NOT assignable owners, so we exclude them up-front
// rather than finding out at write time. PII note: real emails are returned
// only when the token has the `members:pii:read` scope; without it, every
// `email` field comes back as `[redacted]`. `buildPbMemberEmailSet` filters
// those defensively so a misconfigured token doesn't silently classify every
// HS owner as "not a workspace member".
//
// Mirrors PBToolkit's pattern (src/routes/users.js): fetchAllPages('/v2/members').
export async function listPbMembers(
  opts: { includeDisabled?: boolean; includeInvited?: boolean } = {}
): Promise<PBMember[]> {
  const { includeDisabled = false, includeInvited = false } = opts;
  type RawMember = {
    id: string;
    fields?: {
      name?: string;
      username?: string;
      email?: string;
      role?: string;
      disabled?: boolean;
      invitationPending?: boolean;
    };
  };
  type Page = { data: RawMember[]; links?: { next?: string | null } };
  const out: PBMember[] = [];
  let nextUrl: string | null = `/v2/members?includeDisabled=${includeDisabled}&includeInvited=${includeInvited}`;

  while (nextUrl) {
    const page: Page = await withRetry(() => pbRequest<Page>(nextUrl!));
    for (const m of page.data ?? []) {
      const f = m.fields ?? {};
      out.push({
        id: m.id,
        email: (f.email ?? '').toLowerCase(),
        name: f.name,
        role: f.role ?? '',
        disabled: f.disabled ?? false,
        invitationPending: f.invitationPending ?? false,
      });
    }
    nextUrl = page.links?.next ?? null;
  }

  return out;
}

// Convenience projection used by the mapper / deal note builder for O(1)
// "is this email assignable" checks. Drops `[redacted]` entries so a token
// without `members:pii:read` doesn't mask the entire workspace as non-members.
export async function buildPbMemberEmailSet(): Promise<Set<string>> {
  const members = await listPbMembers();
  const emails = new Set<string>();
  for (const m of members) {
    if (!m.email || m.email === '[redacted]') continue;
    emails.add(m.email);
  }
  return emails;
}

// Process-level memoized wrappers (D27). Companies + deals scheduler jobs can
// fire seconds apart on the same warm Cloud Run instance; sharing one fetch
// per 60s window saves a /members round-trip on every overlap. Cold-start
// always fetches; warm hits within the TTL reuse.
const PB_MEMBER_TTL_MS = 60_000;
export const listPbMembersCached = memoizeWithTtl(() => listPbMembers(), PB_MEMBER_TTL_MS);
export const buildPbMemberEmailSetCached = memoizeWithTtl(buildPbMemberEmailSet, PB_MEMBER_TTL_MS);

// Flatten PB's company configuration into a plain field list for the mapping UI.
// PB returns { data: [{ type, fields: { [fieldId]: {id, name, schema, ...} } }] };
// the UI wants Array<{ id, name, type, schema }>.
export async function fetchEntityConfigurations(): Promise<PBField[]> {
  const data = await withRetry(() =>
    pbRequest<{ data: PBEntityConfiguration[] }>('/v2/entities/configurations?type[]=company')
  );
  const configs = data.data ?? [];
  return configs.flatMap(cfg =>
    Object.entries(cfg.fields ?? {})
      .filter(([id]) => !EXCLUDED_PB_FIELD_IDS.has(id))
      .map(([id, def]) => ({
        id,
        name: def.name ?? id,
        // PB exposes no rich-text type token, so we detect via `constraints.maxLength`
        // (≥100k → rich-text). Catches the standard `description`/`specification`
        // and every custom rich-text field, none of which the schema alone reveals.
        type: isRichTextField(def) ? 'richtext' : schemaToToken(def.schema),
        schema: def.schema,
        constraints: def.constraints,
      }))
  );
}

const SCOPE_PROBES = [
  {
    scope: 'Public API',
    probe: '/v2/entities/configurations?type[]=company',
    required: true,
    description: 'Access to Productboard Public API and company metadata',
  },
  {
    scope: 'members.read',
    probe: '/v2/members?limit=1',
    required: true,
    description: 'Resolve workspace members for owner field mapping',
  },
];

async function runProbe(token: string, s: (typeof SCOPE_PROBES)[number]): Promise<ScopeCheck> {
  try {
    const res = await fetch(`${BASE}${s.probe}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) return { scope: s.scope, granted: true, required: s.required, description: s.description };
    const body = await res.json().catch(() => null) as { message?: string } | null;
    return {
      scope: s.scope, granted: false, required: s.required, description: s.description,
      error: body?.message ? `${res.status}: ${body.message}` : `Status ${res.status}`,
    };
  } catch (e) {
    return {
      scope: s.scope, granted: false, required: s.required, description: s.description,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Extract workspace subdomain from links.html on any entity (feature/component/product).
// Pattern: "mycompany.app.productboard.com" → "mycompany"
async function fetchWorkspaceName(token: string): Promise<string | null> {
  for (const type of ['feature', 'component', 'product']) {
    try {
      const res = await fetch(`${BASE}/v2/entities?type[]=${type}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json() as { data?: { links?: { html?: string } }[] };
      const htmlLink = data.data?.[0]?.links?.html;
      if (htmlLink) return new URL(htmlLink).hostname.split('.')[0];
    } catch (_) {}
  }
  return null;
}

export async function checkScopes(token: string): Promise<{ workspaceName: string | null; scopes: ScopeCheck[] }> {
  const [scopes, workspaceName] = await Promise.all([
    Promise.all(SCOPE_PROBES.map(s => runProbe(token, s))),
    fetchWorkspaceName(token),
  ]);
  if (!scopes[0].granted) {
    throw new Error(`Productboard connection failed: ${scopes[0].error ?? 'check your API token'}`);
  }
  return { workspaceName, scopes };
}

// ── Notes (Phase 3 — CRUD + relationships + unassigned placeholder) ──────────
//
// Deals sync as `textNote` records (D1 — `opportunityNote` cannot be created
// via the public API, live-tested 2026-05-02). Each note carries a
// `metadata.source.recordId` like `deal-<dealId>` (single mode) or
// `deal-<dealId>::company-<companyId>` (D6 multi-company mode; `::` is
// roundtrip-safe). Phase 4 wires these into runDealsSync; Phase 3 lands the
// client surface so the engine work has typed, tested calls to lean on.

// Walk every hubspot-source note, paginated. PB's metadata-source filters DO
// honor `metadata[source][system]=hubspot` server-side (live-tested), so we
// never have to fetch the entire workspace and filter client-side. Caller
// receives the union of every recordId — `deal-…` notes (this sync) and
// any other `system=hubspot` notes (e.g. legacy companies-side enrichment).
// Phase 4 is responsible for projecting to a recordId index keyed by deal id.
export async function listHubspotDealNotes(): Promise<ProductboardNote[]> {
  type Page = { data: ProductboardNote[]; links?: { next?: string | null } };
  const all: ProductboardNote[] = [];
  let nextUrl: string | null = '/v2/notes?metadata[source][system]=hubspot';

  while (nextUrl) {
    const page: Page = await withRetry(() => pbRequest<Page>(nextUrl!));
    all.push(...(page.data ?? []));
    nextUrl = page.links?.next ?? null;
  }

  return all;
}

// POST /v2/notes — atomic create with metadata.source + optional customer
// relationship. Wrap any unknown tags via `ensureTagsExist` BEFORE calling
// this so PB doesn't reject the whole note with `selectOption.notFound`
// (live-tested 2026-05-03 — PB does NOT auto-create tag values from a note
// write).
export async function createDealNote(payload: CreateNotePayload): Promise<ProductboardNote> {
  const data = await withRetry(() =>
    pbRequest<{ data: ProductboardNote }>('/v2/notes', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  );
  return data.data;
}

// PATCH /v2/notes/{id} — accepts either `fields` (whole-replace) or `patch`
// (granular set/clear/addItems/removeItems). The note PATCH endpoint does NOT
// accept relationship changes (live-tested constraint); use the dedicated
// `/relationships` endpoints below.
//
// Phase 4 will wrap this in a `patchDealNoteContent` helper that handles the
// 422 `validation.forbidden` content-lock fallback (D13) — Phase 3 just lands
// the bare PATCH surface.
export async function patchDealNote(id: string, patch: NotePatch): Promise<ProductboardNote> {
  const data = await withRetry(() =>
    pbRequest<{ data: ProductboardNote }>(`/v2/notes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  );
  return data.data;
}

// GET /v2/notes/{id}/relationships — lists every relationship on the note
// (customer + link kinds). Used in the force-content-updates path (D13) to
// capture feature links before unlinking, patching, then relinking.
//
// Note the read/write `target.type` divergence: GET responses return
// `target.type: "product" | "feature"`; POST writes require
// `target.type: "link"`. Capture from GET, write back as `"link"`.
// Relationships have no stable id field; identity is `(target.type, target.id)`.
export async function getDealNoteRelationships(id: string): Promise<ProductboardNoteRelationship[]> {
  const data = await withRetry(() =>
    pbRequest<{ data: ProductboardNoteRelationship[] }>(`/v2/notes/${id}/relationships`)
  );
  return data.data ?? [];
}

// DELETE /v2/notes/{noteId}/relationships/link/{targetId} — unlinks a feature
// from a note. Returns 204 on success. Snippet excerpts and importance scores
// are silently destroyed by this call (live-tested constraint) — only invoke
// from the force-content-updates path with explicit user opt-in (D13).
export async function unlinkDealNoteRelationship(noteId: string, targetId: string): Promise<void> {
  await withRetry(() =>
    pbRequest<unknown>(`/v2/notes/${noteId}/relationships/link/${targetId}`, {
      method: 'DELETE',
    })
  );
}

// POST /v2/notes/{noteId}/relationships — re-attaches a feature link after
// the force-content-updates patch. The `target.type` on write is the literal
// string `"link"` regardless of whether the captured GET said "product" or
// "feature" (read/write divergence above).
export async function relinkDealNoteRelationship(noteId: string, targetId: string): Promise<void> {
  await withRetry(() =>
    pbRequest<unknown>(`/v2/notes/${noteId}/relationships`, {
      method: 'POST',
      body: JSON.stringify({
        data: { type: 'link', target: { id: targetId, type: 'link' } },
      }),
    })
  );
}

// PUT /v2/notes/{noteId}/relationships/customer — replaces the note's customer
// relationship in-place. Per the v2 spec, a note can be linked to one customer
// only (a User OR a Company); calling this endpoint on a note that already
// has a customer relationship swaps it. Used by the heal pass (D5) to move
// placeholder-bound deal notes to their resolved PB company once it appears.
//
// Body shape (from openapi v2 public API/notes.yaml):
//   { data: { target: { type: 'user' | 'company', id: '<uuid>' } } }
export async function setDealNoteCustomer(
  noteId: string,
  target: { type: 'user' | 'company'; id: string }
): Promise<void> {
  await withRetry(() =>
    pbRequest<unknown>(`/v2/notes/${noteId}/relationships/customer`, {
      method: 'PUT',
      body: JSON.stringify({ data: { target } }),
    })
  );
}

// Lookup-or-create the placeholder PB company that catches deal notes whose
// HS company hasn't been synced yet (D5). Recordid `unassigned-placeholder`
// is a fixed sentinel; lookup via metadata.source filter, fall back to a
// create on first call.
//
// Tag provisioning works again as of 2026-05-14, so a follow-up could add the
// `hubspot-unassigned` tag to the placeholder via ensureTagsExist + a PATCH.
// Left untouched for now — the placeholder is identified by metadata.source,
// so the tag is cosmetic.
export async function getOrCreateUnassignedCompany(): Promise<{ pbUuid: string }> {
  const RECORD_ID = 'unassigned-placeholder';
  type Page = { data: PBEntity[]; links?: { next?: string | null } };

  // PB rejects metadata[source][recordId] as a GET query param on /v2/entities
  // (HTTP 400 "unexpected"). POST /v2/entities/search accepts it in the body.
  const searchResult = await withRetry(() =>
    pbRequest<Page>('/v2/entities/search', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          filter: {
            type: ['company'],
            metadata: { source: { system: 'hubspot', recordId: RECORD_ID } },
          },
        },
      }),
    })
  );
  const existing = searchResult.data?.[0];
  if (existing) return { pbUuid: existing.id };

  const created = await createEntity({
    data: {
      type: 'company',
      fields: { name: 'Unassigned (HubSpot deals pending company sync)' },
      metadata: { source: { system: 'hubspot', recordId: RECORD_ID } },
    },
  });
  return { pbUuid: created.id };
}

// ── Tag values (D2) ──────────────────────────────────────────────────────────
//
// Tags in PB are a single global multiselect (UUID `5252cefa-690e-58d8-…`)
// shared by note, feature, product, component, and company. Live-tested
// 2026-05-14: `POST /v2/entities/fields/tags/values` with body
// `{data:{fields:{name}}}` returns 201 with `{data:{id}}`. Earlier 500s on
// this endpoint are fixed.
//
//   - listTags() paginates the current tag list (source of truth on first
//     call within a run)
//   - createTag() POSTs the value endpoint and returns the new `{id, name}`
//   - ensureTagsExist() resolves requested names against the cache; misses
//     are auto-provisioned and cached. A creation failure for a single tag
//     drops only that tag (with a warning) — the parent note still lands
//     with the surviving set rather than failing the whole run.
const TAGS_FIELD_ID = 'tags';

export async function listTags(): Promise<ProductboardTag[]> {
  const values = await listFieldValues(TAGS_FIELD_ID);
  return values.map(v => ({ id: v.id, name: v.fields.name }));
}

export async function createTag(name: string): Promise<ProductboardTag> {
  const { id } = await createFieldValue(TAGS_FIELD_ID, name);
  return { id, name };
}

// Returns a `name → ProductboardTag` map. Tags already in the cache are
// reused; missing names are POSTed to `/v2/entities/fields/tags/values` and
// added to the cache. If creation of a specific tag fails, that tag is
// dropped from the result (with a warning) so the parent note write can
// still land with the survivors. The cache is shared across calls within a
// sync run so we paginate at most once and never re-create the same tag.
export async function ensureTagsExist(
  names: string[],
  cache: Map<string, ProductboardTag>
): Promise<Map<string, ProductboardTag>> {
  if (cache.size === 0) {
    const tags = await listTags();
    for (const t of tags) cache.set(t.name, t);
  }

  const out = new Map<string, ProductboardTag>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const cached = cache.get(name);
    if (cached) {
      out.set(name, cached);
      continue;
    }
    try {
      const created = await createTag(name);
      cache.set(name, created);
      out.set(name, created);
    } catch (e) {
      console.warn(
        `ensureTagsExist: failed to auto-provision PB tag "${name}" — dropping from this note write. ` +
        `Underlying error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  return out;
}
