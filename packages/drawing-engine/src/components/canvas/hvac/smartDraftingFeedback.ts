import type {
  PipeAxisConstraint,
  PipeDrawingPlaneKind,
  PipeSnapKind,
} from './pipePointerProjection';

export interface DraftingPoint3D {
  x: number;
  y: number;
  z: number;
}

export type SmartDraftingSlopeKind =
  | 'point'
  | 'horizontal'
  | 'sloped'
  | 'vertical';

export interface SmartDraftingMetrics {
  deltaXmm: number;
  deltaYmm: number;
  deltaZmm: number;
  planLengthMm: number;
  lengthMm: number;
  slopePercent: number | null;
  slopeKind: SmartDraftingSlopeKind;
}

export interface SmartDraftingSnapFeedback {
  kind: PipeSnapKind;
  message?: string | null;
}

export interface SmartDraftingFeedbackInput {
  anchor: DraftingPoint3D;
  current: DraftingPoint3D;
  workplaneKind: PipeDrawingPlaneKind;
  axisConstraint?: PipeAxisConstraint;
  snap?: SmartDraftingSnapFeedback | null;
  ambiguityCount?: number;
}

export type SmartDraftingHudMetricKey = 'length' | 'delta-z' | 'slope';

export interface SmartDraftingHudRow {
  key: SmartDraftingHudMetricKey;
  label: string;
  value: string;
}

export interface SmartDraftingFeedback {
  metrics: SmartDraftingMetrics;
  lengthText: string;
  deltaZText: string;
  slopeText: string;
  metricsText: string;
  label: string;
  keyboardHint: string;
  nearCursor: {
    label: string;
    metrics: string;
    hint: string;
  };
  hudRows: readonly SmartDraftingHudRow[];
  ariaLabel: string;
}

const VECTOR_EPSILON_MM = 1e-6;
const MAX_SEMANTIC_MESSAGE_LENGTH = 48;
const MAX_LABEL_LENGTH = 80;
const MAX_AMBIGUITY_DISPLAY = 99;

const WORKPLANE_LABELS: Record<PipeDrawingPlaneKind, string> = {
  floor: 'Floor',
  wall: 'Wall',
  ceiling: 'Ceiling',
  'equipment-face': 'Equipment face',
  'work-plane': 'Work plane',
  'view-plane': 'View plane',
  'camera-facing': 'Camera plane',
};

const AXIS_LABELS: Record<PipeAxisConstraint, string | null> = {
  none: null,
  'local-x': 'Local X lock',
  'local-y': 'Local Y lock',
  'world-x': 'X lock',
  'world-y': 'Y lock',
  'world-z': 'Z lock',
};

const SNAP_LABELS: Record<PipeSnapKind, string> = {
  'equipment-port': 'Equipment port',
  'pipe-endpoint': 'Pipe endpoint',
  fitting: 'Fitting',
  guide: 'Guide',
  surface: 'Surface',
  'construction-plane': 'Construction plane',
};

function requireFiniteCoordinate(
  point: DraftingPoint3D,
  pointName: 'anchor' | 'current',
): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    if (!Number.isFinite(point[axis])) {
      throw new RangeError(`${pointName}.${axis} must be a finite number`);
    }
  }
}

function requireFiniteMetric(value: number, metricName: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${metricName} is outside the supported numeric range`);
  }
  return value;
}

function normalizeInlineText(value: string): string {
  const withoutControlCharacters = Array.from(value, (character) => {
    const characterCode = character.charCodeAt(0);
    return characterCode <= 0x1f
      || (characterCode >= 0x7f && characterCode <= 0x9f)
      ? ' '
      : character;
  }).join('');

  return withoutControlCharacters
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }

  return `${value.slice(0, maximumLength - 1).trimEnd()}…`;
}

function formatDistanceMm(distanceMm: number): string {
  const absoluteDistance = Math.abs(distanceMm);

  if (absoluteDistance <= VECTOR_EPSILON_MM) {
    return '0 mm';
  }

  if (absoluteDistance < 10) {
    return `${absoluteDistance.toFixed(1).replace(/\.0$/, '')} mm`;
  }

  if (absoluteDistance < 1000) {
    return `${Math.round(absoluteDistance)} mm`;
  }

  const distanceM = absoluteDistance / 1000;
  const fractionDigits = distanceM < 10 ? 2 : distanceM < 100 ? 1 : 0;
  return `${distanceM.toFixed(fractionDigits)} m`;
}

function formatSignedDistanceMm(distanceMm: number): string {
  if (Math.abs(distanceMm) <= VECTOR_EPSILON_MM) {
    return '0 mm';
  }

  return `${distanceMm > 0 ? '+' : '-'}${formatDistanceMm(distanceMm)}`;
}

function formatSlopeValue(metrics: SmartDraftingMetrics): string {
  if (metrics.slopeKind === 'vertical') {
    return 'Vertical';
  }

  if (metrics.slopePercent === null) {
    return '—';
  }

  const normalizedSlope = Math.abs(metrics.slopePercent) <= VECTOR_EPSILON_MM
    ? 0
    : metrics.slopePercent;
  return `${normalizedSlope.toFixed(1)}%`;
}

function formatSlopeText(metrics: SmartDraftingMetrics): string {
  const value = formatSlopeValue(metrics);
  return value === 'Vertical' ? value : `Slope ${value}`;
}

function getSemanticSnapLabel(snap: SmartDraftingSnapFeedback): string {
  const message = snap.message
    ? truncateText(
      normalizeInlineText(snap.message),
      MAX_SEMANTIC_MESSAGE_LENGTH,
    )
    : '';
  return message || SNAP_LABELS[snap.kind];
}

function normalizeAmbiguityCount(ambiguityCount: number | undefined): number {
  if (!Number.isFinite(ambiguityCount) || (ambiguityCount ?? 0) <= 0) {
    return 0;
  }
  return Math.floor(ambiguityCount as number);
}

function buildFeedbackLabel(input: SmartDraftingFeedbackInput): string {
  const parts = [WORKPLANE_LABELS[input.workplaneKind]];
  const axisLabel = AXIS_LABELS[input.axisConstraint ?? 'none'];

  if (axisLabel) {
    parts.push(axisLabel);
  }
  if (input.snap) {
    parts.push(getSemanticSnapLabel(input.snap));
  }

  return truncateText(parts.join(' · '), MAX_LABEL_LENGTH);
}

function buildKeyboardHint(input: SmartDraftingFeedbackInput): string {
  const hints: string[] = [];
  const ambiguityCount = normalizeAmbiguityCount(input.ambiguityCount);

  if (ambiguityCount > 1) {
    const displayCount = ambiguityCount > MAX_AMBIGUITY_DISPLAY
      ? `${MAX_AMBIGUITY_DISPLAY}+`
      : String(ambiguityCount);
    hints.push(`Tab cycle ${displayCount}`);
  }
  if (input.snap) {
    hints.push('Alt free');
  }
  if ((input.axisConstraint ?? 'none') === 'none') {
    hints.push('Shift axis');
  }

  hints.push('Enter accept', 'Esc cancel');
  return hints.join(' · ');
}

export function measureSmartDraftingVector(
  anchor: DraftingPoint3D,
  current: DraftingPoint3D,
): SmartDraftingMetrics {
  requireFiniteCoordinate(anchor, 'anchor');
  requireFiniteCoordinate(current, 'current');

  const deltaXmm = requireFiniteMetric(current.x - anchor.x, 'deltaXmm');
  const deltaYmm = requireFiniteMetric(current.y - anchor.y, 'deltaYmm');
  const deltaZmm = requireFiniteMetric(current.z - anchor.z, 'deltaZmm');
  const planLengthMm = requireFiniteMetric(
    Math.hypot(deltaXmm, deltaYmm),
    'planLengthMm',
  );
  const lengthMm = requireFiniteMetric(
    Math.hypot(deltaXmm, deltaYmm, deltaZmm),
    'lengthMm',
  );

  if (lengthMm <= VECTOR_EPSILON_MM) {
    return {
      deltaXmm,
      deltaYmm,
      deltaZmm,
      planLengthMm,
      lengthMm,
      slopePercent: null,
      slopeKind: 'point',
    };
  }

  if (planLengthMm <= VECTOR_EPSILON_MM) {
    return {
      deltaXmm,
      deltaYmm,
      deltaZmm,
      planLengthMm,
      lengthMm,
      slopePercent: null,
      slopeKind: 'vertical',
    };
  }

  if (Math.abs(deltaZmm) <= VECTOR_EPSILON_MM) {
    return {
      deltaXmm,
      deltaYmm,
      deltaZmm,
      planLengthMm,
      lengthMm,
      slopePercent: 0,
      slopeKind: 'horizontal',
    };
  }

  const slopePercent = requireFiniteMetric(
    (deltaZmm / planLengthMm) * 100,
    'slopePercent',
  );
  return {
    deltaXmm,
    deltaYmm,
    deltaZmm,
    planLengthMm,
    lengthMm,
    slopePercent,
    slopeKind: 'sloped',
  };
}

export function buildSmartDraftingFeedback(
  input: SmartDraftingFeedbackInput,
): SmartDraftingFeedback {
  const metrics = measureSmartDraftingVector(input.anchor, input.current);
  const lengthText = formatDistanceMm(metrics.lengthMm);
  const deltaZText = formatSignedDistanceMm(metrics.deltaZmm);
  const slopeValue = formatSlopeValue(metrics);
  const slopeText = formatSlopeText(metrics);
  const metricsText = `L ${lengthText} · ΔZ ${deltaZText} · ${slopeText}`;
  const label = buildFeedbackLabel(input);
  const keyboardHint = buildKeyboardHint(input);

  return {
    metrics,
    lengthText,
    deltaZText,
    slopeText,
    metricsText,
    label,
    keyboardHint,
    nearCursor: {
      label,
      metrics: metricsText,
      hint: keyboardHint,
    },
    hudRows: [
      { key: 'length', label: 'Length', value: lengthText },
      { key: 'delta-z', label: 'ΔZ', value: deltaZText },
      { key: 'slope', label: 'Slope', value: slopeValue },
    ],
    ariaLabel: `${label}. ${metricsText}. ${keyboardHint}`,
  };
}
