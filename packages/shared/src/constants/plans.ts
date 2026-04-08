/**
 * Subscription Plans and Limits
 */

export enum Plan {
  FREE = "FREE",
  STARTER = "STARTER",
  PROFESSIONAL = "PROFESSIONAL",
  ENTERPRISE = "ENTERPRISE",
}

export interface PlanFeatures {
  smartDrawing: boolean;
  boqGenerator: boolean;
  basicPricing: boolean;
  proposalGenerator: boolean;
  ocrImport: boolean;
  advancedReports: boolean;
  apiAccess: boolean;
  ssoAuth: boolean;
  aiFeatures: boolean;
  complianceSheets: boolean;
  technicalLibrary: boolean;
  mobileApp: boolean;
}

export interface PlanLimits {
  maxUsers: number;
  maxProjects: number;
  maxStorageGB: number;
  maxDrawingsPerProject: number;
  features: PlanFeatures;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  [Plan.FREE]: {
    maxUsers: 5,
    maxProjects: 10,
    maxStorageGB: 1,
    maxDrawingsPerProject: 3,
    features: {
      smartDrawing: true,
      boqGenerator: true,
      basicPricing: true,
      proposalGenerator: true,
      ocrImport: false,
      advancedReports: false,
      apiAccess: false,
      ssoAuth: false,
      aiFeatures: false,
      complianceSheets: false,
      technicalLibrary: false,
      mobileApp: false,
    },
  },

  [Plan.STARTER]: {
    maxUsers: 10,
    maxProjects: 50,
    maxStorageGB: 10,
    maxDrawingsPerProject: 10,
    features: {
      smartDrawing: true,
      boqGenerator: true,
      basicPricing: true,
      proposalGenerator: true,
      ocrImport: true,
      advancedReports: true,
      apiAccess: false,
      ssoAuth: false,
      aiFeatures: true,
      complianceSheets: true,
      technicalLibrary: true,
      mobileApp: false,
    },
  },

  [Plan.PROFESSIONAL]: {
    maxUsers: 25,
    maxProjects: -1, // Unlimited
    maxStorageGB: 50,
    maxDrawingsPerProject: -1, // Unlimited
    features: {
      smartDrawing: true,
      boqGenerator: true,
      basicPricing: true,
      proposalGenerator: true,
      ocrImport: true,
      advancedReports: true,
      apiAccess: true,
      ssoAuth: false,
      aiFeatures: true,
      complianceSheets: true,
      technicalLibrary: true,
      mobileApp: true,
    },
  },

  [Plan.ENTERPRISE]: {
    maxUsers: -1, // Unlimited
    maxProjects: -1, // Unlimited
    maxStorageGB: -1, // Unlimited
    maxDrawingsPerProject: -1, // Unlimited
    features: {
      smartDrawing: true,
      boqGenerator: true,
      basicPricing: true,
      proposalGenerator: true,
      ocrImport: true,
      advancedReports: true,
      apiAccess: true,
      ssoAuth: true,
      aiFeatures: true,
      complianceSheets: true,
      technicalLibrary: true,
      mobileApp: true,
    },
  },
};

/**
 * Check if a feature is available for a plan
 */
export function hasFeature(plan: Plan, feature: keyof PlanFeatures): boolean {
  return PLAN_LIMITS[plan].features[feature] ?? false;
}

/**
 * Check if current usage is within plan limits
 */
export function withinLimits(
  plan: Plan,
  metric: keyof Omit<PlanLimits, "features">,
  current: number
): boolean {
  const limit = PLAN_LIMITS[plan][metric] as number;
  return limit === -1 || current < limit;
}

/**
 * Get remaining quota for a metric
 */
export function getRemainingQuota(
  plan: Plan,
  metric: keyof Omit<PlanLimits, "features">,
  current: number
): number | "unlimited" {
  const limit = PLAN_LIMITS[plan][metric] as number;
  if (limit === -1) return "unlimited";
  return Math.max(0, limit - current);
}

/**
 * Plan display information
 */
export const PLAN_INFO: Record<Plan, { name: string; price: string; description: string }> = {
  [Plan.FREE]: {
    name: "Free",
    price: "$0",
    description: "Perfect for trying out ProvacX",
  },
  [Plan.STARTER]: {
    name: "Starter",
    price: "$29/mo",
    description: "For small HVAC contractors",
  },
  [Plan.PROFESSIONAL]: {
    name: "Professional",
    price: "$79/mo",
    description: "For growing HVAC businesses",
  },
  [Plan.ENTERPRISE]: {
    name: "Enterprise",
    price: "Custom",
    description: "For large organizations with custom needs",
  },
};
