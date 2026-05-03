import type { HubSpotDeal, HubSpotFilter } from '../types/hubspot';
import type { CreateNotePayload, ProductboardTagRef } from '../types/productboard';
import type { BodyMapping, TagMapping, TagRule } from '../types/sync';
import { sanitizeDescription } from './sanitize';

// Phase 4 — deal note builder. Pure functions: take an HS deal + the deals
// mapping config, return the PB note payload plus the list of tag names that
// must be pre-flighted through `ensureTagsExist` before the write lands.
//
// The engine pre-flights tags exactly once per run (D2 + tag-handling
// contract): collect every name from staticTags + rule output + tagMappings
// across every deal, dedup, then call `ensureTagsExist` ONCE. PB's tag-value
// provisioning POST is currently broken (HTTP 500 — see
// feedback_pb_tag_provisioning_unavailable.md), so unknown names are dropped
// from the note write rather than failing it. `tagsToProvision` is therefore
// the *requested* set; the engine intersects it with what `ensureTagsExist`
// returns and increments `stats.tagsDropped` for the difference.

// ── HTML escape ────────────────────────────────────────────────────────────
//
// `buildContentHtml` interpolates raw HS values into HTML. Plain-text fields
// (style='metadata' or non-rich-text longform values) need entity-escaping so
// an HS field that happens to contain `<` doesn't break the surrounding
// markup. Rich-text body sections still flow through `sanitizeDescription`
// from `sanitize.ts` (the same allowlist PB's web app uses) so that path
// retains formatting without trusting raw HS HTML.
function escapeHtml(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Operator semantics ─────────────────────────────────────────────────────
//
// Mirrors `src/client/constants/operators.ts` — the rule UI (Phase 5) picks
// from the same operator set, so the rule evaluator here covers every case
// that picker can produce. Comparisons are string-first (HS deal properties
// arrive as strings), with numeric coercion for the LT/LTE/GT/GTE/BETWEEN
// branches when both sides parse cleanly.
//
// A property that is missing or empty is treated as "not set":
//   - HAS_PROPERTY    → false
//   - NOT_HAS_PROPERTY → true
//   - every other operator → false (rule does not match)

type RuleOperator = HubSpotFilter['operator'];

function getProp(deal: HubSpotDeal, name: string): string | null {
  const v = deal.properties[name];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function tryNumber(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function evaluateOperator(
  raw: string | null,
  op: RuleOperator,
  value: string | undefined,
  values: string[] | undefined,
): boolean {
  // Presence operators handle null up-front; every other operator returns
  // false on a missing value (the rule simply doesn't match).
  if (op === 'HAS_PROPERTY')     return raw !== null;
  if (op === 'NOT_HAS_PROPERTY') return raw === null;
  if (raw === null) return false;

  const lhs = raw;
  const rhs = value ?? '';

  switch (op) {
    case 'EQ':                  return lhs === rhs;
    case 'NEQ':                 return lhs !== rhs;
    case 'CONTAINS_TOKEN':      return lhs.toLowerCase().includes(rhs.toLowerCase());
    case 'NOT_CONTAINS_TOKEN':  return !lhs.toLowerCase().includes(rhs.toLowerCase());
    case 'IN':                  return Array.isArray(values) && values.includes(lhs);
    case 'NOT_IN':              return !Array.isArray(values) || !values.includes(lhs);
    case 'LT':
    case 'LTE':
    case 'GT':
    case 'GTE': {
      const a = tryNumber(lhs);
      const b = tryNumber(rhs);
      if (a === null || b === null) return false;
      if (op === 'LT')  return a <  b;
      if (op === 'LTE') return a <= b;
      if (op === 'GT')  return a >  b;
      return a >= b;
    }
    case 'BETWEEN': {
      // Two-arg numeric range. `values` carries [low, high]; some callers may
      // still pass `value`/`highValue` via TagRule shape, so accept either.
      const a = tryNumber(lhs);
      const lo = tryNumber(values?.[0] ?? value ?? null);
      const hi = tryNumber(values?.[1] ?? null);
      if (a === null || lo === null || hi === null) return false;
      return a >= lo && a <= hi;
    }
    default:
      return false;
  }
}

// Apply each rule's operator to the named field; return tag names whose
// conditions match. Rules are independent — a deal can pick up multiple tags
// from rules that all evaluate true on different fields.
export function evaluateRules(deal: HubSpotDeal, rules: TagRule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (!rule.tagName || !rule.field) continue;
    const raw = getProp(deal, rule.field);
    if (evaluateOperator(raw, rule.operator, rule.value, rule.values)) {
      out.push(rule.tagName);
    }
  }
  return out;
}

// ── Tag mappings ───────────────────────────────────────────────────────────
//
// `TagMapping` rows take a single HS field and lift each non-empty value into
// a tag, optionally prefixed. Field shapes the engine sees:
//   - boolean ("true" / "false") → tag name = the field name (or its prefix)
//     when the value is "true"; nothing when "false"
//   - single enum / string       → one tag (with optional prefix)
//   - multi-checkbox (semicolon-delimited) → one tag per token
// Any prefix is concatenated verbatim — the user controls the separator
// (e.g. `prefix: 'stage:'` produces `stage:closedwon`).

function tagsFromMapping(deal: HubSpotDeal, mapping: TagMapping): string[] {
  if (!mapping.enabled) return [];
  const raw = getProp(deal, mapping.hsField);
  if (raw === null) return [];
  const prefix = mapping.prefix ?? '';

  // HS booleans arrive as the literal strings "true" / "false".
  if (raw === 'true')  return [`${prefix}${mapping.hsField}`];
  if (raw === 'false') return [];

  // HS multi-checkbox values are semicolon-delimited internal strings.
  if (raw.includes(';')) {
    return raw
      .split(';')
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => `${prefix}${t}`);
  }

  return [`${prefix}${raw}`];
}

// ── Body mappings ──────────────────────────────────────────────────────────
//
// `style='metadata'`  → <p><strong>{label}:</strong> {value}</p>
// `style='longform'`  → <h2>{label}</h2><div>{sanitized value}</div>
//
// Mappings render in `order`-ascending order (stable sort within the same
// order value to preserve the user's row order from the UI). Disabled rows
// drop out. A missing/empty value drops the row entirely so the body doesn't
// carry "Owner: " with nothing after it.

export function buildContentHtml(deal: HubSpotDeal, mappings: BodyMapping[]): string {
  const ordered = [...mappings].sort((a, b) => a.order - b.order);
  const parts: string[] = [];

  for (const m of ordered) {
    if (!m.enabled) continue;
    const raw = getProp(deal, m.hsField);
    if (raw === null) continue;

    const label = m.label ?? m.hsField;

    if (m.style === 'metadata') {
      parts.push(`<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(raw)}</p>`);
    } else {
      // Longform: pass the value through the same sanitizer the companies
      // sync uses for rich-text fields. `sanitizeDescription` returns null on
      // empty input so we guard against it producing a hollow section.
      const sanitized = sanitizeDescription(raw);
      if (!sanitized) continue;
      parts.push(`<h2>${escapeHtml(label)}</h2><div>${sanitized}</div>`);
    }
  }

  return parts.join('');
}

// ── Payload builder ────────────────────────────────────────────────────────
//
// Returns the create-note payload plus the list of tag names that need to be
// resolved through `ensureTagsExist`. Callers should never POST the payload
// without first replacing the requested tag names with the pre-flighted
// `ProductboardTagRef[]` (PB rejects unknown tags with `selectOption.notFound`
// — live-tested 2026-05-03).
//
// The note's title (`fields.name`) defaults to `dealname`, falling back to
// `Deal <hs-id>` when the HS record has no dealname set, so PB's UI never
// renders an "(unnamed)" note.

export interface BuildDealNotePayloadArgs {
  deal: HubSpotDeal;
  companyPbUuid: string;
  /** null = single-mode note (one per deal); HS company id = multi-mode note
   *  (one per associated company). Used purely as a marker — the recordId
   *  itself is computed by the engine. */
  companyKey: string | null;
  recordId: string;
  /** Public HS app URL stored on the note's metadata.source.url so users can
   *  jump from PB to HubSpot. The engine builds it once per deal from the
   *  portal id + deal id. */
  sourceUrl: string;
  tagMappings: TagMapping[];
  bodyMappings: BodyMapping[];
  rules: TagRule[];
  staticTags: string[];
  /** Resolved owner email from the HS owner directory, gated on PB workspace
   *  membership (D12). Pass null to skip the owner field entirely — the
   *  engine tracks `stats.ownerSkipped` separately. */
  ownerEmail: string | null;
}

export interface DealNotePayloadResult {
  payload: CreateNotePayload;
  /** Tag names this deal wants on the note. The engine pre-flights every
   *  unique name across the run through `ensureTagsExist` and replaces
   *  unknown names with a dropped-tag warning before the write. */
  tagsToProvision: string[];
}

function dedupAndSort(names: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const n of names) {
    const trimmed = n.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function buildDealNotePayload(args: BuildDealNotePayloadArgs): DealNotePayloadResult {
  const {
    deal,
    companyPbUuid,
    recordId,
    sourceUrl,
    tagMappings,
    bodyMappings,
    rules,
    staticTags,
    ownerEmail,
  } = args;

  const requestedTags = dedupAndSort([
    ...staticTags,
    ...evaluateRules(deal, rules),
    ...tagMappings.flatMap(m => tagsFromMapping(deal, m)),
  ]);

  const tagsRefs: ProductboardTagRef[] = requestedTags.map(name => ({ name }));

  const dealname = getProp(deal, 'dealname');
  const name = dealname ?? `Deal ${deal.id}`;

  const content = buildContentHtml(deal, bodyMappings);

  const payload: CreateNotePayload = {
    data: {
      type: 'textNote',
      fields: {
        name,
        ...(content ? { content } : {}),
        ...(tagsRefs.length > 0 ? { tags: tagsRefs } : {}),
        ...(ownerEmail ? { owner: { email: ownerEmail } } : {}),
      },
      metadata: {
        source: {
          system: 'hubspot',
          recordId,
          url: sourceUrl,
        },
      },
      relationships: [
        { type: 'customer', target: { id: companyPbUuid, type: 'company' } },
      ],
    },
  };

  return { payload, tagsToProvision: requestedTags };
}
