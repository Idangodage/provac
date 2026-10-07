/**
 * Duct run → fabrication plan: every piece (flexible connector, take-off
 * collar, damper, straight sections, elbows, transitions, split fitting, end
 * cap), every joint with its hardware, the section construction (sheet, class,
 * joint member) and the issues. Pure and deterministic; the 2D overlay, 3D
 * builder, BOM and validation all read the same plan, so what is drawn is what
 * is scheduled.
 *
 * Legs are level or vertical (risers and drops). A vertical leg's elbows bend
 * the easy way in the vertical plane through the riser (in-plane size H), and
 * a short rise or drop between parallel legs becomes one offset. A leg that
 * both runs and climbs, or a plan turn at a riser (a hard-way bend), is
 * refused. Branch runs (taps, split branches) are planned from their own
 * record plus their parent; a parent reads its branches for tap windows and
 * its split outlets.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { findAirPort, type DuctAirPort } from './ductAirPorts';
import {
  splitFitting,
  splitOutlet,
  tapAttachment,
  type RoundMainCylinder,
  type SplitFittingGeometry,
  type TapAttachment,
} from './ductBranches';
import { getActiveDuctBuilding, type DuctBuilding } from './ductBuilding';
import { galvanisedSheetMassKgPerM2 } from './ductCatalog';
import {
  ELBOW_RULES,
  rectangularDamperLayout,
  roundDamperLayout,
  seamAllowanceMm,
  seamsPerSection,
  resolveVaneType,
  vaneCountOnDiagonal,
  vaneSectionsFor,
  type DuctDamperLayout,
  type DuctVaneSpec,
} from './ductFittingRules';
import { FLEX_RULES, flexCurve } from './ductFlex';
import { resolveSectionConstruction, runSectionSheetMm, type SectionConstruction } from './ductGauge';
import {
  TURN_EPSILON_DEG,
  add,
  dot,
  ductLegs,
  frameToPlan,
  radiusElbowGeometry,
  scale,
  squareElbowGeometry,
  turnAngleDeg,
  vertexCentreZ,
  type DuctLegGeometry,
  type DuctVerticalFrame,
  type ElbowPlanGeometry,
} from './ductGeometry';
import { ductInsulationThicknessMm, insulationTakeoff, type DuctInsulationTakeoff } from './ductInsulation';
import { jointHardware, roundTakeoffHardware, slipOverHardware, takeoffHardware, type JointHardware } from './ductJoints';
import { ductBranchesOf, ductParentOf, type DuctBranchRef } from './ductNetwork';
import { jogOffset, tightestOgee, type DuctOffsetGeometry } from './ductOffsets';
import {
  PENETRATION_JOINT_MARGIN_MM,
  PENETRATION_MAX_ANGLE_DEG,
  ductWallCrossings,
  penetrationHasFireDamper,
  sleeveOpeningMm,
  type DuctPenetration,
  type DuctWallCrossing,
} from './ductPenetrations';
import { checkSpigotFit, plenumGeometry, spigotAttachment } from './ductPlenum';
import { maxRoundBranchMm, roundReducerMinLengthMm, wyeLegLengthMm, ROUND_FITTING_RULES } from './ductRoundFittings';
import { goredElbowPieces, SMACNA_TABLE_3_1 } from './ductRoundRules';
import type { DuctDesignSettings } from './ductSettings';
import { squareToRoundAreaMm2 } from './ductSquareToRound';
import { findTerminalPort } from './ductTerminals';
import {
  isRoundLeg,
  isRoundMainTapStyle,
  isRoundTapStyle,
  readDuctRunSpec,
  roundLeg,
  type DuctInlineAccessory,
  type DuctLeg,
  type DuctPoint3,
  type DuctRunSpec,
  type DuctTapStyle,
} from './ductTypes';

export type DuctIssueCode =
  | 'DU_PRESSURE_UNSUPPORTED'
  | 'DU_SIZE_OVER_TABLE'
  | 'DU_NO_STOCK'
  | 'DU_GAUGE_JOINT'
  | 'DU_LEG_TOO_SHORT'
  | 'DU_MOUTH_APPROX'
  | 'DU_STALE'
  | 'DU_INTERMEDIATE_REINF'
  | 'DU_CROSS_BREAK'
  | 'DU_TRANSITION_ANGLE'
  | 'DU_TAP_TOO_BIG'
  | 'DU_TAP_CLASH'
  | 'DU_SPLIT_INCOMPLETE'
  | 'DU_SPLIT_SIZE'
  | 'DU_BRANCH_DIRECTION'
  | 'DU_ELBOW_RADIUS'
  | 'DU_VANE_SPAN'
  | 'DU_ASPECT_RATIO'
  | 'DU_GAUGE_OVERRIDE'
  | 'DU_SLOPED_LEG'
  | 'DU_HARD_WAY_ELBOW'
  | 'DU_TURN_BACK'
  | 'DU_SUPPORT_RULE'
  | 'DU_SUPPORT_LOAD'
  | 'DU_SOFFIT'
  | 'DU_CLASH'
  | 'DU_SPIGOT_CLASH'
  | 'DU_PLENUM_SIZE'
  | 'DU_FLEX_LENGTH'
  | 'DU_FLEX_BEND'
  | 'DU_FLEX_SIZE'
  | 'DU_FLEX_DROP'
  | 'DU_TERMINAL_SIZE'
  | 'DU_TERMINAL_ALIGN'
  | 'DU_OPEN_END'
  | 'DU_PENETRATION_FLEX'
  | 'DU_PENETRATION_FITTING'
  | 'DU_PENETRATION_JOINT'
  | 'DU_PENETRATION_ANGLE'
  | 'DU_PENETRATION_EXTERIOR'
  | 'DU_INLINE_CLASH';

export interface DuctIssue {
  code: DuctIssueCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  legIndex?: number;
  nodeIndex?: number;
  point?: Point2D;
  /** A wall penetration's issue: its key on the run (`${wallId}:${n}`). */
  penetrationKey?: string;
}

/** 'fire-damper': a curtain fire damper in its sleeve, centred in a wall the run passes through (bought in, not fabricated). */
export type DuctPieceKind =
  | 'connector' | 'takeoff' | 'damper' | 'straight' | 'elbow' | 'offset' | 'transition' | 'split' | 'plenum' | 'flex' | 'end-cap' | 'fire-damper'
  | 'access-door' | 'attenuator';

/** A flexible runout to an air terminal (SMACNA §3.5–3.7): its 3D centreline and what it serves. */
export interface DuctFlexPiece {
  /** Centreline samples (z = centre) and their arc lengths. */
  points: DuctPoint3[];
  stations: number[];
  minBendRadiusMm: number;
  terminalId: string;
  /** SMACNA Fig. 3-7 form; NM-IL = non-metallic, insulated. */
  type: DuctDesignSettings['flexType'];
  /** Insulation on an insulated form (mm). */
  jacketMm: number;
}

/** A plenum box ending the run, and the spigots on its faces (their branches' collars). */
export interface DuctPlenumPiece {
  widthMm: number;
  heightMm: number;
  lengthMm: number;
  spigots: Array<{ branchId: string; face: 'left' | 'right' | 'end'; point: Point2D; direction: Point2D; centreZ: number; openingMm: number }>;
  /** The duct entering the back face (outside). */
  inletWidthMm: number;
  inletHeightMm: number;
}

export interface DuctElbowVanes {
  spec: DuctVaneSpec;
  /** Vane length = the duct height the vanes span (mm). */
  lengthMm: number;
  /** Vane sections over the height (Fig. 2-4); sections − 1 intermediate runners. */
  sections: number;
}

export interface DuctElbow extends ElbowPlanGeometry {
  /** Rectangular: radius (RE1) or square with vanes (RE2); round: gored (SMACNA Table 3-1). */
  style: 'radius' | 'square-vaned' | 'gored';
  vaneCount: number;
  vanes?: DuctElbowVanes;
  /** Gored elbow: number of pieces (Table 3-1). */
  gores?: number;
  /**
   * 'vertical': the elbow at a riser, bending the easy way in the riser's
   * vertical plane; its geometry (corner, arc, ends) is in `frame`'s local
   * (s, t) = (along the heading, elevation). Absent = a plan elbow.
   */
  plane?: 'plan' | 'vertical';
  frame?: DuctVerticalFrame;
  /** Section size in the plane of the bend (W for a plan elbow, H for a vertical one). */
  inPlaneMm?: number;
  /** A neck lengthened to take up a leg remainder too short to be a section (practice). */
  extraNeckInMm?: number;
  extraNeckOutMm?: number;
}

export interface DuctTransitionInfo {
  neckMm: number;
  slopeMm: number;
  /** Per-side angle of the side walls (plan) and of the top (flat bottom). */
  angleWidthDeg: number;
  angleHeightDeg: number;
  /** Judged in the flow direction. */
  widthSense: 'expanding' | 'contracting' | 'none';
  heightSense: 'expanding' | 'contracting' | 'none';
  compressed: boolean;
}

export interface DuctTakeoffInfo {
  style: DuctTapStyle;
  leadInMm: number;
  /** Round collars: the opening diameter at the parent wall (the cone mouth for a conical tap). */
  openingMm?: number;
  /** Parent leg direction (the lead-in points toward its start, −d). */
  parentDirection: Point2D;
  /** Off a round main: the main's cylinder, which the collar is cut to (its saddle). */
  roundMain?: RoundMainCylinder;
}

export interface DuctPiece {
  mark: string;
  kind: DuctPieceKind;
  legIndex: number;
  nodeIndex?: number;
  /** Plan centreline ends (an elbow's ends are its neck ends). */
  start: Point2D;
  end: Point2D;
  /** Straight pieces: leg direction; elbow: incoming direction. */
  direction: Point2D;
  stationStartMm: number;
  stationEndMm: number;
  /** Developed centreline length (elbow: arc or square path + necks). */
  lengthMm: number;
  /** Clear inside section at the start of the piece. */
  widthMm: number;
  heightMm: number;
  /** Clear section at the end (differs only on a transition). */
  endWidthMm: number;
  endHeightMm: number;
  /** Round pieces: diameter at the start and the end. */
  diameterMm?: number;
  endDiameterMm?: number;
  /**
   * Clear bottom of a level piece (flat bottom). A vertical piece or a
   * vertical-plane fitting: the lowest level it reaches.
   */
  bottomZ: number;
  /** Centreline elevation at the start and at the end (they differ on risers and vertical fittings). */
  centreZ: number;
  endCentreZ: number;
  /** The piece's axis at its start is vertical: +1 up, −1 down (riser and drop pieces, a riser's top elbow). */
  vertical?: 1 | -1;
  /** Vertical-plane fittings (elbows, offsets at a riser): the plane their local geometry is in. */
  frame?: DuctVerticalFrame;
  elbow?: DuctElbow;
  /** Offset (SMACNA Fig. 2-7): spans node `nodeIndex` to the next node. */
  offset?: DuctOffsetGeometry;
  transition?: DuctTransitionInfo;
  takeoff?: DuctTakeoffInfo;
  split?: SplitFittingGeometry;
  plenum?: DuctPlenumPiece;
  flex?: DuctFlexPiece;
  isMakeUp?: boolean;
  /** Longitudinal seam length in this piece (mm): seams × developed length. */
  seamLengthMm: number;
  /** Connector: GI edge on each side of the fabric (mm). */
  connectorMetalMm?: number;
  /** Damper: blade layout per SMACNA Fig. 2-12/2-13. */
  damper?: DuctDamperLayout;
  /** Fire damper: the wall penetration it sits in (its key on the run). */
  penetrationKey?: string;
  /** An accessory set into the leg's straight: its id in the spec's `inline` list. */
  inlineId?: string;
  /** Access door: the door (square, mm) and the face it is in. */
  accessDoor?: { sizeMm: number; face: 'side' | 'bottom' };
  /** Sound attenuator: its casing proud of the duct each side (mm), and its make by the duct's shape. */
  attenuator?: { casingMm: number; type: 'splitter' | 'podded' };
  sheetThicknessMm: number | null;
  sheetAreaM2: number;
  fabricAreaM2: number;
  massKg: number;
}

export type DuctJointKind = 'flange' | 'unit-connection' | 'tap-connection' | 'flex-connection' | 'terminal-connection' | 'end-cap';

export interface DuctJoint {
  id: string;
  kind: DuctJointKind;
  stationMm: number;
  point: Point2D;
  /** Plan direction (a joint on a riser: the riser's heading, which its H runs along). */
  direction: Point2D;
  centreZ: number;
  /** A joint on a riser or drop: its flange lies flat. */
  vertical?: 1 | -1;
  widthMm: number;
  heightMm: number;
  outerWidthMm: number;
  outerHeightMm: number;
  between: [string | null, string | null];
  /** Null when the section construction could not be resolved. */
  hardware: JointHardware | null;
}

export interface DuctFabricationPlan {
  elementId: string;
  spec: DuctRunSpec;
  status: 'ok' | 'error';
  /** Construction per leg (index = leg). */
  constructionByLeg: SectionConstruction[];
  startPort: DuctAirPort | null;
  /** Where a take-off branch leaves its parent (branch runs only). */
  tap: TapAttachment | null;
  pieces: DuctPiece[];
  joints: DuctJoint[];
  issues: DuctIssue[];
  /** Where the run passes through walls: each sleeve, and its fire damper where it has one (derived from the walls). */
  penetrations: DuctPenetration[];
  polylineLengthMm: number;
  totals: { sheetAreaM2: number; fabricAreaM2: number; massKg: number };
  /** Rules this plan used whose values are not verified against their source. */
  unverifiedRules: string[];
  /** Project-practice values this plan used (SMACNA gives no number for them). */
  practiceRules: string[];
  /** Longitudinal seam type of the straights and fittings (SMACNA Fig. 1-5). */
  seamType: DuctDesignSettings['longitudinalSeam'];
  /** Round sections: spiral or longitudinal seam (SMACNA Fig. 3-1). */
  seamRound: DuctDesignSettings['roundSeam'];
  /** External insulation carried (mm; 0 = bare) and its takeoff. */
  insulationMm: number;
  insulation: DuctInsulationTakeoff | null;
}

/** Sheet consumed by one roll-formed TDC flange, per duct end. Practice. */
const TDC_FLANGE_ROLL_MM = 35;
const STATION_EPSILON_MM = 0.5;

/** Values SMACNA gives no number for; the plan lists the ones it used. */
const PRACTICE = {
  allowances: 'Seam and flange sheet allowances',
  elbowNeck: 'Elbow neck length for the flange',
  slipOver: 'Screws at the unit collar (S1.40 spacing by analogy)',
  transitionTaper: 'Transition design taper (within the Fig. 2-7 limits)',
  takeoff: 'Take-off collar length, damper section length and tap-window margin',
  plenum: 'Plenum construction from the rectangular duct tables; spigot edge margin 50 mm',
  flex: 'Flexible runout: 100 mm straight lead off each collar, maximum length, jacket thickness',
  neckStretch: 'A leg remainder shorter than the minimum make-up piece is taken up in the elbow neck',
  insulation: 'NBR thickness by service, flange bands, tape and waste',
  split: 'Split neck and tee depth (types per Fig. 2-5)',
  roundTap: 'Round-main tap stub and lateral collar lengths (Fig. 3-4 leaves them undimensioned)',
  wye: 'Wye leg 3A/2 read as the centreline length to the outlet',
  penetration: 'Wall penetrations: a plain straight through the wall, joints 50 mm clear of its faces, the sleeve clearance',
  fireDamper: 'Fire damper sleeve 1.2 mm, its mass × 1.5 for the frame, curtain and retaining angles; breakaway joints at the sleeve ends',
  inline: 'Inline accessories: access door 450/300/200 mm square with 50 mm of face each side, its section 100 mm longer; attenuator casing 50 mm proud, its mass a 1 mm casing × 2.5 for the infill and splitters',
} as const;

/** A sound attenuator's casing beyond the duct, each side (mm), practice. */
export const ATTENUATOR_CASING_MM = 50;
const ATTENUATOR_CASING_SHEET_MM = 1;
const ATTENUATOR_MASS_FACTOR = 2.5;

/**
 * An access door for a section (SMACNA Fig. 7-2 practice): 450 mm square where
 * the duct's wider face takes it with 50 mm each side, else 300, else 200,
 * else what fits; a flat duct's in its bottom (reached from the ceiling below),
 * a tall or round one's in its side.
 */
export function accessDoorFor(section: DuctLeg, doorMm?: number): { sizeMm: number; face: 'side' | 'bottom' } {
  const round = isRoundLeg(section);
  const face = round ? section.diameterMm! * 0.7 : Math.max(section.widthMm, section.heightMm);
  const size = doorMm ?? [450, 300, 200].find((candidate) => face >= candidate + 100) ?? Math.max(100, Math.floor((face - 50) / 50) * 50);
  return { sizeMm: size, face: !round && section.widthMm >= section.heightMm ? 'bottom' : 'side' };
}

/** The length an inline accessory takes of its leg (mm). */
export function inlineAccessoryLengthMm(
  item: Pick<DuctInlineAccessory, 'kind'> & { lengthMm?: number | undefined; doorMm?: number | undefined },
  section: DuctLeg,
  settings: Pick<DuctDesignSettings, 'vcdLengthMm'>,
): number {
  if (item.kind === 'damper') return settings.vcdLengthMm;
  if (item.kind === 'access-door') return accessDoorFor(section, item.doorMm).sizeMm + 100;
  return item.lengthMm ?? 900;
}

const INLINE_NAMES: Record<DuctInlineAccessory['kind'], string> = { damper: 'volume damper', 'access-door': 'access door', attenuator: 'sound attenuator' };

/** A fire damper's sleeve sheet and the allowance for its frame, curtain and retaining angles (mass factor), practice. */
const FIRE_DAMPER_SLEEVE_MM = 1.2;
const FIRE_DAMPER_MASS_FACTOR = 1.5;

/** The clear section at a piece's start or end, round pieces keeping their diameter. */
function pieceSection(piece: DuctPiece, at: 'start' | 'end'): DuctLeg {
  const diameter = at === 'start' ? piece.diameterMm : piece.endDiameterMm ?? piece.diameterMm;
  if (diameter !== undefined) return { widthMm: diameter, heightMm: diameter, diameterMm: diameter };
  return at === 'start' ? { widthMm: piece.widthMm, heightMm: piece.heightMm } : { widthMm: piece.endWidthMm, heightMm: piece.endHeightMm };
}

function sameSection(a: DuctLeg, b: DuctLeg): boolean {
  return Math.abs(a.widthMm - b.widthMm) < 0.5 && Math.abs(a.heightMm - b.heightMm) < 0.5 && isRoundLeg(a) === isRoundLeg(b);
}

function outer(section: DuctLeg, thicknessMm: number | null): { w: number; h: number } {
  const t = thicknessMm ?? 1;
  return { w: section.widthMm + 2 * t, h: section.heightMm + 2 * t };
}

/** Seams of a piece (straights by the coil rule; fittings are made of four panels). */
interface SeamSpec {
  count: number;
  allowanceMm: number;
}

/** Outside girth: π·D for a round section, 2(W + H) otherwise. */
function girthOf(section: DuctLeg, thicknessMm: number | null): number {
  const o = outer(section, thicknessMm);
  return isRoundLeg(section) ? Math.PI * o.w : 2 * (o.w + o.h);
}

function straightAreaM2(section: DuctLeg, thicknessMm: number | null, lengthMm: number, flangeRollEnds: number, seams: SeamSpec): number {
  const girth = girthOf(section, thicknessMm) + seams.count * seams.allowanceMm;
  return (girth * (lengthMm + flangeRollEnds * TDC_FLANGE_ROLL_MM)) / 1e6;
}

function elbowAreaM2(elbow: DuctElbow, section: DuctLeg, thicknessMm: number | null, flangeRollEnds: number): number {
  const o = outer(section, thicknessMm);
  const neck = elbow.neckMm;
  const girth = girthOf(section, thicknessMm);
  let body: number;
  if (elbow.style === 'gored') {
    body = girth * elbow.centrelineRadiusMm * ((elbow.angleDeg * Math.PI) / 180);
  } else if (elbow.style === 'radius') {
    const theta = (elbow.angleDeg * Math.PI) / 180;
    const ro = elbow.centrelineRadiusMm + o.w / 2;
    const ri = Math.max(0, elbow.centrelineRadiusMm - o.w / 2);
    const cheeks = 2 * 0.5 * theta * (ro * ro - ri * ri);
    body = cheeks + o.h * (ro + ri) * theta;
  } else {
    const cheek = o.w * o.w;
    body = 2 * cheek + o.h * 2 * o.w;
  }
  const necks = (2 * neck + (elbow.extraNeckInMm ?? 0) + (elbow.extraNeckOutMm ?? 0)) * girth;
  return (body + necks + flangeRollEnds * TDC_FLANGE_ROLL_MM * girth) / 1e6;
}

/** A transition between a rectangular and a round section (either way). */
export function isShapeChange(from: DuctLeg, to: DuctLeg): boolean {
  return isRoundLeg(from) !== isRoundLeg(to);
}

function transitionAreaM2(from: DuctLeg, to: DuctLeg, thicknessMm: number | null, neckMm: number, slopeMm: number, flangeRollEnds: number, seams: SeamSpec): number {
  const a = outer(from, thicknessMm);
  const b = outer(to, thicknessMm);
  const girthA = girthOf(from, thicknessMm);
  const girthB = girthOf(to, thicknessMm);
  const slant = Math.hypot(slopeMm, Math.max(Math.abs(b.w - a.w) / 2, Math.abs(b.h - a.h)));
  let lofted = ((girthA + girthB) / 2) * slant;
  if (isShapeChange(from, to)) {
    // Square-to-round: its development (4 triangles + 4 cone quarters), flat bottom shared.
    const rect = isRoundLeg(from) ? b : a;
    const diameter = isRoundLeg(from) ? a.w : b.w;
    lofted = squareToRoundAreaMm2({
      rectHalfWidthMm: rect.w / 2, rectHalfHeightMm: rect.h / 2, rectCentreUpMm: rect.h / 2,
      radiusMm: diameter / 2, circleCentreUpMm: diameter / 2, lengthMm: slopeMm, rectAtStart: !isRoundLeg(from),
    });
  }
  const body = lofted + neckMm * (girthA + girthB);
  return (body + seams.count * seams.allowanceMm * (slant + 2 * neckMm) + flangeRollEnds * TDC_FLANGE_ROLL_MM * (girthA + girthB) / 2) / 1e6;
}

function pieceLength(elbow: DuctElbow): number {
  const bend = elbow.style === 'square-vaned'
    ? 2 * elbow.setbackMm
    : (elbow.centrelineRadiusMm * elbow.angleDeg * Math.PI) / 180;
  return bend + 2 * elbow.neckMm + (elbow.extraNeckInMm ?? 0) + (elbow.extraNeckOutMm ?? 0);
}

/** The elbow with its start (or end) neck lengthened by `extraMm` along the leg. */
function stretchElbowNeck(elbow: DuctElbow, at: 'start' | 'end', extraMm: number): DuctElbow {
  return at === 'start'
    ? { ...elbow, startPoint: add(elbow.startPoint, scale(elbow.inDirection, -extraMm)), extraNeckInMm: (elbow.extraNeckInMm ?? 0) + extraMm }
    : { ...elbow, endPoint: add(elbow.endPoint, scale(elbow.outDirection, extraMm)), extraNeckOutMm: (elbow.extraNeckOutMm ?? 0) + extraMm };
}

interface NodeFitting {
  nodeIndex: number;
  elbow?: DuctElbow;
  /** An offset from this node to the next; the leg between is part of it. */
  offset?: DuctOffsetGeometry;
  /** A vertical offset's plane (its geometry is local to it). */
  frame?: DuctVerticalFrame;
  /** This node is the far end of the previous node's offset. */
  continuesOffset?: boolean;
  /** Polyline length the fitting takes from the leg before and the leg after the node. */
  consumeInMm: number;
  consumeOutMm: number;
}

const elbowFitting = (nodeIndex: number, elbow: DuctElbow): NodeFitting => ({
  nodeIndex, elbow, consumeInMm: elbow.setbackMm + elbow.neckMm, consumeOutMm: elbow.setbackMm + elbow.neckMm,
});

/** Turning vanes of a square elbow per SMACNA Fig. 2-3 / 2-4: on the diagonal runner, spanning the height. */
export function elbowVanes(section: DuctLeg, vaneType: DuctDesignSettings['vaneType']): DuctElbowVanes & { count: number } {
  const spec = resolveVaneType(vaneType, section.heightMm);
  return { spec, lengthMm: section.heightMm, sections: vaneSectionsFor(section.heightMm, spec), count: vaneCountOnDiagonal(section.widthMm, spec) };
}

/**
 * The bend at an interior node: a plan turn between level legs, or an
 * easy-way bend in a riser's vertical plane. `bendSection` is the section as
 * the bend sees it (width = the size in the bend's plane). Null when the run
 * goes straight on, or the bend is refused (reported into `issues`).
 */
interface NodeBend {
  plane: 'plan' | 'vertical';
  angleDeg: number;
  frame: DuctVerticalFrame | null;
  corner: Point2D;
  inDirection: Point2D;
  outDirection: Point2D;
  bendSection: DuctLeg;
}

/** The sharpest plan turn one elbow makes (practice: SMACNA RE1 leaves θ open; a U-turn is two elbows). */
const MAX_PLAN_TURN_DEG = 150;

function nodeBend(spec: DuctRunSpec, legs: DuctLegGeometry[], node: number, issues?: DuctIssue[]): NodeBend | null {
  const incoming = legs[node - 1];
  const outgoing = legs[node];
  const section = spec.legs[node - 1];
  if (!incoming || !outgoing || !section) return null;
  if (!incoming.vertical && !outgoing.vertical) {
    const angleDeg = turnAngleDeg(incoming.direction, outgoing.direction);
    if (angleDeg < TURN_EPSILON_DEG) return null;
    // Past this one elbow would need a setback of R·tan(θ/2) → ∞: the run doubles back on itself.
    if (angleDeg > MAX_PLAN_TURN_DEG) {
      issues?.push({ code: 'DU_TURN_BACK', severity: 'error', nodeIndex: node, point: spec.path[node],
        message: `The run turns back on itself here (${Math.round(angleDeg)}°): one elbow turns at most ${MAX_PLAN_TURN_DEG}°. Add a leg between two turns.` });
      return null;
    }
    return { plane: 'plan', angleDeg, frame: null, corner: spec.path[node]!, inDirection: incoming.direction, outDirection: outgoing.direction, bendSection: section };
  }
  if (incoming.vertical && outgoing.vertical) {
    if (incoming.vertical !== outgoing.vertical) {
      issues?.push({ code: 'DU_SLOPED_LEG', severity: 'error', nodeIndex: node, point: spec.path[node],
        message: 'A riser cannot turn back on itself; end the rise with a level leg.' });
    }
    return null;
  }
  // A level leg meets a riser: the bend lies in the riser's vertical plane, which contains its heading.
  const riser = incoming.vertical ? incoming : outgoing;
  const level = incoming.vertical ? outgoing : incoming;
  const along = dot(level.direction, riser.direction);
  if (Math.abs(along) < Math.cos(Math.PI / 180)) {
    issues?.push({ code: 'DU_HARD_WAY_ELBOW', severity: 'error', nodeIndex: node, point: spec.path[node],
      message: 'The run turns in plan at a riser, so this elbow would bend the hard way. Turn on a level leg before or after the riser.' });
    return null;
  }
  const levelLocal = { x: Math.sign(along), y: 0 };
  const riserLocal = { x: 0, y: riser.vertical };
  return {
    plane: 'vertical',
    angleDeg: 90,
    frame: { origin: { x: spec.path[node]!.x, y: spec.path[node]!.y }, heading: riser.direction },
    corner: { x: 0, y: vertexCentreZ(spec, node) },
    inDirection: incoming.vertical ? riserLocal : levelLocal,
    outDirection: incoming.vertical ? levelLocal : riserLocal,
    // Easy way: W stays horizontal across the plane, so H is the in-plane size.
    bendSection: isRoundLeg(section) ? section : { widthMm: section.heightMm, heightMm: section.widthMm },
  };
}

function buildElbow(
  style: 'radius' | 'square-vaned',
  bend: NodeBend,
  ratio: number,
  settings: DuctDesignSettings,
  vaneType: DuctDesignSettings['vaneType'] = settings.vaneType,
): DuctElbow {
  const inPlane = bend.bendSection.widthMm;
  const geometry = style === 'radius'
    ? radiusElbowGeometry(bend.corner, bend.inDirection, bend.outDirection, ratio * inPlane, settings.elbowNeckMm)
    : squareElbowGeometry(bend.corner, bend.inDirection, bend.outDirection, inPlane, settings.elbowNeckMm);
  const placed = { plane: bend.plane, ...(bend.frame ? { frame: bend.frame } : {}), inPlaneMm: inPlane };
  if (style !== 'square-vaned') return { ...geometry, style, vaneCount: 0, ...placed };
  const { count, ...vanes } = elbowVanes(bend.bendSection, vaneType);
  return { ...geometry, style, vaneCount: count, vanes, ...placed };
}

/**
 * Choose each elbow's style so its setbacks fit the legs where possible (auto).
 * `legStartReserveMm[i]` is what leg i already carries after its start node
 * (connector, take-off, damper, transition).
 */
function planFittings(spec: DuctRunSpec, legs: DuctLegGeometry[], legStartReserveMm: number[], settings: DuctDesignSettings, issues: DuctIssue[]): Map<number, NodeFitting> {
  const fittings = new Map<number, NodeFitting>();
  const radiusConsume = (node: number): number => {
    const bend = nodeBend(spec, legs, node);
    if (!bend) return 0;
    const leg = spec.legs[node - 1]!;
    const ratio = spec.nodeOverrides[String(node)]?.centrelineRatio
      ?? (isRoundLeg(leg) ? SMACNA_TABLE_3_1[settings.roundVelocityBand].ratio : settings.elbowCentrelineRatio);
    const radius = ratio * bend.bendSection.widthMm;
    return radius * Math.tan((bend.angleDeg * Math.PI) / 360) + settings.elbowNeckMm;
  };
  for (let node = 1; node < spec.path.length - 1; node += 1) {
    const incoming = legs[node - 1]!;
    const outgoing = legs[node]!;
    const bend = nodeBend(spec, legs, node, issues);
    if (!bend) continue;
    const angle = bend.angleDeg;
    const section = spec.legs[node - 1]!;
    if (isRoundLeg(section)) {
      // Round: a gored elbow, R/D and pieces from SMACNA Table 3-1 by the velocity band.
      const roundRatio = spec.nodeOverrides[String(node)]?.centrelineRatio ?? SMACNA_TABLE_3_1[settings.roundVelocityBand].ratio;
      const geometry = radiusElbowGeometry(bend.corner, bend.inDirection, bend.outDirection, roundRatio * section.widthMm, settings.elbowNeckMm);
      fittings.set(node, elbowFitting(node, {
        ...geometry, style: 'gored', vaneCount: 0, gores: goredElbowPieces(settings.roundVelocityBand, angle),
        plane: bend.plane, ...(bend.frame ? { frame: bend.frame } : {}), inPlaneMm: section.widthMm,
      }));
      continue;
    }
    const ratio = spec.nodeOverrides[String(node)]?.centrelineRatio ?? settings.elbowCentrelineRatio;
    const requested = spec.nodeOverrides[String(node)]?.elbowStyle ?? settings.elbowStyle;
    const squareAllowed = Math.abs(angle - 90) < TURN_EPSILON_DEG;
    const before = (legStartReserveMm[node - 1] ?? 0) + (node >= 2 ? (fittings.get(node - 1)?.consumeOutMm ?? 0) : 0);
    const after = (legStartReserveMm[node] ?? 0) + (node + 1 < spec.path.length - 1 ? radiusConsume(node + 1) : 0);
    const vaneType = spec.nodeOverrides[String(node)]?.vaneType ?? settings.vaneType;
    const radius = buildElbow('radius', bend, ratio, settings);
    const radiusConsumeMm = radius.setbackMm + radius.neckMm;
    const radiusFits = incoming.lengthMm + STATION_EPSILON_MM >= before + radiusConsumeMm
      && outgoing.lengthMm + STATION_EPSILON_MM >= radiusConsumeMm + after;
    let style: 'radius' | 'square-vaned' = 'radius';
    if (requested === 'square-vaned' && squareAllowed) style = 'square-vaned';
    else if (requested === 'auto' && !radiusFits && squareAllowed) style = 'square-vaned';
    const elbow = style === 'radius' ? radius : buildElbow('square-vaned', bend, ratio, settings, vaneType);
    fittings.set(node, elbowFitting(node, elbow));
    const ratioName = bend.plane === 'vertical' ? 'R/H' : 'R/W';
    if (style === 'radius' && ratio < ELBOW_RULES.squareThroatRatio - 1e-9) {
      issues.push({ code: 'DU_ELBOW_RADIUS', severity: 'error', nodeIndex: node, point: spec.path[node],
        message: `${ratioName} ${ratio} is below ${ELBOW_RULES.squareThroatRatio}, the tightest radius SMACNA allows (Fig. 2-2).` });
    } else if (style === 'radius' && ratio < 1 - 1e-9) {
      issues.push({ code: 'DU_ELBOW_RADIUS', severity: 'warning', nodeIndex: node, point: spec.path[node],
        message: `${ratioName} ${ratio}: SMACNA allows a tight throat only up to ${ELBOW_RULES.squareThroatMaxVelocityMs} m/s (Fig. 2-2 RE1).` });
    }
    if (elbow.vanes && elbow.vanes.sections > 1) {
      issues.push({ code: 'DU_VANE_SPAN', severity: 'info', nodeIndex: node, point: spec.path[node],
        message: `Vanes ${Math.round(elbow.vanes.lengthMm)} mm long exceed the ${elbow.vanes.spec.maxUnsupportedMm} mm unsupported span: ${elbow.vanes.sections} sections with ${elbow.vanes.sections - 1} intermediate runner(s) (Fig. 2-4).` });
    }
    if (requested === 'square-vaned' && !squareAllowed) {
      issues.push({ code: 'DU_LEG_TOO_SHORT', severity: 'info', nodeIndex: node, point: spec.path[node],
        message: `A ${Math.round(angle)}° turn is made as a radius elbow; square vaned elbows are for 90° turns.` });
    }
  }
  mergeOffsets(spec, legs, legStartReserveMm, settings, fittings);
  return fittings;
}

/**
 * A jog between two parallel legs whose middle leg cannot hold two elbows is
 * made as one offset fitting (SMACNA Fig. 2-7): mitred up to 60°, an ogee
 * (throat ≥ 150 mm) beyond. The section must be the same through the jog. A
 * short rise or drop between level legs is the same fitting in the riser's
 * vertical plane (always an ogee: the jog is square).
 */
function mergeOffsets(
  spec: DuctRunSpec,
  legs: DuctLegGeometry[],
  legStartReserveMm: number[],
  settings: DuctDesignSettings,
  fittings: Map<number, NodeFitting>,
): void {
  for (let node = 1; node + 1 < spec.path.length - 1; node += 1) {
    const first = fittings.get(node);
    const second = fittings.get(node + 1);
    if (!first?.elbow || !second?.elbow) continue;
    const incoming = legs[node - 1]!;
    const middle = legs[node]!;
    const outgoing = legs[node + 1]!;
    if (incoming.vertical || outgoing.vertical) continue;
    if (dot(incoming.direction, outgoing.direction) < 0.999) continue;
    const frame = first.elbow.frame ?? null;
    if ((first.elbow.plane ?? 'plan') !== (second.elbow.plane ?? 'plan')) continue;
    if (!sameSection(spec.legs[node - 1]!, spec.legs[node]!) || !sameSection(spec.legs[node]!, spec.legs[node + 1]!)) continue;
    if ((legStartReserveMm[node] ?? 0) > STATION_EPSILON_MM) continue;
    if (middle.lengthMm + STATION_EPSILON_MM >= first.consumeOutMm + second.consumeInMm) continue;
    const width = first.elbow.inPlaneMm ?? spec.legs[node]!.widthMm;
    const before = (legStartReserveMm[node - 1] ?? 0) + (node >= 2 ? (fittings.get(node - 1)?.consumeOutMm ?? 0) : 0);
    const after = (legStartReserveMm[node + 1] ?? 0) + (fittings.get(node + 2)?.consumeInMm ?? 0);
    const fits = (candidate: DuctOffsetGeometry | null) => Boolean(candidate)
      && incoming.lengthMm + STATION_EPSILON_MM >= before + candidate!.consumeInMm
      && outgoing.lengthMm + STATION_EPSILON_MM >= candidate!.consumeOutMm + after;
    // Plan corners, or the corners in the riser's plane (along the heading = local +s).
    const a = first.elbow.corner;
    const b = second.elbow.corner;
    const along = frame ? { x: 1, y: 0 } : incoming.direction;
    let offset = jogOffset(a, b, along, width, settings.elbowNeckMm, settings.elbowCentrelineRatio * width);
    if (!fits(offset)) offset = tightestOgee(a, b, along, width, settings.elbowNeckMm);
    if (!offset || !fits(offset)) continue;
    fittings.set(node, { nodeIndex: node, offset, ...(frame ? { frame } : {}), consumeInMm: offset.consumeInMm, consumeOutMm: middle.lengthMm });
    fittings.set(node + 1, { nodeIndex: node + 1, continuesOffset: true, consumeInMm: middle.lengthMm, consumeOutMm: offset.consumeOutMm });
    node += 1;
  }
}

interface TransitionPlan {
  from: DuctLeg;
  to: DuctLeg;
  neckMm: number;
  slopeMm: number;
}

/** Level legs keep a flat bottom (the height changes on top); a riser's transition is concentric both ways. */
function planTransition(from: DuctLeg, to: DuctLeg, settings: DuctDesignSettings, concentric = false, taperDeg = settings.transitionTaperDeg): TransitionPlan {
  const rise = Math.max(Math.abs(to.widthMm - from.widthMm) / 2, Math.abs(to.heightMm - from.heightMm) / (concentric ? 2 : 1));
  let slope = Math.ceil(rise / Math.tan((taperDeg * Math.PI) / 180) / 10) * 10;
  // A round reducer's cone is at least A - B and 102 mm long (SMACNA Fig. 3-5, L2).
  if (isRoundLeg(from) && isRoundLeg(to)) slope = Math.max(slope, Math.ceil(roundReducerMinLengthMm(from.diameterMm!, to.diameterMm!) / 10) * 10);
  return { from, to, neckMm: settings.elbowNeckMm, slopeMm: slope };
}

function transitionLength(transition: TransitionPlan): number {
  return 2 * transition.neckMm + transition.slopeMm;
}

/**
 * Straight sections between `from` and `to` (leg-local distances), stock
 * length at a time; a short remainder is shared with the previous section, and
 * no joint may fall inside a tap window.
 */
export function layoutSections(
  from: number,
  to: number,
  sectionMm: number,
  minMakeUpMm: number,
  windows: ReadonlyArray<{ from: number; to: number }>,
): number[] {
  const lengths: number[] = [];
  let cursor = from;
  let guard = 0;
  while (to - cursor > STATION_EPSILON_MM && guard < 10000) {
    guard += 1;
    const remaining = to - cursor;
    let next: number;
    if (remaining <= sectionMm + STATION_EPSILON_MM) next = to;
    else if (remaining - sectionMm < minMakeUpMm) next = cursor + remaining / 2;
    else next = cursor + sectionMm;
    const inside = windows.find((window) => next > window.from + STATION_EPSILON_MM && next < window.to - STATION_EPSILON_MM);
    if (inside && next < to - STATION_EPSILON_MM) {
      next = inside.from - cursor >= minMakeUpMm ? inside.from : Math.min(inside.to, to);
      if (to - next > STATION_EPSILON_MM && to - next < minMakeUpMm) next = to;
    }
    lengths.push(next - cursor);
    cursor = next;
  }
  return lengths;
}

export interface PlanDuctRunOptions {
  settings: DuctDesignSettings;
  scene: readonly HvacElement[];
  /** The walls and rooms the run passes through (default: the active building, which the drawing keeps current). */
  building?: Pick<DuctBuilding, 'walls' | 'rooms'>;
}

/** A rigid leg's wall crossing as the planner lays the leg out: its zone (a fire damper's sleeve reaches further) and what it found. */
interface LegCrossing {
  crossing: DuctWallCrossing;
  fireDamper: boolean;
  /** Along the leg (mm from its start): the wall's zone, or the damper's sleeve. */
  from: number;
  to: number;
  /** It falls on a fitting or a take-off (reported once). */
  fitting: boolean;
  damperMark?: string;
}

export function planDuctRun(element: HvacElement, options: PlanDuctRunOptions): DuctFabricationPlan | null {
  const spec = readDuctRunSpec(element);
  if (!spec) return null;
  return planDuctRunSpec(element.id, spec, options);
}

/**
 * The rigid part of a run ending in a flexible runout: its path up to the last
 * point before the terminal. A run that is all runout keeps a short stub off
 * its start (its collar and damper).
 */
function rigidPartOf(spec: DuctRunSpec): DuctRunSpec {
  const path = spec.path.slice(0, -1);
  const legs = spec.legs.slice(0, -1);
  if (path.length >= 2) return { ...spec, path, legs };
  const start = spec.path[0]!;
  const end = spec.path[spec.path.length - 1]!;
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const stub = 150;
  return {
    ...spec,
    path: [start, { x: start.x + ((end.x - start.x) / length) * stub, y: start.y + ((end.y - start.y) / length) * stub, z: start.z }],
    legs: [spec.legs[0]!],
  };
}

export function planDuctRunSpec(elementId: string, plannedSpec: DuctRunSpec, options: PlanDuctRunOptions): DuctFabricationPlan {
  const { settings, scene } = options;
  const issues: DuctIssue[] = [];
  const unverified = new Set<string>();
  const practice = new Set<string>([PRACTICE.allowances]);
  // A flexible runout to a terminal is planned after the rigid part it leaves from.
  const flexTail = plannedSpec.end.kind === 'terminal' && plannedSpec.end.flex && plannedSpec.path.length >= 2;
  const spec: DuctRunSpec = flexTail ? rigidPartOf(plannedSpec) : plannedSpec;
  const legs = ductLegs(spec);
  const polylineLengthMm = legs.reduce((total, leg) => total + leg.lengthMm, 0);
  const flowAlongPath = spec.service === 'supply';

  // Construction per section size (identical sizes share one resolution).
  const constructionCache = new Map<string, SectionConstruction>();
  const constructionOf = (section: DuctLeg): SectionConstruction => {
    const key = isRoundLeg(section) ? `d${section.diameterMm}` : `${section.widthMm}x${section.heightMm}`;
    let construction = constructionCache.get(key);
    if (!construction) {
      construction = resolveSectionConstruction({
        widthMm: section.widthMm, heightMm: section.heightMm, service: spec.service, construction: spec.construction,
        settings, pressureClassPa: spec.pressureClassPa, jointSystem: spec.jointSystem, gaugeOverrideMm: spec.gaugeOverrideMm,
        ...(isRoundLeg(section) ? { diameterMm: section.diameterMm } : {}),
      });
      constructionCache.set(key, construction);
    }
    return construction;
  };
  const constructionByLeg = plannedSpec.legs.map(constructionOf);
  const sheetOf = (section: DuctLeg) => constructionOf(section).sheetThicknessMm;
  const heavier = (a: DuctLeg, b: DuctLeg) => ((sheetOf(b) ?? 0) > (sheetOf(a) ?? 0) ? b : a);
  const flangeRollEnds = (section: DuctLeg) => (constructionOf(section).joint?.system === 'tdc' ? 2 : 0);
  // Longitudinal seams (Fig. 1-5): straights by the coil rule, fittings as four panels.
  const seamsOf = (section: DuctLeg, fitting: boolean): SeamSpec => {
    const sheet = sheetOf(section) ?? 1;
    const o = outer(section, sheet);
    if (isRoundLeg(section)) {
      // Round (Fig. 3-1): one spiral lock along the strip (≈10 % of the girth, practice) or one longitudinal seam.
      return settings.roundSeam === 'spiral' ? { count: 1, allowanceMm: 0.1 * Math.PI * o.w } : { count: 1, allowanceMm: 25 };
    }
    return {
      count: fitting ? 4 : seamsPerSection(o.w, o.h, settings.coilWidthMm),
      allowanceMm: seamAllowanceMm(settings.longitudinalSeam, sheet),
    };
  };
  const massOf = (areaM2: number, section: DuctLeg) => {
    const sheet = sheetOf(section);
    return sheet === null ? 0 : areaM2 * galvanisedSheetMassKgPerM2(sheet);
  };

  legs.forEach((leg) => {
    if (leg.sloped) {
      issues.push({ code: 'DU_SLOPED_LEG', severity: 'error', legIndex: leg.index, point: spec.path[leg.index],
        message: `Leg ${leg.index + 1} both runs and climbs: a duct is level or vertical. Make the level change a riser or a drop (drawn level here).` });
    }
  });

  // ---- Wall penetrations: derived from the walls each time (a moved wall never leaves a stale sleeve). ----
  const insulationMm = ductInsulationThicknessMm(spec, settings);
  const building = options.building ?? getActiveDuctBuilding();
  const crossings = building.walls.length ? ductWallCrossings(plannedSpec, building.walls, building.rooms) : [];
  if (crossings.length) practice.add(PRACTICE.penetration);
  const crossingsByLeg = new Map<number, LegCrossing[]>();
  for (const crossing of crossings) {
    // The runout's crossings are flexible duct through a wall (reported below); the rigid legs carry the rest.
    if (crossing.onFlex || crossing.legIndex >= legs.length) continue;
    const fireDamper = penetrationHasFireDamper(crossing, plannedSpec.penetrations, settings.fireDamperPolicy);
    const extra = fireDamper ? settings.fireDamperSleeveExtensionMm : 0;
    const entry: LegCrossing = { crossing, fireDamper, from: crossing.zoneFromMm - extra, to: crossing.zoneToMm + extra, fitting: false };
    crossingsByLeg.set(crossing.legIndex, [...(crossingsByLeg.get(crossing.legIndex) ?? []), entry]);
  }
  // ---- Inline accessories: each on its leg's straight, laid like a fire damper (straights before and after, no joint in it). ----
  const inlineByLeg = new Map<number, Array<{ item: DuctInlineAccessory; from: number; to: number; ok: boolean }>>();
  for (const item of spec.inline ?? []) {
    const section = spec.legs[item.legIndex];
    if (!section || item.legIndex >= legs.length) {
      issues.push({ code: 'DU_INLINE_CLASH', severity: 'error',
        message: `The ${INLINE_NAMES[item.kind]} (${item.id}) is on leg ${item.legIndex + 1}, which this run no longer has (or which is its flexible runout).` });
      continue;
    }
    const length = inlineAccessoryLengthMm(item, section, settings);
    inlineByLeg.set(item.legIndex, [...(inlineByLeg.get(item.legIndex) ?? []), { item, from: item.stationMm - length / 2, to: item.stationMm + length / 2, ok: true }]);
  }
  if (inlineByLeg.size) practice.add(PRACTICE.inline);
  // PN-01 …: the run's own penetration marks (P-nn is the plenum box's piece mark).
  const markOf = (crossing: DuctWallCrossing) => `PN-${String(crossings.indexOf(crossing) + 1).padStart(2, '0')}`;
  const fittingInWall = (entry: LegCrossing, legIndex: number, message: string) => {
    if (entry.fitting) return;
    entry.fitting = true;
    issues.push({ code: 'DU_PENETRATION_FITTING', severity: 'error', legIndex, point: entry.crossing.point, penetrationKey: entry.crossing.key,
      message: `${markOf(entry.crossing)}: ${message}` });
  };
  if (legs[0]?.vertical && spec.start.kind !== 'open') {
    issues.push({ code: 'DU_SLOPED_LEG', severity: 'error', legIndex: 0, point: spec.path[0],
      message: 'The first leg must leave its collar or parent level; add a level leg before the riser.' });
  }

  // ---- Start: unit collar, take-off, split outlet or open. ----
  const firstLeg = spec.legs[0]!;
  let startPort: DuctAirPort | null = null;
  let tap: TapAttachment | null = null;
  let entrySection: DuctLeg = firstLeg;
  const startPieces: Array<{ kind: 'connector' | 'takeoff' | 'damper'; lengthMm: number; section: DuctLeg }> = [];
  if (spec.start.kind === 'unit-port') {
    startPort = findAirPort(scene, spec.start.unitId, spec.start.portId);
    if (!startPort) {
      issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The unit this duct starts from is missing.' });
    } else {
      if (startPort.source === 'procedural') {
        issues.push({ code: 'DU_MOUTH_APPROX', severity: 'warning', point: spec.path[0],
          message: 'This unit has no measured collars; the connection uses placeholder openings.' });
      }
      if (Math.hypot(startPort.lip.x - spec.path[0]!.x, startPort.lip.y - spec.path[0]!.y) > 5) {
        issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The unit has moved away from this duct.' });
      }
      if (!spec.legacy) entrySection = { widthMm: startPort.widthMm, heightMm: startPort.heightMm };
    }
    if (spec.start.connector && settings.flexibleConnectorAtUnit && !spec.legacy) {
      startPieces.push({ kind: 'connector', lengthMm: settings.connectorFabricMm + 2 * settings.connectorMetalMm, section: entrySection });
    }
    practice.add(PRACTICE.slipOver);
  } else if (spec.start.kind === 'tap' || spec.start.kind === 'split-branch' || spec.start.kind === 'spigot') {
    const start = spec.start;
    let leaving: Point2D | null = null;
    const parent = ductParentOf(spec, scene);
    const parentSpec = parent ? readDuctRunSpec(parent) : null;
    if (!parentSpec) {
      issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The run this branch was taken off is missing.' });
    } else if (start.kind === 'tap') {
      const parentSection = parentSpec.legs[start.legIndex];
      const parentSheet = parentSection ? runSectionSheetMm(parentSpec, parentSection, settings) : 1;
      tap = tapAttachment(parentSpec, start, firstLeg, parentSheet, settings);
      const roundMain = Boolean(parentSection && isRoundLeg(parentSection));
      if (roundMain && !isRoundMainTapStyle(start.style)) {
        issues.push({ code: 'DU_TAP_CLASH', severity: 'error', point: spec.path[0],
          message: 'A round main takes a branch by a conical tap, a 90° tap or a 45° lateral (SMACNA Fig. 3-4 / 3-5).' });
      } else if (!roundMain && isRoundMainTapStyle(start.style)) {
        issues.push({ code: 'DU_TAP_CLASH', severity: 'error', point: spec.path[0],
          message: 'Round-main taps go on round runs; take a round branch off a rectangular wall with a spin-in or conical collar (SMACNA Fig. 2-6).' });
      } else if (isRoundTapStyle(start.style) !== isRoundLeg(firstLeg)) {
        issues.push({ code: 'DU_TAP_CLASH', severity: 'error', point: spec.path[0],
          message: isRoundLeg(firstLeg) ? 'A round branch needs a spin-in or conical collar.' : 'A spin-in or conical collar needs a round branch.' });
      }
      if (roundMain && parentSection && isRoundLeg(firstLeg) && firstLeg.diameterMm! > maxRoundBranchMm(parentSection.diameterMm!) + 0.5) {
        issues.push({ code: 'DU_TAP_TOO_BIG', severity: 'error', point: spec.path[0],
          message: `A Ø${Math.round(firstLeg.diameterMm!)} branch is over two thirds of the Ø${Math.round(parentSection.diameterMm!)} main (SMACNA S3.4: at most Ø${Math.floor(maxRoundBranchMm(parentSection.diameterMm!))}).` });
      }
      if (roundMain) practice.add(PRACTICE.roundTap);
      if (!tap) {
        issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The parent leg this branch was taken off no longer exists.' });
      } else {
        if (firstLeg.heightMm > tap.parentSection.heightMm + 0.5) {
          issues.push({ code: 'DU_TAP_TOO_BIG', severity: 'error', point: spec.path[0],
            message: `Branch ${firstLeg.heightMm} mm high is taller than its parent (${tap.parentSection.heightMm} mm).` });
        }
        if (Math.hypot(tap.wallPoint.x - spec.path[0]!.x, tap.wallPoint.y - spec.path[0]!.y) > 5) {
          issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The parent run has moved away from this branch.' });
        }
        leaving = tap.direction;
        startPieces.push({ kind: 'takeoff', lengthMm: tap.collarLengthMm, section: firstLeg });
      }
    } else if (start.kind === 'spigot') {
      // A round spigot on the parent's plenum: a take-off off the box face.
      const plenum = plenumGeometry(parentSpec);
      const parentSheet = plenum
        ? resolveSectionConstruction({ widthMm: plenum.widthMm, heightMm: plenum.heightMm, service: parentSpec.service,
          construction: parentSpec.construction, settings, pressureClassPa: parentSpec.pressureClassPa, jointSystem: parentSpec.jointSystem, gaugeOverrideMm: parentSpec.gaugeOverrideMm }).sheetThicknessMm ?? 1
        : 1;
      tap = plenum ? spigotAttachment(parentSpec, start, firstLeg, parentSheet, settings) : null;
      if (!isRoundLeg(firstLeg)) {
        issues.push({ code: 'DU_TAP_CLASH', severity: 'error', point: spec.path[0], message: 'A plenum spigot takes a round branch.' });
      }
      if (!tap) {
        issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The parent run no longer ends in a plenum.' });
      } else {
        if (Math.hypot(tap.wallPoint.x - spec.path[0]!.x, tap.wallPoint.y - spec.path[0]!.y) > 5 || Math.abs(tap.bottomZ - spec.path[0]!.z) > 5) {
          issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The parent plenum has moved away from this branch.' });
        }
        leaving = tap.direction;
        startPieces.push({ kind: 'takeoff', lengthMm: tap.collarLengthMm, section: firstLeg });
      }
      practice.add(PRACTICE.plenum);
    } else {
      const style = parentSpec.end.kind === 'split' ? parentSpec.end.style : 'bullhead';
      const lastSection = parentSpec.legs[parentSpec.legs.length - 1]!;
      const parentSheet = runSectionSheetMm(parentSpec, lastSection, settings);
      const outlet = splitOutlet(parentSpec, style, start.side, firstLeg, parentSheet, settings);
      leaving = outlet?.direction ?? null;
      if (parentSpec.end.kind !== 'split') {
        issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The parent run no longer ends in a split.' });
      } else if (outlet && Math.hypot(outlet.point.x - spec.path[0]!.x, outlet.point.y - spec.path[0]!.y) > 5) {
        issues.push({ code: 'DU_STALE', severity: 'warning', point: spec.path[0], message: 'The parent split has moved away from this branch.' });
      }
      if (firstLeg.heightMm > lastSection.heightMm + 0.5) {
        issues.push({ code: 'DU_TAP_TOO_BIG', severity: 'error', point: spec.path[0],
          message: `Branch ${firstLeg.heightMm} mm high is taller than its parent (${lastSection.heightMm} mm).` });
      }
    }
    // The collar or elbow outlet fixes the first leg's direction; anything else runs back into the parent.
    if (leaving && legs[0] && dot(legs[0].direction, leaving) < Math.cos(Math.PI / 180)) {
      issues.push({ code: 'DU_BRANCH_DIRECTION', severity: 'error', point: spec.path[0],
        message: 'A branch must leave its parent square to the wall; the first leg runs off at an angle.' });
    }
    if (start.vcd) startPieces.push({ kind: 'damper', lengthMm: settings.vcdLengthMm, section: firstLeg });
    practice.add(PRACTICE.takeoff);
  } else if (spec.start.kind === 'open' && spec.start.orphaned) {
    issues.push({ code: 'DU_OPEN_END', severity: 'warning', point: spec.path[0],
      message: 'The run this branch was taken off was deleted; the branch starts open.' });
  }

  // ---- Transitions: where the section changes along the path. ----
  const transitions: Array<TransitionPlan | null> = spec.legs.map((section, index) => {
    const previous = index === 0 ? entrySection : spec.legs[index - 1]!;
    return sameSection(previous, section) ? null : planTransition(previous, section, settings, Boolean(legs[index]?.vertical), spec.nodeOverrides[String(index)]?.taperDeg);
  });
  if (transitions.some(Boolean)) practice.add(PRACTICE.transitionTaper);
  const startPiecesLength = startPieces.reduce((total, piece) => total + piece.lengthMm, 0);
  const legStartReserve = spec.legs.map((_, index) =>
    (index === 0 ? startPiecesLength : 0) + (transitions[index] ? transitionLength(transitions[index]!) : 0));
  const fittings = planFittings(spec, legs, legStartReserve, settings, issues);
  if (fittings.size > 0) practice.add(PRACTICE.elbowNeck);
  // A leg inside an offset has no pieces of its own.
  const legInsideOffset = (legIndex: number) => Boolean(fittings.get(legIndex)?.offset);

  // ---- Tap windows this run carries for its own branches. ----
  const branches = ductBranchesOf(elementId, scene);
  const windowsByLeg = new Map<number, Array<{ from: number; to: number; branchId: string }>>();
  for (const branch of branches) {
    if (branch.start.kind !== 'tap') continue;
    const section = spec.legs[branch.start.legIndex];
    if (!section) {
      issues.push({ code: 'DU_TAP_CLASH', severity: 'error', message: `Branch ${branch.element.id} refers to a leg this run no longer has.` });
      continue;
    }
    const attachment = tapAttachment(spec, branch.start, branch.spec.legs[0]!, sheetOf(section) ?? 1, settings);
    if (!attachment) continue;
    const list = windowsByLeg.get(branch.start.legIndex) ?? [];
    list.push({
      from: attachment.openingFromMm - settings.tapWindowMarginMm,
      to: attachment.openingToMm + settings.tapWindowMarginMm,
      branchId: branch.element.id,
    });
    windowsByLeg.set(branch.start.legIndex, list);
  }

  // ---- Walk the legs, laying pieces along the polyline stations. ----
  const pieces: DuctPiece[] = [];
  const counters: Record<string, number> = {};
  const mark = (prefix: string) => {
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}-${String(counters[prefix]).padStart(prefix === 'S' ? 3 : 2, '0')}`;
  };
  const levelOf = (legIndex: number) => spec.path[legIndex]!.z;

  let station = 0;
  legs.forEach((leg, legIndex) => {
    const section = spec.legs[legIndex]!;
    const bottomZ = levelOf(legIndex);
    // A riser's pieces stack on its plan point; their centreline climbs (or falls) with the station.
    const at = (distance: number): Point2D => (leg.vertical ? { x: leg.start.x, y: leg.start.y } : add(leg.start, scale(leg.direction, distance)));
    const riserZ = (distance: number) => leg.startCentreZ + leg.vertical * distance;
    const levels = (from: number, to: number, pieceSection: DuctLeg) => (leg.vertical
      ? { bottomZ: Math.min(riserZ(from), riserZ(to)), centreZ: riserZ(from), endCentreZ: riserZ(to), vertical: leg.vertical as 1 | -1 }
      : { bottomZ, centreZ: bottomZ + pieceSection.heightMm / 2, endCentreZ: bottomZ + pieceSection.heightMm / 2 });
    const straightPiece = (kind: DuctPieceKind, prefix: string, from: number, to: number, pieceSection: DuctLeg, extra: Partial<DuctPiece> = {}): DuctPiece => {
      const length = to - from;
      const seams = seamsOf(pieceSection, kind !== 'straight');
      const area = straightAreaM2(pieceSection, sheetOf(pieceSection), length, flangeRollEnds(pieceSection), seams);
      return {
        mark: mark(prefix), kind, legIndex, start: at(from), end: at(to), direction: leg.direction,
        stationStartMm: station + from, stationEndMm: station + to, lengthMm: length,
        widthMm: pieceSection.widthMm, heightMm: pieceSection.heightMm,
        endWidthMm: pieceSection.widthMm, endHeightMm: pieceSection.heightMm,
        ...(isRoundLeg(pieceSection) ? { diameterMm: pieceSection.diameterMm, endDiameterMm: pieceSection.diameterMm } : {}),
        ...levels(from, to, pieceSection),
        sheetThicknessMm: sheetOf(pieceSection), sheetAreaM2: area, fabricAreaM2: 0, massKg: massOf(area, pieceSection),
        seamLengthMm: kind === 'connector' ? 0 : seams.count * length,
        ...extra,
      };
    };
    const endFitting = fittings.get(legIndex + 1);
    const legCrossings = crossingsByLeg.get(legIndex) ?? [];
    if (leg.vertical && (windowsByLeg.get(legIndex) ?? []).length > 0) {
      issues.push({ code: 'DU_TAP_CLASH', severity: 'error', legIndex, point: at(0),
        message: 'A take-off sits on a riser; take-offs are made on level straights.' });
    }
    const legInline = (inlineByLeg.get(legIndex) ?? []).sort((a, b) => a.from - b.from);
    if (legInsideOffset(legIndex)) {
      for (const entry of legInline) {
        entry.ok = false;
        issues.push({ code: 'DU_INLINE_CLASH', severity: 'error', legIndex, point: at(entry.item.stationMm),
          message: `The ${INLINE_NAMES[entry.item.kind]} (${entry.item.id}) sits on a leg that is now part of an offset; move it onto a straight.` });
      }
      if ((windowsByLeg.get(legIndex) ?? []).length > 0) {
        issues.push({ code: 'DU_TAP_CLASH', severity: 'error', legIndex, point: at(leg.lengthMm / 2),
          message: 'A take-off sits on a leg that is now part of an offset; move it onto a straight section.' });
      }
      for (const entry of legCrossings) {
        fittingInWall(entry, legIndex, 'the duct passes through this wall inside an offset; a wall needs a plain straight through it. Make the jog on one side of the wall.');
      }
      station += leg.lengthMm;
      return;
    }
    // A plenum fills the end of the last level leg.
    const plenumHere = legIndex === legs.length - 1 && spec.end.kind === 'plenum' && !leg.vertical ? plenumGeometry(spec) : null;
    const endReserve = (endFitting ? endFitting.consumeInMm : 0) + (plenumHere?.lengthMm ?? 0);
    let cursor = legIndex === 0 ? 0 : (fittings.get(legIndex)?.consumeOutMm ?? 0);
    const legFirstPiece = pieces.length;

    if (legIndex === 0) {
      for (const startPiece of startPieces) {
        const length = Math.max(0, Math.min(startPiece.lengthMm, leg.lengthMm - cursor));
        if (startPiece.kind === 'connector') {
          const o = outer(startPiece.section, sheetOf(startPiece.section));
          const girth = 2 * (o.w + o.h);
          const metalArea = (girth * 2 * settings.connectorMetalMm) / 1e6;
          pieces.push({
            ...straightPiece('connector', 'C', cursor, cursor + length, startPiece.section),
            connectorMetalMm: settings.connectorMetalMm,
            sheetAreaM2: metalArea, fabricAreaM2: (girth * settings.connectorFabricMm) / 1e6, massKg: massOf(metalArea, startPiece.section),
          });
        } else if (startPiece.kind === 'takeoff' && tap) {
          const piece = straightPiece('takeoff', 'T', cursor, cursor + length, startPiece.section, {
            takeoff: {
              style: (spec.start as { style: DuctTapStyle }).style, leadInMm: tap.leadInMm, parentDirection: tap.parentDirection,
              ...(tap.openingDiameterMm !== null ? { openingMm: tap.openingDiameterMm } : {}),
              ...(tap.roundMain ? { roundMain: tap.roundMain } : {}),
            },
          });
          // The shoe's lead-in adds a triangular cheek pair and a sloped wall.
          const leadArea = tap.leadInMm > 0 ? (tap.leadInMm * tap.leadInMm + tap.leadInMm * Math.SQRT2 * startPiece.section.heightMm) / 1e6 : 0;
          piece.sheetAreaM2 += leadArea;
          piece.massKg = massOf(piece.sheetAreaM2, startPiece.section);
          pieces.push(piece);
        } else {
          const damperSection = startPiece.section;
          pieces.push(straightPiece('damper', 'D', cursor, cursor + length, damperSection, {
            damper: isRoundLeg(damperSection)
              ? roundDamperLayout(damperSection.diameterMm!, sheetOf(damperSection) ?? 0.48, constructionOf(damperSection).pressureClassPa)
              : rectangularDamperLayout(damperSection.widthMm, damperSection.heightMm),
          }));
        }
        cursor += length;
      }
    }

    const transition = transitions[legIndex];
    if (transition) {
      const available = leg.lengthMm - cursor - endReserve;
      const wanted = transitionLength(transition);
      const compressed = available + STATION_EPSILON_MM < wanted;
      const slope = compressed ? Math.max(0, available - 2 * transition.neckMm) : transition.slopeMm;
      const total = Math.max(0, Math.min(wanted, available));
      const riseW = Math.abs(transition.to.widthMm - transition.from.widthMm) / 2;
      const riseH = Math.abs(transition.to.heightMm - transition.from.heightMm) / (leg.vertical ? 2 : 1);
      const angle = (rise: number) => (rise <= 0 ? 0 : slope <= 0 ? 90 : (Math.atan(rise / slope) * 180) / Math.PI);
      const sense = (fromValue: number, toValue: number): DuctTransitionInfo['widthSense'] => {
        if (Math.abs(toValue - fromValue) < 0.5) return 'none';
        const grows = toValue > fromValue;
        return grows === flowAlongPath ? 'expanding' : 'contracting';
      };
      const info: DuctTransitionInfo = {
        neckMm: transition.neckMm, slopeMm: slope,
        angleWidthDeg: angle(riseW), angleHeightDeg: angle(riseH),
        widthSense: sense(transition.from.widthMm, transition.to.widthMm),
        heightSense: sense(transition.from.heightMm, transition.to.heightMm),
        compressed,
      };
      // SMACNA Fig. 2-7: the width changes equally both sides (concentric in plan, judged on the
      // included angle), the flat bottom makes the height change eccentric (judged on the top slope).
      // On a riser there is no flat bottom: both sizes change concentrically.
      const includedLimit = (sense: DuctTransitionInfo['widthSense']) => (sense === 'expanding'
        ? settings.transitionMaxDivergingIncludedDeg : settings.transitionMaxConvergingIncludedDeg);
      const includedWidth = 2 * info.angleWidthDeg;
      const widthLimit = includedLimit(info.widthSense);
      const includedHeight = 2 * info.angleHeightDeg;
      if (info.widthSense !== 'none' && includedWidth > widthLimit + 0.01) {
        issues.push({ code: 'DU_TRANSITION_ANGLE', severity: 'error', legIndex, point: at(cursor + total / 2),
          message: `${info.widthSense === 'expanding' ? 'Diverging' : 'Converging'} transition at ${includedWidth.toFixed(0)}° included exceeds ${widthLimit}° (SMACNA Fig. 2-7, concentric); lengthen the leg.` });
      } else if (leg.vertical && info.heightSense !== 'none' && includedHeight > includedLimit(info.heightSense) + 0.01) {
        issues.push({ code: 'DU_TRANSITION_ANGLE', severity: 'error', legIndex, point: at(cursor + total / 2),
          message: `${info.heightSense === 'expanding' ? 'Diverging' : 'Converging'} riser transition at ${includedHeight.toFixed(0)}° included exceeds ${includedLimit(info.heightSense)}° (SMACNA Fig. 2-7, concentric); lengthen the riser.` });
      } else if (!leg.vertical && info.heightSense !== 'none' && info.angleHeightDeg > settings.transitionMaxEccentricDeg + 0.01) {
        issues.push({ code: 'DU_TRANSITION_ANGLE', severity: 'error', legIndex, point: at(cursor + total / 2),
          message: `Eccentric transition (flat bottom) at ${info.angleHeightDeg.toFixed(0)}° exceeds ${settings.transitionMaxEccentricDeg}° (SMACNA Fig. 2-7); lengthen the leg.` });
      }
      const bigger = heavier(transition.from, transition.to);
      const area = transitionAreaM2(transition.from, transition.to, sheetOf(bigger), transition.neckMm, slope, flangeRollEnds(bigger), seamsOf(bigger, true));
      pieces.push({
        mark: mark('R'), kind: 'transition', legIndex, start: at(cursor), end: at(cursor + total), direction: leg.direction,
        stationStartMm: station + cursor, stationEndMm: station + cursor + total, lengthMm: total,
        widthMm: transition.from.widthMm, heightMm: transition.from.heightMm,
        endWidthMm: transition.to.widthMm, endHeightMm: transition.to.heightMm,
        ...(isRoundLeg(transition.from) ? { diameterMm: transition.from.diameterMm } : {}),
        ...(isRoundLeg(transition.to) ? { endDiameterMm: transition.to.diameterMm } : {}),
        ...(leg.vertical
          ? levels(cursor, cursor + total, transition.from)
          : { bottomZ, centreZ: bottomZ + transition.from.heightMm / 2, endCentreZ: bottomZ + transition.to.heightMm / 2 }),
        transition: info,
        sheetThicknessMm: sheetOf(bigger), sheetAreaM2: area, fabricAreaM2: 0, massKg: massOf(area, bigger),
        seamLengthMm: 4 * total,
      });
      cursor += total;
    }

    const available = leg.lengthMm - cursor - endReserve;
    if (available < -STATION_EPSILON_MM) {
      issues.push({ code: 'DU_LEG_TOO_SHORT', severity: 'error', legIndex, point: at(leg.lengthMm / 2),
        message: `Leg ${legIndex + 1} is ${Math.round(-available)} mm too short for its fittings.` });
    }
    const straightFrom = cursor;
    const straightTo = Math.max(cursor, leg.lengthMm - endReserve);
    const windows = (windowsByLeg.get(legIndex) ?? []).sort((a, b) => a.from - b.from);
    windows.forEach((window, index) => {
      const clashesFitting = window.from < straightFrom - STATION_EPSILON_MM || window.to > straightTo + STATION_EPSILON_MM;
      const clashesWindow = index > 0 && window.from < windows[index - 1]!.to - STATION_EPSILON_MM;
      if (clashesFitting || clashesWindow) {
        issues.push({ code: 'DU_TAP_CLASH', severity: 'error', legIndex, point: at((window.from + window.to) / 2),
          message: clashesWindow ? 'Two take-offs overlap on this leg.' : 'A take-off overlaps an elbow, transition or connector; move it along the run.' });
      }
    });
    // A wall needs a plain straight through it: no fitting, no take-off, and a fire damper's whole sleeve.
    for (const entry of legCrossings) {
      if (windows.some((window) => window.from < entry.to && window.to > entry.from)) {
        fittingInWall(entry, legIndex, 'a take-off sits in the wall the duct passes through. Move the take-off clear of the wall.');
      } else if (entry.from < straightFrom - STATION_EPSILON_MM || entry.to > straightTo + STATION_EPSILON_MM) {
        fittingInWall(entry, legIndex, entry.fireDamper
          ? `the fire damper needs ${Math.round(entry.to - entry.from)} mm of straight through the wall (its sleeve stands ${Math.round(settings.fireDamperSleeveExtensionMm)} mm out of each face); a fitting is in the way. Move the fitting or the wall.`
          : 'the duct passes through the wall at a fitting (an elbow, transition, connector or damper); a wall needs a plain straight through it. Move the fitting or the wall.');
      }
    }
    // An inline accessory needs plain straight: clear of the fittings, the take-offs, the walls and the other accessories.
    legInline.forEach((entry, index) => {
      const name = `The ${INLINE_NAMES[entry.item.kind]} (${entry.item.id})`;
      let reason: string | null = null;
      if (entry.from < straightFrom - STATION_EPSILON_MM || entry.to > straightTo + STATION_EPSILON_MM) reason = 'overlaps an elbow, transition or other fitting';
      else if (windows.some((window) => window.from < entry.to && window.to > entry.from)) reason = 'overlaps a take-off';
      else if (legCrossings.some((crossing) => crossing.from < entry.to && crossing.to > entry.from)) reason = 'sits in a wall the duct passes through';
      else if (legInline.slice(0, index).some((other) => other.ok && other.to > entry.from + STATION_EPSILON_MM)) reason = 'overlaps another accessory';
      if (!reason) return;
      entry.ok = false;
      issues.push({ code: 'DU_INLINE_CLASH', severity: 'error', legIndex, point: at(Math.max(0, Math.min(leg.lengthMm, entry.item.stationMm))),
        message: `${name} ${reason}; move it along the leg.` });
    });
    const laidInline = legInline.filter((entry) => entry.ok);
    const sectionLength = isRoundLeg(section) && settings.roundSeam === 'spiral' ? settings.roundSectionLengthMm : settings.sectionLengthMm;
    // A remainder too short to be a section is taken up in an elbow neck: the next elbow's, or the one just made.
    const remainder = straightTo - straightFrom;
    let stretchNextElbowMm = 0;
    // (Not through a wall: the straight in it stays a straight.)
    if (remainder > STATION_EPSILON_MM && remainder < settings.minMakeUpPieceMm - STATION_EPSILON_MM && windows.length === 0 && legCrossings.length === 0
      && laidInline.length === 0) {
      const previous = pieces[pieces.length - 1];
      if (endFitting?.elbow) {
        stretchNextElbowMm = remainder;
      } else if (pieces.length === legFirstPiece && previous?.kind === 'elbow' && previous.elbow && previous.nodeIndex === legIndex) {
        const elbow = stretchElbowNeck(previous.elbow, 'end', remainder);
        const bendSection = previous.frame && !isRoundLeg(section) ? { widthMm: section.heightMm, heightMm: section.widthMm } : section;
        previous.elbow = elbow;
        previous.end = previous.frame ? frameToPlan(previous.frame, elbow.endPoint) : elbow.endPoint;
        if (previous.frame) previous.endCentreZ = elbow.endPoint.y;
        previous.stationEndMm += remainder;
        previous.lengthMm = pieceLength(elbow);
        previous.seamLengthMm = 4 * previous.lengthMm;
        previous.sheetAreaM2 = elbowAreaM2(elbow, bendSection, sheetOf(section), flangeRollEnds(section));
        previous.massKg = massOf(previous.sheetAreaM2, section);
        cursor += remainder;
      }
      if (cursor > straightFrom || stretchNextElbowMm > 0) practice.add(PRACTICE.neckStretch);
    }
    if (!(stretchNextElbowMm > 0 || cursor > straightFrom)) {
      // Joints keep clear of the take-off openings and of the walls the run passes through (a fire damper's sleeve
      // brings its own breakaway joints, beyond the wall faces).
      const jointWindows = [...windows, ...legCrossings.filter((entry) => !entry.fireDamper)
        .map((entry) => ({ from: entry.from - PENETRATION_JOINT_MARGIN_MM, to: entry.to + PENETRATION_JOINT_MARGIN_MM }))]
        .sort((a, b) => a.from - b.from);
      const straights = (to: number) => {
        const lengths = layoutSections(cursor, to, sectionLength, settings.minMakeUpPieceMm, jointWindows);
        lengths.forEach((length, index) => {
          pieces.push(straightPiece('straight', 'S', cursor, cursor + length, section, {
            isMakeUp: length < sectionLength - STATION_EPSILON_MM && (index >= lengths.length - 2),
          }));
          cursor += length;
        });
      };
      // A fire damper in its sleeve, centred in the wall: bought in (no sheet of the run's), its mass for the supports.
      const fireDamper = (entry: LegCrossing) => (from: number, to: number) => {
        const piece = straightPiece('fire-damper', 'FD', from, to, section, { penetrationKey: entry.crossing.key });
        const massKg = (girthOf(section, sheetOf(section)) / 1000) * ((to - from) / 1000) * galvanisedSheetMassKgPerM2(FIRE_DAMPER_SLEEVE_MM) * FIRE_DAMPER_MASS_FACTOR;
        pieces.push({ ...piece, sheetAreaM2: 0, fabricAreaM2: 0, massKg, seamLengthMm: 0 });
        entry.damperMark = piece.mark;
        practice.add(PRACTICE.fireDamper);
      };
      // An inline accessory: a damper section, a section carrying an access door, or a bought-in attenuator.
      const accessory = (item: DuctInlineAccessory) => (from: number, to: number) => {
        if (item.kind === 'damper') {
          pieces.push(straightPiece('damper', 'D', from, to, section, {
            inlineId: item.id,
            damper: isRoundLeg(section)
              ? roundDamperLayout(section.diameterMm!, sheetOf(section) ?? 0.48, constructionOf(section).pressureClassPa)
              : rectangularDamperLayout(section.widthMm, section.heightMm),
          }));
        } else if (item.kind === 'access-door') {
          pieces.push(straightPiece('access-door', 'AD', from, to, section, { inlineId: item.id, accessDoor: accessDoorFor(section, item.doorMm) }));
        } else {
          const piece = straightPiece('attenuator', 'SA', from, to, section, {
            inlineId: item.id, attenuator: { casingMm: ATTENUATOR_CASING_MM, type: isRoundLeg(section) ? 'podded' : 'splitter' },
          });
          const casing: DuctLeg = isRoundLeg(section) ? roundLeg(section.diameterMm! + 2 * ATTENUATOR_CASING_MM)
            : { widthMm: section.widthMm + 2 * ATTENUATOR_CASING_MM, heightMm: section.heightMm + 2 * ATTENUATOR_CASING_MM };
          const massKg = (girthOf(casing, ATTENUATOR_CASING_SHEET_MM) / 1000) * ((to - from) / 1000)
            * galvanisedSheetMassKgPerM2(ATTENUATOR_CASING_SHEET_MM) * ATTENUATOR_MASS_FACTOR;
          pieces.push({ ...piece, sheetAreaM2: 0, fabricAreaM2: 0, massKg, seamLengthMm: 0 });
        }
      };
      const laid = [
        ...legCrossings.filter((candidate) => candidate.fireDamper).map((entry) => ({ from: entry.from, to: entry.to, lay: fireDamper(entry) })),
        ...laidInline.map((entry) => ({ from: entry.from, to: entry.to, lay: accessory(entry.item) })),
      ].sort((a, b) => a.from - b.from);
      for (const entry of laid) {
        const from = Math.max(cursor, entry.from - cursor <= STATION_EPSILON_MM ? cursor : entry.from);
        const to = Math.min(entry.to, straightTo);
        if (to - from < STATION_EPSILON_MM) continue;
        if (from > cursor + STATION_EPSILON_MM) straights(from);
        cursor = from;
        entry.lay(cursor, to);
        cursor = to;
      }
      if (straightTo > cursor + STATION_EPSILON_MM) straights(straightTo);
    }

    if (endFitting?.offset) {
      const offset = endFitting.offset;
      const nodeStation = station + leg.lengthMm;
      const middle = legs[legIndex + 1]!;
      const area = straightAreaM2(section, sheetOf(section), offset.developedLengthMm, flangeRollEnds(section), seamsOf(section, true));
      const first = offset.centreline[0]!;
      const last = offset.centreline[offset.centreline.length - 1]!;
      const frame = endFitting.frame;
      // A vertical offset (a short rise or drop) lives in the riser's plane: ends mapped to plan, elevations from t.
      const placement = frame
        ? {
          start: frameToPlan(frame, first), end: frameToPlan(frame, last), frame,
          bottomZ: Math.min(spec.path[endFitting.nodeIndex]!.z, spec.path[endFitting.nodeIndex + 1]!.z),
          centreZ: first.y, endCentreZ: last.y,
        }
        : { start: first, end: last, bottomZ, centreZ: bottomZ + section.heightMm / 2, endCentreZ: bottomZ + section.heightMm / 2 };
      pieces.push({
        mark: mark('O'), kind: 'offset', legIndex, nodeIndex: endFitting.nodeIndex,
        ...placement, direction: leg.direction,
        stationStartMm: nodeStation - endFitting.consumeInMm,
        stationEndMm: nodeStation + middle.lengthMm + (fittings.get(legIndex + 2)?.consumeOutMm ?? 0),
        lengthMm: offset.developedLengthMm, widthMm: section.widthMm, heightMm: section.heightMm,
        endWidthMm: section.widthMm, endHeightMm: section.heightMm,
        ...(isRoundLeg(section) ? { diameterMm: section.diameterMm, endDiameterMm: section.diameterMm } : {}),
        offset,
        sheetThicknessMm: sheetOf(section), sheetAreaM2: area, fabricAreaM2: 0, massKg: massOf(area, section),
        seamLengthMm: 4 * offset.developedLengthMm,
      });
    } else if (plenumHere) {
      const box = { widthMm: plenumHere.widthMm, heightMm: plenumHere.heightMm };
      const sheet = sheetOf(box);
      const o = outer(box, sheet);
      const duct = outer(section, sheetOf(section));
      const length = plenumHere.lengthMm;
      // Four sides, the blank far face and the back face around the duct opening; four seams.
      const areaMm2 = 2 * (o.w + o.h) * (length + 2 * TDC_FLANGE_ROLL_MM) + 2 * o.w * o.h - duct.w * duct.h + 4 * 25 * length;
      const spigots = plenumSpigots(branches, spec, sheet ?? 1, settings);
      for (const found of checkSpigotFit(plenumHere, spigots)) {
        issues.push({ code: found.code, severity: 'error', point: spigots.find((spigot) => spigot.branchId === found.branchId)?.point, message: found.message });
      }
      if (plenumHere.widthMm < section.widthMm - 0.5 || plenumHere.heightMm < section.heightMm - 0.5) {
        issues.push({ code: 'DU_PLENUM_SIZE', severity: 'error', point: plenumHere.end,
          message: `The plenum (${Math.round(plenumHere.widthMm)} × ${Math.round(plenumHere.heightMm)}) is smaller than the duct entering it.` });
      }
      practice.add(PRACTICE.plenum);
      pieces.push({
        mark: mark('P'), kind: 'plenum', legIndex, start: at(leg.lengthMm - length), end: at(leg.lengthMm), direction: leg.direction,
        stationStartMm: station + leg.lengthMm - length, stationEndMm: station + leg.lengthMm, lengthMm: length,
        widthMm: box.widthMm, heightMm: box.heightMm, endWidthMm: box.widthMm, endHeightMm: box.heightMm,
        bottomZ, centreZ: bottomZ + box.heightMm / 2, endCentreZ: bottomZ + box.heightMm / 2,
        plenum: {
          ...box, lengthMm: length, inletWidthMm: duct.w, inletHeightMm: duct.h,
          spigots: spigots.map(({ branchId, face, point, direction, centreZ, openingMm }) => ({ branchId, face, point, direction, centreZ, openingMm })),
        },
        sheetThicknessMm: sheet, sheetAreaM2: areaMm2 / 1e6, fabricAreaM2: 0, massKg: massOf(areaMm2 / 1e6, box),
        seamLengthMm: 4 * length,
      });
    } else if (endFitting?.elbow) {
      const elbow = stretchNextElbowMm > 0 ? stretchElbowNeck(endFitting.elbow, 'start', stretchNextElbowMm) : endFitting.elbow;
      const nodeStation = station + leg.lengthMm;
      const frame = elbow.plane === 'vertical' ? elbow.frame : undefined;
      // A vertical elbow's cheeks lie in the riser's plane: its in-plane size is H.
      const bendSection = frame && !isRoundLeg(section) ? { widthMm: section.heightMm, heightMm: section.widthMm } : section;
      const area = elbowAreaM2(elbow, bendSection, sheetOf(section), flangeRollEnds(section));
      const placement = frame
        ? {
          start: frameToPlan(frame, elbow.startPoint), end: frameToPlan(frame, elbow.endPoint), frame,
          bottomZ: Math.min(spec.path[endFitting.nodeIndex]!.z, Math.min(elbow.startPoint.y, elbow.endPoint.y)),
          centreZ: elbow.startPoint.y, endCentreZ: elbow.endPoint.y,
          ...(Math.abs(elbow.inDirection.y) > 0.5 ? { vertical: (elbow.inDirection.y > 0 ? 1 : -1) as 1 | -1 } : {}),
        }
        : { start: elbow.startPoint, end: elbow.endPoint, bottomZ, centreZ: bottomZ + section.heightMm / 2, endCentreZ: bottomZ + section.heightMm / 2 };
      pieces.push({
        mark: mark('E'), kind: 'elbow', legIndex, nodeIndex: endFitting.nodeIndex,
        ...placement, direction: leg.direction,
        stationStartMm: nodeStation - endFitting.consumeInMm - stretchNextElbowMm, stationEndMm: nodeStation + endFitting.consumeOutMm,
        lengthMm: pieceLength(elbow), widthMm: section.widthMm, heightMm: section.heightMm,
        endWidthMm: section.widthMm, endHeightMm: section.heightMm,
        ...(isRoundLeg(section) ? { diameterMm: section.diameterMm, endDiameterMm: section.diameterMm } : {}),
        elbow,
        sheetThicknessMm: sheetOf(section), sheetAreaM2: area, fabricAreaM2: 0, massKg: massOf(area, section),
        seamLengthMm: 4 * pieceLength(elbow),
      });
    }
    station += leg.lengthMm;
  });

  // ---- End: cap, split or open. ----
  const lastLegIndex = legs.length - 1;
  const lastLeg = legs[lastLegIndex]!;
  const lastSection = spec.legs[lastLegIndex]!;
  const lastBottom = levelOf(lastLegIndex);
  const endLevels = lastLeg.vertical
    ? { bottomZ: lastLeg.endCentreZ, centreZ: lastLeg.endCentreZ, endCentreZ: lastLeg.endCentreZ, vertical: lastLeg.vertical as 1 | -1 }
    : { bottomZ: lastBottom, centreZ: lastBottom + lastSection.heightMm / 2, endCentreZ: lastBottom + lastSection.heightMm / 2 };
  const endPiece = (kind: 'end-cap' | 'split', prefix: string, extra: Partial<DuctPiece>, area: number, massSection: DuctLeg): DuctPiece => ({
    mark: mark(prefix), kind, legIndex: lastLegIndex, start: { x: lastLeg.end.x, y: lastLeg.end.y }, end: { x: lastLeg.end.x, y: lastLeg.end.y }, direction: lastLeg.direction,
    stationStartMm: polylineLengthMm, stationEndMm: polylineLengthMm, lengthMm: 0,
    widthMm: lastSection.widthMm, heightMm: lastSection.heightMm, endWidthMm: lastSection.widthMm, endHeightMm: lastSection.heightMm,
    ...endLevels,
    sheetThicknessMm: sheetOf(massSection), sheetAreaM2: area, fabricAreaM2: 0, massKg: massOf(area, massSection),
    seamLengthMm: 0,
    ...extra,
  });
  if (spec.end.kind === 'end-cap') {
    const o = outer(lastSection, sheetOf(lastSection));
    const capArea = isRoundLeg(lastSection) ? (Math.PI * o.w * o.w) / 4 + Math.PI * o.w * 25 : o.w * o.h + 2 * (o.w + o.h) * TDC_FLANGE_ROLL_MM;
    pieces.push(endPiece('end-cap', 'K', isRoundLeg(lastSection) ? { diameterMm: lastSection.diameterMm, endDiameterMm: lastSection.diameterMm } : {}, capArea / 1e6, lastSection));
  } else if (spec.end.kind === 'split') {
    const splitBranches = branches.flatMap((branch) => (branch.start.kind === 'split-branch'
      ? [{ side: branch.start.side, section: branch.spec.legs[0]! }] : []));
    const geometry = splitFitting(spec, spec.end.style, splitBranches, sheetOf(lastSection) ?? 1, settings);
    if (lastLeg.vertical) {
      issues.push({ code: 'DU_SPLIT_SIZE', severity: 'error', point: spec.path[spec.path.length - 1],
        message: 'A split ends a level leg; add a level leg after the riser.' });
    }
    if (spec.end.style === 'wye') {
      if (!isRoundLeg(lastSection) || splitBranches.some((branch) => !isRoundLeg(branch.section))) {
        issues.push({ code: 'DU_SPLIT_SIZE', severity: 'error', point: spec.path[spec.path.length - 1],
          message: 'A wye splits a round main into round branches (SMACNA Fig. 3-5); a rectangular run splits with a Y or a bullhead tee (Fig. 2-5).' });
      }
      practice.add(PRACTICE.wye);
    } else if (isRoundLeg(lastSection) || splitBranches.some((branch) => isRoundLeg(branch.section))) {
      issues.push({ code: 'DU_SPLIT_SIZE', severity: 'error', point: spec.path[spec.path.length - 1],
        message: 'Y and bullhead splits are rectangular fittings (SMACNA Fig. 2-5); split a round main with a wye (Fig. 3-5).' });
    }
    if (geometry) {
      practice.add(PRACTICE.split);
      if (geometry.cappedSides.length > 0) {
        issues.push({ code: 'DU_SPLIT_INCOMPLETE', severity: 'warning', point: geometry.origin,
          message: geometry.cappedSides.length === 2 ? 'The split has no branches yet; both outlets are capped.' : 'One outlet of the split has no branch and is capped.' });
      }
      const sharedWidth = geometry.branches.reduce((total, branch) => total + branch.section.widthMm, 0);
      if (geometry.style === 'y' && sharedWidth > lastSection.widthMm + 0.5) {
        issues.push({ code: 'DU_SPLIT_SIZE', severity: 'error', point: geometry.origin,
          message: `The Y branches (${sharedWidth} mm together) are wider than the run (${lastSection.widthMm} mm).` });
      }
      for (const branch of geometry.branches) {
        if (branch.section.heightMm > lastSection.heightMm + 0.5) {
          issues.push({ code: 'DU_TAP_TOO_BIG', severity: 'error', point: branch.outlet.point,
            message: `Split branch ${branch.section.heightMm} mm high is taller than the run (${lastSection.heightMm} mm).` });
        }
      }
      const o = outer(lastSection, sheetOf(lastSection));
      const heavy = geometry.branches.reduce((best, branch) => heavier(best, branch.section), lastSection);
      let area: number;
      if (geometry.style === 'wye') {
        // A cone from the main to each outlet over its 3A/2 leg, a 51 mm spigot on each, a disc on a capped leg.
        const leg = wyeLegLengthMm(lastSection.widthMm);
        const spigot = ROUND_FITTING_RULES.spigotMm;
        area = (geometry.branches.reduce((total, branch) => {
          const r1 = o.w / 2;
          const r2 = branch.section.widthMm / 2 + (sheetOf(branch.section) ?? 1);
          return total + Math.PI * (r1 + r2) * Math.hypot(leg, r1 - r2) + 2 * Math.PI * r2 * spigot;
        }, 0) + geometry.cappedSides.length * (Math.PI * o.w * o.w) / 4) / 1e6;
      } else if (geometry.style === 'bullhead') {
        area = (2 * (o.w + o.h) * geometry.depthMm + o.w * o.h) / 1e6;
      } else {
        area = geometry.branches.reduce((total, branch) => total + (branch.elbow
          ? elbowAreaM2({ ...branch.elbow, style: 'radius', vaneCount: 0 }, branch.section, sheetOf(heavy), 0) : 0), 0)
          + (geometry.cappedSides.length > 0 ? (o.w * o.h) / 2e6 : 0);
      }
      pieces.push(endPiece('split', 'Y', { split: geometry, lengthMm: geometry.depthMm }, area, heavy));
    }
  } else if (spec.end.kind === 'terminal') {
    const end = spec.end;
    const port = findTerminalPort(scene, end.terminalId, end.portId);
    const stored = plannedSpec.path[plannedSpec.path.length - 1]!;
    if (!port) {
      issues.push({ code: 'DU_STALE', severity: 'warning', point: stored, message: 'The air terminal this run serves is missing.' });
    } else if (Math.hypot(port.lip.x - stored.x, port.lip.y - stored.y) > 5) {
      issues.push({ code: 'DU_STALE', severity: 'warning', point: stored, message: 'The air terminal has moved away from this run.' });
    }
    if (flexTail) {
      const flexSection = plannedSpec.legs[plannedSpec.legs.length - 1]!;
      const diameter = flexSection.diameterMm ?? flexSection.widthMm;
      const rigidEnd = spec.path[spec.path.length - 1]!;
      const startCentre = { x: rigidEnd.x, y: rigidEnd.y, z: lastLeg.vertical ? lastLeg.endCentreZ : rigidEnd.z + lastSection.heightMm / 2 };
      const startDirection = lastLeg.vertical ? { x: 0, y: 0, z: lastLeg.vertical } : { x: lastLeg.direction.x, y: lastLeg.direction.y, z: 0 };
      const endCentre = port ? port.lip : { x: stored.x, y: stored.y, z: stored.z + diameter / 2 };
      const endDirection = port ? { x: -port.normal.x, y: -port.normal.y, z: 0 } : startDirection;
      const curve = flexCurve(startCentre, startDirection, endCentre, endDirection);
      practice.add(PRACTICE.flex);
      if (curve.lengthMm > settings.flexMaxLengthMm + 0.5) {
        issues.push({ code: 'DU_FLEX_LENGTH', severity: 'warning', point: stored,
          message: `The flexible runout is ${(curve.lengthMm / 1000).toFixed(2)} m, over the ${(settings.flexMaxLengthMm / 1000).toFixed(2)} m maximum (project; SMACNA S3.23 asks for the minimum length). Bring the rigid duct closer.` });
      }
      if (curve.minBendRadiusMm < FLEX_RULES.minBendDiameters * diameter - 0.5) {
        issues.push({ code: 'DU_FLEX_BEND', severity: 'error', point: { x: curve.tightestAt.x, y: curve.tightestAt.y },
          message: `The runout bends at ${Math.round(curve.minBendRadiusMm)} mm radius, under one diameter (${Math.round(diameter)} mm, SMACNA S3.24).` });
      }
      if (port?.diameterMm !== undefined && Math.abs(port.diameterMm - diameter) > 0.5) {
        issues.push({ code: 'DU_FLEX_SIZE', severity: 'error', point: stored,
          message: `A Ø${Math.round(diameter)} runout on a Ø${Math.round(port.diameterMm)} terminal spigot.` });
      }
      if (startCentre.z - endCentre.z > FLEX_RULES.terminalDropSupportMm) {
        issues.push({ code: 'DU_FLEX_DROP', severity: 'info', point: stored,
          message: `The runout drops ${Math.round(startCentre.z - endCentre.z)} mm to the terminal: add supports (SMACNA Fig. 2-15, over 0.91 m).` });
      }
      const planDirection = { x: endCentre.x - startCentre.x, y: endCentre.y - startCentre.y };
      const planLength = Math.hypot(planDirection.x, planDirection.y) || 1;
      const zs = curve.points.map((point) => point.z);
      pieces.push({
        mark: mark('F'), kind: 'flex', legIndex: plannedSpec.legs.length - 1,
        start: { x: startCentre.x, y: startCentre.y }, end: { x: endCentre.x, y: endCentre.y },
        direction: { x: planDirection.x / planLength, y: planDirection.y / planLength },
        stationStartMm: polylineLengthMm, stationEndMm: polylineLengthMm + curve.lengthMm, lengthMm: curve.lengthMm,
        widthMm: diameter, heightMm: diameter, endWidthMm: diameter, endHeightMm: diameter, diameterMm: diameter, endDiameterMm: diameter,
        bottomZ: Math.min(...zs) - diameter / 2, centreZ: startCentre.z, endCentreZ: endCentre.z,
        flex: { points: curve.points, stations: curve.stations, minBendRadiusMm: curve.minBendRadiusMm, terminalId: end.terminalId,
          type: settings.flexType, jacketMm: settings.flexType === 'nm-il' ? settings.flexJacketMm : 0 },
        sheetThicknessMm: null, sheetAreaM2: 0, fabricAreaM2: 0, massKg: 0, seamLengthMm: 0,
      });
    } else if (port) {
      if (port.diameterMm !== undefined && !(isRoundLeg(lastSection) && Math.abs((lastSection.diameterMm ?? 0) - port.diameterMm) < 0.5)) {
        issues.push({ code: 'DU_TERMINAL_SIZE', severity: 'error', point: stored,
          message: `The run (${isRoundLeg(lastSection) ? `Ø${Math.round(lastSection.diameterMm!)}` : `${lastSection.widthMm}×${lastSection.heightMm}`}) does not fit the terminal's Ø${Math.round(port.diameterMm)} spigot.` });
      }
      // Rigid duct slips over the spigot: it must arrive level, square to it and on its axis.
      const square = !lastLeg.vertical && lastLeg.direction.x * -port.normal.x + lastLeg.direction.y * -port.normal.y > Math.cos(Math.PI / 90);
      const across = Math.abs((stored.x - port.lip.x) * port.normal.y - (stored.y - port.lip.y) * port.normal.x);
      if (!square || across > 5 || Math.abs(stored.z + lastSection.heightMm / 2 - port.lip.z) > 5) {
        issues.push({ code: 'DU_TERMINAL_ALIGN', severity: 'error', point: stored,
          message: 'Rigid duct must meet the terminal\'s spigot level, square to it and on its axis; route the last leg straight into the spigot or use a flexible runout.' });
      }
    }
  } else if (spec.end.kind === 'plenum' && lastLeg.vertical) {
    issues.push({ code: 'DU_PLENUM_SIZE', severity: 'error', point: spec.path[spec.path.length - 1],
      message: 'A plenum ends a level leg; add a level leg after the riser.' });
  } else if (spec.end.kind === 'open' && !spec.legacy) {
    issues.push({ code: 'DU_OPEN_END', severity: spec.end.orphaned ? 'warning' : 'info', point: spec.path[spec.path.length - 1],
      message: spec.end.orphaned ? 'The terminal this run served was deleted; the run ends open.' : 'The run ends open.' });
  }

  // ---- Constructions actually used, reported once each. ----
  const statusIssue: Record<Exclude<SectionConstruction['status'], 'ok'>, DuctIssueCode> = {
    'unsupported-pressure': 'DU_PRESSURE_UNSUPPORTED',
    'gauge-override-invalid': 'DU_GAUGE_OVERRIDE',
    'size-over-table': 'DU_SIZE_OVER_TABLE',
    'no-stock': 'DU_NO_STOCK',
    'joint-not-achievable': 'DU_GAUGE_JOINT',
  };
  const usedSections: DuctLeg[] = [...spec.legs, ...pieces.map((piece) => pieceSection(piece, 'end'))];
  if (startPieces.some((piece) => piece.kind === 'connector')) usedSections.push(entrySection);
  const reported = new Set<SectionConstruction>();
  for (const section of usedSections) {
    const construction = constructionOf(section);
    if (reported.has(construction)) continue;
    reported.add(construction);
    if (construction.status !== 'ok') {
      issues.push({ code: statusIssue[construction.status], severity: 'error', message: construction.message ?? construction.status });
      continue;
    }
    if (construction.intermediate) {
      issues.push({ code: 'DU_INTERMEDIATE_REINF', severity: 'warning',
        message: `Intermediate reinforcement class ${construction.intermediate.cls} at ${construction.intermediate.spacingMm} mm (Table 1-10M member).` });
    }
    if (construction.crossBreak.width || construction.crossBreak.height) {
      issues.push({ code: 'DU_CROSS_BREAK', severity: 'info', message: `Cross-break or bead the wide sides of ${section.widthMm}×${section.heightMm} (SMACNA S1.15).` });
    }
    const aspect = Math.max(section.widthMm, section.heightMm) / Math.max(1, Math.min(section.widthMm, section.heightMm));
    if (aspect > settings.aspectRatioAdvisory + 1e-9) {
      issues.push({ code: 'DU_ASPECT_RATIO', severity: 'info',
        message: `${section.widthMm}×${section.heightMm} has an aspect ratio of ${aspect.toFixed(1)}:1 (advisory limit ${settings.aspectRatioAdvisory}:1; project practice, not SMACNA).` });
    }
  }

  // ---- Joints: the section at a joint is the previous piece's end section. ----
  const joints: DuctJoint[] = [];
  const hardwareFor = (section: DuctLeg): JointHardware | null => {
    const construction = constructionOf(section);
    if (construction.status !== 'ok' || !construction.joint) return null;
    const o = outer(section, construction.sheetThicknessMm);
    return jointHardware(construction.joint, {
      sideAMm: o.w, sideBMm: o.h, pressureClassPa: construction.pressureClassPa, washersPerBolt: settings.washersPerBolt,
    });
  };
  /** A joint at the start of `at`: its point, heading and centreline level, flat on a riser. */
  const pushJoint = (kind: DuctJointKind, stationMm: number, at: DuctPiece, section: DuctLeg,
    between: [string | null, string | null], hardware: JointHardware | null) => {
    const o = outer(section, sheetOf(section));
    joints.push({
      id: `${elementId}:J${joints.length + 1}`, kind, stationMm, point: at.start, direction: at.direction,
      centreZ: at.vertical || at.frame ? at.centreZ : at.bottomZ + section.heightMm / 2,
      ...(at.vertical ? { vertical: at.vertical } : {}),
      widthMm: section.widthMm, heightMm: section.heightMm, outerWidthMm: o.w, outerHeightMm: o.h,
      between, hardware,
    });
  };
  const first = pieces[0];
  if (first) {
    const section = pieceSection(first, 'start');
    const o = outer(section, sheetOf(section));
    const pressureClassPa = constructionOf(section).pressureClassPa;
    if (spec.start.kind === 'unit-port') {
      pushJoint('unit-connection', 0, first, section, [null, first.mark],
        slipOverHardware({ sideAMm: o.w, sideBMm: o.h, pressureClassPa, washersPerBolt: settings.washersPerBolt }));
    } else if ((spec.start.kind === 'tap' || spec.start.kind === 'spigot') && tap) {
      const start = spec.start;
      pushJoint('tap-connection', 0, first, section, [null, first.mark],
        tap.openingDiameterMm !== null && isRoundTapStyle(start.style)
          ? roundTakeoffHardware({ sideAMm: tap.openingDiameterMm, sideBMm: tap.openingDiameterMm, pressureClassPa, washersPerBolt: settings.washersPerBolt },
            start.style as Exclude<DuctTapStyle, 'shoe-45' | 'straight'>)
          : takeoffHardware({ sideAMm: o.w + tap.leadInMm, sideBMm: o.h, pressureClassPa, washersPerBolt: settings.washersPerBolt }));
    } else if (spec.start.kind === 'split-branch') {
      pushJoint('flange', 0, first, section, [null, first.mark], hardwareFor(section));
    }
  }
  for (let index = 1; index < pieces.length; index += 1) {
    const previous = pieces[index - 1]!;
    const next = pieces[index]!;
    const section = pieceSection(previous, 'end');
    // A runout slips over the rigid end and is held by draw bands (counted with the runout).
    if (next.kind === 'flex') {
      pushJoint('flex-connection', next.stationStartMm, next, section, [previous.mark, next.mark], null);
      continue;
    }
    pushJoint(next.kind === 'end-cap' ? 'end-cap' : 'flange', next.stationStartMm, next, section,
      [previous.mark, next.mark], hardwareFor(section));
  }

  // The run's last piece meets the terminal's spigot: a runout's draw band, or a rigid slip joint.
  const lastPiece = pieces[pieces.length - 1];
  if (spec.end.kind === 'terminal' && lastPiece) {
    const section = pieceSection(lastPiece, 'end');
    const o = outer(section, lastPiece.sheetThicknessMm);
    const flexEnd = lastPiece.flex?.points[lastPiece.flex.points.length - 2];
    const along = flexEnd ? { x: lastPiece.end.x - flexEnd.x, y: lastPiece.end.y - flexEnd.y } : lastPiece.direction;
    const length = Math.hypot(along.x, along.y) || 1;
    joints.push({
      id: `${elementId}:J${joints.length + 1}`, kind: 'terminal-connection', stationMm: lastPiece.stationEndMm, point: lastPiece.end,
      direction: { x: along.x / length, y: along.y / length }, centreZ: lastPiece.endCentreZ,
      widthMm: section.widthMm, heightMm: section.heightMm, outerWidthMm: o.w, outerHeightMm: o.h,
      between: [lastPiece.mark, null], hardware: lastPiece.kind === 'flex' ? null : hardwareFor(section),
    });
  }

  // ---- Wall penetrations: each sleeve (the opening a builder leaves), and the rules each keeps. ----
  const legStarts: number[] = [];
  legs.reduce((start, leg) => { legStarts.push(start); return start + leg.lengthMm; }, 0);
  const penetrations: DuctPenetration[] = crossings.map((crossing) => {
    const mark = markOf(crossing);
    const entry = crossingsByLeg.get(crossing.legIndex)?.find((candidate) => candidate.crossing === crossing) ?? null;
    const flexSection = plannedSpec.legs[crossing.legIndex]!;
    const a = plannedSpec.path[crossing.legIndex]!;
    const b = plannedSpec.path[crossing.legIndex + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const issue = (code: DuctIssueCode, severity: DuctIssue['severity'], message: string) => issues.push({
      code, severity, message: `${mark}: ${message}`, point: crossing.point, penetrationKey: crossing.key, ...(entry ? { legIndex: crossing.legIndex } : {}),
    });
    if (!entry) {
      // Flexible duct through a wall: never (it is not a fire or smoke barrier, and it crushes in the sleeve).
      const diameter = flexSection.diameterMm ?? flexSection.widthMm;
      const outerDiameter = diameter + 2 * (settings.flexType === 'nm-il' ? settings.flexJacketMm : 0);
      issue('DU_PENETRATION_FLEX', 'error', 'the flexible runout passes through a wall. Flexible duct may not pass through walls (UL 181 / NFPA 90A practice): bring the rigid duct through the wall and start the runout beyond it.');
      return {
        ...crossing, mark, fireDamper: false,
        stationMm: polylineLengthMm + crossing.legStationMm, fromStationMm: polylineLengthMm + crossing.zoneFromMm, toStationMm: polylineLengthMm + crossing.zoneToMm,
        widthMm: diameter, heightMm: diameter, diameterMm: diameter, outerWidthMm: outerDiameter, outerHeightMm: outerDiameter,
        opening: sleeveOpeningMm(outerDiameter, outerDiameter, settings.penetrationClearanceMm, true),
        bottomZ: Math.min(a.z, b.z), direction,
      };
    }
    const section = spec.legs[crossing.legIndex]!;
    const round = isRoundLeg(section);
    // The insulation runs through a plain sleeve; it stops at a fire damper's (the damper's sleeve is fire-stopped bare).
    const skin = (sheetOf(section) ?? 1) + (entry.fireDamper ? 0 : insulationMm);
    const outerWidthMm = section.widthMm + 2 * skin;
    const outerHeightMm = section.heightMm + 2 * skin;
    const start = legStarts[crossing.legIndex] ?? 0;
    const penetration: DuctPenetration = {
      ...crossing, mark, fireDamper: entry.fireDamper, ...(entry.damperMark ? { damperMark: entry.damperMark } : {}),
      stationMm: start + crossing.legStationMm, fromStationMm: start + crossing.zoneFromMm, toStationMm: start + crossing.zoneToMm,
      widthMm: section.widthMm, heightMm: section.heightMm, ...(round ? { diameterMm: section.diameterMm } : {}),
      outerWidthMm, outerHeightMm, opening: sleeveOpeningMm(outerWidthMm, outerHeightMm, settings.penetrationClearanceMm, round),
      bottomZ: spec.path[crossing.legIndex]!.z, direction,
    };
    if (crossing.angleDeg > PENETRATION_MAX_ANGLE_DEG) {
      issue('DU_PENETRATION_ANGLE', 'warning', `the duct crosses the wall ${Math.round(crossing.angleDeg)}° off square. A sleeve is set square to the wall (within ${PENETRATION_MAX_ANGLE_DEG}°, practice): cross it square.`);
    }
    if (crossing.exterior) {
      issue('DU_PENETRATION_EXTERIOR', 'warning', 'the duct passes through an exterior wall: the opening needs weatherproofing, and the wall\'s fire and acoustic rating checked.');
    }
    // A joint in the wall (or within the margin of its faces) cannot be made up there.
    if (!entry.fitting && !entry.fireDamper && joints.some((joint) => joint.stationMm > penetration.fromStationMm - PENETRATION_JOINT_MARGIN_MM + STATION_EPSILON_MM
      && joint.stationMm < penetration.toStationMm + PENETRATION_JOINT_MARGIN_MM - STATION_EPSILON_MM)) {
      issue('DU_PENETRATION_JOINT', 'warning', `a transverse joint falls in the wall or within ${PENETRATION_JOINT_MARGIN_MM} mm of its faces, where it cannot be made up. Lengthen the straight through the wall.`);
    }
    return penetration;
  });

  if (insulationMm > 0) practice.add(PRACTICE.insulation);
  const totals = pieces.reduce((sum, piece) => ({
    sheetAreaM2: sum.sheetAreaM2 + piece.sheetAreaM2,
    fabricAreaM2: sum.fabricAreaM2 + piece.fabricAreaM2,
    massKg: sum.massKg + piece.massKg,
  }), { sheetAreaM2: 0, fabricAreaM2: 0, massKg: 0 });

  const flexLength = pieces.reduce((total, piece) => total + (piece.kind === 'flex' ? piece.lengthMm : 0), 0);
  return {
    elementId,
    spec: plannedSpec,
    status: issues.some((issue) => issue.severity === 'error') ? 'error' : 'ok',
    constructionByLeg,
    startPort,
    tap,
    pieces,
    joints,
    issues,
    penetrations,
    polylineLengthMm: polylineLengthMm + flexLength,
    totals,
    unverifiedRules: [...unverified],
    practiceRules: [...practice],
    seamType: settings.longitudinalSeam,
    seamRound: settings.roundSeam,
    insulationMm,
    insulation: insulationMm > 0 ? insulationTakeoff({ pieces, joints }, insulationMm, settings) : null,
  };
}

/** The spigots the run's branches take off its plenum: where each collar opens. */
function plenumSpigots(branches: readonly DuctBranchRef[], spec: DuctRunSpec, sheetMm: number, settings: Pick<DuctDesignSettings, 'tapCollarMm' | 'conicalFlareMm'>) {
  return branches.flatMap((branch) => {
    if (branch.start.kind !== 'spigot') return [];
    const start = branch.start;
    const attachment = spigotAttachment(spec, start, branch.spec.legs[0]!, sheetMm, settings);
    if (!attachment) return [];
    return [{
      branchId: branch.element.id, face: start.face, alongMm: start.alongMm, acrossMm: start.acrossMm,
      point: attachment.wallPoint, direction: attachment.direction,
      centreZ: attachment.bottomZ + (branch.spec.legs[0]!.diameterMm ?? branch.spec.legs[0]!.widthMm) / 2,
      openingMm: attachment.openingDiameterMm ?? branch.spec.legs[0]!.widthMm,
    }];
  });
}

/** What a run's plan depends on besides itself: its unit or parent, and its branches. */
function planDependencies(element: HvacElement, spec: DuctRunSpec | null, scene: readonly HvacElement[]): unknown[] {
  if (!spec) return [];
  const dependencies: unknown[] = [];
  if (spec.start.kind === 'unit-port') {
    const unitId = spec.start.unitId;
    dependencies.push(scene.find((candidate) => candidate.id === unitId));
  }
  const parent = ductParentOf(spec, scene);
  if (parent) dependencies.push(parent);
  for (const branch of ductBranchesOf(element.id, scene)) dependencies.push(branch.element);
  return dependencies;
}

/** Memoised plans: keyed by the element object, the settings object, the building (its walls) and the plan's dependencies. */
const PLAN_CACHE = new WeakMap<HvacElement, { settings: DuctDesignSettings; building: DuctBuilding; dependencies: unknown[]; plan: DuctFabricationPlan | null }>();

export function getDuctRunPlan(element: HvacElement, scene: readonly HvacElement[], settings: DuctDesignSettings): DuctFabricationPlan | null {
  const spec = readDuctRunSpec(element);
  const dependencies = planDependencies(element, spec, scene);
  const building = getActiveDuctBuilding();
  const cached = PLAN_CACHE.get(element);
  if (cached && cached.settings === settings && cached.building === building && cached.dependencies.length === dependencies.length
    && cached.dependencies.every((value, index) => value === dependencies[index])) {
    return cached.plan;
  }
  const plan = spec ? planDuctRunSpec(element.id, spec, { settings, scene, building }) : null;
  PLAN_CACHE.set(element, { settings, building, dependencies, plan });
  return plan;
}
