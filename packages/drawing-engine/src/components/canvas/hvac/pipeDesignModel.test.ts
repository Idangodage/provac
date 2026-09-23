import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import {
  designWithNodePositions, hasPersistedPipeDesign, insertDesignJoint, readPipeDesign,
  readPipeSegmentMaterials, removeDesignJoint, writePipeDesign,
} from './pipeDesignModel';
import type { PipeRouteNode3D } from './pipeRoute3d';

const element = (properties: Record<string, unknown>, overrides: Partial<HvacElement> = {}): HvacElement => ({
  id: 'pipe-1',
  type: 'refrigerant-pipe',
  label: 'Liquid Pipe',
  position: { x: 0, y: 0 },
  width: 100, depth: 100, height: 50,
  elevation: 2000, rotation: 0,
  mountType: 'ceiling', supplyZoneRatio: 0,
  properties: { lineKind: 'liquid', pipeDiameterMm: 9.52, outerDiameterMm: 9.52, ...properties },
  ...overrides,
} as unknown as HvacElement);

const unit = (id: string): HvacElement => element({}, {
  id, type: 'outdoor-unit', label: id,
} as Partial<HvacElement>);

/** An L route stored with explicit 3D nodes. */
const L_ROUTE: PipeRouteNode3D[] = [
  { x: 0, y: 0, z: 2600 }, { x: 2000, y: 0, z: 2600 }, { x: 2000, y: 3000, z: 2600 },
];

function routed(nodes: PipeRouteNode3D[], extra: Record<string, unknown> = {}): HvacElement {
  return element({
    routePoints: nodes.map(({ x, y }) => ({ x, y })),
    routeNodes3d: nodes,
    segmentMaterials: nodes.slice(1).map(() => 'flexible'),
    ...extra,
  });
}

const portConnection = (point: { x: number; y: number }, direction: { x: number; y: number },
  elevationMm: number, sourceElementId = 'odu-1') => ({
  connectionKind: 'unit-port', sourceElementId,
  portPoint: point, direction, elevationMm,
});

describe('readPipeDesign — reconstruction', () => {
  it('builds identified nodes, legs and joints from a stored 3D route', () => {
    const design = readPipeDesign(routed(L_ROUTE));
    expect(design.nodes).toHaveLength(3);
    expect(design.legs).toHaveLength(2);
    expect(design.joints).toHaveLength(1);
    expect(design.provenance).toBe('reconstructed');
    // Every leg names real nodes, and the joint names a real node.
    const ids = new Set(design.nodes.map(node => node.id));
    expect(design.legs.every(leg => ids.has(leg.fromNodeId) && ids.has(leg.toNodeId))).toBe(true);
    expect(ids.has(design.joints[0]!.nodeId)).toBe(true);
    expect(design.joints[0]!.includedAngleDeg).toBeCloseTo(90, 6);
  });

  it('never invents a part number for a recovered corner', () => {
    const design = readPipeDesign(routed(L_ROUTE, { fieldBendConstruction: 'socket-elbow' }));
    expect(design.joints[0]!.catalogueId).toBeNull();
    expect(design.joints[0]!.constructionSource).toBe('element-policy');
  });

  it('marks a recovered radius as unverified rather than presenting it as a fitting spec', () => {
    const design = readPipeDesign(routed(L_ROUTE));
    expect(design.joints[0]!.radiusMm.verified).toBe(false);
    expect(design.joints[0]!.radiusMm.note).toBeTruthy();
  });

  it('derives leg length and direction rather than trusting stored values', () => {
    const design = readPipeDesign(routed(L_ROUTE));
    expect(design.legs[0]!.lengthMm).toBeCloseTo(2000, 6);
    expect(design.legs[0]!.direction).toMatchObject({ x: 1, y: 0, z: 0 });
  });
});

describe('readPipeDesign — port frames', () => {
  it('reads a unit port as a 3D frame with a plan-derived axis', () => {
    const design = readPipeDesign(
      routed(L_ROUTE, { startConnection: portConnection({ x: 0, y: 0 }, { x: 1, y: 0 }, 2600) }),
      [unit('odu-1')]);
    expect(design.ports.start.kind).toBe('unit-port');
    expect(design.ports.start.origin).toEqual({ x: 0, y: 0, z: 2600 });
    expect(design.ports.start.axis).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(design.ports.start.axisSource).toBe('derived-plan');
    // The reserved stub is a project setting, not a manufacturer limit.
    expect(design.ports.start.straightApproachMm.verified).toBe(false);
  });

  it('reports an unresolvable connection as unresolved, never as an open end', () => {
    const design = readPipeDesign(
      routed(L_ROUTE, { startConnection: portConnection({ x: 0, y: 0 }, { x: 1, y: 0 }, 2600, 'missing-unit') }),
      []);
    expect(design.ports.start.kind).toBe('unresolved');
    expect(design.ports.start.unresolvedReason).toContain('missing-unit');
    expect(design.unresolved.some(entry => entry.startsWith('start:'))).toBe(true);
  });

  it('reports a genuinely absent connection as open', () => {
    const design = readPipeDesign(routed(L_ROUTE));
    expect(design.ports.start.kind).toBe('open');
    expect(design.ports.start.origin).toBeNull();
  });
});

describe('readPipeDesign — plan-only migration', () => {
  /** No routeNodes3d; ends welded at different heights. */
  const planOnly = element({
    routePoints: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 3000 }],
    segmentMaterials: ['flexible', 'flexible'],
    startConnection: portConnection({ x: 0, y: 0 }, { x: 1, y: 0 }, 2600),
    endConnection: portConnection({ x: 2000, y: 3000 }, { x: 0, y: -1 }, 1400, 'idu-1'),
  });
  const scene = [unit('odu-1'), unit('idu-1')];

  it('recovers a real vertical transition instead of flattening to the start elevation', () => {
    const design = readPipeDesign(planOnly, scene);
    expect(design.provenance).toBe('migrated');
    // Both welds are reached at their own elevation.
    expect(design.nodes[0]!.z).toBeCloseTo(2600, 6);
    expect(design.nodes.at(-1)!.z).toBeCloseTo(1400, 6);
    // The transition is a real vertical leg, not a ramp along the run.
    const vertical = design.legs.filter(leg => Math.abs(leg.direction.z) > 0.99);
    expect(vertical).toHaveLength(1);
    expect(vertical[0]!.lengthMm).toBeCloseTo(1200, 6);
  });

  it('keeps the terminal approach horizontal at port level', () => {
    const design = readPipeDesign(planOnly, scene);
    const last = design.legs.at(-1)!;
    expect(Math.abs(last.direction.z)).toBeLessThan(1e-6);
    expect(design.nodes.at(-2)!.z).toBeCloseTo(1400, 6);
  });

  it('is idempotent — a second pass adds no second riser', () => {
    const once = readPipeDesign(planOnly, scene);
    const written = writePipeDesign(planOnly, once);
    const twice = readPipeDesign(written, scene);
    expect(twice.nodes).toHaveLength(once.nodes.length);
    expect(twice.legs.filter(leg => Math.abs(leg.direction.z) > 0.99)).toHaveLength(1);
  });

  it('reports an impossible transition rather than inventing a riser location', () => {
    const twoNode = element({
      routePoints: [{ x: 0, y: 0 }, { x: 2000, y: 0 }],
      segmentMaterials: ['flexible'],
      startConnection: portConnection({ x: 0, y: 0 }, { x: 1, y: 0 }, 2600),
      endConnection: portConnection({ x: 2000, y: 0 }, { x: -1, y: 0 }, 1400, 'idu-1'),
    });
    const design = readPipeDesign(twoNode, scene);
    expect(design.nodes).toHaveLength(2);
    expect(design.unresolved.join(' ')).toContain('vertical transition');
    expect(design.provenance).not.toBe('migrated');
  });
});

describe('writePipeDesign — round trip', () => {
  it('persists identities and reads them back unchanged', () => {
    const source = routed(L_ROUTE);
    const design = readPipeDesign(source);
    const written = writePipeDesign(source, design);

    expect(hasPersistedPipeDesign(written)).toBe(true);
    const reread = readPipeDesign(written);
    expect(reread.provenance).toBe('authored');
    expect(reread.nodes.map(node => node.id)).toEqual(design.nodes.map(node => node.id));
    expect(reread.legs.map(leg => leg.id)).toEqual(design.legs.map(leg => leg.id));
    expect(reread.joints.map(joint => joint.id)).toEqual(design.joints.map(joint => joint.id));
    expect(reread.nodes.map(node => [node.x, node.y, node.z]))
      .toEqual(design.nodes.map(node => [node.x, node.y, node.z]));
  });

  it('regenerates the fabrication route so every renderer keeps reading the truth', () => {
    const source = routed(L_ROUTE);
    const written = writePipeDesign(source, readPipeDesign(source));
    expect(written.properties.routePoints).toEqual([
      { x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 3000 },
    ]);
    expect(written.properties.routeNodes3d).toEqual(L_ROUTE);
    expect(written.properties.centerline_start).toEqual({ x: 0, y: 0 });
    expect(written.properties.centerline_end).toEqual({ x: 2000, y: 3000 });
  });

  it('always writes exactly one material per leg', () => {
    // The defect this prevents: a node count that changed while the material
    // array did not, which silently falls back to re-inference on next read.
    const source = routed(L_ROUTE);
    const design = readPipeDesign(source);
    const grown = designWithNodePositions(design, [
      { x: 0, y: 0, z: 2600 }, { x: 2000, y: 0, z: 2600 }, { x: 2000, y: 3000, z: 2600 },
    ]);
    const written = writePipeDesign(source, grown);
    expect((written.properties.segmentMaterials as unknown[])).toHaveLength(grown.legs.length);
    expect(readPipeSegmentMaterials(written)).toHaveLength(grown.legs.length);
  });

  it('keeps the legacy connection projection in step with the port frame', () => {
    const source = routed(L_ROUTE, {
      startConnection: portConnection({ x: 0, y: 0 }, { x: 1, y: 0 }, 2600),
    });
    const design = readPipeDesign(source, [unit('odu-1')]);
    const written = writePipeDesign(source, design);
    const connection = written.properties.startConnection as Record<string, unknown>;
    expect(connection.elevationMm).toBe(2600);
    expect(connection.direction).toEqual({ x: 1, y: 0 });
    // Identity fields are carried through untouched.
    expect(connection.sourceElementId).toBe('odu-1');
  });
});

describe('designWithNodePositions', () => {
  it('moves geometry while preserving every identity and recomputing derived values', () => {
    const design = readPipeDesign(routed(L_ROUTE));
    const moved = designWithNodePositions(design, [
      { x: 0, y: 0, z: 2600 }, { x: 2500, y: 0, z: 2600 }, { x: 2500, y: 3000, z: 2600 },
    ]);
    expect(moved.nodes.map(node => node.id)).toEqual(design.nodes.map(node => node.id));
    expect(moved.legs[0]!.lengthMm).toBeCloseTo(2500, 6);
    expect(moved.joints[0]!.includedAngleDeg).toBeCloseTo(90, 6);
  });

  it('refuses a position list that does not match the topology', () => {
    const design = readPipeDesign(routed(L_ROUTE));
    expect(designWithNodePositions(design, [{ x: 0, y: 0, z: 0 }])).toBe(design);
  });
});

describe('topology — identities survive insertion and removal', () => {
  const ids = (source: ReturnType<typeof readPipeDesign>) => ({
    nodes: source.nodes.map(node => node.id),
    legs: source.legs.map(leg => leg.id),
    joints: source.joints.map(joint => joint.id),
  });

  it('splits a leg, keeping every existing identity and minting unique new ones', () => {
    const before = readPipeDesign(routed(L_ROUTE));
    const result = insertDesignJoint(before, before.legs[0]!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.design;
    expect(after.nodes).toHaveLength(before.nodes.length + 1);
    expect(after.legs).toHaveLength(before.legs.length + 1);
    expect(after.joints).toHaveLength(before.joints.length + 1);

    // Nothing that existed lost its identity.
    for (const id of ids(before).nodes) expect(ids(after).nodes).toContain(id);
    for (const id of ids(before).joints) expect(ids(after).joints).toContain(id);
    // The split leg keeps its id for the first half.
    expect(ids(after).legs).toContain(before.legs[0]!.id);
    // Every identity is unique.
    const all = [...ids(after).nodes, ...ids(after).legs, ...ids(after).joints];
    expect(new Set(all).size).toBe(all.length);
  });

  it('inserts at the true 3D midpoint by default', () => {
    const before = readPipeDesign(routed(L_ROUTE));
    const result = insertDesignJoint(before, before.legs[0]!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design.nodes[1]).toMatchObject({ x: 1000, y: 0, z: 2600 });
  });

  it('records no part number for a corner nobody has chosen a fitting for', () => {
    const before = readPipeDesign(routed(L_ROUTE));
    const result = insertDesignJoint(before, before.legs[0]!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inserted = result.design.joints.find(joint => !ids(before).joints.includes(joint.id))!;
    expect(inserted.catalogueId).toBeNull();
  });

  it('refuses an insertion with no room on both sides', () => {
    const tight = readPipeDesign(routed([
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 500, z: 0 },
    ]));
    const result = insertDesignJoint(tight, tight.legs[0]!.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('room');
  });

  it('removes a bend, rejoins the route and keeps the surviving identities', () => {
    const before = readPipeDesign(routed([
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 },
      { x: 1000, y: 1000, z: 0 }, { x: 2000, y: 1000, z: 0 },
    ]));
    const result = removeDesignJoint(before, before.joints[0]!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.design;
    expect(after.nodes).toHaveLength(before.nodes.length - 1);
    expect(after.legs).toHaveLength(before.legs.length - 1);
    expect(after.joints).toHaveLength(before.joints.length - 1);
    // The upstream leg survives and now spans the join.
    expect(after.legs[0]!.id).toBe(before.legs[0]!.id);
    expect(after.legs[0]!.toNodeId).toBe(before.legs[1]!.toNodeId);
    // Terminal identities are untouched.
    expect(after.nodes[0]!.id).toBe(before.nodes[0]!.id);
    expect(after.nodes.at(-1)!.id).toBe(before.nodes.at(-1)!.id);
  });

  it('refuses to remove a corner that separates two materials', () => {
    const mixed = readPipeDesign(element({
      routePoints: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }],
      routeNodes3d: [
        { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 1000, z: 0 },
      ],
      segmentMaterials: ['hard', 'flexible'],
    }));
    const result = removeDesignJoint(mixed, mixed.joints[0]!.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('different pipe materials');
  });

  it('refuses to remove a locked bend', () => {
    const before = readPipeDesign(routed(L_ROUTE));
    const locked = { ...before, joints: before.joints.map(joint => ({ ...joint, lock: 'rigid' as const })) };
    const result = removeDesignJoint(locked, before.joints[0]!.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('locked');
  });

  it('removing the only bend leaves a valid straight pipe', () => {
    const before = readPipeDesign(routed(L_ROUTE));
    const result = removeDesignJoint(before, before.joints[0]!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design.nodes).toHaveLength(2);
    expect(result.design.legs).toHaveLength(1);
    expect(result.design.joints).toHaveLength(0);
    // Both welds keep their identities; only the corner between them is gone.
    expect(result.design.nodes[0]!.id).toBe(before.nodes[0]!.id);
    expect(result.design.nodes[1]!.id).toBe(before.nodes[2]!.id);
  });

  it('refuses to remove a terminal, which is a weld rather than a bend', () => {
    const before = readPipeDesign(routed(L_ROUTE));
    const result = removeDesignJoint(before, 'not-a-joint');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Select a bend');
  });

  it('survives a persistence round trip with the inserted identities intact', () => {
    const source = routed(L_ROUTE);
    const before = readPipeDesign(source);
    const inserted = insertDesignJoint(before, before.legs[0]!.id);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const written = writePipeDesign(source, inserted.design);
    const reread = readPipeDesign(written);
    expect(reread.nodes.map(node => node.id)).toEqual(inserted.design.nodes.map(node => node.id));
    expect(reread.legs.map(leg => leg.id)).toEqual(inserted.design.legs.map(leg => leg.id));
    expect(reread.joints.map(joint => joint.id)).toEqual(inserted.design.joints.map(joint => joint.id));
    // Materials stay one-per-leg through a topology change.
    expect(readPipeSegmentMaterials(written)).toHaveLength(inserted.design.legs.length);
  });
});
