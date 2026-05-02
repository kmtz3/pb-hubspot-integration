import { Router } from 'express';
import { getCachedData, setCachedData } from '../lib/firestore';
import { fetchProperties, getHubSpotToken } from '../sync/hubspot';
import { fetchEntityConfigurations } from '../sync/productboard';
import type { HubSpotProperty } from '../types/hubspot';
import type { PBField } from '../types/productboard';
import type { HubSpotFilter } from '../types/hubspot';
import type { ObjectType } from '../types/sync';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export const router = Router();
export const hsPropertiesRouter = Router();
export const pbFieldsRouter = Router();

// D24: `?objectType=` is optional and defaults to `companies` so existing
// clients that don't yet pass it keep working without change. Phase 2 wires
// the deals branch in `properties` and `preview`.
function readObjectType(raw: unknown): ObjectType {
  if (raw === 'deals' || raw === 'companies') return raw;
  return 'companies';
}

// POST /api/filters/preview[?objectType=companies|deals]
router.post('/preview', async (req, res) => {
  const objectType = readObjectType(req.query.objectType);
  if (objectType === 'deals') {
    return res.status(501).json({ error: 'deals filter preview lands in Phase 2' });
  }

  const { filters } = req.body as { filters?: HubSpotFilter[] };
  if (!Array.isArray(filters)) return res.status(400).json({ error: 'filters array required' });

  try {
    const token = await getHubSpotToken();
    const payload = {
      filterGroups: [{ filters }],
      properties: ['name'],
      limit: 1,
    };

    const resp = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { message?: string };
      return res.status(resp.status).json({ error: err.message ?? 'HubSpot search failed' });
    }

    const data = await resp.json() as { total: number; results: unknown[] };
    res.json({ count: data.total, total: data.total });
  } catch (err) {
    res.status(500).json({ error: 'Filter preview failed' });
  }
});

// GET /api/hubspot/properties[?refresh=true&objectType=companies|deals]
hsPropertiesRouter.get('/properties', async (req, res) => {
  const objectType = readObjectType(req.query.objectType);
  if (objectType === 'deals') {
    return res.status(501).json({ error: 'deals properties endpoint lands in Phase 2' });
  }

  try {
    const bypassCache = req.query.refresh === 'true';
    if (!bypassCache) {
      const cached = await getCachedData<HubSpotProperty[]>('hs_properties');
      if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
        return res.json(cached.data);
      }
    }
    const properties = await fetchProperties();
    res.json(properties);
    // See note on /fields — cache write must not fail a successful response.
    setCachedData('hs_properties', properties).catch(err =>
      console.error('[hs-properties] cache write failed (non-fatal):', err)
    );
  } catch (err) {
    console.error('[hs-properties] fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch HubSpot properties' });
  }
});

// GET /api/productboard/fields[?refresh=true]
// Cache key bumped to pb_fields_v3 after the response shape changed from
// PBEntityConfiguration[] (raw, fields-as-Record) to PBField[] (flat).
pbFieldsRouter.get('/fields', async (req, res) => {
  try {
    const bypassCache = req.query.refresh === 'true';
    if (!bypassCache) {
      const cached = await getCachedData<PBField[]>('pb_fields_v3');
      if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
        return res.json(cached.data);
      }
    }
    const fields = await fetchEntityConfigurations();
    res.json(fields);
    // Cache write is a side effect — fire-and-forget so a Firestore rejection
    // (e.g. undefined values, transient connection issue) can't fail a request
    // that already has the data the client needs.
    setCachedData('pb_fields_v3', fields).catch(err =>
      console.error('[pb-fields] cache write failed (non-fatal):', err)
    );
  } catch (err) {
    console.error('[pb-fields] fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch Productboard fields' });
  }
});
