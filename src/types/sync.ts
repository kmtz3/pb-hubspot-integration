import type { PBFieldType } from './productboard';
import type { HubSpotFilter } from './hubspot';

// ── Object-type discriminator ────────────────────────────────────────────────
// Phase 1 introduces multi-object support. `ObjectType` discriminates between
// the existing companies sync and the upcoming deals sync. New routes accept
// it as an optional param defaulting to `companies` so existing clients keep
// working unchanged (D24).
export type ObjectType = 'companies' | 'deals';

// `incremental` = the default cursor-based sweep using `lastSyncAt`.
// `backfill`    = explicit window with `from`/`to` epoch ms (D8/D21, deals).
// `full`        = full sweep ignoring the incremental cursor (companies UI).
export type SyncMode = 'incremental' | 'backfill' | 'full';

// ── Field mappings ───────────────────────────────────────────────────────────

export interface FieldMapping {
  hubspotProperty: string;
  pbFieldId: string;
  pbFieldType: PBFieldType | null;
  enabled: boolean;
  locked: boolean;
}

// ── Deals-specific mapping shapes (scaffolded; populated in Phase 5) ─────────

export interface TagMapping {
  hsField: string;
  prefix?: string;
  enabled: boolean;
}

export interface BodyMapping {
  hsField: string;
  label?: string;
  style: 'metadata' | 'longform';
  order: number;
  enabled: boolean;
}

export interface TagRule {
  field: string;
  operator: HubSpotFilter['operator'];
  value?: string;
  values?: string[];
  tagName: string;
}

export interface DealsFieldMappings {
  tags: TagMapping[];
  body: BodyMapping[];
  rules: TagRule[];
  staticTags: string[];
}

export interface FieldMappingsDoc {
  companies: FieldMapping[];
  deals: DealsFieldMappings;
}

// ── Filters ──────────────────────────────────────────────────────────────────

export interface FilterGroup {
  filters: HubSpotFilter[];
}

export interface DealsFilter {
  pipelineId: string;
  stageIds: string[];
  filterGroups: FilterGroup[];
}

export interface FiltersDoc {
  companies: {
    enabled: boolean;
    filterGroups: FilterGroup[];
    previewCount?: number;
  };
  deals: DealsFilter;
}

// Legacy alias kept so engine and existing tests can still import it under
// the old name. Phase 5 swaps callers to read from `FiltersDoc.companies`.
export type AccountFilter = FiltersDoc['companies'];

// ── Sync config ──────────────────────────────────────────────────────────────
//
// Phase 1 partitions per-object cursors and adds the deals toggles. The
// schedule cron strings + their startup reconciliation land in Phase 6 (D19,
// D22); for Phase 1 the legacy schedule enum fields stay accessible so the
// existing accounts Schedule UI continues to work without behavioral change.

export type LegacyScheduleEnum = 'manual' | 'daily' | 'weekly' | 'hourly' | 'every15';

export interface SyncConfig {
  // Per-object cron strings — null = paused (D22). Phase 6 wires these to
  // GCP Cloud Scheduler; Phase 1 leaves them alongside the legacy enum so the
  // existing accounts schedule UI keeps working.
  schedule: { companies: string | null; deals: string | null };

  // Per-object lastSyncAt cursors. ISO strings (the engine reads
  // `lastSyncAt.companies` for the companies incremental path).
  lastSyncAt: { companies: string | null; deals: string | null };

  // ── Deals toggles (D6, D13/D14) ────────────────────────────────────────────
  multiCompanyDealNotes: boolean;
  forceContentUpdates: boolean;

  // ── Existing operational fields (carried over) ────────────────────────────
  domainFallbackEnabled: boolean;
  inProgress: boolean;
  inProgressStartedAt?: string;
  inProgressStats?: Partial<SyncStats>;
  historyRetentionDays?: number;
  debugLogging?: boolean;
  syncToPBProperty?: string;
  lastSyncStatus?: SyncStatus;
  lastSyncStats?: SyncStats;

  // ── Legacy schedule enum (transitional; replaced fully in Phase 6) ────────
  // The existing accounts Schedule UI uses these; the cron string in
  // `schedule.companies` is the future-state field. Phase 6 removes the enum
  // and migrates the UI to a cron picker.
  legacySchedule?: LegacyScheduleEnum;
  legacyScheduleTime?: string;
  legacyScheduleDay?: string;
  legacyTimezone?: string;
}

// ── Sync run + stats ─────────────────────────────────────────────────────────

export interface SyncStats {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  // Phase 1 extends stats; deals-only counters are optional so companies runs
  // serialize the same shape they did before (D17 — refactor only).
  archived?: number;
  contentSkipped?: number;
  snippetsStripped?: number;
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
  // New on every run record. Existing companies runs serialize as
  // `objectType: 'companies'`; deals runs land in Phase 4.
  objectType: ObjectType;
  mode: SyncMode;
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
  // Browser-safe display only. Populated by the route handler before responding.
  tokenMasked?: string;
}

export interface ProductboardConfig {
  connected: boolean;
  workspaceName?: string | null;
  connectedAt?: string;
  // Server-only: never sent to the browser.
  tokenSecretName?: string;
  // Browser-safe display only. Populated by the route handler before responding.
  tokenMasked?: string;
}

// `updateSyncConfig` accepts a partial that tolerates partial inner shapes
// for the `schedule` and `lastSyncAt` partitions — Firestore deep-merges map
// fields under `merge: true`, and the in-memory store mirrors that, so writing
// `{ lastSyncAt: { companies: x } }` doesn't blow away the `deals` key.
export type SyncConfigUpdate = {
  schedule?:   Partial<SyncConfig['schedule']>;
  lastSyncAt?: Partial<SyncConfig['lastSyncAt']>;
} & Partial<Omit<SyncConfig, 'schedule' | 'lastSyncAt'>>;

// ── App config (returned by /api/config) ─────────────────────────────────────

export interface AppConfig {
  hubspot: HubSpotConfig;
  productboard: ProductboardConfig;
  sync: SyncConfig;
  fieldMappings: FieldMappingsDoc;
  filters: FiltersDoc;
}
