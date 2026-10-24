import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement, Point2D, Room } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { planAutoRouteDucts } from './ductAutoRoute';
import { DEFAULT_DUCT_SETTINGS } from './ductSettings';
import { readDuctTerminalSpec } from './ductTerminals';
import { proposeTerminals, terminalShortfall, unitTurnToFaceTerminals, type TerminalProposal } from './ductUnitAdvice';

let serial = 0;
function place(definitionId: string, centre: Point2D, extra: Partial<HvacElement> = {}): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  serial += 1;
  return {
    id: `${definitionId}-${serial}`, type: def.type, category: def.equipmentCategory, subtype: def.subtype, modelLabel: def.modelLabel,
    position: { x: centre.x - def.widthMm / 2, y: centre.y - def.depthMm / 2 }, rotation: 0,
    width: def.widthMm, depth: def.depthMm, height: def.heightMm, elevation: def.elevationMm, mountType: def.mountType,
    label: `${def.type === 'return-grille' ? 'RAG' : 'SAD'}-${serial}`, supplyZoneRatio: 0.5,
    properties: { definitionId: def.id, ...(def.defaultProperties ?? {}) }, ...extra,
  } as HvacElement;
}

// The user's top hall (17.6 × 9 m) with its FDU224 at rotation 0 (supply collar facing +y, "south"): the two
// diffusers north of it and the two grilles south, as drawn on 23 October 2026.
const hall = { id: 'hall', vertices: [{ x: 0, y: 0 }, { x: 17600, y: 0 }, { x: 17600, y: 9000 }, { x: 0, y: 9000 }] } as Room;
const unit = place('vrf-fdu224kxze1', { x: 9200, y: 4700 });
const terminals = [
  place('terminal-square-595-250', { x: 2200, y: 1300 }), place('terminal-square-595-250', { x: 15400, y: 1500 }),
  place('terminal-return-eggcrate-595-250', { x: 2900, y: 7600 }), place('terminal-return-eggcrate-595-250', { x: 15800, y: 7600 }),
];
const settings = DEFAULT_DUCT_SETTINGS;

describe('unit advice: facing its terminals', () => {
  it('a unit turned away from all its terminals is told to turn 180°', () => {
    expect(unitTurnToFaceTerminals(unit, terminals)).toEqual({ angleDeg: 180, ahead: 4, aheadNow: 0, total: 4 });
  });

  it('a unit already facing them gets no advice', () => {
    expect(unitTurnToFaceTerminals({ ...unit, rotation: 180 }, terminals)).toBeNull();
  });
});

describe('unit advice: enough terminals for the airflow', () => {
  it('4,320 m³/h through two Ø250 diffusers: 12.2 m/s against 3, so 6 × Ø300 or 9 × Ø250', () => {
    const short = terminalShortfall(terminals, 'supply', 4320, settings)!;
    expect(short.count).toBe(2);
    expect(short.perTerminalM3h).toBe(2160);
    expect(short.velocityMs).toBeCloseTo(12.2, 1);
    expect(short.capMs).toBe(3);
    expect(short.needed).toEqual([{ neckMm: 300, count: 6 }, { neckMm: 250, count: 9 }]);
  });

  it('the return side at its own limit (3.5 m/s): 5 × Ø300 or 7 × Ø250 grilles', () => {
    expect(terminalShortfall(terminals, 'return', 4320, settings)!.needed).toEqual([{ neckMm: 300, count: 5 }, { neckMm: 250, count: 7 }]);
  });

  it('six Ø300 diffusers are enough', () => {
    const six = [1.5, 4.5, 7.5, 10.5, 13.5, 16.5].map((x) => place('terminal-square-595-300', { x: x * 1000, y: 1400 }));
    expect(terminalShortfall(six, 'supply', 4320, settings)).toBeNull();
  });
});

describe('unit advice: proposing the terminals (the unit turned to face them first, as advised)', () => {
  let ids = 0;
  const newId = () => `new-${ids++}`;
  const turned = { ...unit, rotation: 180 };
  const scene = [turned, ...terminals];
  const proposal = proposeTerminals(scene, [hall], unit.id, terminals.map((terminal) => terminal.id), 'supply', 4320, settings, newId)!;
  const centreOf = (element: HvacElement) => ({ x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 });
  /** How far ahead of the service's collar a point lies. */
  const ahead = (point: Point2D, service: 'supply' | 'return') => {
    const collar = resolveUnitAirPorts(turned).find((port) => port.kind === service)!;
    return (point.x - collar.lip.x) * collar.normal.x + (point.y - collar.lip.y) * collar.normal.y;
  };

  it('re-necks the two diffusers to Ø300 and adds four for six in all', () => {
    expect(proposal.neckMm).toBe(300);
    expect(proposal.current).toBe(2);
    expect(proposal.total).toBe(6);
    expect(proposal.updates.map((terminal) => readDuctTerminalSpec(terminal)!.neckDiameterMm)).toEqual([300, 300]);
    expect(proposal.updates.every((terminal) => terminal.properties.definitionId === 'terminal-square-595-300')).toBe(true);
    expect(proposal.add).toHaveLength(4);
    expect(terminalShortfall([...proposal.updates, ...proposal.add], 'supply', 4320, settings)).toBeNull();
  });

  it('the new ones join the unit, take the next tags, go ahead of the collar and keep clear of the walls, the unit and each other', () => {
    const labels = new Set(scene.map((element) => element.label));
    for (const terminal of proposal.add) {
      expect(terminal.properties.airSystem).toEqual({ unitId: unit.id });
      expect(labels.has(terminal.label)).toBe(false);
      expect(ahead(centreOf(terminal), 'supply')).toBeGreaterThanOrEqual(1500);
      const centre = { x: terminal.position.x + terminal.width / 2, y: terminal.position.y + terminal.depth / 2 };
      expect(Math.min(centre.x, centre.y, 17600 - centre.x, 9000 - centre.y)).toBeGreaterThanOrEqual(800);
      const toUnit = Math.hypot(Math.max(unit.position.x - centre.x, 0, centre.x - unit.position.x - unit.width),
        Math.max(unit.position.y - centre.y, 0, centre.y - unit.position.y - unit.depth));
      expect(toUnit).toBeGreaterThan(900);
    }
    const centres = [...proposal.updates, ...proposal.add].map((terminal) => ({ x: terminal.position.x + terminal.width / 2, y: terminal.position.y + terminal.depth / 2 }));
    for (let a = 0; a < centres.length; a += 1) {
      for (let b = a + 1; b < centres.length; b += 1) expect(Math.hypot(centres[a]!.x - centres[b]!.x, centres[a]!.y - centres[b]!.y)).toBeGreaterThan(895);
    }
    // Apart from the return grilles where the room allows (so the supply does not short-circuit).
    const grilles = terminals.slice(2).map((terminal) => ({ x: terminal.position.x + terminal.width / 2, y: terminal.position.y + terminal.depth / 2 }));
    for (const centre of centres.slice(2)) expect(Math.min(...grilles.map((grille) => Math.hypot(centre.x - grille.x, centre.y - grille.y)))).toBeGreaterThanOrEqual(1500);
  });

  it('the terminals proposed for both services give the unit a layout', () => {
    // As the panel does it: the supply proposal added, then the return proposed on the drawing as it then is.
    const apply = (elements: readonly HvacElement[], next: TerminalProposal) => {
      const updated = new Map(next.updates.map((element) => [element.id, element]));
      return [...elements.map((element) => updated.get(element.id) ?? element), ...next.add];
    };
    const withSupply = apply(scene, proposal);
    const ownIds = withSupply.filter((element) => readDuctTerminalSpec(element)).map((element) => element.id);
    const returns = proposeTerminals(withSupply, [hall], unit.id, ownIds, 'return', 4320, settings, newId)!;
    expect(returns.total).toBe(5);
    expect(returns.add.every((terminal) => ahead(centreOf(terminal), 'return') >= 1500)).toBe(true);
    const final = apply(withSupply, returns).map((element) => (readDuctTerminalSpec(element)
      ? { ...element, properties: { ...element.properties, airSystem: { unitId: unit.id } } } : element));
    const result = planAutoRouteDucts(final, { supply: true, return: true },
      { settings, shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing' });
    expect(result.units[0]?.status, result.units[0]?.notes.join(' | ')).toBe('designed');
    expect(result.units[0]?.advice ?? []).toEqual([]);
  }, 300_000);

  it('nothing to propose when the terminals are enough', () => {
    const six = [1.5, 4.5, 7.5, 10.5, 13.5, 16.5].map((x) => place('terminal-square-595-300', { x: x * 1000, y: 1400 }));
    expect(proposeTerminals([unit, ...six], [hall], unit.id, six.map((terminal) => terminal.id), 'supply', 4320, settings, newId)).toBeNull();
  });
});
