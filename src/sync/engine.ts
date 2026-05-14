import type { SyncDebugLog, SyncStats, SyncRunError, SyncRunWarning, SyncTrigger, SseEmitter, SyncEvent, ObjectType, SyncMode } from '../types/sync';
import type { CreateNotePayload, NotePatch, PBFieldValuesCache, ProductboardNote, ProductboardTag, ProductboardTagRef } from '../types/productboard';
import {
  getSyncConfig,
  getFieldMappings,
  getAccountFilter,
  getDealsFieldMappings,
  getDealsFilter,
  getHubSpotConfig,
  getPBConfig,
  updateSyncConfig,
  writeSyncHistory,
} from '../lib/firestore';
import { fetchCompanies, fetchDeals, fetchDealAssociations, fetchOwnerEmailMapsCached, fetchProperties } from './hubspot';
import * as pbClient from './productboard';
import { buildCompanyMaps, buildDealNoteMaps, findExistingCompany, findExistingDealNote, parseDealRecordId, type DealNoteIndex } from './dedup';
import { buildCompanyFieldsPayload, buildPatchOperations, detectOwnerIdField, stripNullFieldValues } from './mapper';
import { buildDealNotePayload } from './dealNoteBuilder';
import { patchDealNoteContent } from './notePatcher';
import type { FieldMapping } from '../types/sync';
import type { HubSpotDeal } from '../types/hubspot';
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

// ── Deals sync (Phase 4) ────────────────────────────────────────────────────
//
// Mirrors `runCompaniesSync` shape: skip-on-disconnect, per-batch concurrency,
// SSE events, history record, lastSyncAt cursor. The inner write pipeline
// follows the algorithm in plan-deals-support.md ("Engine algorithm —
// content-lock fallback (N-link safe)" and "Multi-company recordId
// algorithm") verbatim.
//
// Reuses the shared cached helpers from Phase 3 — `buildPbMemberEmailSetCached`
// and `fetchOwnerEmailMapsCached`. Two scheduler invocations on the same warm
// instance share the result for 60s (D27).

function buildHsDealUrl(portalId: string | undefined, dealId: string): string {
  // Canonical HS deal URL. When `portalId` is unknown (the Connect tab is
  // pre-Phase-2 and didn't capture it), drop the segment rather than
  // hardcoding a placeholder — PB shows the URL on the note's source link.
  return portalId
    ? `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`
    : `https://app.hubspot.com/deal/${dealId}`;
}

interface DealTarget {
  companyKey: string | null;
  recordId: string;
  pbCompanyUuid: string;
}

// Exported for unit tests covering the multi-company recordId algorithm
// (plan section "Multi-company recordId algorithm").
export function computeDealTargets(
  deal: HubSpotDeal,
  associations: { primary?: string; all: string[] },
  multiCompany: boolean,
  companyMap: Map<string, string>,
  unassignedPlaceholderUuid: string,
): DealTarget[] {
  if (multiCompany && associations.all.length > 1) {
    return associations.all.map(companyId => ({
      companyKey: companyId,
      recordId: `deal-${deal.id}::company-${companyId}`,
      pbCompanyUuid: companyMap.get(companyId) ?? unassignedPlaceholderUuid,
    }));
  }
  const primary = associations.primary ?? associations.all[0] ?? null;
  return [{
    companyKey: null,
    recordId: `deal-${deal.id}`,
    pbCompanyUuid: primary
      ? (companyMap.get(primary) ?? unassignedPlaceholderUuid)
      : unassignedPlaceholderUuid,
  }];
}

// Existing tags on a PB note as a sorted, deduped name list. Used for D10's
// union-on-PATCH semantics — never subtract tags the user added in PB.
export function existingTagNames(note: ProductboardNote): string[] {
  const tags = note.fields?.tags ?? [];
  const set = new Set<string>();
  for (const t of tags) {
    if (t?.name) set.add(t.name);
  }
  return [...set];
}

export function unionTagNames(existing: string[], requested: string[]): string[] {
  const set = new Set<string>();
  for (const n of existing)  if (n) set.add(n);
  for (const n of requested) if (n) set.add(n);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export async function runDealsSync(options: RunSyncOptions): Promise<SyncStats> {
  const { trigger, sseEmitter, runId } = options;
  // Deals runs default to incremental. Backfill is the explicit window mode
  // (windowFrom/windowTo + windowField); `full` is companies-only and is
  // coerced down to incremental for deals to keep the cursor honest.
  const mode: SyncMode = options.mode === 'backfill'
    ? 'backfill'
    : 'incremental';
  const startedAt = new Date().toISOString();

  activeRuns.set(runId, { cancelRequested: false });
  await updateSyncConfig({ inProgress: true });

  const stats: SyncStats = { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
  const errors: SyncRunError[] = [];
  const warnings: SyncRunWarning[] = [];
  const debugLogs: SyncDebugLog[] = [];

  const skip = await checkConnectionsForSkip();
  if (skip) {
    const finishedAt = new Date().toISOString();
    sseEmitter?.({ type: 'done', status: 'skipped', stats, durationMs: 0 });
    await writeSyncHistory({
      startedAt, finishedAt, trigger, status: 'skipped',
      objectType: 'deals', mode,
      stats, errors: [], skipReason: skip,
    });
    await updateSyncConfig({
      lastSyncAt: { deals: finishedAt },
      lastSyncStatus: 'skipped',
      lastSyncStats: stats,
      inProgress: false,
    });
    activeRuns.delete(runId);
    return stats;
  }

  try {
    const [syncConfig, dealsMappings, dealsFilter, hsConfig] = await Promise.all([
      getSyncConfig(),
      getDealsFieldMappings(),
      getDealsFilter(),
      getHubSpotConfig(),
    ]);

    if (dealsFilter.pipelineId === null) {
      // No pipeline configured — nothing to sync. Emit a skipped run so the
      // UI surfaces the misconfiguration instead of silently producing zero
      // results in a `success` row.
      const finishedAt = new Date().toISOString();
      const skipReason = 'No deal pipeline configured — set one in Deals → Filter';
      sseEmitter?.({ type: 'done', status: 'skipped', stats, durationMs: 0 });
      await writeSyncHistory({
        startedAt, finishedAt, trigger, status: 'skipped',
        objectType: 'deals', mode, stats, errors: [], skipReason,
      });
      await updateSyncConfig({
        lastSyncAt: { deals: finishedAt },
        lastSyncStatus: 'skipped',
        lastSyncStats: stats,
        inProgress: false,
      });
      activeRuns.delete(runId);
      return stats;
    }

    // Shared directories (D20 + D27): fetched through the cached helpers so
    // a deals run that fires seconds after a companies run on the same warm
    // instance reuses the same /v2/members + /crm/v3/owners walks.
    let pbMemberEmails: Set<string>;
    let ownerIdToEmail: Map<string, string>;
    try {
      pbMemberEmails = DRY_RUN() ? new Set() : await pbClient.buildPbMemberEmailSetCached();
    } catch (e) {
      console.warn('runDealsSync: could not pre-load PB members for owner gating:', e);
      pbMemberEmails = new Set();
    }
    try {
      const maps = DRY_RUN()
        ? { ownerIdToEmail: new Map<string, string>(), userIdToEmail: new Map<string, string>() }
        : await fetchOwnerEmailMapsCached();
      ownerIdToEmail = maps.ownerIdToEmail;
    } catch (e) {
      console.warn('runDealsSync: could not pre-load HS owners for id → email resolution:', e);
      ownerIdToEmail = new Map();
    }

    // PB company dedup (HS recordId → PB uuid) — reused from the companies
    // sync. Walks every PB company once, same primitive as runCompaniesSync.
    const companyMaps = DRY_RUN()
      ? { byRecordId: new Map<string, string>(), byDomain: new Map<string, string>() }
      : buildCompanyMaps(await pbClient.listCompanies());

    // Placeholder PB company for deals whose HS company hasn't been synced
    // yet (D5). `getOrCreateUnassignedCompany` is idempotent — looks up by
    // metadata.source first, creates only on miss.
    const { pbUuid: unassignedPlaceholderUuid } = DRY_RUN()
      ? { pbUuid: 'pb-unassigned-dryrun' }
      : await pbClient.getOrCreateUnassignedCompany();

    const filterGroups = dealsFilter.filterGroups ?? [];
    const lastSyncAt = mode === 'backfill'
      ? null
      : (syncConfig.lastSyncAt?.deals ? new Date(syncConfig.lastSyncAt.deals).getTime() : null);

    const deals = await fetchDeals({
      filterGroups,
      pipelineId: dealsFilter.pipelineId,
      stageIds: dealsFilter.stageIds,
      properties: collectDealProperties(dealsMappings),
      lastSyncAt,
      windowFrom: options.windowFrom ?? null,
      windowTo: options.windowTo ?? null,
      windowField: options.windowField,
    });

    stats.fetched = deals.length;

    const associations = deals.length > 0
      ? await fetchDealAssociations(deals.map(d => d.id))
      : new Map<string, { primary?: string; all: string[] }>();

    // Heal pass — re-resolve any placeholder-attached deal notes against the
    // now-current PB company map and the just-fetched associations. Uses
    // `PUT /v2/notes/{id}/relationships/customer` to swap the customer link
    // in-place — no archive + recreate, no data loss. Runs BEFORE the
    // dedup-index walk so the moved notes show up under their new (real)
    // company on the same run.
    if (!DRY_RUN()) {
      try {
        const healed = await healUnassignedNotes({
          unassignedPlaceholderUuid,
          companyByHsId: companyMaps.byRecordId,
          dealAssociations: associations,
        });
        if (healed > 0) console.info(`runDealsSync: healed ${healed} unassigned note(s)`);
      } catch (e) {
        console.warn('runDealsSync: heal pass failed (continuing with main sync):', e);
      }
    }

    // Walk every hubspot-source note once and build the deal-note index.
    // Built AFTER the heal pass so any notes moved off the placeholder are
    // indexed under their resolved company in the same run.
    const dealNoteIndex: DealNoteIndex = DRY_RUN()
      ? new Map()
      : buildDealNoteMaps(await pbClient.listHubspotDealNotes());

    // Pre-flight tag provisioning ONCE per run (D2 + tag-handling contract).
    // Collect every tag name the run will need across staticTags + rule output
    // + tagMappings × every deal, dedup, then call ensureTagsExist once. Names
    // missing from the PB workspace are auto-created via the values endpoint.
    // The engine still intersects each deal's requested set with the resolved
    // cache and increments stats.tagsDropped + warnings for any that failed to
    // provision (per-tag create errors fall back to dropping that tag only).
    const requestedTagNamesPerDeal = new Map<string, string[]>();
    const allRequestedNames = new Set<string>();
    for (const deal of deals) {
      const targets = computeDealTargets(
        deal,
        associations.get(deal.id) ?? { all: [] },
        syncConfig.multiCompanyDealNotes,
        companyMaps.byRecordId,
        unassignedPlaceholderUuid,
      );
      // The same deal lands the same tag set across every target (multi-mode
      // produces N notes from one deal, but tags are deal-level). We compute
      // once and reuse per target below.
      const tagPreview = buildDealNotePayload({
        deal,
        companyPbUuid: targets[0]?.pbCompanyUuid ?? unassignedPlaceholderUuid,
        companyKey: targets[0]?.companyKey ?? null,
        recordId: targets[0]?.recordId ?? `deal-${deal.id}`,
        sourceUrl: buildHsDealUrl(hsConfig.portalId, deal.id),
        tagMappings: dealsMappings.tags,
        bodyMappings: dealsMappings.body,
        rules: dealsMappings.rules,
        staticTags: dealsMappings.staticTags,
        ownerEmail: null,
      });
      requestedTagNamesPerDeal.set(deal.id, tagPreview.tagsToProvision);
      for (const n of tagPreview.tagsToProvision) allRequestedNames.add(n);
    }

    const tagCache = new Map<string, ProductboardTag>();
    const resolvedTags = DRY_RUN() || allRequestedNames.size === 0
      ? new Map<string, ProductboardTag>()
      : await pbClient.ensureTagsExist([...allRequestedNames], tagCache);

    // Track every dropped name once for the warnings field. Per-deal counts
    // still flow into stats.tagsDropped so the UI shows scale.
    const droppedTagNames = new Set<string>();
    for (const name of allRequestedNames) {
      if (!resolvedTags.has(name)) droppedTagNames.add(name);
    }
    if (droppedTagNames.size > 0) {
      warnings.push({
        hsId: null,
        name: 'tags-dropped',
        detail:
          `${droppedTagNames.size} tag name(s) requested by deals failed to auto-provision in PB ` +
          `and were dropped from note writes: ` +
          [...droppedTagNames].sort((a, b) => a.localeCompare(b)).join(', '),
      });
    }

    const emit = (event: SyncEvent) => sseEmitter?.(event);

    for (let i = 0; i < deals.length; i += CONCURRENCY) {
      const ctx = activeRuns.get(runId);
      if (ctx?.cancelRequested) break;

      const batch = deals.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (deal) => {
        const dealName = deal.properties.dealname ?? deal.id;
        const debug: Partial<SyncDebugLog> = { hsId: deal.id, name: dealName };

        try {
          const dealAssocs = associations.get(deal.id) ?? { all: [] };
          const targets = computeDealTargets(
            deal,
            dealAssocs,
            syncConfig.multiCompanyDealNotes,
            companyMaps.byRecordId,
            unassignedPlaceholderUuid,
          );

          const ownerHsId = deal.properties.hubspot_owner_id;
          const ownerEmailRaw = ownerHsId ? ownerIdToEmail.get(String(ownerHsId)) : undefined;
          let ownerEmail: string | null = null;
          if (ownerEmailRaw) {
            if (pbMemberEmails.has(ownerEmailRaw)) {
              ownerEmail = ownerEmailRaw;
            } else {
              // D12 — silently drop the owner; bump stats.ownerSkipped so the
              // History tab surfaces the count.
              stats.ownerSkipped = (stats.ownerSkipped ?? 0) + 1;
            }
          }

          const requestedNames = requestedTagNamesPerDeal.get(deal.id) ?? [];
          const resolvedDealTags: ProductboardTagRef[] = [];
          for (const name of requestedNames) {
            const tag = resolvedTags.get(name);
            if (tag) {
              resolvedDealTags.push({ id: tag.id, name: tag.name });
            } else {
              stats.tagsDropped = (stats.tagsDropped ?? 0) + 1;
            }
          }

          const targetKeys = new Set<string | null>();
          for (const target of targets) {
            targetKeys.add(target.companyKey);
            const existing = findExistingDealNote(deal.id, target.companyKey, dealNoteIndex);

            const built = buildDealNotePayload({
              deal,
              companyPbUuid: target.pbCompanyUuid,
              companyKey: target.companyKey,
              recordId: target.recordId,
              sourceUrl: buildHsDealUrl(hsConfig.portalId, deal.id),
              tagMappings: dealsMappings.tags,
              bodyMappings: dealsMappings.body,
              rules: dealsMappings.rules,
              staticTags: dealsMappings.staticTags,
              ownerEmail,
            });
            // Replace the name-only tag refs with the resolved (id+name)
            // entries so PB doesn't 422 on selectOption.notFound.
            const payload = withResolvedTags(built.payload, resolvedDealTags);

            if (DRY_RUN()) {
              console.log(`[DRY_RUN] would ${existing ? 'update' : 'create'} deal note for ${deal.id} → ${target.recordId}`);
              stats.skipped++;
              emit({ type: 'record', status: 'skipped', name: dealName, hsId: deal.id, detail: 'dry-run' });
              continue;
            }

            if (existing) {
              // Build PATCH semantics: union tags (D10), owner only-when-empty (D11),
              // always update content + name. Content-lock 422 falls back through
              // notePatcher.
              const unionedTags = unionTagNames(existingTagNames(existing), resolvedDealTags.map(t => t.name));
              const tagRefsForPatch: ProductboardTagRef[] = unionedTags.map(name => {
                const resolved = resolvedTags.get(name);
                return resolved ? { id: resolved.id, name } : { name };
              });
              const ownerCurrentlyEmpty = !existing.fields?.owner;
              const patchFields: NotePatch['data']['fields'] = {
                ...(payload.data.fields.name      !== undefined ? { name:    payload.data.fields.name    } : {}),
                ...(payload.data.fields.content   !== undefined ? { content: payload.data.fields.content } : {}),
                ...(tagRefsForPatch.length > 0    ? { tags: tagRefsForPatch } : {}),
                ...(ownerEmail && ownerCurrentlyEmpty ? { owner: { email: ownerEmail } } : {}),
              };

              const patch: NotePatch = { data: { fields: patchFields } };
              debug.action = 'update';
              debug.pbId = existing.id;
              debug.payload = patch;

              const outcome = await patchDealNoteContent(existing.id, patch, {
                forceContentUpdates: syncConfig.forceContentUpdates,
              });
              if (outcome.status === 'patched-without-content') {
                stats.contentSkipped = (stats.contentSkipped ?? 0) + 1;
              } else if (outcome.status === 'patched-via-relink') {
                stats.snippetsStripped = (stats.snippetsStripped ?? 0) + (outcome.linksRecycled ?? 0);
              }
              stats.updated++;
              emit({ type: 'record', status: 'updated', name: dealName, hsId: deal.id });
            } else {
              debug.action = 'create';
              debug.payload = payload;
              await pbClient.createDealNote(payload);
              stats.created++;
              emit({ type: 'record', status: 'created', name: dealName, hsId: deal.id });
            }
          }

          // Archive existing notes whose company key fell out of the target
          // set (D6 — multi → single flip, or company association removed in
          // HS). Hard-delete is intentionally avoided.
          const existingForDeal = dealNoteIndex.get(deal.id);
          if (existingForDeal && !DRY_RUN()) {
            for (const [existingKey, existingNote] of existingForDeal) {
              if (targetKeys.has(existingKey)) continue;
              try {
                const staleTags = unionTagNames(existingTagNames(existingNote), ['stale-association']);
                const staleTagsResolved: ProductboardTagRef[] = staleTags.map(name => {
                  const resolved = resolvedTags.get(name);
                  return resolved ? { id: resolved.id, name } : { name };
                });
                const archivePatch: NotePatch = {
                  data: {
                    fields: { archived: true, tags: staleTagsResolved },
                  },
                };
                await pbClient.patchDealNote(existingNote.id, archivePatch);
                stats.archived = (stats.archived ?? 0) + 1;
              } catch (archiveErr) {
                // Don't let an archive failure mask the create/update successes
                // for this deal — record the warning and continue.
                const detail = archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
                warnings.push({
                  hsId: deal.id,
                  name: dealName,
                  detail: `Failed to archive stale note ${existingNote.id}: ${detail}`,
                });
              }
            }
          }
        } catch (err) {
          stats.errors++;
          const detail = err instanceof Error ? err.message : String(err);
          errors.push({ hsId: deal.id, name: dealName, detail });
          if (syncConfig.debugLogging) {
            debugLogs.push({
              at: new Date().toISOString(),
              hsId: debug.hsId ?? null,
              name: debug.name ?? deal.id,
              action: debug.action,
              pbId: debug.pbId,
              payload: debug.payload,
              error: serializeError(err),
            });
          }
          emit({ type: 'record', status: 'error', name: dealName, hsId: deal.id, detail });
        }
      }));

      const processed = Math.min(i + CONCURRENCY, deals.length);
      emit({
        type: 'progress',
        processed,
        total: deals.length,
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
    const status = errors.length === 0
      ? 'success'
      : errors.length === stats.fetched
      ? 'failed'
      : 'partial';

    emit({ type: 'done', status, stats, durationMs: Date.now() - new Date(startedAt).getTime() });

    await writeSyncHistory({
      startedAt,
      finishedAt,
      trigger,
      status,
      objectType: 'deals',
      mode,
      stats,
      errors,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(syncConfig.debugLogging ? { debugLogs } : {}),
    });

    // Backfill runs explicitly do NOT advance the incremental cursor — the
    // window is one-shot and arbitrary, so anchoring on its endpoint would
    // skip records modified outside the window since the last incremental.
    const cursorUpdate = mode === 'backfill'
      ? {}
      : { lastSyncAt: { deals: finishedAt } };

    await updateSyncConfig({
      ...cursorUpdate,
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

// Replace the bare `{name}` tag refs produced by the builder with the
// resolved `{id, name}` refs from `ensureTagsExist`. PB rejects unknown tag
// names with `selectOption.notFound`; only the resolved set is safe to send.
function withResolvedTags(payload: CreateNotePayload, resolved: ProductboardTagRef[]): CreateNotePayload {
  if (resolved.length === 0) {
    const fields = { ...payload.data.fields };
    delete fields.tags;
    return { data: { ...payload.data, fields } };
  }
  return {
    data: {
      ...payload.data,
      fields: { ...payload.data.fields, tags: resolved },
    },
  };
}

// Properties to fetch on each deal: defaults from the HS deal client plus
// every property referenced by tag/body/rule mappings. Dedups to keep the
// search payload compact.
function collectDealProperties(mappings: { tags: { hsField: string }[]; body: { hsField: string }[]; rules: { field: string }[] }): string[] {
  const set = new Set<string>([
    'dealname', 'dealstage', 'pipeline', 'amount', 'closedate',
    'hubspot_owner_id', 'hs_lastmodifieddate', 'createdate', 'description',
    'hs_is_closed_won', 'hs_is_closed',
  ]);
  for (const m of mappings.tags) if (m.hsField) set.add(m.hsField);
  for (const m of mappings.body) if (m.hsField) set.add(m.hsField);
  for (const m of mappings.rules) if (m.field)  set.add(m.field);
  return [...set];
}

// ── Heal pass (D5) ──────────────────────────────────────────────────────────
//
// Re-resolves any deal note currently attached to the unassigned placeholder
// against the now-current PB company map. Called as the first step of every
// runDealsSync (and exported for direct use by tests / future cron jobs).
//
// Uses `PUT /v2/notes/{id}/relationships/customer` (operationId
// `replaceNoteCustomerRelationship`, openapi v2 public API/notes.yaml) to
// swap the customer link in-place — the spec guarantees a note has at most
// one customer relationship, and PUT replaces it. No archive + recreate
// cycle, no data loss: the note id, content, tags, owner, and feature
// relationships are all preserved across the move.
//
// Single-mode (recordId `deal-<id>`) notes don't carry the HS company id, so
// the heal needs the most-recent associations. The caller passes them in
// via `dealAssociations` when available (the main runDealsSync collects
// them right after fetchDeals). Notes whose deal isn't in the current
// association map are skipped — their customer link will heal on the next
// run that fetches the deal.

interface HealContext {
  unassignedPlaceholderUuid: string;
  companyByHsId: Map<string, string>;
  dealAssociations?: Map<string, { primary?: string; all: string[] }>;
}

export async function healUnassignedNotes(ctx: HealContext): Promise<number> {
  // Walk every hubspot-source note. PB's notes index does not expose a
  // customer-id filter, so we filter client-side via getDealNoteRelationships
  // per candidate note. Archived notes are skipped.
  const notes = await pbClient.listHubspotDealNotes();

  let healed = 0;
  for (const note of notes) {
    if (note.fields?.archived) continue;

    const recordId = note.metadata?.source?.recordId;
    if (!recordId) continue;
    const parsed = parseDealRecordId(recordId);
    if (!parsed) continue;

    let rels: typeof note.relationships;
    try {
      rels = await pbClient.getDealNoteRelationships(note.id);
    } catch (e) {
      console.warn(`healUnassignedNotes: failed to read relationships for note ${note.id}:`, e);
      continue;
    }
    const customerRel = rels?.find(r => r.type === 'customer');
    if (!customerRel || customerRel.target.id !== ctx.unassignedPlaceholderUuid) continue;

    // Resolve target HS company id:
    //   - multi-mode (`deal-X::company-Y`) → companyKey is the HS id directly
    //   - single-mode (`deal-X`)           → look up the deal's primary
    //     association in the run-scoped map; fall back to any associated
    //     company. Without the map (e.g. caller didn't pass one), we can't
    //     resolve and leave the note for the next run.
    let resolvedHsCompanyId: string | null = null;
    if (parsed.companyKey) {
      resolvedHsCompanyId = parsed.companyKey;
    } else if (ctx.dealAssociations) {
      const a = ctx.dealAssociations.get(parsed.dealId);
      resolvedHsCompanyId = a?.primary ?? a?.all[0] ?? null;
    }
    if (!resolvedHsCompanyId) continue;

    const resolvedPbUuid = ctx.companyByHsId.get(resolvedHsCompanyId);
    if (!resolvedPbUuid || resolvedPbUuid === ctx.unassignedPlaceholderUuid) continue;

    try {
      await pbClient.setDealNoteCustomer(note.id, { type: 'company', id: resolvedPbUuid });
      healed++;
    } catch (e) {
      console.warn(`healUnassignedNotes: failed to move customer link for note ${note.id}:`, e);
    }
  }

  return healed;
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
