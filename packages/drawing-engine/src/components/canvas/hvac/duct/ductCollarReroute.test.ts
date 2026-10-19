import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { footprintCorners } from './ductAutoContext';
import { errorCodes } from './ductBranchReaim';
import { tapOrigin } from './ductBranchTargets';
import { withActiveDuctBuilding } from './ductBuilding';
import { rerouteFromCollar } from './ductCollarReroute';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from './ductDraft';
import { getDuctRunPlan, planDuctRunSpec } from './ductFabricationPlanner';
import { branchAnchor, ductRunElementWithSpec } from './ductFollow';
import { ductLegs } from './ductGeometry';
import { resolveDuctSettings } from './ductSettings';
import { typicalTerminalSpec } from './ductTerminalCatalog';
import { terminalEnvelope, terminalSpigotPort } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const at = (dx: number, dy: number, from: Point2D = supply.lip) => ({ x: from.x + dx, y: from.y + dy });
// A collar main straight up (−y) 4000 mm, a take-off at 2000 mm to +x, its straight and a runout to D1.
const main = buildDuctRunDraftElement({ port: supply, points: [at(0, -4000)] }, 'main');
const tap = tapOrigin(main, settings, { legIndex: 0, stationMm: 2000, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 }) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
const straightEnd = at(1500 * tap.direction.x, 1500 * tap.direction.y, tap.point);
const spec = typicalTerminalSpec('square-4way', 200);
const envelope = terminalEnvelope(spec);
const d1: HvacElement = {
  id: 'd1', type: 'diffuser', position: { x: straightEnd.x + 400, y: straightEnd.y + 300 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm,
  height: envelope.heightMm, elevation: 2400, mountType: 'ceiling', label: 'SAD-1', supplyZoneRatio: 0.5, properties: { terminal: spec },
};
const d1Lip = terminalSpigotPort(d1)!.lip;
const branch = buildDuctRunDraftElement({
  origin: tap, points: [straightEnd, { x: d1Lip.x, y: d1Lip.y, z: d1Lip.z - 100 }], legSizes: [{ widthMm: 300, heightMm: 150 }, roundLeg(200)],
  end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
}, 'branch');
const scene = [unit, main, branch, d1];
const mainSpec = readDuctRunSpec(main)!;

function turned(rotation: number) {
  const next = { ...unit, rotation };
  const port = resolveUnitAirPorts(next).find((candidate) => candidate.kind === 'supply')!;
  const after = scene.map((element) => (element.id === unit.id ? next : element));
  return { next, port, after };
}

/** Whether a plan segment's duct (half width `half`) overlaps a box. */
function overlaps(a: Point2D, b: Point2D, box: { minX: number; minY: number; maxX: number; maxY: number }, half: number): boolean {
  return Math.max(a.x, b.x) + half > box.minX && Math.min(a.x, b.x) - half < box.maxX
    && Math.max(a.y, b.y) + half > box.minY && Math.min(a.y, b.y) - half < box.maxY;
}

describe('rerouteFromCollar', () => {
  for (const rotation of [90, -90]) {
    it(`a unit turned ${rotation}°: the main leaves the turned collar, goes round the casing and joins its old line before the take-off`, () => {
      const { next, port, after } = turned(rotation);
      const result = rerouteFromCollar({
        scene: after, baseline: scene, settings, run: main, spec: mainSpec,
        to: { point: { x: port.lip.x, y: port.lip.y }, direction: port.normal, z: mainSpec.path[0]!.z }, unit: footprintCorners(next),
      });
      expect(result).not.toBeNull();
      const out = result!.spec;
      // It starts on the turned collar and leaves square to it.
      expect(out.path[0]!.x).toBeCloseTo(port.lip.x, 6);
      expect(out.path[0]!.y).toBeCloseTo(port.lip.y, 6);
      const legs = ductLegs(out);
      expect(legs[0]!.direction.x).toBeCloseTo(port.normal.x, 6);
      expect(legs[0]!.direction.y).toBeCloseTo(port.normal.y, 6);
      // From the join on, the route is the old one: the old main's end is the new run's end.
      expect(out.path[out.path.length - 1]).toEqual(mainSpec.path[mainSpec.path.length - 1]);
      const join = out.path[out.path.length - 2]!;
      expect(join.x).toBeCloseTo(supply.lip.x, 6);
      // Clear of the turned casing (the first straight leaves its face).
      const corners = footprintCorners(next);
      const box = { minX: Math.min(...corners.map((c) => c.x)), minY: Math.min(...corners.map((c) => c.y)), maxX: Math.max(...corners.map((c) => c.x)), maxY: Math.max(...corners.map((c) => c.y)) };
      for (const leg of legs.slice(1)) expect(overlaps(leg.start, leg.end, box, 674 / 2)).toBe(false);
      // The take-off keeps its place in the room.
      const place = result!.relocate(0, 2000);
      expect(place.legIndex).toBe(out.legs.length - 1);
      const branchSpec = readDuctRunSpec(branch)!;
      const moved = { ...branchSpec, start: { ...(branchSpec.start as Extract<DuctRunSpec['start'], { kind: 'tap' }>), ...place } };
      const before = branchAnchor(mainSpec, branchSpec, settings)!;
      const now = branchAnchor(out, moved, settings)!;
      expect(now.point.x).toBeCloseTo(before.point.x, 6);
      expect(now.point.y).toBeCloseTo(before.point.y, 6);
      // No rule broken that was not before.
      const trial = after.map((element) => (element.id === 'main' ? ductRunElementWithSpec(main, out) : element.id === 'branch' ? ductRunElementWithSpec(branch, moved) : element));
      const errorsAfter = errorCodes(planDuctRunSpec('main', out, { settings, scene: trial }));
      const errorsBefore = errorCodes(getDuctRunPlan(main, scene, settings));
      for (const [code, count] of errorsAfter) expect(count).toBeLessThanOrEqual(errorsBefore.get(code) ?? 0);
      expect(result!.elbows).toBeGreaterThanOrEqual(2);
    });
  }

  it('keeps to its room: a wall beside the unit sends the route of a half turn round the other side', () => {
    const { next, port, after } = turned(180);
    const reroute = () => rerouteFromCollar({
      scene: after, baseline: scene, settings, run: main, spec: mainSpec,
      to: { point: { x: port.lip.x, y: port.lip.y }, direction: port.normal, z: mainSpec.path[0]!.z }, unit: footprintCorners(next),
    });
    // Without walls it goes round the unit's left (−x) side.
    const free = reroute()!;
    expect(Math.min(...free.spec.path.map((point) => point.x))).toBeLessThan(0);
    // A wall 300 mm left of the casing: round the right side instead, nothing left of the wall.
    const wall = { id: 'w', a: { x: -300, y: -5000 }, b: { x: -300, y: 5000 }, thicknessMm: 200, baseZ: 0, topZ: 3000, structural: true };
    const walled = withActiveDuctBuilding([wall], [], reroute);
    expect(walled).not.toBeNull();
    expect(Math.min(...walled!.spec.path.map((point) => point.x)) - 674 / 2).toBeGreaterThan(-300 + 100);
    expect(Math.max(...walled!.spec.path.map((point) => point.x))).toBeGreaterThan(1084);
  });

  it('refuses a collar that is not square to the old route (a 45° turn is left to the other re-aims)', () => {
    const { next, port, after } = turned(45);
    expect(rerouteFromCollar({
      scene: after, baseline: scene, settings, run: main, spec: mainSpec,
      to: { point: { x: port.lip.x, y: port.lip.y }, direction: port.normal, z: mainSpec.path[0]!.z }, unit: footprintCorners(next),
    })).toBeNull();
  });
});
