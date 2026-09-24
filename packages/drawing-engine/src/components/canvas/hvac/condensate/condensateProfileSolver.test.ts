import { describe, expect, it } from 'vitest';

import { maxFeasibleSlope, solveProfile, type ProfileNode } from './condensateProfileSolver';

const INF = Number.POSITIVE_INFINITY;

function node(id: string, down: string | null, w: number, upper = INF, lower = Number.NEGATIVE_INFINITY, reason?: string): ProfileNode {
  return { id, down, w, upper, lower, ...(reason ? { upperReason: reason } : {}) };
}

describe('solveProfile', () => {
  it('hangs a single run from its drain port at the design fall', () => {
    // port (2600) —10 m at 1 %→ a —5 m→ root; void floor 2400.
    const solution = solveProfile([
      node('port', 'a', 100, 2600, 2400, 'port'),
      node('a', 'root', 50, INF, 2400),
      node('root', null, 0, INF, 2400),
    ]);
    expect(solution.feasible).toBe(true);
    expect(solution.zHigh.get('port')).toBe(2600);
    expect(solution.zHigh.get('a')).toBe(2500);
    expect(solution.zHigh.get('root')).toBe(2450);
    // Least profile sits on the void floor at the root and climbs upstream.
    expect(solution.zLow.get('root')).toBe(2400);
    expect(solution.zLow.get('a')).toBe(2450);
    expect(solution.zLow.get('port')).toBe(2550);
  });

  it('reports the exact fall shortfall and the binding drain port', () => {
    const solution = solveProfile([
      node('port', 'root', 300, 2600, Number.NEGATIVE_INFINITY, 'unit FCU-3 drain port'),
      node('root', null, 0, INF, 2420, undefined),
    ]);
    expect(solution.feasible).toBe(false);
    expect(solution.diagnosis?.shortfallMm).toBeCloseTo(120);
    expect(solution.diagnosis?.nodeId).toBe('root');
    expect(solution.diagnosis?.bindingNodeId).toBe('port');
    expect(solution.diagnosis?.bindingReason).toBe('unit FCU-3 drain port');
  });

  it('lets the lower port set the main, with the join drop entering from the top', () => {
    //  high port (2650) → bEndH —join 40→ J;  low port (2600) —... trunk
    const solution = solveProfile([
      node('low', 'j', 50, 2600),
      node('high', 'bh', 20, 2650),
      node('bh', 'j', 40),
      node('j', 'root', 30),
      node('root', null, 0, INF, 2400),
    ]);
    expect(solution.feasible).toBe(true);
    // The trunk from the low port binds the junction; the high branch drops more.
    expect(solution.zHigh.get('j')).toBe(2550);
    expect((solution.zHigh.get('bh') ?? 0) - (solution.zHigh.get('j') ?? 0)).toBeGreaterThanOrEqual(40);
  });

  it('models a pump lift as a negative fall', () => {
    // Pumped cassette: port 2560, lift riser up to +600, then 30 m at 1 % to a stack at 2500.
    const nodes = (lift: number) => [
      node('port', 'stub', 0, 2560),
      node('stub', 'top', -lift),
      node('top', 'root', 300, 2850),
      node('root', null, 0, 2500, 2500),
    ];
    expect(solveProfile(nodes(0)).feasible).toBe(false);
    const lifted = solveProfile(nodes(600));
    expect(lifted.feasible).toBe(true);
    // Minimal lift needed = z_low(top) − port = (2500 + 300) − 2560 = 240 mm.
    expect((lifted.zLow.get('top') ?? 0) - 2560).toBe(240);
  });

  it('respects a "below refrigerant" window as an upper bound', () => {
    const solution = solveProfile([
      node('port', 'x', 20, 2600),
      node('x', 'root', 20, 2500, Number.NEGATIVE_INFINITY, 'below refrigerant R1'),
      node('root', null, 0, INF, 2300),
    ]);
    expect(solution.feasible).toBe(true);
    expect(solution.zHigh.get('x')).toBe(2500);
    expect(solution.zHigh.get('root')).toBe(2480);
    const blocked = solveProfile([
      node('port', 'x', 20, 2600),
      node('x', 'root', 20, 2350, Number.NEGATIVE_INFINITY, 'below refrigerant R1'),
      node('root', null, 0, INF, 2400),
    ]);
    expect(blocked.feasible).toBe(false);
    expect(blocked.diagnosis?.bindingReason).toBe('below refrigerant R1');
    expect(blocked.diagnosis?.shortfallMm).toBeCloseTo(70);
  });

  it('satisfies every constraint whenever it reports feasible (randomised trees)', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const count = 3 + Math.floor(random() * 12);
      const nodes: ProfileNode[] = [node('n0', null, 0, INF, 2300 + random() * 100)];
      for (let index = 1; index < count; index += 1) {
        const down = `n${Math.floor(random() * index)}`;
        const leafish = random() < 0.5;
        nodes.push(node(`n${index}`, down, random() * 60 - (random() < 0.1 ? 200 : 0),
          leafish ? 2500 + random() * 200 : INF, random() < 0.2 ? 2350 + random() * 100 : Number.NEGATIVE_INFINITY));
      }
      // Real leaves are drain ports and always carry a finite upper bound.
      const hasChild = new Set(nodes.map((n) => n.down).filter(Boolean));
      for (const n of nodes) if (!hasChild.has(n.id) && !Number.isFinite(n.upper)) n.upper = 2500 + random() * 200;
      const solution = solveProfile(nodes);
      if (!solution.feasible) {
        expect(solution.diagnosis!.shortfallMm).toBeGreaterThan(0);
        continue;
      }
      for (const n of nodes) {
        const z = solution.zHigh.get(n.id)!;
        expect(z).toBeLessThanOrEqual(n.upper + 1e-6);
        expect(z).toBeGreaterThanOrEqual(n.lower - 1e-6);
        if (n.down) expect(z - solution.zHigh.get(n.down)!).toBeGreaterThanOrEqual(n.w - 1e-6);
        expect(solution.zLow.get(n.id)!).toBeLessThanOrEqual(z + 1e-6);
      }
    }
  });
});

describe('maxFeasibleSlope', () => {
  it('finds the steepest uniform fall the head allows', () => {
    // 20 m run with 300 mm of head → 1.5 %.
    const build = (slope: number) => [
      node('port', 'root', slope * 200, 2700),
      node('root', null, 0, INF, 2400),
    ];
    const result = maxFeasibleSlope(build, 1, 2);
    expect(result?.slopePercent).toBeCloseTo(1.5, 1);
    expect(maxFeasibleSlope(build, 1.6, 2)).toBeNull();
    expect(maxFeasibleSlope(build, 1, 1.2)?.slopePercent).toBe(1.2);
  });
});
