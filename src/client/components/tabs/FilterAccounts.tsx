import { useCallback, useEffect, useRef } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { X, Plus, CheckCircle } from 'lucide-react';
import { useConfig, useSaveConfig, useHSProperties, useFilterPreview } from '../../hooks/api';
import { OPERATORS_BY_TYPE, OPERATOR_LABELS } from '../../constants/operators';
import type { HubSpotFilter } from '../../../types/hubspot';
import InlineAlert from '../ui/InlineAlert';

interface FilterFormValues {
  enabled: boolean;
  filters: HubSpotFilter[];
}

const MAX_FILTERS = 18;

export default function FilterAccounts() {
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: hsProps } = useHSProperties();
  const saveConfig = useSaveConfig();
  const preview = useFilterPreview();

  const { control, register, watch, handleSubmit, reset } = useForm<FilterFormValues>({
    defaultValues: {
      enabled: false,
      filters: [],
    },
  });

  const initialized = useRef(false);
  useEffect(() => {
    if (config?.accountFilter && hsProps && !initialized.current) {
      initialized.current = true;
      reset({
        enabled: config.accountFilter.enabled,
        filters: config.accountFilter.filterGroups[0]?.filters ?? [],
      });
    }
  }, [config?.accountFilter, hsProps, reset]);

  const { fields, append, remove } = useFieldArray({ control, name: 'filters' });
  const currentFilters = watch('filters');
  const enabled = watch('enabled');

  // Auto-dismiss the "Filters saved." indicator after a moment so it
  // doesn't linger and imply that subsequent unsaved edits are persisted.
  useEffect(() => {
    if (!saveConfig.isSuccess && !saveConfig.isError) return;
    const t = setTimeout(() => saveConfig.reset(), 2500);
    return () => clearTimeout(t);
  }, [saveConfig.isSuccess, saveConfig.isError, saveConfig.reset]);

  // Clear the indicator immediately when the user edits anything,
  // since the displayed config no longer matches what's saved.
  useEffect(() => {
    const sub = watch(() => {
      if (saveConfig.isSuccess || saveConfig.isError) saveConfig.reset();
    });
    return () => sub.unsubscribe();
  }, [watch, saveConfig.isSuccess, saveConfig.isError, saveConfig.reset]);

  const getPropertyType = useCallback((propName: string): string => {
    return hsProps?.find(p => p.name === propName)?.type ?? 'string';
  }, [hsProps]);

  const onSave = handleSubmit(async (values) => {
    await saveConfig.mutateAsync({
      accountFilter: {
        enabled: values.enabled,
        filterGroups: [{ filters: values.filters }],
      },
    });
  });

  const runPreview = () => {
    preview.mutate(currentFilters);
  };

  if (configLoading) return <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Filter accounts</h1>
          <p style={{ color: 'var(--muted-foreground)', fontSize: 14, marginTop: 4 }}>
            Only sync companies matching these conditions.
          </p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <Controller control={control} name="enabled" render={({ field }) => (
            <button
              type="button"
              onClick={() => field.onChange(!field.value)}
              style={{
                width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                background: field.value ? 'var(--primary)' : 'var(--muted)',
                position: 'relative', transition: 'background 200ms',
              }}>
              <span style={{
                position: 'absolute', top: 3, left: field.value ? 20 : 3,
                width: 16, height: 16, borderRadius: '50%', background: '#fff',
                transition: 'left 200ms',
              }} />
            </button>
          )} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {enabled ? 'Filter active' : 'Filter disabled — sync all companies'}
          </span>
        </label>
      </div>

      {/* Conditions card */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Conditions</div>

        {fields.map((field, idx) => {
          const propType = getPropertyType(currentFilters[idx]?.propertyName ?? '');
          const operators = OPERATORS_BY_TYPE[propType] ?? OPERATORS_BY_TYPE['string']!;
          const op = currentFilters[idx]?.operator ?? '';
          const hideValue = op === 'HAS_PROPERTY' || op === 'NOT_HAS_PROPERTY';
          const selectedProp = hsProps?.find(p => p.name === currentFilters[idx]?.propertyName);

          return (
            <div key={field.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--muted-foreground)', width: 38, textAlign: 'right', flexShrink: 0, marginRight: 8 }}>
                {idx === 0 ? 'WHERE' : 'AND'}
              </span>

              {/* Property select */}
              <select {...register(`filters.${idx}.propertyName`)}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, width: 220 }}>
                <option value="">Select property…</option>
                {(hsProps ?? []).map(p => (
                  <option key={p.name} value={p.name}>{p.label}</option>
                ))}
              </select>

              {/* Operator select */}
              <select {...register(`filters.${idx}.operator`)}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 13, width: 200 }}>
                {operators.map(op => (
                  <option key={op} value={op}>{OPERATOR_LABELS[op] ?? op}</option>
                ))}
              </select>

              {/* Value input */}
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

              {/* Type chip */}
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
          <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 8 }}>
            Maximum 18 conditions reached.
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12, fontSize: 12, color: 'var(--muted-foreground)' }}>
          Need OR logic? Pre-filter records in HubSpot using a 'Sync to PB' custom property.
        </div>
      </div>

      {/* Preview card */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Preview</div>
        {preview.data && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{preview.data.count.toLocaleString()}</div>
            <div style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>
              of {preview.data.total.toLocaleString()} total companies
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
          onClick={runPreview}
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
