import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { cardinal, terminalWithSide, type Frame, type TerminalCtx } from './ductAutoContext';
import { placeTaps } from './ductAutoLayout';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';

const settings = resolveDuctSettings({ soffitMm: 3000 });
const frame: Frame = { origin: { x: 0, y: 0 }, n: { x: 1, y: 0 }, t: { x: 0, y: 1 } };

function diffuser(id: string, x: number, y: number, automatic = true): TerminalCtx {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  // As placed, the inlet faces along the main instead of towards it.
  const element: HvacElement = {
    id, type: 'diffuser', position: { x: x - envelope.widthMm / 2, y: y - envelope.depthMm / 2 }, rotation: 90,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 2400, mountType: 'ceiling', label: id, supplyZoneRatio: 0.5,
    properties: { terminal: spec, ...(!automatic ? { spigotSideSetBy: 'user' } : {}) },
  };
  const port = terminalSpigotPort(element)!;
  const terminal: TerminalCtx = { element, spec, port, lip: port.lip, normal: cardinal(port.normal),
    airflowM3h: 150, fixed: false, neck: 200, branch: 200 };
  terminal.variants = automatic
    ? (['back', 'front', 'left', 'right'] as const).map(side => terminalWithSide(frame, terminal, side)!)
    : [terminalWithSide(frame, terminal, spec.spigotSide)!];
  return terminal;
}

describe('take-off location and diffuser inlet are selected together', () => {
  it('uses the perpendicular nearest connection instead of the placed inlet approach station', () => {
    const terminal = diffuser('near-main', 4000, 1500);
    const placed = placeTaps({ vertices: [{ x: 0, y: 0 }, { x: 10000, y: 0 }], startClearMm: 1200, terminals: [terminal] }, 400, settings)!;
    const tap = placed.taps[0]!;
    expect(tap.station).toBeCloseTo(4000);
    expect(tap.terminal.normal).toEqual({ x: 0, y: -1 });
    expect(tap.terminal.variants).toBe(terminal.variants);
  });

  it('does not select the farther leg of a turned main merely because the placed inlet faces it', () => {
    const terminal = diffuser('near-turned-leg', 4000, 1500);
    const placed = placeTaps({ vertices: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 10000 }],
      startClearMm: 1200, terminals: [terminal] }, 400, settings)!;
    const tap = placed.taps[0]!;
    expect(tap.legIndex).toBe(0);
    expect(tap.station).toBeCloseTo(4000);
    expect(tap.terminal.normal).toEqual({ x: 0, y: -1 });
  });

  it('preserves a manually fixed inlet even when its approach is longer', () => {
    const terminal = diffuser('fixed', 4000, 1500, false);
    const placed = placeTaps({ vertices: [{ x: 0, y: 0 }, { x: 10000, y: 0 }], startClearMm: 1200, terminals: [terminal] }, 400, settings)!;
    const tap = placed.taps[0]!;
    expect(tap.terminal.spec.spigotSide).toBe(terminal.spec.spigotSide);
    expect(tap.terminal.turnedTo).toBeUndefined();
    expect(tap.station).toBeCloseTo(terminal.lip.x + 800);
  });

  it('moves to a clear station when the nearest take-off stub is obstructed', () => {
    const terminal = diffuser('obstructed', 4000, 1500);
    const placed = placeTaps({ vertices: [{ x: 0, y: 0 }, { x: 10000, y: 0 }], startClearMm: 1200, terminals: [terminal] }, 400, settings,
      wall => Math.abs(wall.x - 4000) < 300, () => [3500, 4500])!;
    const tap = placed.taps[0]!;
    expect(tap.station).toBeCloseTo(3500);
    expect(tap.terminal.normal).toEqual({ x: 0, y: -1 });
  });

  it('uses the farther leg when the nearest leg cannot fit its take-off stub', () => {
    const terminal = diffuser('blocked-nearest-leg', 4000, 1500);
    const placed = placeTaps({ vertices: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 10000 }],
      startClearMm: 1200, terminals: [terminal] }, 400, settings, wall => wall.y < 500)!;
    const tap = placed.taps[0]!;
    expect(tap.legIndex).toBe(1);
    expect(tap.station).toBeCloseTo(1500);
    expect(tap.terminal.normal).toEqual({ x: 1, y: 0 });
  });

  it('keeps opposite take-off windows separated after both inlets turn towards their main', () => {
    const terminals = [diffuser('above', 4000, 1500), diffuser('below', 4000, -1500)];
    const placed = placeTaps({ vertices: [{ x: 0, y: 0 }, { x: 10000, y: 0 }], startClearMm: 1200, terminals }, 400, settings)!;
    const stations = placed.taps.map(tap => tap.station).sort((a, b) => a - b);
    expect(stations[1]! - stations[0]!).toBeGreaterThanOrEqual(200 + 2 * settings.tapWindowMarginMm + 100);
    expect((stations[0]! + stations[1]!) / 2).toBeCloseTo(4000);
    expect(placed.taps.map(tap => tap.terminal.normal)).toEqual([{ x: 0, y: -1 }, { x: 0, y: 1 }]);
  });

  it('preserves the placed inlet when two adjacent legs offer equally short clear routes', () => {
    const terminal = diffuser('equal-legs', 4500, 1500);
    // Match the orientation generator's preference for facing the source
    // axis: the current inlet must still win an equal feasible comparison.
    terminal.variants!.reverse();
    const placed = placeTaps({ vertices: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 10000 }],
      startClearMm: 1200, terminals: [terminal] }, 400, settings)!;
    const tap = placed.taps[0]!;
    expect(tap.legIndex).toBe(1);
    expect(tap.terminal.spec.spigotSide).toBe(terminal.spec.spigotSide);
    expect(tap.terminal.turnedTo).toBeUndefined();
  });
});
