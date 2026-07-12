/**
 * VRF piping board — data model (world units = mm, floating point).
 *
 * Core rule: a paired run stores ONE spine; gas + liquid are DERIVED by offsetting
 * ±gap/2. Connections are TOPOLOGICAL — a pipe references a kit port by id, never
 * by "coordinates that happen to coincide".
 */

/** A point in WORLD units (mm). Pixels are a rendering detail only. */
export interface Point {
  x: number;
  y: number;
}

/** Which line(s) a run carries. A 'paired' run holds both on one spine. */
export type LineType = 'gas' | 'liquid' | 'paired';

/** Port line type — a port carries exactly one line. */
export type PortType = 'gas' | 'liquid';

/** Port role on a REFNET-style branch kit. */
export type PortRole = 'in' | 'out_main' | 'out_branch';

/**
 * A pipe size (per run for now; per-segment sizing arrives with branching).
 * `minBendRadiusMm` is a function of the OUTER diameter — the inner line of a
 * paired bend (r − gap/2) must still clear this.
 */
export interface PipeSize {
  /** Nominal label, e.g. '9.52' (3/8"). */
  label: string;
  gasOuterMm: number;
  liquidOuterMm: number;
  minBendRadiusMm: number;
}

/**
 * A paired refrigerant run. Geometry is fully described by `spine` + params;
 * the gas/liquid outlines are pure derivations (see geometry/ in later phases).
 */
export interface PipeRun {
  id: string;
  /** The shared centerline, world mm. */
  spine: Point[];
  lineType: LineType;
  size: PipeSize;
  /** Corner fillet radius, mm (to the SPINE). */
  bendRadiusMm: number;
}

/** A kit's placement: position (mm) + rotation (rad) + optional mirror. */
export interface KitTransform {
  pos: Point;
  rotation: number;
  mirror: boolean;
}

/**
 * A branch-kit port. `localPos`/`localDir` are the source of truth in the kit's
 * own frame; the WORLD position/direction are derived through the kit transform
 * ({@link portWorld}) so that moving the kit moves every port for free (invariant F).
 */
export interface Port {
  id: string;
  type: PortType;
  role: PortRole;
  /** Port position in the kit-local frame (mm). */
  localPos: Point;
  /** Outward unit direction in the kit-local frame. */
  localDir: Point;
}

/** A REFNET-style copper branch kit: a component with typed ports. */
export interface BranchKit {
  id: string;
  kind: string;
  transform: KitTransform;
  ports: Port[];
}

/** A topological link: one END of a pipe spine is bound to one kit PORT. */
export interface Connection {
  pipeId: string;
  /** Which spine endpoint is bound. */
  pipeEnd: 'start' | 'end';
  kitId: string;
  portId: string;
}

/** The undoable document: geometry + topology + selection. */
export interface BoardDoc {
  runs: Record<string, PipeRun>;
  kits: Record<string, BranchKit>;
  connections: Connection[];
  selection: string[];
}

export type Tool = 'select' | 'pipe' | 'branch-kit';
export type LineFilter = 'gas' | 'liquid' | 'both';

export const emptyDoc = (): BoardDoc => ({
  runs: {},
  kits: {},
  connections: [],
  selection: [],
});

/** A minimal size table; expand as sizing rules land. */
export const PIPE_SIZES: PipeSize[] = [
  { label: '6.35', gasOuterMm: 12.7, liquidOuterMm: 9.5, minBendRadiusMm: 40 },
  { label: '9.52', gasOuterMm: 15.9, liquidOuterMm: 12.7, minBendRadiusMm: 60 },
  { label: '12.7', gasOuterMm: 22.2, liquidOuterMm: 15.9, minBendRadiusMm: 90 },
  { label: '15.88', gasOuterMm: 28.6, liquidOuterMm: 19.1, minBendRadiusMm: 120 },
];
