import { describe, expect, it } from "vitest";

import {
  getProtectedPipeNodeIndexes,
  moveEditablePipeNode,
  resolveHybridPipeConstraintKey,
} from "./hybridPipeEditing";

describe("hybrid pipe vertex editing", () => {
  it("protects connected endpoints and the adjacent unit-port stub", () => {
    expect([
      ...getProtectedPipeNodeIndexes(
        6,
        { connected: true, unitPort: true },
        { connected: true, unitPort: false },
      ),
    ]).toEqual([0, 1, 5]);
  });

  it("moves only an editable node and preserves authored Z elsewhere", () => {
    const nodes = [
      { x: 0, y: 0, z: 100 },
      { x: 100, y: 0, z: 100 },
      { x: 200, y: 0, z: 500 },
    ];
    const moved = moveEditablePipeNode(
      nodes,
      2,
      { x: 220, y: 30, z: 650 },
      new Set([0, 1]),
    );
    expect(moved).toEqual([
      { x: 0, y: 0, z: 100 },
      { x: 100, y: 0, z: 100 },
      { x: 220, y: 30, z: 650 },
    ]);
    expect(nodes[2]).toEqual({ x: 200, y: 0, z: 500 });
  });

  it("maps quick and Blender-style constraints", () => {
    expect(resolveHybridPipeConstraintKey({ ctrlKey: true })).toBe("z");
    expect(resolveHybridPipeConstraintKey({ key: "X" })).toBe("x");
    expect(resolveHybridPipeConstraintKey({ key: "z", shiftKey: true })).toBe("xy");
    expect(resolveHybridPipeConstraintKey({ key: "q" })).toBe("free");
  });
});
