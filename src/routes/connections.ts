import { Router } from 'express';
import { getHubSpotConfig, saveHubSpotConfig, clearHubSpotConfig, getPBConfig, savePBConfig, clearPBConfig } from '../lib/firestore';
import { getSecret } from '../lib/secrets';
import { getAccountInfo, checkScopes } from '../sync/hubspot';
import { testConnection } from '../sync/productboard';
import type { HubSpotConfig, ProductboardConfig } from '../types/sync';

export const router = Router();

// Strip the raw token from any config before sending it to the browser.
// Replaces tokenSecretName with a short masked preview for UI display.
function sanitize<T extends HubSpotConfig | ProductboardConfig>(config: T): Omit<T, 'tokenSecretName'> & { tokenMasked?: string } {
  const { tokenSecretName, ...rest } = config;
  const tokenMasked = tokenSecretName ? '••••••••' + tokenSecretName.slice(-4) : undefined;
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

    // Store the token as the secret name in both dev and prod.
    // In prod this will be replaced with a Secret Manager resource name;
    // in dev getSecret falls back to treating it as the literal value.
    const tokenSecretName = token;

    const config: HubSpotConfig = {
      connected: true,
      portalId,
      hubName,
      connectedAt: new Date().toISOString(),
      tokenSecretName,
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
    const { workspaceName } = await testConnection(token);

    const tokenSecretName = token;
    const config: ProductboardConfig = {
      connected: true,
      workspaceName,
      connectedAt: new Date().toISOString(),
      tokenSecretName,
    };
    await savePBConfig(config);
    res.json(sanitize(config));
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
      const { workspaceName } = await testConnection(token);
      return res.json({ ok: true, workspaceName });
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
