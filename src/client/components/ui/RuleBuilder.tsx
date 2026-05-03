import { X } from 'lucide-react';
import { OPERATORS_BY_TYPE, OPERATOR_LABELS } from '../../constants/operators';
import type { TagRule } from '../../../types/sync';
import type { HubSpotFilter, HubSpotProperty } from '../../../types/hubspot';

export const TAG_DATALIST_ID = 'pb-tag-options';

const MULTI_VALUE_OPS = new Set<HubSpotFilter['operator']>(['IN', 'NOT_IN', 'BETWEEN']);
const NO_VALUE_OPS = new Set<HubSpotFilter['operator']>(['HAS_PROPERTY', 'NOT_HAS_PROPERTY']);

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
  const tagWarning = Boolean(rule.tagName) && pbTags.length > 0 && !pbTags.includes(rule.tagName);

  return (
    <div style={{ marginBottom: tagWarning ? 2 : 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <select
          value={rule.field}
          onChange={e => onChange({ ...rule, field: e.target.value, operator: 'EQ', value: undefined, values: undefined })}
          style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 185 }}
        >
          <option value="">Field…</option>
          {hsProps.map(p => (
            <option key={p.name} value={p.name}>{p.label}</option>
          ))}
        </select>

        <select
          value={rule.operator}
          onChange={e => onChange({ ...rule, operator: e.target.value as HubSpotFilter['operator'], value: undefined, values: undefined })}
          style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 160 }}
        >
          {operators.map(op => (
            <option key={op} value={op}>{OPERATOR_LABELS[op] ?? op}</option>
          ))}
        </select>

        {!noValue && (
          isMultiValue ? (
            <input
              value={(rule.values ?? []).join(', ')}
              onChange={e => onChange({ ...rule, value: undefined, values: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              placeholder={rule.operator === 'BETWEEN' ? 'low, high' : 'val1, val2…'}
              style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 130 }}
            />
          ) : (
            prop?.options?.length ? (
              <select
                value={rule.value ?? ''}
                onChange={e => onChange({ ...rule, value: e.target.value, values: undefined })}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 130 }}
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
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, width: 130 }}
              />
            )
          )
        )}

        <span style={{ padding: '0 2px', color: 'var(--muted-foreground)', fontSize: 12, flexShrink: 0 }}>→ tag</span>

        <input
          value={rule.tagName}
          onChange={e => onChange({ ...rule, tagName: e.target.value })}
          list={TAG_DATALIST_ID}
          placeholder="Tag name…"
          style={{
            border: `1px solid ${tagWarning ? 'oklch(80% 0.14 85)' : 'var(--border)'}`,
            borderRadius: 6, padding: '6px 8px', fontSize: 12, flex: 1,
            background: tagWarning ? 'oklch(97% 0.07 90)' : undefined,
          }}
        />

        <button type="button" onClick={onRemove}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)', padding: '4px 2px', flexShrink: 0 }}>
          <X size={14} />
        </button>
      </div>

      {tagWarning && (
        <div style={{ fontSize: 11, color: 'oklch(50% 0.14 40)', paddingLeft: 4, paddingTop: 3, paddingBottom: 2 }}>
          "{rule.tagName}" is not in the PB workspace — pre-seed it in Productboard before the next run.
        </div>
      )}
    </div>
  );
}
