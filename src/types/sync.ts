import type { PBFieldType } from './productboard';

export interface FieldMapping {
  hubspotProperty: string;
  pbFieldId: string;
  pbFieldType: PBFieldType | null;
  enabled: boolean;
  locked: boolean;
}

export interface SyncConfig {
  schedule: 'manual' | 'daily' | 'weekly' | 'hourly' | 'every15';
  scheduleTime?: string;
  scheduleDay?: string;
  timezone?: string;
  lastSyncAt?: string;
  lastSyncStatus?: SyncStatus;
  lastSyncStats?: SyncStats;
  domainFallbackEnabled: boolean;
  inProgress: boolean;
  // Timestamp of when the current run started. Lets the route handler detect
  // a stale lock (Cloud Run can kill the instance mid-sync since the route
  // returns 200 and continues in setImmediate, orphaning inProgress=true).
  inProgressStartedAt?: string;
  inProgressStats?: Partial<SyncStats>;
  historyRetentionDays?: number;
  debugLogging?: boolean;
  syncToPBProperty?: string;
}

export interface SyncStats {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface SyncRunError {
  hsId: string | null;
  name: string;
  detail: string;
}

export interface SyncDebugLog {
  at: string;
  hsId: string | null;
  name: string;
  action?: 'create' | 'update';
  pbId?: string;
  payload?: unknown;
  error?: {
    message: string;
    name?: string;
    status?: number;
    responseBody?: unknown;
    stack?: string;
  };
}

export interface SyncRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  trigger: SyncTrigger;
  status: SyncStatus;
  stats: SyncStats;
  errors: SyncRunError[];
  debugLogs?: SyncDebugLog[];
  resolvedViaFallback?: number;
  // Set when status === 'skipped'. Surfaces *why* the run was a no-op (e.g.
  // missing token) so the History tab can render context instead of leaving
  // the user wondering why nothing happened.
  skipReason?: string;
}

export type SyncTrigger = 'ui' | 'scheduler';
export type SyncStatus = 'success' | 'partial' | 'failed' | 'running' | 'skipped';

export type SseEmitter = (event: SyncEvent) => void;

export type SyncEvent =
  | { type: 'progress'; processed: number; total: number; created: number; updated: number; skipped: number; errors: number; rate: number; eta: string }
  | { type: 'record'; status: 'created' | 'updated' | 'skipped' | 'error'; name: string; hsId: string; detail?: string }
  | { type: 'done'; status: SyncStatus; stats: SyncStats; durationMs: number };

export interface HubSpotConfig {
  connected: boolean;
  portalId?: string;
  hubName?: string | null;
  connectedAt?: string;
  // Server-only: never sent to the browser.
  tokenSecretName?: string;
  // Server-only: last 4 chars of the raw token, captured at save time so the UI
  // preview reflects the actual token rather than the secret resource path.
  tokenLast4?: string;
  // Browser-safe display only. Populated by the route handler before responding.
  tokenMasked?: string;
}

export interface ProductboardConfig {
  connected: boolean;
  workspaceName?: string | null;
  connectedAt?: string;
  // Server-only: never sent to the browser.
  tokenSecretName?: string;
  // Server-only: last 4 chars of the raw token, captured at save time so the UI
  // preview reflects the actual token rather than the secret resource path.
  tokenLast4?: string;
  // Browser-safe display only. Populated by the route handler before responding.
  tokenMasked?: string;
}

export interface AccountFilter {
  enabled: boolean;
  filterGroups: Array<{ filters: import('./hubspot').HubSpotFilter[] }>;
  previewCount?: number;
}

export interface FieldMappingsDoc {
  mappings: FieldMapping[];
}

export interface AppConfig {
  hubspot: HubSpotConfig;
  productboard: ProductboardConfig;
  sync: SyncConfig;
  fieldMappings: FieldMappingsDoc;
  accountFilter: AccountFilter;
}
