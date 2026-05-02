import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useForm, Controller } from 'react-hook-form';
import { useConfig, useSaveConfig } from '../../hooks/api';
import InlineAlert from '../ui/InlineAlert';
import Code from '../ui/Code';
import type { SyncConfig } from '../../../types/sync';

type SettingsForm = Pick<SyncConfig,
  | 'domainFallbackEnabled'
  | 'historyRetentionDays'
  | 'debugLogging'
  | 'syncToPBProperty'
>;

// ── Section card ──────────────────────────────────────────────────────────────

function Section({ title, description, children }: {
  title: string; description?: string; children: React.ReactNode;
}) {
  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.0075em' }}>{title}</div>
        {description && <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 2 }}>{description}</div>}
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 0 }}>{children}</div>
    </section>
  );
}

// ── Setting row ───────────────────────────────────────────────────────────────

function SettingRow({ label, hint, ctrl }: {
  label: string; hint: string | React.ReactNode; ctrl: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 24, padding: '12px 0', borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 2, maxWidth: 560 }}>{hint}</div>
      </div>
      <div style={{ flexShrink: 0, paddingTop: 2 }}>{ctrl}</div>
    </div>
  );
}

function SettingRowLast({ label, hint, ctrl }: {
  label: string; hint: string | React.ReactNode; ctrl: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 24, padding: '12px 0', alignItems: 'flex-start' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 2, maxWidth: 560 }}>{hint}</div>
      </div>
      <div style={{ flexShrink: 0, paddingTop: 2 }}>{ctrl}</div>
    </div>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const w = 36, h = 20, knob = h - 4;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative', width: w, height: h, borderRadius: 99,
        border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
        background: checked ? 'var(--primary)' : 'oklch(81% 0.02 280)',
        transition: 'background 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? w - knob - 2 : 2,
        width: knob, height: knob, borderRadius: 99, background: 'white',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        transition: 'left 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      }} />
    </button>
  );
}

// ── Styled select ─────────────────────────────────────────────────────────────

function StyledSelect({ value, onChange, options }: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          appearance: 'none', WebkitAppearance: 'none',
          height: 28, padding: '0 26px 0 10px',
          borderRadius: 4, border: '1px solid var(--input)',
          background: 'var(--background)', color: 'var(--foreground)',
          fontSize: 12, fontFamily: 'var(--font-sans)', fontWeight: 500, cursor: 'pointer',
        }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-foreground)', pointerEvents: 'none', fontSize: 10 }}>▾</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Settings() {
  const { data: config, isLoading } = useConfig();
  const saveMutation = useSaveConfig();
  const [showSaved, setShowSaved] = useState(false);


  const { control, handleSubmit, reset, watch } = useForm<SettingsForm>({
    defaultValues: {
      domainFallbackEnabled: true,
      historyRetentionDays: 90,
      debugLogging: false,
      syncToPBProperty: '',
    },
  });

  const sync = config?.sync;

  useEffect(() => {
    if (sync) {
      reset({
        domainFallbackEnabled: sync.domainFallbackEnabled,
        historyRetentionDays: sync.historyRetentionDays ?? 90,
        debugLogging: sync.debugLogging ?? false,
        syncToPBProperty: sync.syncToPBProperty ?? '',
      });
    }
  }, [sync, reset]);

  // Auto-dismiss the error banner after a moment, mirroring the success indicator.
  useEffect(() => {
    if (!saveMutation.isError) return;
    const t = setTimeout(() => saveMutation.reset(), 4000);
    return () => clearTimeout(t);
  }, [saveMutation.isError, saveMutation.reset]);

  // Clear both indicators the moment the user edits anything — they no
  // longer reflect what's saved, so showing them would be misleading.
  useEffect(() => {
    const sub = watch(() => {
      if (showSaved) setShowSaved(false);
      if (saveMutation.isError) saveMutation.reset();
    });
    return () => sub.unsubscribe();
  }, [watch, showSaved, saveMutation.isError, saveMutation.reset]);

  function onSubmit(values: SettingsForm) {
    saveMutation.mutate({ sync: { ...sync!, ...values } }, {
      onSuccess: () => {
        setShowSaved(true);
        setTimeout(() => setShowSaved(false), 2500);
      },
    });
  }

  if (isLoading) return <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>;

  const env = import.meta.env.MODE;

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Settings</h1>
            <p style={{ color: 'var(--muted-foreground)', fontSize: 13, marginTop: 4 }}>
              Advanced sync behaviour and account preferences.
            </p>
          </div>
          <button
            type="submit"
            disabled={saveMutation.isPending}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              height: 28, padding: '0 12px', borderRadius: 4, border: 'none',
              background: showSaved ? 'var(--success)' : 'var(--primary)',
              color: 'var(--primary-foreground)',
              fontSize: 12, fontFamily: 'var(--font-sans)', fontWeight: 600,
              cursor: saveMutation.isPending ? 'not-allowed' : 'pointer',
              opacity: saveMutation.isPending ? 0.6 : 1,
              transition: 'background 200ms',
            }}
          >
            {showSaved && <Check size={13} strokeWidth={2.5} />}
            {saveMutation.isPending ? 'Saving…' : showSaved ? 'Saved' : 'Save settings'}
          </button>
        </div>

        {saveMutation.isError && <div style={{ marginBottom: 16 }}><InlineAlert variant="destructive">Failed to save settings. Please try again.</InlineAlert></div>}

        {/* Deduplication */}
        <Section title="Deduplication" description="How the sync engine matches HubSpot companies to existing Productboard records.">
          <SettingRow
            label="Domain fallback matching"
            hint="When a HubSpot company has no matching PB record by source ID, fall back to matching by domain. The first match's ID is written back so future syncs use the fast primary path."
            ctrl={
              <Controller name="domainFallbackEnabled" control={control}
                render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />} />
            }
          />
          <SettingRowLast
            label="Sync-to-PB property name (HubSpot)"
            hint={<>Optional. Only sync HubSpot companies where this boolean property is true — useful as a manual opt-in. Leave blank to sync all companies passing the account filter.</>}
            ctrl={
              <Controller name="syncToPBProperty" control={control}
                render={({ field }) => (
                  <input
                    type="text"
                    placeholder="e.g. pb_sync_enabled"
                    {...field}
                    style={{
                      height: 28, padding: '0 10px', width: 200,
                      borderRadius: 4, border: '1px solid var(--input)',
                      background: 'var(--background)', color: 'var(--foreground)',
                      fontSize: 12, fontFamily: 'var(--font-mono)', outline: 'none',
                    }}
                  />
                )}
              />
            }
          />
        </Section>

        {/* Hygiene */}
        <Section title="Hygiene" description="Data retention and operational logging.">
          <SettingRow
            label="Sync history retention"
            hint="Sync run records older than the chosen window are automatically purged from Firestore."
            ctrl={
              <Controller name="historyRetentionDays" control={control}
                render={({ field }) => (
                  <StyledSelect
                    value={String(field.value ?? 90)}
                    onChange={v => field.onChange(Number(v))}
                    options={[
                      { value: '30',      label: '30 days' },
                      { value: '90',      label: '90 days' },
                      { value: '365',     label: '1 year' },
                      { value: '0',       label: 'Forever' },
                    ]}
                  />
                )}
              />
            }
          />
          <SettingRowLast
            label="Debug logging"
            hint="Stores extended per-record failure diagnostics in sync history, including the attempted Productboard payload and full API error response. Disable during normal operation to reduce history size."
            ctrl={
              <Controller name="debugLogging" control={control}
                render={({ field }) => <Toggle checked={field.value ?? false} onChange={field.onChange} />} />
            }
          />
        </Section>

        {/* Diagnostics */}
        <Section title="Diagnostics">
          <SettingRowLast
            label="Environment"
            hint="Runtime environment and connected workspace identifiers."
            ctrl={null}
          />
          <div style={{ background: 'var(--muted)', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)' }}>mode: {env}</div>
            {config?.hubspot.portalId && <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)' }}>hs_portal_id: {config.hubspot.portalId}</div>}
            {config?.productboard.workspaceName && <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)' }}>pb_workspace: {config.productboard.workspaceName}</div>}
          </div>
        </Section>

        {/* Danger zone */}
        <section style={{ background: 'var(--card)', border: '1px solid oklch(60% 0.23 25 / 0.3)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid oklch(60% 0.23 25 / 0.2)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.0075em', color: 'var(--destructive)' }}>Danger zone</div>
          </div>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 0 }}>
            <SettingRow
              label="Reset all configuration"
              hint="Clears mappings, filters, schedule, and history. Tokens in Secret Manager are not affected."
              ctrl={
                <button type="button" style={{
                  height: 28, padding: '0 12px', borderRadius: 4,
                  border: '1px solid var(--destructive)', background: 'var(--background)',
                  color: 'var(--destructive)', fontSize: 12, fontFamily: 'var(--font-sans)',
                  fontWeight: 600, cursor: 'pointer',
                }}>
                  Reset config
                </button>
              }
            />
            <SettingRowLast
              label="Disconnect both systems"
              hint="Removes saved tokens and disables all syncs. Existing Productboard records are not deleted."
              ctrl={
                <a href="/auth/logout" style={{
                  display: 'inline-flex', alignItems: 'center',
                  height: 28, padding: '0 12px', borderRadius: 4,
                  border: '1px solid var(--destructive)', background: 'var(--background)',
                  color: 'var(--destructive)', fontSize: 12, fontFamily: 'var(--font-sans)',
                  fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
                }}>
                  Disconnect
                </a>
              }
            />
          </div>
        </section>
      </div>
    </form>
  );
}
