import type { HubSpotCompany } from '../types/hubspot';
import type { PBFieldConstraints, PBFieldType, PBFieldValue, JSONSchema } from '../types/productboard';
import type { FieldMapping } from '../types/sync';
import { sanitizeDescription } from './sanitize';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// PB date fields require strict `YYYY-MM-DD`. HubSpot returns either that for
// `date` properties, an ISO timestamp like `2024-03-15T00:00:00Z` for
// `datetime`, or occasionally a numeric ms-epoch. Mirrors PBToolkit's
// _normalizeDate, with UTC getters so an HS midnight-UTC value doesn't shift
// across the date line in negative timezones.
function normalizeDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (ISO_DATE_RE.test(s)) return s;
  // ISO datetime — keep the date prefix verbatim, no TZ math.
  const tIdx = s.indexOf('T');
  if (tIdx === 10 && ISO_DATE_RE.test(s.slice(0, 10))) return s.slice(0, 10);
  // Numeric ms-epoch (or any string Date can parse) — format in UTC.
  const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// PB v2 represents rich-text fields as `type: 'string'` plus either
// `format: 'richtext'` or a `contentMediaType` (HTML). Matches the heuristic
// used by PBToolkit's normalizeSchema.
function isRichTextSchema(schema: JSONSchema): boolean {
  if (schema.type !== 'string') return false;
  if (schema.format === 'richtext' || schema.format === 'rich-text') return true;
  if ('contentMediaType' in schema) return true;
  return false;
}

// Member-field detector: PB models user-pickers as `object` with a required
// `email` property (singular) or `array` items of the same shape (multi).
// Distinguishing from regular dropdowns matters because writes need an email
// resolved to a user UUID, which our HS sync can't produce.
function isMemberObject(schema: JSONSchema | undefined): boolean {
  if (!schema || schema.type !== 'object') return false;
  const props = (schema as any).properties as Record<string, unknown> | undefined;
  return !!props && 'email' in props;
}

export function schemaToToken(schema: JSONSchema): PBFieldType | null {
  if (schema.type === 'array') {
    return isMemberObject((schema as any).items) ? 'multimember' : 'multiselect';
  }
  if (schema.type === 'object') return isMemberObject(schema) ? 'member' : 'select';
  if (schema.type === 'string' && schema.format === 'date') return 'date';
  if (isRichTextSchema(schema)) return 'richtext';
  if (schema.type === 'string') return 'text';
  if (schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  return null;
}

// Captures `email@host.tld` out of plain emails AND `Name <email@host.tld>`
// patterns; mirrors the EMAIL_RE used in PBToolkit's fieldBuilder.
const EMAIL_RE = /([\w.+-]+@[\w-]+\.[\w.-]+)/i;

export interface CoerceContext {
  /** Lowercased emails of valid PB workspace members. When provided, member
   *  writes are validated against this set; unknown emails are skipped. */
  memberEmails?: Set<string>;
  /** HS owner.id → email lookup, from /crm/v3/owners. Used to resolve
   *  HS fields like `hubspot_owner_id` / `hs_all_owner_ids` (which store
   *  HubSpot owner ids) into email strings before coercion. */
  ownerIdToEmail?: Map<string, string>;
  /** HS owner.userId → email lookup. Used for `hs_user_ids_of_all_owners`
   *  and similar fields that hold HubSpot user ids (distinct from owner ids). */
  userIdToEmail?: Map<string, string>;
  /** PB fields that reject null/blank values. These cannot be cleared through
   *  the API, so empty HubSpot values must be omitted from the payload. */
  nonClearableFieldIds?: Set<string>;
  /** PB per-field constraints used to format/guard values before writes. */
  fieldConstraintsById?: Map<string, PBFieldConstraints>;
  /** HS property options lookup: property name → (internal value → display label).
   *  Built from /crm/v3/properties/company at sync startup. Used to translate
   *  enumeration values (e.g. "academic_programs") to display labels ("Academic Programs")
   *  before writing to PB select / multiselect fields. */
  hsPropertyOptions?: Map<string, Map<string, string>>;
  /** Invoked once per `member` / `multimember` value that gets dropped because
   *  the resolved email isn't in `memberEmails`. The engine wires this to
   *  `stats.ownerSkipped` so SyncRun reflects the truth instead of silently
   *  losing owners (D20). Optional — call sites without stats can omit. */
  onMemberSkipped?: () => void;
}

// HS property-name heuristic — distinguishes owner-id sources (`hubspot_owner_id`,
// `hs_all_owner_ids`) from user-id sources (`hs_user_ids_of_all_owners`,
// custom `*_user_ids`). The two are different identifier spaces in HubSpot,
// so they need different lookup maps.
export type OwnerIdKind = 'owner' | 'user' | null;
export function detectOwnerIdField(hsName: string | undefined): OwnerIdKind {
  if (!hsName) return null;
  const n = hsName.toLowerCase();
  if (/user_ids?_of_/.test(n) || /(^|_)user_ids?$/.test(n)) return 'user';
  if (n === 'hubspot_owner_id' || n === 'hs_all_owner_ids' || /(^|_)owner_ids?$/.test(n)) return 'owner';
  return null;
}

// Replace each id token in `raw` with the matching email. Splits on commas,
// semicolons, and arrays. Returns a comma-separated email string, or null
// if no ids resolved (so coerceFieldValue treats it as empty).
export function resolveOwnerIdsToEmails(
  raw: unknown,
  kind: NonNullable<OwnerIdKind>,
  ctx: CoerceContext | undefined
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const map = kind === 'user' ? ctx?.userIdToEmail : ctx?.ownerIdToEmail;
  if (!map || map.size === 0) {
    console.warn(`resolveOwnerIdsToEmails: no ${kind}-id → email map available; skipping ${kind}-id source`);
    return null;
  }
  const tokens = Array.isArray(raw)
    ? raw.map(String)
    : String(raw).split(/[,;]/);
  const emails: string[] = [];
  for (const t of tokens) {
    const id = t.trim();
    if (!id) continue;
    const email = map.get(id);
    if (email) emails.push(email);
    else console.warn(`resolveOwnerIdsToEmails: HS ${kind} id "${id}" has no resolved email; skipping`);
  }
  return emails.length > 0 ? emails.join(', ') : null;
}

function extractEmail(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).match(EMAIL_RE);
  return m ? m[1]!.toLowerCase() : null;
}

export function coerceFieldValue(
  value: unknown,
  destType: PBFieldType,
  ctx?: CoerceContext
): PBFieldValue {
  if (value === null || value === undefined) return null;

  if (destType === 'member') {
    const email = extractEmail(value);
    if (!email) return null;
    if (ctx?.memberEmails && !ctx.memberEmails.has(email)) {
      console.warn(`coerceFieldValue: PB member "${email}" is not a workspace member; skipping`);
      ctx.onMemberSkipped?.();
      return null;
    }
    return { email };
  }

  if (destType === 'multimember') {
    // Accept arrays directly, otherwise split a delimited string on `,` or `;`.
    const items = Array.isArray(value) ? value.map(String) : String(value).split(/[,;]/);
    const out: { email: string }[] = [];
    for (const item of items) {
      const email = extractEmail(item);
      if (!email) continue;
      if (ctx?.memberEmails && !ctx.memberEmails.has(email)) {
        console.warn(`coerceFieldValue: PB member "${email}" is not a workspace member; skipping`);
        ctx.onMemberSkipped?.();
        continue;
      }
      out.push({ email });
    }
    return out.length > 0 ? out : null;
  }

  if (destType === 'select') {
    return { name: String(value) };
  }
  if (destType === 'multiselect') {
    // HubSpot returns multiselect (fieldType=checkbox) values as a semicolon-
    // delimited string of internal values. buildCompanyFieldsPayload pre-translates
    // these to display labels and converts to an array before coercion, but we also
    // split inline here as a fallback for any caller that passes the raw string.
    const items = Array.isArray(value) ? value.map(String) : String(value).split(';');
    const names = items.map(s => s.trim()).filter(Boolean);
    return names.length > 0 ? names.map(name => ({ name })) : null;
  }
  if (destType === 'number') {
    const n = parseFloat(String(value));
    if (isNaN(n)) {
      console.warn(`coerceFieldValue: cannot coerce "${value}" to number — mapping skipped`);
      return null;
    }
    return n;
  }
  if (destType === 'boolean') {
    return value as boolean;
  }
  if (destType === 'richtext') {
    return sanitizeDescription(value);
  }
  if (destType === 'date') {
    const normalized = normalizeDate(value);
    if (normalized === null) {
      console.warn(`coerceFieldValue: cannot coerce "${value}" to YYYY-MM-DD — mapping skipped`);
      return null;
    }
    return normalized;
  }
  // text — coerce to string; arrays (from pre-translated multiselect) join with ", "
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

function applyNumberConstraints(
  value: number,
  fieldId: string,
  constraints: PBFieldConstraints | undefined
): number | null {
  const scale = constraints?.maxScale ?? 2;
  const factor = Math.pow(10, scale);
  const rounded = Math.round(value * factor) / factor;

  if (constraints?.minimum !== undefined && rounded < constraints.minimum) {
    console.warn(`applyNumberConstraints: ${fieldId} value ${rounded} is below PB minimum ${constraints.minimum}; mapping skipped`);
    return null;
  }
  if (constraints?.maximum !== undefined && rounded > constraints.maximum) {
    console.warn(`applyNumberConstraints: ${fieldId} value ${rounded} exceeds PB maximum ${constraints.maximum}; mapping skipped`);
    return null;
  }

  return rounded;
}

export function buildCompanyFieldsPayload(
  hsCompany: HubSpotCompany,
  mappings: FieldMapping[],
  ctx?: CoerceContext
): Record<string, PBFieldValue> {
  const result: Record<string, PBFieldValue> = {};

  const setValue = (fieldId: string, value: PBFieldValue): void => {
    if (value === null && ctx?.nonClearableFieldIds?.has(fieldId)) return;
    result[fieldId] = value;
  };

  for (const mapping of mappings) {
    if (!mapping.locked && !mapping.enabled) continue;
    if (!mapping.pbFieldId) continue;
    if (!mapping.pbFieldType) continue;

    let rawValue: unknown = hsCompany.properties[mapping.hubspotProperty];
    if (rawValue === undefined) continue;

    // HubSpot returns unset properties as `""` (not undefined) — collapse those
    // to null up-front so the field becomes a `clear` op via
    // buildPatchOperations rather than feeding malformed values into coercion
    // (e.g. select would produce `{ name: "" }` and PB rejects with
    // "Invalid format for attribute '' in field with ID …"). Mirrors
    // PBToolkit's `isEmpty = rawVal === '' || rawVal == null` check
    // in companies.js:651.
    if (rawValue === null || (typeof rawValue === 'string' && rawValue.trim() === '')) {
      setValue(mapping.pbFieldId, null);
      continue;
    }

    // If the HS source is an owner/user-id field and the destination wants
    // email content (member, multimember, or text — for comma-delimited
    // listings), resolve the ids → emails up-front so the existing coerce
    // branches don't need any owner-aware logic.
    const ownerKind = detectOwnerIdField(mapping.hubspotProperty);
    const wantsEmail =
      mapping.pbFieldType === 'member' ||
      mapping.pbFieldType === 'multimember' ||
      mapping.pbFieldType === 'text';
    if (ownerKind && wantsEmail) {
      rawValue = resolveOwnerIdsToEmails(rawValue, ownerKind, ctx);
      if (rawValue === null) {
        setValue(mapping.pbFieldId, null);
        continue;
      }
    }

    // Translate HS enumeration internal values → display labels before coercion.
    // HubSpot multiselect (fieldType=checkbox) values arrive as semicolon-delimited
    // internal strings like "academic_programs;academic_research". We split and
    // resolve each token so PB receives display labels ("Academic Programs",
    // "Academic Research") rather than raw internal values.
    //   • select / multiselect destination: array of label strings → coerced to { name }[]
    //   • text destination: array of label strings → joined with ", "
    // Single-select (no semicolon) is also resolved when options are present.
    const optMap = ctx?.hsPropertyOptions?.get(mapping.hubspotProperty);
    if (optMap && typeof rawValue === 'string') {
      if (rawValue.includes(';')) {
        rawValue = rawValue.split(';').map(v => { const t = v.trim(); return optMap.get(t) ?? t; }).filter(Boolean);
      } else {
        rawValue = optMap.get(rawValue.trim()) ?? rawValue;
      }
    }

    const coerced = coerceFieldValue(rawValue, mapping.pbFieldType, ctx);
    if (mapping.pbFieldType === 'number' && typeof coerced === 'number') {
      const constrained = applyNumberConstraints(
        coerced,
        mapping.pbFieldId,
        ctx?.fieldConstraintsById?.get(mapping.pbFieldId)
      );
      if (constrained === null) continue;
      setValue(mapping.pbFieldId, constrained);
      continue;
    }
    setValue(mapping.pbFieldId, coerced);
  }

  return result;
}

export function stripNullFieldValues(fields: Record<string, PBFieldValue>): Record<string, Exclude<PBFieldValue, null>> {
  const result: Record<string, Exclude<PBFieldValue, null>> = {};
  for (const [fieldId, value] of Object.entries(fields)) {
    if (value !== null) result[fieldId] = value;
  }
  return result;
}

export function buildPatchOperations(
  fields: Record<string, PBFieldValue>,
  nonClearableFieldIds: Set<string> = new Set()
): Array<{ op: 'set' | 'clear'; path: string; value?: Exclude<PBFieldValue, null> }> {
  const ops: Array<{ op: 'set' | 'clear'; path: string; value?: Exclude<PBFieldValue, null> }> = [];

  for (const [fieldId, value] of Object.entries(fields)) {
    if (value === null) {
      if (!nonClearableFieldIds.has(fieldId)) ops.push({ op: 'clear', path: fieldId });
      continue;
    }
    ops.push({ op: 'set', path: fieldId, value });
  }

  return ops;
}
