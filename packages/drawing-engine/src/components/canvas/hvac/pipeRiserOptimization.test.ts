import { describe, expect, it } from 'vitest';

import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { generateRiserTurnAlternatives, recoverQuarterTurnCorners3D } from './pipeRiserOptimization';
import type { PipeRouteNode3D as Node } from './pipeRoute3d';

const p = (x: number, y = 0, z = 0): Node => ({ x, y, z });
const example = [p(0), p(300), p(300, 0, 200), p(700, 0, 200), p(700, 600, 200)];
const options = { bendTakeoffMm: 38, startStraightMm: 100, endStraightMm: 100 };
const length = (nodes: readonly Node[]): number => nodes.slice(1).reduce((total, node, index) => {
  const previous = nodes[index]!;
  return total + Math.hypot(node.x - previous.x, node.y - previous.y, node.z - previous.z);
}, 0);
const verticalTravel = (nodes: readonly Node[]): number => nodes.slice(1)
  .reduce((total, node, index) => total + Math.abs(node.z - nodes[index]!.z), 0);
const expectClose = (actual: readonly Node[], expected: readonly Node[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((node, index) => {
    expect(node.x).toBeCloseTo(expected[index]!.x, 5);
    expect(node.y).toBeCloseTo(expected[index]!.y, 5);
    expect(node.z).toBeCloseTo(expected[index]!.z, 5);
  });
};

describe('riser relocation onto an adjacent horizontal corner', () => {
  it('replaces three physical socket elbows with two and preserves exact terminals', () => {
    const snapshot = structuredClone(example);
    const [proposal] = generateRiserTurnAlternatives(example, options);
    expect(proposal).toBeDefined();
    expect(proposal!.nodes).toEqual([p(0), p(700), p(700, 0, 200), p(700, 600, 200)]);
    expect(proposal!.elbowsRemoved).toBe(1);
    expect(proposal!.relocations[0]).toMatchObject({
      oldStart: p(300), oldEnd: p(300, 0, 200),
      newStart: p(700), newEnd: p(700, 0, 200), removedStraightMm: 400,
    });
    const before = compileCopperSocketElbowRoute(example, 15.875, options);
    const after = compileCopperSocketElbowRoute(proposal!.nodes, 15.875, options);
    expect(before.issues).toEqual([]);
    expect(after.issues).toEqual([]);
    expect(before.fittings).toHaveLength(3);
    expect(after.fittings).toHaveLength(2);
    expect(after.fittings.every(fitting => fitting.spec.angleDeg === 90)).toBe(true);
    expect(proposal!.lengthMm).toBe(proposal!.originalLengthMm);
    expect(example).toEqual(snapshot);
    expect(proposal!.nodes[0]).not.toBe(example[0]);
  });

  it.each([0, Math.PI / 2, Math.PI, 0.812])('works in either traversal with rises and drops at rotation %s', angle => {
    for (const riseSign of [-1, 1]) for (const reverse of [false, true]) {
      const rotate = (node: Node): Node => ({
        x: 7345 + node.x * Math.cos(angle) - node.y * Math.sin(angle),
        y: -985 + node.x * Math.sin(angle) + node.y * Math.cos(angle),
        z: 2300 + riseSign * node.z,
      });
      const source = example.map(rotate);
      const expected = [p(0), p(700), p(700, 0, 200), p(700, 600, 200)].map(rotate);
      if (reverse) { source.reverse(); expected.reverse(); }
      const [proposal] = generateRiserTurnAlternatives(source, options);
      expect(proposal).toBeDefined();
      expectClose(proposal!.nodes, expected);
      expect(proposal!.lengthMm).toBeCloseTo(length(source), 5);
      expect(verticalTravel(proposal!.nodes)).toBe(verticalTravel(source));
    }
  });

  it('relocates an interior riser with existing elbows on both sides', () => {
    const source = [p(0, -600), ...example, p(1300, 600, 200)];
    const proposal = generateRiserTurnAlternatives(source, options)
      .find(candidate => candidate.relocations[0]!.sourceStartIndex === 1);
    expect(proposal!.nodes).toEqual([p(0, -600), p(0), p(700), p(700, 0, 200), p(700, 600, 200), p(1300, 600, 200)]);
    expect(proposal!.relocations[0]!.sourceStartIndex).toBe(1);
    const fitted = compileCopperSocketElbowRoute(proposal!.nodes, 15.875, options);
    expect(fitted.issues).toEqual([]);
    expect(fitted.fittings).toHaveLength(4);
  });

  it('checks adjacent socket faces and protected start/end straights', () => {
    const shortOutgoing = [...example.slice(0, -1), p(700, 60, 200)];
    const neighbour = [...shortOutgoing, p(1000, 60, 200)];
    expect(generateRiserTurnAlternatives(shortOutgoing, options)).toEqual([]);
    expect(generateRiserTurnAlternatives(neighbour, { bendTakeoffMm: 38 })).toEqual([]);
    expect(generateRiserTurnAlternatives(example, { ...options, startStraightMm: 680 })).toEqual([]);
    expect(generateRiserTurnAlternatives([...example].reverse(), { ...options, endStraightMm: 680 })).toEqual([]);
    expect(generateRiserTurnAlternatives(example, { ...options, minimumFittingStraightMm: 130 })).toEqual([]);
    expect(generateRiserTurnAlternatives(example, { ...options, minimumFittingStraightMm: 124 })).toHaveLength(1);
  });

  it('does not claim a two-elbow riser when the full fitting takeoffs do not fit', () => {
    const shortRise = example.map(node => ({ ...node, z: node.z * 0.3 }));
    expect(generateRiserTurnAlternatives(shortRise, options)).toEqual([]);
    expect(generateRiserTurnAlternatives(example, { bendTakeoffMm: 101 })).toEqual([]);
  });

  it('does not rewrite an already optimal two-elbow rise or a level-only plan corner', () => {
    expect(generateRiserTurnAlternatives([p(0), p(700), p(700, 0, 200), p(700, 600, 200)], options)).toEqual([]);
    expect(generateRiserTurnAlternatives(example.map(node => ({ ...node, z: 200 })), options)).toEqual([]);
  });

  it('keeps inclined risers, return bends and nonperpendicular departures', () => {
    const diagonalRise = example.map(node => ({ ...node }));
    diagonalRise[1]!.y = 20;
    expect(generateRiserTurnAlternatives(diagonalRise, options)).toEqual([]);
    expect(generateRiserTurnAlternatives([p(0), p(300), p(300, 0, 200), p(100, 0, 200), p(100, 500, 200)], options)).toEqual([]);
    expect(generateRiserTurnAlternatives([...example.slice(0, -1), p(1000, 600, 200)], options)).toEqual([]);
  });

  it('ignores duplicate/collinear sampling while preserving geometry and endpoints', () => {
    const source = [p(0), p(150), p(300), p(300), p(300, 0, 100), ...example.slice(2)];
    expect(generateRiserTurnAlternatives(source, options)[0]!.nodes)
      .toEqual([p(0), p(700), p(700, 0, 200), p(700, 600, 200)]);
  });

  it('offers both combined and separate alternatives so a collision does not suppress other improvements', () => {
    const source = [...example, p(700, 900, 200), p(700, 900, 400), p(700, 1300, 400), p(1300, 1300, 400)];
    const proposals = generateRiserTurnAlternatives(source, options);
    expect(proposals.map(proposal => proposal.elbowsRemoved)).toEqual([2, 1, 1, 1]);
    expect(proposals[0]!.nodes).toEqual([p(0), p(700), p(700, 0, 200), p(700, 1300, 200), p(700, 1300, 400), p(1300, 1300, 400)]);
    expect(generateRiserTurnAlternatives(proposals[0]!.nodes, options)).toEqual([]);
    for (const proposal of proposals) {
      expect(proposal.lengthMm).toBe(length(source));
      expect(verticalTravel(proposal.nodes)).toBe(verticalTravel(source));
      expect(compileCopperSocketElbowRoute(proposal.nodes, 15.875, options).issues).toEqual([]);
    }
    expect(generateRiserTurnAlternatives(source, options)).toEqual(proposals);
  });

  it('bounds candidate allocation even for many independent risers', () => {
    const source = [p(0)];
    for (let index = 0; index < 60; index += 1) {
      const origin = source.at(-1)!;
      const forward = index % 2 === 0;
      source.push(...example.slice(1).map(node => ({
        x: origin.x + (forward ? node.x : node.y),
        y: origin.y + (forward ? node.y : node.x), z: origin.z + node.z,
      })));
    }
    const proposals = generateRiserTurnAlternatives(source, { ...options, maxAlternatives: 4 });
    expect(proposals).toHaveLength(4);
    expect(proposals[0]!.elbowsRemoved).toBe(60);
    expect(proposals[0]!.nodes).toHaveLength(122);
    expect(generateRiserTurnAlternatives(source, { ...options, maxAlternatives: 10000 })).toHaveLength(32);
  });

  it('returns no alternative for malformed dimensions or coordinates', () => {
    expect(generateRiserTurnAlternatives([...example, p(Infinity)], options)).toEqual([]);
    expect(generateRiserTurnAlternatives(example, { bendTakeoffMm: 0 })).toEqual([]);
    expect(generateRiserTurnAlternatives(example, { ...options, endStraightMm: NaN })).toEqual([]);
    expect(generateRiserTurnAlternatives([], options)).toEqual([]);
  });
});

describe('recovering saved circular elbows for riser alternatives', () => {
  it('recovers all three real socket elbows across horizontal and vertical planes', () => {
    const compiled = compileCopperSocketElbowRoute(example, 15.875, options);
    const corners = recoverQuarterTurnCorners3D(compiled.centerline);
    expectClose(corners, example);
    const [proposal] = generateRiserTurnAlternatives(corners, options);
    expect(compileCopperSocketElbowRoute(proposal!.nodes, 15.875, options).fittings).toHaveLength(2);
    expect(recoverQuarterTurnCorners3D(corners)).toEqual(corners);
  });

  it.each([0, 0.62, Math.PI])('recovers reversed and rotated sampled routes at rotation %s', angle => {
    const source = example.map(node => ({ x: node.x * Math.cos(angle) - node.y * Math.sin(angle),
      y: node.x * Math.sin(angle) + node.y * Math.cos(angle), z: -node.z })).reverse();
    const compiled = compileCopperSocketElbowRoute(source, 15.875, options);
    expectClose(recoverQuarterTurnCorners3D(compiled.centerline), source);
  });

  it('preserves custom gathers, chamfers and damaged noncircular arcs', () => {
    const chamfer = [p(0), p(300), p(350, 50), p(350, 400)];
    expect(recoverQuarterTurnCorners3D(chamfer)).toEqual(chamfer);
    const compiled = compileCopperSocketElbowRoute([p(0), p(300), p(300, 500)], 15.875);
    const damaged = compiled.centerline.map(node => ({ ...node }));
    damaged[Math.floor(damaged.length / 2)]!.z += 2;
    const recovered = recoverQuarterTurnCorners3D(damaged);
    expect(recovered.some(node => node.z === 2)).toBe(true);
    expect(recovered.length).toBeGreaterThan(20);
    const tiltedLead = compiled.centerline.map(node => ({ ...node }));
    tiltedLead[0]!.y = 50;
    expect(recoverQuarterTurnCorners3D(tiltedLead).length).toBeGreaterThan(3);
  });
});
