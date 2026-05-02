import type { HubSpotCompany } from '../types/hubspot';
import type { SyncConfig } from '../types/sync';
import type { PBEntity } from '../types/productboard';

// PB's v2 search endpoint (`POST /v2/entities/search`) does not yet honor
// `filter.metadata.source.recordId` — the docs flag the metadata filter as
// "not yet active" and the live API silently returns the unfiltered company
// list (verified May 2026). Until PB ships it, dedup walks every company once
// at sync start (see `listCompanies` in `productboard.ts`) and builds the
// lookup maps below client-side.
//
// TODO(pb): swap `byRecordId` for a per-record search call once the metadata
// filter activates — that avoids the full-walk cost on workspaces with many
// thousands of companies.
//
// `filter.fields.domain` IS supported but only via `{contains: …}` (substring,
// no exact-match operator), so the domain fallback is also resolved
// client-side here for an exact, lower-cased compare.

export interface CompanyMaps {
  byRecordId: Map<string, string>;
  byDomain: Map<string, string>;
}

function normalizeDomain(d: unknown): string | null {
  if (d === null || d === undefined) return null;
  const t = String(d).trim().toLowerCase();
  return t || null;
}

export function buildCompanyMaps(companies: PBEntity[]): CompanyMaps {
  const byRecordId = new Map<string, string>();
  const byDomain = new Map<string, string>();
  for (const c of companies) {
    if (c.type !== 'company') continue;
    const src = c.metadata?.source;
    if (src?.system === 'hubspot' && src.recordId) {
      byRecordId.set(src.recordId, c.id);
    }
    const domain = normalizeDomain(c.fields?.domain);
    // First-write wins so the dedup result is stable across runs even when
    // the workspace has multiple companies sharing a domain.
    if (domain && !byDomain.has(domain)) byDomain.set(domain, c.id);
  }
  return { byRecordId, byDomain };
}

export function findExistingEntity(
  hsCompany: HubSpotCompany,
  config: Pick<SyncConfig, 'domainFallbackEnabled'>,
  maps: CompanyMaps
): { pbId: string; resolvedViaFallback: boolean } | null {
  const primary = maps.byRecordId.get(hsCompany.id);
  if (primary) return { pbId: primary, resolvedViaFallback: false };

  if (!config.domainFallbackEnabled) return null;
  const domain = normalizeDomain(hsCompany.properties.domain);
  if (!domain) return null;

  const fallback = maps.byDomain.get(domain);
  if (fallback) return { pbId: fallback, resolvedViaFallback: true };

  return null;
}
