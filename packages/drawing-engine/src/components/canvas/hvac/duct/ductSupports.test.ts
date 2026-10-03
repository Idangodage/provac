import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { addDuctRunMeshes } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { tapOrigin } from './ductBranchTargets';
import { tapAttachment } from './ductBranches';
import { buildDuctRunDraftElement, buildDuctRunDraft, type DuctDraftPoint } from './ductDraft';
import { planDuctRun, type DuctFabricationPlan } from './ductFabricationPlanner';
import { resolveDuctSettings } from './ductSettings';
import { metricRodFor, table41Minimum, trapezeMemberFor } from './ductSupportTables';
import { getDuctSupportPlan, planDuctSupports, type DuctSupportPlan } from './ductSupports';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { buildDuctRunElement, readDuctRunSpec, roundLeg, type DuctLeg, type DuctTapStyle } from './ductTypes';

const settings = resolveDuctSettings({ soffitMm: 2900 });
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const z0 = supply.lip.z - supply.heightMm / 2;
const along = (mm: number, across = 0): DuctDraftPoint => ({ x: supply.lip.x + across, y: supply.lip.y - mm });

function supported(element: HvacElement, scene: HvacElement[] = [unit, element], overrideSettings = settings): { plan: DuctFabricationPlan; supports: DuctSupportPlan } {
  const plan = planDuctRun(element, { settings: overrideSettings, scene })!;
  return { plan, supports: planDuctSupports(plan, scene, overrideSettings, overrideSettings.soffitMm ?? 2900) };
}

/** Gaps between hangers along the straight duct (an elbow is held at its ends, so its own length does not count). */
const gaps = (supports: DuctSupportPlan, plan?: DuctFabricationPlan) => supports.hangers.slice(1).map((hanger, index) => {
  const a = supports.hangers[index]!.stationMm;
  const b = hanger.stationMm;
  const fittings = (plan?.pieces ?? []).filter((piece) => piece.kind === 'elbow' || piece.kind === 'offset')
    .reduce((total, piece) => total + Math.max(0, Math.min(b, piece.stationEndMm) - Math.max(a, piece.stationStartMm)), 0);
  return b - a - fittings;
});

describe('SMACNA chapter 4 tables', () => {
  it('Table 4-1M minimum per pair by half perimeter and the spacing column that covers it', () => {
    expect(table41Minimum(838, 2400)).toEqual({ strap: '25.4×1.00', rodMm: 6.4 });
    expect(table41Minimum(838, 3000)).toEqual({ strap: '25.4×1.31', rodMm: 9.5 });
    expect(table41Minimum(700, 1200)).toEqual({ strap: '25.4×0.85', rodMm: 2.7 });
    expect(table41Minimum(5000, 2400)).toBeNull();
  });

  it('metric rods by load at SMACNA stress (derived); Table 4-3M lightest member by length and load', () => {
    expect(metricRodFor(20)!.label).toBe('M8');
    expect(metricRodFor(300)!.label).toBe('M10');
    expect(metricRodFor(530)!.label).toBe('M16');
    expect(metricRodFor(20, 'M10')!.label).toBe('M10');
    expect(metricRodFor(1000)).toBeNull();
    // 775 mm bar → the 900 mm row: 25.4×1.61 carries 27 kg, 25.4×3.2 59 kg.
    expect(trapezeMemberFor(775, 40)).toMatchObject({ member: { label: 'L25.4×3.2' }, allowableKg: 59, rowLengthMm: 900 });
    expect(trapezeMemberFor(1500, 150)!.member.label).toBe('L38.1×4.8');
    expect(trapezeMemberFor(2600, 50)).toBeNull();
  });
});

describe('duct supports', () => {
  // 7 m straight supply off the FDUM22, capped.
  const straight = buildDuctRunDraftElement({ port: supply, points: [along(7000)] }, 'straight');
  const { plan, supports } = supported(straight);

  it('hangs the run just past the connector, near its end, and at no more than 2.4 m', () => {
    expect(supports.issues).toEqual([]);
    const first = supports.hangers[0]!;
    // Connector 254 mm, then 300 mm (practice), well within 610 mm.
    expect(first.stationMm).toBeCloseTo(554, 6);
    expect(first.reasons).toContain('unit');
    const last = supports.hangers.at(-1)!;
    expect(last.stationMm).toBeGreaterThanOrEqual(7000 - 610);
    expect(Math.max(...gaps(supports))).toBeLessThanOrEqual(2400 + 0.5);
  });

  it('keeps every hanger clear of the joints (between flanges)', () => {
    for (const hanger of supports.hangers) {
      for (const joint of plan.joints) expect(Math.abs(joint.stationMm - hanger.stationMm)).toBeGreaterThanOrEqual(150 - 0.5);
    }
  });

  it('sizes the trapeze: share of the run + 4.89 kg/m² + bar; M8 rods up to the soffit', () => {
    const hanger = supports.hangers[1]!;
    expect(hanger.kind).toBe('trapeze');
    expect(hanger.rods).toHaveLength(2);
    expect(hanger.rod!.label).toBe('M8');
    expect(hanger.bar!.spanMm).toBeCloseTo(674 + 1.2 + 100, 6);
    expect(hanger.bar!.member.label).toBe('L25.4×3.2');
    expect(hanger.loadKg).toBeGreaterThan(20);
    expect(hanger.loadKg).toBeLessThan(59);
    // Rod: from 30 mm below the bar (under the duct) up to the 2900 soffit.
    expect(hanger.supportZ).toBeCloseTo(z0 - 0.6, 6);
    expect(hanger.rods[0]!.bottomZ).toBeCloseTo(z0 - 0.6 - 25.4 - 30, 6);
    expect(hanger.rods[0]!.bottomZ + hanger.rods[0]!.lengthMm).toBeGreaterThanOrEqual(2900);
    expect(hanger.smacnaMinimum).toBe('Table 4-1M per pair: ⌀6.4 rod or strap 25.4×1.00');
  });

  it('puts a hanger within 610 mm of each elbow', () => {
    const bend = buildDuctRunDraftElement({ port: supply, points: [along(3000), along(3000, 4000)] }, 'bend');
    const result = supported(bend);
    const elbow = result.plan.pieces.find((piece) => piece.kind === 'elbow')!;
    const near = result.supports.hangers.filter((hanger) => hanger.stationMm >= elbow.stationStartMm - 610 && hanger.stationMm <= elbow.stationEndMm + 610);
    expect(near.length).toBeGreaterThan(0);
    expect(near.some((hanger) => hanger.reasons.includes('elbow'))).toBe(true);
    // Both sides of the elbow (practice; S4.1 asks for one).
    expect(result.supports.hangers.some((hanger) => hanger.stationMm <= elbow.stationStartMm && hanger.stationMm >= elbow.stationStartMm - 610)).toBe(true);
    expect(result.supports.hangers.some((hanger) => hanger.stationMm >= elbow.stationEndMm && hanger.stationMm <= elbow.stationEndMm + 610)).toBe(true);
    expect(Math.max(...gaps(result.supports, result.plan))).toBeLessThanOrEqual(2400 + 0.5);
    expect(result.supports.issues).toEqual([]);
  });

  it('puts a hanger on the parent within 1220 mm of a take-off', () => {
    const main = buildDuctRunDraftElement({ port: supply, points: [along(7000)] }, 'main');
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3500, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 })!;
    if (origin.kind !== 'tap') throw new Error('expected a tap origin');
    const branch = buildDuctRunDraft({ origin, points: [{ x: origin.point.x - 2000, y: origin.point.y }], legSizes: [{ widthMm: 300, heightMm: 150 }] }, 'branch', [unit, main]).element;
    const scene = [unit, main, branch];
    const result = supported(main, scene);
    const tapStation = 3500;
    expect(result.supports.hangers.some((hanger) => Math.abs(hanger.stationMm - tapStation) <= 1220 && hanger.reasons.includes('branch'))).toBe(true);
    const branchSupports = supported(branch, scene).supports;
    expect(branchSupports.hangers[0]!.stationMm).toBeLessThanOrEqual(1220);
  });

  it.each([
    { style: 'shoe-45', section: { widthMm: 300, heightMm: 150 } },
    { style: 'conical', section: roundLeg(150) },
  ] satisfies Array<{ style: DuctTapStyle; section: DuctLeg }>)('keeps parent supports clear of $style collars on later legs', ({ style, section }) => {
    const main = buildDuctRunDraftElement({ port: supply, points: [along(3000), along(3000, 7000)] }, 'main');
    const request = { legIndex: 1, stationMm: 3500, side: 1 as const, style, vcd: true };
    const origin = tapOrigin(main, settings, request, section)!;
    if (origin.kind !== 'tap') throw new Error('expected a tap origin');
    const branch = buildDuctRunDraft({ origin,
      points: [{ x: origin.point.x + origin.direction.x * 2000, y: origin.point.y + origin.direction.y * 2000 }],
      legSizes: [section],
    }, 'branch', [unit, main]).element;
    const { plan: mainPlan, supports: mainSupports } = supported(main, [unit, main, branch]);
    const attachment = tapAttachment(mainPlan.spec, request, section, mainPlan.constructionByLeg[1]!.sheetThicknessMm!, settings)!;
    const from = 3000 + attachment.openingFromMm - settings.hangerJointClearanceMm;
    const to = 3000 + attachment.openingToMm + settings.hangerJointClearanceMm;
    expect(mainSupports.issues).toEqual([]);
    expect(mainSupports.hangers.some((hanger) => hanger.reasons.includes('branch') && Math.abs(hanger.stationMm - 6500) <= 1220)).toBe(true);
    for (const hanger of mainSupports.hangers) {
      expect(hanger.stationMm <= from || hanger.stationMm >= to).toBe(true);
    }
    expect(Math.max(...gaps(mainSupports, mainPlan))).toBeLessThanOrEqual(settings.hangerSpacingMm + 0.5);
  });

  it('reports an unavailable support instead of hanging through a crowded take-off', () => {
    const main = buildDuctRunDraftElement({
      origin: { kind: 'free', point: { x: 0, y: 0 }, bottomZ: 2500, service: 'supply' },
      points: [{ x: 1000, y: 0 }], legSizes: [{ widthMm: 1000, heightMm: 300 }],
    }, 'crowded');
    const section = { widthMm: 800, heightMm: 200 };
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 500, side: 1, style: 'straight', vcd: false }, section)!;
    if (origin.kind !== 'tap') throw new Error('expected a tap origin');
    const branch = buildDuctRunDraft({ origin, points: [{ x: origin.point.x, y: origin.point.y + 2000 }], legSizes: [section] }, 'wide-branch', [main]).element;
    const result = supported(main, [main, branch]);
    expect(result.supports.hangers).toEqual([]);
    expect(result.supports.issues.some((issue) => issue.code === 'DU_SUPPORT_RULE' && issue.message.includes('take-offs'))).toBe(true);
  });

  it.each([true, false])('a collar-only flex branch delegates to a feasible parent hanger: %s', (parentCanHang) => {
    const mainLength = parentCanHang ? 4000 : 400;
    const main = buildDuctRunDraftElement({
      origin: { kind: 'free', point: { x: 0, y: 0 }, bottomZ: 2500, service: 'supply' },
      points: [{ x: mainLength, y: 0 }], legSizes: [{ widthMm: 400, heightMm: 250 }],
    }, 'main-flex');
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: mainLength / 2, side: 1, style: 'spin-in', vcd: true }, roundLeg(200))!;
    if (origin.kind !== 'tap') throw new Error('expected a tap origin');
    const stub = settings.tapCollarMm + settings.vcdLengthMm;
    const terminalSpec = typicalTerminalSpec('square-4way', 200);
    const envelope = terminalEnvelope(terminalSpec);
    const draft: HvacElement = { id: 'flex-diffuser', type: 'diffuser', position: { x: 0, y: 0 }, rotation: 0,
      width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
      elevation: origin.bottomZ + 100 - terminalSpec.faceHeightMm - terminalSpec.plenumHeightMm / 2,
      mountType: 'ceiling', label: 'SD', supplyZoneRatio: 0.5, properties: { terminal: terminalSpec } };
    const port = terminalSpigotPort(draft)!;
    const terminal = { ...draft, position: { x: origin.point.x - port.lip.x, y: origin.point.y + stub + 900 - port.lip.y } };
    const terminalPort = terminalSpigotPort(terminal)!;
    const branch = buildDuctRunDraft({ origin,
      points: [{ x: origin.point.x, y: origin.point.y + stub, z: origin.bottomZ },
        { x: terminalPort.lip.x, y: terminalPort.lip.y, z: terminalPort.lip.z - 100 }],
      legSizes: [roundLeg(200), roundLeg(200)], end: { kind: 'terminal', terminalId: terminal.id, portId: 'spigot', flex: true },
    }, 'flex-branch', [main, terminal]).element;
    const scene = [main, terminal, branch];
    const result = supported(branch, scene);
    expect(result.plan.status).toBe('ok');
    expect(result.plan.pieces.map((piece) => piece.kind)).toEqual(['takeoff', 'damper', 'flex']);
    expect(result.supports.hangers).toEqual([]);
    const supportWarnings = result.supports.issues.filter((issue) => issue.code === 'DU_SUPPORT_RULE');
    if (parentCanHang) {
      expect(supportWarnings).toEqual([]);
      // Parent support state is a scene dependency even when this child plan is retained.
      expect(getDuctSupportPlan(result.plan, scene, settings).issues).toEqual([]);
      const mainSpec = readDuctRunSpec(main)!;
      const raisedMain = { ...main, properties: buildDuctRunElement({ ...mainSpec,
        path: mainSpec.path.map((point) => ({ ...point, z: 3000 })),
      }).properties! };
      expect(getDuctSupportPlan(result.plan, [raisedMain, terminal, branch], settings).issues
        .some((issue) => issue.code === 'DU_SUPPORT_RULE')).toBe(true);
      const branchSpec = readDuctRunSpec(branch)!;
      const rigidBranch = { ...branch, properties: buildDuctRunElement({ ...branchSpec,
        end: { kind: 'terminal', terminalId: terminal.id, portId: 'spigot', flex: false },
      }).properties! };
      const withStub = supported(main, scene).supports;
      const withoutStub = supported(main, [main, terminal, rigidBranch]).supports;
      expect(withStub.hangers.map((hanger) => hanger.stationMm)).toEqual(withoutStub.hangers.map((hanger) => hanger.stationMm));
      const load = (supports: DuctSupportPlan) => supports.hangers.reduce((sum, hanger) => sum + hanger.loadKg, 0);
      expect(load(withStub) - load(withoutStub)).toBeGreaterThan(result.plan.pieces.filter((piece) => piece.kind !== 'flex').reduce((sum, piece) => sum + piece.massKg, 0));
    } else {
      expect(supportWarnings.length).toBeGreaterThan(0);
      expect(supported(main, scene).supports.hangers).toEqual([]);
    }
  });

  it('flags a duct that reaches the soffit, and hangs a riser at the riser interval', () => {
    const low = supported(straight, [unit, straight], resolveDuctSettings({ soffitMm: 2550 }));
    expect(low.supports.issues.map((issue) => issue.code)).toContain('DU_SOFFIT');
    const below = supported(straight, [unit, straight], resolveDuctSettings({ soffitMm: 1000 }));
    expect(below.supports.hangers.every((hanger) => hanger.rods.every((rod) => rod.lengthMm >= 0))).toBe(true);
    const riser = buildDuctRunDraftElement({
      origin: { kind: 'free', point: { x: 0, y: 0 }, bottomZ: 9000, service: 'supply' },
      points: [{ x: 2000, y: 0 }, { x: 4000, y: 0, z: 4000 }], legSizes: [{ widthMm: 600, heightMm: 300 }],
    }, 'riser');
    const result = supported(riser, [riser], resolveDuctSettings({ soffitMm: 12000 }));
    expect(result.supports.risers).toHaveLength(1);
    expect(result.supports.risers[0]!.member).toBe('L40×4');
    expect(result.supports.risers[0]!.lengthMm).toBeCloseTo(600 + 2 * result.plan.constructionByLeg[1]!.sheetThicknessMm! + 300, 6);
    // Level hangers stay off the riser: next to its elbows instead.
    expect(result.supports.hangers.every((hanger) => result.plan.pieces.some((piece) => !piece.vertical && !piece.frame
      && hanger.stationMm >= piece.stationStartMm && hanger.stationMm <= piece.stationEndMm))).toBe(true);
  });

  it('a small round duct hangs from one rod and a band (Table 4-2)', () => {
    const round = buildDuctRunDraftElement({
      origin: { kind: 'free', point: { x: 0, y: 0 }, bottomZ: 2600, service: 'supply' },
      points: [{ x: 5000, y: 0 }], legSizes: [roundLeg(250)],
    }, 'round');
    const result = supported(round, [round]);
    expect(result.supports.hangers.every((hanger) => hanger.kind === 'band' && hanger.rods.length === 1)).toBe(true);
    expect(result.supports.hangers[0]!.smacnaMinimum).toMatch(/^Table 4-2: one ⌀6.4 rod/);
    expect(Math.max(...gaps(result.supports))).toBeLessThanOrEqual(2400 + 0.5);
  });

  it('lists the supports in the BOM and builds them in 3D', () => {
    const bom = buildDuctBom([plan], [supports]);
    const rodCount = supports.hangers.reduce((total, hanger) => total + hanger.rods.length, 0);
    const anchors = bom.find((row) => row.description === 'Soffit anchor M8')!;
    expect(anchors.quantity).toBe(rodCount);
    const metres = bom.find((row) => row.description === 'Threaded rod M8, galvanised')!;
    expect(metres.quantity).toBeCloseTo(supports.hangers.reduce((total, hanger) => total + hanger.rods.reduce((sum, rod) => sum + rod.lengthMm, 0), 0) / 1000, 2);
    expect(bom.filter((row) => row.description.startsWith('Trapeze angle')).reduce((total, row) => total + row.quantity, 0)).toBe(supports.hangers.length);
    const group = new THREE.Group();
    addDuctRunMeshes(group, straight, { allElements: [unit, straight], ductSettings: settings });
    const mesh = group.children.find((child) => child.name === 'duct-supports') as THREE.Mesh;
    expect(mesh).toBeDefined();
    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.max.z).toBeCloseTo(2900, 0);
  });
});
