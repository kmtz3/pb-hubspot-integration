import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import Shell from './components/Shell';
import Connect from './components/tabs/setup/Connect';
import Settings from './components/tabs/setup/Settings';
import AccountsFilter from './components/tabs/accounts/Filter';
import AccountsMapFields from './components/tabs/accounts/MapFields';
import AccountsSchedule from './components/tabs/accounts/Schedule';
import DealsFilter from './components/tabs/deals/Filter';
import DealsMapFields from './components/tabs/deals/MapFields';
import DealsSchedule from './components/tabs/deals/Schedule';
import History from './components/tabs/activity/History';
import { useConnections } from './hooks/api';

// Phase 1 sidebar IDs are object-typed prefixes: `accounts-*` and `deals-*`.
// Setup + Activity stay as flat ids since they're shared across object types.
export type Tab =
  | 'connect'
  | 'settings'
  | 'accounts-filter' | 'accounts-fields' | 'accounts-schedule'
  | 'deals-filter'    | 'deals-fields'    | 'deals-schedule'
  | 'history';

const TABS: Tab[] = [
  'connect', 'settings',
  'accounts-filter', 'accounts-fields', 'accounts-schedule',
  'deals-filter',    'deals-fields',    'deals-schedule',
  'history',
];

export const TAB_PATHS: Record<Tab, string> = {
  'connect':            '/connect',
  'settings':           '/settings',
  'accounts-filter':    '/accounts/filter',
  'accounts-fields':    '/accounts/map',
  'accounts-schedule':  '/accounts/schedule',
  'deals-filter':       '/deals/filter',
  'deals-fields':       '/deals/map',
  'deals-schedule':     '/deals/schedule',
  'history':            '/history',
};

const PATH_TO_TAB: Record<string, Tab> = {
  'connect':           'connect',
  'settings':          'settings',
  'accounts/filter':   'accounts-filter',
  'accounts/map':      'accounts-fields',
  'accounts/schedule': 'accounts-schedule',
  'deals/filter':      'deals-filter',
  'deals/map':         'deals-fields',
  'deals/schedule':    'deals-schedule',
  'history':           'history',
};

const TAB_COMPONENTS: Record<Tab, React.ReactNode> = {
  'connect':            <Connect />,
  'settings':           <Settings />,
  'accounts-filter':    <AccountsFilter />,
  'accounts-fields':    <AccountsMapFields />,
  'accounts-schedule':  <AccountsSchedule />,
  'deals-filter':       <DealsFilter />,
  'deals-fields':       <DealsMapFields />,
  'deals-schedule':     <DealsSchedule />,
  'history':            <History />,
};

function HomeRedirect() {
  const { data, isLoading } = useConnections();
  if (isLoading) return null;
  const bothConnected = !!(data?.hubspot?.connected && data?.productboard?.connected);
  return <Navigate to={bothConnected ? '/accounts/schedule' : '/connect'} replace />;
}

function TabView() {
  const navigate = useNavigate();
  const params = useParams<{ '*': string }>();
  const path = (params['*'] ?? '').replace(/^\//, '').replace(/\/$/, '');
  const activeTab = PATH_TO_TAB[path] ?? null;

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
      <Route path="*" element={<TabView />} />
    </Routes>
  );
}
