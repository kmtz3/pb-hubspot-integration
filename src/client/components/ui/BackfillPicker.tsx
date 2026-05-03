import { useState } from 'react';
import type { BackfillRequest } from '../../hooks/api';

interface Props {
  onRun: (req: BackfillRequest) => void;
  isPending: boolean;
}

type Mode = 'lastx' | 'custom';
type Unit = 'days' | 'months' | 'years';

const UNIT_OPTIONS: { value: Unit; label: string }[] = [
  { value: 'days',   label: 'days'   },
  { value: 'months', label: 'months' },
  { value: 'years',  label: 'years'  },
];

const WINDOW_FIELDS: { value: BackfillRequest['windowField']; label: string; hint: string }[] = [
  { value: 'hs_lastmodifieddate', label: 'Last modified', hint: 'Deals updated in the window' },
  { value: 'createdate',          label: 'Created date',  hint: 'Deals created in the window' },
];

function computeFrom(amount: number, unit: Unit): number {
  const now = Date.now();
  if (unit === 'years')  return now - amount * 365 * 24 * 60 * 60 * 1000;
  if (unit === 'months') return now - amount * 30  * 24 * 60 * 60 * 1000;
  return now - amount * 24 * 60 * 60 * 1000;
}

const INPUT_STYLE: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '6px 8px', fontSize: 13,
  background: 'var(--background)', color: 'var(--foreground)',
};

export default function BackfillPicker({ onRun, isPending }: Props) {
  const [mode, setMode] = useState<Mode>('lastx');
  const [amount, setAmount] = useState(30);
  const [unit, setUnit] = useState<Unit>('days');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [windowField, setWindowField] = useState<BackfillRequest['windowField']>('hs_lastmodifieddate');

  const canRun = mode === 'lastx'
    ? amount > 0
    : Boolean(fromDate && toDate && fromDate < toDate);

  function handleRun() {
    if (!canRun) return;
    let from: number;
    let to: number;
    if (mode === 'lastx') {
      to = Date.now();
      from = computeFrom(amount, unit);
    } else {
      from = new Date(fromDate).getTime();
      to = new Date(toDate).getTime() + (24 * 60 * 60 * 1000 - 1);
    }
    onRun({ from, to, windowField });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Mode toggle */}
      <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', alignSelf: 'flex-start' }}>
        {(['lastx', 'custom'] as Mode[]).map(m => (
          <button key={m} type="button"
            onClick={() => setMode(m)}
            style={{
              height: 28, padding: '0 14px', border: 'none',
              background: mode === m ? 'var(--primary)' : 'var(--background)',
              color: mode === m ? 'var(--primary-foreground)' : 'var(--foreground)',
              fontSize: 12, fontFamily: 'var(--font-sans)', fontWeight: 500,
              cursor: 'pointer',
              borderRight: m === 'lastx' ? '1px solid var(--border)' : 'none',
            }}
          >
            {m === 'lastx' ? 'Last X' : 'Custom range'}
          </button>
        ))}
      </div>

      {/* Window inputs */}
      {mode === 'lastx' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>Last</span>
          <input
            type="number"
            min={1}
            value={amount}
            onChange={e => setAmount(Math.max(1, Number(e.target.value)))}
            style={{ ...INPUT_STYLE, width: 68 }}
          />
          <select
            value={unit}
            onChange={e => setUnit(e.target.value as Unit)}
            style={{ ...INPUT_STYLE, width: 100 }}
          >
            {UNIT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={{ ...INPUT_STYLE, width: 150 }} />
          <span style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>to</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            style={{ ...INPUT_STYLE, width: 150 }} />
          {fromDate && toDate && fromDate >= toDate && (
            <span style={{ fontSize: 12, color: 'var(--destructive)' }}>End must be after start</span>
          )}
        </div>
      )}

      {/* Match deals by */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted-foreground)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Match deals by
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {WINDOW_FIELDS.map(wf => (
            <label key={wf.value} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
              border: `1px solid ${windowField === wf.value ? 'var(--primary)' : 'var(--border)'}`,
              borderRadius: 6, cursor: 'pointer',
              background: windowField === wf.value ? 'var(--accent)' : 'var(--background)',
              transition: 'background 150ms, border-color 150ms',
            }}>
              <input type="radio" name="backfill-window" value={wf.value}
                checked={windowField === wf.value}
                onChange={() => setWindowField(wf.value)}
                style={{ display: 'none' }} />
              <span style={{
                width: 14, height: 14, borderRadius: 99, flexShrink: 0,
                border: `2px solid ${windowField === wf.value ? 'var(--primary)' : 'var(--input)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--background)',
              }}>
                {windowField === wf.value && (
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--primary)' }} />
                )}
              </span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{wf.label}</div>
                <div style={{ fontSize: 11, color: 'var(--muted-foreground)', marginTop: 1 }}>{wf.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Run button */}
      <div>
        <button
          type="button"
          onClick={handleRun}
          disabled={!canRun || isPending}
          style={{
            height: 32, padding: '0 18px', borderRadius: 6, border: 'none',
            background: 'var(--primary)', color: 'var(--primary-foreground)',
            fontSize: 13, fontFamily: 'var(--font-sans)', fontWeight: 600,
            cursor: !canRun || isPending ? 'not-allowed' : 'pointer',
            opacity: !canRun || isPending ? 0.6 : 1,
          }}
        >
          {isPending ? 'Running…' : 'Run backfill'}
        </button>
      </div>
    </div>
  );
}
