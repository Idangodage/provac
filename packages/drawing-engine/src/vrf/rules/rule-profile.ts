import { z } from 'zod';

/**
 * Manufacturer rules are data, never universal constants. Every engineering
 * value carries provenance so the UI can distinguish verified data from a
 * project preference or a conservative software fallback.
 */
export const ruleProvenanceSchema = z.enum([
  'manufacturer-model',
  'manufacturer-family',
  'project-default',
  'fallback',
]);

export type RuleProvenance = z.infer<typeof ruleProvenanceSchema>;

export interface RuleValue<T> {
  value: T;
  source: RuleProvenance;
  verified: boolean;
  sourceReference?: string;
  note?: string;
}

export function ruleValueSchema<TSchema extends z.ZodTypeAny>(value: TSchema) {
  return z.object({
    value,
    source: ruleProvenanceSchema,
    verified: z.boolean(),
    sourceReference: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  });
}

export const vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

export type RuleVec3 = z.infer<typeof vec3Schema>;

export const branchOrientationModeSchema = z.enum([
  'horizontal-split',
  'vertical-split',
  'horizontal-header',
]);

export type BranchOrientationMode = z.infer<typeof branchOrientationModeSchema>;

export const branchOrientationRuleSchema = z.object({
  allowedModes: z.array(branchOrientationModeSchema).min(1),
  maximumRollDeviationDeg: ruleValueSchema(z.number().finite().min(0).max(180)).optional(),
  maximumPitchDeviationDeg: ruleValueSchema(z.number().finite().min(0).max(180)).optional(),
  autoLevelToWorldGravity: z.boolean().optional(),
  prohibitedOutletDirections: z.array(vec3Schema).optional(),
});

export type BranchOrientationRule = z.infer<typeof branchOrientationRuleSchema>;

export const straightZoneRuleSchema = z.object({
  upstreamMinimumMm: ruleValueSchema(z.number().finite().nonnegative()).optional(),
  downstreamMinimumMm: ruleValueSchema(z.number().finite().nonnegative()).optional(),
  appliesToOutletIndex: z.number().int().nonnegative().optional(),
  noBendAllowed: z.boolean(),
  noReducerAllowed: z.boolean(),
  noOtherBranchAllowed: z.boolean(),
});

export type StraightZoneRule = z.infer<typeof straightZoneRuleSchema>;

export const branchTypeSchema = z.enum(['y-joint', 'header', 'outdoor-multi-kit']);
export const branchSystemRoleSchema = z.enum([
  'first-branch',
  'intermediate-branch',
  'terminal-header',
]);

export const vrfArrangementSchema = z.enum(['heat-pump', 'heat-recovery']);

export const branchKitCatalogRuleSchema = z.object({
  id: z.string().min(1),
  manufacturer: z.string().min(1),
  family: z.string().min(1),
  model: z.string().min(1),
  branchType: branchTypeSchema,
  allowedSystemRoles: z.array(branchSystemRoleSchema).min(1),
  refrigerants: z.array(z.string().min(1)).min(1),
  arrangements: z.array(vrfArrangementSchema).min(1),
  downstreamCapacityIndexMin: ruleValueSchema(z.number().finite().nonnegative()).optional(),
  downstreamCapacityIndexMax: ruleValueSchema(z.number().finite().positive()).optional(),
  outdoorCapacityMin: ruleValueSchema(z.number().finite().nonnegative()).optional(),
  outdoorCapacityMax: ruleValueSchema(z.number().finite().positive()).optional(),
  downstreamBranchCountMin: z.number().int().nonnegative().optional(),
  downstreamBranchCountMax: z.number().int().positive().optional(),
  upstreamDiametersMm: z.array(z.number().finite().positive()).optional(),
  downstreamDiametersMm: z.array(z.number().finite().positive()).optional(),
  headerOutletCount: z.number().int().positive().optional(),
  compatibleReducerIds: z.array(z.string().min(1)).optional(),
  orientation: branchOrientationRuleSchema,
  straightZones: z.array(straightZoneRuleSchema).default([]),
  provenanceNote: z.string().min(1).optional(),
});

export type BranchKitCatalogRule = z.infer<typeof branchKitCatalogRuleSchema>;

export const pipeSizingRuleSchema = z.object({
  id: z.string().min(1),
  systemType: z.enum([
    'refrigerant-gas',
    'refrigerant-liquid',
    'refrigerant-suction',
    'refrigerant-discharge',
    'refrigerant-equalizer',
    'drain',
  ]),
  capacityIndexMin: z.number().finite().nonnegative(),
  capacityIndexMax: z.number().finite().positive(),
  outsideDiameterMm: ruleValueSchema(z.number().finite().positive()),
  minimumBendRadiusMm: ruleValueSchema(z.number().finite().positive()),
});

export type PipeSizingRule = z.infer<typeof pipeSizingRuleSchema>;

export const equipmentPortDefaultsSchema = z.object({
  minimumStraightStubMm: ruleValueSchema(z.number().finite().nonnegative()),
  minimumBendRadiusMm: ruleValueSchema(z.number().finite().positive()),
  serviceClearanceMm: ruleValueSchema(z.number().finite().nonnegative()),
  allowedExitConeDeg: ruleValueSchema(z.number().finite().min(0).max(180)).optional(),
});

export type EquipmentPortDefaults = z.infer<typeof equipmentPortDefaultsSchema>;

export const routeLimitRulesSchema = z.object({
  maximumTotalLengthMm: ruleValueSchema(z.number().finite().positive()).optional(),
  maximumEquivalentLengthMm: ruleValueSchema(z.number().finite().positive()).optional(),
  maximumHeightDifferenceMm: ruleValueSchema(z.number().finite().nonnegative()).optional(),
  maximumIndoorToBranchLengthMm: ruleValueSchema(z.number().finite().positive()).optional(),
  maximumIndoorUnitCount: ruleValueSchema(z.number().int().positive()).optional(),
});

export type RouteLimitRules = z.infer<typeof routeLimitRulesSchema>;

export const manufacturerRuleProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  manufacturer: z.string().min(1),
  family: z.string().min(1),
  refrigerants: z.array(z.string().min(1)).min(1),
  verified: z.boolean(),
  sourceReferences: z.array(z.string().min(1)).default([]),
  portDefaults: equipmentPortDefaultsSchema,
  branchKits: z.array(branchKitCatalogRuleSchema).default([]),
  pipeSizing: z.array(pipeSizingRuleSchema).default([]),
  routeLimits: routeLimitRulesSchema.default({}),
});

export type ManufacturerRuleProfile = z.infer<typeof manufacturerRuleProfileSchema>;

const SOURCE_PRIORITY: Record<RuleProvenance, number> = {
  'manufacturer-model': 0,
  'manufacturer-family': 1,
  'project-default': 2,
  fallback: 3,
};

/** Resolve exact model -> family -> project -> fallback without losing provenance. */
export function resolveRuleValue<T>(
  candidates: ReadonlyArray<RuleValue<T> | null | undefined>,
): RuleValue<T> | null {
  const available = candidates.filter((value): value is RuleValue<T> => Boolean(value));
  if (available.length === 0) return null;
  return [...available].sort((left, right) => (
    SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source]
    || Number(right.verified) - Number(left.verified)
  ))[0]!;
}

export function isVerifiedManufacturerValue<T>(value: RuleValue<T>): boolean {
  return value.verified && (
    value.source === 'manufacturer-model'
    || value.source === 'manufacturer-family'
  );
}

function fallbackValue<T>(value: T, note: string): RuleValue<T> {
  return {
    value,
    source: 'fallback',
    verified: false,
    note,
  };
}

/**
 * Safe application fallback. These values keep geometry constructible, but are
 * deliberately labelled as unverified and must never be presented as a
 * manufacturer's requirement.
 */
export const PROJECT_FALLBACK_RULE_PROFILE: ManufacturerRuleProfile = {
  schemaVersion: 1,
  id: 'project-fallback/unverified',
  manufacturer: 'Unspecified',
  family: 'Project fallback',
  refrigerants: ['unspecified'],
  verified: false,
  sourceReferences: [],
  portDefaults: {
    minimumStraightStubMm: fallbackValue(150, 'Unverified application fallback.'),
    minimumBendRadiusMm: fallbackValue(60, 'Unverified application fallback.'),
    serviceClearanceMm: fallbackValue(100, 'Unverified application fallback.'),
    allowedExitConeDeg: fallbackValue(45, 'Unverified application fallback.'),
  },
  branchKits: [],
  pipeSizing: [],
  routeLimits: {},
};

