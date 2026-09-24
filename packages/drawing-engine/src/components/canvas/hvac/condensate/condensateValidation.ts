/**
 * Live design checks for condensate drainage — the same rules the generator
 * designs to, re-checked on whatever is in the drawing (field edits included).
 * Issues use the VRF report shape so they appear in the one design-check list.
 *
 *  CD_ADVERSE_FALL  a run rises in the flow direction (outside a pump riser)
 *  CD_FALL_MIN      a run falls less than the minimum
 *  CD_JOIN_FROM_TOP a branch enters a main below its crown
 *  CD_SIZE_DECREASE a pipe is smaller than a pipe feeding it
 *  CD_SIZE_CAPACITY a pipe is smaller than the capacity table requires
 *  CD_PUMP_LIFT     a lift exceeds the pump head / rises too far from the unit
 *  CD_RUN_LENGTH    a unit's drain run exceeds the advisory maximum
 *  CD_AIR_VENT      a pumped collective main has no air vent
 *  CD_TRAP          a negative-pressure gravity unit has no trap
 *  CD_AIR_BREAK     the drop does not stop an air break above the receptor
 *  CD_ENVELOPE      a run leaves the ceiling void
 *  CD_CLASH         a drain is closer to a refrigerant run than their insulation
 *  CD_OPEN_END      a pipe ends at a junction nothing continues from
 *  CD_STALE         a unit or termination moved after the network was generated
 *  CD_UNCONNECTED_UNIT  an indoor unit drain is not connected (information)
 */
import type { HvacElement, Point2D } from '../../../../types';
import type { VrfValidationIssue, VrfValidationReport } from '../../../../vrf/rules';
import { listNetworkPipeLanes } from '../networkPipeClearance';
import type { PipeRoutingSettings } from '../pipeRoutingSettings';

import { condensateNetworkSourceSignature } from './condensateElements';
import { buildCondensateSink, connectedUnitIdsOf, deriveCondensateEnvelope, UNIT_CONNECTION_ZONE_MM } from './condensateEnvironment';
import { minimumInnerDiameterForCapacity } from './condensatePipeCatalog';
import { CONDENSATE_INDOOR_UNIT_TYPES, getIndoorUnitDrainPort } from './condensatePorts';
import type { CondensateDesignSettings } from './condensateSettings';
import {
  CONDENSATE_TUNDISH_HEIGHT_MM,
  condensateInsulatedRadiusMm,
  getCondensateOwnership,
  isCondensateGully,
  isCondensatePipe,
  readCondensateGullySpec,
  readCondensatePipeSpec,
  type CondensatePipeSpec,
  type Point3,
} from './condensateTypes';

type Level = VrfValidationIssue['level'];

function issue(code: string, level: Level, entityId: string, message: string, suggestedFix?: string, regenerate = false): VrfValidationIssue {
  return {
    id: `${code}:${entityId}`,
    level,
    code,
    entityId,
    message,
    ...(suggestedFix ? { suggestedFix } : {}),
    ...(regenerate ? { fix: { kind: 'regenerate-condensate' as const } } : {}),
  };
}

function segmentDistance3(a: Point3, b: Point3, c: Point3, d: Point3): number {
  // Closest points between two finite 3D segments (clamped).
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const v = { x: d.x - c.x, y: d.y - c.y, z: d.z - c.z };
  const w = { x: a.x - c.x, y: a.y - c.y, z: a.z - c.z };
  const dot = (p: Point3, q: Point3) => p.x * q.x + p.y * q.y + p.z * q.z;
  const A = dot(u, u); const B = dot(u, v); const C = dot(v, v); const D = dot(u, w); const E = dot(v, w);
  const denominator = A * C - B * B;
  let s = denominator > 1e-9 ? (B * E - C * D) / denominator : 0;
  s = Math.max(0, Math.min(1, s));
  let t = C > 1e-9 ? (B * s + E) / C : 0;
  if (t < 0) { t = 0; s = A > 1e-9 ? Math.max(0, Math.min(1, -D / A)) : 0; }
  else if (t > 1) { t = 1; s = A > 1e-9 ? Math.max(0, Math.min(1, (B - D) / A)) : 0; }
  const p = { x: a.x + u.x * s, y: a.y + u.y * s, z: a.z + u.z * s };
  const q = { x: c.x + v.x * t, y: c.y + v.y * t, z: c.z + v.z * t };
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

function planLength(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * The part of a drain segment (flowing away from its outlet) that lies outside
 * the unit connection zone, as its new start point; null when it is all inside.
 */
function clipOutsideZone(a: Point3, b: Point3, center: Point2D, radius: number): Point3 | null {
  const inside = (p: Point2D) => planLength(p, center) <= radius;
  if (!inside(a)) return a;
  if (inside(b)) return null;
  let lo = 0;
  let hi = 1;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const mid = (lo + hi) / 2;
    const p = { x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid };
    if (inside(p)) lo = mid; else hi = mid;
  }
  return { x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi, z: a.z + (b.z - a.z) * hi };
}

export interface CondensateValidationOptions {
  settings: CondensateDesignSettings;
  routingSettings: Pick<PipeRoutingSettings, 'ceilingLimitMm'>;
}

export function validateCondensateNetwork(scene: readonly HvacElement[], options: CondensateValidationOptions): VrfValidationReport {
  const { settings } = options;
  const issues: VrfValidationIssue[] = [];
  const pipes = scene.filter(isCondensatePipe);
  const gullies = scene.filter(isCondensateGully);
  if (!pipes.length && !gullies.length) return { issues, commitBlocked: false, counts: { error: 0, warning: 0, advisory: 0, information: 0 } };
  const specs = new Map(pipes.map((pipe) => [pipe.id, readCondensatePipeSpec(pipe)]));
  const byStartNode = new Map<string, Array<{ id: string; spec: CondensatePipeSpec }>>();
  for (const [id, spec] of specs) {
    const nodeId = spec.drainStart?.nodeId;
    if (!nodeId) continue;
    const list = byStartNode.get(nodeId) ?? [];
    list.push({ id, spec });
    byStartNode.set(nodeId, list);
  }
  const unitsById = new Map(scene.filter((element) => CONDENSATE_INDOOR_UNIT_TYPES.has(element.type)).map((element) => [element.id, element]));
  const envelope = deriveCondensateEnvelope(scene, settings, options.routingSettings);
  const minimumSlope = settings.minSlopePercent - 0.02;

  for (const pipe of pipes) {
    const spec = specs.get(pipe.id)!;
    const nodes = spec.routeNodes3d;
    const radius = condensateInsulatedRadiusMm(spec);
    const label = `${pipe.label || 'Condensate pipe'}`;
    let adverse = false;
    let shallow: number | null = null;
    nodes.forEach((node, index) => {
      if (index === 0) return;
      const previous = nodes[index - 1]!;
      const run = planLength(previous, node);
      const rise = node.z - previous.z;
      const pumpConnection = spec.pumped && index <= 2 && run <= settings.liftMaxHorizontalMm + 1;
      if (pumpConnection) {
        const unitId = spec.drainStart?.unitId;
        const unit = unitId ? unitsById.get(unitId) : undefined;
        const port = unit ? getIndoorUnitDrainPort(unit, settings) : null;
        if (run < 1 && rise > 0 && port && rise > port.pumpMaxLiftMm + 1) {
          issues.push(issue('CD_PUMP_LIFT', 'error', pipe.id, `${label}: the drain lift of ${Math.round(rise)} mm exceeds the ${port.label} pump head (${Math.round(port.pumpMaxLiftMm)} mm).`, 'Reduce the lift or regenerate the network.', true));
        }
        return;
      }
      if (rise > 1) adverse = true;
      if (run > 60 && rise <= 1) {
        const slope = ((previous.z - node.z) / run) * 100;
        if (slope < minimumSlope) shallow = Math.min(shallow ?? slope, slope);
      }
      if (run > 60 && spec.segmentRole === 'main' && node.z - radius < envelope.ceilingPlaneMm - 1) {
        issues.push(issue('CD_ENVELOPE', 'warning', pipe.id, `${label} runs below the ceiling plane (${Math.round(envelope.ceilingPlaneMm)} mm).`, 'Lower the ceiling-void settings or regenerate.'));
      }
      if (node.z + radius > envelope.soffitMm + 1) {
        issues.push(issue('CD_ENVELOPE', 'warning', pipe.id, `${label} rises above the soffit (${Math.round(envelope.soffitMm)} mm).`));
      }
    });
    if (adverse) {
      issues.push(issue('CD_ADVERSE_FALL', 'error', pipe.id, `${label} rises in the direction of flow — a trap or back-fall that will hold water.`, 'Regenerate the network or restore a continuous fall.', true));
    }
    if (shallow !== null) {
      issues.push(issue('CD_FALL_MIN', 'error', pipe.id, `${label} falls only ${(shallow as number).toFixed(2)} % (minimum ${settings.minSlopePercent} %).`, 'Regenerate the network to restore the fall.', true));
    }
    // Branch into the crown of the main.
    for (const fitting of spec.fittings) {
      if (fitting.kind !== 'wye') continue;
      const end = nodes[nodes.length - 1];
      if (end && end.z < fitting.point.z + fitting.outerDiameterMm / 2 - 1) {
        issues.push(issue('CD_JOIN_FROM_TOP', 'error', pipe.id, `${label} enters its main below the crown; water can back up into the branch.`, 'Branches must join mains from the top.', true));
      }
    }
    // Continuity and size downstream.
    const endNode = spec.drainEnd?.kind === 'junction' ? spec.drainEnd.nodeId : undefined;
    if (endNode) {
      const next = byStartNode.get(endNode) ?? [];
      if (!next.length) {
        issues.push(issue('CD_OPEN_END', 'warning', pipe.id, `${label} ends at a junction that no pipe continues from.`, 'Regenerate the network.', true));
      }
      for (const downstream of next) {
        if (downstream.spec.outerDiameterMm + 0.01 < spec.outerDiameterMm) {
          issues.push(issue('CD_SIZE_DECREASE', 'error', downstream.id, `Condensate pipe ${downstream.spec.nominalSize} is smaller than the ${spec.nominalSize} pipe feeding it.`, 'A drain must never reduce toward its discharge.'));
        }
      }
    }
    const { minInnerDiameterMm } = minimumInnerDiameterForCapacity(spec.upstreamCapacityKw, settings);
    if (spec.upstreamCapacityKw > 0 && spec.innerDiameterMm + 0.05 < minInnerDiameterMm) {
      issues.push(issue('CD_SIZE_CAPACITY', 'warning', pipe.id, `${label} (ID ${spec.innerDiameterMm} mm) is below the ${minInnerDiameterMm.toFixed(1)} mm required for ${spec.upstreamCapacityKw.toFixed(1)} kW.`));
    }
  }

  // Networks: stale inputs, vents, traps, air breaks, run lengths.
  const networks = new Map<string, HvacElement[]>();
  for (const pipe of pipes) {
    const owner = getCondensateOwnership(pipe);
    if (!owner) continue;
    const list = networks.get(owner.networkId) ?? [];
    list.push(pipe);
    networks.set(owner.networkId, list);
  }
  for (const [networkId, members] of networks) {
    const owner = getCondensateOwnership(members[0]!)!;
    const gully = gullies.find((element) => element.id === owner.gullyId);
    const units = owner.unitIds.map((id) => unitsById.get(id)).filter((unit): unit is HvacElement => Boolean(unit));
    const ports = units.map((unit) => getIndoorUnitDrainPort(unit, settings)).filter((port): port is NonNullable<typeof port> => port !== null);
    const anchor = members[0]!.id;
    if (!gully || ports.length !== owner.unitIds.length) {
      issues.push(issue('CD_STALE', 'warning', anchor, 'A unit or termination of this condensate network was removed.', 'Regenerate the condensate network.', true));
    } else {
      const sink = buildCondensateSink(gully, settings, []);
      const signature = condensateNetworkSourceSignature({ sink, units: ports.map((source) => ({ source })) });
      if (signature !== owner.sourceSignature) {
        issues.push(issue('CD_STALE', 'warning', anchor, 'A unit or termination moved after this condensate network was generated.', 'Regenerate the condensate network.', true));
      }
      const memberSpecs = members.map((member) => specs.get(member.id)!);
      if (sink.kind === 'floor-gully') {
        const drop = memberSpecs.find((spec) => spec.segmentRole === 'drop');
        const gullySpec = readCondensateGullySpec(gully);
        const receptor = gullySpec.terminalTrap === 'tundish' ? CONDENSATE_TUNDISH_HEIGHT_MM : 0;
        const bottom = drop?.routeNodes3d[drop.routeNodes3d.length - 1]?.z;
        if (bottom !== undefined && bottom < gullySpec.inletElevationMm + receptor + Math.min(gullySpec.airBreakMm, settings.airBreakMm) - 1) {
          issues.push(issue('CD_AIR_BREAK', 'warning', anchor, `The drop into ${gully.label} has no visible air break above the receptor.`, 'Indirect discharge needs an air gap above the flood rim.'));
        }
      }
      const pumped = memberSpecs.some((spec) => spec.pumped);
      if (settings.airVentForPumpedMains && pumped && owner.unitIds.length >= 2
        && !memberSpecs.some((spec) => spec.fittings.some((fitting) => fitting.kind === 'air-vent'))) {
        issues.push(issue('CD_AIR_VENT', 'warning', anchor, 'A collective main carrying pumped units has no air vent at its head.', 'Fit an air vent at the highest point of the collective drain.'));
      }
      for (const port of ports) {
        const branch = memberSpecs.find((spec) => spec.drainStart?.unitId === port.unitId);
        if (settings.trapNegativePressureUnits && port.negativePressure && branch && !branch.pumped
          && !branch.fittings.some((fitting) => fitting.kind === 'p-trap')) {
          issues.push(issue('CD_TRAP', 'warning', port.unitId, `${port.label} drains under negative pressure without a trap.`, 'Fit a P-trap sized to the fan static pressure.'));
        }
      }
      // Run length from each unit to the termination along the network.
      for (const port of ports) {
        let length = 0;
        let cursor = memberSpecs.find((spec) => spec.drainStart?.unitId === port.unitId);
        const guard = new Set<CondensatePipeSpec>();
        while (cursor && !guard.has(cursor)) {
          guard.add(cursor);
          const nodes = cursor.routeNodes3d;
          for (let index = 1; index < nodes.length; index += 1) length += planLength(nodes[index - 1]!, nodes[index]!);
          const next = cursor.drainEnd?.nodeId ? byStartNode.get(cursor.drainEnd.nodeId)?.find((entry) => memberSpecs.includes(entry.spec)) : undefined;
          cursor = next?.spec;
        }
        if (length > settings.maxUnitRunMm) {
          issues.push(issue('CD_RUN_LENGTH', 'advisory', port.unitId, `${port.label} drains through ${(length / 1000).toFixed(1)} m of horizontal pipe (advisory maximum ${(settings.maxUnitRunMm / 1000).toFixed(0)} m).`));
        }
      }
      void networkId;
    }
  }

  // Unconnected indoor drains (only once a termination exists).
  if (gullies.length) {
    const connected = new Set(pipes.flatMap((pipe) => specs.get(pipe.id)!.upstreamUnitIds));
    for (const unit of unitsById.values()) {
      if (connected.has(unit.id) || !getIndoorUnitDrainPort(unit, settings)) continue;
      issues.push(issue('CD_UNCONNECTED_UNIT', 'information', unit.id, `${unit.label || unit.id} has no condensate drain.`, 'Generate the condensate network.', true));
    }
  }

  // 3D clash with refrigerant runs (insulated surfaces touching).
  for (const clash of findCondensateRefrigerantClashes(scene)) {
    const pipe = pipes.find((candidate) => candidate.id === clash.condensateId);
    issues.push(issue('CD_CLASH', 'error', clash.condensateId, `${pipe?.label || 'Condensate pipe'} clashes with refrigerant run ${clash.refrigerantId}.`, 'Regenerate the network (it coordinates below / above refrigerant runs).', true));
  }

  const unique = [...new Map(issues.map((entry) => [entry.id, entry])).values()];
  const counts = { error: 0, warning: 0, advisory: 0, information: 0 } as VrfValidationReport['counts'];
  for (const entry of unique) counts[entry.level] += 1;
  return { issues: unique, commitBlocked: false, counts };
}

/**
 * Condensate ↔ refrigerant contacts (insulated surfaces touching), one entry
 * per drain pipe (its first contact). A unit's drain and its own refrigerant
 * stubs share the manufacturer's connection zone around the drain outlet —
 * the same exemption the generator applies.
 */
export function findCondensateRefrigerantClashes(scene: readonly HvacElement[]): Array<{ condensateId: string; refrigerantId: string }> {
  const pipes = scene.filter(isCondensatePipe);
  if (!pipes.length) return [];
  // Drains meet each other by design at wyes; coordinate against refrigerant only.
  const lanes = listNetworkPipeLanes([...scene]).filter((lane) => lane.service !== 'drain');
  const byId = new Map(scene.map((element) => [element.id, element]));
  const clashes: Array<{ condensateId: string; refrigerantId: string }> = [];
  for (const pipe of pipes) {
    const spec = readCondensatePipeSpec(pipe);
    const radius = condensateInsulatedRadiusMm(spec);
    const ownUnit = spec.drainStart?.kind === 'unit-drain' ? spec.drainStart : null;
    let clash: string | null = null;
    for (const lane of lanes) {
      const sharesZone = ownUnit?.unitId ? connectedUnitIdsOf(byId.get(lane.elementId)).includes(ownUnit.unitId) : false;
      for (const segment of lane.segments) {
        for (let index = 1; index < spec.routeNodes3d.length && !clash; index += 1) {
          let a = spec.routeNodes3d[index - 1]!;
          const b = spec.routeNodes3d[index]!;
          if (sharesZone && ownUnit) {
            const clipped = clipOutsideZone(a, b, ownUnit.point, UNIT_CONNECTION_ZONE_MM);
            if (!clipped) continue;
            a = clipped;
          }
          if (segmentDistance3(a, b, segment.a, segment.b) < radius + lane.radiusMm - 0.5) clash = lane.elementId;
        }
        if (clash) break;
      }
      if (clash) break;
    }
    if (clash) clashes.push({ condensateId: pipe.id, refrigerantId: clash });
  }
  return clashes;
}

export function mergeValidationReports(a: VrfValidationReport, b: VrfValidationReport): VrfValidationReport {
  if (!b.issues.length) return a;
  const issues = [...a.issues, ...b.issues];
  const counts = { ...a.counts };
  for (const level of Object.keys(b.counts) as Array<keyof typeof counts>) counts[level] = (counts[level] ?? 0) + b.counts[level];
  return { issues, commitBlocked: a.commitBlocked || b.commitBlocked, counts };
}
