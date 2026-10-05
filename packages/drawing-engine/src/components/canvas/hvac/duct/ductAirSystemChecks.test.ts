import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { checkAirSystems, outlineGapMm } from './ductAirSystemChecks';
import { buildDuctRunDraftElement } from './ductDraft';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec, type DuctTerminalSpec } from './ductTerminals';
import { roundLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const rooms = [
  { id: 'r1', name: 'Office', vertices: [{ x: -3000, y: -6000 }, { x: 5000, y: -6000 }, { x: 5000, y: 4000 }, { x: -3000, y: 4000 }] },
  { id: 'r2', name: 'Meeting', vertices: [{ x: 5000, y: -6000 }, { x: 12000, y: -6000 }, { x: 12000, y: 4000 }, { x: 5000, y: 4000 }] },
];

function unit(id: string, x: number, properties: Record<string, unknown> = {}): HvacElement {
  return {
    id, type: 'ducted-ac', position: { x, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2400,
    mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W', ...properties },
  };
}

function terminal(id: string, centre: Point2D, spec: DuctTerminalSpec, unitId: string | null): HvacElement {
  const envelope = terminalEnvelope(spec);
  return {
    id, type: spec.service === 'return' ? 'return-grille' : 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec, ...(unitId ? { airSystem: { unitId } } : {}) },
  };
}

const supply = typicalTerminalSpec('square-4way', 200);
const ret = typicalTerminalSpec('return-egg-crate', 250);
const codes = (issues: ReturnType<typeof checkAirSystems>) => issues.map((issue) => `${issue.level}:${issue.code}:${issue.entityId}`);

describe('air-system design checks', () => {
  it('measures the plan gap between two faces', () => {
    const a = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(outlineGapMm(a, a.map((p) => ({ x: p.x + 300, y: p.y })))).toBeCloseTo(200, 9);
    expect(outlineGapMm(a, a.map((p) => ({ x: p.x + 50, y: p.y + 50 })))).toBe(0);
  });

  it('a clean system raises nothing but its terminals in no system', () => {
    const scene = [unit('u1', 0), terminal('sad-1', { x: -1500, y: -3000 }, supply, 'u1'), terminal('sad-2', { x: 1500, y: -3000 }, supply, 'u1'),
      terminal('rag-1', { x: 0, y: 2500 }, ret, 'u1'), terminal('rag-9', { x: 3500, y: 2500 }, ret, null)];
    expect(codes(checkAirSystems(scene, settings, rooms))).toEqual(['information:DU_TERMINAL_UNASSIGNED:rag-9']);
  });

  it('flags a terminal ducted from another unit, or by a duct of the other service', () => {
    const u1 = unit('u1', 0);
    const u2 = unit('u2', 7000);
    const s1 = terminal('sad-1', { x: 2000, y: -3000 }, { ...supply, spigotSide: 'front' }, 'u2');
    const collar = resolveUnitAirPorts(u1).find((port) => port.kind === 'supply')!;
    const lip = terminalSpigotPort(s1)!.lip;
    const run = buildDuctRunDraftElement({
      port: collar, points: [{ x: collar.lip.x, y: lip.y + 400 }, { x: lip.x, y: lip.y + 400 }, { x: lip.x, y: lip.y, z: lip.z - 100 }],
      legSizes: [{ widthMm: collar.widthMm, heightMm: collar.heightMm }, roundLeg(200), roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'sad-1', portId: 'spigot', flex: true },
    }, 'run');
    expect(codes(checkAirSystems([u1, u2, s1, run], settings, rooms))).toContain('error:DU_SYSTEM_MISMATCH:sad-1');
    // The same run ending on a return terminal (its spigot where the diffuser's was): a return on a supply duct.
    const asReturn = { ...s1, type: 'return-grille' as const, properties: { terminal: { ...s1.properties.terminal as DuctTerminalSpec, service: 'return' as const }, airSystem: { unitId: 'u1' } } };
    expect(codes(checkAirSystems([u1, u2, asReturn, run], settings, rooms))).toContain('error:DU_SERVICE_MISMATCH:sad-1');
  });

  it('flags a terminal assigned to a unit without a collar of its service, and an unbalanced system', () => {
    const noReturn = unit('u1', 0, { airPorts: [{ id: 'supply', kind: 'supply', lip: { x: -117, y: -348.5, z: 152 }, normal: { x: 0, y: -1 }, widthMm: 674, heightMm: 164 }] });
    const issues = codes(checkAirSystems([noReturn, terminal('rag-1', { x: 0, y: 2500 }, ret, 'u1')], settings, rooms));
    expect(issues).toContain('error:DU_SYSTEM_NO_COLLAR:u1');
    // Two diffusers fixed at 450 m³/h each against the unit's 600 m³/h.
    const fixed = { ...supply, designAirflowM3h: 450 };
    const unbalanced = codes(checkAirSystems([unit('u1', 0), terminal('sad-1', { x: -1500, y: -3000 }, fixed, 'u1'), terminal('sad-2', { x: 1500, y: -3000 }, fixed, 'u1')], settings, rooms));
    expect(unbalanced).toContain('warning:DU_SYSTEM_AIRFLOW:u1');
  });

  it('warns when a return sits too close to a supply face in the same room, not across a wall', () => {
    const near = [unit('u1', 0), terminal('sad-1', { x: 1000, y: -2500 }, supply, 'u1'), terminal('rag-1', { x: 1000, y: -1200 }, ret, 'u1')];
    expect(codes(checkAirSystems(near, settings, rooms))).toContain('warning:DU_SHORT_CIRCUIT:rag-1');
    // 0.7 m apart, but the supply is in the next room.
    const across = [unit('u1', 0), terminal('sad-1', { x: 5650, y: -2500 }, supply, 'u1'), terminal('rag-1', { x: 4350, y: -2500 }, ret, 'u1')];
    expect(codes(checkAirSystems(across, settings, rooms))).not.toContain('warning:DU_SHORT_CIRCUIT:rag-1');
  });

  it('warns when a room the system supplies has no return of it, while its return is ducted elsewhere', () => {
    const scene = [unit('u1', 0), terminal('sad-1', { x: 0, y: -3000 }, supply, 'u1'), terminal('sad-2', { x: 8000, y: -3000 }, supply, 'u1'),
      terminal('rag-1', { x: 0, y: 2500 }, ret, 'u1')];
    const issues = checkAirSystems(scene, settings, rooms);
    const path = issues.filter((issue) => issue.code === 'DU_ROOM_RETURN_PATH');
    expect(path).toHaveLength(1);
    expect(path[0]!.message).toContain('Meeting gets supply air from DU-1');
    // A system without ducted returns draws from the ceiling void: no warning.
    expect(checkAirSystems(scene.slice(0, 3), settings, rooms).some((issue) => issue.code === 'DU_ROOM_RETURN_PATH')).toBe(false);
  });
});
