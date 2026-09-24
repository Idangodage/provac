/**
 * Refrigerant hop over a condensate drain (gravity priority).
 *
 * When a drain can pass neither below nor above a refrigerant run, the drain
 * keeps its fall and the refrigerant yields: a plumb riser up, a level cross
 * over the drain and a plumb riser down, spliced into the refrigerant's real
 * 3D route (`routeNodes3d`) — never the legacy `bypasses` metadata. Plumb
 * risers with 90° elbows are what the refrigerant 3D, fitting and auto-route
 * code already supports.
 *
 * Lines crossed in the same window (a gas/liquid pair) hop TOGETHER: the same
 * rise at the same stations, so the pair keeps its spacing and never clashes
 * with itself. The rise is the larger of what the drain needs and the least
 * height two elbows can be built in, and must stay under the soffit. Every hop
 * is validated against its own spans (a legacy route's unrelated defects must
 * not block it) and against every other refrigerant run.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { findNewNetworkPipeClashes } from '../networkPipeClearance';
import { pipeDesignSkeleton, pipeWithEditedNodes, validatePipeBendSpace } from '../pipeEditModel';
import { splitPipeRoute3dAtPlanInterval, type PipeRouteNode3D } from '../pipeRoute3d';
import { getActivePipeRoutingSettings, type PipeRoutingSettings } from '../pipeRoutingSettings';
import { resolveRefrigerantPipeSpec, type RefrigerantPipeMaterial } from '../refrigerantPipePairModel';

import { closestOnSegment, distance } from './condensateGeometry';
import type { RefrigerantHopProposal } from './condensateNetworkPlanner';
import type { CondensateDesignSettings } from './condensateSettings';

/** Straight run kept either side of the hop for the elbows' sockets (mm). */
const HOP_APPROACH_MM = 120;
/** Minimum distance from an existing corner of the refrigerant run (mm). */
const CORNER_CLEARANCE_MM = 150;
/** Rise search step when the required rise is too small to build (mm). */
const RISE_STEP_MM = 10;

export interface RefrigerantHopResult {
  element?: HvacElement;
  reason?: string;
  riseMm?: number;
}

interface HopSite {
  element: HvacElement;
  nodes: PipeRouteNode3D[];
  materials: RefrigerantPipeMaterial[];
  plan: Point2D[];
  index: number;
  local: number;
  segmentLength: number;
  baseZ: number;
  outerRadius: number;
  direction: Point2D;
}

function locateHop(scene: readonly HvacElement[], proposal: RefrigerantHopProposal): { site?: HopSite; reason?: string } {
  const element = scene.find((candidate) => candidate.id === proposal.refrigerantElementId);
  if (!element || element.type !== 'refrigerant-pipe') return { reason: 'Only a single refrigerant line can take a hop.' };
  // The same baseline the adaptive editor edits: design corners with the real
  // terminal riser synthesised for a legacy plan-only route, so the port
  // approach stays straight and level when the route becomes 3D-authored.
  const skeleton = pipeDesignSkeleton(element);
  const nodes: PipeRouteNode3D[] = skeleton.nodes.map(({ x, y, z }) => ({ x, y, z }));
  const materials = skeleton.legs.map((leg) => leg.material);
  if (nodes.length < 2) return { reason: 'The refrigerant run has no editable route.' };
  const plan: Point2D[] = nodes.map(({ x, y }) => ({ x, y }));
  let best: { index: number; local: number; distance: number } | null = null;
  for (let index = 1; index < plan.length; index += 1) {
    const a = plan[index - 1]!;
    const b = plan[index]!;
    const { point, t } = closestOnSegment(proposal.point, a, b);
    const d = distance(point, proposal.point);
    if (!best || d < best.distance) best = { index: index - 1, local: t * distance(a, b), distance: d };
  }
  // The proposal point lies on the physical lane; editable nodes can differ by fillet sampling.
  if (!best || best.distance > 30) return { reason: 'The crossing is not on this refrigerant run.' };
  const a = nodes[best.index]!;
  const b = nodes[best.index + 1]!;
  const segmentLength = distance(plan[best.index]!, plan[best.index + 1]!);
  if (Math.abs(a.z - b.z) > 1 || segmentLength < 1) return { reason: 'The refrigerant crosses on a riser or sloped section.' };
  const spec = resolveRefrigerantPipeSpec(element.properties, scene as HvacElement[]);
  return {
    site: {
      element,
      nodes,
      materials,
      plan,
      index: best.index,
      local: best.local,
      segmentLength,
      baseZ: a.z,
      outerRadius: spec.outerDiameterMm / 2,
      direction: {
        x: (plan[best.index + 1]!.x - plan[best.index]!.x) / segmentLength,
        y: (plan[best.index + 1]!.y - plan[best.index]!.y) / segmentLength,
      },
    },
  };
}

/** A hop covers every crossing of one line inside a window: [from, to] along the crossing segment. */
interface HopSpan {
  site: HopSite;
  from: number;
  to: number;
  proposals: RefrigerantHopProposal[];
}

function spliceHop(span: HopSpan, riseMm: number, scene: readonly HvacElement[]): { element?: HvacElement; reason?: string } {
  const { site } = span;
  const half = (span.to - span.from) / 2;
  const centre = (span.from + span.to) / 2;
  site.local = centre;
  const spec = resolveRefrigerantPipeSpec(site.element.properties, scene as HvacElement[]);
  const portStub = getActivePipeRoutingSettings().minimumPortStubMm;
  const startReserve = site.index === 0 && spec.startConnection?.connectionKind === 'unit-port' ? portStub : 0;
  const endReserve = site.index === site.plan.length - 2 && spec.endConnection?.connectionKind === 'unit-port' ? portStub : 0;
  const startLimit = startReserve ? startReserve + HOP_APPROACH_MM / 2 : CORNER_CLEARANCE_MM;
  const endLimit = endReserve ? endReserve + HOP_APPROACH_MM / 2 : CORNER_CLEARANCE_MM;
  if (site.local - half < startLimit || site.local + half > site.segmentLength - endLimit) {
    return {
      reason: startReserve || endReserve
        ? 'The crossing is inside the refrigerant port stub at the unit; move the drain route or the unit.'
        : 'The crossing is too close to a refrigerant bend for a hop.',
    };
  }
  const origin = site.plan[site.index]!;
  const at = (offset: number): Point2D => ({
    x: origin.x + site.direction.x * (site.local + offset),
    y: origin.y + site.direction.y * (site.local + offset),
  });
  const split = splitPipeRoute3dAtPlanInterval(site.plan, site.nodes, at(-half), at(half), { first: site.baseZ, second: site.baseZ });
  if (!split) return { reason: 'The refrigerant route could not be split for a hop.' };
  const topZ = site.baseZ + riseMm;
  const next: PipeRouteNode3D[] = [
    ...split.before,
    { ...split.firstCutNode, z: topZ },
    { ...split.secondCutNode, z: topZ },
    ...split.after,
  ];
  const materials = site.materials;
  const segmentMaterials = [
    ...materials.slice(0, site.index + 1),
    'hard', 'hard', 'hard',
    ...materials.slice(site.index),
  ].slice(0, next.length - 1);
  const edited = pipeWithEditedNodes({ ...site.element, properties: { ...site.element.properties, segmentMaterials } }, next);
  // Judge the hop on its own spans; the port-stub room is checked above.
  const cutIndex = split.before.length - 1;
  const local3d = next.slice(Math.max(0, cutIndex - 1), Math.min(next.length, cutIndex + 5));
  const detached = {
    ...edited,
    properties: { ...edited.properties, startConnection: null, endConnection: null, segmentMaterials: local3d.slice(1).map(() => 'hard') },
  };
  const bendIssue = validatePipeBendSpace(detached, local3d, []);
  if (bendIssue) return { reason: `The hop does not leave room for its elbows: ${bendIssue}` };
  return { element: edited };
}

/** Smallest rise ≥ `requiredRise` whose two elbows fit, or null if none fits under `maxRise`. */
function constructibleRise(span: HopSpan, requiredRise: number, maxRise: number, scene: readonly HvacElement[]): number | null {
  for (let rise = Math.max(1, requiredRise); rise <= maxRise + 1e-6; rise += RISE_STEP_MM) {
    if (spliceHop(span, rise, scene).element) return rise;
  }
  return null;
}

function withHopRecord(element: HvacElement, proposals: readonly RefrigerantHopProposal[], riseMm: number): HvacElement {
  const hops = Array.isArray(element.properties.condensateHops) ? element.properties.condensateHops as unknown[] : [];
  return {
    ...element,
    properties: {
      ...element.properties,
      condensateHops: [...hops, ...proposals.map((proposal) => ({ key: proposal.key, networkId: proposal.networkId, riseMm: Math.round(riseMm) }))],
    },
  };
}

/** Builds one line's hop (used directly for a single line; bundles go through the grouped builder). */
export function buildRefrigerantHop(
  scene: readonly HvacElement[],
  proposal: RefrigerantHopProposal,
  routing: Pick<PipeRoutingSettings, 'ceilingLimitMm'>,
): RefrigerantHopResult {
  const group = buildHopGroup(scene, [proposal], routing);
  if (group.reason) return { reason: group.reason };
  return { element: group.elements[0], riseMm: group.riseMm };
}

function buildHopGroup(
  scene: readonly HvacElement[],
  proposals: readonly RefrigerantHopProposal[],
  routing: Pick<PipeRoutingSettings, 'ceilingLimitMm'>,
): { elements: HvacElement[]; riseMm?: number; reason?: string } {
  // One span per refrigerant line: every crossing of that line in the group.
  const spans = new Map<string, HopSpan>();
  for (const proposal of proposals) {
    const located = locateHop(scene, proposal);
    if (!located.site) return { elements: [], reason: located.reason };
    const site = located.site;
    const reach = proposal.halfWindowMm + HOP_APPROACH_MM;
    const existing = spans.get(proposal.refrigerantElementId);
    if (!existing) {
      spans.set(proposal.refrigerantElementId, { site, from: site.local - reach, to: site.local + reach, proposals: [proposal] });
      continue;
    }
    if (existing.site.index !== site.index) return { elements: [], reason: 'The drains cross this refrigerant run on both sides of a bend; hop each separately.' };
    existing.from = Math.min(existing.from, site.local - reach);
    existing.to = Math.max(existing.to, site.local + reach);
    existing.proposals.push(proposal);
  }
  const groupSpans = [...spans.values()];
  // One rise for the whole bundle: enough for every line, and buildable for every line.
  let rise = Math.max(...groupSpans.flatMap((span) => span.proposals.map((proposal) => proposal.requiredCentrelineZ - span.site.baseZ)));
  if (rise <= 0.5) return { elements: [], reason: 'No hop needed: the refrigerant already clears the drain.' };
  const maxRise = Math.min(...groupSpans.map((span) => routing.ceilingLimitMm - span.site.outerRadius - span.site.baseZ));
  if (rise > maxRise) return { elements: [], reason: 'No room above the refrigerant run for a hop within the soffit.' };
  for (const span of groupSpans) {
    const buildable = constructibleRise(span, rise, maxRise, scene);
    if (buildable === null) return { elements: [], reason: 'No room above the refrigerant run for a buildable hop (elbows need more height than the soffit allows).' };
    rise = Math.max(rise, buildable);
  }
  const elements: HvacElement[] = [];
  for (const span of groupSpans) {
    const spliced = spliceHop(span, rise, scene);
    if (!spliced.element) return { elements: [], reason: spliced.reason };
    elements.push(withHopRecord(spliced.element, span.proposals, rise));
  }
  // Lines hopping together keep their relative geometry by construction (a pair
  // that already nearly touches stays exactly as it was); only a contact with a
  // run OUTSIDE the group is a new clash.
  const members = new Set(elements.map((element) => element.id));
  const clashes = findNewNetworkPipeClashes([...scene], elements, [])
    .filter((clash) => !(members.has(clash.elementIds[0]) && members.has(clash.elementIds[1])));
  if (clashes.length) return { elements: [], reason: 'The hop would clash with another refrigerant run.' };
  return { elements, riseMm: rise };
}

/** Builds store updates for the approved hops; lines crossed in one window hop together. */
export function buildRefrigerantHopUpdates(
  scene: HvacElement[],
  proposals: readonly RefrigerantHopProposal[],
  _settings: CondensateDesignSettings,
  routing: Pick<PipeRoutingSettings, 'ceilingLimitMm'>,
): { updates: Array<{ id: string; updates: Partial<HvacElement> }>; rejected: Array<{ key: string; reason: string }> } {
  // Cluster proposals whose crossings sit within one hop's reach of each other
  // (a pair crossed once, or several drains crossing the same stretch).
  const parent = proposals.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  for (let i = 0; i < proposals.length; i += 1) {
    for (let j = i + 1; j < proposals.length; j += 1) {
      const reach = 2 * (Math.max(proposals[i]!.halfWindowMm, proposals[j]!.halfWindowMm) + HOP_APPROACH_MM);
      if (distance(proposals[i]!.point, proposals[j]!.point) <= reach) parent[find(i)] = find(j);
    }
  }
  const windows = new Map<number, RefrigerantHopProposal[]>();
  proposals.forEach((proposal, index) => {
    const root = find(index);
    const list = windows.get(root) ?? [];
    list.push(proposal);
    windows.set(root, list);
  });
  let working = [...scene];
  const changed = new Map<string, HvacElement>();
  const rejected: Array<{ key: string; reason: string }> = [];
  for (const group of windows.values()) {
    const result = buildHopGroup(working, group, routing);
    if (result.reason || !result.elements.length) {
      for (const proposal of group) rejected.push({ key: proposal.key, reason: result.reason ?? 'Hop not possible.' });
      continue;
    }
    for (const element of result.elements) {
      changed.set(element.id, element);
      working = working.map((candidate) => (candidate.id === element.id ? element : candidate));
    }
  }
  return {
    updates: [...changed.values()].map((element) => ({
      id: element.id,
      updates: {
        position: element.position,
        width: element.width,
        depth: element.depth,
        elevation: element.elevation,
        height: element.height,
        properties: element.properties,
      },
    })),
    rejected,
  };
}
