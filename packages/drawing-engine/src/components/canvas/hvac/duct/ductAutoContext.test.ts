import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { cardinal, dirToLocal, spigotVariants, toLocal, type Frame, type ServiceCtx, type TerminalCtx } from './ductAutoContext';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';

const frame: Frame = { origin: { x: 0, y: 0 }, n: { x: 1, y: 0 }, t: { x: 0, y: 1 } };

function terminal(centre: Point2D = { x: 3000, y: 1500 }, overrides: Partial<HvacElement> = {}): TerminalCtx {
  const spec = typicalTerminalSpec('square-4way', 200);
  const size = terminalEnvelope(spec);
  const element: HvacElement = {
    id: 'diffuser', type: 'diffuser', position: { x: centre.x - size.widthMm / 2, y: centre.y - size.depthMm / 2 },
    rotation: 0, width: size.widthMm, depth: size.depthMm, height: size.heightMm,
    elevation: 2400, mountType: 'ceiling', label: 'Diffuser', supplyZoneRatio: 0.5,
    properties: { terminal: spec }, ...overrides,
  };
  const port = terminalSpigotPort(element)!;
  return {
    element, spec: readDuctTerminalSpec(element)!, port,
    lip: toLocal(frame, port.lip), normal: cardinal(dirToLocal(frame, port.normal)),
    neck: 200, branch: 200, airflowM3h: 100, fixed: false,
  };
}

describe('automatic terminal connection sides', () => {
  it('keeps a connection toward a nearby cross-trunk even when it faces away from the unit axis', () => {
    const placed = terminal();
    const variants = spigotVariants(frame, placed, true);
    // A cross-trunk beyond the diffuser needs the +X face, previously pruned
    // by the unit-axis ranking despite a clear, direct approach.
    expect(variants.some(side => side.normal.x === 1 && side.normal.y === 0)).toBe(true);
    expect(new Set(variants.map(side => side.spec.spigotSide)).size).toBe(4);
    expect(variants[0]!.normal).toEqual({ x: 0, y: -1 });
    expect(variants.every(side => side.element.position === placed.element.position && side.element.rotation === placed.element.rotation)).toBe(true);
  });

  it('keeps the manually selected side and directional faces fixed', () => {
    const placed = terminal();
    const locked = terminal(undefined, { properties: { ...placed.element.properties, spigotSideSetBy: 'user' } });
    const slot = terminal(undefined, { properties: { terminal: typicalTerminalSpec('linear-slot', 200) } });
    for (const [candidate, enabled] of [[locked, true], [slot, true], [placed, false]] as const) {
      expect(spigotVariants(frame, candidate, enabled)).toEqual([{ ...candidate, variants: undefined, turnedTo: undefined }]);
    }
  });

  it('filters obstructed approaches at the collar height while retaining sides clear above or below equipment', () => {
    const placed = terminal();
    const right = spigotVariants(frame, placed, true).find(side => side.spec.spigotSide === 'right')!;
    const obstruction: ServiceCtx['obstacles'][number] = {
      id: 'equipment', minX: right.lip.x + 100, maxX: right.lip.x + 200,
      minY: right.lip.y - 100, maxY: right.lip.y + 100,
      zMin: right.port.lip.z - 100, zMax: right.port.lip.z + 100,
    };
    const hasRight = (obstacle: typeof obstruction) => spigotVariants(frame, placed, true, [obstacle]).some(side => side.spec.spigotSide === 'right');
    expect(hasRight(obstruction)).toBe(false);
    expect(hasRight({ ...obstruction, zMin: right.port.lip.z + 300, zMax: right.port.lip.z + 600 })).toBe(true);
    expect(hasRight({ ...obstruction, zMin: right.port.lip.z - 600, zMax: right.port.lip.z - 300 })).toBe(true);
  });

  it('ranks approaches from the actual diffuser centre for a large plenum and long collar', () => {
    const spec = { ...typicalTerminalSpec('square-4way', 200), plenumWidthMm: 1000, plenumDepthMm: 1000, spigotLengthMm: 300 };
    const placed = terminal({ x: 3000, y: 300 }, { properties: { terminal: spec } });
    expect(spigotVariants(frame, placed, true)[0]!.normal).toEqual({ x: 0, y: -1 });
  });

  it('allows every approach to a top collar without reporting a physical spigot turn', () => {
    const placed = terminal(undefined, { properties: { terminal: { ...typicalTerminalSpec('linear-slot', 200), spigotEntry: 'top' } } });
    const variants = spigotVariants(frame, placed, true);
    expect(variants).toHaveLength(4);
    expect(variants.every(side => side.turnedTo === undefined && side.port.vertical
      && side.port.lip.x === placed.port.lip.x && side.port.lip.y === placed.port.lip.y)).toBe(true);
  });
});
