import type {
  PBEntity,
  PBCreateEntityPayload,
  PBUpdateEntityPayload,
  PBFieldValueDefinition,
  PBEntityConfiguration,
  PBEntityConfigurationField,
  PBField,
} from '../types/productboard';
import { getSecret } from '../lib/secrets';
import { getPBConfig } from '../lib/firestore';
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

// Workspace member directory used to validate `member`/`multimember` writes.
// Returns a Set of lowercased emails so the mapper can skip rows whose source
// email isn't a real PB workspace member (avoids "user not found" write
// failures). Mirrors PBToolkit's pattern (src/routes/users.js): fetch
// /v2/members once, project to fields.email, lowercase, dedupe.
export async function listMemberEmails(
  opts: { includeDisabled?: boolean; includeInvited?: boolean } = {}
): Promise<Set<string>> {
  const { includeDisabled = false, includeInvited = false } = opts;
  type Member = { fields?: { email?: string } };
  type Page = { data: Member[]; links?: { next?: string | null } };
  const emails = new Set<string>();
  let nextUrl: string | null = `/v2/members?includeDisabled=${includeDisabled}&includeInvited=${includeInvited}`;

  while (nextUrl) {
    const page: Page = await withRetry(() => pbRequest<Page>(nextUrl!));
    for (const m of page.data ?? []) {
      const e = m.fields?.email?.toLowerCase();
      if (e) emails.add(e);
    }
    nextUrl = page.links?.next ?? null;
  }

  return emails;
}

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
