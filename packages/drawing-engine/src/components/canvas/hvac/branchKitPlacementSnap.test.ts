import { describe, expect, it } from "vitest";

import type { Point2D } from "../../../types";

import {
  applyPlacement,
  solveBranchKitSnap,
  type PlaceablePort,
  type PlacementTransform,
  type SnapTargetEnd,
} from "./branchKitPlacementSnap";

const L = 112;
const PORTS: PlaceablePort[] = [
  { role: "inlet", point: { x: -L, y: 0 }, direction: { x: -1, y: 0 } },
  { role: "run-outlet", point: { x: L, y: 0 }, direction: { x: 1, y: 0 } },
  { role: "branch-outlet", point: { x: 40, y: 72 }, direction: { x: 0, y: 1 } },
];

function portByRole(role: string): PlaceablePort {
  return PORTS.find((p) => p.role === role)!;
}

function worldDir(tf: PlacementTransform, port: PlaceablePort): Point2D {
  const a = applyPlacement(tf, port.point);
  const b = applyPlacement(tf, {
    x: port.point.x + port.direction.x,
    y: port.point.y + port.direction.y,
  });
  const d = { x: b.x - a.x, y: b.y - a.y };
  const n = Math.hypot(d.x, d.y) || 1;
  return { x: d.x / n, y: d.y / n };
}

describe("solveBranchKitSnap", () => {
  it("returns the cursor-centred transform with no snap when nothing is near", () => {
    const targets: SnapTargetEnd[] = [
      { id: "e", point: { x: 999, y: 999 }, direction: { x: 1, y: 0 } },
    ];
    const { transform, snap } = solveBranchKitSnap(PORTS, targets, { x: 300, y: 200 }, 30);
    expect(snap).toBeNull();
    expect(transform).toEqual({ tx: 300, ty: 200, rotDeg: 0 });
  });

  it("snaps the inlet onto a rightward-heading pipe end with no rotation", () => {
    const end: SnapTargetEnd = { id: "eR", point: { x: 250, y: 132 }, direction: { x: 1, y: 0 } };
    // Cursor placed so the inlet port sits ~near the end (inlet local x = -L).
    const { transform, snap } = solveBranchKitSnap(PORTS, [end], { x: 250 + L, y: 132 }, 30);
    expect(snap).not.toBeNull();
    expect(snap!.portRole).toBe("inlet");
    expect(snap!.targetId).toBe("eR");
    const landed = applyPlacement(transform, portByRole("inlet").point);
    expect(landed.x).toBeCloseTo(250, 5);
    expect(landed.y).toBeCloseTo(132, 5);
    // Port faces INTO the pipe: opposite the pipe's outward heading.
    const wd = worldDir(transform, portByRole("inlet"));
    expect(wd.x).toBeCloseTo(-1, 5);
    expect(wd.y).toBeCloseTo(0, 5);
  });

  it("auto-rotates so the inlet meets a downward-heading pipe end head-to-head", () => {
    const end: SnapTargetEnd = { id: "eD", point: { x: 520, y: 250 }, direction: { x: 0, y: 1 } };
    const { transform, snap } = solveBranchKitSnap(PORTS, [end], { x: 520 + L, y: 250 }, 40);
    expect(snap).not.toBeNull();
    expect(snap!.portRole).toBe("inlet");
    const landed = applyPlacement(transform, portByRole("inlet").point);
    expect(landed.x).toBeCloseTo(520, 5);
    expect(landed.y).toBeCloseTo(250, 5);
    const wd = worldDir(transform, portByRole("inlet"));
    // Pipe heads down (0,1) → inlet must face up (0,-1).
    expect(wd.x).toBeCloseTo(0, 5);
    expect(wd.y).toBeCloseTo(-1, 5);
  });

  it("picks the nearest port/target pair", () => {
    const near: SnapTargetEnd = { id: "near", point: { x: L + 5, y: 0 }, direction: { x: -1, y: 0 } };
    const far: SnapTargetEnd = { id: "far", point: { x: -L + 20, y: 0 }, direction: { x: 1, y: 0 } };
    // Cursor at origin: run-outlet world = (L,0) is 5 from `near`; inlet world = (-L,0) is 20 from `far`.
    const { snap } = solveBranchKitSnap(PORTS, [near, far], { x: 0, y: 0 }, 30);
    expect(snap).not.toBeNull();
    expect(snap!.targetId).toBe("near");
    expect(snap!.portRole).toBe("run-outlet");
  });

  it("ignores targets already consumed by other kits", () => {
    const end: SnapTargetEnd = { id: "taken", point: { x: 250, y: 132 }, direction: { x: 1, y: 0 } };
    const { snap } = solveBranchKitSnap(
      PORTS,
      [end],
      { x: 250 + L, y: 132 },
      30,
      new Set(["taken"]),
    );
    expect(snap).toBeNull();
  });
});
