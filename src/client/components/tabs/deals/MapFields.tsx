import { useEffect, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { Plus, Trash2, GripVertical, CheckCircle, AlertTriangle, X } from 'lucide-react';
import { useConfig, useSaveConfig, useHSDealProperties, usePbTags } from '../../../hooks/api';
import RuleBuilder, { TAG_DATALIST_ID } from '../../ui/RuleBuilder';
import InlineAlert from '../../ui/InlineAlert';
import SearchableSelect from '../../ui/SearchableSelect';
import type { TagMapping, BodyMapping, TagRule, DealsFieldMappings } from '../../../../types/sync';
import type { HubSpotProperty } from '../../../../types/hubspot';

// ── Type grouping helpers (mirrors accounts/MapFields) ────────────────────────

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

function hsLogicalType(p: { type?: string; fieldType?: string } | undefined): string | null {
  if (!p?.type) return null;
  const t = p.type, ft = (p.fieldType ?? '').toLowerCase();
  if (t === 'enumeration') return ft === 'checkbox' ? 'multiselect' : 'select';
  if (t === 'string') return (ft === 'textarea' || ft === 'html' || ft === 'richtext') ? 'richtext' : 'text';
  if (t === 'phone_number') return 'phone';
  if (t === 'number') return 'number';
  if (t === 'bool') return 'boolean';
  if (t === 'date' || t === 'datetime') return 'date';
  return null;
}

function hsGroupKey(p: { type?: string; fieldType?: string } | undefined): string {
  if (p?.type === 'phone_number') return 'phone';
  return hsLogicalType(p) || 'other';
}

function groupByType<T>(
  items: T[],
  getType: (x: T) => string | null | undefined,
  order: readonly string[],
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {};
  for (const it of items) {
    const t = getType(it) || 'other';
    (groups[t] ??= []).push(it);
  }
  const ordered: Array<[string, T[]]> = [];
  for (const t of order) if (groups[t]?.length) ordered.push([t, groups[t]!]);
  for (const t of Object.keys(groups).sort()) {
    if (!order.includes(t as never)) ordered.push([t, groups[t]!]);
  }
  return ordered;
}

// ── Form types ────────────────────────────────────────────────────────────────

interface MapFieldsForm {
  tags: TagMapping[];
  body: BodyMapping[];
  rules: TagRule[];
  staticTags: string[];
}

const DEFAULT_RULES: TagRule[] = [
  { field: 'dealstage', operator: 'EQ', value: 'closedwon',  tagName: 'Closed-won'  },
  { field: 'dealstage', operator: 'EQ', value: 'closedlost', tagName: 'Closed-lost' },
];

const DEFAULT_BODY: BodyMapping[] = [
  { hsField: 'dealname',          label: 'Deal name',   style: 'longform',  order: 0, enabled: true },
  { hsField: 'dealstage',         label: 'Stage',       style: 'metadata',  order: 1, enabled: true },
  { hsField: 'amount',            label: 'Amount',      style: 'metadata',  order: 2, enabled: true },
  { hsField: 'closedate',         label: 'Close date',  style: 'metadata',  order: 3, enabled: true },
  { hsField: 'pipeline',          label: 'Pipeline',    style: 'metadata',  order: 4, enabled: true },
  { hsField: 'hubspot_owner_id',  label: 'Owner',       style: 'metadata',  order: 5, enabled: true },
  { hsField: 'description',       label: 'Description', style: 'longform',  order: 6, enabled: true },
];

// ── Inner components ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        width: 36, height: 20, borderRadius: 99, border: 'none', padding: 0,
        cursor: 'pointer', flexShrink: 0, position: 'relative',
        background: checked ? 'var(--primary)' : 'oklch(81% 0.02 280)',
        transition: 'background 200ms',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: 99, background: 'white',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        transition: 'left 200ms',
      }} />
    </button>
  );
}

function TagMappingRow({
  idx, control, register, hsProps, onRemove,
}: {
  idx: number;
  control: ReturnType<typeof useForm<MapFieldsForm>>['control'];
  register: ReturnType<typeof useForm<MapFieldsForm>>['register'];
  hsProps: HubSpotProperty[];
  onRemove: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <Controller control={control} name={`tags.${idx}.enabled`} render={({ field: f }) => (
        <Toggle checked={f.value} onChange={f.onChange} />
      )} />
      <select
        {...register(`tags.${idx}.hsField`)}
        style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, flex: 1 }}
      >
        <option value="">Select field…</option>
        {hsProps.map(p => (
          <option key={p.name} value={p.name}>{p.label}</option>
        ))}
      </select>
      <input
        {...register(`tags.${idx}.prefix`)}
        placeholder="Prefix (optional)"
        style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, width: 150 }}
      />
      <button type="button" onClick={onRemove}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 }}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DealsMapFields() {
  const { data: config, isLoading } = useConfig();
  const { data: rawHSProps = [] } = useHSDealProperties();
  const { data: pbTagsData = [] } = usePbTags();
  const saveConfig = useSaveConfig();

  const hsProps = Array.isArray(rawHSProps) ? rawHSProps : [];
  const pbTagNames = pbTagsData.map(t => t.name);
  const tagSrcProps = hsProps.filter(p => p.type === 'enumeration' || p.type === 'bool');

  const { control, register, watch, handleSubmit, reset, setValue, formState } = useForm<MapFieldsForm>({
    defaultValues: { tags: [], body: DEFAULT_BODY, rules: DEFAULT_RULES, staticTags: [] },
  });

  // Sync form from config whenever the config changes AND the user hasn't
  // started editing (isDirty = false). This handles both hard refresh and the
  // stale-cache race where a background refetch brings fresher data after the
  // initial render. After a successful save, onSave calls reset() to clear
  // dirty state so the next config refetch re-anchors the form correctly.
  useEffect(() => {
    if (!config?.fieldMappings?.deals) return;
    if (formState.isDirty) return;
    const d = config.fieldMappings.deals as DealsFieldMappings;
    reset({
      tags: d.tags ?? [],
      body: (d.body ?? []).filter(b => b.hsField).sort((a, b) => a.order - b.order),
      rules: d.rules?.length ? d.rules : DEFAULT_RULES,
      staticTags: d.staticTags ?? [],
    });
  }, [config, reset]);  // eslint-disable-line react-hooks/exhaustive-deps

  const {
    fields: tagFields, append: appendTag, remove: removeTag,
  } = useFieldArray({ control, name: 'tags' });
  const {
    fields: bodyFields, append: appendBody, remove: removeBody, move: moveBody,
  } = useFieldArray({ control, name: 'body' });
  const {
    fields: ruleFields, append: appendRule, remove: removeRule,
  } = useFieldArray({ control, name: 'rules' });

  const staticTags = watch('staticTags');
  const watchedRules = watch('rules');
  const watchedBody = watch('body');

  const usedBodyFields = new Set(
    watchedBody.map(b => b?.hsField).filter(Boolean) as string[]
  );

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (!saveConfig.isSuccess && !saveConfig.isError) return;
    const t = setTimeout(() => saveConfig.reset(), 2500);
    return () => clearTimeout(t);
  }, [saveConfig.isSuccess, saveConfig.isError, saveConfig.reset]);

  const onSave = handleSubmit(async values => {
    const ordered = values.body.filter(b => b.hsField).map((b, i) => ({ ...b, order: i }));
    await saveConfig.mutateAsync({
      fieldMappings: {
        deals: {
          tags: values.tags,
          body: ordered,
          rules: values.rules,
          staticTags: values.staticTags,
        },
      } as never,
    });
    // Clear dirty state so the next config refetch re-anchors the form
    // against the freshly-saved values without overwriting user intent.
    reset({ tags: values.tags, body: ordered, rules: values.rules, staticTags: values.staticTags });
  });

  function addStaticTag(name: string) {
    const trimmed = name.trim();
    if (!trimmed || staticTags.includes(trimmed)) { setTagInput(''); return; }
    setValue('staticTags', [...staticTags, trimmed]);
    setTagInput('');
  }

  function removeStaticTag(name: string) {
    setValue('staticTags', staticTags.filter(t => t !== name));
  }

  if (isLoading) return <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>;

  const cardStyle: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16, overflow: 'hidden',
  };
  const cardHeaderStyle: React.CSSProperties = {
    padding: '16px 20px', borderBottom: '1px solid var(--border)',
  };
  const cardBodyStyle: React.CSSProperties = {
    padding: 20, display: 'flex', flexDirection: 'column', gap: 20,
  };
  const sectionHeadStyle: React.CSSProperties = {
    fontSize: 13, fontWeight: 600, marginBottom: 6,
  };
  const sectionHintStyle: React.CSSProperties = {
    fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 10,
  };
  const addBtnStyle: React.CSSProperties = {
    border: '1px dashed var(--border)', borderRadius: 6, padding: '6px 12px',
    background: 'none', cursor: 'pointer', fontSize: 13,
    color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', gap: 6,
    marginTop: 4,
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Map deal fields</h1>
          <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
            Choose which deal fields become tags or note body content in Productboard.
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
          <button
            type="button"
            onClick={onSave}
            disabled={saveConfig.isPending}
            style={{ background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 18px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {saveConfig.isPending ? 'Saving…' : 'Save mappings'}
          </button>
        </div>
      </div>

      {/* ── Tags section ── */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Tags</div>
          <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>
            Map deal fields to PB tags, add static tags, and define conditional rules.
          </div>
        </div>
        <div style={cardBodyStyle}>

          {/* Field-to-tag mappings */}
          <div>
            <div style={sectionHeadStyle}>Field → tag mappings</div>
            <div style={{ ...sectionHintStyle }}>
              Tags are derived from the field value — e.g. a "Tier" field maps to a "Tier: Enterprise" tag. Prefix is optional.
            </div>
            {tagFields.map((field, idx) => (
              <TagMappingRow
                key={field.id}
                idx={idx}
                control={control}
                register={register}
                hsProps={tagSrcProps}
                onRemove={() => removeTag(idx)}
              />
            ))}
            <button type="button" onClick={() => appendTag({ hsField: '', prefix: '', enabled: true })} style={addBtnStyle}>
              <Plus size={14} /> Add mapping
            </button>
          </div>

          {/* Static tags */}
          <div>
            <div style={sectionHeadStyle}>Static tags</div>
            <div style={sectionHintStyle}>Added to every deal note regardless of field values.</div>

            {/* Shared datalist for tag autocomplete — used by chips input + rule builders */}
            <datalist id={TAG_DATALIST_ID}>
              {pbTagNames.map(t => <option key={t} value={t} />)}
            </datalist>

            {staticTags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {staticTags.map(tag => {
                  const warn = pbTagNames.length > 0 && !pbTagNames.includes(tag);
                  return (
                    <span key={tag} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '3px 8px 3px 10px', borderRadius: 20, fontSize: 12,
                      background: warn ? 'oklch(97% 0.07 90)' : 'var(--secondary)',
                      border: `1px solid ${warn ? 'oklch(80% 0.14 85)' : 'var(--border)'}`,
                      color: warn ? 'oklch(40% 0.14 40)' : 'var(--secondary-foreground)',
                    }}>
                      {warn && <AlertTriangle size={10} style={{ flexShrink: 0 }} />}
                      {tag}
                      <button type="button" onClick={() => removeStaticTag(tag)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'inherit', display: 'flex', alignItems: 'center' }}>
                        <X size={10} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                list={TAG_DATALIST_ID}
                placeholder="Tag name… (Enter to add)"
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); addStaticTag(tagInput); }
                  if (e.key === ',') { e.preventDefault(); addStaticTag(tagInput.replace(/,$/, '')); }
                }}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13, width: 240 }}
              />
              <button type="button" onClick={() => addStaticTag(tagInput)}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', background: 'none', cursor: 'pointer', fontSize: 13 }}>
                Add
              </button>
            </div>
          </div>

          {/* Conditional rules */}
          <div>
            <div style={sectionHeadStyle}>Conditional rules</div>
            <div style={sectionHintStyle}>Apply a tag when a deal field matches a condition.</div>
            {ruleFields.map((field, idx) => (
              <RuleBuilder
                key={field.id}
                rule={watchedRules[idx] ?? { field: '', operator: 'EQ', value: '', tagName: '' }}
                onChange={val => setValue(`rules.${idx}`, val)}
                onRemove={() => removeRule(idx)}
                hsProps={hsProps}
                pbTags={pbTagNames}
              />
            ))}
            <button
              type="button"
              onClick={() => appendRule({ field: '', operator: 'EQ', value: '', tagName: '' })}
              style={addBtnStyle}
            >
              <Plus size={14} /> Add rule
            </button>
          </div>
        </div>
      </div>

      {/* ── Body section ── */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Note body</div>
          <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>
            Choose which deal fields appear in the note body. Drag rows to reorder.
          </div>
        </div>
        <div style={{ padding: 20 }}>
          {bodyFields.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--muted-foreground)' }}>
              <div style={{ fontSize: 14, marginBottom: 12 }}>No fields configured yet.</div>
              <button
                type="button"
                onClick={() => DEFAULT_BODY.forEach(b => appendBody(b))}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', background: 'none', cursor: 'pointer', fontSize: 13 }}
              >
                Load defaults
              </button>
            </div>
          ) : (
            <>
              {/* Table header */}
              <div style={{ display: 'grid', gridTemplateColumns: '28px 32px 1fr 160px 60px 32px', gap: 8, padding: '6px 4px', marginBottom: 4, fontSize: 11, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.04em', alignItems: 'center' }}>
                <span />
                <span />
                <span>HubSpot field</span>
                <span>Style</span>
                <span>Enabled</span>
                <span />
              </div>

              {bodyFields.map((field, idx) => {
                const isDragOver = overIndex === idx && dragIndex !== null && dragIndex !== idx;
                const currentHsField = watchedBody[idx]?.hsField ?? '';

                const availableProps = hsProps.filter(p =>
                  p.name === currentHsField || !usedBodyFields.has(p.name)
                );
                const grouped = groupByType(availableProps, p => hsGroupKey(p), HS_TYPE_ORDER);
                const groups = grouped.map(([type, items]) => ({
                  type,
                  label: HS_TYPE_LABELS[type] ?? type,
                  items,
                }));

                return (
                  <div
                    key={field.id}
                    draggable
                    onDragStart={() => setDragIndex(idx)}
                    onDragOver={e => { e.preventDefault(); if (overIndex !== idx) setOverIndex(idx); }}
                    onDrop={() => {
                      if (dragIndex !== null && dragIndex !== idx) moveBody(dragIndex, idx);
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '28px 32px 1fr 160px 60px 32px',
                      gap: 8, padding: '8px 4px', alignItems: 'center',
                      borderRadius: 6,
                      background: isDragOver ? 'var(--accent)' : dragIndex === idx ? 'var(--muted)' : 'transparent',
                      border: `1px solid ${isDragOver ? 'var(--primary)' : 'transparent'}`,
                      transition: 'background 100ms',
                      marginBottom: 2,
                    }}
                  >
                    {/* Drag handle */}
                    <div style={{ cursor: 'grab', color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <GripVertical size={14} />
                    </div>

                    {/* Order number */}
                    <div style={{ fontSize: 11, color: 'var(--muted-foreground)', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>
                      {idx + 1}
                    </div>

                    {/* Field picker */}
                    <Controller
                      control={control}
                      name={`body.${idx}.hsField`}
                      render={({ field: f }) => (
                        <SearchableSelect
                          value={f.value ?? ''}
                          onChange={next => {
                            f.onChange(next);
                            const picked = hsProps.find(p => p.name === next);
                            if (picked) {
                              const currentLabel = watchedBody[idx]?.label ?? '';
                              const prevProp = hsProps.find(p => p.name === f.value);
                              // Auto-set label from HS prop label if it's blank or
                              // still matching the previous prop's label (not user-edited).
                              if (!currentLabel || currentLabel === prevProp?.label) {
                                setValue(`body.${idx}.label`, picked.label ?? '');
                              }
                            }
                          }}
                          groups={groups}
                          getKey={p => p.name}
                          getLabel={p => p.label ?? p.name}
                          getSubLabel={p => (p.label && p.label !== p.name ? p.name : null)}
                          getSearchText={p => p.name ?? ''}
                          placeholder="Select a field…"
                          searchPlaceholder="Search deal properties…"
                        />
                      )}
                    />

                    {/* Style select */}
                    <select
                      {...register(`body.${idx}.style`)}
                      style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12 }}
                    >
                      <option value="metadata">Metadata</option>
                      <option value="longform">Longform</option>
                    </select>

                    {/* Enabled toggle */}
                    <div>
                      <Controller control={control} name={`body.${idx}.enabled`} render={({ field: f }) => (
                        <Toggle checked={f.value} onChange={f.onChange} />
                      )} />
                    </div>

                    {/* Remove */}
                    <button type="button" onClick={() => removeBody(idx)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={() => appendBody({ hsField: '', label: '', style: 'metadata', order: bodyFields.length, enabled: true })}
                style={{ ...addBtnStyle, marginTop: 8 }}
              >
                <Plus size={14} /> Add field
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
