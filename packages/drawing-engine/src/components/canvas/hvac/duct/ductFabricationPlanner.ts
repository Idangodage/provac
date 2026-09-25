/**
 * Duct run → fabrication plan: every piece (flexible connector, straight
 * sections, elbows, end cap), every joint with its hardware, the section
 * construction (sheet, class, joint member) and the issues. Pure and
 * deterministic; the 2D overlay, 3D builder, BOM and validation all read the
 * same plan, so what is drawn is what is scheduled.
 *
 * Phase 1 scope: horizontal legs of one section size. Size changes
 * (transitions) and vertical legs are reported, not fabricated, until their
 * phases land.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { findAirPort, type DuctAirPort } from './ductAirPorts';
import { galvanisedSheetMassKgPerM2 } from './ductCatalog';
import { resolveSectionConstruction, type SectionConstruction } from './ductGauge';
import {
  TURN_EPSILON_DEG,
  add,
  ductLegs,
  radiusElbowGeometry,
  scale,
  squareElbowGeometry,
  turnAngleDeg,
  type DuctLegGeometry,
  type ElbowPlanGeometry,
} from './ductGeometry';
import { jointHardware, slipOverHardware, type JointHardware } from './ductJoints';
import type { DuctDesignSettings } from './ductSettings';
import { readDuctRunSpec, type DuctLeg, type DuctRunSpec } from './ductTypes';

export type DuctIssueCode =
  | 'DU_PRESSURE_UNSUPPORTED'
  | 'DU_SIZE_OVER_TABLE'
  | 'DU_NO_STOCK'
  | 'DU_GAUGE_JOINT'
  | 'DU_LEG_TOO_SHORT'
  | 'DU_MOUTH_APPROX'
  | 'DU_MOUTH_MISMATCH'
  | 'DU_STALE'
  | 'DU_INTERMEDIATE_REINF'
  | 'DU_CROSS_BREAK'
  | 'DU_SIZE_CHANGE_PENDING'
  | 'DU_VERTICAL_PENDING'
  | 'DU_OPEN_END';

export interface DuctIssue {
  code: DuctIssueCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  legIndex?: number;
  nodeIndex?: number;
  point?: Point2D;
}

export type DuctPieceKind = 'connector' | 'straight' | 'elbow' | 'end-cap';

export interface DuctElbow extends ElbowPlanGeometry {
  style: 'radius' | 'square-vaned';
  vaneCount: number;
}

export interface DuctPiece {
  mark: string;
  kind: DuctPieceKind;
  legIndex: number;
  nodeIndex?: number;
  /** Plan centreline ends (an elbow's ends are its neck ends). */
  start: Point2D;
  end: Point2D;
  /** Straights / connector: leg direction; elbow: incoming direction. */
  direction: Point2D;
  stationStartMm: number;
  stationEndMm: number;
  /** Developed centreline length (elbow: arc or square path + necks). */
  lengthMm: number;
  /** Clear inside section. */
  widthMm: number;
  heightMm: number;
  /** Elevation of the clear bottom and of the centreline. */
  bottomZ: number;
  centreZ: number;
  elbow?: DuctElbow;
  isMakeUp?: boolean;
  /** Connector: GI edge on each side of the fabric (mm). */
  connectorMetalMm?: number;
  sheetThicknessMm: number | null;
  sheetAreaM2: number;
  fabricAreaM2: number;
  massKg: number;
}

export type DuctJointKind = 'flange' | 'unit-connection' | 'end-cap';

export interface DuctJoint {
  id: string;
  kind: DuctJointKind;
  stationMm: number;
  point: Point2D;
  direction: Point2D;
  centreZ: number;
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
  pieces: DuctPiece[];
  joints: DuctJoint[];
  issues: DuctIssue[];
  polylineLengthMm: number;
  totals: { sheetAreaM2: number; fabricAreaM2: number; massKg: number };
  /** Rules this plan used whose values are not verified against their source. */
  unverifiedRules: string[];
}

/** Longitudinal seam girth allowance per section (two Pittsburgh seams). Practice, unverified. */
const SEAM_GIRTH_ALLOWANCE_MM = 50;
/** Sheet consumed by one roll-formed TDC flange, per duct end. Practice, unverified. */
const TDC_FLANGE_ROLL_MM = 35;
const STATION_EPSILON_MM = 0.5;

const UNVERIFIED = {
  allowances: 'Seam and flange sheet allowances (fabricator practice)',
  tdcCleats: 'TDC cleat spacing: SMACNA T-24 clip rule applied (Fig. 1-15 not read)',
  elbow: 'Elbow R/W, neck length and vane pitch (institutional specs; SMACNA Fig. 2-2/2-3 not read)',
  connector: 'Flexible connector dimensions (fabricator practice)',
  slipOver: 'Screws at the unit collar (S1.40 spacing by analogy)',
} as const;

function outer(section: DuctLeg, thicknessMm: number | null): { w: number; h: number } {
  const t = thicknessMm ?? 1;
  return { w: section.widthMm + 2 * t, h: section.heightMm + 2 * t };
}

function straightAreaM2(section: DuctLeg, thicknessMm: number | null, lengthMm: number, flangeRollEnds: number): number {
  const o = outer(section, thicknessMm);
  const girth = 2 * (o.w + o.h) + SEAM_GIRTH_ALLOWANCE_MM;
  return (girth * (lengthMm + flangeRollEnds * TDC_FLANGE_ROLL_MM)) / 1e6;
}

function elbowAreaM2(elbow: DuctElbow, section: DuctLeg, thicknessMm: number | null, flangeRollEnds: number): number {
  const o = outer(section, thicknessMm);
  const neck = elbow.neckMm;
  const girth = 2 * (o.w + o.h);
  let body: number;
  if (elbow.style === 'radius') {
    const theta = (elbow.angleDeg * Math.PI) / 180;
    const ro = elbow.centrelineRadiusMm + o.w / 2;
    const ri = Math.max(0, elbow.centrelineRadiusMm - o.w / 2);
    const cheeks = 2 * 0.5 * theta * (ro * ro - ri * ri);
    body = cheeks + o.h * (ro + ri) * theta;
  } else {
    const cheek = o.w * o.w;
    body = 2 * cheek + o.h * 2 * o.w;
  }
  const necks = 2 * neck * girth;
  return (body + necks + flangeRollEnds * TDC_FLANGE_ROLL_MM * girth) / 1e6;
}

function pieceLength(elbow: DuctElbow): number {
  const bend = elbow.style === 'radius'
    ? (elbow.centrelineRadiusMm * elbow.angleDeg * Math.PI) / 180
    : 2 * elbow.setbackMm;
  return bend + 2 * elbow.neckMm;
}

interface NodeFitting {
  nodeIndex: number;
  elbow: DuctElbow;
  /** Polyline length the fitting consumes on each adjacent leg (setback + neck). */
  consumeMm: number;
}

function vaneCount(inPlaneWidthMm: number, spacingMm: number): number {
  return Math.max(1, Math.ceil(inPlaneWidthMm / spacingMm) - 1);
}

function buildElbow(
  style: 'radius' | 'square-vaned',
  corner: Point2D,
  incoming: DuctLegGeometry,
  outgoing: DuctLegGeometry,
  section: DuctLeg,
  ratio: number,
  settings: DuctDesignSettings,
): DuctElbow {
  const geometry = style === 'radius'
    ? radiusElbowGeometry(corner, incoming.direction, outgoing.direction, ratio * section.widthMm, settings.elbowNeckMm)
    : squareElbowGeometry(corner, incoming.direction, outgoing.direction, section.widthMm, settings.elbowNeckMm);
  return { ...geometry, style, vaneCount: style === 'square-vaned' ? vaneCount(section.widthMm, settings.vaneSpacingMm) : 0 };
}

/** Choose each elbow's style so its setbacks fit the legs where possible (auto). */
function planFittings(spec: DuctRunSpec, legs: DuctLegGeometry[], startReserveMm: number, settings: DuctDesignSettings, issues: DuctIssue[]): Map<number, NodeFitting> {
  const fittings = new Map<number, NodeFitting>();
  const radiusConsume = (node: number): number => {
    const incoming = legs[node - 1];
    const outgoing = legs[node];
    if (!incoming || !outgoing) return 0;
    const angle = turnAngleDeg(incoming.direction, outgoing.direction);
    if (angle < TURN_EPSILON_DEG) return 0;
    const ratio = spec.nodeOverrides[String(node)]?.centrelineRatio ?? settings.elbowCentrelineRatio;
    const radius = ratio * spec.legs[node - 1]!.widthMm;
    return radius * Math.tan((angle * Math.PI) / 360) + settings.elbowNeckMm;
  };
  for (let node = 1; node < spec.path.length - 1; node += 1) {
    const incoming = legs[node - 1]!;
    const outgoing = legs[node]!;
    const angle = turnAngleDeg(incoming.direction, outgoing.direction);
    if (angle < TURN_EPSILON_DEG) continue;
    const section = spec.legs[node - 1]!;
    const ratio = spec.nodeOverrides[String(node)]?.centrelineRatio ?? settings.elbowCentrelineRatio;
    const requested = spec.nodeOverrides[String(node)]?.elbowStyle ?? settings.elbowStyle;
    const squareAllowed = Math.abs(angle - 90) < TURN_EPSILON_DEG;
    const before = node === 1 ? startReserveMm : (fittings.get(node - 1)?.consumeMm ?? 0);
    const after = node + 1 < spec.path.length - 1 ? radiusConsume(node + 1) : 0;
    const radius = buildElbow('radius', spec.path[node]!, incoming, outgoing, section, ratio, settings);
    const radiusConsumeMm = radius.setbackMm + radius.neckMm;
    const radiusFits = incoming.lengthMm + STATION_EPSILON_MM >= before + radiusConsumeMm
      && outgoing.lengthMm + STATION_EPSILON_MM >= radiusConsumeMm + after;
    let style: 'radius' | 'square-vaned' = 'radius';
    if (requested === 'square-vaned' && squareAllowed) style = 'square-vaned';
    else if (requested === 'auto' && !radiusFits && squareAllowed) style = 'square-vaned';
    const elbow = style === 'radius' ? radius : buildElbow('square-vaned', spec.path[node]!, incoming, outgoing, section, ratio, settings);
    fittings.set(node, { nodeIndex: node, elbow, consumeMm: elbow.setbackMm + elbow.neckMm });
    if (requested === 'square-vaned' && !squareAllowed) {
      issues.push({ code: 'DU_LEG_TOO_SHORT', severity: 'info', nodeIndex: node, point: spec.path[node],
        message: `A ${Math.round(angle)}° turn is made as a radius elbow; square vaned elbows are for 90° turns.` });
    }
  }
  return fittings;
}

export interface PlanDuctRunOptions {
  settings: DuctDesignSettings;
  scene: readonly HvacElement[];
}

export function planDuctRun(element: HvacElement, options: PlanDuctRunOptions): DuctFabricationPlan | null {
  const spec = readDuctRunSpec(element);
  if (!spec) return null;
  return planDuctRunSpec(element.id, spec, options);
}

export function planDuctRunSpec(elementId: string, spec: DuctRunSpec, options: PlanDuctRunOptions): DuctFabricationPlan {
  const { settings, scene } = options;
  const issues: DuctIssue[] = [];
  const unverified = new Set<string>([UNVERIFIED.allowances, UNVERIFIED.elbow]);
  const legs = ductLegs(spec);
  const polylineLengthMm = legs.reduce((total, leg) => total + leg.lengthMm, 0);

  // Section construction per leg (identical sizes share one resolution).
  const constructionCache = new Map<string, SectionConstruction>();
  const constructionByLeg = spec.legs.map((leg) => {
    const key = `${leg.widthMm}x${leg.heightMm}`;
    let construction = constructionCache.get(key);
    if (!construction) {
      construction = resolveSectionConstruction({
        widthMm: leg.widthMm, heightMm: leg.heightMm, service: spec.service, construction: spec.construction,
        settings, pressureClassPa: spec.pressureClassPa, jointSystem: spec.jointSystem,
      });
      constructionCache.set(key, construction);
    }
    return construction;
  });
  const statusIssue: Record<Exclude<SectionConstruction['status'], 'ok'>, DuctIssueCode> = {
    'unsupported-pressure': 'DU_PRESSURE_UNSUPPORTED',
    'size-over-table': 'DU_SIZE_OVER_TABLE',
    'no-stock': 'DU_NO_STOCK',
    'joint-not-achievable': 'DU_GAUGE_JOINT',
  };
  for (const construction of new Set(constructionByLeg)) {
    if (construction.status !== 'ok') {
      issues.push({ code: statusIssue[construction.status], severity: 'error', message: construction.message ?? construction.status });
      continue;
    }
    if (construction.intermediate) {
      issues.push({ code: 'DU_INTERMEDIATE_REINF', severity: 'warning',
        message: `Intermediate reinforcement class ${construction.intermediate.cls} at ${construction.intermediate.spacingMm} mm (Table 1-10M member).` });
    }
    if (construction.crossBreak.width || construction.crossBreak.height) {
      issues.push({ code: 'DU_CROSS_BREAK', severity: 'info', message: 'Cross-break or bead the wide sides (SMACNA S1.15).' });
    }
    if (construction.joint?.system === 'tdc') unverified.add(UNVERIFIED.tdcCleats);
  }
  if (spec.legs.some((leg) => leg.widthMm !== spec.legs[0]!.widthMm || leg.heightMm !== spec.legs[0]!.heightMm)) {
    issues.push({ code: 'DU_SIZE_CHANGE_PENDING', severity: 'warning', message: 'Size changes need a transition; transitions are fabricated from phase 2.' });
  }
  legs.forEach((leg) => {
    if (leg.sloped) {
      issues.push({ code: 'DU_VERTICAL_PENDING', severity: 'warning', legIndex: leg.index,
        message: 'Rising or falling legs are fabricated from phase 3; this leg is drawn level.' });
    }
  });

  // Start: the unit collar.
  let startPort: DuctAirPort | null = null;
  let connectorLengthMm = 0;
  const firstLeg = spec.legs[0]!;
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
      if (Math.abs(startPort.widthMm - firstLeg.widthMm) > 1 || Math.abs(startPort.heightMm - firstLeg.heightMm) > 1) {
        issues.push({ code: 'DU_MOUTH_MISMATCH', severity: 'warning', point: spec.path[0],
          message: `Duct ${firstLeg.widthMm}×${firstLeg.heightMm} differs from the collar ${startPort.widthMm}×${startPort.heightMm}; a transition is needed (phase 2).` });
      }
    }
    if (spec.start.connector && settings.flexibleConnectorAtUnit && !spec.legacy) {
      connectorLengthMm = settings.connectorFabricMm + 2 * settings.connectorMetalMm;
      unverified.add(UNVERIFIED.connector);
    }
    unverified.add(UNVERIFIED.slipOver);
  }
  if (spec.end.kind === 'open' && !spec.legacy) {
    issues.push({ code: 'DU_OPEN_END', severity: 'info', point: spec.path[spec.path.length - 1], message: 'The run ends open.' });
  }

  const fittings = planFittings(spec, legs, connectorLengthMm, settings, issues);

  // Walk the legs, laying pieces along the polyline stations.
  const pieces: DuctPiece[] = [];
  const counters = { S: 0, E: 0, C: 0, K: 0 };
  const mark = (prefix: keyof typeof counters) => {
    counters[prefix] += 1;
    return `${prefix}-${String(counters[prefix]).padStart(prefix === 'S' ? 3 : 2, '0')}`;
  };
  const sheetOf = (legIndex: number) => constructionByLeg[legIndex]?.sheetThicknessMm ?? null;
  const flangeRollEnds = (legIndex: number) => (constructionByLeg[legIndex]?.joint?.system === 'tdc' ? 2 : 0);
  const massOf = (areaM2: number, legIndex: number) => {
    const sheet = sheetOf(legIndex);
    return sheet === null ? 0 : areaM2 * galvanisedSheetMassKgPerM2(sheet);
  };
  const levelOf = (legIndex: number) => spec.path[legIndex]!.z;

  let station = 0;
  legs.forEach((leg, legIndex) => {
    const section = spec.legs[legIndex]!;
    const bottomZ = levelOf(legIndex);
    const centreZ = bottomZ + section.heightMm / 2;
    const at = (distance: number) => add(leg.start, scale(leg.direction, distance));
    const startFitting = fittings.get(legIndex);
    const endFitting = fittings.get(legIndex + 1);
    let cursor = legIndex === 0 ? 0 : (startFitting?.consumeMm ?? 0);

    if (legIndex === 0 && connectorLengthMm > 0) {
      const length = Math.min(connectorLengthMm, leg.lengthMm);
      const o = outer(section, sheetOf(0));
      const girth = 2 * (o.w + o.h);
      const metalArea = (girth * 2 * settings.connectorMetalMm) / 1e6;
      pieces.push({
        mark: mark('C'), kind: 'connector', legIndex, start: at(0), end: at(length), direction: leg.direction,
        stationStartMm: station, stationEndMm: station + length, lengthMm: length,
        widthMm: section.widthMm, heightMm: section.heightMm, bottomZ, centreZ, connectorMetalMm: settings.connectorMetalMm,
        sheetThicknessMm: sheetOf(0), sheetAreaM2: metalArea, fabricAreaM2: (girth * settings.connectorFabricMm) / 1e6,
        massKg: massOf(metalArea, 0),
      });
      cursor = length;
    }

    const endReserve = endFitting ? endFitting.consumeMm : 0;
    const available = leg.lengthMm - cursor - endReserve;
    if (available < -STATION_EPSILON_MM) {
      issues.push({ code: 'DU_LEG_TOO_SHORT', severity: 'error', legIndex, point: at(leg.lengthMm / 2),
        message: `Leg ${legIndex + 1} is ${Math.round(-available)} mm too short for its fittings.` });
    }
    const span = Math.max(0, available);
    const lengths: number[] = [];
    if (span > STATION_EPSILON_MM) {
      const full = Math.floor((span + STATION_EPSILON_MM) / settings.sectionLengthMm);
      const remainder = span - full * settings.sectionLengthMm;
      for (let index = 0; index < full; index += 1) lengths.push(settings.sectionLengthMm);
      if (remainder > STATION_EPSILON_MM) {
        if (remainder < settings.minMakeUpPieceMm && full >= 1) {
          const shared = (settings.sectionLengthMm + remainder) / 2;
          lengths.splice(lengths.length - 1, 1, shared, shared);
        } else {
          lengths.push(remainder);
        }
      }
    }
    lengths.forEach((length, index) => {
      const start = cursor;
      const end = cursor + length;
      const area = straightAreaM2(section, sheetOf(legIndex), length, flangeRollEnds(legIndex));
      pieces.push({
        mark: mark('S'), kind: 'straight', legIndex, start: at(start), end: at(end), direction: leg.direction,
        stationStartMm: station + start, stationEndMm: station + end, lengthMm: length,
        widthMm: section.widthMm, heightMm: section.heightMm, bottomZ, centreZ,
        isMakeUp: length < settings.sectionLengthMm - STATION_EPSILON_MM && (index >= lengths.length - 2),
        sheetThicknessMm: sheetOf(legIndex), sheetAreaM2: area, fabricAreaM2: 0, massKg: massOf(area, legIndex),
      });
      cursor = end;
    });

    if (endFitting) {
      const elbow = endFitting.elbow;
      const nodeStation = station + leg.lengthMm;
      const area = elbowAreaM2(elbow, section, sheetOf(legIndex), flangeRollEnds(legIndex));
      pieces.push({
        mark: mark('E'), kind: 'elbow', legIndex, nodeIndex: endFitting.nodeIndex,
        start: elbow.startPoint, end: elbow.endPoint, direction: leg.direction,
        stationStartMm: nodeStation - endFitting.consumeMm, stationEndMm: nodeStation + endFitting.consumeMm,
        lengthMm: pieceLength(elbow), widthMm: section.widthMm, heightMm: section.heightMm, bottomZ, centreZ, elbow,
        sheetThicknessMm: sheetOf(legIndex), sheetAreaM2: area, fabricAreaM2: 0, massKg: massOf(area, legIndex),
      });
    }
    station += leg.lengthMm;
  });

  const lastLegIndex = legs.length - 1;
  const lastLeg = legs[lastLegIndex]!;
  if (spec.end.kind === 'end-cap') {
    const section = spec.legs[lastLegIndex]!;
    const o = outer(section, sheetOf(lastLegIndex));
    const area = (o.w * o.h + 2 * (o.w + o.h) * TDC_FLANGE_ROLL_MM) / 1e6;
    const bottomZ = levelOf(lastLegIndex);
    pieces.push({
      mark: mark('K'), kind: 'end-cap', legIndex: lastLegIndex, start: lastLeg.end, end: lastLeg.end, direction: lastLeg.direction,
      stationStartMm: polylineLengthMm, stationEndMm: polylineLengthMm, lengthMm: 0,
      widthMm: section.widthMm, heightMm: section.heightMm, bottomZ, centreZ: bottomZ + section.heightMm / 2,
      sheetThicknessMm: sheetOf(lastLegIndex), sheetAreaM2: area, fabricAreaM2: 0, massKg: massOf(area, lastLegIndex),
    });
  }

  // Joints between consecutive pieces, plus the unit connection.
  const joints: DuctJoint[] = [];
  const hardwareFor = (legIndex: number, section: DuctLeg): JointHardware | null => {
    const construction = constructionByLeg[legIndex];
    if (!construction || construction.status !== 'ok' || !construction.joint) return null;
    const o = outer(section, construction.sheetThicknessMm);
    return jointHardware(construction.joint, {
      sideAMm: o.w, sideBMm: o.h, pressureClassPa: construction.pressureClassPa, washersPerBolt: settings.washersPerBolt,
    });
  };
  const pushJoint = (kind: DuctJointKind, stationMm: number, point: Point2D, direction: Point2D, legIndex: number, between: [string | null, string | null], hardware: JointHardware | null) => {
    const section = spec.legs[legIndex]!;
    const o = outer(section, sheetOf(legIndex));
    joints.push({
      id: `${elementId}:J${joints.length + 1}`, kind, stationMm, point, direction,
      centreZ: levelOf(legIndex) + section.heightMm / 2,
      widthMm: section.widthMm, heightMm: section.heightMm, outerWidthMm: o.w, outerHeightMm: o.h,
      between, hardware,
    });
  };
  if (spec.start.kind === 'unit-port' && pieces[0]) {
    const first = pieces[0];
    const o = outer(spec.legs[0]!, sheetOf(0));
    pushJoint('unit-connection', 0, first.start, first.direction, 0, [null, first.mark],
      slipOverHardware({ sideAMm: o.w, sideBMm: o.h, pressureClassPa: constructionByLeg[0]?.pressureClassPa ?? 0, washersPerBolt: settings.washersPerBolt }));
  }
  for (let index = 1; index < pieces.length; index += 1) {
    const previous = pieces[index - 1]!;
    const next = pieces[index]!;
    pushJoint(next.kind === 'end-cap' ? 'end-cap' : 'flange', next.stationStartMm, next.start, next.direction, next.legIndex,
      [previous.mark, next.mark], hardwareFor(next.legIndex, spec.legs[next.legIndex]!));
  }

  const totals = pieces.reduce((sum, piece) => ({
    sheetAreaM2: sum.sheetAreaM2 + piece.sheetAreaM2,
    fabricAreaM2: sum.fabricAreaM2 + piece.fabricAreaM2,
    massKg: sum.massKg + piece.massKg,
  }), { sheetAreaM2: 0, fabricAreaM2: 0, massKg: 0 });

  return {
    elementId,
    spec,
    status: issues.some((issue) => issue.severity === 'error') ? 'error' : 'ok',
    constructionByLeg,
    startPort,
    pieces,
    joints,
    issues,
    polylineLengthMm,
    totals,
    unverifiedRules: [...unverified],
  };
}

/** Memoised plans: keyed by the element object, the settings object and the start unit. */
const PLAN_CACHE = new WeakMap<HvacElement, { settings: DuctDesignSettings; unit: HvacElement | undefined; plan: DuctFabricationPlan | null }>();

export function getDuctRunPlan(element: HvacElement, scene: readonly HvacElement[], settings: DuctDesignSettings): DuctFabricationPlan | null {
  const spec = readDuctRunSpec(element);
  const unitId = spec?.start.kind === 'unit-port' ? spec.start.unitId : null;
  const unit = unitId ? scene.find((candidate) => candidate.id === unitId) : undefined;
  const cached = PLAN_CACHE.get(element);
  if (cached && cached.settings === settings && cached.unit === unit) return cached.plan;
  const plan = spec ? planDuctRunSpec(element.id, spec, { settings, scene }) : null;
  PLAN_CACHE.set(element, { settings, unit, plan });
  return plan;
}
