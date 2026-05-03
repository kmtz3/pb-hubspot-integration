import { useCallback, useEffect, useRef } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { X, Plus, CheckCircle } from 'lucide-react';
import { useConfig, useSaveConfig, useHSDealProperties, useDealPipelines, useDealsFilterPreview } from '../../../hooks/api';
import { OPERATORS_BY_TYPE, OPERATOR_LABELS } from '../../../constants/operators';
import type { HubSpotFilter } from '../../../../types/hubspot';
import InlineAlert from '../../ui/InlineAlert';

interface FilterFormValues {
  pipelineId: string;
  stageIds: string[];
  filters: HubSpotFilter[];
}

const MAX_FILTERS = 18;

export default function DealsFilter() {
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: pipelines = [] } = useDealPipelines();
  const { data: rawHSProps = [] } = useHSDealProperties();
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
    reset({
      pipelineId: d.pipelineId ?? '',
      stageIds: d.stageIds ?? [],
      filters: d.filterGroups?.[0]?.filters ?? [],
    });
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
          <Controller control={control} name="pipelineId" render={({ field }) => (
            <select
              {...field}
              onChange={e => {
                field.onChange(e.target.value);
                setValue('stageIds', [], { shouldDirty: true });
              }}
              style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', fontSize: 13, width: 300 }}
            >
              <option value="">All pipelines (no filter)</option>
              {pipelines.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          )} />
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
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Property conditions</div>

        {fields.map((field, idx) => {
          const propType = getPropertyType(currentFilters[idx]?.propertyName ?? '');
          const operators = OPERATORS_BY_TYPE[propType] ?? OPERATORS_BY_TYPE['string']!;
          const op = currentFilters[idx]?.operator ?? '';
          const hideValue = op === 'HAS_PROPERTY' || op === 'NOT_HAS_PROPERTY';
          const selectedProp = hsProps.find(p => p.name === currentFilters[idx]?.propertyName);

          return (
            <div key={field.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--muted-foreground)', width: 38, textAlign: 'right', flexShrink: 0, marginRight: 8 }}>
                {idx === 0 ? 'WHERE' : 'AND'}
              </span>
              <select {...register(`filters.${idx}.propertyName`)}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, width: 220 }}>
                <option value="">Select property…</option>
                {hsProps.map(p => (
                  <option key={p.name} value={p.name}>{p.label}</option>
                ))}
              </select>
              <select {...register(`filters.${idx}.operator`)}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, width: 200 }}>
                {operators.map(op => (
                  <option key={op} value={op}>{OPERATOR_LABELS[op] ?? op}</option>
                ))}
              </select>
              {!hideValue && (
                selectedProp?.options?.length ? (
                  <select {...register(`filters.${idx}.value`)}
                    style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, flex: 1 }}>
                    <option value="">Select value…</option>
                    {selectedProp.options.map(o => (
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
