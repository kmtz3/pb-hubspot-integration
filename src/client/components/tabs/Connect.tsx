import { useState } from 'react';
import { CheckCircle, Unplug, RefreshCw } from 'lucide-react';
import { useConnections, useConnectHubSpot, useConnectProductboard, useDisconnect, useTestConnection } from '../../hooks/api';
import type { HubSpotScopeCheck } from '../../hooks/api';
import type { HubSpotConfig, ProductboardConfig } from '../../../types/sync';

function maskToken(token?: string): string {
  if (!token) return '';
  return '••••••••' + token.slice(-4);
}

function ConnectionCard({
  system,
  title,
  color,
  logoSrc,
  scopes,
  setupGuideUrl,
  config,
  onConnect,
  onDisconnect,
  onTestConnection,
  testState,
  testMessage,
  scopeChecks,
  isPending,
}: {
  system: 'hubspot' | 'productboard';
  title: string;
  color: string;
  logoSrc: string;
  scopes: string[];
  setupGuideUrl: string;
  config: HubSpotConfig | ProductboardConfig | undefined;
  onConnect: (token: string) => void;
  onDisconnect: () => void;
  onTestConnection: () => void;
  testState: 'idle' | 'pending' | 'ok' | 'error';
  testMessage: string;
  scopeChecks?: HubSpotScopeCheck[];
  isPending: boolean;
}) {
  const [token, setToken] = useState('');
  const connected = config?.connected ?? false;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 20, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <img src={logoSrc} width={24} height={24} alt={title} />
        <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
        {connected && <CheckCircle size={16} color="#16a34a" />}
      </div>

      {connected ? (
        <>
          <div style={{ fontFamily: 'var(--font-mono)', background: 'var(--muted)', borderRadius: 6, padding: '6px 10px', marginBottom: 12, fontSize: 13 }}>
            {maskToken(config?.tokenSecretName)}
          </div>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginBottom: 12 }}>
            <tbody>
              {'portalId' in (config ?? {}) && (() => {
                const hs = config as HubSpotConfig;
                return <>
                  {hs.hubName && (
                    <tr>
                      <td style={{ color: 'var(--muted-foreground)', paddingBottom: 4 }}>Hub</td>
                      <td style={{ fontWeight: 600 }}>{hs.hubName}</td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ color: 'var(--muted-foreground)', paddingBottom: 4 }}>Portal</td>
                    <td style={{ fontWeight: 600 }}>
                      <a href={`https://app.hubspot.com/contacts/${hs.portalId}/companies`} target="_blank" rel="noreferrer"
                         style={{ color: 'inherit', textDecoration: 'none' }}>
                        {hs.portalId} ↗
                      </a>
                    </td>
                  </tr>
                </>;
              })()}
              {'workspaceName' in (config ?? {}) && (() => {
                const pb = config as ProductboardConfig;
                const pbUrl = pb.workspaceName
                  ? `https://${pb.workspaceName}.productboard.com`
                  : 'https://productboard.com';
                return (
                  <tr>
                    <td style={{ color: 'var(--muted-foreground)', paddingBottom: 4 }}>Workspace</td>
                    <td style={{ fontWeight: 600 }}>
                      <a href={pbUrl} target="_blank" rel="noreferrer"
                         style={{ color: 'inherit', textDecoration: 'none' }}>
                        {pb.workspaceName ?? '—'} ↗
                      </a>
                    </td>
                  </tr>
                );
              })()}
              {config?.connectedAt && (
                <tr>
                  <td style={{ color: 'var(--muted-foreground)' }}>Connected</td>
                  <td>{new Date(config.connectedAt).toLocaleDateString()}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={onTestConnection}
                disabled={testState === 'pending'}
                style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', background: 'none', cursor: testState === 'pending' ? 'not-allowed' : 'pointer', fontSize: 13, opacity: testState === 'pending' ? 0.6 : 1 }}>
                {testState === 'pending' ? <RefreshCw size={13} style={{ marginRight: 4, animation: 'spin 1s linear infinite' }} /> : null}
                {testState === 'pending' ? 'Testing…' : 'Test connection'}
              </button>
              <button onClick={onDisconnect} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--destructive)' }}>
                <Unplug size={14} style={{ marginRight: 4 }} />
                Disconnect
              </button>
            </div>
            {testState === 'ok' && !scopeChecks?.length && (
              <div style={{ fontSize: 12, color: '#16a34a' }}>✓ {testMessage}</div>
            )}
            {testState === 'error' && (
              <div style={{ fontSize: 12, color: 'var(--destructive)' }}>✗ {testMessage}</div>
            )}
            {scopeChecks && scopeChecks.length > 0 && (() => {
              const missing = scopeChecks.filter(s => !s.granted);
              const allGranted = missing.length === 0;
              return (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: allGranted ? '#16a34a' : '#b45309' }}>
                    {allGranted ? '✓ All required scopes granted' : `⚠ ${missing.length} of ${scopeChecks.length} required scope${scopeChecks.length === 1 ? '' : 's'} missing`}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 16, listStyle: 'none' }}>
                    {scopeChecks.map(s => (
                      <li key={s.scope} style={{ marginBottom: 2 }}>
                        <span style={{ color: s.granted ? '#16a34a' : 'var(--destructive)' }}>
                          {s.granted ? '✓' : '✗'}
                        </span>{' '}
                        <code style={{ fontSize: 11 }}>{s.scope}</code>
                        <span style={{ color: 'var(--muted-foreground)' }}>
                          {' — '}{s.description}
                        </span>
                        {!s.granted && s.error && (
                          <div style={{ marginLeft: 14, color: 'var(--muted-foreground)', fontSize: 11 }}>
                            {s.error}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 6 }}>Required scopes:</div>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--muted-foreground)' }}>
              {scopes.map(s => <li key={s}><code>{s}</code></li>)}
            </ul>
          </div>
          <input
            type="password"
            placeholder={`Paste ${title} token`}
            value={token}
            onChange={e => setToken(e.target.value)}
            style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', fontSize: 13, marginBottom: 10, boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              disabled={!token || isPending}
              onClick={() => onConnect(token)}
              style={{ background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: !token || isPending ? 0.6 : 1 }}>
              {isPending ? 'Connecting…' : 'Connect'}
            </button>
            <a href={setupGuideUrl} target="_blank" rel="noreferrer"
               style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 12px', fontSize: 13, textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center' }}>
              Setup guide ↗
            </a>
          </div>
        </>
      )}
    </div>
  );
}

export default function Connect() {
  const { data, isLoading } = useConnections();
  const connectHS = useConnectHubSpot();
  const connectPB = useConnectProductboard();
  const disconnect = useDisconnect();
  const testConn = useTestConnection();

  const [hsTestState, setHsTestState] = useState<'idle' | 'pending' | 'ok' | 'error'>('idle');
  const [hsTestMsg, setHsTestMsg] = useState('');
  const [hsScopeChecks, setHsScopeChecks] = useState<HubSpotScopeCheck[] | undefined>(undefined);
  const [pbTestState, setPbTestState] = useState<'idle' | 'pending' | 'ok' | 'error'>('idle');
  const [pbTestMsg, setPbTestMsg] = useState('');

  // Surface scope health from the most recent successful HS connect mutation
  // so the user sees scope status immediately after connecting, not just on
  // the explicit "Test connection" run.
  const connectScopeChecks = (connectHS.data as { scopes?: HubSpotScopeCheck[] } | undefined)?.scopes;
  const hsScopes = hsScopeChecks ?? connectScopeChecks;

  function handleTest(system: 'hubspot' | 'productboard') {
    const setState = system === 'hubspot' ? setHsTestState : setPbTestState;
    const setMsg = system === 'hubspot' ? setHsTestMsg : setPbTestMsg;
    if (system === 'hubspot') setHsScopeChecks(undefined);
    setState('pending');
    testConn.mutate(system, {
      onSuccess: (data) => {
        setState('ok');
        setMsg('Connection is healthy');
        if (system === 'hubspot' && data.scopes) setHsScopeChecks(data.scopes);
      },
      onError: (err) => { setState('error'); setMsg(err instanceof Error ? err.message : 'Test failed'); },
    });
  }

  if (isLoading) return <div style={{ padding: 32, color: 'var(--muted-foreground)' }}>Loading…</div>;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Connect</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 14, marginTop: 4 }}>
          Connect your HubSpot and Productboard accounts to start syncing companies.
        </p>
      </div>

      {(connectHS.error || connectPB.error) && (
        <div style={{ background: 'var(--destructive-accent)', border: '1px solid var(--destructive)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
          {(connectHS.error as Error)?.message ?? (connectPB.error as Error)?.message}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        <ConnectionCard
          system="hubspot"
          title="HubSpot"
          color="#ff7a59"
          logoSrc="/logos/hubspot-icon.svg"
          scopes={['crm.objects.companies.read', 'crm.schemas.companies.read', 'crm.objects.owners.read']}
          setupGuideUrl="https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys"
          config={data?.hubspot}
          onConnect={token => connectHS.mutate(token)}
          onDisconnect={() => disconnect.mutate('hubspot')}
          onTestConnection={() => handleTest('hubspot')}
          testState={hsTestState}
          testMessage={hsTestMsg}
          scopeChecks={hsScopes}
          isPending={connectHS.isPending}
        />
        <ConnectionCard
          system="productboard"
          title="Productboard"
          color="#6366f1"
          logoSrc="/logos/pb-icon.svg"
          scopes={['Company read/write (v2 API)']}
          setupGuideUrl="https://developer.productboard.com/#section/Authentication"
          config={data?.productboard}
          onConnect={token => connectPB.mutate(token)}
          onDisconnect={() => disconnect.mutate('productboard')}
          onTestConnection={() => handleTest('productboard')}
          testState={pbTestState}
          testMessage={pbTestMsg}
          isPending={connectPB.isPending}
        />
      </div>

      {/* Deployment card */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Deployment</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          {[
            { label: 'GCP Project', value: import.meta.env.VITE_GCP_PROJECT_ID ?? '—' },
            { label: 'Service', value: 'Cloud Run' },
            { label: 'Storage', value: 'Firestore' },
            { label: 'Access', value: 'Cloud Run IAM' },
          ].map(item => (
            <div key={item.label}>
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
