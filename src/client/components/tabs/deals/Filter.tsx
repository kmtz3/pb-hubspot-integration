import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { X, Plus, CheckCircle, RefreshCw } from 'lucide-react';
import { useConfig, useSaveConfig, useHSDealProperties, useDealPipelines, useDealsFilterPreview } from '../../../hooks/api';
import { OPERATORS_BY_TYPE, OPERATOR_LABELS } from '../../../constants/operators';
import type { HubSpotFilter } from '../../../../types/hubspot';
import InlineAlert from '../../ui/InlineAlert';
import SearchableSelect from '../../ui/SearchableSelect';
import MultiCheckSelect from '../../ui/MultiCheckSelect';

interface FilterFormValues {
  pipelineId: string;
  stageIds: string[];
  filters: HubSpotFilter[];
}

const MAX_FILTERS = 18;

export default function DealsFilter() {
  const { data: config, isLoading: configLoading } = useConfig();
  const queryClient = useQueryClient();
  const { data: pipelines = [], isFetching: pipelinesFetching } = useDealPipelines();
  const { data: rawHSProps = [], isFetching: propsFetching } = useHSDealProperties();
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const refreshing = forceRefreshing || propsFetching || pipelinesFetching;
  const hsProps = Array.isArray(rawHSProps) ? rawHSProps : [];
  const saveConfig = useSaveConfig();
  const preview = useDealsFilterPreview();

  const { control, register, watch, handleSubmit, reset, setValue } = useForm<FilterFormValues>({
    defaultValues: { pipelineId: '', stageIds: [], filters: [] },
  });

  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !config?.filters?.deals) return;
    initialized.current = true;
    const d = config.filters.deals;
    const raw = d.filterGroups?.[0]?.filters ?? [];
    const filters = raw.map((f: any) => {
      if ((f.operator === 'IN' || f.operator === 'NOT_IN') && f.value && !f.values?.length) {
        return { ...f, values: [f.value], value: '' };
      }
      return f;
    });
    reset({ pipelineId: d.pipelineId ?? '', stageIds: d.stageIds ?? [], filters });
  }, [config?.filters?.deals, reset]);

  const { fields, append, remove } = useFieldArray({ control, name: 'filters' });
  const pipelineId = watch('pipelineId');
  const stageIds = watch('stageIds');
  const currentFilters = watch('filters');

  const selectedPipeline = pipelines.find(p => p.id === pipelineId);
  const availableStages = (selectedPipeline?.stages ?? [])
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder);

  useEffect(() => {
    if (!saveConfig.isSuccess && !saveConfig.isError) return;
    const t = setTimeout(() => saveConfig.reset(), 2500);
    return () => clearTimeout(t);
  }, [saveConfig.isSuccess, saveConfig.isError, saveConfig.reset]);

  useEffect(() => {
    const sub = watch(() => {
      if (saveConfig.isSuccess || saveConfig.isError) saveConfig.reset();
    });
    return () => sub.unsubscribe();
  }, [watch, saveConfig.isSuccess, saveConfig.isError, saveConfig.reset]);

  const getPropertyType = useCallback((propName: string): string => {
    return hsProps.find(p => p.name === propName)?.type ?? 'string';
  }, [hsProps]);

  const refreshFieldOptions = async () => {
    setForceRefreshing(true);
    try {
      const [propsRes, pipelinesRes] = await Promise.all([
        fetch('/api/hubspot/properties?objectType=deals&refresh=true', { headers: { Accept: 'application/json' } }),
        fetch('/api/hubspot/pipelines?refresh=true', { headers: { Accept: 'application/json' } }),
      ]);
      if (propsRes.ok) {
        const props = await propsRes.json();
        if (Array.isArray(props)) queryClient.setQueryData(['hs-deal-properties'], props);
      }
      if (pipelinesRes.ok) {
        const pl = await pipelinesRes.json();
        if (Array.isArray(pl)) queryClient.setQueryData(['hs-deal-pipelines'], pl);
      }
    } finally {
      setForceRefreshing(false);
    }
  };

  const pipelineGroups = useMemo(() => [
    { type: 'pipeline', label: 'Pipelines', items: pipelines },
  ], [pipelines]);

  const propGroups = useMemo(() => {
    const TYPE_ORDER = ['string', 'enumeration', 'number', 'date', 'datetime', 'bool', 'phone_number'];
    const TYPE_LABELS: Record<string, string> = {
      string: 'Text', enumeration: 'Select', number: 'Number',
      date: 'Date', datetime: 'Date & Time', bool: 'Boolean', phone_number: 'Phone',
    };
    const grouped: Record<string, typeof hsProps> = {};
    for (const p of hsProps) {
      const t = (p.type as string) || 'other';
      (grouped[t] ??= []).push(p);
    }
    const result = TYPE_ORDER
      .filter(t => grouped[t]?.length)
      .map(t => ({ type: t, label: TYPE_LABELS[t] ?? t, items: grouped[t]! }));
    for (const t of Object.keys(grouped).sort()) {
      if (!TYPE_ORDER.includes(t)) result.push({ type: t, label: t, items: grouped[t]! });
    }
    return result;
  }, [hsProps]);

  const onSave = handleSubmit(async values => {
    await saveConfig.mutateAsync({
      filters: {
        deals: {
          pipelineId: values.pipelineId,
          stageIds: values.stageIds,
          filterGroups: [{ filters: values.filters }],
        },
      } as never,
    });
  });

  const toggleStage = (stageId: string) => {
    const current = stageIds ?? [];
    setValue(
      'stageIds',
      current.includes(stageId) ? current.filter(id => id !== stageId) : [...current, stageId],
      { shouldDirty: true },
    );
  };

  if (configLoading) return <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Filter deals</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
          Choose which pipeline and stages sync, then add optional property conditions.
        </p>
      </div>

      {/* Pipeline & stages card */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 16 }}>Pipeline & stages</div>

        <div style={{ marginBottom: pipelineId && availableStages.length > 0 ? 16 : 0 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted-foreground)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Pipeline
          </label>
          <div style={{ maxWidth: 300 }}>
            <Controller control={control} name="pipelineId" render={({ field }) => (
              <SearchableSelect
                value={field.value ?? ''}
                onChange={val => {
                  field.onChange(val);
                  setValue('stageIds', [], { shouldDirty: true });
                }}
                groups={pipelineGroups}
                getKey={(p: any) => p.id}
                getLabel={(p: any) => p.label}
                renderSelected={v => pipelines.find(p => p.id === v)?.label ?? v}
                emptyOption={{ value: '', label: 'All pipelines (no filter)' }}
                placeholder="All pipelines (no filter)"
                searchPlaceholder="Search pipelines…"
              />
            )} />
          </div>
        </div>

        {pipelineId && availableStages.length > 0 && (
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted-foreground)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Stages {stageIds.length > 0 ? `(${stageIds.length} selected)` : '(all stages)'}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {availableStages.map(stage => {
                const selected = stageIds.includes(stage.id);
                return (
                  <button
                    key={stage.id}
                    type="button"
                    onClick={() => toggleStage(stage.id)}
                    style={{
                      padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 500,
                      border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
                      background: selected ? 'var(--primary)' : 'var(--background)',
                      color: selected ? 'var(--primary-foreground)' : 'var(--foreground)',
                      cursor: 'pointer', transition: 'all 120ms',
                    }}
                  >
                    {stage.label}
                  </button>
                );
              })}
            </div>
            {stageIds.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)', marginTop: 6 }}>
                No stages selected — all stages in this pipeline will sync.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Property conditions card */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontWeight: 600 }}>Property conditions</div>
          <button
            type="button"
            onClick={refreshFieldOptions}
            disabled={refreshing}
            title="Refresh properties and pipelines from HubSpot"
            aria-label="Refresh field options"
            style={{
              background: 'none', border: 'none', cursor: refreshing ? 'default' : 'pointer',
              color: 'var(--muted-foreground)', padding: 2, display: 'flex', alignItems: 'center',
              opacity: refreshing ? 0.6 : 1,
            }}>
            <RefreshCw size={13} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none', transformOrigin: 'center' }} />
          </button>
        </div>

        {fields.map((field, idx) => {
          const propType = getPropertyType(currentFilters[idx]?.propertyName ?? '');
          const operators = OPERATORS_BY_TYPE[propType] ?? OPERATORS_BY_TYPE['string']!;
          const op = currentFilters[idx]?.operator ?? '';
          const hideValue = op === 'HAS_PROPERTY' || op === 'NOT_HAS_PROPERTY';
          const selectedProp = hsProps.find(p => p.name === currentFilters[idx]?.propertyName);

          return (
            <div key={field.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--muted-foreground)', width: 38, textAlign: 'right', flexShrink: 0, marginRight: 8 }}>
                {idx === 0 ? 'WHERE' : 'AND'}
              </span>
              <div style={{ width: 220, flexShrink: 0 }}>
                <Controller control={control} name={`filters.${idx}.propertyName`} render={({ field: f }) => (
                  <SearchableSelect
                    value={f.value ?? ''}
                    onChange={f.onChange}
                    groups={propGroups}
                    getKey={(p: any) => p.name}
                    getLabel={(p: any) => p.label ?? p.name}
                    getSubLabel={(p: any) => (p.label && p.label !== p.name) ? p.name : null}
                    getSearchText={(p: any) => p.name}
                    placeholder="Select property…"
                    searchPlaceholder="Search properties…"
                  />
                )} />
              </div>
              <Controller control={control} name={`filters.${idx}.operator`} render={({ field: f }) => (
                <select
                  value={f.value}
                  onChange={e => {
                    const next = e.target.value;
                    const wasMulti = f.value === 'IN' || f.value === 'NOT_IN';
                    const isMulti = next === 'IN' || next === 'NOT_IN';
                    f.onChange(next);
                    if (wasMulti && !isMulti) setValue(`filters.${idx}.values`, []);
                    if (!wasMulti && isMulti) setValue(`filters.${idx}.value`, '');
                  }}
                  style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, minWidth: 100, flex: '0 1 160px' }}>
                  {operators.map(op => (
                    <option key={op} value={op}>{OPERATOR_LABELS[op] ?? op}</option>
                  ))}
                </select>
              )} />
              {!hideValue && (
                (op === 'IN' || op === 'NOT_IN') ? (
                  selectedProp?.options?.length ? (
                    <Controller control={control} name={`filters.${idx}.values`} render={({ field: f }) => (
                      <MultiCheckSelect
                        options={selectedProp.options!.map((o: any) => ({ value: o.value, label: o.label }))}
                        selected={f.value ?? []}
                        onChange={f.onChange}
                      />
                    )} />
                  ) : (
                    <input {...register(`filters.${idx}.value`)}
                      placeholder="Values (comma-separated)"
                      style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, flex: 1 }} />
                  )
                ) : selectedProp?.options?.length ? (
                  <select {...register(`filters.${idx}.value`)}
                    style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, flex: 1 }}>
                    <option value="">Select value…</option>
                    {selectedProp.options.map((o: any) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input {...register(`filters.${idx}.value`)}
                    placeholder="Value"
                    style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, flex: 1 }} />
                )
              )}
              <span style={{ background: 'var(--muted)', borderRadius: 4, padding: '2px 6px', fontSize: 11, color: 'var(--muted-foreground)', flexShrink: 0 }}>
                {propType}
              </span>
              <button type="button" onClick={() => remove(idx)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2 }}>
                <X size={15} />
              </button>
            </div>
          );
        })}

        {fields.length < MAX_FILTERS && (
          <button
            type="button"
            onClick={() => append({ propertyName: '', operator: 'EQ', value: '' })}
            style={{ border: '1px dashed var(--border)', borderRadius: 6, padding: '6px 12px', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--muted-foreground)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <Plus size={14} /> Add condition
          </button>
        )}
        {fields.length >= MAX_FILTERS && (
          <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 8 }}>Maximum 18 conditions reached.</div>
        )}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12, fontSize: 12, color: 'var(--muted-foreground)' }}>
          Conditions apply in addition to the pipeline/stage filter above.
        </div>
      </div>

      {/* Preview card */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Preview</div>
        {preview.data && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{preview.data.count.toLocaleString()}</div>
            <div style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>
              of {preview.data.total.toLocaleString()} total deals
            </div>
            <div style={{ height: 8, background: 'var(--muted)', borderRadius: 4, marginTop: 8 }}>
              <div style={{
                height: '100%', borderRadius: 4, background: 'var(--primary)',
                width: `${Math.round(preview.data.count / Math.max(preview.data.total, 1) * 100)}%`,
              }} />
            </div>
          </div>
        )}
        {preview.isError && (
          <div style={{ fontSize: 12, color: 'var(--destructive)', marginBottom: 8 }}>
            Preview failed — check your conditions and try again.
          </div>
        )}
        <button
          type="button"
          onClick={() => preview.mutate(currentFilters)}
          disabled={preview.isPending}
          style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', background: 'none', cursor: 'pointer', fontSize: 13 }}>
          {preview.isPending ? 'Running…' : 'Run preview'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 16, justifyContent: 'flex-end', alignItems: 'center' }}>
        {saveConfig.isSuccess && (
          <InlineAlert variant="success">
            <CheckCircle size={16} color="var(--success)" style={{ flexShrink: 0, marginTop: 1, marginRight: 4 }} />
            Filters saved.
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
          {saveConfig.isPending ? 'Saving…' : 'Save filters'}
        </button>
      </div>
    </div>
  );
}
