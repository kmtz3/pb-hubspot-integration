import type { HubSpotCompany } from '../types/hubspot';
import type { SyncConfig } from '../types/sync';
import type { PBEntity, ProductboardNote } from '../types/productboard';

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

export function findExistingCompany(
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

// ── Deal-note dedup (Phase 1 stubs; full implementation in Phase 4) ──────────
//
// recordId format (live-tested 2026-05-02):
//   single mode:  `deal-<dealId>`
//   multi mode:   `deal-<dealId>::company-<companyId>`
// `::` roundtrips verbatim through PB POST/GET and the metadata filter.
//
// `buildDealNoteMaps` walks every hubspot-source note once (paginated via
// `listHubspotDealNotes` in productboard.ts, Phase 3) and builds a nested
// dealId → (companyKey | null) → note map. `findExistingDealNote` is the
// per-deal lookup the engine calls per row.

export type DealNoteIndex = Map<string, Map<string | null, ProductboardNote>>;

// Parses a `deal-…::company-…` (or single-mode `deal-…`) recordId into a
// `(dealId, companyKey)` pair. Returns null when the input doesn't carry the
// `deal-` prefix on its first segment — those records are emitted by other
// hubspot-source flows (e.g. the legacy companies enrichment notes) and are
// not part of the deal-note index.
export function parseDealRecordId(recordId: string): { dealId: string; companyKey: string | null } | null {
  if (!recordId) return null;
  const [dealPart, companyPart] = recordId.split('::');
  if (!dealPart.startsWith('deal-')) return null;
  const dealId = dealPart.slice('deal-'.length);
  if (!dealId) return null;
  if (companyPart === undefined) {
    return { dealId, companyKey: null };
  }
  if (!companyPart.startsWith('company-')) return null;
  const companyKey = companyPart.slice('company-'.length);
  if (!companyKey) return null;
  return { dealId, companyKey };
}

// Walk every hubspot-source note once and project to a nested map:
//   outer key = HS deal id
//   inner key = HS company id (multi-mode) or null (single-mode)
// Notes whose recordId doesn't match the deal-note format are silently
// skipped — `listHubspotDealNotes` returns the union of every system=hubspot
// note, not just deal notes. Archived notes are also skipped so the heal pass
// (which archives placeholder-bound notes) doesn't trip the dedup match on
// the same run — the main flow then recreates them under the resolved
// company.
export function buildDealNoteMaps(notes: ProductboardNote[]): DealNoteIndex {
  const index: DealNoteIndex = new Map();
  for (const note of notes) {
    if (note.fields?.archived) continue;
    const recordId = note.metadata?.source?.recordId;
    if (!recordId) continue;
    const parsed = parseDealRecordId(recordId);
    if (!parsed) continue;
    let inner = index.get(parsed.dealId);
    if (!inner) {
      inner = new Map();
      index.set(parsed.dealId, inner);
    }
    // First-write wins so the dedup result is stable across runs even when
    // (defensively) PB returns more than one note for the same recordId.
    if (!inner.has(parsed.companyKey)) inner.set(parsed.companyKey, note);
  }
  return index;
}

export function findExistingDealNote(
  dealId: string,
  companyKey: string | null,
  index: DealNoteIndex
): ProductboardNote | undefined {
  return index.get(dealId)?.get(companyKey);
}
