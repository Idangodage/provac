import { z } from 'zod';

import {
  manufacturerRuleProfileSchema,
  type ManufacturerRuleProfile,
} from './rule-profile';

export interface RuleProfileLoadResult {
  profile: ManufacturerRuleProfile | null;
  errors: string[];
}

/** Parse external JSON without allowing malformed rules into engineering logic. */
export function loadManufacturerRuleProfile(input: unknown): RuleProfileLoadResult {
  const parsed = manufacturerRuleProfileSchema.safeParse(input);
  if (parsed.success) {
    return { profile: parsed.data, errors: [] };
  }
  return {
    profile: null,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'profile';
      return `${path}: ${issue.message}`;
    }),
  };
}

export class ManufacturerRuleRegistry {
  private readonly profiles = new Map<string, ManufacturerRuleProfile>();

  register(input: unknown): RuleProfileLoadResult {
    const result = loadManufacturerRuleProfile(input);
    if (result.profile) this.profiles.set(result.profile.id, result.profile);
    return result;
  }

  get(id: string): ManufacturerRuleProfile | null {
    return this.profiles.get(id) ?? null;
  }

  find(manufacturer: string, family?: string, refrigerant?: string): ManufacturerRuleProfile[] {
    const m = manufacturer.trim().toLowerCase();
    const f = family?.trim().toLowerCase();
    const r = refrigerant?.trim().toLowerCase();
    return [...this.profiles.values()].filter((profile) => (
      profile.manufacturer.trim().toLowerCase() === m
      && (!f || profile.family.trim().toLowerCase() === f)
      && (!r || profile.refrigerants.some((candidate) => candidate.toLowerCase() === r))
    ));
  }

  clear(): void {
    this.profiles.clear();
  }
}

/** Stable formatting for callers that want to surface Zod errors in a HUD. */
export function formatRuleProfileError(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || 'profile'}: ${issue.message}`);
}

