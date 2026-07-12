export const INCH_MM = 25.4;
export const THREE_EIGHTHS_INCH_MM = INCH_MM * 0.375;
export const FIVE_EIGHTHS_INCH_MM = INCH_MM * 0.625;
export const THREE_QUARTER_INCH_MM = INCH_MM * 0.75;

export const DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM = FIVE_EIGHTHS_INCH_MM;
export const DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM = THREE_EIGHTHS_INCH_MM;
export const DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM = THREE_QUARTER_INCH_MM;
export const DEFAULT_REFRIGERANT_PIPE_GAP_MM = INCH_MM;

export function computeIndoorRefrigerantPortStubLengthMm(
  pipeDiameterMm: number,
): number {
  const normalizedDiameter = Number.isFinite(pipeDiameterMm) && pipeDiameterMm > 0
    ? pipeDiameterMm
    : DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM;
  return Math.max(52, Math.min(64, normalizedDiameter * 3.8));
}

export function computeIndoorDrainPortStubLengthMm(
  pipeDiameterMm: number,
): number {
  const normalizedDiameter = Number.isFinite(pipeDiameterMm) && pipeDiameterMm > 0
    ? pipeDiameterMm
    : 32;
  return Math.max(64, Math.min(80, normalizedDiameter * 2.2));
}
