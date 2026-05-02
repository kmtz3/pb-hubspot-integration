import type { ReactNode } from 'react';
import { Plug, Filter, Columns, Calendar, History, Settings, BookOpen } from 'lucide-react';
import type { Tab } from '../App';
import { useConfig, useConnections } from '../hooks/api';

// Phase 1 sidebar groups (per plan task 11):
//   SETUP    – shared connection + general toggles
//   ACCOUNTS – companies sync surface (existing UX)
//   DEALS    – deals sync surface (placeholders this phase)
//   ACTIVITY – history, segmented in Phase 5
type NavGroup = {
  label: string;
  items: Array<{ id: Tab; label: string; Icon: React.ElementType }>;
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Setup',
    items: [
      { id: 'connect',  label: 'Connect',  Icon: Plug },
      { id: 'settings', label: 'Settings', Icon: Settings },
    ],
  },
  {
    label: 'Accounts',
    items: [
      { id: 'accounts-filter',   label: 'Filter accounts', Icon: Filter   },
      { id: 'accounts-fields',   label: 'Map fields',      Icon: Columns  },
      { id: 'accounts-schedule', label: 'Schedule',        Icon: Calendar },
    ],
  },
  {
    label: 'Deals',
    items: [
      { id: 'deals-filter',   label: 'Filter deals', Icon: Filter   },
      { id: 'deals-fields',   label: 'Map fields',   Icon: Columns  },
      { id: 'deals-schedule', label: 'Schedule',     Icon: Calendar },
    ],
  },
  {
    label: 'Activity',
    items: [
      { id: 'history', label: 'History', Icon: History },
    ],
  },
];

function SidebarSyncSummary() {
  const { data } = useConfig();
  const sync = data?.sync;

  const state = sync?.inProgress
    ? 'syncing'
    : sync?.lastSyncStatus ?? 'idle';

  const stateStyles: Record<string, { bg: string; dot: string; label: string }> = {
    success:  { bg: 'var(--success-accent)', dot: '#16a34a',  label: 'Healthy' },
    syncing:  { bg: 'var(--accent)',         dot: '#2563eb',  label: 'Syncing…' },
    partial:  { bg: 'var(--warning-accent)', dot: '#d97706',  label: 'Partial errors' },
    failed:   { bg: 'var(--destructive-accent)', dot: '#dc2626', label: 'Last sync failed' },
    idle:     { bg: 'var(--muted)',          dot: '#9ca3af',  label: 'Not configured' },
  };

  const s = stateStyles[state] ?? stateStyles['idle']!;

  return (
    <div style={{ background: s.bg, borderRadius: 8, padding: '10px 12px', fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot, display: 'inline-block',
          ...(state === 'syncing' ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}) }} />
        {s.label}
      </div>
      {sync?.lastSyncStats && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
          <span>+{sync.lastSyncStats.created}</span>
          <span>↻{sync.lastSyncStats.updated}</span>
          {sync.lastSyncStats.errors > 0 && <span>⚠{sync.lastSyncStats.errors}</span>}
        </div>
      )}
    </div>
  );
}

function PlatformChip({ icon, alt, label }: { icon: string; alt: string; label: string }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      minWidth: 0,
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--muted-foreground)',
      background: 'var(--muted)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '3px 8px 3px 6px',
      maxWidth: 180,
      whiteSpace: 'nowrap',
    }}>
      <img src={icon} width={14} height={14} alt={alt} style={{ objectFit: 'contain', flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </span>
  );
}

function WorkspaceChips() {
  const { data } = useConnections();
  const pbName = data?.productboard?.workspaceName;
  const hsPortal = data?.hubspot?.portalId;

  if (!pbName && !hsPortal) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {hsPortal && <PlatformChip icon="/logos/hubspot-icon.svg" alt="HubSpot" label={`Portal ${hsPortal}`} />}
      {pbName && <PlatformChip icon="/logos/pb-icon.svg" alt="Productboard" label={pbName} />}
    </div>
  );
}

interface ShellProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children: ReactNode;
}

export default function Shell({ activeTab, onTabChange, children }: ShellProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'var(--font-sans)' }}>
      {/* TopBar */}
      <header style={{
        height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 24px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/logos/hubspot-icon.svg" width={20} height={20} alt="HubSpot" style={{ objectFit: 'contain' }} />
          <span style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>→</span>
          <img src="/logos/pb-icon.svg" width={20} height={20} alt="Productboard" style={{ objectFit: 'contain' }} />
          <span style={{ fontWeight: 700, fontSize: 15, marginLeft: 4 }}>HubSpot Productboard Integration</span>
          <span style={{ background: 'var(--muted)', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 500 }}>v{__APP_VERSION__}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <WorkspaceChips />
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 13, cursor: 'pointer', textDecoration: 'none', color: 'inherit' }}>
            <BookOpen size={14} />
            Docs
          </a>
        </div>
      </header>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* SideNav */}
        <nav style={{
          width: 220, flexShrink: 0, padding: '20px 12px',
          borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        }}>
          {NAV_GROUPS.map(group => (
            <div key={group.label} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)', marginBottom: 6 }}>
                {group.label}
              </div>
              {group.items.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => onTabChange(id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: activeTab === id ? 600 : 400, textAlign: 'left',
                    background: activeTab === id ? 'var(--accent)' : 'transparent',
                    color: activeTab === id ? 'var(--accent-foreground)' : 'inherit',
                    marginBottom: 2, width: '100%',
                  }}>
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <SidebarSyncSummary />
        </nav>

        {/* Content */}
        <main style={{ flex: 1, overflow: 'auto', padding: '24px 32px 64px', maxWidth: 1200 }}>
          {children}
        </main>
      </div>
    </div>
  );
}
