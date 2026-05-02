import type { HubSpotCompany, HubSpotFilterGroup, HubSpotProperty, HubSpotSearchPayload } from '../types/hubspot';
import { getSecret } from '../lib/secrets';
import { withRetry, type ApiResponse } from './rateLimit';

const BASE = 'https://api.hubapi.com';
const BACKOFF_PAUSE_MS = 200;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function getToken(): Promise<string> {
  return getSecret('HUBSPOT_API_KEY');
}

async function hsRequest<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const token = await getToken();
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

  const effectiveFilterGroups: HubSpotFilterGroup[] = [...filterGroups];

  if (lastSyncAt) {
    effectiveFilterGroups.push({
      filters: [{
        propertyName: 'hs_lastmodifieddate',
        operator: 'GT',
        value: String(new Date(lastSyncAt).getTime()),
      }],
    });
  }

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

export interface ScopeCheck {
  scope: string;
  granted: boolean;
  required: boolean;
  description: string;
  error?: string;
}

// HubSpot scope probes: each scope is verified by calling the canonical
// endpoint it gates. 200 → granted; 403 (or `category: MISSING_SCOPES`) →
// absent; other failure modes are reported with the status so the UI can
// distinguish "missing scope" from "couldn't verify". Probes use limit=1
// where supported to keep the check cheap.
const SCOPE_PROBES: Array<{ scope: string; probe: string; required: boolean; description: string }> = [
  {
    scope: 'crm.objects.companies.read',
    probe: '/crm/v3/objects/companies?limit=1',
    required: true,
    description: 'Read HubSpot company records (core sync source)',
  },
  {
    scope: 'crm.schemas.companies.read',
    probe: '/crm/v3/properties/company',
    required: true,
    description: 'Read company property metadata for field mapping',
  },
  {
    scope: 'crm.objects.owners.read',
    probe: '/crm/v3/owners?limit=1',
    required: true,
    description: 'Resolve owner IDs to emails for PB member field mappings',
  },
];

export async function checkScopes(token: string): Promise<ScopeCheck[]> {
  const probe = async (s: typeof SCOPE_PROBES[number]): Promise<ScopeCheck> => {
    try {
      const res = await fetch(`${BASE}${s.probe}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        return { scope: s.scope, granted: true, required: s.required, description: s.description };
      }
      const body = await res.json().catch(() => null) as { category?: string; message?: string } | null;
      const isMissingScope = res.status === 403 || body?.category === 'MISSING_SCOPES';
      return {
        scope: s.scope,
        granted: false,
        required: s.required,
        description: s.description,
        error: isMissingScope ? 'Scope not granted' : `${res.status} ${body?.message ?? ''}`.trim(),
      };
    } catch (e) {
      return {
        scope: s.scope,
        granted: false,
        required: s.required,
        description: s.description,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };
  return Promise.all(SCOPE_PROBES.map(probe));
}
