/**
 * HVAC Calculation Utilities
 */

// ═══════════════════════════════════════════════════════════════════════════
// DUCT CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate rectangular duct area (m²)
 */
export function rectDuctArea(widthMm: number, heightMm: number): number {
  return (widthMm / 1000) * (heightMm / 1000);
}

/**
 * Calculate round duct area (m²)
 */
export function roundDuctArea(diameterMm: number): number {
  const radiusM = diameterMm / 2000;
  return Math.PI * radiusM * radiusM;
}

/**
 * Calculate equivalent round duct diameter for rectangular duct
 * Uses ASHRAE formula: De = 1.30 * ((a*b)^0.625) / ((a+b)^0.25)
 */
export function equivalentDiameter(widthMm: number, heightMm: number): number {
  const a = widthMm;
  const b = heightMm;
  return 1.3 * Math.pow(a * b, 0.625) / Math.pow(a + b, 0.25);
}

/**
 * Calculate duct velocity (m/s)
 */
export function ductVelocity(airflowLps: number, areaSqM: number): number {
  return (airflowLps / 1000) / areaSqM;
}

/**
 * Calculate airflow from velocity (L/s)
 */
export function airflowFromVelocity(velocityMs: number, areaSqM: number): number {
  return velocityMs * areaSqM * 1000;
}

/**
 * Calculate rectangular duct perimeter (mm)
 */
export function rectDuctPerimeter(widthMm: number, heightMm: number): number {
  return 2 * (widthMm + heightMm);
}

/**
 * Calculate rectangular duct surface area per meter length (m²/m)
 */
export function rectDuctSurfaceAreaPerMeter(widthMm: number, heightMm: number): number {
  return rectDuctPerimeter(widthMm, heightMm) / 1000;
}

/**
 * Calculate round duct surface area per meter length (m²/m)
 */
export function roundDuctSurfaceAreaPerMeter(diameterMm: number): number {
  return (Math.PI * diameterMm) / 1000;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAUGE SELECTION (SMACNA)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get recommended gauge for rectangular duct based on SMACNA
 */
export function getRecommendedGauge(
  widthMm: number,
  _heightMm: number,
  pressureClass: "low" | "medium" | "high" = "low"
): number {
  const maxDimension = widthMm;

  if (pressureClass === "low") {
    if (maxDimension <= 300) return 26;
    if (maxDimension <= 750) return 24;
    if (maxDimension <= 1200) return 22;
    if (maxDimension <= 1800) return 20;
    return 18;
  }

  if (pressureClass === "medium") {
    if (maxDimension <= 450) return 24;
    if (maxDimension <= 750) return 22;
    if (maxDimension <= 1200) return 20;
    if (maxDimension <= 1800) return 18;
    return 16;
  }

  // High pressure
  if (maxDimension <= 450) return 22;
  if (maxDimension <= 900) return 20;
  if (maxDimension <= 1200) return 18;
  return 16;
}

// ═══════════════════════════════════════════════════════════════════════════
// WEIGHT CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Steel density kg/mm³ by gauge
 */
const STEEL_WEIGHT_KG_PER_SQM: Record<number, number> = {
  26: 4.27,
  24: 5.47,
  22: 6.87,
  20: 8.59,
  18: 10.77,
  16: 13.61,
};

/**
 * Calculate duct weight per meter (kg/m)
 */
export function ductWeightPerMeter(
  widthMm: number,
  heightMm: number,
  gauge: number
): number {
  const surfaceArea = rectDuctSurfaceAreaPerMeter(widthMm, heightMm);
  const weightPerSqM = STEEL_WEIGHT_KG_PER_SQM[gauge] || 6.87;
  return surfaceArea * weightPerSqM;
}

// ═══════════════════════════════════════════════════════════════════════════
// BOQ CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate quantity based on component type
 */
export function calculateQuantity(
  componentType: string,
  properties: Record<string, unknown>
): { quantity: number; unit: string } {
  const length = (properties.length as number) || 0;
  const width = (properties.width as number) || 0;
  const height = (properties.height as number) || 0;

  switch (componentType) {
    case "RECT_DUCT":
    case "ROUND_DUCT":
    case "FLEX_DUCT":
      return { quantity: length / 1000, unit: "LM" }; // Linear meters

    case "ELBOW_RECT":
    case "ELBOW_ROUND":
    case "TEE_RECT":
    case "TEE_ROUND":
    case "REDUCER_RECT":
    case "REDUCER_ROUND":
    case "DIFFUSER_SQUARE":
    case "DIFFUSER_ROUND":
    case "GRILLE_RETURN":
    case "DAMPER_VOLUME":
    case "ACCESS_DOOR":
      return { quantity: 1, unit: "NOS" }; // Numbers

    case "INSULATION_DUCT_EXT":
    case "INSULATION_DUCT_INT":
      return {
        quantity: rectDuctSurfaceAreaPerMeter(width, height) * (length / 1000),
        unit: "SQM",
      };

    case "INSULATION_PIPE":
      return { quantity: length / 1000, unit: "LM" };

    case "REF_PIPE":
      return { quantity: length, unit: "M" }; // Meters

    default:
      return { quantity: 1, unit: "NOS" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRICING CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply markup percentage
 */
export function applyMarkup(baseCost: number, markupPercent: number): number {
  return baseCost * (1 + markupPercent / 100);
}

/**
 * Calculate total with markups
 */
export function calculateTotalWithMarkups(
  subtotal: number,
  overheadPercent: number,
  profitPercent: number,
  contingencyPercent: number
): {
  overhead: number;
  profit: number;
  contingency: number;
  total: number;
} {
  const overhead = subtotal * (overheadPercent / 100);
  const withOverhead = subtotal + overhead;

  const profit = withOverhead * (profitPercent / 100);
  const withProfit = withOverhead + profit;

  const contingency = withProfit * (contingencyPercent / 100);
  const total = withProfit + contingency;

  return { overhead, profit, contingency, total };
}

/**
 * Calculate tax
 */
export function calculateTax(amount: number, taxRate: number): number {
  return amount * (taxRate / 100);
}

// ═══════════════════════════════════════════════════════════════════════════
// VRF PIPING VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

export interface VRFLimits {
  maxPipingLength: number;
  maxHeightDifference: number;
  maxIDUToFirstBranch: number;
  maxIDUConnections: number;
}

export const DEFAULT_VRF_LIMITS: VRFLimits = {
  maxPipingLength: 165,
  maxHeightDifference: 50,
  maxIDUToFirstBranch: 40,
  maxIDUConnections: 64,
};

export interface VRFValidationResult {
  isValid: boolean;
  checks: {
    pipingLength: { value: number; limit: number; status: "ok" | "warning" | "error" };
    heightDifference: { value: number; limit: number; status: "ok" | "warning" | "error" };
    iduToFirstBranch: { value: number; limit: number; status: "ok" | "warning" | "error" };
    iduConnections: { value: number; limit: number; status: "ok" | "warning" | "error" };
  };
}

/**
 * Validate VRF system against manufacturer limits
 */
export function validateVRFSystem(
  values: {
    pipingLength: number;
    heightDifference: number;
    iduToFirstBranch: number;
    iduConnections: number;
  },
  limits: VRFLimits = DEFAULT_VRF_LIMITS
): VRFValidationResult {
  const getStatus = (value: number, limit: number): "ok" | "warning" | "error" => {
    const ratio = value / limit;
    if (ratio > 1) return "error";
    if (ratio > 0.9) return "warning";
    return "ok";
  };

  const checks = {
    pipingLength: {
      value: values.pipingLength,
      limit: limits.maxPipingLength,
      status: getStatus(values.pipingLength, limits.maxPipingLength),
    },
    heightDifference: {
      value: values.heightDifference,
      limit: limits.maxHeightDifference,
      status: getStatus(values.heightDifference, limits.maxHeightDifference),
    },
    iduToFirstBranch: {
      value: values.iduToFirstBranch,
      limit: limits.maxIDUToFirstBranch,
      status: getStatus(values.iduToFirstBranch, limits.maxIDUToFirstBranch),
    },
    iduConnections: {
      value: values.iduConnections,
      limit: limits.maxIDUConnections,
      status: getStatus(values.iduConnections, limits.maxIDUConnections),
    },
  };

  const isValid = Object.values(checks).every((c) => c.status !== "error");

  return { isValid, checks };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format currency
 */
export function formatCurrency(
  amount: number,
  currency: string = "USD",
  locale: string = "en-US"
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amount);
}

/**
 * Format number with units
 */
export function formatWithUnit(value: number, unit: string, decimals: number = 2): string {
  return `${value.toFixed(decimals)} ${unit}`;
}

/**
 * Format duct size
 */
export function formatDuctSize(width: number, height: number): string {
  return `${width}x${height}mm`;
}

/**
 * Format round duct size
 */
export function formatRoundDuctSize(diameter: number): string {
  return `Ø${diameter}mm`;
}
