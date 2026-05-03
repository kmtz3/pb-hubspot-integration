import { Router } from 'express';
import { getHubSpotConfig, saveHubSpotConfig, clearHubSpotConfig, getPBConfig, savePBConfig, clearPBConfig } from '../lib/firestore';
import { getSecret, writeSecret } from '../lib/secrets';
import { getAccountInfo, checkScopes } from '../sync/hubspot';
import { testConnection, checkScopes as checkPBScopes } from '../sync/productboard';
import type { HubSpotConfig, ProductboardConfig } from '../types/sync';

export const router = Router();

// Strip server-only token fields before sending the config to the browser.
// Builds `tokenMasked` from `tokenLast4` (the last 4 chars of the raw token,
// captured at save time) — never from `tokenSecretName`, whose tail is the
// Secret Manager resource path (e.g. ".../versions/4") and tells the UI nothing
// useful about the actual token. Configs saved before tokenLast4 was tracked
// fall back to dots-only until the next reconnect.
function sanitize<T extends HubSpotConfig | ProductboardConfig>(
  config: T,
): Omit<T, 'tokenSecretName' | 'tokenLast4'> & { tokenMasked?: string } {
  const { tokenSecretName, tokenLast4, ...rest } = config;
  const tokenMasked = tokenSecretName
    ? '••••••••' + (tokenLast4 ?? '')
    : undefined;
  return { ...rest, tokenMasked };
}

router.get('/', async (_req, res) => {
  try {
    const [hubspot, productboard] = await Promise.all([getHubSpotConfig(), getPBConfig()]);
    res.json({ hubspot: sanitize(hubspot), productboard: sanitize(productboard) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load connection status' });
  }
});

router.post('/hubspot', async (req, res) => {
  const { token } = req.body as { token?: string };
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const [{ portalId, hubName }, scopes] = await Promise.all([
      getAccountInfo(token),
      checkScopes(token),
    ]);

    // In production: write the token to Secret Manager and store the version
    // resource name (projects/…/secrets/hubspot-token/versions/N) in Firestore.
    // In dev: writeSecret returns the literal token, matching the pre-existing
    // local-development flow that getSecret already supports.
    const tokenSecretName = await writeSecret('hubspot-token', token);

    const config: HubSpotConfig = {
      connected: true,
      portalId,
      hubName,
      connectedAt: new Date().toISOString(),
      tokenSecretName,
      tokenLast4: token.slice(-4),
    };
    await saveHubSpotConfig(config);
    res.json({ ...sanitize(config), scopes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: `HubSpot connection failed: ${msg}` });
  }
});

router.post('/productboard', async (req, res) => {
  const { token } = req.body as { token?: string };
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const [{ workspaceName }, scopes] = await Promise.all([
      testConnection(token),
      checkPBScopes(token),
    ]);

    const tokenSecretName = await writeSecret('productboard-token', token);
    const config: ProductboardConfig = {
      connected: true,
      workspaceName,
      connectedAt: new Date().toISOString(),
      tokenSecretName,
      tokenLast4: token.slice(-4),
    };
    await savePBConfig(config);
    res.json({ ...sanitize(config), scopes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: `Productboard connection failed: ${msg}` });
  }
});

router.get('/:system/test', async (req, res) => {
  const { system } = req.params;
  try {
    if (system === 'hubspot') {
      const config = await getHubSpotConfig();
      if (!config.connected || !config.tokenSecretName) {
        return res.status(400).json({ error: 'HubSpot is not connected' });
      }
      const token = await getSecret(config.tokenSecretName);
      const [{ portalId }, scopes] = await Promise.all([
        getAccountInfo(token),
        checkScopes(token),
      ]);
      return res.json({ ok: true, portalId, scopes });
    } else if (system === 'productboard') {
      const config = await getPBConfig();
      if (!config.connected || !config.tokenSecretName) {
        return res.status(400).json({ error: 'Productboard is not connected' });
      }
      const token = await getSecret(config.tokenSecretName);
      const [{ workspaceName }, scopes] = await Promise.all([
        testConnection(token),
        checkPBScopes(token),
      ]);
      return res.json({ ok: true, workspaceName, scopes });
    } else {
      return res.status(400).json({ error: 'unknown system' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

router.delete('/:system', async (req, res) => {
  const { system } = req.params;
  try {
    if (system === 'hubspot') {
      await clearHubSpotConfig();
    } else if (system === 'productboard') {
      await clearPBConfig();
    } else {
      return res.status(400).json({ error: 'unknown system' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});
