import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { airSystemMarkup } from './ductAirSystemMarkup';
import {
  AIR_SYSTEM_COLORS,
  airSystemTags,
  airTerminalSchedule,
  airTerminalScheduleToCsv,
  analyseAirSystems,
  nextAirSystemTag,
  servingUnitOf,
} from './ductAirSystems';
import { spigotOrigin } from './ductBranchTargets';
import { buildDuctRunDraft, buildDuctRunDraftElement } from './ductDraft';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec, type DuctTerminalSpec } from './ductTerminals';
import { roundLeg } from './ductTypes';

const settings = resolveDuctSettings({ soffitMm: 3200 });

function unit(id: string, x: number, properties: Record<string, unknown> = {}, roomId = 'room-1'): HvacElement {
  return {
    id, type: 'ducted-ac', position: { x, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2400,
    mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId, properties: { modelCode: 'FDUM22KXE6F-W', ...properties },
  };
}

function terminal(id: string, centre: Point2D, spec: DuctTerminalSpec, properties: Record<string, unknown> = {}, roomId = 'room-1'): HvacElement {
  const envelope = terminalEnvelope(spec);
  return {
    id, type: spec.service === 'return' ? 'return-grille' : 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId, properties: { terminal: spec, ...properties },
  };
}

const supplySpec = typicalTerminalSpec('square-4way', 200);
const returnSpec = typicalTerminalSpec('return-egg-crate', 250);

describe('air system tags', () => {
  it('keeps stored tags (first one wins) and derives the rest past every number in use', () => {
    const scene = [unit('a', 0), unit('b', 3000, { airSystemTag: 'DU-4' }), unit('c', 6000, { airSystemTag: 'du-4' }), unit('d', 9000, { airSystemTag: 'AHU-L2' })];
    const tags = airSystemTags(scene);
    expect(tags.get('b')).toBe('DU-4');
    expect(tags.get('d')).toBe('AHU-L2');
    // a and c (whose stored tag clashes with b's) take the next free numbers after DU-4.
    expect(tags.get('a')).toBe('DU-5');
    expect(tags.get('c')).toBe('DU-6');
    expect(nextAirSystemTag(scene)).toBe('DU-7');
    expect(nextAirSystemTag([])).toBe('DU-1');
    // Cached per scene snapshot.
    expect(airSystemTags(scene)).toBe(tags);
  });
});

describe('air systems: assigned, connected, mismatched', () => {
  const u1 = unit('u1', 0);
  const u2 = unit('u2', 6000);
  const supply1 = resolveUnitAirPorts(u1).find((port) => port.kind === 'supply')!;
  // Supply collars face −Y: diffusers 2.5 m in front, their spigots facing the unit.
  const facing = { ...supplySpec, spigotSide: 'front' as const };
  const s1 = terminal('sad-1', { x: supply1.lip.x - 1200, y: supply1.lip.y - 2500 }, facing, { airSystem: { unitId: 'u1' } });
  const s2 = terminal('sad-2', { x: supply1.lip.x + 1200, y: supply1.lip.y - 2500 }, facing);
  const s3 = terminal('sad-3', { x: 7000, y: -2500 }, facing, { airSystem: { unitId: 'u2' } });
  const r1 = terminal('rag-1', { x: 500, y: 2200 }, returnSpec, { airSystem: { unitId: 'u1' } });
  const lost = terminal('rag-9', { x: 9000, y: 2200 }, returnSpec, { airSystem: { unitId: 'gone' } });
  const port2 = terminalSpigotPort(s2)!;
  // A run straight from u1's supply collar into sad-2 (not assigned: it belongs by its duct).
  const run = buildDuctRunDraftElement({
    port: supply1, points: [{ x: supply1.lip.x, y: port2.lip.y + 400 }, { x: port2.lip.x, y: port2.lip.y + 400 }, { x: port2.lip.x, y: port2.lip.y, z: port2.lip.z - 100 }],
    legSizes: [{ widthMm: supply1.widthMm, heightMm: supply1.heightMm }, roundLeg(200), roundLeg(200)],
    end: { kind: 'terminal', terminalId: 'sad-2', portId: 'spigot', flex: true },
  }, 'run-1');
  const scene = [u1, u2, s1, s2, s3, r1, lost, run];

  it('finds the unit a terminal is ducted from', () => {
    expect(servingUnitOf('sad-2', scene)).toEqual({ unitId: 'u1', service: 'supply', runId: 'run-1' });
    expect(servingUnitOf('sad-1', scene)).toBeNull();
  });

  it('puts each terminal in its unit\'s system: assigned, connected or both; the rest in none', () => {
    const analysis = analyseAirSystems(scene);
    const system1 = analysis.byUnit.get('u1')!;
    expect(system1.tag).toBe('DU-1');
    expect(system1.color).toBe(AIR_SYSTEM_COLORS[0]);
    expect(system1.supply.members.map((member) => [member.terminal.id, member.source])).toEqual([['sad-1', 'assigned'], ['sad-2', 'connected']]);
    expect(system1.return.members.map((member) => member.terminal.id)).toEqual(['rag-1']);
    expect(system1.supply.connected).toBe(1);
    expect(analysis.byUnit.get('u2')!.supply.members.map((member) => member.terminal.id)).toEqual(['sad-3']);
    // Assigned to a unit no longer in the drawing: in no system.
    expect(analysis.unassigned.map((element) => element.id)).toEqual(['rag-9']);
    // The FDUM22 moves 600 m³/h at Hi: two supply terminals share it, the return takes it all.
    expect(system1.airflowM3h).toBeCloseTo(600, 6);
    expect(system1.supply.members.map((member) => member.airflowM3h)).toEqual([300, 300]);
    expect(system1.return.members[0]!.airflowM3h).toBeCloseTo(600, 6);
    expect(analysis.byTerminal.get('sad-2')!.unitId).toBe('u1');
  });

  it('flags a terminal assigned to one unit but ducted from another', () => {
    const moved = { ...s2, properties: { ...s2.properties, airSystem: { unitId: 'u2' } } };
    const analysis = analyseAirSystems([u1, u2, s1, moved, s3, r1, lost, run]);
    const member = analysis.byUnit.get('u2')!.supply.members.find((entry) => entry.terminal.id === 'sad-2')!;
    expect(member.source).toBe('assigned');
    expect(member.mismatch).toBe(true);
    expect(member.connection?.unitId).toBe('u1');
  });

  it('draws rings, tethers with the air direction and the unit tag for the systems in focus', () => {
    const analysis = analyseAirSystems(scene);
    const markup = airSystemMarkup(analysis, { k: 0.2, focusUnitIds: new Set(['u1']), showAll: false, showTags: true });
    // sad-1 and rag-1 are not ducted yet: tethered; sad-2 is ducted: ringed only.
    expect(markup).toContain('data-air-system-tether="sad-1"');
    expect(markup).toContain('data-air-system-tether="rag-1"');
    expect(markup).not.toContain('data-air-system-tether="sad-2"');
    expect(markup).toContain('data-air-system-member="sad-2"');
    expect(markup).toContain('data-air-system-tag="u1"');
    // DU-2 is not in focus; the terminal in no system shows dashed grey while a system is.
    expect(markup).not.toContain('data-air-system-tether="sad-3"');
    expect(markup).toContain('data-air-system-unassigned="rag-9"');
    expect(airSystemMarkup(analysis, { k: 0.2, focusUnitIds: new Set(), showAll: false, showTags: true })).not.toContain('data-air-system-member');
    expect(airSystemMarkup(analysis, { k: 0.2, focusUnitIds: new Set(), showAll: true, showTags: true })).toContain('data-air-system-tether="sad-3"');
    // Pick mode says what a click does.
    const pick = airSystemMarkup(analysis, { k: 0.2, focusUnitIds: new Set(), showAll: false, showTags: true, pickUnitId: 'u2', hoverTerminalId: 'sad-1' });
    expect(pick).toContain('Move SAD-1 from DU-1 to DU-2');
    const remove = airSystemMarkup(analysis, { k: 0.2, focusUnitIds: new Set(), showAll: false, showTags: true, pickUnitId: 'u1', hoverTerminalId: 'sad-1' });
    expect(remove).toContain('Remove SAD-1 from DU-1');
  });

  it('schedules every terminal by system and service, with the CSV', () => {
    const rows = airTerminalSchedule(analyseAirSystems(scene), settings, new Map([['room-1', 'Office']]));
    expect(rows.map((row) => [row.tag, row.system, row.service, row.status])).toEqual([
      ['SAD-1', 'DU-1', 'supply', 'not ducted'],
      ['SAD-2', 'DU-1', 'supply', 'ducted'],
      ['RAG-1', 'DU-1', 'return', 'not ducted'],
      ['SAD-3', 'DU-2', 'supply', 'not ducted'],
      ['RAG-9', '', 'return', 'unassigned'],
    ]);
    expect(rows[0]).toMatchObject({ type: 'Square 4-way ceiling diffuser', face: '595×595', neckMm: 200, airflowM3h: 300, fixed: false, room: 'Office', pressureDropPa: 15 });
    const csv = airTerminalScheduleToCsv(rows).split('\n');
    expect(csv[0]).toBe('Tag,System,Service,Type,Face (mm),Neck (mm),Airflow (m3/h),Airflow basis,Neck velocity (m/s),Pressure drop (Pa),Filter,Room,Status');
    expect(csv).toHaveLength(6);
  });
});

describe('air systems through a duct tree', () => {
  it('follows a branch up to the run off the collar', () => {
    const u1 = unit('u1', 0);
    const supply = resolveUnitAirPorts(u1).find((port) => port.kind === 'supply')!;
    const main = buildDuctRunDraftElement({
      port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 1000 }], end: { kind: 'plenum', widthMm: 900, heightMm: 350, lengthMm: 500 },
    }, 'main');
    const origin = spigotOrigin(main, settings, { face: 'left', alongMm: 250, acrossMm: 0, style: 'spin-in', vcd: true }, roundLeg(200))!;
    if (origin.kind !== 'spigot') throw new Error('expected a spigot origin');
    const target = terminal('sad-1', { x: origin.point.x + origin.direction.x * 1500, y: origin.point.y + origin.direction.y * 1500 }, supplySpec);
    const port = terminalSpigotPort(target)!;
    const branch = buildDuctRunDraft({
      origin, points: [{ x: port.lip.x, y: port.lip.y, z: port.lip.z - 100 }], legSizes: [roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'sad-1', portId: 'spigot', flex: true },
    }, 'branch', [u1, main, target]).element;
    const scene = [u1, main, target, branch];
    expect(servingUnitOf('sad-1', scene)).toEqual({ unitId: 'u1', service: 'supply', runId: 'branch' });
    expect(analyseAirSystems(scene).byUnit.get('u1')!.supply.members[0]!.source).toBe('connected');
  });
});
