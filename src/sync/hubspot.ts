import type { DealCompanyAssociations, HubSpotCompany, HubSpotDeal, HubSpotFilter, HubSpotFilterGroup, HubSpotPipeline, HubSpotProperty, HubSpotSearchPayload } from '../types/hubspot';
import { getSecret } from '../lib/secrets';
import { getHubSpotConfig } from '../lib/firestore';
import { withRetry, type ApiResponse } from './rateLimit';
import type { ScopeCheck } from '../types/sync';

const BASE = 'https://api.hubapi.com';
const BACKOFF_PAUSE_MS = 200;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Token resolution order:
//   1. HUBSPOT_API_KEY env var — ops escape hatch in any environment.
//   2. tokenSecretName on the Firestore connection doc (production: a Secret
//      Manager resource name; dev: the literal token, since writeSecret
//      short-circuits when NODE_ENV !== 'production').
// Anything else means "no token configured" — surface that explicitly so the
// route handler returns 500 instead of sending the literal string
// "HUBSPOT_API_KEY" as a Bearer token (which is what the old code did).
export async function getHubSpotToken(): Promise<string> {
  if (process.env.HUBSPOT_API_KEY) return process.env.HUBSPOT_API_KEY;
  const config = await getHubSpotConfig();
  if (config.tokenSecretName) return getSecret(config.tokenSecretName);
  throw new Error('HubSpot is not connected — configure a token in the Connect tab.');
}

async function hsRequest<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const token = await getHubSpotToken();
  const res = await fetch(`${BASE}${path}`, {
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

export async function fetchCompanies(options: {
  filterGroups?: HubSpotFilterGroup[];
  properties?: string[];
  lastSyncAt?: string;
} = {}): Promise<HubSpotCompany[]> {
  const {
    filterGroups = [],
    properties = ['name', 'domain', 'hs_lastmodifieddate'],
    lastSyncAt,
  } = options;

  // HubSpot CRM Search v3 semantics: filterGroups OR each other; filters
  // within a group AND. To express `(account filter) AND (recently modified)`,
  // the incremental constraint must be appended to *every* user group, not
  // pushed as a new group (which would OR it onto the user's filter and pull
  // in modified-but-out-of-scope records). With no user groups, fall back to
  // the incremental constraint as the single group.
  const incremental: HubSpotFilter | null = lastSyncAt
    ? {
        propertyName: 'hs_lastmodifieddate',
        operator: 'GT',
        value: String(new Date(lastSyncAt).getTime()),
      }
    : null;

  const effectiveFilterGroups: HubSpotFilterGroup[] = (() => {
    if (filterGroups.length === 0) {
      return incremental ? [{ filters: [incremental] }] : [];
    }
    if (!incremental) return filterGroups;
    return filterGroups.map(g => ({ filters: [...g.filters, incremental] }));
  })();

  const companies: HubSpotCompany[] = [];
  let cursor: number | undefined;

  do {
    const payload: HubSpotSearchPayload = {
      filterGroups: effectiveFilterGroups,
      properties,
      limit: 100,
      ...(cursor !== undefined ? { after: cursor } : {}),
    };

    const pageData = await withRetry(() =>
      hsRequest<{ results: HubSpotCompany[]; paging?: { next?: { after: number } } }>(
        '/crm/v3/objects/companies/search',
        { method: 'POST', body: JSON.stringify(payload) }
      )
    );

    companies.push(...pageData.results);
    cursor = pageData.paging?.next?.after;
  } while (cursor !== undefined);

  return companies;
}

export async function fetchProperties(): Promise<HubSpotProperty[]> {
  const data = await withRetry(() =>
    hsRequest<{ results: HubSpotProperty[] }>('/crm/v3/properties/company')
  );
  return data.results;
}

// HubSpot owner directory used to resolve `hubspot_owner_id` (owner.id) and
// `hs_user_ids_of_all_owners` (owner.userId) values into emails for sync to
// PB member / multi-member / text fields. Returns BOTH maps from a single
// paginated walk over /crm/v3/owners. Requires the `crm.objects.owners.read`
// scope on the HS token; throws on auth failure so the caller can fall back
// to skipping owner-id mappings rather than failing the whole sync.
export async function fetchOwnerEmailMaps(): Promise<{
  ownerIdToEmail: Map<string, string>;
  userIdToEmail: Map<string, string>;
}> {
  type Owner = { id?: string; email?: string; userId?: number | string };
  type Page = { results: Owner[]; paging?: { next?: { after?: string } } };
  const ownerIdToEmail = new Map<string, string>();
  const userIdToEmail = new Map<string, string>();
  let after: string | undefined;

  do {
    const path: string = after
      ? `/crm/v3/owners?limit=100&after=${encodeURIComponent(after)}`
      : '/crm/v3/owners?limit=100';
    const page: Page = await withRetry(() => hsRequest<Page>(path));
    for (const o of page.results ?? []) {
      const email = o.email?.toLowerCase();
      if (!email) continue;
      if (o.id) ownerIdToEmail.set(String(o.id), email);
      if (o.userId !== undefined && o.userId !== null) userIdToEmail.set(String(o.userId), email);
    }
    after = page.paging?.next?.after;
  } while (after);

  return { ownerIdToEmail, userIdToEmail };
}

export async function getAccountInfo(token: string): Promise<{ portalId: string; hubName: string | null }> {
  const res = await fetch(`${BASE}/account-info/v3/details`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HubSpot account info failed: ${res.status}`);
  // HubSpot's account-info API does not expose a portal/hub name — portalId is the only identifier.
  // The 2025-09 versioned endpoint is checked here in case a name field is added in future.
  const data = await res.json() as { portalId: number | string; name?: string; hubName?: string; companyName?: string };
  const hubName = data.name ?? data.hubName ?? data.companyName ?? null;
  return { portalId: String(data.portalId), hubName };
}

// HubSpot scope probes: each scope is verified by calling the canonical
// endpoint it gates. 200 → granted; 403 (or `category: MISSING_SCOPES`) →
// absent; other failure modes are reported with the status so the UI can
// distinguish "missing scope" from "couldn't verify". Probes use limit=1
// where supported to keep the check cheap.
//
// D26: probes carry a `group` so the Connect tab can render two sections —
// "Required for Companies" (required=true, group='companies') and
// "Required for Deals (optional)" (required=false, group='deals'). A failed
// deals-group probe is displayed with muted styling so companies-only
// customers don't perceive the integration as broken.
const SCOPE_PROBES: Array<{
  scope: string;
  probe: string;
  required: boolean;
  description: string;
  group: 'companies' | 'deals';
}> = [
  {
    scope: 'crm.objects.companies.read',
    probe: '/crm/v3/objects/companies?limit=1',
    required: true,
    group: 'companies',
    description: 'Read HubSpot company records (core sync source)',
  },
  {
    scope: 'crm.schemas.companies.read',
    probe: '/crm/v3/properties/company',
    required: true,
    group: 'companies',
    description: 'Read company property metadata for field mapping',
  },
  {
    scope: 'crm.objects.owners.read',
    probe: '/crm/v3/owners?limit=1',
    required: true,
    group: 'companies',
    description: 'Resolve owner IDs to emails for PB member field mappings',
  },
  {
    scope: 'crm.objects.deals.read',
    probe: '/crm/v3/objects/deals?limit=1',
    required: false,
    group: 'deals',
    description: 'Read HubSpot deal records (required for Deals sync)',
  },
  {
    scope: 'crm.schemas.deals.read',
    probe: '/crm/v3/properties/deals?limit=1',
    required: false,
    group: 'deals',
    description: 'Read deal property metadata for field mapping',
  },
];

export async function checkScopes(token: string): Promise<ScopeCheck[]> {
  const probe = async (s: typeof SCOPE_PROBES[number]): Promise<ScopeCheck> => {
    try {
      const res = await fetch(`${BASE}${s.probe}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        return { scope: s.scope, granted: true, required: s.required, group: s.group, description: s.description };
      }
      const body = await res.json().catch(() => null) as { category?: string; message?: string } | null;
      const isMissingScope = res.status === 403 || body?.category === 'MISSING_SCOPES';
      return {
        scope: s.scope,
        granted: false,
        required: s.required,
        group: s.group,
        description: s.description,
        error: isMissingScope ? 'Scope not granted' : `${res.status} ${body?.message ?? ''}`.trim(),
      };
    } catch (e) {
      return {
        scope: s.scope,
        granted: false,
        required: s.required,
        group: s.group,
        description: s.description,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };
  return Promise.all(SCOPE_PROBES.map(probe));
}

// ── Deals ────────────────────────────────────────────────────────────────────

export async function fetchDealProperties(): Promise<HubSpotProperty[]> {
  const data = await withRetry(() =>
    hsRequest<{ results: HubSpotProperty[] }>('/crm/v3/properties/deals')
  );
  return data.results;
}

export async function fetchDealPipelines(): Promise<HubSpotPipeline[]> {
  const data = await withRetry(() =>
    hsRequest<{ results: HubSpotPipeline[] }>('/crm/v3/pipelines/deals')
  );
  return data.results;
}

// Fetches deals matching the given filter groups, pipeline, and optional
// stage constraints. Mirrors the incremental/backfill semantics of
// fetchCompanies — mandatory filters (pipeline, stage) are ANDed into every
// user group; the window filter is appended the same way.
export async function fetchDeals(opts: {
  filterGroups?: HubSpotFilterGroup[];
  pipelineId: string;
  stageIds?: string[];
  properties?: string[];
  lastSyncAt?: number | null;
  windowFrom?: number | null;
  windowTo?: number | null;
  windowField?: 'hs_lastmodifieddate' | 'createdate';
}): Promise<HubSpotDeal[]> {
  const {
    filterGroups = [],
    pipelineId,
    stageIds,
    properties = ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate', 'hubspot_owner_id', 'hs_lastmodifieddate', 'createdate', 'description'],
    lastSyncAt,
    windowFrom,
    windowTo,
    windowField = 'hs_lastmodifieddate',
  } = opts;

  const mandatoryFilters: HubSpotFilter[] = [
    { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
    ...(stageIds && stageIds.length > 0
      ? [{ propertyName: 'dealstage', operator: 'IN' as const, values: stageIds }]
      : []),
  ];

  // Backfill window (D21) takes priority; fall back to incremental lastSyncAt.
  const windowFilter: HubSpotFilter | null = (() => {
    if (windowFrom != null && windowTo != null) {
      return { propertyName: windowField, operator: 'BETWEEN', value: String(windowFrom), highValue: String(windowTo) };
    }
    if (lastSyncAt != null) {
      return { propertyName: 'hs_lastmodifieddate', operator: 'GT', value: String(lastSyncAt) };
    }
    return null;
  })();

  // AND-compose mandatory + window filters into each user group. Same pattern
  // as fetchCompanies so OR semantics between groups are preserved.
  const baseGroups = filterGroups.length > 0 ? filterGroups : [{ filters: [] }];
  const effectiveFilterGroups: HubSpotFilterGroup[] = baseGroups.map(g => ({
    filters: [
      ...mandatoryFilters,
      ...g.filters,
      ...(windowFilter ? [windowFilter] : []),
    ],
  }));

  const deals: HubSpotDeal[] = [];
  let cursor: number | undefined;

  do {
    const payload = {
      filterGroups: effectiveFilterGroups,
      properties,
      limit: 100,
      ...(cursor !== undefined ? { after: cursor } : {}),
    };

    const pageData = await withRetry(() =>
      hsRequest<{ results: HubSpotDeal[]; paging?: { next?: { after: number } } }>(
        '/crm/v3/objects/deals/search',
        { method: 'POST', body: JSON.stringify(payload) }
      )
    );

    deals.push(...pageData.results);
    cursor = pageData.paging?.next?.after;
  } while (cursor !== undefined);

  return deals;
}

// Fetches company associations for a list of deal IDs using the HubSpot
// associations v4 batch endpoint. Chunks to 1000 IDs per request (HS limit).
// A deal is marked "primary" when one of its association types carries the
// label 'deal_to_company_primary'.
export async function fetchDealAssociations(
  dealIds: string[]
): Promise<Map<string, DealCompanyAssociations>> {
  type AssocType = { category: string; typeId: number; label?: string };
  type ToItem = { toObjectId: string; associationTypes: AssocType[] };
  type ResultItem = { from: { id: string }; to: ToItem[] };
  type BatchResponse = { results: ResultItem[] };

  const result = new Map<string, DealCompanyAssociations>();

  // Chunk at 1000 per HS batch limit
  for (let i = 0; i < dealIds.length; i += 1000) {
    const chunk = dealIds.slice(i, i + 1000);
    const response = await withRetry(() =>
      hsRequest<BatchResponse>(
        '/crm/associations/2026-03/deal/company/batch/read',
        {
          method: 'POST',
          body: JSON.stringify({ inputs: chunk.map(id => ({ id })) }),
        }
      )
    );

    for (const item of response.results ?? []) {
      const all: string[] = [];
      let primary: string | undefined;
      for (const to of item.to ?? []) {
        const companyId = String(to.toObjectId);
        all.push(companyId);
        if (to.associationTypes.some(t => t.label === 'deal_to_company_primary')) {
          primary = companyId;
        }
      }
      result.set(item.from.id, { primary, all });
    }
  }

  // Deals with no associations are omitted from the batch response; seed them
  // with an empty record so callers always find an entry.
  for (const id of dealIds) {
    if (!result.has(id)) result.set(id, { all: [] });
  }

  return result;
}
