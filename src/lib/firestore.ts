import * as fs from 'fs';
import * as path from 'path';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type {
  HubSpotConfig,
  ProductboardConfig,
  SyncConfig,
  SyncConfigUpdate,
  SyncRun,
  SyncStats,
  AccountFilter,
  FieldMapping,
  FieldMappingsDoc,
  FiltersDoc,
  DealsFieldMappings,
  DealsFilter,
} from '../types/sync';

// ── Dev in-memory store ──────────────────────────────────────────────────────
// Used automatically when FIRESTORE_EMULATOR_HOST is not set in dev.
// Avoids 6-7s GCP connection timeouts during local development.
// All reads/writes behave identically to Firestore from the caller's perspective.
//
// The persistent subset (connections + config) is flushed to .dev-store.json so
// tokens survive server restarts. syncHistory and cache are intentionally transient.

const USE_MEMSTORE =
  process.env.NODE_ENV !== 'production' && !process.env.FIRESTORE_EMULATOR_HOST;

const DEV_STORE_PATH = path.resolve(process.cwd(), '.dev-store.json');

// Emulator-mode token backup — survives kill -9 on the emulator process.
// Written on every saveHubSpotConfig / savePBConfig call; read lazily when
// the emulator doc is missing (e.g. after a force-kill that skips --export-on-exit).
const DEV_TOKENS_PATH = path.resolve(process.cwd(), '.dev-tokens.json');
type DevTokenBackup = { hubspot?: Partial<HubSpotConfig>; productboard?: Partial<ProductboardConfig> };
let devTokenBackup: DevTokenBackup = {};

function loadDevTokens(): void {
  try {
    devTokenBackup = JSON.parse(fs.readFileSync(DEV_TOKENS_PATH, 'utf8')) as DevTokenBackup;
  } catch { devTokenBackup = {}; }
}

function flushDevTokens(): void {
  fs.writeFileSync(DEV_TOKENS_PATH, JSON.stringify(devTokenBackup, null, 2), 'utf8');
}

if (!USE_MEMSTORE && process.env.NODE_ENV !== 'production') {
  loadDevTokens();
}

type PersistedDevStore = {
  hubspot: HubSpotConfig;
  productboard: ProductboardConfig;
  sync: SyncConfig;
  fieldMappings: FieldMappingsDoc;
  filters: FiltersDoc;
};

function loadDevStore(): PersistedDevStore {
  try {
    const raw = fs.readFileSync(DEV_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as PersistedDevStore;
    // D16 — wipe-and-redeploy on shape mismatch. If a `.dev-store.json` from a
    // pre-Phase-1 build is on disk, drop it rather than silently up-cast: we
    // don't ship read-side compat for the old shape.
    if (!parsed.sync || typeof parsed.sync.schedule !== 'object' || !parsed.fieldMappings || !('companies' in parsed.fieldMappings)) {
      console.info('[db] .dev-store.json holds the pre-Phase-1 shape — discarding (D16: wipe-and-redeploy).');
      return defaultDevStore();
    }
    return parsed;
  } catch {
    return defaultDevStore();
  }
}

function defaultDevStore(): PersistedDevStore {
  return {
    hubspot:       { connected: false },
    productboard:  { connected: false },
    sync:          defaultSyncConfig(),
    fieldMappings: defaultFieldMappingsDoc(),
    filters:       defaultFiltersDoc(),
  };
}

function flushDevStore(): void {
  const snapshot: PersistedDevStore = {
    hubspot:       mem.hubspot,
    productboard:  mem.productboard,
    sync:          mem.sync,
    fieldMappings: mem.fieldMappings,
    filters:       mem.filters,
  };
  fs.writeFileSync(DEV_STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
}

type MemStore = {
  hubspot: HubSpotConfig;
  productboard: ProductboardConfig;
  sync: SyncConfig;
  fieldMappings: FieldMappingsDoc;
  filters: FiltersDoc;
  syncHistory: Map<string, Omit<SyncRun, 'id'>>;
  cache: Map<string, CachedData<unknown>>;
};

const persisted = USE_MEMSTORE ? loadDevStore() : null;

if (USE_MEMSTORE) {
  const hadTokens = persisted?.hubspot?.connected || persisted?.productboard?.connected;
  console.info(
    `[db] Using in-memory store (FIRESTORE_EMULATOR_HOST not set). ${hadTokens ? 'Loaded saved tokens from .dev-store.json.' : 'No saved state found.'}`
  );
}

const mem: MemStore = {
  hubspot:       persisted?.hubspot       ?? { connected: false },
  productboard:  persisted?.productboard  ?? { connected: false },
  sync:          persisted?.sync          ?? defaultSyncConfig(),
  fieldMappings: persisted?.fieldMappings ?? defaultFieldMappingsDoc(),
  filters:       persisted?.filters       ?? defaultFiltersDoc(),
  syncHistory:   new Map(),
  cache:         new Map(),
};
let memHistorySeq = 0;

// ── Firestore init (skipped in memstore mode) ────────────────────────────────

if (!USE_MEMSTORE) {
  if (!getApps().length) {
    const projectId = process.env.GCP_PROJECT_ID || process.env.FIRESTORE_PROJECT_ID || 'demo-local';
    initializeApp({ projectId });
  }
}

// `ignoreUndefinedProperties` must be set on the Firestore instance before any
// reads/writes — otherwise upstream APIs returning sparse objects (e.g. PB
// field configs where some entries omit `constraints`) cause writes to throw.
let firestoreSettingsApplied = false;
function db() {
  const fs = getFirestore();
  if (!firestoreSettingsApplied && !USE_MEMSTORE) {
    fs.settings({ ignoreUndefinedProperties: true });
    firestoreSettingsApplied = true;
  }
  return fs;
}

// ── Connection config (unchanged from pre-refactor) ──────────────────────────

const CONFIG = 'config';

export async function getHubSpotConfig(): Promise<HubSpotConfig> {
  if (USE_MEMSTORE) return { ...mem.hubspot };
  const snap = await db().collection(CONFIG).doc('hubspot').get();
  if (snap.exists) return snap.data() as HubSpotConfig;
  if (process.env.NODE_ENV !== 'production' && devTokenBackup.hubspot) {
    console.info('[db] Restoring HubSpot config from .dev-tokens.json (emulator was force-killed)');
    await db().collection(CONFIG).doc('hubspot').set(devTokenBackup.hubspot, { merge: true });
    return devTokenBackup.hubspot as HubSpotConfig;
  }
  return { connected: false };
}

export async function saveHubSpotConfig(config: Partial<HubSpotConfig>): Promise<void> {
  if (USE_MEMSTORE) { mem.hubspot = { ...mem.hubspot, ...config }; flushDevStore(); return; }
  await db().collection(CONFIG).doc('hubspot').set(config, { merge: true });
  if (process.env.NODE_ENV !== 'production') {
    devTokenBackup.hubspot = { ...devTokenBackup.hubspot, ...config };
    flushDevTokens();
  }
}

export async function clearHubSpotConfig(): Promise<void> {
  const cleared: HubSpotConfig = { connected: false };
  if (USE_MEMSTORE) { mem.hubspot = cleared; flushDevStore(); return; }
  await db().collection(CONFIG).doc('hubspot').set(cleared);
  if (process.env.NODE_ENV !== 'production') {
    devTokenBackup.hubspot = cleared;
    flushDevTokens();
  }
}

export async function getPBConfig(): Promise<ProductboardConfig> {
  if (USE_MEMSTORE) return { ...mem.productboard };
  const snap = await db().collection(CONFIG).doc('productboard').get();
  if (snap.exists) return snap.data() as ProductboardConfig;
  if (process.env.NODE_ENV !== 'production' && devTokenBackup.productboard) {
    console.info('[db] Restoring Productboard config from .dev-tokens.json (emulator was force-killed)');
    await db().collection(CONFIG).doc('productboard').set(devTokenBackup.productboard, { merge: true });
    return devTokenBackup.productboard as ProductboardConfig;
  }
  return { connected: false };
}

export async function savePBConfig(config: Partial<ProductboardConfig>): Promise<void> {
  if (USE_MEMSTORE) { mem.productboard = { ...mem.productboard, ...config }; flushDevStore(); return; }
  await db().collection(CONFIG).doc('productboard').set(config, { merge: true });
  if (process.env.NODE_ENV !== 'production') {
    devTokenBackup.productboard = { ...devTokenBackup.productboard, ...config };
    flushDevTokens();
  }
}

export async function clearPBConfig(): Promise<void> {
  const cleared: ProductboardConfig = { connected: false };
  if (USE_MEMSTORE) { mem.productboard = cleared; flushDevStore(); return; }
  await db().collection(CONFIG).doc('productboard').set(cleared);
  if (process.env.NODE_ENV !== 'production') {
    devTokenBackup.productboard = cleared;
    flushDevTokens();
  }
}

// ── Sync config (Phase 1: partitioned shape, no back-compat) ─────────────────
//
// `config/sync` now carries:
//   - schedule:    { companies: cron|null, deals: cron|null }   (Phase 6 wires)
//   - lastSyncAt:  { companies: ISO|null,  deals: ISO|null }
//   - new toggles: forceContentUpdates, multiCompanyDealNotes
// plus the existing operational flags. Per D16, we read the new shape only —
// pre-Phase-1 docs are detected and replaced with defaults rather than silently
// upcast, and the deploy procedure is wipe-and-redeploy.

function isLegacySyncShape(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  // Old shape had `schedule` as an enum string, e.g. "manual" | "daily" | …
  return typeof d.schedule === 'string';
}

export async function getSyncConfig(): Promise<SyncConfig> {
  if (USE_MEMSTORE) return cloneSyncConfig(mem.sync);
  const snap = await db().collection(CONFIG).doc('sync').get();
  const data = snap.data();
  if (!data) return defaultSyncConfig();
  if (isLegacySyncShape(data)) {
    console.warn('[db] config/sync is in the pre-Phase-1 shape; returning defaults (D16 — re-enter via UI).');
    return defaultSyncConfig();
  }
  return mergeSyncDefaults(data as Partial<SyncConfig>);
}

// Deep-merge top-level partition objects (`schedule`, `lastSyncAt`) so a
// partial update like `{ lastSyncAt: { companies: …}}` doesn't blow away the
// `deals` key. Other fields shallow-merge as before. Mirrors the Firestore
// `merge: true` deep-merge for map fields.
function deepMergePartitions(
  prev: SyncConfig,
  update: SyncConfigUpdate,
): SyncConfig {
  const { schedule, lastSyncAt, ...rest } = update;
  const next: SyncConfig = { ...prev, ...rest };
  if (schedule)   next.schedule   = { ...prev.schedule,   ...schedule };
  if (lastSyncAt) next.lastSyncAt = { ...prev.lastSyncAt, ...lastSyncAt };
  return next;
}

export async function updateSyncConfig(update: SyncConfigUpdate): Promise<void> {
  if (USE_MEMSTORE) {
    mem.sync = deepMergePartitions(mem.sync, update);
    flushDevStore();
    return;
  }
  await db().collection(CONFIG).doc('sync').set(update, { merge: true });
}

// ── Field mappings (partitioned) ─────────────────────────────────────────────

function isLegacyFieldMappingsShape(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  // Old shape: `{ mappings: FieldMapping[] }`. New shape: `{ companies, deals }`.
  return 'mappings' in (data as object) && !('companies' in (data as object));
}

async function readFieldMappingsDoc(): Promise<FieldMappingsDoc> {
  if (USE_MEMSTORE) return cloneFieldMappingsDoc(mem.fieldMappings);
  const snap = await db().collection(CONFIG).doc('fieldMappings').get();
  const data = snap.data();
  if (!data) return defaultFieldMappingsDoc();
  if (isLegacyFieldMappingsShape(data)) {
    console.warn('[db] config/fieldMappings is in the pre-Phase-1 shape; returning defaults (D16 — re-enter via UI).');
    return defaultFieldMappingsDoc();
  }
  return mergeFieldMappingsDefaults(data as Partial<FieldMappingsDoc>);
}

// Companies-scoped helper. Existing engine + tests call this with no args —
// preserves the surface area used by `runCompaniesSync`. Phase 4 introduces
// a separate `getDealsFieldMappings` reader.
export async function getFieldMappings(): Promise<FieldMapping[]> {
  const doc = await readFieldMappingsDoc();
  return [...doc.companies];
}

export async function getDealsFieldMappings(): Promise<DealsFieldMappings> {
  const doc = await readFieldMappingsDoc();
  return { ...doc.deals };
}

export async function getFieldMappingsDoc(): Promise<FieldMappingsDoc> {
  return readFieldMappingsDoc();
}

export async function saveFieldMappings(mappings: FieldMapping[]): Promise<void> {
  if (USE_MEMSTORE) {
    mem.fieldMappings = { ...mem.fieldMappings, companies: [...mappings] };
    flushDevStore();
    return;
  }
  await db().collection(CONFIG).doc('fieldMappings').set({ companies: mappings }, { merge: true });
}

export async function saveDealsFieldMappings(deals: DealsFieldMappings): Promise<void> {
  if (USE_MEMSTORE) {
    mem.fieldMappings = { ...mem.fieldMappings, deals: { ...deals } };
    flushDevStore();
    return;
  }
  await db().collection(CONFIG).doc('fieldMappings').set({ deals }, { merge: true });
}

// ── Filters (partitioned; doc renamed config/filters from config/accountFilter)

function isLegacyFiltersShape(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  // Old shape: `{ enabled, filterGroups }`. New shape: `{ companies, deals }`.
  return 'enabled' in (data as object) && !('companies' in (data as object));
}

async function readFiltersDoc(): Promise<FiltersDoc> {
  if (USE_MEMSTORE) return cloneFiltersDoc(mem.filters);
  const snap = await db().collection(CONFIG).doc('filters').get();
  const data = snap.data();
  if (!data) return defaultFiltersDoc();
  if (isLegacyFiltersShape(data)) {
    console.warn('[db] config/filters is in the pre-Phase-1 shape; returning defaults (D16 — re-enter via UI).');
    return defaultFiltersDoc();
  }
  return mergeFiltersDefaults(data as Partial<FiltersDoc>);
}

// Companies-scoped helper. The engine still calls `getAccountFilter()` — we
// keep the alias because the underlying meaning is the same: the companies
// filter group. Phase 5/6 may rename callers; Phase 1 is refactor-only.
export async function getAccountFilter(): Promise<AccountFilter> {
  const doc = await readFiltersDoc();
  return { ...doc.companies };
}

export async function getDealsFilter(): Promise<DealsFilter> {
  const doc = await readFiltersDoc();
  return { ...doc.deals };
}

export async function getFiltersDoc(): Promise<FiltersDoc> {
  return readFiltersDoc();
}

export async function saveAccountFilter(filter: AccountFilter): Promise<void> {
  if (USE_MEMSTORE) {
    mem.filters = { ...mem.filters, companies: { ...filter } };
    flushDevStore();
    return;
  }
  await db().collection(CONFIG).doc('filters').set({ companies: filter }, { merge: true });
}

export async function saveDealsFilter(filter: DealsFilter): Promise<void> {
  if (USE_MEMSTORE) {
    mem.filters = { ...mem.filters, deals: { ...filter } };
    flushDevStore();
    return;
  }
  await db().collection(CONFIG).doc('filters').set({ deals: filter }, { merge: true });
}

// ── Sync history ─────────────────────────────────────────────────────────────

const HISTORY = 'syncHistory';

export async function writeSyncHistory(run: Omit<SyncRun, 'id'>): Promise<string> {
  if (USE_MEMSTORE) {
    const id = `mem-run-${++memHistorySeq}`;
    mem.syncHistory.set(id, run);
    return id;
  }
  const ref = await db().collection(HISTORY).add(run);
  return ref.id;
}

export async function getSyncHistory(limit = 20): Promise<SyncRun[]> {
  if (USE_MEMSTORE) {
    return [...mem.syncHistory.entries()]
      .map(([id, run]) => ({ id, ...run } as SyncRun))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }
  const snap = await db().collection(HISTORY)
    .orderBy('startedAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as SyncRun));
}

export async function getSyncRun(runId: string): Promise<SyncRun | null> {
  if (USE_MEMSTORE) {
    const run = mem.syncHistory.get(runId);
    return run ? { id: runId, ...run } as SyncRun : null;
  }
  const snap = await db().collection(HISTORY).doc(runId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as SyncRun;
}

// ── Property/field cache ──────────────────────────────────────────────────────

export interface CachedData<T> {
  data: T;
  cachedAt: string;
}

export async function getCachedData<T>(key: string): Promise<CachedData<T> | null> {
  if (USE_MEMSTORE) return (mem.cache.get(key) as CachedData<T>) ?? null;
  const snap = await db().collection('cache').doc(key).get();
  if (!snap.exists) return null;
  return snap.data() as CachedData<T>;
}

export async function setCachedData<T>(key: string, data: T): Promise<void> {
  const entry: CachedData<T> = { data, cachedAt: new Date().toISOString() };
  if (USE_MEMSTORE) { mem.cache.set(key, entry as CachedData<unknown>); return; }
  await db().collection('cache').doc(key).set(entry);
}

// ── Defaults ──────────────────────────────────────────────────────────────────

function defaultCompanyMappings(): FieldMapping[] {
  return [
    { hubspotProperty: 'name',   pbFieldId: 'name',   pbFieldType: 'text', enabled: true,  locked: true  },
    { hubspotProperty: 'domain', pbFieldId: 'domain', pbFieldType: 'text', enabled: true,  locked: true  },
  ];
}

function defaultDealsFieldMappings(): DealsFieldMappings {
  return { tags: [], body: [], rules: [], staticTags: [] };
}

export function defaultFieldMappingsDoc(): FieldMappingsDoc {
  return {
    companies: defaultCompanyMappings(),
    deals: defaultDealsFieldMappings(),
  };
}

function defaultDealsFilter(): DealsFilter {
  return { pipelineId: '', stageIds: [], filterGroups: [] };
}

export function defaultFiltersDoc(): FiltersDoc {
  return {
    companies: { enabled: false, filterGroups: [] },
    deals:     defaultDealsFilter(),
  };
}

export function defaultSyncConfig(): SyncConfig {
  return {
    schedule:               { companies: null, deals: null },
    lastSyncAt:             { companies: null, deals: null },
    multiCompanyDealNotes:  false,
    forceContentUpdates:    false,
    domainFallbackEnabled:  true,
    inProgress:             false,
  };
}

function mergeSyncDefaults(partial: Partial<SyncConfig>): SyncConfig {
  const defaults = defaultSyncConfig();
  return {
    ...defaults,
    ...partial,
    schedule:   { ...defaults.schedule,   ...(partial.schedule   ?? {}) },
    lastSyncAt: { ...defaults.lastSyncAt, ...(partial.lastSyncAt ?? {}) },
  };
}

function mergeFieldMappingsDefaults(partial: Partial<FieldMappingsDoc>): FieldMappingsDoc {
  return {
    companies: partial.companies ?? defaultCompanyMappings(),
    deals:     { ...defaultDealsFieldMappings(), ...(partial.deals ?? {}) },
  };
}

function mergeFiltersDefaults(partial: Partial<FiltersDoc>): FiltersDoc {
  const defaults = defaultFiltersDoc();
  return {
    companies: { ...defaults.companies, ...(partial.companies ?? {}) },
    deals:     { ...defaults.deals,     ...(partial.deals     ?? {}) },
  };
}

function cloneSyncConfig(c: SyncConfig): SyncConfig {
  return {
    ...c,
    schedule:   { ...c.schedule },
    lastSyncAt: { ...c.lastSyncAt },
  };
}

function cloneFieldMappingsDoc(d: FieldMappingsDoc): FieldMappingsDoc {
  return { companies: [...d.companies], deals: { ...d.deals, tags: [...d.deals.tags], body: [...d.deals.body], rules: [...d.deals.rules], staticTags: [...d.deals.staticTags] } };
}

function cloneFiltersDoc(d: FiltersDoc): FiltersDoc {
  return {
    companies: { ...d.companies, filterGroups: [...d.companies.filterGroups] },
    deals:     { ...d.deals, stageIds: [...d.deals.stageIds], filterGroups: [...d.deals.filterGroups] },
  };
}

// Re-export the legacy default-mappings helper name so any external scripts
// importing it (planning-docs experiments, manual seeds) keep compiling.
export { defaultCompanyMappings as defaultFieldMappings };

// Suppress the unused-import lint warning for `SyncStats`, which several
// callers reach through this module's barrel re-exports.
export type { SyncStats };
