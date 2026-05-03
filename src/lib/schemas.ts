import { z } from 'zod';

// ── Connections ───────────────────────────────────────────────────────────────

export const TokenBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

// ── Filters ───────────────────────────────────────────────────────────────────

const HubSpotFilterSchema = z.object({
  propertyName: z.string(),
  operator: z.enum([
    'EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE',
    'BETWEEN', 'IN', 'NOT_IN',
    'HAS_PROPERTY', 'NOT_HAS_PROPERTY',
    'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN',
  ]),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  highValue: z.string().optional(),
});

const FilterGroupSchema = z.object({
  filters: z.array(HubSpotFilterSchema),
});

// ── Field mappings ────────────────────────────────────────────────────────────

const FieldMappingSchema = z.object({
  hubspotProperty: z.string(),
  pbFieldId: z.string(),
  pbFieldType: z.enum([
    'text', 'richtext', 'number', 'select', 'multiselect',
    'date', 'boolean', 'member', 'multimember',
  ]).nullable(),
  enabled: z.boolean(),
  locked: z.boolean(),
});

const TagMappingSchema = z.object({
  hsField: z.string(),
  prefix: z.string().optional(),
  enabled: z.boolean(),
});

const BodyMappingSchema = z.object({
  hsField: z.string(),
  label: z.string().optional(),
  style: z.enum(['metadata', 'longform']),
  order: z.number().int(),
  enabled: z.boolean(),
});

const TagRuleSchema = z.object({
  field: z.string(),
  operator: z.enum([
    'EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE',
    'BETWEEN', 'IN', 'NOT_IN',
    'HAS_PROPERTY', 'NOT_HAS_PROPERTY',
    'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN',
  ]),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  tagName: z.string(),
});

const DealsFieldMappingsSchema = z.object({
  tags: z.array(TagMappingSchema),
  body: z.array(BodyMappingSchema),
  rules: z.array(TagRuleSchema),
  staticTags: z.array(z.string()),
});

// ── Sync config (partial update) ──────────────────────────────────────────────

const SyncConfigUpdateSchema = z.object({
  schedule: z.object({
    companies: z.string().nullable(),
    deals: z.string().nullable(),
  }).partial().optional(),
  lastSyncAt: z.object({
    companies: z.string().nullable(),
    deals: z.string().nullable(),
  }).partial().optional(),
  domainFallbackEnabled: z.boolean().optional(),
  multiCompanyDealNotes: z.boolean().optional(),
  forceContentUpdates: z.boolean().optional(),
  debugLogging: z.boolean().optional(),
  historyRetentionDays: z.number().int().positive().optional(),
  legacySchedule: z.enum(['manual', 'daily', 'weekly', 'hourly', 'every15']).optional(),
  legacyScheduleTime: z.string().optional(),
  legacyScheduleDay: z.string().optional(),
  legacyTimezone: z.string().optional(),
  syncToPBProperty: z.string().optional(),
});

// ── Config PATCH body ─────────────────────────────────────────────────────────

export const ConfigPatchBodySchema = z.object({
  sync: SyncConfigUpdateSchema.optional(),
  fieldMappings: z.object({
    companies: z.array(FieldMappingSchema).optional(),
    deals: DealsFieldMappingsSchema.optional(),
  }).optional(),
  filters: z.object({
    companies: z.object({
      enabled: z.boolean(),
      filterGroups: z.array(FilterGroupSchema),
      previewCount: z.number().int().nonnegative().optional(),
    }).optional(),
    deals: z.object({
      pipelineId: z.string(),
      stageIds: z.array(z.string()),
      filterGroups: z.array(FilterGroupSchema),
    }).optional(),
  }).optional(),
});
