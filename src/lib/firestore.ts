import * as fs from 'fs';
import * as path from 'path';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type {
  HubSpotConfig,
  ProductboardConfig,
  SyncConfig,
  SyncRun,
  SyncStats,
  AccountFilter,
  FieldMapping,
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
  fieldMappings: { mappings: FieldMapping[] };
  accountFilter: AccountFilter;
};

function loadDevStore(): PersistedDevStore {
  try {
    const raw = fs.readFileSync(DEV_STORE_PATH, 'utf8');
    return JSON.parse(raw) as PersistedDevStore;
  } catch {
    return {
      hubspot:       { connected: false },
      productboard:  { connected: false },
      sync:          { schedule: 'manual', domainFallbackEnabled: true, inProgress: false },
      fieldMappings: { mappings: defaultFieldMappings() },
      accountFilter: { enabled: false, filterGroups: [] },
    };
  }
}

function flushDevStore(): void {
  const snapshot: PersistedDevStore = {
    hubspot:       mem.hubspot,
    productboard:  mem.productboard,
    sync:          mem.sync,
    fieldMappings: mem.fieldMappings,
    accountFilter: mem.accountFilter,
  };
  fs.writeFileSync(DEV_STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
}

type MemStore = {
  hubspot: HubSpotConfig;
  productboard: ProductboardConfig;
  sync: SyncConfig;
  fieldMappings: { mappings: FieldMapping[] };
  accountFilter: AccountFilter;
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
  sync:          persisted?.sync          ?? { schedule: 'manual', domainFallbackEnabled: true, inProgress: false },
  fieldMappings: persisted?.fieldMappings ?? { mappings: defaultFieldMappings() },
  accountFilter: persisted?.accountFilter ?? { enabled: false, filterGroups: [] },
  syncHistory:   new Map(),
  cache:         new Map(),
};
let memHistorySeq = 0;

// ── Firestore init (skipped in memstore mode) ────────────────────────────────

if (!USE_MEMSTORE) {
  if (!getApps().length) {
    initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID ?? 'demo-local' });
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

// ── Config document helpers ──────────────────────────────────────────────────

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

export async function getSyncConfig(): Promise<SyncConfig> {
  if (USE_MEMSTORE) return { ...mem.sync };
  const snap = await db().collection(CONFIG).doc('sync').get();
  return (snap.data() as SyncConfig) ?? {
    schedule: 'manual',
    domainFallbackEnabled: true,
    inProgress: false,
  };
}

export async function updateSyncConfig(update: Partial<SyncConfig>): Promise<void> {
  if (USE_MEMSTORE) { mem.sync = { ...mem.sync, ...update }; flushDevStore(); return; }
  await db().collection(CONFIG).doc('sync').set(update, { merge: true });
}

export async function getFieldMappings(): Promise<FieldMapping[]> {
  if (USE_MEMSTORE) return [...mem.fieldMappings.mappings];
  const snap = await db().collection(CONFIG).doc('fieldMappings').get();
  const data = snap.data() as { mappings?: FieldMapping[] } | undefined;
  return data?.mappings ?? defaultFieldMappings();
}

export async function saveFieldMappings(mappings: FieldMapping[]): Promise<void> {
  if (USE_MEMSTORE) { mem.fieldMappings = { mappings }; flushDevStore(); return; }
  await db().collection(CONFIG).doc('fieldMappings').set({ mappings });
}

export async function getAccountFilter(): Promise<AccountFilter> {
  if (USE_MEMSTORE) return { ...mem.accountFilter };
  const snap = await db().collection(CONFIG).doc('accountFilter').get();
  return (snap.data() as AccountFilter) ?? { enabled: false, filterGroups: [] };
}

export async function saveAccountFilter(filter: AccountFilter): Promise<void> {
  if (USE_MEMSTORE) { mem.accountFilter = { ...filter }; flushDevStore(); return; }
  await db().collection(CONFIG).doc('accountFilter').set(filter);
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

function defaultFieldMappings(): FieldMapping[] {
  return [
    { hubspotProperty: 'name',   pbFieldId: 'name',   pbFieldType: 'text', enabled: true,  locked: true  },
    { hubspotProperty: 'domain', pbFieldId: 'domain', pbFieldType: 'text', enabled: true,  locked: true  },
  ];
}
