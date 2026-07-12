import * as THREE from 'three';

export type SnapType =
  | 'equipment-port'
  | 'pipe-endpoint'
  | 'pipe-centreline'
  | 'pipe-node'
  | 'branch-inlet'
  | 'branch-outlet'
  | 'grid'
  | 'level'
  | 'wall-face'
  | 'wall-centreline'
  | 'ceiling-plane'
  | 'structural-axis'
  | 'midpoint'
  | 'parallel'
  | 'perpendicular'
  | 'collinear'
  | 'same-elevation'
  | 'same-x'
  | 'same-y'
  | 'same-z'
  | 'tangent'
  | 'valid-branch-insertion-point'
  | 'straight-zone-boundary'
  | (string & {});

export interface SnapConstraint {
  kind: string;
  [key: string]: unknown;
}

export interface SnapCandidate {
  id: string;
  type: SnapType;
  worldPoint: THREE.Vector3;
  /** Distance from the pointer to the projected candidate in CSS pixels. */
  screenDistancePx: number;
  /** Lower values win. Defaults are type-specific. */
  priority?: number;
  /** 0 = incompatible, 1 = fully compatible. Compatibility is weighted before distance. */
  compatibilityScore?: number;
  /** Optional tool/intent score. Lower is better. */
  intentScore?: number;
  constraint?: SnapConstraint;
  targetEntityId?: string;
  message: string;
  isValid: boolean;
  metadata?: Record<string, unknown>;
}

export interface SnapSettings {
  tolerancePx: number;
  /** The active target remains captured out to this distance. Must be >= tolerancePx. */
  breakAwayPx: number;
  /** Challenger must beat the active candidate by this score to switch before break-away. */
  switchScoreMargin: number;
  priorityWeight: number;
  compatibilityWeight: number;
  intentWeight: number;
  disabledTypes?: ReadonlySet<SnapType>;
}

export interface SnapResolution {
  point: THREE.Vector3;
  candidate: SnapCandidate | null;
  score: number;
  retainedByHysteresis: boolean;
}

const DEFAULT_TYPE_PRIORITY: Record<string, number> = {
  'equipment-port': 0,
  'branch-inlet': 1,
  'branch-outlet': 1,
  'pipe-endpoint': 2,
  'pipe-node': 3,
  'valid-branch-insertion-point': 4,
  midpoint: 5,
  tangent: 6,
  'pipe-centreline': 7,
  'straight-zone-boundary': 8,
  collinear: 9,
  perpendicular: 9,
  parallel: 9,
  'same-elevation': 10,
  'same-x': 10,
  'same-y': 10,
  'same-z': 10,
  'wall-face': 11,
  'wall-centreline': 11,
  'ceiling-plane': 11,
  'structural-axis': 11,
  level: 12,
  grid: 20,
};

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  tolerancePx: 14,
  breakAwayPx: 22,
  switchScoreMargin: 8,
  priorityWeight: 100,
  compatibilityWeight: 80,
  intentWeight: 20,
};

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function candidateScore(candidate: SnapCandidate, settings: SnapSettings): number {
  const priority = finiteOr(candidate.priority, DEFAULT_TYPE_PRIORITY[candidate.type] ?? 50);
  const compatibility = clamp01(finiteOr(candidate.compatibilityScore, 1));
  const intent = finiteOr(candidate.intentScore, 0);
  return (
    priority * settings.priorityWeight
    + (1 - compatibility) * settings.compatibilityWeight
    + intent * settings.intentWeight
    + candidate.screenDistancePx
  );
}

function deterministicCompare(
  left: { candidate: SnapCandidate; score: number },
  right: { candidate: SnapCandidate; score: number },
): number {
  return (
    left.score - right.score
    || left.candidate.screenDistancePx - right.candidate.screenDistancePx
    || left.candidate.id.localeCompare(right.candidate.id)
  );
}

/**
 * Central, renderer-independent snap arbitration. Candidate generation stays in
 * tool/domain adapters; ranking, screen tolerance and capture hysteresis live here.
 */
export class SnapManager {
  private activeId: string | null = null;

  get activeCandidateId(): string | null {
    return this.activeId;
  }

  reset(): void {
    this.activeId = null;
  }

  resolve(
    rawWorldPoint: THREE.Vector3,
    candidates: readonly SnapCandidate[],
    overrides: Partial<SnapSettings> = {},
  ): SnapResolution {
    const settings: SnapSettings = {
      ...DEFAULT_SNAP_SETTINGS,
      ...overrides,
      tolerancePx: Math.max(0, finiteOr(overrides.tolerancePx, DEFAULT_SNAP_SETTINGS.tolerancePx)),
      breakAwayPx: Math.max(
        Math.max(0, finiteOr(overrides.tolerancePx, DEFAULT_SNAP_SETTINGS.tolerancePx)),
        finiteOr(overrides.breakAwayPx, DEFAULT_SNAP_SETTINGS.breakAwayPx),
      ),
    };
    const usable = candidates.filter((candidate) => (
      candidate.isValid
      && Number.isFinite(candidate.screenDistancePx)
      && candidate.screenDistancePx >= 0
      && !settings.disabledTypes?.has(candidate.type)
      && candidate.worldPoint.toArray().every(Number.isFinite)
    ));
    const active = this.activeId
      ? usable.find((candidate) => candidate.id === this.activeId) ?? null
      : null;
    const ranked = usable
      .filter((candidate) => candidate.screenDistancePx <= settings.tolerancePx)
      .map((candidate) => ({ candidate, score: candidateScore(candidate, settings) }))
      .sort(deterministicCompare);
    const challenger = ranked[0] ?? null;

    if (active && active.screenDistancePx <= settings.breakAwayPx) {
      const activeScore = candidateScore(active, settings);
      const challengerWins = challenger
        && challenger.candidate.id !== active.id
        && challenger.score + settings.switchScoreMargin < activeScore;
      if (!challengerWins) {
        return {
          point: active.worldPoint.clone(),
          candidate: active,
          score: activeScore,
          retainedByHysteresis: true,
        };
      }
    }

    if (challenger) {
      this.activeId = challenger.candidate.id;
      return {
        point: challenger.candidate.worldPoint.clone(),
        candidate: challenger.candidate,
        score: challenger.score,
        retainedByHysteresis: false,
      };
    }

    this.activeId = null;
    return {
      point: rawWorldPoint.clone(),
      candidate: null,
      score: Number.POSITIVE_INFINITY,
      retainedByHysteresis: false,
    };
  }
}

export function rankSnapCandidates(
  candidates: readonly SnapCandidate[],
  overrides: Partial<SnapSettings> = {},
): SnapCandidate[] {
  const settings = { ...DEFAULT_SNAP_SETTINGS, ...overrides };
  return candidates
    .filter((candidate) => candidate.isValid && Number.isFinite(candidate.screenDistancePx))
    .map((candidate) => ({ candidate, score: candidateScore(candidate, settings) }))
    .sort(deterministicCompare)
    .map(({ candidate }) => candidate);
}

