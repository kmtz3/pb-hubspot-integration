import { useMemo } from 'react';
import { X } from 'lucide-react';
import { OPERATORS_BY_TYPE, OPERATOR_LABELS } from '../../constants/operators';
import type { TagRule } from '../../../types/sync';
import type { HubSpotFilter, HubSpotProperty } from '../../../types/hubspot';
import SearchableSelect from './SearchableSelect';
import MultiCheckSelect from './MultiCheckSelect';

export const TAG_DATALIST_ID = 'pb-tag-options';

const MULTI_VALUE_OPS = new Set<HubSpotFilter['operator']>(['IN', 'NOT_IN', 'BETWEEN']);
const NO_VALUE_OPS   = new Set<HubSpotFilter['operator']>(['HAS_PROPERTY', 'NOT_HAS_PROPERTY']);

const HS_TYPE_ORDER = ['string', 'enumeration', 'number', 'date', 'datetime', 'bool', 'phone_number'] as const;
const HS_TYPE_LABELS: Record<string, string> = {
  string: 'Text', enumeration: 'Select', number: 'Number',
  date: 'Date', datetime: 'Date & Time', bool: 'Boolean', phone_number: 'Phone',
};

interface Props {
  rule: TagRule;
  onChange: (rule: TagRule) => void;
  onRemove: () => void;
  hsProps: HubSpotProperty[];
  pbTags: string[];
}

export default function RuleBuilder({ rule, onChange, onRemove, hsProps, pbTags }: Props) {
  const prop = hsProps.find(p => p.name === rule.field);
  const propType = prop?.type ?? 'string';
  const operators = OPERATORS_BY_TYPE[propType] ?? OPERATORS_BY_TYPE['string']!;
  const isMultiValue = MULTI_VALUE_OPS.has(rule.operator);
  const noValue = NO_VALUE_OPS.has(rule.operator);
  const tagIsNew = Boolean(rule.tagName) && pbTags.length > 0 && !pbTags.includes(rule.tagName);

  const propGroups = useMemo(() => {
    const grouped: Record<string, HubSpotProperty[]> = {};
    for (const p of hsProps) {
      const t = p.type || 'other';
      (grouped[t] ??= []).push(p);
    }
    const ordered: Array<{ type: string; label: string; items: HubSpotProperty[] }> = [];
    for (const t of HS_TYPE_ORDER) {
      if (grouped[t]?.length) ordered.push({ type: t, label: HS_TYPE_LABELS[t] ?? t, items: grouped[t]! });
    }
    for (const t of Object.keys(grouped).sort()) {
      if (!HS_TYPE_ORDER.includes(t as never)) ordered.push({ type: t, label: t, items: grouped[t]! });
    }
    return ordered;
  }, [hsProps]);

  const multiOptions = useMemo(
    () => (prop?.options ?? []).map(o => ({ value: o.value, label: o.label })),
    [prop],
  );

  return (
    <div style={{ marginBottom: tagIsNew ? 2 : 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>

        {/* Field picker – searchable + categorized */}
        <div style={{ width: 200, flexShrink: 0 }}>
          <SearchableSelect
            value={rule.field}
            onChange={val => onChange({ ...rule, field: val, operator: 'EQ', value: undefined, values: undefined })}
            groups={propGroups}
            getKey={(p: HubSpotProperty) => p.name}
            getLabel={(p: HubSpotProperty) => p.label ?? p.name}
            getSubLabel={(p: HubSpotProperty) => (p.label && p.label !== p.name ? p.name : null)}
            getSearchText={(p: HubSpotProperty) => p.name}
            placeholder="Field…"
            searchPlaceholder="Search properties…"
          />
        </div>

        {/* Operator */}
        <select
          value={rule.operator}
          onChange={e => onChange({ ...rule, operator: e.target.value as HubSpotFilter['operator'], value: undefined, values: undefined })}
          style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, flexShrink: 0, minWidth: 140 }}
        >
          {operators.map(op => (
            <option key={op} value={op}>{OPERATOR_LABELS[op] ?? op}</option>
          ))}
        </select>

        {/* Value input – dropdown when options exist, multi-select for IN/NOT_IN */}
        {!noValue && (
          isMultiValue ? (
            rule.operator === 'BETWEEN' ? (
              <input
                value={(rule.values ?? []).join(', ')}
                onChange={e => onChange({ ...rule, value: undefined, values: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                placeholder="low, high"
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 120, flexShrink: 0 }}
              />
            ) : multiOptions.length > 0 ? (
              <MultiCheckSelect
                options={multiOptions}
                selected={rule.values ?? []}
                onChange={vals => onChange({ ...rule, value: undefined, values: vals })}
              />
            ) : (
              <input
                value={(rule.values ?? []).join(', ')}
                onChange={e => onChange({ ...rule, value: undefined, values: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                placeholder="val1, val2…"
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 120, flexShrink: 0 }}
              />
            )
          ) : prop?.options?.length ? (
            <select
              value={rule.value ?? ''}
              onChange={e => onChange({ ...rule, value: e.target.value, values: undefined })}
              style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, flexShrink: 0, minWidth: 110 }}
            >
              <option value="">Value…</option>
              {prop.options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              value={rule.value ?? ''}
              onChange={e => onChange({ ...rule, value: e.target.value, values: undefined })}
              placeholder="Value…"
              style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 110, flexShrink: 0 }}
            />
          )
        )}

        <span style={{ padding: '0 2px', color: 'var(--muted-foreground)', fontSize: 12, flexShrink: 0 }}>→ tag</span>

        <input
          value={rule.tagName}
          onChange={e => onChange({ ...rule, tagName: e.target.value })}
          list={TAG_DATALIST_ID}
          placeholder="Tag name…"
          style={{
            border: '1px solid var(--border)',
            borderRadius: 6, padding: '6px 8px', fontSize: 12, flex: 1, minWidth: 80,
          }}
        />

        <button type="button" onClick={onRemove}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: '4px 2px', flexShrink: 0 }}>
          <X size={14} />
        </button>
      </div>

      {tagIsNew && (
        <div style={{ fontSize: 11, color: 'var(--muted-foreground)', paddingLeft: 4, paddingTop: 3, paddingBottom: 2 }}>
          "{rule.tagName}" will be created in Productboard automatically on the next run.
        </div>
      )}
    </div>
  );
}
