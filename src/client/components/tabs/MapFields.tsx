import { useEffect, useRef, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, Lock, Plus, CheckCircle, RefreshCw } from 'lucide-react';
import { useConfig, useSaveConfig, useHSProperties, usePBFields } from '../../hooks/api';
import type { FieldMapping } from '../../../types/sync';
import type { PBFieldType } from '../../../types/productboard';

// Maps an HS property to the default PB destination type when the user picks
// the HS source first. Routes textarea / html / richtext sources to PB
// rich-text (description), keeping auto-set behaviour aligned with
// hsLogicalType + COMPATIBILITY.
function hsTypeToPBFieldType(p: { type?: string; fieldType?: string } | undefined): PBFieldType | null {
  if (!p?.type) return null;
  const t = p.type, ft = (p.fieldType ?? '').toLowerCase();
  if (t === 'enumeration') return ft === 'checkbox' ? 'multiselect' : 'select';
  if (t === 'string') return (ft === 'textarea' || ft === 'html' || ft === 'richtext') ? 'richtext' : 'text';
  if (t === 'phone_number') return 'text';
  if (t === 'number') return 'number';
  if (t === 'bool') return 'boolean';
  if (t === 'date' || t === 'datetime') return 'date';
  return null;
}

// Order in which type-groups appear inside each HS dropdown, with friendlier
// labels than the raw HubSpot type tokens. Grouping keys are derived from
// hsLogicalType so the visual buckets stay in lockstep with the pair-compat
// matrix — plain text fields show under "Text"; long-text (textarea), HTML,
// and rich-text fields show under "Rich text" and pair with PB description
// targets. Phone numbers get their own bucket for clarity even though they
// pair as `text` logically.
const HS_TYPE_ORDER = [
  'text', 'richtext', 'phone', 'number', 'select', 'multiselect', 'boolean', 'date',
] as const;
const HS_TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  richtext: 'Rich text',
  phone: 'Phone',
  number: 'Number',
  select: 'Single-select',
  multiselect: 'Multi-select',
  boolean: 'Boolean',
  date: 'Date',
};

// Visual grouping key for the HS dropdown. Mostly hsLogicalType, plus a
// dedicated "phone" bucket since phone numbers fall under text logically but
// deserve their own optgroup in the UI.
function hsGroupKey(p: { type?: string; fieldType?: string } | undefined): string {
  if (p?.type === 'phone_number') return 'phone';
  return hsLogicalType(p) || 'other';
}

const PB_TYPE_ORDER: PBFieldType[] = ['text', 'richtext', 'number', 'select', 'multiselect', 'date', 'boolean', 'member', 'multimember'];
const PB_TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  richtext: 'Description',
  number: 'Number',
  select: 'Select',
  multiselect: 'Multi-select',
  date: 'Date',
  boolean: 'Boolean',
  member: 'Member',
  multimember: 'Multi-member',
};

// Cross-system "logical" type used to gate which HubSpot ↔ Productboard
// pairs are valid. Both sides resolve into one of these buckets, then
// COMPATIBILITY decides which buckets can pair.
type LogicalType =
  | 'text'
  | 'richtext'
  | 'number'
  | 'date'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'member'
  | 'multimember';

// HubSpot enumeration covers both single- and multi-select; the disambiguator
// is `fieldType` ('checkbox' = multi, anything else = single). For text:
// `textarea` (long text), `html`, and `richtext` all route to PB rich-text
// (description) — long text often overflows PB's 2000-char plain-text cap and
// belongs in description. `object_coordinates` (lat/long) is a stringified
// pair, treat as text.
function hsLogicalType(p: { type?: string; fieldType?: string } | undefined): LogicalType | null {
  if (!p) return null;
  const t = p.type, ft = (p.fieldType ?? '').toLowerCase();
  if (t === 'enumeration') return ft === 'checkbox' ? 'multiselect' : 'select';
  if (t === 'string') return (ft === 'textarea' || ft === 'html' || ft === 'richtext') ? 'richtext' : 'text';
  if (t === 'phone_number' || t === 'object_coordinates') return 'text';
  if (t === 'number') return 'number';
  if (t === 'bool') return 'boolean';
  if (t === 'date' || t === 'datetime') return 'date';
  return null;
}

function pbLogicalType(f: { type?: PBFieldType | null } | undefined): LogicalType | null {
  if (!f || !f.type) return null;
  // PBFieldType already aligns 1:1 with LogicalType for every value PB exposes.
  return f.type as LogicalType;
}

// "X can be paired with these types" — applied symmetrically: whichever side
// the user picks first, the other side filters by COMPATIBILITY[that type].
// Boolean serializes cleanly to "true"/"false" as text or as a select value
// (engine auto-provisions unknown select values), so it accepts both fallbacks.
// member/multimember accept text sources because the runtime extracts emails
// via regex and validates them against the PB workspace member directory
// (skipping rows whose email isn't a real member).
const COMPATIBILITY: Record<LogicalType, LogicalType[]> = {
  text:        ['text', 'member', 'multimember'],
  richtext:    ['richtext'],
  number:      ['number', 'text'],
  date:        ['date', 'text'],
  boolean:     ['boolean', 'text', 'select'],
  select:      ['select', 'text', 'boolean'],
  multiselect: ['multiselect', 'text', 'multimember'],
  member:      ['member', 'text'],
  multimember: ['multimember', 'text', 'multiselect'],
};

function isCompatible(a: LogicalType | null, b: LogicalType | null): boolean {
  if (!a || !b) return true; // no constraint until both sides have a known type
  return COMPATIBILITY[a].includes(b);
}

// HubSpot doesn't tag company-level text fields with a semantic "email" type,
// so we can't tell from the HS schema alone whether a text field actually
// holds emails. To avoid pointing arbitrary text (HQ, Industry, …) at PB
// member targets, we gate text → member on the property *name* matching an
// email-ish pattern. Matches `email`, `*_email`, `*email` as a suffix.
function isLikelyEmailHSProp(p: { name?: string } | undefined): boolean {
  if (!p?.name) return false;
  const n = p.name.toLowerCase();
  return n === 'email' || /(^|_)email($|s?$)/.test(n) || n.endsWith('email');
}

// Owner-id source detection — mirrors detectOwnerIdField in src/sync/mapper.ts.
// At sync time these are resolved to emails via /crm/v3/owners; in the UI we
// just need to know "this source can be treated as email-bearing for the
// purposes of pair compatibility against PB member targets".
function isOwnerIdHSProp(p: { name?: string } | undefined): boolean {
  if (!p?.name) return false;
  const n = p.name.toLowerCase();
  if (/user_ids?_of_/.test(n) || /(^|_)user_ids?$/.test(n)) return true;
  if (n === 'hubspot_owner_id' || n === 'hs_all_owner_ids' || /(^|_)owner_ids?$/.test(n)) return true;
  return false;
}

// Pair-level check that layers data-source verifiability on top of the
// logical-type compat matrix. Two extra guards:
// 1. text → member/multimember: HS prop name must imply email content.
// 2. select → member or multiselect → multimember: only allowed when HS
//    source is an owner/user-id field (resolved to email at sync time).
function isPairAllowed(
  hsProp: { name?: string; type?: string; fieldType?: string } | undefined,
  pbField: { type?: PBFieldType | null } | undefined
): boolean {
  const hsLT = hsLogicalType(hsProp);
  const pbLT = pbLogicalType(pbField);

  // Owner-id sources unlock select → member and multiselect → multimember
  // even though they aren't in the static COMPATIBILITY table.
  if (hsLT === 'select' && pbLT === 'member' && isOwnerIdHSProp(hsProp)) return true;
  if (hsLT === 'multiselect' && pbLT === 'multimember' && isOwnerIdHSProp(hsProp)) return true;

  if (!isCompatible(hsLT, pbLT)) return false;

  if ((pbLT === 'member' || pbLT === 'multimember') && hsLT === 'text') {
    return isLikelyEmailHSProp(hsProp);
  }
  return true;
}

function groupByType<T>(
  items: T[],
  getType: (x: T) => string | null | undefined,
  order: readonly string[]
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {};
  for (const it of items) {
    const t = getType(it) || 'other';
    (groups[t] ??= []).push(it);
  }
  const ordered: Array<[string, T[]]> = [];
  for (const t of order) if (groups[t]?.length) ordered.push([t, groups[t]!]);
  for (const t of Object.keys(groups).sort()) {
    if (!order.includes(t)) ordered.push([t, groups[t]!]);
  }
  return ordered;
}

import Badge from '../ui/Badge';
import Code from '../ui/Code';
import InlineAlert from '../ui/InlineAlert';
import SearchableSelect from '../ui/SearchableSelect';

interface MappingFormValues {
  mappings: FieldMapping[];
}

function getStatusBadge(mapping: FieldMapping, hsProps: any[], pbFields: any[]) {
  if (!mapping.pbFieldId || !mapping.pbFieldType) return null;

  const hsProp = hsProps.find((p: any) => p.name === mapping.hubspotProperty);
  const pbField = pbFields.find((f: any) => f.id === mapping.pbFieldId);

  if (mapping.pbFieldType === 'richtext') {
    return <Badge variant="purple">✨ Sanitized as HTML</Badge>;
  }

  if (mapping.pbFieldType === 'select' || mapping.pbFieldType === 'multiselect') {
    return <Badge variant="purple">✨ Auto-provisions values</Badge>;
  }

  // Catches incompatible pairs that pre-date the dropdown filtering — the new
  // dropdowns shouldn't let users create these going forward, but old configs
  // loaded from Firestore might still contain them.
  if (hsProp && pbField) {
    if (hsProp && pbField && !isPairAllowed(hsProp, pbField)) {
      return <Badge variant="warning">⚠ Type mismatch</Badge>;
    }
  }

  return <span>—</span>;
}

export default function MapFields() {
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useConfig();
  const { data: rawHSProps, isFetching: hsFetching } = useHSProperties();
  const { data: rawPBFields, isFetching: pbFetching } = usePBFields();
  // Defend against the cache temporarily holding a non-array (e.g. an error
  // body that slipped past `setQueryData`) — without this, every render path
  // that calls `.find`/`.filter` crashes the whole tab via the ErrorBoundary.
  // Also self-heal: if the cached value is bad, evict it so react-query refetches.
  const hsProps = Array.isArray(rawHSProps) ? rawHSProps : [];
  const pbFields = Array.isArray(rawPBFields) ? rawPBFields : [];
  useEffect(() => {
    if (rawHSProps !== undefined && !Array.isArray(rawHSProps)) {
      queryClient.removeQueries({ queryKey: ['hs-properties'] });
    }
    if (rawPBFields !== undefined && !Array.isArray(rawPBFields)) {
      queryClient.removeQueries({ queryKey: ['pb-fields'] });
    }
  }, [rawHSProps, rawPBFields, queryClient]);
  const saveConfig = useSaveConfig();
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const refreshing = forceRefreshing || hsFetching || pbFetching;

  // Bypass the 1h server-side cache by hitting the routes with ?refresh=true,
  // then seed the react-query cache so the dropdowns repopulate immediately.
  // Any non-array response (e.g. a 5xx error body from the upstream API) is
  // discarded — stuffing `{error: '…'}` into the cache crashes the table on
  // the next render with `.find is not a function`.
  const refreshFieldOptions = async () => {
    setForceRefreshing(true);
    try {
      const [hsRes, pbRes] = await Promise.all([
        fetch('/api/hubspot/properties?refresh=true', { headers: { Accept: 'application/json' } }),
        fetch('/api/productboard/fields?refresh=true', { headers: { Accept: 'application/json' } }),
      ]);
      if (hsRes.ok) {
        const hs = await hsRes.json();
        if (Array.isArray(hs)) queryClient.setQueryData(['hs-properties'], hs);
      }
      if (pbRes.ok) {
        const pb = await pbRes.json();
        if (Array.isArray(pb)) queryClient.setQueryData(['pb-fields'], pb);
      }
    } finally {
      setForceRefreshing(false);
    }
  };

  const { control, watch, reset, handleSubmit, setValue } = useForm<MappingFormValues>({
    defaultValues: { mappings: config?.fieldMappings.mappings ?? [] },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'mappings' });
  const watchedMappings = watch('mappings');

  // Seed the form from the server config once. Don't re-seed on every config
  // refetch (e.g. post-save invalidation) — the form already matches what was
  // just saved, and re-running reset() during a successful-save render
  // destabilizes the "Mappings saved." alert.
  // Pre-1.0.10 configs may have a stale pbFieldType (set from the HS source
  // when an HS dropdown was last touched) that disagrees with the actual PB
  // field's type. Heal those at load time so the badge logic and any
  // pbFieldType-driven sync paths use the destination's real type. Wait until
  // pbFields has loaded so the lookup can succeed.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    if (!config?.fieldMappings.mappings) return;
    if (!pbFields) return;
    const healed = config.fieldMappings.mappings.map((m: any) => {
      if (!m.pbFieldId) return m;
      const pbField = pbFields.find((f: any) => f.id === m.pbFieldId);
      if (!pbField || pbField.type === m.pbFieldType) return m;
      return { ...m, pbFieldType: pbField.type };
    });
    reset({ mappings: healed });
    initializedRef.current = true;
  }, [config, pbFields, reset]);

  // Auto-dismiss the saved/failed indicator after a moment so it
  // doesn't linger and imply that subsequent unsaved edits are persisted.
  useEffect(() => {
    if (!saveConfig.isSuccess && !saveConfig.isError) return;
    const t = setTimeout(() => saveConfig.reset(), 2500);
    return () => clearTimeout(t);
  }, [saveConfig.isSuccess, saveConfig.isError, saveConfig.reset]);

  // Clear the indicator immediately when the user edits anything,
  // since the displayed config no longer matches what's saved. Only react
  // to user-initiated change events — programmatic resets emit no type.
  useEffect(() => {
    const sub = watch((_, { type }) => {
      if (type !== 'change') return;
      if (saveConfig.isSuccess || saveConfig.isError) saveConfig.reset();
    });
    return () => sub.unsubscribe();
  }, [watch, saveConfig.isSuccess, saveConfig.isError, saveConfig.reset]);

  // pbFields is already a flat Array<{id, name, type, schema}> from /api/productboard/fields.
  const allPBFields = pbFields;

  // Sets of HS properties / PB fields already used by some row, so each
  // dropdown can hide them — except its own current selection.
  const usedHSProps = new Set(
    watchedMappings.map((m: any) => m?.hubspotProperty).filter(Boolean) as string[]
  );
  const usedPBFields = new Set(
    watchedMappings.map((m: any) => m?.pbFieldId).filter(Boolean) as string[]
  );

  const onSave = handleSubmit(async (values) => {
    await saveConfig.mutateAsync({ fieldMappings: { mappings: values.mappings } });
  });

  const onReset = () => {
    reset({
      mappings: [
        { hubspotProperty: 'name',   pbFieldId: 'name',   pbFieldType: 'text', enabled: true, locked: true },
        { hubspotProperty: 'domain', pbFieldId: 'domain', pbFieldType: 'text', enabled: true, locked: true },
      ],
    });
  };

  if (isLoading) return <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>;

  return (
    <div style={{ paddingBottom: 400 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Map fields</h1>
          <p style={{ color: 'var(--muted-foreground)', fontSize: 14, marginTop: 4 }}>
            Choose which HubSpot company fields sync to Productboard.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {saveConfig.isSuccess && (
            <InlineAlert variant="success">
              <CheckCircle size={16} color="var(--success)" style={{ flexShrink: 0, marginTop: 1, marginRight: 4 }} />
              Mappings saved.
            </InlineAlert>
          )}
          {saveConfig.isError && (
            <InlineAlert variant="destructive">Save failed — try again.</InlineAlert>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onReset}
              style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 14px', background: 'none', cursor: 'pointer', fontSize: 13 }}>
              Reset to defaults
            </button>
            <button type="button" onClick={onSave} disabled={saveConfig.isPending}
              style={{ background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 18px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              {saveConfig.isPending ? 'Saving…' : 'Save mappings'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16 }}>
        {/* Table header */}
        <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 24px 1fr 1fr 32px', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)', alignItems: 'center' }}>
          <span></span>
          <span>HubSpot property</span>
          <span></span>
          <span>Productboard field</span>
          <span>Status</span>
          <button
            type="button"
            onClick={refreshFieldOptions}
            disabled={refreshing}
            title="Refresh dropdown options from HubSpot and Productboard"
            aria-label="Refresh dropdown options"
            style={{
              background: 'none',
              border: 'none',
              cursor: refreshing ? 'default' : 'pointer',
              color: 'var(--muted-foreground)',
              padding: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: refreshing ? 0.6 : 1,
            }}>
            <RefreshCw
              size={13}
              style={{
                animation: refreshing ? 'spin 1s linear infinite' : 'none',
                transformOrigin: 'center',
              }}
            />
          </button>
        </div>

        {fields.map((field, idx) => {
          const mapping = watchedMappings[idx];
          if (!mapping) return null;

          return (
            <div key={field.id}
              style={{ display: 'grid', gridTemplateColumns: '40px 1fr 24px 1fr 1fr 32px', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center', fontSize: 13 }}>

              {/* Enable switch */}
              <Controller control={control} name={`mappings.${idx}.enabled`} render={({ field: f }) => (
                <button type="button" disabled={mapping.locked}
                  onClick={() => !mapping.locked && f.onChange(!f.value)}
                  style={{
                    width: 36, height: 20, borderRadius: 10, border: 'none', cursor: mapping.locked ? 'default' : 'pointer',
                    background: f.value ? 'var(--primary)' : 'var(--muted)', position: 'relative', opacity: mapping.locked ? 0.7 : 1,
                  }}>
                  <span style={{ position: 'absolute', top: 2, left: f.value ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 150ms' }} />
                </button>
              )} />

              {/* HS property */}
              {mapping.locked ? (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {hsProps.find((p: any) => p.name === mapping.hubspotProperty)?.label ?? mapping.hubspotProperty}
                  </div>
                  <Code>{mapping.hubspotProperty}</Code>
                </div>
              ) : (
                <Controller control={control} name={`mappings.${idx}.hubspotProperty`} render={({ field: f }) => {
                  // If PB is already chosen for this row, restrict HS options to
                  // sources that are valid pairs with the PB target. The pair
                  // check enforces both logical-type compat AND the email-name
                  // guard for member targets.
                  const selectedPB = allPBFields.find((fld: any) => fld.id === mapping.pbFieldId);
                  const availableHS = hsProps.filter((p: any) => {
                    if (p.name === mapping.hubspotProperty) return true; // never hide the current pick
                    if (usedHSProps.has(p.name)) return false;
                    return selectedPB ? isPairAllowed(p, selectedPB) : true;
                  });
                  const hsGrouped = groupByType(availableHS, (p: any) => hsGroupKey(p), HS_TYPE_ORDER);
                  const hsGroups = hsGrouped.map(([type, items]) => ({
                    type,
                    label: HS_TYPE_LABELS[type] ?? type,
                    items,
                  }));
                  return (
                    <SearchableSelect
                      value={f.value ?? ''}
                      onChange={(next) => {
                        f.onChange(next);
                        // Only seed pbFieldType from the HS source when no PB
                        // destination is chosen yet (placeholder value). Once
                        // PB is set, its type is the source of truth — see the
                        // inverse onChange below. Without this guard, picking
                        // an HS single-select after the user already chose a
                        // PB text destination would overwrite pbFieldType to
                        // 'select' and trigger the "Auto-provisions values"
                        // badge plus mis-keyed sync-time coercion.
                        if (!mapping.pbFieldId) {
                          const hsProp = hsProps.find((p: any) => p.name === next);
                          setValue(`mappings.${idx}.pbFieldType`, hsProp ? hsTypeToPBFieldType(hsProp) : null);
                        }
                      }}
                      groups={hsGroups}
                      getKey={(p: any) => p.name}
                      getLabel={(p: any) => p.label ?? p.name}
                      getSubLabel={(p: any) => (p.label && p.label !== p.name ? p.name : null)}
                      getSearchText={(p: any) => p.name ?? ''}
                      placeholder="Select a property…"
                      searchPlaceholder="Search HubSpot properties…"
                    />
                  );
                }} />
              )}

              <span style={{ color: 'var(--muted-foreground)', textAlign: 'center' }}>→</span>

              {/* PB field */}
              {mapping.locked ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                  {mapping.pbFieldId}
                  <Lock size={12} style={{ color: 'var(--muted-foreground)' }} />
                </div>
              ) : (
                <Controller control={control} name={`mappings.${idx}.pbFieldId`} render={({ field: f }) => {
                  // If HS is already chosen for this row, restrict PB options
                  // to valid pair targets. Member options are hidden unless
                  // the HS source name passes the email-likelihood check.
                  const selectedHS = hsProps.find((p: any) => p.name === mapping.hubspotProperty);
                  const availablePB = allPBFields.filter((fld: any) => {
                    if (fld.id === mapping.pbFieldId) return true; // never hide the current pick
                    if (usedPBFields.has(fld.id)) return false;
                    return selectedHS ? isPairAllowed(selectedHS, fld) : true;
                  });
                  const pbGrouped = groupByType(availablePB, (fld: any) => fld.type, PB_TYPE_ORDER);
                  const pbGroups = pbGrouped.map(([type, items]) => ({
                    type,
                    label: PB_TYPE_LABELS[type] ?? type,
                    items,
                  }));
                  return (
                    <SearchableSelect
                      value={f.value ?? ''}
                      onChange={(next) => {
                        f.onChange(next);
                        // Drive coercion off the PB destination type so rich-text
                        // descriptions always get sanitized, regardless of the HS source type.
                        const pbField = allPBFields.find((fld: any) => fld.id === next);
                        if (pbField?.type) {
                          setValue(`mappings.${idx}.pbFieldType`, pbField.type);
                        }
                      }}
                      groups={pbGroups}
                      getKey={(fld: any) => fld.id}
                      getLabel={(fld: any) => fld.name}
                      getSearchText={(fld: any) => fld.id ?? ''}
                      placeholder="Not mapped"
                      emptyOption={{ value: '', label: 'Not mapped' }}
                      searchPlaceholder="Search Productboard fields…"
                    />
                  );
                }} />
              )}

              {/* Status badge */}
              <div>{getStatusBadge(mapping, hsProps, pbFields)}</div>

              {/* Trash */}
              <div>
                {!mapping.locked && (
                  <button type="button" onClick={() => remove(idx)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 }}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => append({ hubspotProperty: '', pbFieldId: '', pbFieldType: null, enabled: true, locked: false })}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: '1px dashed var(--border)', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--muted-foreground)', marginBottom: 16, width: '100%', justifyContent: 'center' }}>
        <Plus size={14} /> Add mapping
      </button>

      <InlineAlert variant="info">
        Custom Productboard fields must be pre-created in your workspace before mapping them here. Productboard's API doesn't support creating field definitions programmatically.
      </InlineAlert>
    </div>
  );
}
