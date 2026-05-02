import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import Shell from './components/Shell';
import Connect from './components/tabs/Connect';
import FilterAccounts from './components/tabs/FilterAccounts';
import MapFields from './components/tabs/MapFields';
import Schedule from './components/tabs/Schedule';
import History from './components/tabs/History';
import Settings from './components/tabs/Settings';
import { useConnections } from './hooks/api';

export type Tab = 'connect' | 'filter' | 'fields' | 'schedule' | 'history' | 'settings';

const TABS: Tab[] = ['connect', 'filter', 'fields', 'schedule', 'history', 'settings'];

export const TAB_PATHS: Record<Tab, string> = {
  connect:  '/connect',
  filter:   '/filter',
  fields:   '/map',
  schedule: '/schedule',
  history:  '/history',
  settings: '/settings',
};

const SLUG_TO_TAB: Record<string, Tab> = {
  connect:  'connect',
  filter:   'filter',
  map:      'fields',
  schedule: 'schedule',
  history:  'history',
  settings: 'settings',
};

const TAB_COMPONENTS: Record<Tab, React.ReactNode> = {
  connect:  <Connect />,
  filter:   <FilterAccounts />,
  fields:   <MapFields />,
  schedule: <Schedule />,
  history:  <History />,
  settings: <Settings />,
};

function HomeRedirect() {
  const { data, isLoading } = useConnections();
  if (isLoading) return null;
  const bothConnected = !!(data?.hubspot?.connected && data?.productboard?.connected);
  return <Navigate to={bothConnected ? '/schedule' : '/connect'} replace />;
}

function TabView() {
  const navigate = useNavigate();
  const { tab } = useParams<{ tab: string }>();
  const activeTab = tab ? (SLUG_TO_TAB[tab] ?? null) : null;

  if (!activeTab) return <Navigate to="/connect" replace />;

  return (
    <Shell activeTab={activeTab} onTabChange={(t) => navigate(TAB_PATHS[t])}>
      {TABS.map(t => (
        <div key={t} style={{ display: activeTab === t ? 'contents' : 'none' }}>
          {TAB_COMPONENTS[t]}
        </div>
      ))}
    </Shell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/:tab" element={<TabView />} />
      <Route path="*" element={<Navigate to="/connect" replace />} />
    </Routes>
  );
}
