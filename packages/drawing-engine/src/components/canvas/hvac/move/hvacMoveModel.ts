/**
 * One move for every input — a drag in any view, the move gizmo, the arrow
 * keys, a typed distance: what the selection becomes when it is moved by a
 * vector, with everything that follows it, as one command (one undo).
 *
 * - Moved together = moved rigidly: everything selected translates by the
 *   same vector, so whatever joins two selected items keeps its shape.
 * - What joins the selection to things that stay adapts instead of breaking:
 *   duct runs stretch (ductNetworkMove: a unit moved alone keeps its diffusers
 *   where they are), refrigerant pipes re-attach to the moved ports, drains
 *   re-solve.
 * - A duct run moved without its unit offsets; one straight moves sideways or
 *   up and down, its neighbours stretching.
 * - Rules: units and terminals keep their placement rules, and the whole
 *   selection stops at the last position where every one of them holds; up
 *   and down, only ducted units, duct straights, refrigerant pipes and branch
 *   kits move (terminals and cassettes sit in the ceiling, wall and outdoor
 *   units at their mounting level), units and ducts within the ceiling void.
 * - Duct problems the move makes (a clash, a short leg) are allowed: the plan
 *   checks report them.
 * - A turn (a rotation about the vertical axis) is the same command: units
 *   and terminals turn as one block about the selection's centre (or each
 *   about its own); a wall unit stays square to its wall; a square or round
 *   face keeps its spigot facing its runout; runs on a turned collar rejoin
 *   their route (ductNetworkMove), pipes re-attach, drains re-solve.
 *
 * Pure: the placement rules, the drain context and the void come in through
 * the context, so the same model serves the preview and the commit.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { getProtectedPipeNodeIndexes } from '../../hybrid/hybridPipeEditing';
import { createCondensateEditSession, followCondensateDrains, isUnitBranchSpec, type CondensateEditContext } from '../condensate/condensateEditing';
import { fixedPrefixLength, translateRouteInterior, type PlanRoute } from '../condensate/condensateRouteOps';
import { getCondensateOwnership, isCondensatePipe } from '../condensate/condensateTypes';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { isDuctTerminalElement, readDuctTerminalSpec, SQUARE_BOX_TERMINAL_KINDS, type DuctTerminalSpigotSide } from '../duct/ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctLeg, type DuctRunSpec } from '../duct/ductTypes';
import type { CriteriaRoom } from '../duct/unitCriteria';
import { readPipeRouteNodes3d } from '../pipeRoute3d';
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
  isRefrigerantPipeElementType,
  resolveRefrigerantPipeBranchKitReconnectionUpdates,
  resolveRefrigerantPipePairSpec,
  resolveRefrigerantPipeSpec,
  resolveRefrigerantPipeUnitPortReconnectionUpdates,
  translateRefrigerantPipeElementProperties,
} from '../refrigerantPipePairModel';

import { ZERO3, type Vec3 } from './ductElasticMove';
import { ductsAwaitingTurn, moveDuctNetwork, terminalsTurnedWhole, turnPoint, type DuctSegmentRef } from './ductNetworkMove';
import type { DuctResizeOutcome } from './ductResize';

/** A turn of the selection about the vertical axis. */
export interface HvacRotation {
  /** Degrees, clockwise on the plan (the sense of an element's rotation). */
  angleDeg: number;
  /** About the selection's centre as one block (the default), each item about its own centre, or about a point. */
  pivot?: 'group' | 'each' | Point2D;
  /** A drag: the turn stops at the last angle every rule allows (else it is made whole or not at all). */
  partial?: boolean;
  /** A drag: the spigot sides its last frame showed (a square face's spigot then changes side only past its margin). */
  spigotSides?: Readonly<Record<string, DuctTerminalSpigotSide>>;
}

export interface HvacMoveRequest {
  /** What is moved: units, terminals, duct runs, refrigerant pipes, branch kits, drain runs. */
  ids: readonly string[];
  /** One duct straight moved on its own (as picked for its segment card). */
  segment?: DuctSegmentRef | null;
  /** The move asked for (mm; plan x, y and z up); zero for a turn. */
  delta: Vec3;
  /** A turn instead of a move: the units and terminals selected turn, what is attached to them follows. */
  rotation?: HvacRotation | null;
}

/** What the placement rules say about a unit or terminal at a new centre (the canvas's computeHvacPlacement). */
export interface HvacPlacementCheck {
  valid: boolean;
  invalidReason: string | null;
  /** Top-left of the footprint. */
  point: Point2D;
  rotationDeg: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  roomId: string | null;
  wallId: string | null;
  placementProperties?: Record<string, unknown>;
}

/** The void above the ceiling that units and ducts move up and down in (mm). */
export interface HvacCeilingVoid {
  /** The ceiling plane: nothing in the void hangs below it. */
  ceilingMm: number;
  /** The soffit: nothing rises above it. */
  soffitMm: number;
}

export interface HvacMoveContext {
  ductSettings: DuctDesignSettings;
  /** The placement rules; absent: any position is valid. */
  place?: (center: Point2D, element: HvacElement) => HvacPlacementCheck;
  /** Drains follow and drain runs re-solve in it; absent: drains are left as they are (a fast preview). */
  condensate?: CondensateEditContext;
  /** Absent: no level limits. */
  ceilingVoid?: HvacCeilingVoid | null;
  /** The drawing's rooms (a resize's figures judge a system by the criteria of the rooms it serves). */
  rooms?: ReadonlyArray<CriteriaRoom>;
  /**
   * A drag's preview of a turn: the ducts of a unit turned without its whole
   * system wait for the release (they are designed then): they are left as
   * they are and listed in the plan's `pendingRunIds` (drawn faded).
   */
  deferTurnedDucts?: boolean;
}

export interface HvacMoveOutcome {
  /** `moved`: it was selected; `follows`: it changed because what it is attached to moved. */
  kind: 'moved' | 'follows';
  /** What the move left for the designer (shown amber): a run that no longer reaches its terminal, … */
  note?: string;
}

export interface HvacMovePlan {
  requested: Vec3;
  /** The move made: the whole selection stops where the first rule would break. */
  applied: Vec3;
  /** applied / requested (1: all of it). */
  fraction: number;
  /** What stopped the move short, and why. */
  limitedBy: { id: string; reason: string } | null;
  /** Every changed element, as it will be stored. */
  updated: HvacElement[];
  /** Drain pieces the re-solve adds and removes. */
  add: HvacElement[];
  removeIds: string[];
  outcomes: Map<string, HvacMoveOutcome>;
  /** Worth telling the designer (in the status bar). */
  messages: string[];
  /** Those of the messages that only say what was done (not what is left to do): the readout shows them plainly. */
  infos?: string[];
  /** The undo step's name ("Move FDUM22 and 2 diffusers", "Rotate DU-1 90° clockwise"). */
  label: string;
  /**
   * A turn: the angle asked for and made (degrees, clockwise on the plan), about `pivot` (null: each item's own
   * centre), and the side each square face's spigot took.
   */
  rotation?: { requestedDeg: number; appliedDeg: number; pivot: Point2D | null; spigotSides?: Readonly<Record<string, DuctTerminalSpigotSide>> };
  /** A straight sized by dragging one of its grips: the value before, asked and made. */
  resize?: DuctResizeOutcome;
  /** A turn's preview: the runs whose design waits for the release (left as they are, drawn faded). */
  pendingRunIds?: string[];
}

/** Equipment that moves up and down; everything else keeps its level. */
const Z_MOVABLE = new Set<HvacElement['type']>(['ducted-ac', 'refrigerant-branch-kit']);
const MOVE_EPSILON_MM = 0.01;
const BISECTION_STEPS = 16;

function isEquipment(element: HvacElement): boolean {
  return !isDuctElement(element) && !isCondensatePipe(element) && !isRefrigerantPipeElementType(element.type);
}

/** What a turn turns: units and air terminals (and drain outlets); branch kits turn with their pipe run, not on their own. */
export function isTurnableElement(element: HvacElement): boolean {
  return isEquipment(element) && element.type !== 'refrigerant-branch-kit';
}

function centreOf(element: Pick<HvacElement, 'position' | 'width' | 'depth'>): Point2D {
  return { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
}

function scaled(delta: Vec3, fraction: number): Vec3 {
  return { x: delta.x * fraction, y: delta.y * fraction, z: delta.z * fraction };
}

/** The elements a refrigerant pipe's ends are bound to. */
function pipeEndOwners(pipe: HvacElement): string[] {
  const owners: string[] = [];
  for (const key of ['startConnection', 'endConnection', 'startBundleConnection', 'endBundleConnection']) {
    const connection = pipe.properties[key] as Record<string, unknown> | null | undefined;
    if (!connection || typeof connection !== 'object') continue;
    for (const field of ['sourceElementId', 'gasSourceElementId', 'liquidSourceElementId']) {
      const owner = connection[field];
      if (typeof owner === 'string') owners.push(owner);
    }
  }
  return owners;
}

/** Why an element keeps its level in an up-and-down move. */
function levelLockReason(element: HvacElement): string {
  switch (element.type) {
    case 'diffuser':
    case 'return-grille':
    case 'ceiling-cassette-ac':
      return 'sits in the ceiling';
    case 'wall-mounted-ac':
    case 'split-ac':
      return 'hangs on its wall at its mounting height';
    case 'outdoor-unit':
      return 'stands at its own level';
    default:
      return 'keeps its level';
  }
}

/** A refrigerant pipe moved by a plan vector: its route translates and its envelope follows. */
function translatePipe(element: HvacElement, delta: Point2D, scene: readonly HvacElement[]): HvacElement {
  const properties = translateRefrigerantPipeElementProperties(element.type, element.properties, delta);
  const next = { ...element, properties };
  const visual = element.type === 'refrigerant-pipe-pair' ? buildRefrigerantPipePairVisual(next, [...scene]) : buildRefrigerantPipeVisual(next);
  return { ...next, position: { x: visual.bounds.minX, y: visual.bounds.minY }, width: visual.bounds.width, depth: visual.bounds.height };
}

/** A refrigerant pipe moved up or down: its route nodes do, except the ones held at a connection. */
function raisePipe(element: HvacElement, dz: number, scene: readonly HvacElement[]): HvacElement | null {
  const context = [...scene];
  const authored = readPipeRouteNodes3d(element);
  let routePoints: Point2D[];
  let fallbackZ: number;
  let startProtection: { connected: boolean; unitPort: boolean };
  let endProtection: { connected: boolean; unitPort: boolean };
  if (element.type === 'refrigerant-pipe-pair') {
    const spec = resolveRefrigerantPipePairSpec(element.properties, context);
    const visual = buildRefrigerantPipePairVisual(element, context);
    routePoints = spec.routePoints;
    fallbackZ = element.elevation + (visual.gasLocalZMm + visual.liquidLocalZMm) / 2;
    startProtection = { connected: Boolean(spec.startBundleConnection), unitPort: spec.startBundleConnection?.connectionKind === 'unit-port' };
    endProtection = { connected: Boolean(spec.endBundleConnection), unitPort: spec.endBundleConnection?.connectionKind === 'unit-port' };
  } else {
    const spec = resolveRefrigerantPipeSpec(element.properties, context);
    const visual = buildRefrigerantPipeVisual(element, context);
    routePoints = spec.routePoints;
    fallbackZ = element.elevation + visual.localZMm;
    startProtection = { connected: Boolean(spec.startConnection), unitPort: spec.startConnection?.connectionKind === 'unit-port' };
    endProtection = { connected: Boolean(spec.endConnection), unitPort: spec.endConnection?.connectionKind === 'unit-port' };
  }
  const nodes = authored.length >= 2 ? authored : routePoints.map((point) => ({ ...point, z: fallbackZ }));
  const held = getProtectedPipeNodeIndexes(nodes.length, startProtection, endProtection);
  const next = nodes.map((node, index) => (held.has(index) ? node : { ...node, z: node.z + dz }));
  if (!next.some((node, index) => Math.abs(node.z - nodes[index]!.z) > 1e-6)) return null;
  return {
    ...element,
    ...(held.size === 0 ? { elevation: element.elevation + dz } : {}),
    properties: { ...element.properties, routeNodes3d: next, networkLevelLocked: true, networkLevelPlan: undefined },
  };
}

const NOUNS: Partial<Record<HvacElement['type'], [string, string]>> = {
  'ducted-ac': ['unit', 'units'],
  'split-ac': ['unit', 'units'],
  'wall-mounted-ac': ['unit', 'units'],
  'ceiling-cassette-ac': ['unit', 'units'],
  'ceiling-suspended-ac': ['unit', 'units'],
  'outdoor-unit': ['outdoor unit', 'outdoor units'],
  diffuser: ['diffuser', 'diffusers'],
  'return-grille': ['grille', 'grilles'],
  duct: ['duct run', 'duct runs'],
  'refrigerant-pipe': ['pipe', 'pipes'],
  'refrigerant-pipe-pair': ['pipe', 'pipes'],
  'refrigerant-branch-kit': ['branch kit', 'branch kits'],
  'condensate-pipe': ['drain', 'drains'],
  'condensate-gully': ['gully', 'gullies'],
};

/** How an item is named in a move: a unit by its air-system tag ("DU-1"), else its label (without a library "(3D)"). */
function moveName(element: HvacElement): string {
  const tag = element.properties.airSystemTag;
  if (typeof tag === 'string' && tag.trim()) return tag.trim();
  return element.label?.trim().replace(/\s*\(3D\)$/i, '') ?? '';
}

/** "Move DU-1 and 2 diffusers", "Move a straight of SD-2". */
export function hvacMoveLabel(selected: readonly HvacElement[], segment: { run: HvacElement | undefined } | null): string {
  if (segment) return `Move a straight of ${segment.run?.label || 'a duct run'}`;
  const named = selectionName(selected);
  return named ? `Move ${named}` : 'Move';
}

/** "Rotate DU-1 90° clockwise", "Rotate 3 diffusers 45° anticlockwise each". */
export function hvacRotateLabel(turned: readonly HvacElement[], angleDeg: number, each: boolean): string {
  const named = selectionName(turned);
  const magnitude = Math.round(Math.abs(angleDeg) * 10) / 10;
  const sense = Math.abs(magnitude - 180) < 0.05 ? '' : angleDeg > 0 ? ' clockwise' : ' anticlockwise';
  return `Rotate${named ? ` ${named}` : ''} ${magnitude}°${sense}${each && turned.length > 1 ? ' each' : ''}`;
}

/** The selection in a few words: "DU-1 and 2 diffusers" ('' when empty). */
function selectionName(selected: readonly HvacElement[]): string {
  const groups = new Map<string, HvacElement[]>();
  for (const element of selected) {
    const noun = NOUNS[element.type]?.[0] ?? 'item';
    groups.set(noun, [...(groups.get(noun) ?? []), element]);
  }
  const parts = [...groups].map(([noun, elements]) => {
    if (elements.length === 1) return moveName(elements[0]!) || `1 ${noun}`;
    const plural = Object.values(NOUNS).find((pair) => pair?.[0] === noun)?.[1] ?? `${noun}s`;
    return `${elements.length} ${plural}`;
  });
  if (parts.length === 0) return '';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

interface Built {
  updated: Map<string, HvacElement>;
  add: HvacElement[];
  removeIds: Set<string>;
  outcomes: Map<string, HvacMoveOutcome>;
  messages: string[];
  /** The duct runs as they changed (for the void check). */
  ducts: HvacElement[];
}

export function planHvacMove(scene: readonly HvacElement[], request: HvacMoveRequest, context: HvacMoveContext): HvacMovePlan {
  // A turn, even of 0° (a drag's first frames are named and checked as the turn they start).
  if (request.rotation) return planHvacRotation(scene, request, request.rotation, context);
  const byId = new Map(scene.map((element) => [element.id, element]));
  const selected = [...new Set(request.ids)].map((id) => byId.get(id)).filter((element): element is HvacElement => Boolean(element));
  const segment = request.segment && byId.has(request.segment.runId) ? request.segment : null;
  const equipment = selected.filter(isEquipment);
  const runIds = new Set(selected.filter(isDuctElement).map((element) => element.id));
  const pipes = selected.filter((element) => isRefrigerantPipeElementType(element.type));
  const drains = selected.filter(isCondensatePipe);
  const pipeIds = new Set(pipes.map((pipe) => pipe.id));
  const requested = request.delta;
  const planar = Math.hypot(requested.x, requested.y) > MOVE_EPSILON_MM;
  const messages: string[] = [];
  // Translated as they are, without their placement rules: a branch kit carried by its selected pipes (it must
  // not re-snap onto their old run), and an item that already breaks its rules where it is (moving it back in
  // must be possible; it does not hold the others back either).
  const rigid = new Set(equipment
    .filter((element) => (element.type === 'refrigerant-branch-kit' && pipes.some((pipe) => pipeEndOwners(pipe).includes(element.id)))
      || (planar && context.place && !context.place(centreOf(element), element).valid))
    .map((element) => element.id));

  /** A unit or terminal moved by `delta`: its placement rules decide where it lands (or that it cannot). */
  const placeEquipment = (element: HvacElement, delta: Vec3): { element: HvacElement; valid: boolean; reason: string | null } => {
    let next = element;
    if (Math.hypot(delta.x, delta.y) > MOVE_EPSILON_MM) {
      if (!context.place || rigid.has(element.id)) {
        next = { ...element, position: { x: element.position.x + delta.x, y: element.position.y + delta.y } };
      } else {
        const centre = centreOf(element);
        const placement = context.place({ x: centre.x + delta.x, y: centre.y + delta.y }, element);
        if (!placement.valid) return { element, valid: false, reason: placement.invalidReason ?? 'it cannot be placed there' };
        next = {
          ...element,
          position: placement.point,
          rotation: placement.rotationDeg,
          width: placement.widthMm,
          depth: placement.depthMm,
          height: placement.heightMm,
          roomId: placement.roomId ?? undefined,
          wallId: placement.wallId ?? undefined,
          properties: { ...element.properties, ...(placement.placementProperties ?? {}) },
        };
      }
    }
    if (Math.abs(delta.z) > MOVE_EPSILON_MM && Z_MOVABLE.has(element.type)) {
      next = {
        ...next,
        elevation: next.elevation + delta.z,
        ...(element.type === 'refrigerant-branch-kit' ? { properties: { ...next.properties, networkLevelLocked: true } } : {}),
      };
    }
    return { element: next, valid: true, reason: null };
  };

  // ---- How far the whole selection can go: every unit and terminal keeps its placement rules. ----
  let fraction = 1;
  let limitedBy: HvacMovePlan['limitedBy'] = null;
  if (planar && context.place) {
    const holding = equipment.filter((element) => !rigid.has(element.id));
    const firstBreak = (at: number) => {
      for (const element of holding) {
        const placed = placeEquipment(element, scaled(requested, at));
        if (!placed.valid) return { id: element.id, reason: `${element.label || 'An item'}: ${placed.reason}` };
      }
      return null;
    };
    let broken = firstBreak(1);
    if (broken) {
      let low = 0;
      let high = 1;
      for (let step = 0; step < BISECTION_STEPS; step += 1) {
        const middle = (low + high) / 2;
        const at = firstBreak(middle);
        if (at) { high = middle; broken = at; } else low = middle;
      }
      fraction = low;
      limitedBy = broken;
    }
  }
  // Up and down within the void: a ducted unit's underside stays above the ceiling, its top below the soffit.
  if (Math.abs(requested.z) > MOVE_EPSILON_MM) {
    const locked = equipment.filter((element) => !Z_MOVABLE.has(element.type));
    if (locked.length && !planar) {
      messages.push(`Only ducted units, duct straights, pipes and branch kits move up and down: ${locked.map((element) => `${element.label || 'an item'} ${levelLockReason(element)}`).join('; ')}.`);
    }
    const ceilingVoid = context.ceilingVoid;
    if (ceilingVoid) {
      for (const element of equipment) {
        if (element.type !== 'ducted-ac') continue;
        const room = requested.z > 0 ? ceilingVoid.soffitMm - (element.elevation + element.height) : ceilingVoid.ceilingMm - element.elevation;
        const within = requested.z > 0 ? room >= 0 : room <= 0;
        if (within && Math.abs(room) < Math.abs(requested.z * fraction)) {
          fraction = room / requested.z;
          limitedBy = {
            id: element.id,
            reason: requested.z > 0
              ? `${element.label || 'The unit'} would rise above the soffit (${Math.round(ceilingVoid.soffitMm)} mm).`
              : `${element.label || 'The unit'} would drop below the ceiling (${Math.round(ceilingVoid.ceilingMm)} mm).`,
          };
        }
      }
    }
  }

  const build = (at: number, withDrains: boolean): Built => {
    const delta = scaled(requested, at);
    const updated = new Map<string, HvacElement>();
    const outcomes = new Map<string, HvacMoveOutcome>();
    const built: Built = { updated, add: [], removeIds: new Set(), outcomes, messages: [], ducts: [] };
    const current = (id: string) => updated.get(id) ?? byId.get(id)!;
    const sceneNow = () => scene.map((element) => updated.get(element.id) ?? element);
    const changedFrom = (element: HvacElement) => {
      const before = byId.get(element.id)!;
      return Math.hypot(element.position.x - before.position.x, element.position.y - before.position.y) > MOVE_EPSILON_MM
        || Math.abs(element.elevation - before.elevation) > MOVE_EPSILON_MM
        || Math.abs((element.rotation ?? 0) - (before.rotation ?? 0)) > MOVE_EPSILON_MM;
    };

    // Units, terminals, kits, gullies.
    const movedEquipment: string[] = [];
    for (const element of equipment) {
      const placed = placeEquipment(element, delta);
      if (!placed.valid || !changedFrom(placed.element)) continue;
      updated.set(element.id, placed.element);
      outcomes.set(element.id, { kind: 'moved' });
      movedEquipment.push(element.id);
    }
    const afterEquipment = sceneNow();

    // Selected refrigerant pipes translate (and rise) with the selection.
    for (const pipe of pipes) {
      let next: HvacElement | null = pipe;
      if (Math.hypot(delta.x, delta.y) > MOVE_EPSILON_MM) next = translatePipe(pipe, delta, afterEquipment);
      if (Math.abs(delta.z) > MOVE_EPSILON_MM) next = raisePipe(next, delta.z, afterEquipment) ?? next;
      if (next !== pipe) {
        updated.set(pipe.id, next);
        outcomes.set(pipe.id, { kind: 'moved' });
      }
    }
    // Pipes on the moved units' and kits' ports re-attach (one after another, so a pipe between two moved items meets both).
    for (const id of movedEquipment) {
      const moved = updated.get(id)!;
      const elements = sceneNow();
      const followers = [
        ...resolveRefrigerantPipeUnitPortReconnectionUpdates(elements, moved),
        ...resolveRefrigerantPipeBranchKitReconnectionUpdates(elements, moved),
      ];
      for (const follower of followers) {
        if (follower.id === id || pipeIds.has(follower.id)) continue;
        updated.set(follower.id, { ...current(follower.id), ...follower.updates } as HvacElement);
        outcomes.set(follower.id, { kind: 'follows' });
      }
    }

    // Duct runs: stretched to what moved, moved with the drag, or a straight moved on its own.
    const ducts = moveDuctNetwork({
      before: scene, after: afterEquipment, movedEquipmentIds: new Set(movedEquipment), runIds,
      segment, delta, settings: context.ductSettings,
    });
    for (const run of ducts.runs) {
      updated.set(run.id, run);
      outcomes.set(run.id, ducts.outcomes.get(run.id) ?? { kind: 'follows' });
    }
    built.ducts = ducts.runs;
    if (ducts.segmentRefused) built.messages.push(ducts.segmentRefused);
    built.messages.push(...ducts.messages);
    for (const id of runIds) {
      if (!ducts.runs.some((run) => run.id === id) && delta.z !== 0 && !planar) {
        built.messages.push(`${byId.get(id)!.label || 'The run'} has no riser to rise on: move one of its straights, or its unit.`);
      }
    }

    // Drains: selected runs re-solve with their legs moved; drains follow the moved units and gullies.
    if (withDrains && context.condensate) {
      const merge = (result: { add: HvacElement[]; updates: HvacElement[]; removeIds: string[] }, kind: HvacMoveOutcome['kind']) => {
        built.add.push(...result.add);
        result.removeIds.forEach((id) => built.removeIds.add(id));
        result.updates.forEach((element) => {
          updated.set(element.id, element);
          if (!outcomes.has(element.id)) outcomes.set(element.id, { kind });
        });
      };
      if (drains.length) {
        if (Math.abs(delta.z) > MOVE_EPSILON_MM && Math.hypot(delta.x, delta.y) <= MOVE_EPSILON_MM) {
          built.messages.push('Drain levels follow from the fall: move the riser or change the fall instead.');
        } else {
          const byNetwork = new Map<string, HvacElement[]>();
          for (const pipe of drains) {
            const networkId = getCondensateOwnership(pipe)?.networkId;
            if (networkId) byNetwork.set(networkId, [...(byNetwork.get(networkId) ?? []), pipe]);
          }
          for (const [networkId, networkPipes] of byNetwork) {
            const session = createCondensateEditSession([...scene], networkId, context.condensate);
            if (!session) continue;
            const routes = new Map<string, PlanRoute>();
            for (const pipe of networkPipes) {
              const route = session.model.routes.get(pipe.id);
              const spec = session.model.specs.get(pipe.id);
              if (route && spec) routes.set(pipe.id, translateRouteInterior(route, { x: delta.x, y: delta.y }, fixedPrefixLength(isUnitBranchSpec(spec))));
            }
            const result = session.solve({ routes });
            if (result.ok) merge(result, 'moved');
            else built.messages.push(result.message);
          }
        }
      }
      if (movedEquipment.length) {
        const follow = followCondensateDrains(scene, afterEquipment, movedEquipment, context.condensate);
        merge(follow, 'follows');
        built.messages.push(...follow.messages);
      }
    }
    return built;
  };

  // ---- Duct runs stay inside the void too: their lowest bottom above the ceiling, their highest top below the soffit. ----
  let built = build(fraction, false);
  const moved = requested.z * fraction;
  if (Math.abs(moved) > MOVE_EPSILON_MM && context.ceilingVoid) {
    const { ceilingMm, soffitMm } = context.ceilingVoid;
    let factor = 1;
    let culprit: HvacElement | null = null;
    for (const run of built.ducts) {
      const before = readDuctRunSpec(byId.get(run.id)!);
      const after = readDuctRunSpec(run);
      if (!before || !after) continue;
      const a = ductExtent(before);
      const b = ductExtent(after);
      // What rose past the soffit (or dropped past the ceiling) moved the full way: it may move only so far.
      const over = moved > 0
        ? (b.topMm > soffitMm && a.topMm <= soffitMm + MOVE_EPSILON_MM ? b.topMm - soffitMm : 0)
        : (b.bottomMm < ceilingMm && a.bottomMm >= ceilingMm - MOVE_EPSILON_MM ? ceilingMm - b.bottomMm : 0);
      if (over <= 0) continue;
      const allowed = Math.max(0, (Math.abs(moved) - over) / Math.abs(moved));
      if (allowed < factor) { factor = allowed; culprit = run; }
    }
    if (culprit && factor < 1) {
      fraction *= factor;
      const name = (culprit as HvacElement).label || 'A duct run';
      limitedBy = {
        id: (culprit as HvacElement).id,
        reason: moved > 0 ? `${name} would rise above the soffit (${Math.round(soffitMm)} mm).` : `${name} would drop below the ceiling (${Math.round(ceilingMm)} mm).`,
      };
    }
  }
  const nothing = fraction * Math.hypot(requested.x, requested.y, requested.z) < MOVE_EPSILON_MM;
  built = nothing ? { updated: new Map(), add: [], removeIds: new Set(), outcomes: new Map(), messages: [], ducts: [] } : build(fraction, true);
  if (limitedBy) messages.push(nothing ? `Cannot move: ${limitedBy.reason}` : `Stopped short: ${limitedBy.reason}`);
  messages.push(...built.messages);

  const removeIds = [...built.removeIds];
  return {
    requested,
    applied: scaled(requested, fraction),
    fraction,
    limitedBy,
    updated: [...built.updated.values()].filter((element) => !built.removeIds.has(element.id)),
    add: built.add,
    removeIds,
    outcomes: built.outcomes,
    messages: [...new Set(messages)],
    label: hvacMoveLabel(selected, segment ? { run: byId.get(segment.runId) } : null),
  };
}

const ANGLE_EPSILON_DEG = 1e-6;
const SIDE_NORMAL: Record<DuctTerminalSpigotSide, Point2D> = {
  back: { x: 0, y: -1 }, front: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

/** Whether a unit hangs on a wall (it stays square to it). */
function hangsOnWall(element: HvacElement): boolean {
  return element.mountType === 'wall' || element.type === 'wall-mounted-ac';
}

/** A rotation in [0, 360), without the float dust of repeated turns. */
function normalisedDeg(angleDeg: number): number {
  const turned = ((angleDeg % 360) + 360) % 360;
  const rounded = Math.round(turned * 1e6) / 1e6;
  return rounded >= 360 ? 0 : rounded;
}

/** The centre of the plan box round the items' footprints: where a block turns about (the grip and the ring use it too). */
export function turnPivot(elements: readonly HvacElement[]): Point2D {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const element of elements) {
    const centre = centreOf(element);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const corner = turnPoint({ x: centre.x + (sx * element.width) / 2, y: centre.y + (sy * element.depth) / 2 }, centre, element.rotation ?? 0);
      minX = Math.min(minX, corner.x); minY = Math.min(minY, corner.y); maxX = Math.max(maxX, corner.x); maxY = Math.max(maxY, corner.y);
    }
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** A square face's spigot keeps its side until a turn is this far past the diagonal (no swinging back and forth at 45°). */
const SPIGOT_SIDE_MARGIN_DEG = 10;

/**
 * The spigot side of a square or round face turned `angleDeg` that points
 * where its spigot did: the side it has (`held`: the side a drag showed last)
 * while that one is within 45° + 10° of that way, else the side nearest it;
 * null for a face whose box is not square (its spigot turns with it).
 */
function spigotSideKeptFacing(element: HvacElement, angleDeg: number, held?: DuctTerminalSpigotSide): DuctTerminalSpigotSide | null {
  const spec = readDuctTerminalSpec(element);
  if (!spec || !SQUARE_BOX_TERMINAL_KINDS.has(spec.kind) || Math.abs(spec.plenumWidthMm - spec.plenumDepthMm) > 1) return null;
  // The old side's normal in the turned element's frame: turned back by the angle.
  const wanted = turnPoint(SIDE_NORMAL[spec.spigotSide], { x: 0, y: 0 }, -angleDeg);
  const facing = (side: DuctTerminalSpigotSide) => SIDE_NORMAL[side].x * wanted.x + SIDE_NORMAL[side].y * wanted.y;
  const kept = held ?? spec.spigotSide;
  if (facing(kept) >= Math.cos(((45 + SPIGOT_SIDE_MARGIN_DEG) * Math.PI) / 180) - 1e-9) return kept;
  let best = spec.spigotSide;
  let bestDot = -Infinity;
  for (const side of ['back', 'front', 'left', 'right'] as const) {
    const dot = facing(side);
    if (dot > bestDot + 1e-9) { best = side; bestDot = dot; }
  }
  return best;
}

/**
 * A turn of the selected units and terminals about the vertical axis, with
 * everything attached following: one block about the selection's centre
 * (moved together = turned rigidly: a system whose unit and terminals all turn
 * turns whole), or each item about its own centre.
 */
function planHvacRotation(scene: readonly HvacElement[], request: HvacMoveRequest, rotation: HvacRotation, context: HvacMoveContext): HvacMovePlan {
  const byId = new Map(scene.map((element) => [element.id, element]));
  const selected = [...new Set(request.ids)].map((id) => byId.get(id)).filter((element): element is HvacElement => Boolean(element));
  // Units and terminals turn; branch kits turn with their pipe run, not on their own; runs, pipes and drains follow.
  const turnable = selected.filter(isTurnableElement);
  const each = rotation.pivot === 'each';
  const pivot: Point2D | null = each ? null : typeof rotation.pivot === 'object' && rotation.pivot ? rotation.pivot : turnPivot(turnable);
  const requestedDeg = rotation.angleDeg;
  const unchanged = (limitedBy: HvacMovePlan['limitedBy'], messages: string[]): HvacMovePlan => ({
    requested: ZERO3, applied: ZERO3, fraction: 0, limitedBy, updated: [], add: [], removeIds: [], outcomes: new Map(), messages,
    label: hvacRotateLabel(turnable, requestedDeg, each), rotation: { requestedDeg, appliedDeg: 0, pivot },
  });
  if (turnable.length === 0) {
    return unchanged(null, ['Only units and air terminals turn: select one (duct runs, pipes and drains follow what they are attached to).']);
  }
  const onWall = turnable.find(hangsOnWall);
  if (onWall) {
    const reason = `${moveName(onWall) || 'The unit'} hangs on its wall and stays square to it: move it to another wall instead.`;
    return unchanged({ id: onWall.id, reason }, [`Cannot turn: ${reason}`]);
  }
  const turnedIds = new Set(turnable.map((element) => element.id));
  // A terminal whose whole system turns with it keeps its spigot on the same side (its runout turns too).
  const wholeTerminals = pivot ? terminalsTurnedWhole(scene, turnedIds) : new Set<string>();
  // A drag's preview: a unit turned without its whole system leaves its ducts to the release (designed then).
  const awaiting = context.deferTurnedDucts ? ductsAwaitingTurn(scene, turnedIds) : null;
  const pending = awaiting?.runIds.size ? { pendingRunIds: [...awaiting.runIds] } : {};
  // An item already breaking its rules where it is turns as it is (and does not hold the others back).
  const free = new Set(turnable.filter((element) => context.place && !context.place(centreOf(element), element).valid).map((element) => element.id));

  const turnElement = (element: HvacElement, angle: number): { element: HvacElement; valid: boolean; reason: string | null } => {
    const centre = centreOf(element);
    const nextCentre = pivot ? turnPoint(centre, pivot, angle) : centre;
    let properties = element.properties;
    if (isDuctTerminalElement(element) && !wholeTerminals.has(element.id)) {
      const side = spigotSideKeptFacing(element, angle, rotation.spigotSides?.[element.id]);
      const raw = (element.properties.terminal ?? {}) as Record<string, unknown>;
      if (side && side !== readDuctTerminalSpec(element)?.spigotSide) properties = { ...properties, terminal: { ...raw, spigotSide: side } };
    }
    let next: HvacElement = {
      ...element,
      position: { x: nextCentre.x - element.width / 2, y: nextCentre.y - element.depth / 2 },
      rotation: normalisedDeg((element.rotation ?? 0) + angle),
      properties,
    };
    if (context.place && !free.has(element.id)) {
      const placement = context.place(nextCentre, next);
      if (!placement.valid) return { element, valid: false, reason: placement.invalidReason ?? 'it cannot be placed there' };
      next = { ...next, roomId: placement.roomId ?? undefined };
    }
    return { element: next, valid: true, reason: null };
  };

  // ---- How far the whole selection can turn: every unit and terminal keeps its placement rules. ----
  const firstBreak = (angle: number) => {
    for (const element of turnable) {
      const turned = turnElement(element, angle);
      if (!turned.valid) return { id: element.id, reason: `${element.label || 'An item'}: ${turned.reason}` };
    }
    return null;
  };
  let fraction = 1;
  let limitedBy: HvacMovePlan['limitedBy'] = null;
  const broken = firstBreak(requestedDeg);
  if (broken) {
    limitedBy = broken;
    fraction = 0;
    if (rotation.partial) {
      let low = 0;
      let high = 1;
      for (let step = 0; step < BISECTION_STEPS; step += 1) {
        const middle = (low + high) / 2;
        const at = firstBreak(requestedDeg * middle);
        if (at) { high = middle; limitedBy = at; } else low = middle;
      }
      fraction = low;
    }
  }
  const appliedDeg = requestedDeg * fraction;
  if (Math.abs(appliedDeg) <= ANGLE_EPSILON_DEG) return { ...unchanged(limitedBy, limitedBy ? [`Cannot turn: ${limitedBy.reason}`] : []), ...pending };

  // ---- The turn and what follows it. ----
  const updated = new Map<string, HvacElement>();
  const outcomes = new Map<string, HvacMoveOutcome>();
  const messages: string[] = limitedBy ? [`Stopped short: ${limitedBy.reason}`] : [];
  const add: HvacElement[] = [];
  const removeIds = new Set<string>();
  const sceneNow = () => scene.map((element) => updated.get(element.id) ?? element);
  for (const element of turnable) {
    updated.set(element.id, turnElement(element, appliedDeg).element);
    outcomes.set(element.id, { kind: 'moved' });
  }
  // The side each square face's spigot took (a drag passes them back, so a side changes only past its margin).
  const spigotSides: Record<string, DuctTerminalSpigotSide> = {};
  for (const element of turnable) {
    if (!isDuctTerminalElement(element) || wholeTerminals.has(element.id)) continue;
    const side = spigotSideKeptFacing(element, appliedDeg, rotation.spigotSides?.[element.id]);
    if (side) spigotSides[element.id] = side;
  }
  const afterEquipment = sceneNow();
  // Pipes on the turned units' ports re-attach (one after another, so a pipe between two turned units meets both).
  for (const element of turnable) {
    const elements = sceneNow();
    for (const follower of resolveRefrigerantPipeUnitPortReconnectionUpdates(elements, updated.get(element.id)!)) {
      if (follower.id === element.id) continue;
      updated.set(follower.id, { ...(updated.get(follower.id) ?? byId.get(follower.id)!), ...follower.updates } as HvacElement);
      outcomes.set(follower.id, { kind: 'follows' });
    }
  }
  // Duct runs: turned with their whole system, re-aimed off a turned collar, re-curved or re-aimed onto a turned spigot.
  const ducts = moveDuctNetwork({
    before: scene, after: afterEquipment, runIds: new Set(), segment: null, delta: ZERO3,
    movedEquipmentIds: awaiting?.unitIds.size ? new Set([...turnedIds].filter((id) => !awaiting.unitIds.has(id))) : turnedIds,
    settings: context.ductSettings, turn: { angleDeg: appliedDeg, pivot },
  });
  for (const run of ducts.runs) {
    if (awaiting?.runIds.has(run.id)) continue;
    updated.set(run.id, run);
    outcomes.set(run.id, ducts.outcomes.get(run.id) ?? { kind: 'follows' });
  }
  messages.push(...ducts.messages);
  // Drains follow the turned outlets (the commit; a preview leaves them).
  if (context.condensate) {
    const follow = followCondensateDrains(scene, afterEquipment, [...turnedIds], context.condensate);
    add.push(...follow.add);
    follow.removeIds.forEach((id) => removeIds.add(id));
    follow.updates.forEach((element) => {
      updated.set(element.id, element);
      if (!outcomes.has(element.id)) outcomes.set(element.id, { kind: 'follows' });
    });
    messages.push(...follow.messages);
  }
  return {
    requested: ZERO3,
    applied: ZERO3,
    fraction,
    limitedBy,
    updated: [...updated.values()].filter((element) => !removeIds.has(element.id)),
    add,
    removeIds: [...removeIds],
    outcomes,
    messages: [...new Set(messages)],
    infos: ducts.infos,
    label: hvacRotateLabel(turnable, appliedDeg, each),
    rotation: { requestedDeg, appliedDeg, pivot, ...(Object.keys(spigotSides).length ? { spigotSides } : {}) },
    ...pending,
  };
}

/** The plan as a store command (one undo step). */
export function hvacMoveCommand(plan: HvacMovePlan): {
  add: HvacElement[];
  removeIds: string[];
  updates: Array<{ id: string; updates: Partial<HvacElement> }>;
} {
  return {
    add: plan.add,
    removeIds: plan.removeIds,
    updates: plan.updated.map((element) => {
      const { id: _id, ...updates } = element;
      return { id: element.id, updates };
    }),
  };
}

/** Whether the plan changes anything. */
export function hvacMoveChanges(plan: HvacMovePlan): boolean {
  return plan.updated.length > 0 || plan.add.length > 0 || plan.removeIds.length > 0;
}

/**
 * The void units and ducts move up and down in: the ceiling where the air
 * terminals sit (else the rooms' ceilings, the cassettes' faces, 2400 mm), up
 * to the soffit.
 */
export function resolveHvacCeilingVoid(
  scene: readonly HvacElement[],
  rooms: ReadonlyArray<{ properties3D?: { ceilingHeight?: number } | null }>,
  soffitMm: number,
): HvacCeilingVoid {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const terminals = scene.filter((element) => element.type === 'diffuser' || element.type === 'return-grille').map((element) => element.elevation);
  const roomCeilings = rooms.map((room) => room.properties3D?.ceilingHeight).filter((value): value is number => Number.isFinite(value));
  const cassettes = scene.filter((element) => element.type === 'ceiling-cassette-ac').map((element) => element.elevation);
  const ceilingMm = terminals.length ? median(terminals) : roomCeilings.length ? median(roomCeilings) : cassettes.length ? median(cassettes) : 2400;
  return { ceilingMm, soffitMm: Math.max(ceilingMm, soffitMm) };
}

/** A run's lowest clear bottom and highest outside top (insulation included), in mm. */
function ductExtent(spec: DuctRunSpec): { bottomMm: number; topMm: number } {
  let bottomMm = Number.POSITIVE_INFINITY;
  let topMm = Number.NEGATIVE_INFINITY;
  spec.path.forEach((point, index) => {
    const sections = [spec.legs[index - 1], spec.legs[index]].filter((section): section is DuctLeg => Boolean(section));
    const height = Math.max(0, ...sections.map((section) => section.diameterMm ?? section.heightMm));
    bottomMm = Math.min(bottomMm, point.z);
    topMm = Math.max(topMm, point.z + height + 2 * spec.insulationThicknessMm);
  });
  return { bottomMm, topMm };
}
