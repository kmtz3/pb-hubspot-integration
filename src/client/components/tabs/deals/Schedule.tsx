import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle, XCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useConfig, useSaveConfig, useSyncRuns, useCancelSync, useTriggerBackfill } from '../../../hooks/api';
import { useSyncStream } from '../../../hooks/useSyncStream';
import BackfillPicker from '../../ui/BackfillPicker';
import InlineAlert from '../../ui/InlineAlert';
import type { SyncRun } from '../../../../types/sync';

type ScheduleEnum = 'manual' | 'daily' | 'weekly' | 'hourly' | 'every15';

const SCHEDULE_OPTIONS: { value: ScheduleEnum; label: string; desc: string }[] = [
  { value: 'manual',  label: 'Manual only',     desc: 'Deals sync only when triggered manually or by a backfill run.' },
  { value: 'weekly',  label: 'Weekly',           desc: 'One sweep per week.' },
  { value: 'daily',   label: 'Daily',            desc: 'Recommended. One full sweep every night.' },
  { value: 'hourly',  label: 'Hourly',           desc: 'Picks up new deals within an hour. Heavier API usage.' },
  { value: 'every15', label: 'Every 15 minutes', desc: 'Near real-time. Use only with strict deal filters.' },
];

function enumToCron(schedule: ScheduleEnum): string | null {
  if (schedule === 'manual')   return null;
  if (schedule === 'every15')  return '*/15 * * * *';
  if (schedule === 'hourly')   return '0 * * * *';
  if (schedule === 'daily')    return '0 2 * * *';
  if (schedule === 'weekly')   return '0 2 * * 1';
  return null;
}

function cronToEnum(cron: string | null | undefined): ScheduleEnum {
  if (!cron) return 'manual';
  if (cron === '*/15 * * * *') return 'every15';
  if (/^\d+ \* \* \* \*$/.test(cron)) return 'hourly';
  if (/^\d+ \d+ \* \* \*$/.test(cron)) return 'daily';
  if (/^\d+ \d+ \* \* \d+$/.test(cron)) return 'weekly';
  return 'manual';
}

// ── Radio card ────────────────────────────────────────────────────────────────

function RadioCard({ checked, onChange, label, hint }: {
  checked: boolean; onChange: () => void; label: string; hint: string;
}) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
      border: `1px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
      borderRadius: 6, cursor: 'pointer',
      background: checked ? 'var(--accent)' : 'var(--background)',
      transition: 'background 150ms, border-color 150ms',
    }}>
      <span style={{
        width: 16, height: 16, borderRadius: 99, marginTop: 1,
        border: `2px solid ${checked ? 'var(--primary)' : 'var(--input)'}`,
        background: 'var(--background)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {checked && <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--primary)' }} />}
      </span>
      <input type="radio" checked={checked} onChange={onChange} style={{ display: 'none' }} />
      <div style={{ flex: 1, fontSize: 13 }}>
        <div style={{ fontWeight: 600, color: checked ? 'var(--accent-foreground)' : 'var(--foreground)' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 2 }}>{hint}</div>
      </div>
    </label>
  );
}

// ── Backfill progress card ────────────────────────────────────────────────────

function BackfillProgressCard({ runId, onDone, onCancel }: {
  runId: string; onDone: () => void; onCancel: () => void;
}) {
  const { latestProgress, done } = useSyncStream(runId);
  const cancelMutation = useCancelSync();

  useEffect(() => { if (done) onDone(); }, [done, onDone]);

  const pct = latestProgress
    ? Math.round((latestProgress.processed / Math.max(latestProgress.total, 1)) * 100)
    : 0;

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--primary)', borderRadius: 8,
      padding: 20, display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: 'var(--primary)', animation: 'pulse 1.4s ease-in-out infinite' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Backfill in progress</div>
          {latestProgress && (
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
              ETA {latestProgress.eta}
            </div>
          )}
        </div>
        {!done && (
          <button
            onClick={() => cancelMutation.mutate(runId, { onSuccess: onCancel })}
            disabled={cancelMutation.isPending}
            style={{ border: '1px solid var(--destructive)', borderRadius: 6, padding: '5px 12px', background: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--destructive)', opacity: cancelMutation.isPending ? 0.5 : 1 }}
          >
            Cancel
          </button>
        )}
      </div>

      {latestProgress && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, fontFamily: 'var(--font-mono)' }}>
            <span>{latestProgress.processed.toLocaleString()} / {latestProgress.total.toLocaleString()} deals</span>
            <span style={{ fontWeight: 600 }}>{pct}%</span>
          </div>
          <div style={{ height: 8, background: 'var(--muted)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: 'linear-gradient(90deg, var(--primary), oklch(76% 0.12 255))',
              transition: 'width 280ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
            }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Last backfill run card ─────────────────────────────────────────────────────

function LastBackfillCard({ run }: { run?: SyncRun }) {
  if (!run) return null;
  const palette = {
    success: { color: 'var(--success)',          icon: CheckCircle,  label: 'Completed' },
    partial: { color: 'var(--warning)',          icon: AlertCircle,  label: 'Partial'   },
    failed:  { color: 'var(--destructive)',      icon: XCircle,      label: 'Failed'    },
    running: { color: 'var(--primary)',          icon: Loader2,      label: 'Running'   },
    skipped: { color: 'var(--muted-foreground)', icon: AlertCircle,  label: run.skipReason ?? 'Skipped' },
  }[run.status];

  const started = new Date(run.startedAt).toLocaleString();
  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid var(--border)', marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        Last backfill
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <palette.icon size={16} style={{ color: palette.color, flexShrink: 0 }} />
        <span style={{ fontWeight: 600 }}>{palette.label}</span>
        <span style={{ color: 'var(--muted-foreground)' }}>·</span>
        <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>{started}</span>
        {(run.stats.created > 0 || run.stats.updated > 0) && (
          <>
            <span style={{ color: 'var(--muted-foreground)' }}>·</span>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
              <span style={{ color: 'var(--success)' }}>+{run.stats.created}</span>
              <span style={{ color: 'var(--primary)', marginLeft: 8 }}>⟳{run.stats.updated}</span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DealsSchedule() {
  const { data: config, isLoading } = useConfig();
  const saveMutation = useSaveConfig();
  const backfillMutation = useTriggerBackfill();
  const { data: allRuns = [] } = useSyncRuns(50);
  const queryClient = useQueryClient();

  const [schedule, setSchedule] = useState<ScheduleEnum>('manual');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (config?.sync?.schedule?.deals !== undefined) {
      setSchedule(cronToEnum(config.sync.schedule.deals));
    }
  }, [config?.sync?.schedule?.deals]);

  useEffect(() => {
    if (!saveMutation.isSuccess && !saveMutation.isError) return;
    const t = setTimeout(() => saveMutation.reset(), 2500);
    return () => clearTimeout(t);
  }, [saveMutation.isSuccess, saveMutation.isError, saveMutation.reset]);

  function handleSaveSchedule() {
    const cron = enumToCron(schedule);
    saveMutation.mutate({ sync: { schedule: { deals: cron } } as never });
  }

  function handleRunDone() {
    setIsRunning(false);
    setActiveRunId(null);
    queryClient.invalidateQueries({ queryKey: ['sync-runs'] });
    queryClient.invalidateQueries({ queryKey: ['config'] });
  }

  const lastBackfillRun = allRuns.find(r => r.objectType === 'deals' && r.mode === 'backfill');

  if (isLoading) return <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Deals schedule</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
          Cadence and backfill window for syncing HubSpot deals into Productboard notes.
        </p>
      </div>

      {isRunning && activeRunId && (
        <div style={{ marginBottom: 16 }}>
          <BackfillProgressCard
            runId={activeRunId}
            onDone={handleRunDone}
            onCancel={() => { setIsRunning(false); setActiveRunId(null); }}
          />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        {/* Cadence card */}
        <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Cadence</div>
            <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>
              How often the incremental deals sync runs.
            </div>
          </div>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {SCHEDULE_OPTIONS.map(opt => (
              <RadioCard
                key={opt.value}
                checked={schedule === opt.value}
                onChange={() => setSchedule(opt.value)}
                label={opt.label}
                hint={opt.desc}
              />
            ))}
            <div style={{ marginTop: 6, paddingTop: 16, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16 }}>
              {saveMutation.isSuccess && (
                <InlineAlert variant="success">
                  <CheckCircle size={16} color="var(--success)" style={{ flexShrink: 0, marginTop: 1, marginRight: 4 }} />
                  Schedule saved.
                </InlineAlert>
              )}
              {saveMutation.isError && (
                <InlineAlert variant="destructive">Save failed — try again.</InlineAlert>
              )}
              <button
                type="button"
                onClick={handleSaveSchedule}
                disabled={saveMutation.isPending}
                style={{
                  height: 28, padding: '0 12px', borderRadius: 4, border: 'none',
                  background: 'var(--primary)', color: 'var(--primary-foreground)',
                  fontSize: 12, fontFamily: 'var(--font-sans)', fontWeight: 600,
                  cursor: saveMutation.isPending ? 'not-allowed' : 'pointer',
                  opacity: saveMutation.isPending ? 0.6 : 1,
                }}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save schedule'}
              </button>
            </div>
          </div>
        </section>

        {/* Backfill card */}
        <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Backfill</div>
            <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>
              Re-sync deals in a historical window — useful for initial load or missed runs.
            </div>
          </div>
          <div style={{ padding: 20 }}>
            <BackfillPicker
              isPending={isRunning}
              onRun={req => {
                if (isRunning) return;
                setIsRunning(true);
                backfillMutation.mutate(req, {
                  onSuccess: ({ runId }) => setActiveRunId(runId),
                  onError: () => setIsRunning(false),
                });
              }}
            />
            <LastBackfillCard run={lastBackfillRun} />
          </div>
        </section>
      </div>
    </div>
  );
}
