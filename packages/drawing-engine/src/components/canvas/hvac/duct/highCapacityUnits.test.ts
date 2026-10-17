/**
 * High-capacity ducted units (FDU224/280KXZE1, 4320 m³/h at Hi): their ducts
 * design by constant friction without running out of stock sizes — the main
 * is sized at the trunk velocity limit (0.8 Pa/m would mean 6.25 m/s), round
 * mains reach Ø630 and above — and the fan's 200 Pa covers them.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct, type AutoDuctResult } from './ductAutoLayout';
import { legNormal } from './ductBranches';
import { resolveDuctSettings } from './ductSettings';
import { readUnitAirData, sizeRound, velocityMs } from './ductSizing';
import { basisLimits, defaultSizingBasis, velocityAtFriction } from './ductSystemSizing';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';

const settings = resolveDuctSettings({ soffitMm: 3300 });

function fdu280(): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === 'vrf-fdu280kxze1')!;
  return {
    id: 'fdu', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: definition.widthMm, depth: definition.depthMm,
    height: definition.heightMm, elevation: 2400, mountType: 'ceiling', label: 'FDU280', supplyZoneRatio: 0.5,
    properties: { ...(definition.defaultProperties ?? {}) },
  };
}

function diffuser(id: string, centre: Point2D, facing: Point2D): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 300);
  const envelope = terminalEnvelope(spec);
  const rotation = (((Math.atan2(facing.x, -facing.y) * 180) / Math.PI) + 360) % 360;
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    rotation, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}

describe('an FDU280KXZE1 with six Ø300 diffusers, by constant friction', () => {
  const unit = fdu280();
  const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
  const n = supply.normal;
  const t = legNormal(n);
  const at = (along: number, across: number): Point2D => ({ x: supply.lip.x + n.x * along + t.x * across, y: supply.lip.y + n.y * along + t.y * across });
  // The trunk down the middle, three diffusers either side of it (each spigot facing the trunk).
  const terminals = [2400, 4800, 7200].flatMap((along, row) => [-2800, 2800].map((across, side) => diffuser(`sd${row * 2 + side}`, at(along, across), across < 0 ? t : { x: -t.x, y: -t.y })));

  it('takes 4320 m³/h at Hi and up to 200 Pa from the maker\'s data', () => {
    const air = readUnitAirData(unit);
    expect(air.airflowM3h?.hi).toBe(4320);
    expect(air.maxEspPa).toBe(200);
  });

  it('round stock reaches the main a large unit needs (no longer capped at Ø500)', () => {
    const limits = basisLimits(defaultSizingBasis(settings, 'supply', 4320), 'trunk');
    const d = sizeRound(4320, limits, settings.autoRoundSizesMm);
    expect(d).toBeGreaterThanOrEqual(560);
    expect(velocityMs({ widthMm: d, heightMm: d, diameterMm: d }, 4320)).toBeLessThanOrEqual(limits.maxVelocityMs * 1.001);
  });

  it('designs cleanly: every section within the friction rate or its velocity limit, none capped, the fan covering it', () => {
    const basis = defaultSizingBasis(settings, 'supply', null, 'hi');
    const result: AutoDuctResult = generateAutoDuct([unit, ...terminals], {
      unitId: 'fdu', terminalIds: terminals.map((terminal) => terminal.id), fanSpeed: 'hi', layout: 'auto',
      services: { supply: true, return: false }, rebuildExisting: false, shape: 'rect', sizing: { supply: basis },
    }, settings);
    expect(result.airflowM3h).toBe(4320);
    const design = result.designs[result.selected]!;
    expect(design).toBeDefined();
    expect(design.errors).toBe(0);
    const report = result.services.find((service) => service.service === 'supply')!.sizingReport!;
    expect(report.issues.some((issue) => issue.code === 'DU_SIZE_CAPPED')).toBe(false);
    // 0.8 Pa/m would put 6.25 m/s in the main; the 5 m/s trunk limit sizes it, and the report says so.
    expect(velocityAtFriction(4320, 0.8)).toBeGreaterThan(6);
    expect(report.main!.velocityCapped).toBe(true);
    expect(report.main!.velocityMs).toBeLessThanOrEqual(settings.autoMaxVelocityTrunkMs * 1.001);
    for (const section of report.sections) {
      if (section.airflowM3h <= 0 || section.part === 'runout') continue;
      expect(section.velocityMs).toBeLessThanOrEqual(report.basis.maxVelocity[section.part] * 1.001 + 0.01);
    }
    expect(report.terminals.every((terminal) => terminal.airflowM3h === 720)).toBe(true);
    expect(design.requiredEspPa).toBeLessThanOrEqual(200);
  }, 240000);
});
