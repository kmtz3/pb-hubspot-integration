import { Router } from 'express';
import { getCachedData, setCachedData } from '../lib/firestore';
import { fetchDealPipelines, fetchDealProperties, fetchProperties, getHubSpotToken } from '../sync/hubspot';
import { fetchEntityConfigurations, listTags } from '../sync/productboard';
import type { HubSpotPipeline, HubSpotProperty } from '../types/hubspot';
import type { PBField, ProductboardTag } from '../types/productboard';
import type { HubSpotFilter } from '../types/hubspot';
import type { ObjectType } from '../types/sync';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function normalizeFilters(filters: HubSpotFilter[]): HubSpotFilter[] {
  return filters.map(f => {
    if (f.operator !== 'IN' && f.operator !== 'NOT_IN') return f;
    if (f.values?.length) {
      // HubSpot rejects IN/NOT_IN filters that carry both value and values.
      // Strip the stray empty value field that the form leaves behind when
      // the user switches to a multi-select operator.
      const { value: _v, ...rest } = f;
      return rest;
    }
    if (f.value) {
      const { value, ...rest } = f;
      return { ...rest, values: value.split(',').map(v => v.trim()).filter(Boolean) };
    }
    return f;
  });
}

export const router = Router();
export const hsPropertiesRouter = Router();
export const pbFieldsRouter = Router();

// D24: `?objectType=` is optional and defaults to `companies` so existing
// clients that don't yet pass it keep working without change.
function readObjectType(raw: unknown): ObjectType {
  if (raw === 'deals' || raw === 'companies') return raw;
  return 'companies';
}

// POST /api/filters/preview[?objectType=companies|deals]
router.post('/preview', async (req, res) => {
  const objectType = readObjectType(req.query.objectType);
  if (objectType === 'deals') {
    // Deals filter preview is a count-only probe against the deals search
    // endpoint, identical in shape to the companies preview. Pipeline/stage
    // pre-filters are not applied here — this endpoint is used by the Filter
    // tab's "Preview" button which already scopes to the user's filter groups.
    const { filters } = req.body as { filters?: HubSpotFilter[] };
    if (!Array.isArray(filters)) return res.status(400).json({ error: 'filters array required' });
    try {
      const token = await getHubSpotToken();
      const resp = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filterGroups: [{ filters: normalizeFilters(filters) }], properties: ['dealname'], limit: 1 }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as { message?: string };
        return res.status(resp.status).json({ error: err.message ?? 'HubSpot search failed' });
      }
      const data = await resp.json() as { total: number };
      return res.json({ count: data.total, total: data.total });
    } catch {
      return res.status(500).json({ error: 'Filter preview failed' });
    }
  }

  const { filters } = req.body as { filters?: HubSpotFilter[] };
  if (!Array.isArray(filters)) return res.status(400).json({ error: 'filters array required' });

  try {
    const token = await getHubSpotToken();
    const payload = {
      filterGroups: [{ filters: normalizeFilters(filters) }],
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
    try {
      const bypassCache = req.query.refresh === 'true';
      if (!bypassCache) {
        const cached = await getCachedData<HubSpotProperty[]>('hs_deal_properties');
        if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
          return res.json(cached.data);
        }
      }
      const properties = await fetchDealProperties();
      res.json(properties);
      setCachedData('hs_deal_properties', properties).catch(err =>
        console.error('[hs-deal-properties] cache write failed (non-fatal):', err)
      );
    } catch (err) {
      console.error('[hs-deal-properties] fetch failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to fetch HubSpot deal properties', detail: msg });
    }
    return;
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
    // Cache write must not fail a successful response.
    setCachedData('hs_properties', properties).catch(err =>
      console.error('[hs-properties] cache write failed (non-fatal):', err)
    );
  } catch (err) {
    console.error('[hs-properties] fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch HubSpot properties' });
  }
});

// GET /api/hubspot/pipelines[?refresh=true]
// Returns the full pipeline + stage list for deals. Used by the Deals → Filter
// tab to populate the pipeline single-select and stage multi-select.
hsPropertiesRouter.get('/pipelines', async (req, res) => {
  try {
    const bypassCache = req.query.refresh === 'true';
    if (!bypassCache) {
      const cached = await getCachedData<HubSpotPipeline[]>('hs_deal_pipelines');
      if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
        return res.json(cached.data);
      }
    }
    const pipelines = await fetchDealPipelines();
    res.json(pipelines);
    setCachedData('hs_deal_pipelines', pipelines).catch(err =>
      console.error('[hs-deal-pipelines] cache write failed (non-fatal):', err)
    );
  } catch (err) {
    console.error('[hs-deal-pipelines] fetch failed:', err);
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to fetch HubSpot deal pipelines', detail: msg });
  }
});

// GET /api/productboard/tags[?refresh=true]
// Thin proxy to listTags(). Used by the Deals → MapFields save-time tag
// validation and the tag-name autocomplete picker. Cache TTL matches fields.
pbFieldsRouter.get('/tags', async (req, res) => {
  try {
    const bypassCache = req.query.refresh === 'true';
    if (!bypassCache) {
      const cached = await getCachedData<ProductboardTag[]>('pb_tags');
      if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
        return res.json(cached.data);
      }
    }
    const tags = await listTags();
    res.json(tags);
    setCachedData('pb_tags', tags).catch(err =>
      console.error('[pb-tags] cache write failed (non-fatal):', err)
    );
  } catch (err) {
    console.error('[pb-tags] fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch Productboard tags' });
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
