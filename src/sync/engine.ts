import type { SyncDebugLog, SyncStats, SyncTrigger, SseEmitter, SyncEvent } from '../types/sync';
import type { PBFieldValuesCache } from '../types/productboard';
import {
  getSyncConfig,
  getFieldMappings,
  getAccountFilter,
  updateSyncConfig,
  writeSyncHistory,
} from '../lib/firestore';
import { fetchCompanies, fetchOwnerEmailMaps } from './hubspot';
import * as pbClient from './productboard';
import { buildCompanyMaps, findExistingEntity } from './dedup';
import { buildFieldsPayload, buildPatchOperations, detectOwnerIdField, stripNullFieldValues } from './mapper';
import type { FieldMapping } from '../types/sync';
import type { PBField, PBFieldValue } from '../types/productboard';
import { ApiError } from './rateLimit';

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

export async function runSync(options: {
  trigger: SyncTrigger;
  fullSync?: boolean;
  sseEmitter?: SseEmitter;
  runId: string;
}): Promise<SyncStats> {
  const { trigger, fullSync = trigger === 'ui', sseEmitter, runId } = options;
  const startedAt = new Date().toISOString();

  activeRuns.set(runId, { cancelRequested: false });
  await updateSyncConfig({ inProgress: true });

  const stats: SyncStats = { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
  const errors: Array<{ hsId: string | null; name: string; detail: string }> = [];
  const debugLogs: SyncDebugLog[] = [];
  let resolvedViaFallback = 0;

  try {
    const [syncConfig, mappings, accountFilter] = await Promise.all([
      getSyncConfig(),
      getFieldMappings(),
      getAccountFilter(),
    ]);

    const filterGroups = accountFilter.enabled ? accountFilter.filterGroups : [];
    const lastSyncAt = fullSync ? undefined : syncConfig.lastSyncAt;
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

    // Pre-fetch the workspace member directory once when any active mapping
    // targets a PB member field, so per-row email validation is O(1).
    let memberEmails: Set<string> | undefined;
    const needsMembers = mappings.some(m =>
      (m.enabled || m.locked) && (m.pbFieldType === 'member' || m.pbFieldType === 'multimember')
    );
    if (needsMembers && !DRY_RUN()) {
      try {
        memberEmails = await pbClient.listMemberEmails();
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
    // cleanly rather than failing the run.
    let ownerIdToEmail: Map<string, string> | undefined;
    let userIdToEmail: Map<string, string> | undefined;
    const needsOwnerLookup = mappings.some(m =>
      (m.enabled || m.locked) && detectOwnerIdField(m.hubspotProperty) !== null
    );
    if (needsOwnerLookup && !DRY_RUN()) {
      try {
        const maps = await fetchOwnerEmailMaps();
        ownerIdToEmail = maps.ownerIdToEmail;
        userIdToEmail = maps.userIdToEmail;
      } catch (e) {
        console.warn('Could not pre-load HS owners for id → email resolution (likely missing crm.objects.owners.read scope):', e);
        ownerIdToEmail = new Map();
        userIdToEmail = new Map();
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
          const existing = findExistingEntity(company, syncConfig, companyMaps);
          const fields = buildFieldsPayload(company, mappings, {
            memberEmails,
            ownerIdToEmail,
            userIdToEmail,
            nonClearableFieldIds: requiredPBFieldIds,
            fieldConstraintsById: pbFieldConstraintsById,
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
                    url: `https://app.hubspot.com/contacts/${syncConfig.lastSyncAt ?? ''}/company/${company.id}`,
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
      stats,
      errors,
      ...(syncConfig.debugLogging ? { debugLogs } : {}),
      resolvedViaFallback,
    });

    await updateSyncConfig({
      lastSyncAt: finishedAt,
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
