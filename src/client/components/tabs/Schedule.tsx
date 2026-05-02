import { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Loader2, XCircle, CheckCircle, AlertCircle, ChevronDown, CalendarClock } from 'lucide-react';
import { useConfig, useSaveConfig, useStartSync, useCancelSync, useSyncRuns } from '../../hooks/api';
import { useSyncStream } from '../../hooks/useSyncStream';
import InlineAlert from '../ui/InlineAlert';
import type { SyncConfig, SyncStats, SyncRun } from '../../../types/sync';

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Singapore',
  'Australia/Sydney',
];

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const TIME_OPTIONS = ['00:00','01:00','02:00','03:00','04:00','05:00','06:00',
  '07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00',
  '15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00'];

// Ordered longest interval → shortest (Manual stays at top as the "no schedule" choice).
const SCHEDULE_OPTIONS: { value: SyncConfig['schedule']; label: string; desc: string }[] = [
  { value: 'manual',  label: 'Manual only',        desc: "Sync runs only when you click 'Sync now'. No scheduled jobs." },
  { value: 'weekly',  label: 'Weekly',              desc: 'One sweep per week — ideal if the source data is stable.' },
  { value: 'daily',   label: 'Daily',               desc: 'Recommended. One full sweep every night.' },
  { value: 'hourly',  label: 'Hourly',              desc: 'Picks up new HubSpot records within an hour. Heavier API usage.' },
  { value: 'every15', label: 'Every 15 minutes',    desc: 'Near real-time. Use only with strict account filters.' },
];

const DAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// Convert a wall-clock date+time interpreted in `tz` into the absolute UTC
// instant. Works by finding the offset between (year/month/day/hh/mm as UTC)
// and what `tz` would show for that same instant, then subtracting it.
// Edge case: ambiguous DST hours (spring-forward gap, fall-back overlap) land
// on whichever side Intl picks — same ambiguity Cloud Scheduler has, so safe.
function zonedDateTimeToUTC(
  year: number, month: number, day: number,
  hh: number, mm: number, tz: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hh, mm, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(naive)).map(x => [x.type, x.value]));
  const hour24 = p.hour === '24' ? 0 : Number(p.hour);
  const tzAsUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    hour24, Number(p.minute), 0,
  );
  return new Date(naive - (tzAsUTC - naive));
}

function nextFireTime(sync: SyncConfig, now: Date): Date | null {
  if (sync.schedule === 'every15' || sync.schedule === 'hourly') {
    const intervalMs = (sync.schedule === 'every15' ? 15 : 60) * 60_000;
    return new Date(Math.ceil((now.getTime() + 1) / intervalMs) * intervalMs);
  }
  if (sync.schedule !== 'daily' && sync.schedule !== 'weekly') return null;

  const tz = sync.timezone ?? 'America/New_York';
  const [hh, mm] = (sync.scheduleTime ?? '02:00').split(':').map(Number);
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const wdFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });

  const tryOffset = (days: number): Date => {
    const probe = new Date(now.getTime() + days * 86_400_000);
    const d = Object.fromEntries(dateFmt.formatToParts(probe).map(x => [x.type, x.value]));
    return zonedDateTimeToUTC(Number(d.year), Number(d.month), Number(d.day), hh, mm, tz);
  };

  if (sync.schedule === 'daily') {
    const today = tryOffset(0);
    return today > now ? today : tryOffset(1);
  }

  const targetDow = DAY_INDEX[sync.scheduleDay ?? 'Monday'] ?? 1;
  for (let i = 0; i < 8; i++) {
    const candidate = tryOffset(i);
    if (candidate <= now) continue;
    if (DAY_INDEX[wdFmt.format(candidate)] === targetDow) return candidate;
  }
  return null;
}

function formatRelative(target: Date, now: Date): string {
  const totalMin = Math.max(0, Math.round((target.getTime() - now.getTime()) / 60_000));
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `in ${h}h ${String(m).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

// Returns the banner copy for the saved schedule. Null = no banner (manual).
// For interval-based cadences (every15, hourly) shows just the relative
// countdown. For daily/weekly, shows the absolute next-fire time in the user's
// browser timezone plus the relative countdown for at-a-glance context.
function formatNextFire(sync: SyncConfig, now: Date): string | null {
  if (sync.schedule === 'manual') return null;
  const next = nextFireTime(sync, now);
  if (!next) return null;
  const rel = formatRelative(next, now);

  if (sync.schedule === 'every15' || sync.schedule === 'hourly') {
    return `next sync ${rel}`;
  }
  const abs = next.toLocaleString(undefined, {
    weekday: sync.schedule === 'weekly' ? 'long' : undefined,
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  });
  return `next sync at ${abs} (${rel})`;
}

type ScheduleForm = Pick<SyncConfig, 'schedule' | 'scheduleTime' | 'scheduleDay' | 'timezone'>;

// ── Styled select ─────────────────────────────────────────────────────────────

function StyledSelect({ value, onChange, options, width }: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  width?: number;
}) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex', width }}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          appearance: 'none', WebkitAppearance: 'none',
          height: 28, padding: '0 26px 0 10px',
          borderRadius: 4, border: '1px solid var(--input)',
          background: 'var(--background)', color: 'var(--foreground)',
          fontSize: 12, fontFamily: 'var(--font-sans)',
          fontWeight: 500, cursor: 'pointer', width: '100%',
        }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown size={12} style={{
        position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
        color: 'var(--muted-foreground)', pointerEvents: 'none',
      }} />
    </div>
  );
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

// ── Stat block ────────────────────────────────────────────────────────────────

function StatRow({ stats }: { stats: Partial<SyncStats> }) {
  const { fetched = 0, created = 0, updated = 0, skipped = 0, errors = 0 } = stats;
  const items = [
    { label: 'Fetched',  value: fetched.toLocaleString(),    color: 'var(--foreground)' },
    { label: 'Created',  value: `+${created}`,               color: 'var(--success)' },
    { label: 'Updated',  value: `⟳ ${updated.toLocaleString()}`, color: 'var(--primary)' },
    { label: 'Skipped',  value: String(skipped),             color: 'var(--muted-foreground)' },
    { label: 'Errors',   value: String(errors),              color: errors > 0 ? 'var(--destructive)' : 'var(--muted-foreground)' },
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 14, background: 'var(--muted)', borderRadius: 6 }}>
      {items.map(({ label, value, color }) => (
        <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 72, flex: '1 1 72px' }}>
          <div style={{ fontSize: 10, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2, color, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Live progress card ────────────────────────────────────────────────────────

function SyncProgressCard({ runId, onCancel, onDone }: { runId: string; onCancel: () => void; onDone: () => void }) {
  const { latestProgress, done } = useSyncStream(runId);
  const cancelMutation = useCancelSync();

  // Bubble the SSE `done` signal up so the parent can clear `isSyncing`,
  // dismiss this card, and refresh the Last sync query. Without this the
  // progress card and "Syncing…" button stick forever after the run ends.
  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);

  const pct = latestProgress
    ? Math.round((latestProgress.processed / Math.max(latestProgress.total, 1)) * 100)
    : 0;

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--primary)', borderRadius: 8,
      padding: 20, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: 'var(--primary)', animation: 'pulse 1.4s ease-in-out infinite' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Sync in progress · manual trigger</div>
          {latestProgress && (
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
              ETA {latestProgress.eta} · streaming via Server-Sent Events
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
        <>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, fontFamily: 'var(--font-mono)' }}>
              <span>{latestProgress.processed.toLocaleString()} / {latestProgress.total.toLocaleString()} companies</span>
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
          <StatRow stats={latestProgress} />
        </>
      )}
    </div>
  );
}

// ── Last sync card ────────────────────────────────────────────────────────────

function LastSyncCard({ run, isSyncing, onSyncNow, syncPending }: {
  run?: SyncRun; isSyncing: boolean; onSyncNow: () => void; syncPending: boolean;
}) {
  const palette = run ? {
    success: { color: 'var(--success)',     icon: CheckCircle,   label: 'Success' },
    partial: { color: 'var(--warning)',     icon: AlertCircle,   label: 'Partial — completed with errors' },
    failed:  { color: 'var(--destructive)', icon: XCircle,       label: 'Failed' },
    running: { color: 'var(--primary)',     icon: Loader2,       label: 'Running' },
  }[run.status] : null;

  const started = run ? new Date(run.startedAt).toLocaleString() : null;
  const durationSec = run?.finishedAt
    ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : null;
  const durationLabel = durationSec !== null
    ? durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`
    : null;

  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.0075em' }}>Last sync</div>
          <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>Most recent run summary.</div>
        </div>
        <button
          onClick={onSyncNow}
          disabled={isSyncing || syncPending}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 28, padding: '0 10px', borderRadius: 4,
            border: '1px solid var(--input)', background: 'var(--background)',
            color: 'var(--foreground)', fontSize: 12, fontFamily: 'var(--font-sans)',
            fontWeight: 600, cursor: isSyncing || syncPending ? 'not-allowed' : 'pointer',
            opacity: isSyncing || syncPending ? 0.5 : 1,
            transition: 'background 150ms',
          }}
        >
          {isSyncing
            ? <><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Syncing…</>
            : <><RefreshCw size={12} /> Sync now</>
          }
        </button>
      </div>

      <div style={{ padding: 20 }}>
        {!run ? (
          <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--muted-foreground)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>No sync has run yet</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Connect both systems and map fields, then click "Sync now".</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {palette && <palette.icon size={20} style={{ color: palette.color }} />}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{palette?.label}</div>
                <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                  {started}{durationLabel && ` · ${durationLabel}`}{run.trigger && ` · trigger: ${run.trigger}`}
                </div>
              </div>
            </div>
            <StatRow stats={run.stats} />
            {run.errors.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--destructive)' }}>
                {run.errors.length} error{run.errors.length !== 1 ? 's' : ''} — see History for details
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Schedule() {
  const { data: config, isLoading } = useConfig();
  const saveMutation = useSaveConfig();
  const startMutation = useStartSync();
  const { data: runs = [] } = useSyncRuns(1);
  const queryClient = useQueryClient();

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // Tick once per 30s so the "in Xh Ym" countdown in the banner stays fresh
  // without re-rendering the whole page constantly.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Called when the SSE stream emits `done` (success, partial, or failed).
  // Clears the in-progress state and refetches sync-runs + config so the
  // Last sync card and the persisted `inProgress` flag both update.
  const handleSyncDone = () => {
    setIsSyncing(false);
    setActiveRunId(null);
    queryClient.invalidateQueries({ queryKey: ['sync-runs'] });
    queryClient.invalidateQueries({ queryKey: ['config'] });
  };

  const sync = config?.sync;

  const { control, handleSubmit, watch, reset } = useForm<ScheduleForm>({
    defaultValues: { schedule: 'manual', scheduleTime: '02:00', scheduleDay: 'Monday', timezone: 'America/New_York' },
  });

  // Sync local UI state to server-persisted `inProgress`. Deps must NOT
  // include `activeRunId`: between click and the next config refetch, `sync`
  // is stale (inProgress=false), so re-running this effect on activeRunId
  // change wipes the runId we just set and kills the SSE stream.
  useEffect(() => {
    if (!sync) return;
    reset({
      schedule: sync.schedule,
      scheduleTime: sync.scheduleTime ?? '02:00',
      scheduleDay: sync.scheduleDay ?? 'Monday',
      timezone: sync.timezone ?? 'America/New_York',
    });
    if (sync.inProgress) {
      setIsSyncing(true);
    } else {
      setIsSyncing(false);
      setActiveRunId(null);
    }
  }, [sync, reset]);

  // SSE can be interrupted by page navigation, dev-server restarts, or a
  // dropped browser connection. While the UI believes a sync is active, poll
  // persisted config/history so it can recover when the backend has finished.
  useEffect(() => {
    if (!isSyncing) return;
    const t = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['sync-runs'] });
    }, 5000);
    return () => clearInterval(t);
  }, [isSyncing, queryClient]);

  // Auto-dismiss the saved/failed indicator after a moment so it
  // doesn't linger and imply that subsequent unsaved edits are persisted.
  useEffect(() => {
    if (!saveMutation.isSuccess && !saveMutation.isError) return;
    const t = setTimeout(() => saveMutation.reset(), 2500);
    return () => clearTimeout(t);
  }, [saveMutation.isSuccess, saveMutation.isError, saveMutation.reset]);

  // Clear the indicator immediately when the user edits anything,
  // since the displayed config no longer matches what's saved.
  useEffect(() => {
    const sub = watch(() => {
      if (saveMutation.isSuccess || saveMutation.isError) saveMutation.reset();
    });
    return () => sub.unsubscribe();
  }, [watch, saveMutation.isSuccess, saveMutation.isError, saveMutation.reset]);

  const schedule = watch('schedule');

  function onSubmit(values: ScheduleForm) {
    saveMutation.mutate({ sync: { ...sync!, ...values } });
  }

  function handleSyncNow() {
    setIsSyncing(true);
    startMutation.mutate('ui', {
      onSuccess: ({ runId }) => setActiveRunId(runId),
      onError: () => setIsSyncing(false),
    });
  }

  if (isLoading) return <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>;

  const lastRun = runs[0];
  const cadenceTooFast = schedule === 'hourly' || schedule === 'every15';

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Schedule</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
          Cloud Scheduler triggers a sync at the chosen cadence. Manual syncs run immediately and bypass any incremental window.
        </p>
      </div>

      {sync && formatNextFire(sync, now) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px', marginBottom: 16,
          background: 'var(--accent)', border: '1px solid var(--border)',
          borderRadius: 8, color: 'var(--accent-foreground)',
        }}>
          <CalendarClock size={18} style={{ color: 'var(--primary)', flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 13, lineHeight: 1.4 }}>
            <span style={{ fontWeight: 600 }}>Scheduled run set</span>
            <span style={{ color: 'var(--muted-foreground)' }}> · {formatNextFire(sync, now)}</span>
          </div>
        </div>
      )}

      {isSyncing && activeRunId && (
        <SyncProgressCard
          runId={activeRunId}
          onCancel={() => { setIsSyncing(false); setActiveRunId(null); }}
          onDone={handleSyncDone}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        {/* Cadence card */}
        <form onSubmit={handleSubmit(onSubmit)}>
          <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.0075em' }}>Cadence</div>
              <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>Pick how often the sync runs unattended.</div>
            </div>

            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Controller
                name="schedule"
                control={control}
                render={({ field }) => (
                  <>
                    {SCHEDULE_OPTIONS.map(opt => (
                      <div key={opt.value}>
                        <RadioCard
                          checked={field.value === opt.value}
                          onChange={() => field.onChange(opt.value)}
                          label={opt.label}
                          hint={opt.desc}
                        />

                        {field.value === 'daily' && opt.value === 'daily' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 36, marginTop: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>at</span>
                            <Controller name="scheduleTime" control={control} render={({ field: tf }) => (
                              <StyledSelect value={tf.value ?? '02:00'} onChange={tf.onChange} options={TIME_OPTIONS} width={90} />
                            )} />
                            <Controller name="timezone" control={control} render={({ field: tzf }) => (
                              <StyledSelect value={tzf.value ?? 'America/New_York'} onChange={tzf.onChange} options={TIMEZONES} width={200} />
                            )} />
                          </div>
                        )}

                        {field.value === 'weekly' && opt.value === 'weekly' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 36, marginTop: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>on</span>
                            <Controller name="scheduleDay" control={control} render={({ field: df }) => (
                              <StyledSelect value={df.value ?? 'Monday'} onChange={df.onChange} options={DAYS} width={130} />
                            )} />
                            <span style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>at</span>
                            <Controller name="scheduleTime" control={control} render={({ field: tf }) => (
                              <StyledSelect value={tf.value ?? '02:00'} onChange={tf.onChange} options={TIME_OPTIONS} width={90} />
                            )} />
                            <Controller name="timezone" control={control} render={({ field: tzf }) => (
                              <StyledSelect value={tzf.value ?? 'America/New_York'} onChange={tzf.onChange} options={TIMEZONES} width={200} />
                            )} />
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}
              />

              {cadenceTooFast && (
                <InlineAlert variant="warning">
                  At this cadence, a 4,800-company sync uses significant HubSpot API quota. Tighten the account filter or monitor headroom closely.
                </InlineAlert>
              )}

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
                  type="submit"
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
        </form>

        {/* Last sync card */}
        <LastSyncCard
          run={lastRun}
          isSyncing={isSyncing}
          onSyncNow={handleSyncNow}
          syncPending={startMutation.isPending}
        />
      </div>
    </div>
  );
}
