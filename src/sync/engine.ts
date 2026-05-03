import type { SyncDebugLog, SyncStats, SyncTrigger, SseEmitter, SyncEvent, ObjectType, SyncMode } from '../types/sync';
import type { PBFieldValuesCache } from '../types/productboard';
import {
  getSyncConfig,
  getFieldMappings,
  getAccountFilter,
  getHubSpotConfig,
  getPBConfig,
  updateSyncConfig,
  writeSyncHistory,
} from '../lib/firestore';
import { fetchCompanies, fetchOwnerEmailMapsCached, fetchProperties } from './hubspot';
import * as pbClient from './productboard';
import { buildCompanyMaps, findExistingCompany } from './dedup';
import { buildCompanyFieldsPayload, buildPatchOperations, detectOwnerIdField, stripNullFieldValues } from './mapper';
import type { FieldMapping } from '../types/sync';
import type { PBField, PBFieldValue } from '../types/productboard';
import { ApiError } from './rateLimit';

// Shared per-run context passed through the inner pipeline (D20). The shape
// is deliberately narrow — the directories (`pbMemberEmails`, `ownerIdToEmail`,
// `userIdToEmail`) are populated once at run start and read O(1) per record.
// Phase 4 extends this with deal-specific maps (deal note index, company
// dedup index, association map, unassigned placeholder uuid). For Phase 3
// it just formalizes what runCompaniesSync already passes around as locals,
// so both flows have a single interface for "is this email a PB member" /
// "is this HS id resolvable to an email".
export interface SyncContext {
  pbMemberEmails: Set<string>;
  ownerIdToEmail: Map<string, string>;
  userIdToEmail: Map<string, string>;
}

// Returns a human-readable skipReason if either connection is missing, or
// null if both sides are configured. Token presence is detected via either
// (a) the Firestore connection record's `connected` flag (the Connect tab
// flips this on save and clears it on disconnect) or (b) an env-var override
// (HUBSPOT_API_KEY / PB_API_KEY) — matching the lookup order in the token
// getters so the skip check never disagrees with the actual fetch path.
async function checkConnectionsForSkip(): Promise<string | null> {
  const [hs, pb] = await Promise.all([getHubSpotConfig(), getPBConfig()]);
  const hsOk = !!process.env.HUBSPOT_API_KEY || hs.connected;
  const pbOk = !!process.env.PB_API_KEY || pb.connected;
  if (hsOk && pbOk) return null;
  const missing: string[] = [];
  if (!hsOk) missing.push('HubSpot');
  if (!pbOk) missing.push('Productboard');
  return `${missing.join(' + ')} not connected — reconnect in the Connect tab to resume`;
}

function nonClearableFieldIds(fields: PBField[]): Set<string> {
  return new Set(
    fields
      .filter(f => f.constraints?.required || f.constraints?.notBlank)
      .map(f => f.id)
  );
}

function fieldConstraintsById(fields: PBField[]): Map<string, NonNullable<PBField['constraints']>> {
  return new Map(
    fields
      .filter(f => f.constraints)
      .map(f => [f.id, f.constraints!])
  );
}

function serializeError(err: unknown): SyncDebugLog['error'] {
  if (err instanceof ApiError) {
    return {
      name: err.name,
      message: err.message,
      status: err.status,
      responseBody: err.responseBody,
      stack: err.stack,
    };
  }
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

// Ensure every `{name}` value in the payload exists on its PB select / multi-
// select target field. Mirrors PBToolkit's pattern with the autoCreateFieldValues
// option: check the pre-loaded value cache first, only POST when the name is
// genuinely missing. Per Klara (May 2026), never trust the create endpoint to
// dedupe — always look up the existing value list first to avoid creating
// duplicate rows on fields where PB does not collapse them.
async function provisionMissingValues(
  fields: Record<string, PBFieldValue>,
  mappings: FieldMapping[],
  valuesCache: PBFieldValuesCache
): Promise<void> {
  for (const m of mappings) {
    if (!m.pbFieldId) continue;
    if (m.pbFieldType !== 'select' && m.pbFieldType !== 'multiselect') continue;

    const value = fields[m.pbFieldId];
    if (value === null || value === undefined) continue;

    let cache = valuesCache.get(m.pbFieldId);
    if (!cache) {
      cache = new Map<string, string>();
      valuesCache.set(m.pbFieldId, cache);
    }

    const ensure = async (name: string): Promise<boolean> => {
      if (!name) return false;
      if (cache!.has(name)) return true; // already exists — no POST
      try {
        const { id } = await pbClient.createFieldValue(m.pbFieldId, name);
        cache!.set(name, id);
        return true;
      } catch (e) {
        console.warn(`Could not provision PB value "${name}" on field ${m.pbFieldId}:`, e);
        return false;
      }
    };

    if (m.pbFieldType === 'select' && typeof value === 'object' && value !== null && 'name' in value) {
      const ok = await ensure(value.name);
      if (!ok) delete fields[m.pbFieldId];
    } else if (m.pbFieldType === 'multiselect' && Array.isArray(value)) {
      const kept: Array<{ name: string }> = [];
      for (const v of value) {
        if (typeof v !== 'object' || v === null || !('name' in v)) continue;
        if (await ensure(v.name)) kept.push({ name: v.name });
      }
      if (kept.length > 0) fields[m.pbFieldId] = kept;
      else delete fields[m.pbFieldId];
    }
  }
}

const CONCURRENCY = parseInt(process.env.SYNC_CONCURRENCY ?? '5', 10);
const DRY_RUN = () => process.env.DRY_RUN === 'true';

const activeRuns = new Map<string, { cancelRequested: boolean }>();

export function requestCancel(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (!run) return false;
  run.cancelRequested = true;
  return true;
}

// ── Run options + dispatcher ────────────────────────────────────────────────
//
// `runSync` is the top-level entry point used by the route handler and tests.
// It dispatches to `runCompaniesSync` or `runDealsSync` based on `objectType`,
// which defaults to `'companies'` (D24) so existing scheduler invocations and
// tests that pass no objectType keep working without change.
//
// The deals branch throws a clear `not yet implemented` error in Phase 1 —
// the wiring lands in Phase 4. The dispatcher exists now so routes, types,
// and tests can already discriminate on object type.

export interface RunSyncOptions {
  trigger: SyncTrigger;
  runId: string;
  objectType?: ObjectType;
  mode?: SyncMode;
  /** Companies-only legacy flag — full sweep ignoring `lastSyncAt.companies`.
   *  When `mode` is set explicitly it takes precedence. */
  fullSync?: boolean;
  sseEmitter?: SseEmitter;
  /** Backfill-mode window endpoints in epoch ms (deals, Phase 4). */
  windowFrom?: number | null;
  windowTo?: number | null;
  /** Backfill-mode field selector (D21, deals, Phase 4). */
  windowField?: 'hs_lastmodifieddate' | 'createdate';
}

export async function runSync(options: RunSyncOptions): Promise<SyncStats> {
  const objectType: ObjectType = options.objectType ?? 'companies';
  if (objectType === 'companies') return runCompaniesSync(options);
  if (objectType === 'deals') return runDealsSync(options);
  // Exhaustiveness: TS narrows to never here, but a runtime guard keeps the
  // route layer honest if a typo slips through validation.
  throw new Error(`runSync: unsupported objectType "${String(objectType)}"`);
}

// Phase 4 wires the deals path; this stub lets the dispatcher and routes
// compile and ship without exposing a half-built sync.
export async function runDealsSync(_options: RunSyncOptions): Promise<SyncStats> {
  throw new Error('Deals sync not yet implemented (lands in Phase 4)');
}

// ── Companies sync (existing behavior, unchanged from pre-refactor) ─────────

export async function runCompaniesSync(options: RunSyncOptions): Promise<SyncStats> {
  const { trigger, sseEmitter, runId } = options;
  // Resolve mode: explicit `mode` wins; else fall back to the legacy
  // `fullSync` flag (true → 'full', false/undefined → 'incremental'). UI
  // triggers default to full so a "Sync now" click sweeps the whole filter
  // (matches pre-refactor behavior).
  const mode: SyncMode = options.mode
    ?? ((options.fullSync ?? trigger === 'ui') ? 'full' : 'incremental');
  const fullSync = mode === 'full';
  const startedAt = new Date().toISOString();

  activeRuns.set(runId, { cancelRequested: false });
  await updateSyncConfig({ inProgress: true });

  const stats: SyncStats = { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
  const errors: Array<{ hsId: string | null; name: string; detail: string }> = [];
  const debugLogs: SyncDebugLog[] = [];
  let resolvedViaFallback = 0;

  // Fail clean when a connection is missing: emit a skipped run rather than
  // letting the first PB/HS API call throw. Keeps History readable and the
  // scheduler dashboard green when tokens are temporarily disconnected — the
  // run self-heals on reconnect because the next scheduler tick re-checks.
  const skip = await checkConnectionsForSkip();
  if (skip) {
    const finishedAt = new Date().toISOString();
    sseEmitter?.({ type: 'done', status: 'skipped', stats, durationMs: 0 });
    await writeSyncHistory({
      startedAt, finishedAt, trigger, status: 'skipped',
      objectType: 'companies', mode,
      stats, errors: [], skipReason: skip,
    });
    await updateSyncConfig({
      lastSyncAt: { companies: finishedAt },
      lastSyncStatus: 'skipped',
      lastSyncStats: stats,
      inProgress: false,
    });
    activeRuns.delete(runId);
    return stats;
  }

  try {
    const [syncConfig, mappings, accountFilter] = await Promise.all([
      getSyncConfig(),
      getFieldMappings(),
      getAccountFilter(),
    ]);

    const filterGroups = accountFilter.enabled ? accountFilter.filterGroups : [];
    const lastSyncAt = fullSync ? undefined : (syncConfig.lastSyncAt?.companies ?? undefined);
    const pbFields = DRY_RUN() ? [] : await pbClient.fetchEntityConfigurations();
    const requiredPBFieldIds = nonClearableFieldIds(pbFields);
    const pbFieldConstraintsById = fieldConstraintsById(pbFields);

    // Heal stale `pbFieldType` against the live PB field metadata before it
    // drives coercion, value pre-loading, or auto-provisioning. Pre-1.0.10 the
    // MapFields tab could save mappings whose pbFieldType was overwritten from
    // the HS source type — e.g. an HS single-select pointed at a PB text
    // destination would land in Firestore as `pbFieldType: 'select'`. The 1.0.10
    // commit healed this in the UI at load time, but the saved doc stays wrong
    // until the user opens that tab and re-saves. Without this server-side
    // heal, sync time:
    //   - tries to pre-load /values for a non-select field (404)
    //   - POSTs `{ name: '…' }` to a non-select field → 400 "is not a select-type field"
    //   - emits `{ name: 'Foo' }` payloads PB rejects with 422 "Invalid format
    //     for attribute '' in field with ID …"
    // Heal in-memory only — don't write back to Firestore (the UI fix already
    // does that the next time the user touches MapFields).
    if (pbFields.length > 0) {
      const pbFieldTypeById = new Map(pbFields.map(f => [f.id, f.type]));
      for (const m of mappings) {
        if (!m.pbFieldId) continue;
        const liveType = pbFieldTypeById.get(m.pbFieldId);
        if (liveType && liveType !== m.pbFieldType) {
          console.warn(
            `Healing stale pbFieldType for ${m.hubspotProperty} → ${m.pbFieldId}: saved='${m.pbFieldType}', live='${liveType}'`
          );
          m.pbFieldType = liveType;
        }
      }
    }

    // Build the field values cache for select/multiselect mappings
    const valuesCache: PBFieldValuesCache = new Map();
    for (const mapping of mappings) {
      if (!mapping.enabled && !mapping.locked) continue;
      if (mapping.pbFieldType === 'select' || mapping.pbFieldType === 'multiselect') {
        if (!valuesCache.has(mapping.pbFieldId) && !DRY_RUN()) {
          try {
            const values = await pbClient.listFieldValues(mapping.pbFieldId);
            valuesCache.set(mapping.pbFieldId, new Map(values.map(v => [v.fields.name, v.id])));
          } catch (e) {
            console.warn(`Could not pre-load values for field ${mapping.pbFieldId}:`, e);
          }
        }
      }
    }

    // Pre-fetch the PB workspace member directory once when any active
    // mapping targets a PB member field (D20). Single source of truth for
    // owner gating across companies AND deals — both runs read through
    // `buildPbMemberEmailSetCached` (60s TTL, D27) so two scheduler jobs
    // firing seconds apart on the same warm instance share one round-trip.
    let memberEmails: Set<string> | undefined;
    const needsMembers = mappings.some(m =>
      (m.enabled || m.locked) && (m.pbFieldType === 'member' || m.pbFieldType === 'multimember')
    );
    if (needsMembers && !DRY_RUN()) {
      try {
        memberEmails = await pbClient.buildPbMemberEmailSetCached();
      } catch (e) {
        console.warn('Could not pre-load PB members for owner validation:', e);
        memberEmails = new Set();
      }
    }

    // Pre-fetch HS owner directory once when any active mapping reads from
    // an owner-id source (`hubspot_owner_id`, `hs_user_ids_of_all_owners`,
    // …). Builds two maps in one paginated walk — owner.id → email and
    // owner.userId → email — so the mapper's resolveOwnerIdsToEmails is O(1)
    // per row. Requires `crm.objects.owners.read` scope on the HS token; on
    // auth/network failure we proceed with empty maps so resolution skips
    // cleanly rather than failing the run. Memoized variant (60s TTL, D27)
    // is shared with runDealsSync so overlapping schedulers don't duplicate.
    let ownerIdToEmail: Map<string, string> | undefined;
    let userIdToEmail: Map<string, string> | undefined;
    const needsOwnerLookup = mappings.some(m =>
      (m.enabled || m.locked) && detectOwnerIdField(m.hubspotProperty) !== null
    );
    if (needsOwnerLookup && !DRY_RUN()) {
      try {
        const maps = await fetchOwnerEmailMapsCached();
        ownerIdToEmail = maps.ownerIdToEmail;
        userIdToEmail = maps.userIdToEmail;
      } catch (e) {
        console.warn('Could not pre-load HS owners for id → email resolution (likely missing crm.objects.owners.read scope):', e);
        ownerIdToEmail = new Map();
        userIdToEmail = new Map();
      }
    }

    // Pre-fetch HS property options when any active mapping targets a PB
    // select / multiselect field. Builds a propertyName → (value → label) map
    // so HubSpot internal values like "academic_programs" become display labels
    // like "Academic Programs" before they're written to PB.
    let hsPropertyOptions: Map<string, Map<string, string>> | undefined;
    const needsOptions = mappings.some(m =>
      (m.enabled || m.locked) && (m.pbFieldType === 'select' || m.pbFieldType === 'multiselect')
    );
    if (needsOptions && !DRY_RUN()) {
      try {
        const props = await fetchProperties();
        hsPropertyOptions = new Map();
        for (const p of props) {
          if (p.options && p.options.length > 0) {
            hsPropertyOptions.set(p.name, new Map(p.options.map(o => [o.value, o.label])));
          }
        }
      } catch (e) {
        console.warn('Could not pre-load HS property options for label resolution:', e);
      }
    }

    // Walk every PB company once and build dedup maps client-side. PB's
    // search endpoint does not yet honor metadata filters (see dedup.ts), so
    // per-record search would silently match the wrong entity.
    const companyMaps = buildCompanyMaps(await pbClient.listCompanies());

    const allCompanies = await fetchCompanies({
      filterGroups,
      properties: mappings.map(m => m.hubspotProperty),
      lastSyncAt,
    });

    stats.fetched = allCompanies.length;

    const emit = (event: SyncEvent) => sseEmitter?.(event);

    // Process in batches of CONCURRENCY
    for (let i = 0; i < allCompanies.length; i += CONCURRENCY) {
      const ctx = activeRuns.get(runId);
      if (ctx?.cancelRequested) break;

      const batch = allCompanies.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (company) => {
        const debug: Partial<SyncDebugLog> = {
          hsId: company.id,
          name: company.properties.name ?? company.id,
        };
        try {
          const existing = findExistingCompany(company, syncConfig, companyMaps);
          const fields = buildCompanyFieldsPayload(company, mappings, {
            memberEmails,
            ownerIdToEmail,
            userIdToEmail,
            nonClearableFieldIds: requiredPBFieldIds,
            fieldConstraintsById: pbFieldConstraintsById,
            hsPropertyOptions,
            onMemberSkipped: () => { stats.ownerSkipped = (stats.ownerSkipped ?? 0) + 1; },
          });

          if (DRY_RUN()) {
            console.log(`[DRY_RUN] would ${existing ? 'update' : 'create'} entity for ${company.properties.name ?? company.id}`);
            stats.skipped++;
            emit({ type: 'record', status: 'skipped', name: company.properties.name ?? company.id, hsId: company.id, detail: 'dry-run' });
            return;
          }

          // Auto-provision any select / multi-select values that don't yet
          // exist on the PB field — without this, PB rejects the write with
          // 422 selectOption.notFound (verified live, May 2026).
          await provisionMissingValues(fields, mappings, valuesCache);

          if (existing) {
            const patch = buildPatchOperations(fields, requiredPBFieldIds);
            const updatePayload = existing.resolvedViaFallback
              ? {
                  data: {
                    ...(patch.length && { patch }),
                    metadata: { source: { system: 'hubspot', recordId: company.id } },
                  },
                }
              : { data: { patch } };

            debug.action = 'update';
            debug.pbId = existing.pbId;
            debug.payload = updatePayload;
            await pbClient.updateEntity(existing.pbId, updatePayload);
            if (existing.resolvedViaFallback) resolvedViaFallback++;
            stats.updated++;
            emit({ type: 'record', status: 'updated', name: company.properties.name ?? company.id, hsId: company.id });
          } else {
            const createFields = stripNullFieldValues(fields);
            const createPayload = {
              data: {
                type: 'company',
                fields: createFields,
                metadata: {
                  source: {
                    system: 'hubspot',
                    recordId: company.id,
                    url: `https://app.hubspot.com/contacts/${syncConfig.lastSyncAt?.companies ?? ''}/company/${company.id}`,
                  },
                },
              },
            } as const;
            debug.action = 'create';
            debug.payload = createPayload;
            await pbClient.createEntity(createPayload);
            stats.created++;
            emit({ type: 'record', status: 'created', name: company.properties.name ?? company.id, hsId: company.id });
          }
        } catch (err) {
          stats.errors++;
          const detail = err instanceof Error ? err.message : String(err);
          errors.push({ hsId: company.id, name: company.properties.name ?? company.id, detail });
          if (syncConfig.debugLogging) {
            debugLogs.push({
              at: new Date().toISOString(),
              hsId: debug.hsId ?? null,
              name: debug.name ?? company.id,
              action: debug.action,
              pbId: debug.pbId,
              payload: debug.payload,
              error: serializeError(err),
            });
          }
          emit({ type: 'record', status: 'error', name: company.properties.name ?? company.id, hsId: company.id, detail });
        }
      }));

      const processed = Math.min(i + CONCURRENCY, allCompanies.length);
      emit({
        type: 'progress',
        processed,
        total: allCompanies.length,
        created: stats.created,
        updated: stats.updated,
        skipped: stats.skipped,
        errors: stats.errors,
        rate: 0,
        eta: '',
      });

      await updateSyncConfig({ inProgressStats: { ...stats } });
    }

    const finishedAt = new Date().toISOString();
    const status = errors.length === 0 ? 'success' : errors.length === stats.fetched ? 'failed' : 'partial';

    emit({ type: 'done', status, stats, durationMs: Date.now() - new Date(startedAt).getTime() });

    await writeSyncHistory({
      startedAt,
      finishedAt,
      trigger,
      status,
      objectType: 'companies',
      mode,
      stats,
      errors,
      ...(syncConfig.debugLogging ? { debugLogs } : {}),
      resolvedViaFallback,
    });

    // Note: inProgressStartedAt is intentionally not cleared here. The route's
    // staleness check is gated on inProgress=true, so the previous timestamp
    // becomes irrelevant the moment we set inProgress=false. The next run
    // start overwrites it. Avoids needing FieldValue.delete() plumbing.
    await updateSyncConfig({
      lastSyncAt: { companies: finishedAt },
      lastSyncStatus: status,
      lastSyncStats: stats,
      inProgress: false,
    });

    return stats;
  } catch (err) {
    await updateSyncConfig({ inProgress: false });
    throw err;
  } finally {
    activeRuns.delete(runId);
  }
}
