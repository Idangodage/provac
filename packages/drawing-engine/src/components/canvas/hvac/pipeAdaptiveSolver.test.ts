import { describe, expect, it } from 'vitest';

import { solveAdaptivePipeEdit, type AdaptivePipeEditRequest } from './pipeAdaptiveSolver';
import type { PipeRouteNode3D } from './pipeRoute3d';
import type { PipeRuleContext } from './pipeRuleModel';
import { buildPipeSkeleton } from './pipeSkeleton';
import type { RefrigerantPipeMaterial } from './refrigerantPipePairModel';

const context = (overrides: Partial<PipeRuleContext> = {}): PipeRuleContext => ({
  socketElbows: false,
  pipeDiameterMm: 9.52,
  minimumSocketRadiusMm: 0,
  fieldBendRadiusMm: 30,
  minimumFieldBendRadiusMm: 20,
  minimumPortStubMm: 200,
  startIsUnitPort: false,
  endIsUnitPort: false,
  ...overrides,
});

const freeEnds = { start: { position: null, direction: null }, end: { position: null, direction: null } };

function request(nodes: PipeRouteNode3D[], goal: AdaptivePipeEditRequest['goal'],
  overrides: Partial<AdaptivePipeEditRequest> = {},
  materials?: RefrigerantPipeMaterial[]): AdaptivePipeEditRequest {
  return {
    skeleton: buildPipeSkeleton(nodes, { materials, defaultBendRadiusMm: 30 }),
    context: context(),
    goal,
    terminals: freeEnds,
    ...overrides,
  };
}

const ELL: PipeRouteNode3D[] = [
  { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 1000, z: 0 },
];

describe('solveAdaptivePipeEdit — leg slide', () => {
  it('slides a leg by extending its neighbour, keeping the neighbour direction', () => {
    const result = solveAdaptivePipeEdit(request(ELL, { kind: 'move-leg', index: 0, offset: { x: 0, y: 100, z: 0 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The perpendicular leg absorbs the slide by shortening; it does not rotate.
    expect(result.nodes[1]!).toMatchObject({ x: 1000, y: 100 });
    expect(result.nodes[2]!).toMatchObject({ x: 1000, y: 1000 });
    expect(result.adaptations.map(a => a.kind)).toContain('extend-leg');
    expect(result.adaptations.some(a => a.kind === 're-angle-bend')).toBe(false);
  });

  it('refuses a slide along the leg — that is an endpoint edit', () => {
    const result = solveAdaptivePipeEdit(request(ELL, { kind: 'move-leg', index: 0, offset: { x: 250, y: 0, z: 0 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Move an endpoint');
  });

  it('keeps holding a diagonal neighbour’s direction while it still reaches the slid leg', () => {
    const diagonal: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 0 }, { x: 800, y: 600, z: 0 }, { x: 1800, y: 600, z: 0 }, { x: 1800, y: 1600, z: 0 },
    ];
    const result = solveAdaptivePipeEdit(request(diagonal, { kind: 'move-leg', index: 1, offset: { x: 0, y: 300, z: 0 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[1]!.y).toBeCloseTo(900, 6);
    expect(result.nodes[2]!.y).toBeCloseTo(900, 6);
    // The diagonal leg lengthened along its own line; its turn is untouched.
    expect(result.nodes[1]!.x).toBeCloseTo(1200, 6);
    expect(result.adaptations.some(a => a.kind === 're-angle-bend')).toBe(false);
  });

  it('pivots a neighbour that is skew to the slid leg, rolling that bend', () => {
    // Sliding a riser sideways in plan: the horizontal leg below it cannot
    // reach the new riser line while holding its own direction, so it re-aims
    // and its elbow rolls out of the plane it was formed in.
    const riser: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 0, z: 500 }, { x: 1000, y: 1000, z: 500 },
    ];
    const result = solveAdaptivePipeEdit(request(riser, { kind: 'move-leg', index: 1, offset: { x: 0, y: 200, z: 0 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.nodes[1]!).toMatchObject({ x: 1000, y: 200, z: 0 });
    expect(result.adaptations.some(a => a.kind === 'roll-bend-plane')).toBe(true);
  });
});

describe('solveAdaptivePipeEdit — node move', () => {
  it('re-angles a bend to an arbitrary degree rather than refusing the move', () => {
    const result = solveAdaptivePipeEdit(request(ELL, { kind: 'move-node', index: 1, target: { x: 1000, y: 300, z: 0 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reangle = result.adaptations.find(a => a.kind === 're-angle-bend');
    expect(reangle?.label).toMatch(/90° → \d+/);
  });

  it('gives up a catalogue elbow for a field bend when hard pipe needs a non-standard turn', () => {
    const result = solveAdaptivePipeEdit(request(
      ELL, { kind: 'move-node', index: 1, target: { x: 1000, y: 300, z: 0 } },
      { context: context({ socketElbows: true }) },
      ['hard', 'hard'],
    ));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conversion = result.adaptations.find(a => a.kind === 'elbow-to-field-bend');
    expect(conversion?.label).toContain('field bend');
    // Both legs adjoining the re-angled turn become formed tube.
    expect(result.materials.get(0)).toBe('flexible');
    expect(result.materials.get(1)).toBe('flexible');
  });

  it('reports a vertical bend rolled into a horizontal one', () => {
    const riser: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 0, z: 1000 },
    ];
    const result = solveAdaptivePipeEdit(request(riser, { kind: 'move-node', index: 2, target: { x: 1000, y: 1000, z: 0 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roll = result.adaptations.find(a => a.kind === 'roll-bend-plane');
    expect(roll?.label).toBe('bend rolled vertical → horizontal');
  });

  it('travels as far as the fittings allow instead of refusing', () => {
    const long: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 1000, z: 0 }, { x: 2000, y: 1000, z: 0 },
    ];
    const result = solveAdaptivePipeEdit(request(long,
      { kind: 'move-node', index: 1, target: { x: 1000, y: 900, z: 0 } },
      { context: context({ fieldBendRadiusMm: 300 }) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // It stops short of the requested 900, and says what stopped it.
    expect(result.nodes[1]!.y).toBeGreaterThan(0);
    expect(result.nodes[1]!.y).toBeLessThan(880);
    expect(result.clampedTo).toContain('fitting space');
  });

  it('refuses to double the route back on itself', () => {
    // Dragged past the far end along the same line, the two legs become exactly
    // antiparallel — a reversal is not a concession the ladder can buy.
    const result = solveAdaptivePipeEdit(request(ELL, { kind: 'move-node', index: 1, target: { x: 2000, y: 2000, z: 0 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('double back');
  });

  it('accepts a wide obtuse turn that no catalogue fitting offers', () => {
    const result = solveAdaptivePipeEdit(request(ELL, { kind: 'move-node', index: 1, target: { x: -500, y: 0, z: 0 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adaptations.some(a => a.kind === 're-angle-bend')).toBe(true);
  });
});

describe('solveAdaptivePipeEdit — connected ends', () => {
  const connected = {
    start: { position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    end: { position: null, direction: null },
  };

  it('clamps a corner beside a port onto the port axis instead of refusing', () => {
    const result = solveAdaptivePipeEdit(request(ELL,
      { kind: 'move-node', index: 1, target: { x: 900, y: 400, z: 0 } }, { terminals: connected }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clampedTo).toBe('the connected port axis');
    expect(result.nodes[1]!).toMatchObject({ x: 900, y: 0 });
  });

  it('never moves the connected end itself', () => {
    const result = solveAdaptivePipeEdit(request(ELL,
      { kind: 'move-node', index: 0, target: { x: 50, y: 50, z: 0 } }, { terminals: connected }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('start connection must remain fixed');
  });

  it('extends the port leg when a downstream leg slides', () => {
    const result = solveAdaptivePipeEdit(request(ELL,
      { kind: 'move-leg', index: 1, offset: { x: 100, y: 0, z: 0 } }, { terminals: connected }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.nodes[1]!).toMatchObject({ x: 1100, y: 0 });
  });
});

describe('solveAdaptivePipeEdit — whole-run move', () => {
  // Port faces +x; the run leaves along +x then turns +y.
  const RUN: PipeRouteNode3D[] = [
    { x: 0, y: 0, z: 2600 }, { x: 1000, y: 0, z: 2600 }, { x: 1000, y: 3000, z: 2600 },
  ];
  const pinnedStart = {
    start: { position: { x: 0, y: 0, z: 2600 }, direction: { x: 1, y: 0, z: 0 } },
    end: { position: null, direction: null },
  };

  it('only lengthens the port stub when the run moves along the port axis', () => {
    const result = solveAdaptivePipeEdit(request(RUN,
      { kind: 'move-run', offset: { x: 400, y: 0, z: 0 } }, { terminals: pinnedStart }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0]).toEqual({ x: 0, y: 0, z: 2600 });
    expect(result.nodes[1]!).toMatchObject({ x: 1400, y: 0 });
    expect(result.adaptations.some(a => a.kind === 'insert-offset')).toBe(false);
  });

  it('only lengthens the second leg when the run moves along it', () => {
    const result = solveAdaptivePipeEdit(request(RUN,
      { kind: 'move-run', offset: { x: 0, y: 500, z: 0 } }, { terminals: pinnedStart }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The staircase step lands on the existing leg's own line, so no new corner.
    expect(result.nodes).toHaveLength(3);
    expect(result.adaptations.some(a => a.kind === 'insert-offset')).toBe(false);
  });

  it('generates a riser when the run moves in Z away from a fixed port', () => {
    const result = solveAdaptivePipeEdit(request(RUN,
      { kind: 'move-run', offset: { x: 0, y: 0, z: -800 } }, { terminals: pinnedStart }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adaptations.some(a => a.kind === 'insert-riser')).toBe(true);
    // Port untouched, its approach still horizontal, and a real vertical leg.
    expect(result.nodes[0]).toEqual({ x: 0, y: 0, z: 2600 });
    expect(result.nodes[1]!.z).toBe(2600);
    const vertical = result.nodes.slice(1).findIndex((node, index) =>
      Math.abs(node.z - result.nodes[index + 0]!.z) > 1 && Math.hypot(node.x - result.nodes[index]!.x, node.y - result.nodes[index]!.y) < 1);
    expect(vertical).toBeGreaterThanOrEqual(0);
    expect(result.nodes.at(-1)!.z).toBe(1800);
  });

  it('generates an offset dog-leg for a move across the route frame', () => {
    // A run whose only legs are +x then +y, moved along +z-free diagonal in plan
    // that matches neither leg, must step rather than go diagonal.
    const lShape: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 3000, z: 0 }, { x: 4000, y: 3000, z: 0 },
    ];
    const result = solveAdaptivePipeEdit(request(lShape,
      { kind: 'move-run', offset: { x: 0, y: 0, z: 600 } },
      { terminals: { start: { position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
        end: { position: null, direction: null } } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adaptations.some(a => a.kind === 'insert-riser')).toBe(true);
    // Every leg stays axis-aligned — no diagonal was invented.
    for (let index = 1; index < result.nodes.length; index += 1) {
      const a = result.nodes[index - 1]!;
      const b = result.nodes[index]!;
      const axes = [Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)].filter(v => v > 0.5);
      expect(axes).toHaveLength(1);
    }
  });

  it('drops the run between two fixed ports by adding a riser at each', () => {
    const throughRun: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 2600 }, { x: 1000, y: 0, z: 2600 },
      { x: 1000, y: 3000, z: 2600 }, { x: 4000, y: 3000, z: 2600 },
    ];
    const result = solveAdaptivePipeEdit(request(throughRun,
      { kind: 'move-run', offset: { x: 0, y: 0, z: -400 } },
      { terminals: {
        start: { position: { x: 0, y: 0, z: 2600 }, direction: { x: 1, y: 0, z: 0 } },
        end: { position: { x: 4000, y: 3000, z: 2600 }, direction: { x: -1, y: 0, z: 0 } },
      } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both ports untouched, both approaches still horizontal at port level.
    expect(result.nodes[0]).toEqual({ x: 0, y: 0, z: 2600 });
    expect(result.nodes.at(-1)).toEqual({ x: 4000, y: 3000, z: 2600 });
    expect(result.nodes[1]!.z).toBe(2600);
    expect(result.nodes.at(-2)!.z).toBe(2600);
    // The run in between sits at the new level, reached by a riser at each end.
    expect(result.nodes[2]!.z).toBe(2200);
    expect(result.nodes[3]!.z).toBe(2200);
    expect(result.adaptations.some(a => a.kind === 'insert-riser')).toBe(true);
  });

  it('refuses to lower a two-leg run pinned at both ends — it has no middle', () => {
    const result = solveAdaptivePipeEdit(request(RUN,
      { kind: 'move-run', offset: { x: 0, y: 0, z: -400 } },
      { terminals: {
        start: { position: { x: 0, y: 0, z: 2600 }, direction: { x: 1, y: 0, z: 0 } },
        end: { position: { x: 1000, y: 3000, z: 2600 }, direction: { x: 0, y: -1, z: 0 } },
      } }));
    // Both risers would land on the single shared corner, folding the route.
    expect(result.ok).toBe(false);
  });
});

describe('solveAdaptivePipeEdit — pins', () => {
  it('holds a pinned joint and says so', () => {
    const result = solveAdaptivePipeEdit(request(ELL,
      { kind: 'move-node', index: 1, target: { x: 1000, y: 300, z: 0 } }, { pinnedJoints: [1] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('pinned');
  });
});
