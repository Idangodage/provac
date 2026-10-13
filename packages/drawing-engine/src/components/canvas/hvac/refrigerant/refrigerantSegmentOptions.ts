/**
 * What a refrigerant piece's card offers, and what each choice would do.
 *
 * Options are edits through the pipe engine's own builders, so what is
 * previewed is exactly what is applied:
 *  - size: one ACR copper size down or up, or the profile's size (with no
 *    sizing table loaded the card says so) — for the line in focus; a pair's
 *    gas and liquid lines are sized apart;
 *  - the line's bends: socket elbows or formed bends, and a formed bend's
 *    radius as a multiple of the insulated outside;
 *  - a 90° bend made two 45°s with a short straight between them;
 *  - a bend turned into another plane (rolled 90° about its incoming leg);
 *  - a straight's length (its start or its end held), level and sideways
 *    offset — re-solved by the adaptive engine (bends re-angle, risers and
 *    offsets regenerate at fixed ports); a pair's two lines move together;
 *  - insulation, and a leg's copper (hard or flexible);
 *  - a point added at a straight's middle, or a bend taken out;
 *  - a branch kit slid along its run (a pair's gas and liquid kits together),
 *    its pipes following as they do when it is dragged; turned over (only
 *    while no pipe holds it: turning it over moves its ports across the pair)
 *    or another model (listed with why not: the library draws one kit).
 *
 * Each is evaluated on a copy of the drawing: the elements it changes, what
 * else the engine had to change (notes), the change in length and (on a
 * liquid line) in charge, and the design checks it newly fails — or refused,
 * with the engine's own reason.
 *
 * PURE: elements in, options and evaluations out (cached per drawing).
 */
import type { HvacElement } from '../../../../types';
import { PROJECT_FALLBACK_RULE_PROFILE, type ManufacturerRuleProfile } from '../../../../vrf/rules/rule-profile';
import { validateHvacElementsAsVrf } from '../../hooks/useVrfLiveValidation';
import { resolveCopperSocketElbow } from '../copperSocketElbows';
import { readPipeDesign, insertDesignJoint, designWithNodePositions, designRouteNodes } from '../pipeDesignModel';
import { resolvePipeEditFrame } from '../pipeEditGeometry';
import {
  buildAdaptivePipeEdit,
  buildPipeModelEdit,
  buildPipeTopologyEdit,
  editablePipeNodes,
  pipeDesignSkeleton,
  pipeWithEditedDesign,
  pipeWithEditedNodes,
  summarizePipeAdaptations,
  validatePipeBendSpace,
} from '../pipeEditModel';
import type { Vec3 } from '../pipePortFrame';
import { getActivePipeRoutingSettings } from '../pipeRoutingSettings';
import { refrigerantChangeIssues } from '../refrigerantChangeValidation';
import { resolveRefrigerantPipeBranchKitReconnectionUpdates, resolveRefrigerantPipeSpec } from '../refrigerantPipePairModel';
import type { SegmentEvaluationLike, SegmentOptionLike } from '../segments/segmentProvider';

import { refrigerantKitOf } from './refrigerantKits';
import { COPPER_TUBE_SERIES_MM, copperInchLabel, liquidChargeKgPerM, refrigerantCircuitFigures } from './refrigerantPieceFigures';
import { pieceMidpoint, type RefrigerantLine, type RefrigerantPiece } from './refrigerantPieces';

export type RefrigerantOptionGroup =
  | 'size' | 'construction' | 'radius' | 'split-bend' | 'plane'
  | 'length' | 'level' | 'offset' | 'insulation' | 'material' | 'add-point' | 'remove-bend'
  | 'kit-slide' | 'kit-flip' | 'kit-model';

export type RefrigerantPieceEdit =
  | { kind: 'size'; elementId: string; tubeOdMm: number }
  | { kind: 'insulation'; elementId: string; thicknessMm: number }
  | { kind: 'construction'; elementId: string; construction: 'socket-elbow' | 'formed-bend' }
  | { kind: 'radius'; elementId: string; factor: number }
  | { kind: 'split-bend'; elementId: string; jointId: string; chamferMm: number }
  | { kind: 'roll-bend'; elementId: string; jointId: string; angleDeg: number }
  | { kind: 'move-legs'; moves: Array<{ elementId: string; legId: string }>; offset: Vec3 }
  | { kind: 'leg-length'; moves: Array<{ elementId: string; legId: string }>; deltaMm: number; keep: 'start' | 'end' }
  | { kind: 'material'; elementId: string; legId: string; material: 'hard' | 'flexible' }
  | { kind: 'add-point'; elementId: string; point: { x: number; y: number } }
  | { kind: 'remove-bend'; elementId: string; point: { x: number; y: number } }
  | { kind: 'kit-slide'; kitIds: string[]; offset: { x: number; y: number } }
  | { kind: 'kit-flip'; kitIds: string[] }
  | { kind: 'kit-model'; kitIds: string[] };

export type RefrigerantOptionGlyph = 'size-down' | 'size-up' | 'size' | 'socket' | 'formed' | 'radius' | 'split' | 'roll'
  | 'level' | 'offset' | 'length' | 'insulation' | 'hard' | 'flexible' | 'add-point' | 'remove-bend' | 'slide' | 'flip' | 'kit';

export interface RefrigerantSegmentOption extends SegmentOptionLike {
  group: RefrigerantOptionGroup;
  glyph: RefrigerantOptionGlyph;
  edit: RefrigerantPieceEdit;
}

export interface RefrigerantOptionEvaluation extends SegmentEvaluationLike {
  /** Change in the centreline length of the lines it changes (mm). */
  deltaLengthMm: number;
  /** On a liquid line, the change in its additional charge (kg; practice table, unverified). */
  deltaChargeKg: number | null;
}

/** The pair's other line and its piece alongside (geometry edits move both lines together). */
export interface RefrigerantPartner {
  element: HvacElement;
  line: RefrigerantLine;
  piece: RefrigerantPiece;
}

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const LOCK_KEYS = ['routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed'];

/** Insulation thicknesses offered (mm): the model's minimum (1″) and thicker, for warm and humid ceilings. */
export const INSULATION_STEPS_MM = [25.4, 32, 38, 50];
/** A formed bend's centreline radius as a multiple of the insulated outside. */
export const RADIUS_FACTORS = [1, 1.5, 2, 3];

// ---------------------------------------------------------------------------------------------------- applying an edit

type EditResult = { ok: true; elements: HvacElement[]; action: string; notes: string[] } | { ok: false; message: string };

/** The element with new properties, its bounds and level re-derived (its route unchanged). */
function withProperties(element: HvacElement, properties: Record<string, unknown>): HvacElement {
  const next = { ...element, properties: { ...element.properties, ...properties } };
  return pipeWithEditedNodes(next, editablePipeNodes(next));
}

/** The skeleton leg the design leg is, by its two ends (the adaptive engine works on skeleton indices). */
function skeletonLegIndex(element: HvacElement, scene: readonly HvacElement[], legId: string): number | null {
  const design = readPipeDesign(element, scene);
  const index = design.legs.findIndex((leg) => leg.id === legId);
  if (index < 0) return null;
  const from = design.nodes[index]!;
  const to = design.nodes[index + 1]!;
  const skeleton = pipeDesignSkeleton(element);
  let bestIndex = -1;
  let bestError = Infinity;
  skeleton.legs.forEach((_, legIndex) => {
    const error = distance(skeleton.nodes[legIndex]!, from) + distance(skeleton.nodes[legIndex + 1]!, to);
    if (error < bestError) {
      bestIndex = legIndex;
      bestError = error;
    }
  });
  return bestIndex >= 0 && bestError < 5 ? bestIndex : null;
}

function locked(element: HvacElement): boolean {
  return LOCK_KEYS.some((key) => element.properties[key] === true);
}

/** Held to the standard the line arrived with: an edit may not make its fittings worse than they were. */
function fittingConflict(before: HvacElement, after: HvacElement): string | null {
  const conflict = validatePipeBendSpace(after, editablePipeNodes(after), editablePipeNodes(before));
  if (!conflict) return null;
  return validatePipeBendSpace(before, editablePipeNodes(before), []) ? null : conflict;
}

// ---------------------------------------------------------------------------------------------------- branch kits

/** A pipe end held by a kit: the pipe, which end, and the kit port it is on. */
export interface KitPipeEnd {
  pipe: HvacElement;
  endpoint: 'start' | 'end';
  role: string;
}

const ROLE_WORDS: Record<string, string> = { inlet: 'inlet', 'run-outlet': 'run outlet', 'branch-outlet': 'branch outlet' };

/** The pipe ends the kits hold. */
export function kitPipeEnds(scene: readonly HvacElement[], kitIds: readonly string[]): KitPipeEnd[] {
  const ends: KitPipeEnd[] = [];
  for (const pipe of scene) {
    if (pipe.type !== 'refrigerant-pipe') continue;
    const spec = resolveRefrigerantPipeSpec(pipe.properties);
    for (const endpoint of ['start', 'end'] as const) {
      const connection = endpoint === 'start' ? spec.startConnection : spec.endConnection;
      if (connection?.sourceElementId && kitIds.includes(connection.sourceElementId)) {
        ends.push({ pipe, endpoint, role: connection.terminalRole ?? 'port' });
      }
    }
  }
  return ends;
}

/**
 * The other line's kit of a pair: the kit on the same port of the partner line (the pipes of a pair share a bundle).
 * Null for a kit that splits both lines, or one whose partner line is not on a kit.
 */
export function kitPartnerOf(kit: HvacElement, scene: readonly HvacElement[]): HvacElement | null {
  const own = refrigerantKitOf(kit);
  if (!own || own.lines.length !== 1) return null;
  for (const end of kitPipeEnds(scene, [kit.id])) {
    const bundleId = end.pipe.properties.bundleId;
    if (typeof bundleId !== 'string') continue;
    const partnerPipe = scene.find((candidate) => candidate.id !== end.pipe.id && candidate.type === 'refrigerant-pipe'
      && candidate.properties.bundleId === bundleId && candidate.properties.lineKind !== end.pipe.properties.lineKind);
    if (!partnerPipe) continue;
    const spec = resolveRefrigerantPipeSpec(partnerPipe.properties);
    const connection = end.endpoint === 'start' ? spec.startConnection : spec.endConnection;
    const partner = connection?.sourceElementId ? scene.find((candidate) => candidate.id === connection.sourceElementId) : null;
    const partnerKit = partner ? refrigerantKitOf(partner) : null;
    if (partner && partnerKit && partnerKit.lines.length === 1 && partnerKit.lines[0] !== own.lines[0]) return partner;
  }
  return null;
}

/** Why the kits cannot slide by `offset`: a pipe at them leaves sideways, or has too little straight to give. */
function kitSlideConflict(scene: readonly HvacElement[], kitIds: readonly string[], offset: { x: number; y: number }): string | null {
  const stubMm = getActivePipeRoutingSettings().minimumPortStubMm;
  for (const end of kitPipeEnds(scene, kitIds)) {
    const spec = resolveRefrigerantPipeSpec(end.pipe.properties);
    const points = end.endpoint === 'start' ? spec.routePoints : [...spec.routePoints].reverse();
    const at = points[0];
    const next = at ? points.slice(1).find((point) => Math.hypot(point.x - at.x, point.y - at.y) > 1) : undefined;
    if (!at || !next) continue;
    const leg = { x: next.x - at.x, y: next.y - at.y };
    const length = Math.hypot(leg.x, leg.y);
    const after = { x: leg.x - offset.x, y: leg.y - offset.y };
    const along = (after.x * leg.x + after.y * leg.y) / length;
    const across = Math.abs(after.x * leg.y - after.y * leg.x) / length;
    const where = `the ${spec.lineKind} pipe on its ${ROLE_WORDS[end.role] ?? 'port'}`;
    if (across > 1) return `${where[0]!.toUpperCase()}${where.slice(1)} leaves it sideways: sliding the kit would skew it.`;
    if (along < Math.min(stubMm, length) - 0.5) {
      return `${where[0]!.toUpperCase()}${where.slice(1)} has ${Math.round(length)} mm of straight there: not enough to slide ${Math.round(Math.hypot(offset.x, offset.y))} mm that way.`;
    }
  }
  return null;
}

/** The kits slid by `offset` and the pipes on them re-attached (as dragging them does). */
function slideKits(scene: readonly HvacElement[], kitIds: readonly string[], offset: { x: number; y: number }): EditResult {
  const conflict = kitSlideConflict(scene, kitIds, offset);
  if (conflict) return { ok: false, message: conflict };
  let working = [...scene];
  const changed = new Map<string, HvacElement>();
  for (const kitId of kitIds) {
    const kit = working.find((candidate) => candidate.id === kitId);
    if (!kit) return { ok: false, message: 'The kit is no longer in the drawing.' };
    if (locked(kit)) return { ok: false, message: 'This kit is locked. Unlock it before moving it.' };
    const moved = { ...kit, position: { x: kit.position.x + offset.x, y: kit.position.y + offset.y } };
    changed.set(moved.id, moved);
    working = working.map((candidate) => (candidate.id === moved.id ? moved : candidate));
    for (const update of resolveRefrigerantPipeBranchKitReconnectionUpdates(working, moved)) {
      const base = working.find((candidate) => candidate.id === update.id);
      if (!base) continue;
      const next = { ...base, ...update.updates, properties: update.updates.properties ? { ...base.properties, ...update.updates.properties } : base.properties };
      if (locked(base)) return { ok: false, message: 'A pipe on the kit is locked. Unlock it before moving the kit.' };
      changed.set(next.id, next);
      working = working.map((candidate) => (candidate.id === next.id ? next : candidate));
    }
  }
  for (const element of changed.values()) {
    const before = scene.find((candidate) => candidate.id === element.id);
    if (!before || before.type !== 'refrigerant-pipe') continue;
    const fault = fittingConflict(before, element);
    if (fault) return { ok: false, message: fault };
  }
  const pipes = [...changed.values()].filter((element) => element.type === 'refrigerant-pipe').length;
  return {
    ok: true, elements: [...changed.values()], action: kitIds.length > 1 ? 'Slide branch kits' : 'Slide branch kit',
    notes: [`${kitIds.length > 1 ? 'both kits of the pair · ' : ''}${pipes} pipe${pipes === 1 ? '' : 's'} follow${pipes === 1 ? 's' : ''}`],
  };
}

function applyEdit(scene: readonly HvacElement[], edit: RefrigerantPieceEdit): EditResult {
  const find = (id: string) => scene.find((candidate) => candidate.id === id);
  switch (edit.kind) {
    case 'size': {
      const element = find(edit.elementId);
      if (!element) return { ok: false, message: 'The line is no longer in the drawing.' };
      if (locked(element)) return { ok: false, message: 'This line is locked. Unlock it before resizing it.' };
      const spec = resolveRefrigerantPipeSpec(element.properties);
      const next = withProperties(element, {
        pipeDiameterMm: edit.tubeOdMm, nominal_diameter_mm: edit.tubeOdMm,
        outerDiameterMm: edit.tubeOdMm + 2 * spec.insulationThicknessMm,
      });
      const conflict = fittingConflict(element, next);
      if (conflict) return { ok: false, message: conflict };
      return { ok: true, elements: [next], action: `Resize ${spec.lineKind} line to Ø${edit.tubeOdMm.toFixed(2)}`, notes: ['its socket elbows and port fittings follow the new size'] };
    }
    case 'insulation': {
      const element = find(edit.elementId);
      if (!element) return { ok: false, message: 'The line is no longer in the drawing.' };
      const spec = resolveRefrigerantPipeSpec(element.properties);
      const next = withProperties(element, { insulationThicknessMm: edit.thicknessMm, outerDiameterMm: spec.pipeDiameterMm + 2 * edit.thicknessMm });
      return { ok: true, elements: [next], action: `${spec.lineKind === 'gas' ? 'Gas' : 'Liquid'} line insulation ${edit.thicknessMm} mm`, notes: [] };
    }
    case 'construction':
    case 'radius': {
      const element = find(edit.elementId);
      if (!element) return { ok: false, message: 'The line is no longer in the drawing.' };
      if (locked(element)) return { ok: false, message: 'This line is locked. Unlock it before changing its bends.' };
      const next = edit.kind === 'construction'
        ? withProperties(element, { fieldBendConstruction: edit.construction === 'formed-bend' ? 'formed-tube' : undefined })
        : withProperties(element, { bendRadiusFactor: edit.factor, fieldBendConstruction: 'formed-tube' });
      const conflict = fittingConflict(element, next);
      if (conflict) return { ok: false, message: conflict };
      return {
        ok: true, elements: [next],
        action: edit.kind === 'construction' ? (edit.construction === 'formed-bend' ? 'Formed bends' : 'Socket elbows') : `Bend radius ${edit.factor} × outside`,
        notes: ['every bend of this line'],
      };
    }
    case 'split-bend': {
      const element = find(edit.elementId);
      if (!element) return { ok: false, message: 'The line is no longer in the drawing.' };
      if (locked(element)) return { ok: false, message: 'This line is locked. Unlock it before editing it.' };
      const design = readPipeDesign(element, scene);
      const joint = design.joints.find((candidate) => candidate.id === edit.jointId);
      const index = joint ? design.nodes.findIndex((node) => node.id === joint.nodeId) : -1;
      if (!joint || index <= 0 || index >= design.nodes.length - 1) return { ok: false, message: 'This bend is no longer on the line.' };
      const incoming = design.legs[index - 1]!;
      const outgoing = design.legs[index]!;
      if (incoming.lengthMm <= edit.chamferMm + 1 || outgoing.lengthMm <= edit.chamferMm + 1) {
        return { ok: false, message: `Two 45° bends need ${Math.round(edit.chamferMm)} mm of straight on each side of the corner.` };
      }
      const corner = design.nodes[index]!;
      // One new corner back along the incoming leg, the old one moved on along the outgoing leg: the 45° straight between.
      const inserted = insertDesignJoint(design, incoming.id, add(corner, scale(incoming.direction, -edit.chamferMm)));
      if (!inserted.ok) return { ok: false, message: inserted.message };
      const nodes = designRouteNodes(inserted.design);
      const cornerIndex = inserted.design.nodes.findIndex((node) => node.id === corner.id);
      nodes[cornerIndex] = add(corner, scale(outgoing.direction, edit.chamferMm));
      const next = pipeWithEditedDesign(element, designWithNodePositions(inserted.design, nodes));
      const conflict = fittingConflict(element, next);
      if (conflict) return { ok: false, message: conflict };
      return { ok: true, elements: [next], action: 'Two 45° bends', notes: [`a ${Math.round(edit.chamferMm * Math.SQRT2)} mm straight between them`] };
    }
    case 'roll-bend': {
      const element = find(edit.elementId);
      if (!element) return { ok: false, message: 'The line is no longer in the drawing.' };
      const design = readPipeDesign(element, scene);
      const joint = design.joints.find((candidate) => candidate.id === edit.jointId);
      const index = joint ? design.nodes.findIndex((node) => node.id === joint.nodeId) : -1;
      if (index <= 0) return { ok: false, message: 'This bend is no longer on the line.' };
      const nodes = designRouteNodes(design);
      const selection = { kind: 'node' as const, index };
      const frame = resolvePipeEditFrame({ mode: 'world', nodes, selection });
      if (!frame) return { ok: false, message: 'This bend has no frame to turn in.' };
      const result = buildPipeModelEdit({ elementId: element.id, elements: scene, selection, frame, mode: 'adaptive',
        operation: { kind: 'rotate', axis: 'x', angleDegrees: edit.angleDeg, pivot: 'start' } });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, elements: result.elements, action: 'Turn bend', notes: result.adaptations?.length ? [summarizePipeAdaptations(result.adaptations, result.clampedTo) ?? ''].filter(Boolean) : [] };
    }
    case 'move-legs':
    case 'leg-length': {
      let working = [...scene];
      const changed = new Map<string, HvacElement>();
      const notes: string[] = [];
      for (const move of edit.moves) {
        const element = working.find((candidate) => candidate.id === move.elementId);
        if (!element) return { ok: false, message: 'The line is no longer in the drawing.' };
        const legIndex = skeletonLegIndex(element, working, move.legId);
        if (legIndex === null) return { ok: false, message: 'This straight is no longer on the line.' };
        let goal: Parameters<typeof buildAdaptivePipeEdit>[0]['goal'];
        if (edit.kind === 'move-legs') goal = { kind: 'move-leg', legIndex, offset: edit.offset };
        else {
          const skeleton = pipeDesignSkeleton(element);
          const from = skeleton.nodes[legIndex]!;
          const to = skeleton.nodes[legIndex + 1]!;
          const length = distance(from, to);
          if (length < 1) return { ok: false, message: 'This straight has no length to change.' };
          const direction = scale({ x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }, 1 / length);
          goal = edit.keep === 'start'
            ? { kind: 'move-node', nodeIndex: legIndex + 1, target: add(to, scale(direction, edit.deltaMm)) }
            : { kind: 'move-node', nodeIndex: legIndex, target: add(from, scale(direction, -edit.deltaMm)) };
        }
        const result = buildAdaptivePipeEdit({ elementId: element.id, elements: working, goal });
        if (!result.ok) return { ok: false, message: result.message };
        for (const updated of [result.element, ...result.elementUpdates]) {
          changed.set(updated.id, updated);
          working = working.map((candidate) => (candidate.id === updated.id ? updated : candidate));
        }
        const summary = summarizePipeAdaptations(result.adaptations, result.clampedTo);
        if (summary) notes.push(edit.moves.length > 1 ? `${resolveRefrigerantPipeSpec(element.properties).lineKind}: ${summary}` : summary);
      }
      return { ok: true, elements: [...changed.values()], action: edit.kind === 'move-legs' ? 'Move straight' : 'Straight length', notes };
    }
    case 'material': {
      const element = find(edit.elementId);
      if (!element) return { ok: false, message: 'The line is no longer in the drawing.' };
      const design = readPipeDesign(element, scene);
      const index = design.legs.findIndex((leg) => leg.id === edit.legId);
      if (index < 0) return { ok: false, message: 'This straight is no longer on the line.' };
      const atUnit = (endpoint: 'start' | 'end') => design.ports[endpoint].kind === 'unit-port';
      if (edit.material === 'flexible' && ((index === 0 && atUnit('start')) || (index === design.legs.length - 1 && atUnit('end')))) {
        return { ok: false, message: 'The straight connection to an equipment port must remain hard copper.' };
      }
      const next = pipeWithEditedDesign(element, { ...design, legs: design.legs.map((leg) => (leg.id === edit.legId ? { ...leg, material: edit.material } : leg)) });
      return { ok: true, elements: [next], action: edit.material === 'hard' ? 'Hard copper' : 'Flexible copper', notes: [] };
    }
    case 'add-point':
    case 'remove-bend': {
      const result = buildPipeTopologyEdit({ elementId: edit.elementId, elements: scene,
        action: { kind: edit.kind === 'add-point' ? 'insert' : 'remove', nearPoint: edit.point } });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, elements: [result.element, ...result.elementUpdates], action: edit.kind === 'add-point' ? 'Add route point' : 'Remove bend', notes: [] };
    }
    case 'kit-slide':
      return slideKits(scene, edit.kitIds, edit.offset);
    case 'kit-flip': {
      // Turning a kit over mirrors it across its run: its ports move, so only a kit no pipe holds can be turned.
      const held = kitPipeEnds(scene, edit.kitIds).length;
      if (held) return { ok: false, message: `${held} pipe${held === 1 ? ' holds' : 's hold'} it: redraw the branch to turn it over.` };
      const elements: HvacElement[] = [];
      for (const kitId of edit.kitIds) {
        const kit = find(kitId);
        if (!kit) return { ok: false, message: 'The kit is no longer in the drawing.' };
        const roll = typeof kit.properties.branchKitRollDeg === 'number' ? kit.properties.branchKitRollDeg : 0;
        const over = Math.abs((((roll % 360) + 360) % 360) - 180) < 0.5;
        elements.push({ ...kit, properties: { ...kit.properties, branchKitRollDeg: over ? 0 : 180 } });
      }
      return { ok: true, elements, action: 'Turn branch kit over', notes: ['its branch the other way'] };
    }
    case 'kit-model':
      return { ok: false, message: 'The kit library has no other model.' };
    default:
      return { ok: false, message: 'Not an edit.' };
  }
}

// ---------------------------------------------------------------------------------------------------- evaluating

const lengthOf = (element: HvacElement): number => {
  const nodes = editablePipeNodes(element);
  let total = 0;
  for (let index = 1; index < nodes.length; index += 1) total += distance(nodes[index - 1]!, nodes[index]!);
  return total;
};

type IssueLine = SegmentEvaluationLike['newIssues'][number];

const REPORT_CACHE = new WeakMap<readonly HvacElement[], { profile: ManufacturerRuleProfile; keys: Set<string> }>();

/** The checks the edited drawing fails that the drawing did not (VRF checks, and the circuit's hard rules). */
function newIssues(before: readonly HvacElement[], after: readonly HvacElement[], changedIds: string[], profile: ManufacturerRuleProfile): IssueLine[] {
  const key = (issue: { code: string; entityId?: string }) => `${issue.code}|${issue.entityId ?? ''}`;
  let had = REPORT_CACHE.get(before);
  if (!had || had.profile !== profile) {
    const report = validateHvacElementsAsVrf(before, profile);
    had = { profile, keys: new Set(report.issues.filter((issue) => issue.level === 'error' || issue.level === 'warning').map(key)) };
    REPORT_CACHE.set(before, had);
  }
  const fresh: IssueLine[] = validateHvacElementsAsVrf(after, profile).issues
    .filter((issue) => (issue.level === 'error' || issue.level === 'warning') && !had!.keys.has(key(issue)))
    .map((issue) => ({ severity: issue.level, code: issue.code, message: issue.message }));
  const hard = refrigerantChangeIssues(before, after, changedIds, { profile })
    .map((message): IssueLine => ({ severity: 'error', code: 'CIRCUIT', message }));
  return [...fresh, ...hard];
}

const EVALUATION_CACHE = new WeakMap<readonly HvacElement[], Map<string, RefrigerantOptionEvaluation>>();

/** What an option would do to the drawing (cached per drawing and option). */
export function evaluateRefrigerantOption(scene: readonly HvacElement[], option: RefrigerantSegmentOption,
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE): RefrigerantOptionEvaluation {
  let byOption = EVALUATION_CACHE.get(scene);
  if (!byOption) {
    byOption = new Map();
    EVALUATION_CACHE.set(scene, byOption);
  }
  // The same option on another piece ("level:100" on another straight) is another edit: keyed by the edit itself.
  const cacheKey = `${profile.id}|${option.id}|${JSON.stringify(option.edit)}`;
  const cached = byOption.get(cacheKey);
  if (cached) return cached;
  const refused = (message: string): RefrigerantOptionEvaluation => ({
    optionId: option.id, refused: message, updates: [], action: option.title, notes: [], newIssues: [], deltaLengthMm: 0, deltaChargeKg: null,
  });
  let evaluation: RefrigerantOptionEvaluation;
  if (option.disabledReason) evaluation = refused(option.disabledReason);
  else {
    const result = applyEdit(scene, option.edit);
    if (!result.ok) evaluation = refused(result.message);
    else {
      const replaced = new Map(result.elements.map((element) => [element.id, element]));
      const after = scene.map((element) => replaced.get(element.id) ?? element);
      let deltaLengthMm = 0;
      let deltaChargeKg: number | null = null;
      for (const element of result.elements) {
        const before = scene.find((candidate) => candidate.id === element.id);
        if (!before || before.type !== 'refrigerant-pipe') continue;
        const beforeLength = lengthOf(before);
        const afterLength = lengthOf(element);
        deltaLengthMm += afterLength - beforeLength;
        const spec = resolveRefrigerantPipeSpec(element.properties);
        if (spec.lineKind !== 'liquid') continue;
        const was = liquidChargeKgPerM(resolveRefrigerantPipeSpec(before.properties).pipeDiameterMm);
        const now = liquidChargeKgPerM(spec.pipeDiameterMm);
        if (was !== null && now !== null) deltaChargeKg = (deltaChargeKg ?? 0) + (now * afterLength - was * beforeLength) / 1000;
      }
      evaluation = {
        optionId: option.id, updates: result.elements, action: result.action, notes: result.notes,
        newIssues: newIssues(scene, after, result.elements.map((element) => element.id), profile),
        deltaLengthMm, deltaChargeKg,
      };
    }
  }
  byOption.set(cacheKey, evaluation);
  return evaluation;
}

// ---------------------------------------------------------------------------------------------------- the options

const sizeTitle = (od: number) => `Ø${od.toFixed(2)}${copperInchLabel(od) ? ` (${copperInchLabel(od)})` : ''}`;

/** The series index of a tube OD (within 0.05 mm), or the index it would sit at. */
function seriesIndex(od: number): number {
  const exact = COPPER_TUBE_SERIES_MM.findIndex((size) => Math.abs(size - od) <= 0.05);
  if (exact >= 0) return exact;
  const above = COPPER_TUBE_SERIES_MM.findIndex((size) => size > od);
  return (above < 0 ? COPPER_TUBE_SERIES_MM.length : above) - 0.5;
}

/** A plan direction as the screen shows it (plan y runs down the screen). */
export function screenWay(direction: { x: number; y: number }): { arrow: string; words: string } {
  if (Math.abs(direction.x) >= Math.abs(direction.y)) return direction.x >= 0 ? { arrow: '→', words: 'to the right' } : { arrow: '←', words: 'to the left' };
  return direction.y >= 0 ? { arrow: '↓', words: 'down the plan' } : { arrow: '↑', words: 'up the plan' };
}

/** A plan heading's turn to the visual left or right (plan y runs down the screen). */
function turnSide(from: Vec3, to: Vec3): 'left' | 'right' {
  return from.x * to.y - from.y * to.x > 0 ? 'right' : 'left';
}

/** Rotate `v` about the unit `axis` by `angle` (rad). */
function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = axis.x * v.x + axis.y * v.y + axis.z * v.z;
  return {
    x: v.x * c + (axis.y * v.z - axis.z * v.y) * s + axis.x * d * (1 - c),
    y: v.y * c + (axis.z * v.x - axis.x * v.z) * s + axis.y * d * (1 - c),
    z: v.z * c + (axis.x * v.y - axis.y * v.x) * s + axis.z * d * (1 - c),
  };
}

/**
 * The options of a piece. `partner` is the pair's other line and its piece
 * alongside: geometry edits (level, offset, length) move both lines.
 */
export function refrigerantPieceOptions(
  scene: readonly HvacElement[],
  element: HvacElement,
  line: RefrigerantLine,
  piece: RefrigerantPiece,
  partner: RefrigerantPartner | null,
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE,
): RefrigerantSegmentOption[] {
  if (element.type !== 'refrigerant-pipe') return [];
  const options: RefrigerantSegmentOption[] = [];
  const lineName = line.lineKind === 'liquid' ? 'liquid' : 'gas';
  const isLocked = locked(element) ? 'This line is locked. Unlock it before editing it.' : undefined;
  const lock = isLocked ? { disabledReason: isLocked } : {};

  // ---- Size: the line's, one ACR size down or up, and the profile's (or that no sizing table is loaded).
  const at = seriesIndex(line.tubeOdMm);
  const circuit = refrigerantCircuitFigures(scene, element, lineName, profile);
  const recommended = circuit?.recommendation?.recommendedDiameterMm;
  const sizeNote = circuit?.sizingTable ? '' : ' · no sizing table loaded';
  const sizes = new Map<number, string>();
  // One entry per size (drawing labels and real ODs differ in the second decimal: 15.875 is 15.88).
  const offer = (od: number, detail: string) => {
    if (![...sizes.keys()].some((size) => Math.abs(size - od) <= 0.05)) sizes.set(od, detail);
  };
  offer(line.tubeOdMm, 'its size now');
  const down = COPPER_TUBE_SERIES_MM[Math.ceil(at) - 1];
  const up = COPPER_TUBE_SERIES_MM[Math.floor(at) + 1];
  if (recommended !== undefined) {
    // A line on a unit's port is sized to the port; the rest from the profile's table.
    offer(recommended, /terminal tube/i.test(circuit?.recommendation?.note ?? '') ? "the unit's port size"
      : `the profile's size${circuit?.downstreamCapacityIndex ? ` for capacity index ${Math.round(circuit.downstreamCapacityIndex)}` : ''}`);
  }
  if (down !== undefined) offer(down, `one size down${sizeNote}`);
  if (up !== undefined) offer(up, `one size up${sizeNote}`);
  for (const [od, detail] of [...sizes].sort((a, b) => a[0] - b[0])) {
    const current = Math.abs(od - line.tubeOdMm) <= 0.05;
    options.push({
      id: `size:${od.toFixed(2)}`, group: 'size', glyph: current ? 'size' : od < line.tubeOdMm ? 'size-down' : 'size-up',
      title: sizeTitle(od), detail: `${lineName} line · ${detail}`, edit: { kind: 'size', elementId: element.id, tubeOdMm: od },
      ...(current ? { current: true } : {}), ...lock,
    });
  }

  // ---- Insulation: the model's minimum and thicker.
  for (const thickness of INSULATION_STEPS_MM) {
    options.push({
      id: `insulation:${thickness}`, group: 'insulation', glyph: 'insulation', title: `${thickness === 25.4 ? '25' : thickness} mm`,
      detail: thickness === 25.4 ? 'the minimum (1″)' : 'thicker, for a warm or humid ceiling void',
      edit: { kind: 'insulation', elementId: element.id, thicknessMm: thickness },
      ...(Math.abs(line.insulationMm - thickness) < 0.5 ? { current: true } : {}),
    });
  }

  const both = (legId: string | null, partnerLegId: string | null) => [
    ...(legId ? [{ elementId: element.id, legId }] : []),
    ...(partner && partnerLegId ? [{ elementId: partner.element.id, legId: partnerLegId }] : []),
  ];

  if ((piece.kind === 'straight' || piece.kind === 'riser') && piece.legId) {
    const moves = both(piece.legId, partner && (partner.piece.kind === 'straight' || partner.piece.kind === 'riser') ? partner.piece.legId : null);
    const pairNote = moves.length > 1 ? ' · both lines of the pair' : '';
    // ---- Level and sideways offset (straights): the adaptive engine re-makes the rest.
    if (piece.kind === 'straight') {
      for (const dz of [-100, -50, 50, 100]) {
        options.push({
          id: `level:${dz}`, group: 'level', glyph: 'level', title: `${dz > 0 ? '+' : '−'}${Math.abs(dz)}`,
          detail: `${dz > 0 ? 'up' : 'down'} ${Math.abs(dz)} mm${pairNote}`, edit: { kind: 'move-legs', moves, offset: { x: 0, y: 0, z: dz } }, ...lock,
        });
      }
      const from = piece.path[0]!;
      const to = piece.path[piece.path.length - 1]!;
      const run = Math.hypot(to.x - from.x, to.y - from.y);
      if (run > 1) {
        // Across the straight in plan, named the way it moves on screen (plan y runs down the screen).
        const across = { x: -(to.y - from.y) / run, y: (to.x - from.x) / run, z: 0 };
        for (const shift of [-200, -100, 100, 200]) {
          const way = screenWay(scale(across, Math.sign(shift)));
          options.push({
            id: `offset:${shift}`, group: 'offset', glyph: 'offset', title: `${way.arrow} ${Math.abs(shift)}`,
            detail: `${Math.abs(shift)} mm ${way.words}${pairNote}`,
            edit: { kind: 'move-legs', moves, offset: scale(across, shift) }, ...lock,
          });
        }
      }
    }
    // ---- Copper: hard or flexible.
    const leg = line.design.legs.find((candidate) => candidate.id === piece.legId);
    if (leg) {
      const other = leg.material === 'hard' ? 'flexible' : 'hard';
      options.push({
        id: `material:${other}`, group: 'material', glyph: other, title: other === 'hard' ? 'Hard copper' : 'Flexible copper',
        detail: other === 'hard' ? 'straight lengths, joined at fittings' : 'annealed coil, bent on site',
        edit: { kind: 'material', elementId: element.id, legId: leg.id, material: other }, ...lock,
      });
    }
    // ---- A route point at its middle (to bend it there by dragging).
    const middle = pieceMidpoint(piece);
    options.push({
      id: 'add-point', group: 'add-point', glyph: 'add-point', title: 'A point at its middle',
      detail: 'splits the straight there, to drag a new bend out of it', edit: { kind: 'add-point', elementId: element.id, point: { x: middle.x, y: middle.y } }, ...lock,
    });
  }

  if (piece.kind === 'bend' && piece.joint && piece.angleDeg !== null) {
    const formed = !line.socketElbows;
    options.push({
      id: 'construction:socket', group: 'construction', glyph: 'socket', title: 'Socket elbows',
      detail: 'catalogue copper elbows at every bend of this line', edit: { kind: 'construction', elementId: element.id, construction: 'socket-elbow' },
      ...(formed ? {} : { current: true }), ...lock,
    });
    options.push({
      id: 'construction:formed', group: 'construction', glyph: 'formed', title: 'Formed bends',
      detail: 'tube bent on site at every bend of this line', edit: { kind: 'construction', elementId: element.id, construction: 'formed-bend' },
      ...(formed ? { current: true } : {}), ...lock,
    });
    if (formed) {
      const factor = typeof element.properties.bendRadiusFactor === 'number' ? element.properties.bendRadiusFactor : 1;
      for (const next of RADIUS_FACTORS) {
        options.push({
          id: `radius:${next}`, group: 'radius', glyph: 'radius', title: `R ${Math.round(next * line.outsideDiameterMm)} mm`,
          detail: `${next} × its outside Ø · every formed bend of this line`, edit: { kind: 'radius', elementId: element.id, factor: next },
          ...(Math.abs(next - factor) < 1e-6 ? { current: true } : {}), ...lock,
        });
      }
    }
    // ---- Two 45°s for a 90°.
    if (Math.abs(piece.angleDeg - 90) <= 2) {
      const face45 = line.socketElbows ? resolveCopperSocketElbow(line.tubeOdMm, 45)?.centerToFaceMm ?? line.outsideDiameterMm : (piece.radiusMm ?? line.outsideDiameterMm) * Math.tan(Math.PI / 8);
      const chamferMm = Math.ceil((2 * face45 + Math.max(50, 2 * line.tubeOdMm)) / Math.SQRT2 / 10) * 10;
      options.push({
        id: 'split-bend', group: 'split-bend', glyph: 'split', title: 'Two 45° bends',
        detail: `a ${Math.round(chamferMm * Math.SQRT2)} mm straight between them: less pressure drop than one 90°`,
        edit: { kind: 'split-bend', elementId: element.id, jointId: piece.joint.id, chamferMm }, ...lock,
      });
    }
    // ---- Into another plane: rolled 90° about the incoming leg, either way.
    const index = line.design.nodes.findIndex((node) => node.id === piece.joint!.nodeId);
    const incoming = line.design.legs[index - 1];
    const outgoing = line.design.legs[index];
    if (incoming && outgoing) {
      for (const angle of [90, -90]) {
        const turned = rotate(outgoing.direction, incoming.direction, (angle * Math.PI) / 180);
        const words = turned.z > 0.7 ? 'the leg after it rises' : turned.z < -0.7 ? 'the leg after it drops'
          : `level, turning ${turnSide(incoming.direction, turned)}`;
        options.push({
          id: `roll:${angle}`, group: 'plane', glyph: 'roll', title: `Turn it: ${words}`,
          detail: 'rolled 90° about the leg into it; the engine re-makes what follows', edit: { kind: 'roll-bend', elementId: element.id, jointId: piece.joint.id, angleDeg: angle }, ...lock,
        });
      }
    }
    // ---- Taken out.
    const corner = line.design.nodes[index];
    if (corner) {
      options.push({
        id: 'remove-bend', group: 'remove-bend', glyph: 'remove-bend', title: 'Take this bend out',
        detail: 'joins the two straights into one', edit: { kind: 'remove-bend', elementId: element.id, point: { x: corner.x, y: corner.y } }, ...lock,
      });
    }
  }
  return options;
}

/** The options a straight's own values make (typed in the card's Edit tab). */
export function refrigerantValueOption(
  element: HvacElement,
  piece: RefrigerantPiece,
  partner: RefrigerantPartner | null,
  value: { kind: 'level'; deltaMm: number } | { kind: 'offset'; offset: Vec3; label: string } | { kind: 'length'; deltaMm: number; keep: 'start' | 'end' },
): RefrigerantSegmentOption | null {
  if (!piece.legId) return null;
  const moves = [
    { elementId: element.id, legId: piece.legId },
    ...(partner?.piece.legId && (partner.piece.kind === 'straight' || partner.piece.kind === 'riser') ? [{ elementId: partner.element.id, legId: partner.piece.legId }] : []),
  ];
  if (value.kind === 'level') {
    return { id: `level-custom:${value.deltaMm}`, group: 'level', glyph: 'level', title: `${value.deltaMm > 0 ? '+' : '−'}${Math.abs(value.deltaMm)} mm`,
      detail: 'a level of your own', edit: { kind: 'move-legs', moves, offset: { x: 0, y: 0, z: value.deltaMm } } };
  }
  if (value.kind === 'offset') {
    return { id: `offset-custom:${value.label}`, group: 'offset', glyph: 'offset', title: value.label, detail: 'an offset of your own',
      edit: { kind: 'move-legs', moves, offset: value.offset } };
  }
  return { id: `length-custom:${value.keep}:${value.deltaMm}`, group: 'length', glyph: 'length', title: `${value.deltaMm > 0 ? '+' : '−'}${Math.abs(value.deltaMm)} mm`,
    detail: `a length of your own, its ${value.keep} held`, edit: { kind: 'leg-length', moves, deltaMm: value.deltaMm, keep: value.keep } };
}

/** A kit's run in plan: from its inlet towards its outlets (unit), or null for a kit with no ports. */
export function kitRunAxis(element: HvacElement): { x: number; y: number } | null {
  const port = refrigerantKitOf(element)?.ports[0];
  if (!port) return null;
  const run = { x: port.run.x - port.inlet.x, y: port.run.y - port.inlet.y };
  const length = Math.hypot(run.x, run.y);
  return length > 1 ? { x: run.x / length, y: run.y / length } : null;
}

/** A slide of the kits along their run by `shiftMm` (+ towards the outlets). */
export function refrigerantKitSlideOption(kitIds: string[], axis: { x: number; y: number }, shiftMm: number, custom = false): RefrigerantSegmentOption {
  const way = screenWay({ x: axis.x * Math.sign(shiftMm), y: axis.y * Math.sign(shiftMm) });
  return {
    id: `${custom ? 'kit-slide-custom' : 'kit-slide'}:${shiftMm}`, group: 'kit-slide', glyph: 'slide', title: `${way.arrow} ${Math.abs(shiftMm)}${custom ? ' mm' : ''}`,
    detail: `${Math.abs(shiftMm)} mm towards its ${shiftMm > 0 ? 'outlets' : 'inlet'}${kitIds.length > 1 ? ' · both kits of the pair' : ''}`,
    edit: { kind: 'kit-slide', kitIds, offset: { x: axis.x * shiftMm, y: axis.y * shiftMm } },
  };
}

/**
 * A branch kit's options: slid along its run (a pair's gas and liquid kits together), turned over, another model —
 * the last two listed with why not when they cannot be made.
 */
export function refrigerantKitOptions(
  scene: readonly HvacElement[],
  element: HvacElement,
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE,
): RefrigerantSegmentOption[] {
  const kit = refrigerantKitOf(element);
  if (!kit) return [];
  const partner = kitPartnerOf(element, scene);
  const kitIds = partner ? [element.id, partner.id] : [element.id];
  const lockReason = [element, ...(partner ? [partner] : [])].some(locked) ? 'This kit is locked. Unlock it before editing it.' : null;
  const options: RefrigerantSegmentOption[] = [];
  const axis = kitRunAxis(element);
  if (axis) {
    for (const shift of [-200, -100, 100, 200]) {
      options.push({ ...refrigerantKitSlideOption(kitIds, axis, shift), ...(lockReason ? { disabledReason: lockReason } : {}) });
    }
  }
  const held = kitPipeEnds(scene, kitIds).length;
  options.push({
    id: 'kit-flip', group: 'kit-flip', glyph: 'flip', title: 'Turn it over', detail: 'its branch to the other side of the run',
    edit: { kind: 'kit-flip', kitIds },
    ...(held ? { disabledReason: `Turning it over moves its ports across the pair: the ${held} pipe${held === 1 ? '' : 's'} on ${kitIds.length > 1 ? 'the two kits' : 'it'} would need redrawing. Redraw the branch to turn it over.` }
      : lockReason ? { disabledReason: lockReason } : {}),
  });
  const base = kit.model.replace(/\s+(gas|liquid)$/i, '');
  const recommendation = kit.lines.map((line) => refrigerantCircuitFigures(scene, element, line, profile)).find((figures) => figures)?.recommendation ?? null;
  const wanted = recommendation?.recommendedModel?.trim();
  const differs = Boolean(wanted && wanted.toUpperCase() !== base.toUpperCase());
  options.push({
    id: 'kit-model', group: 'kit-model', glyph: 'kit', title: differs ? wanted! : 'Another model', detail: differs ? "the profile's model for it" : 'from the kit library',
    edit: { kind: 'kit-model', kitIds },
    disabledReason: differs
      ? `The profile names ${wanted}, but the kit library draws only ${base}: add ${wanted} to the library to swap it.`
      : `${base} is the only branch kit in the library${recommendation ? '' : ', and the profile has no branch-kit table'}.`,
  });
  return options;
}
