import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AppConfig, SyncRun, HubSpotConfig, ProductboardConfig } from '../../types/sync';
import type { HubSpotPipeline, HubSpotProperty, HubSpotFilter } from '../../types/hubspot';
import type { PBField, ProductboardTag } from '../../types/productboard';
import type { DealsFieldMappings } from '../../types/sync';

export interface HubSpotScopeCheck {
  scope: string;
  granted: boolean;
  required: boolean;
  description: string;
  group?: 'companies' | 'deals';
  error?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  portalId?: string;
  workspaceName?: string | null;
  scopes?: HubSpotScopeCheck[];
}

// ── Shared fetch wrapper ─────────────────────────────────────────────────────

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Accept': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    window.location.href = '/auth/google';
    throw new Error('Redirecting to sign in');
  }
  if (!res.ok) throw new Error(`API error ${res.status}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Health / deployment info ─────────────────────────────────────────────────

export const useHealth = () =>
  useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<{ ok: boolean; gcpProjectId: string | null }>('/health'),
    staleTime: Infinity,
  });

// ── Connections ──────────────────────────────────────────────────────────────

export const useConnections = () =>
  useQuery({
    queryKey: ['connections'],
    queryFn: () => apiFetch<{ hubspot: HubSpotConfig; productboard: ProductboardConfig }>('/api/connections'),
  });

export const useConnectHubSpot = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch<HubSpotConfig & { scopes?: HubSpotScopeCheck[] }>('/api/connections/hubspot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
};

export const useConnectProductboard = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch<ProductboardConfig>('/api/connections/productboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
};

export const useTestConnection = () =>
  useMutation({
    mutationFn: (system: 'hubspot' | 'productboard') =>
      apiFetch<TestConnectionResult>(`/api/connections/${system}/test`),
  });

export const useDisconnect = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (system: 'hubspot' | 'productboard') =>
      apiFetch<void>(`/api/connections/${system}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });
};

// ── Config ───────────────────────────────────────────────────────────────────

export const useConfig = () =>
  useQuery({
    queryKey: ['config'],
    queryFn: () => apiFetch<AppConfig>('/api/config'),
    staleTime: 30_000,
  });

export const useSaveConfig = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppConfig>) =>
      apiFetch<{ ok: boolean }>('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });
};

export const useResetConfig = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>('/api/config', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });
};

export const useClearHistory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>('/api/config/history', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-runs'] }),
  });
};

// ── HubSpot / PB field discovery ─────────────────────────────────────────────

export const useHSProperties = () =>
  useQuery({
    queryKey: ['hs-properties'],
    queryFn: () => apiFetch<HubSpotProperty[]>('/api/hubspot/properties'),
    staleTime: 60 * 60 * 1000,
  });

export const useHSDealProperties = () =>
  useQuery({
    queryKey: ['hs-deal-properties'],
    queryFn: () => apiFetch<HubSpotProperty[]>('/api/hubspot/properties?objectType=deals'),
    staleTime: 60 * 60 * 1000,
  });

export const useDealPipelines = () =>
  useQuery({
    queryKey: ['hs-deal-pipelines'],
    queryFn: () => apiFetch<HubSpotPipeline[]>('/api/hubspot/pipelines'),
    staleTime: 60 * 60 * 1000,
  });

export const usePBFields = () =>
  useQuery({
    queryKey: ['pb-fields'],
    queryFn: () => apiFetch<PBField[]>('/api/productboard/fields'),
    staleTime: 60 * 60 * 1000,
  });

// ── Sync ─────────────────────────────────────────────────────────────────────

export const useSyncRuns = (limit = 20) =>
  useQuery({
    queryKey: ['sync-runs', limit],
    queryFn: () => apiFetch<SyncRun[]>(`/api/sync/runs?limit=${limit}`),
    staleTime: 15_000,
  });

export const useSyncRun = (id: string | null) =>
  useQuery({
    queryKey: ['sync-run', id],
    queryFn: () => apiFetch<SyncRun>(`/api/sync/runs/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const run = query.state.data as SyncRun | undefined;
      return run?.status === 'running' ? 5000 : false;
    },
  });

export const useStartSync = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trigger: 'ui' | 'scheduler' = 'ui') =>
      apiFetch<{ runId: string }>('/api/sync/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-runs'] }),
  });
};

export const useCancelSync = () =>
  useMutation({
    mutationFn: (runId: string) =>
      apiFetch<{ cancelled: boolean }>(`/api/sync/runs/${runId}`, { method: 'DELETE' }),
  });

// ── PB Tags ───────────────────────────────────────────────────────────────────

export const usePbTags = () =>
  useQuery({
    queryKey: ['pb-tags'],
    queryFn: () => apiFetch<ProductboardTag[]>('/api/productboard/tags'),
    staleTime: 60 * 60 * 1000,
  });

// ── Deals config ──────────────────────────────────────────────────────────────

export const useDealsConfig = () => {
  const q = useConfig();
  return { ...q, data: q.data?.fieldMappings?.deals };
};

export const useUpdateDealsConfig = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deals: DealsFieldMappings) =>
      apiFetch<{ ok: boolean }>('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldMappings: { deals } } as never),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });
};

// ── Backfill ──────────────────────────────────────────────────────────────────

export interface BackfillRequest {
  from: number;
  to: number;
  windowField: 'hs_lastmodifieddate' | 'createdate';
}

export const useTriggerBackfill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: BackfillRequest) =>
      apiFetch<{ runId: string }>('/api/sync/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectType: 'deals', mode: 'backfill', trigger: 'ui', ...req }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-runs'] }),
  });
};

// ── Filter preview ────────────────────────────────────────────────────────────

export const useFilterPreview = () =>
  useMutation({
    mutationFn: (filters: HubSpotFilter[]) =>
      apiFetch<{ count: number; total: number }>('/api/filters/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters }),
      }),
  });

export const useDealsFilterPreview = () =>
  useMutation({
    mutationFn: (filters: HubSpotFilter[]) =>
      apiFetch<{ count: number; total: number }>('/api/filters/preview?objectType=deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters }),
      }),
  });
