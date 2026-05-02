import { useState } from 'react';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { useSyncRuns } from '../../hooks/api';
import Code from '../ui/Code';
import type { SyncDebugLog, SyncRun, SyncRunError } from '../../../types/sync';

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SyncRun['status'] }) {
  const map: Record<SyncRun['status'], { bg: string; color: string; label: string }> = {
    success: { bg: 'var(--success-accent)',     color: 'var(--success-accent-foreground)', label: 'Success' },
    partial: { bg: 'var(--warning-accent)',     color: 'var(--warning-accent-foreground)', label: 'Partial' },
    failed:  { bg: 'var(--destructive-accent)', color: 'var(--destructive-accent-foreground)', label: 'Failed' },
    running: { bg: 'var(--accent)',             color: 'var(--accent-foreground)',         label: 'Running' },
  };
  const { bg, color, label } = map[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 4,
      background: bg, color,
      fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

// ── Expanded detail row ───────────────────────────────────────────────────────

function ErrorTable({ errors }: { errors: SyncRunError[] }) {
  if (errors.length === 0) return <p style={{ fontSize: 12, color: 'var(--muted-foreground)', margin: 0 }}>No errors.</p>;
  return (
    <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--border)' }}>
        Errors ({errors.length})
      </div>
      {errors.map((e, i) => (
        <div key={i} style={{
          display: 'flex', gap: 12, padding: '8px 12px',
          borderBottom: i < errors.length - 1 ? '1px solid var(--border)' : 'none',
          alignItems: 'flex-start',
        }}>
          <span style={{ color: 'var(--destructive)', fontSize: 14, marginTop: 1 }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {e.name}{e.hsId ? <> <Code>{e.hsId}</Code></> : null}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>{e.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function DebugLogTable({ logs }: { logs: SyncDebugLog[] }) {
  if (logs.length === 0) return null;
  return (
    <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginTop: 12 }}>
      <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--border)' }}>
        Extended debug log ({logs.length})
      </div>
      {logs.map((log, i) => (
        <div key={i} style={{
          padding: '10px 12px',
          borderBottom: i < logs.length - 1 ? '1px solid var(--border)' : 'none',
        }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{log.name}</span>
            {log.hsId && <Code>{log.hsId}</Code>}
            {log.action && <Code>{log.action}</Code>}
            {log.pbId && <Code>{log.pbId}</Code>}
            <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{new Date(log.at).toLocaleString()}</span>
          </div>
          {log.error && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 4 }}>Full error</div>
              <pre style={{ margin: 0, padding: 10, borderRadius: 4, background: 'var(--muted)', overflowX: 'auto', fontSize: 11, lineHeight: 1.5 }}>
                {JSON.stringify(log.error, null, 2)}
              </pre>
            </div>
          )}
          {log.payload !== undefined && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 4 }}>Attempted Productboard payload</div>
              <pre style={{ margin: 0, padding: 10, borderRadius: 4, background: 'var(--muted)', overflowX: 'auto', fontSize: 11, lineHeight: 1.5 }}>
                {JSON.stringify(log.payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Run row ───────────────────────────────────────────────────────────────────

function RunRow({ run }: { run: SyncRun }) {
  const [open, setOpen] = useState(false);

  const date = new Date(run.startedAt);
  const dateLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + ' · ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const durationSec = run.finishedAt
    ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : null;
  const dur = durationSec !== null
    ? durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`
    : '—';

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <>
      <tr
        onClick={() => setOpen(o => !o)}
        style={{
          borderBottom: '1px solid var(--border)', cursor: 'pointer',
          background: open ? 'var(--muted)' : 'transparent',
          transition: 'background 120ms',
        }}
        onMouseEnter={e => { if (!open) (e.currentTarget as HTMLElement).style.background = 'var(--muted)'; }}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <td style={{ padding: '12px 8px 12px 20px', width: 24 }}>
          <Chevron size={14} style={{ color: 'var(--muted-foreground)' }} />
        </td>
        <td style={{ padding: '12px 16px 12px 0', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>{dateLabel}</td>
        <td style={{ padding: '12px 16px 12px 0' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            background: 'var(--secondary)', color: 'var(--secondary-foreground)',
            fontFamily: 'var(--font-mono)',
          }}>
            {run.trigger}
          </span>
        </td>
        <td style={{ padding: '12px 16px 12px 0', fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)' }}>{dur}</td>
        <td style={{ padding: '12px 16px 12px 0', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          <span style={{ color: 'var(--muted-foreground)' }}>fetched </span>{run.stats.fetched.toLocaleString()}
          <span style={{ color: 'var(--success)', marginLeft: 10 }}>+{run.stats.created}</span>
          <span style={{ color: 'var(--primary)', marginLeft: 10 }}>⟳{run.stats.updated.toLocaleString()}</span>
          {run.stats.errors > 0 && <span style={{ color: 'var(--destructive)', marginLeft: 10 }}>⚠{run.stats.errors}</span>}
        </td>
        <td style={{ padding: '12px 20px 12px 0', textAlign: 'right' }}>
          <StatusBadge status={run.status} />
        </td>
      </tr>

      {open && (
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <td colSpan={6} style={{ padding: '14px 20px 18px 56px', background: 'var(--muted)' }}>
            <div style={{ display: 'flex', gap: 32, marginBottom: run.errors.length ? 12 : 0 }}>
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>Run ID: <Code>{run.id}</Code></div>
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                API calls: <span style={{ fontFamily: 'var(--font-mono)' }}>{run.stats.fetched + run.stats.created + run.stats.updated}</span>
              </div>
            </div>
            {run.errors.length > 0 && <ErrorTable errors={run.errors} />}
            {run.debugLogs && run.debugLogs.length > 0 && <DebugLogTable logs={run.debugLogs} />}
          </td>
        </tr>
      )}
    </>
  );
}

// ── CSV export ────────────────────────────────────────────────────────────────

function downloadCsv(runs: SyncRun[]) {
  const header = ['id', 'startedAt', 'finishedAt', 'trigger', 'status',
    'fetched', 'created', 'updated', 'skipped', 'errors'];
  const rows = runs.map(r => [
    r.id, r.startedAt, r.finishedAt ?? '', r.trigger, r.status,
    r.stats.fetched, r.stats.created, r.stats.updated, r.stats.skipped, r.stats.errors,
  ].join(','));
  const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sync-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main component ────────────────────────────────────────────────────────────

const DATE_RANGES = [
  { label: 'Last 7 days',  days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'All time',     days: 0 },
];

export default function History() {
  const [rangeDays, setRangeDays] = useState(30);
  const [statusFilter, setStatusFilter] = useState<SyncRun['status'] | 'all'>('all');
  const [triggerFilter, setTriggerFilter] = useState<SyncRun['trigger'] | 'all'>('all');

  const { data: runs = [], isLoading } = useSyncRuns(200);

  const cutoff = rangeDays > 0 ? new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000) : null;

  const filtered = runs.filter(r => {
    if (cutoff && new Date(r.startedAt) < cutoff) return false;
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (triggerFilter !== 'all' && r.trigger !== triggerFilter) return false;
    return true;
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Sync history</h1>
          <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
            Every sync run is logged with stats and any per-record errors. Stored in Firestore.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* Date range pill group */}
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {DATE_RANGES.map(({ label, days }) => (
              <button
                key={days}
                onClick={() => setRangeDays(days)}
                style={{
                  height: 28, padding: '0 10px', border: 'none',
                  borderRight: days !== 0 ? '1px solid var(--border)' : 'none',
                  background: rangeDays === days ? 'var(--primary)' : 'var(--background)',
                  color: rangeDays === days ? 'var(--primary-foreground)' : 'var(--foreground)',
                  fontSize: 12, fontFamily: 'var(--font-sans)', fontWeight: 500,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  transition: 'background 120ms',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
              style={{
                appearance: 'none', WebkitAppearance: 'none',
                height: 28, padding: '0 26px 0 10px',
                borderRadius: 4, border: '1px solid var(--input)',
                background: 'var(--background)', color: 'var(--foreground)',
                fontSize: 12, fontFamily: 'var(--font-sans)', fontWeight: 500, cursor: 'pointer',
              }}
            >
              <option value="all">All statuses</option>
              <option value="success">Success</option>
              <option value="partial">Partial</option>
              <option value="failed">Failed</option>
            </select>
            <ChevronRight size={12} style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%) rotate(90deg)', color: 'var(--muted-foreground)', pointerEvents: 'none' }} />
          </div>

          {/* Trigger filter — distinguishes manual UI runs from scheduled ones */}
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <select
              value={triggerFilter}
              onChange={e => setTriggerFilter(e.target.value as typeof triggerFilter)}
              style={{
                appearance: 'none', WebkitAppearance: 'none',
                height: 28, padding: '0 26px 0 10px',
                borderRadius: 4, border: '1px solid var(--input)',
                background: 'var(--background)', color: 'var(--foreground)',
                fontSize: 12, fontFamily: 'var(--font-sans)', fontWeight: 500, cursor: 'pointer',
              }}
            >
              <option value="all">All triggers</option>
              <option value="ui">Manual</option>
              <option value="scheduler">Scheduled</option>
            </select>
            <ChevronRight size={12} style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%) rotate(90deg)', color: 'var(--muted-foreground)', pointerEvents: 'none' }} />
          </div>

          {/* Export */}
          <button
            onClick={() => downloadCsv(filtered)}
            disabled={filtered.length === 0}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: 28, padding: '0 10px', borderRadius: 4,
              border: '1px solid var(--input)', background: 'var(--background)',
              color: 'var(--foreground)', fontSize: 12, fontFamily: 'var(--font-sans)',
              fontWeight: 500, cursor: filtered.length === 0 ? 'not-allowed' : 'pointer',
              opacity: filtered.length === 0 ? 0.4 : 1,
            }}
          >
            <Download size={12} /> Export CSV
          </button>
        </div>
      </div>

      {isLoading ? (
        <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: 40, textAlign: 'center', color: 'var(--muted-foreground)', fontSize: 14 }}>
          No sync runs found for the selected filters.
        </section>
      ) : (
        <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--muted)' }}>
                <th style={{ width: 24 }} />
                <th style={{ padding: '10px 16px 10px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted-foreground)' }}>Started</th>
                <th style={{ padding: '10px 16px 10px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted-foreground)' }}>Trigger</th>
                <th style={{ padding: '10px 16px 10px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted-foreground)' }}>Duration</th>
                <th style={{ padding: '10px 16px 10px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted-foreground)' }}>Stats</th>
                <th style={{ padding: '10px 20px 10px 0', textAlign: 'right', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted-foreground)' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(run => <RunRow key={run.id} run={run} />)}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
