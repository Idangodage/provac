import type {
  BranchOrientationMode,
  BranchOrientationRule,
  RuleVec3,
} from './rule-profile';

export interface BranchWorldFrame {
  forward: RuleVec3;
  up: RuleVec3;
  splitPlaneNormal: RuleVec3;
  outletDirections?: RuleVec3[];
}

export interface BranchOrientationMeasurement {
  mode: BranchOrientationMode;
  rollDeg: number;
  pitchDeg: number;
}

export interface BranchOrientationValidation extends BranchOrientationMeasurement {
  valid: boolean;
  violations: string[];
}

const dot = (a: RuleVec3, b: RuleVec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: RuleVec3, b: RuleVec3): RuleVec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const length = (value: RuleVec3) => Math.hypot(value.x, value.y, value.z);
const normalize = (value: RuleVec3, fallback: RuleVec3): RuleVec3 => {
  const magnitude = length(value);
  return magnitude > 1e-9
    ? { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude }
    : fallback;
};
const scale = (value: RuleVec3, factor: number): RuleVec3 => ({
  x: value.x * factor,
  y: value.y * factor,
  z: value.z * factor,
});
const subtract = (a: RuleVec3, b: RuleVec3): RuleVec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const degrees = (radians: number) => radians * 180 / Math.PI;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function signedAngleAround(a: RuleVec3, b: RuleVec3, axis: RuleVec3): number {
  const sin = dot(cross(a, b), axis);
  const cos = clamp(dot(a, b), -1, 1);
  return degrees(Math.atan2(sin, cos));
}

/** Measurements use world gravity only; a camera is intentionally absent. */
export function measureBranchOrientation(
  frame: BranchWorldFrame,
  worldGravity: RuleVec3 = { x: 0, y: 0, z: -1 },
): BranchOrientationMeasurement {
  const worldUp = normalize(scale(worldGravity, -1), { x: 0, y: 0, z: 1 });
  const forward = normalize(frame.forward, { x: 1, y: 0, z: 0 });
  const up = normalize(frame.up, worldUp);
  const splitNormal = normalize(frame.splitPlaneNormal, worldUp);
  const pitchDeg = degrees(Math.asin(clamp(dot(forward, worldUp), -1, 1)));
  const expectedUpRaw = subtract(worldUp, scale(forward, dot(worldUp, forward)));
  const expectedUp = normalize(expectedUpRaw, normalize(cross(forward, { x: 1, y: 0, z: 0 }), worldUp));
  const actualUp = normalize(subtract(up, scale(forward, dot(up, forward))), expectedUp);
  const rollDeg = signedAngleAround(expectedUp, actualUp, forward);
  const splitVerticality = Math.abs(dot(splitNormal, worldUp));
  const mode: BranchOrientationMode = splitVerticality >= Math.SQRT1_2
    ? 'horizontal-split'
    : 'vertical-split';
  return { mode, rollDeg, pitchDeg };
}

export function validateBranchOrientation(
  frame: BranchWorldFrame,
  rule: BranchOrientationRule,
  worldGravity?: RuleVec3,
): BranchOrientationValidation {
  const measurement = measureBranchOrientation(frame, worldGravity);
  const violations: string[] = [];
  if (!rule.allowedModes.includes(measurement.mode)) {
    violations.push(`${measurement.mode} is not allowed by the active rule profile.`);
  }
  const maxRoll = rule.maximumRollDeviationDeg?.value;
  if (maxRoll !== undefined && Math.abs(measurement.rollDeg) > maxRoll + 1e-6) {
    violations.push(`Roll ${measurement.rollDeg.toFixed(1)}° exceeds ${maxRoll.toFixed(1)}°.`);
  }
  const maxPitch = rule.maximumPitchDeviationDeg?.value;
  if (maxPitch !== undefined && Math.abs(measurement.pitchDeg) > maxPitch + 1e-6) {
    violations.push(`Pitch ${measurement.pitchDeg.toFixed(1)}° exceeds ${maxPitch.toFixed(1)}°.`);
  }
  for (const prohibited of rule.prohibitedOutletDirections ?? []) {
    const direction = normalize(prohibited, { x: 1, y: 0, z: 0 });
    if ((frame.outletDirections ?? []).some((outlet) => dot(normalize(outlet, direction), direction) > 0.999)) {
      violations.push('An outlet points in a prohibited world direction.');
      break;
    }
  }
  return { ...measurement, valid: violations.length === 0, violations };
}

export function nearestAllowedOrientation(
  measurement: BranchOrientationMeasurement,
  rule: BranchOrientationRule,
): BranchOrientationMeasurement {
  return {
    mode: rule.allowedModes.includes(measurement.mode)
      ? measurement.mode
      : rule.allowedModes[0]!,
    rollDeg: clamp(
      measurement.rollDeg,
      -(rule.maximumRollDeviationDeg?.value ?? 180),
      rule.maximumRollDeviationDeg?.value ?? 180,
    ),
    pitchDeg: clamp(
      measurement.pitchDeg,
      -(rule.maximumPitchDeviationDeg?.value ?? 180),
      rule.maximumPitchDeviationDeg?.value ?? 180,
    ),
  };
}

