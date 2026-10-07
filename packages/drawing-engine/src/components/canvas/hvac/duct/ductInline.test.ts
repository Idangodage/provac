import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { priceDuctPlans } from './ductEconomics';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { ductRunMarkup } from './ductOverlayMarkup';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { buildDuctFlowTree, ductRunPieceLosses, FITTING_LOSS_COEFFICIENTS } from './ductPressure';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { ductSegmentOptions } from './ductSegmentOptions';
import { ductSegmentOf, ductSegments } from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { velocityMs, velocityPressurePa } from './ductSizing';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctInlineAccessories, readDuctRunSpec, roundLeg, type DuctInlineAccessory, type DuctLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });
const RECT: DuctLeg = { widthMm: 600, heightMm: 300 };

/** A 600×300 main 6 m long with `inline` accessories (and a capped end). */
function main(inline: DuctInlineAccessory[], section: DuctLeg = RECT): HvacElement {
  const run = buildDuctRunDraftElement({ port, points: [S(6000)], legSizes: [section] }, 'm');
  return ductRunElementWithSpec(run, { ...readDuctRunSpec(run)!, inline });
}
const planOf = (element: HvacElement, scene: HvacElement[] = [unit, element]) => getDuctRunPlan(element, scene, settings)!;
const clashes = (plan: DuctFabricationPlan) => plan.issues.filter((issue) => issue.code === 'DU_INLINE_CLASH');
const ACCESSORIES: DuctInlineAccessory[] = [
  { id: 'i1', kind: 'damper', legIndex: 0, stationMm: 2000 },
  { id: 'i2', kind: 'access-door', legIndex: 0, stationMm: 3000 },
  { id: 'i3', kind: 'attenuator', legIndex: 0, stationMm: 4500, lengthMm: 900 },
];

describe('accessories set into a straight', () => {
  it('are read tolerantly: unknown kinds, duplicate ids and bad stations are left out', () => {
    expect(readDuctInlineAccessories([
      { id: 'i1', kind: 'damper', legIndex: 0, stationMm: 100 },
      { id: 'i1', kind: 'attenuator', legIndex: 0, stationMm: 900 },
      { id: 'i2', kind: 'silencer', legIndex: 0, stationMm: 900 },
      { id: 'i3', kind: 'attenuator', legIndex: 0, stationMm: -5 },
      { id: 'i4', kind: 'attenuator', legIndex: 1, stationMm: 1200, lengthMm: 1200 },
    ])).toEqual([{ id: 'i1', kind: 'damper', legIndex: 0, stationMm: 100 }, { id: 'i4', kind: 'attenuator', legIndex: 1, stationMm: 1200, lengthMm: 1200 }]);
    expect(readDuctInlineAccessories('nope')).toBeUndefined();
  });

  it('each becomes a piece of its own, centred where asked, the straights laid round it and no joint inside it', () => {
    const plan = planOf(main(ACCESSORIES));
    expect(clashes(plan)).toEqual([]);
    const damper = plan.pieces.find((piece) => piece.inlineId === 'i1')!;
    const door = plan.pieces.find((piece) => piece.inlineId === 'i2')!;
    const attenuator = plan.pieces.find((piece) => piece.inlineId === 'i3')!;
    expect(damper.kind).toBe('damper');
    expect(damper.lengthMm).toBeCloseTo(settings.vcdLengthMm, 6);
    // A 600 mm face takes a 450 door with 50 mm a side, in the bottom of a flat duct; its section 100 mm longer.
    expect(door.kind).toBe('access-door');
    expect(door.accessDoor).toEqual({ sizeMm: 450, face: 'bottom' });
    expect(door.lengthMm).toBeCloseTo(550, 6);
    expect(attenuator.kind).toBe('attenuator');
    expect(attenuator.lengthMm).toBeCloseTo(900, 6);
    for (const [piece, station] of [[damper, 2000], [door, 3000], [attenuator, 4500]] as const) {
      expect((piece.stationStartMm + piece.stationEndMm) / 2).toBeCloseTo(station, 6);
    }
    // The run's pieces still add up to its centreline, in order.
    const total = plan.pieces.reduce((sum, piece) => sum + (piece.stationEndMm - piece.stationStartMm), 0);
    expect(total).toBeCloseTo(plan.pieces.at(-1)!.stationEndMm - plan.pieces[0]!.stationStartMm, 6);
    plan.pieces.slice(1).forEach((piece, index) => expect(piece.stationStartMm).toBeCloseTo(plan.pieces[index]!.stationEndMm, 6));
    for (const piece of [damper, door, attenuator]) {
      expect(plan.joints.some((joint) => joint.stationMm > piece.stationStartMm + 1 && joint.stationMm < piece.stationEndMm - 1)).toBe(false);
    }
    // The attenuator is bought in: no sheet of the run's, its casing's mass for the supports.
    expect(attenuator.sheetAreaM2).toBe(0);
    expect(attenuator.massKg).toBeGreaterThan(0);
    expect(attenuator.attenuator).toEqual({ casingMm: 50, type: 'splitter' });
  });

  it('are refused where they would sit on a fitting, on each other or on a leg the run no longer has', () => {
    const onConnector = planOf(main([{ id: 'i1', kind: 'attenuator', legIndex: 0, stationMm: 200, lengthMm: 900 }]));
    expect(clashes(onConnector)).toHaveLength(1);
    expect(onConnector.pieces.some((piece) => piece.inlineId === 'i1')).toBe(false);
    const overlapping = planOf(main([{ id: 'i1', kind: 'damper', legIndex: 0, stationMm: 3000 }, { id: 'i2', kind: 'access-door', legIndex: 0, stationMm: 3100 }]));
    // The one further along is flagged: the door's 550 mm section starts before the damper.
    expect(clashes(overlapping).map((issue) => issue.message).join(' ')).toMatch(/volume damper \(i1\) overlaps another accessory/);
    expect(clashes(planOf(main([{ id: 'i1', kind: 'damper', legIndex: 3, stationMm: 1000 }])))[0]!.message).toMatch(/no longer has/);
  });

  it("are segments of their own, titled as they are", () => {
    const plan = planOf(main(ACCESSORIES));
    const keys = ductSegments(plan).map((segment) => segment.key);
    expect(keys).toEqual(expect.arrayContaining(['inline:i1', 'inline:i2', 'inline:i3']));
    expect(ductSegmentOf(plan, 'inline:i1')!.title).toBe('Volume damper (in line)');
    expect(ductSegmentOf(plan, 'inline:i2')).toMatchObject({ kind: 'access-door', title: 'Access door' });
    expect(ductSegmentOf(plan, 'inline:i3')).toMatchObject({ kind: 'attenuator', title: 'Sound attenuator' });
    expect(ductSegmentOf(plan, 'inline:i3')!.detail).toMatch(/0.90 m · rectangular splitter · casing 50 mm proud/);
  });

  it("an attenuator loses its practice coefficient on the duct's velocity, a round one less", () => {
    const spec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: 600 };
    const envelope = terminalEnvelope(spec);
    const centre = S(6700);
    const terminal: HvacElement = {
      id: 'sad', type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
      width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
      label: 'SAD-1', supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
    };
    const lip = terminalSpigotPort(terminal)!;
    for (const section of [RECT, roundLeg(400)]) {
      const run = buildDuctRunDraftElement({
        port, points: [S(6000), { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - 100 }], legSizes: [section, roundLeg(200)],
        end: { kind: 'terminal', terminalId: 'sad', portId: lip.portId, flex: true },
      }, 'm');
      const element = ductRunElementWithSpec(run, { ...readDuctRunSpec(run)!, inline: [{ id: 'i1', kind: 'attenuator', legIndex: 0, stationMm: 3000, lengthMm: 900 }] });
      const plan = planOf(element, [unit, terminal, element]);
      const losses = ductRunPieceLosses(buildDuctFlowTree([plan], new Map([['sad', 600]])), 'm', 'supply')!;
      const index = plan.pieces.findIndex((piece) => piece.inlineId === 'i1');
      const zeta = section.diameterMm ? FITTING_LOSS_COEFFICIENTS.attenuatorPodded : FITTING_LOSS_COEFFICIENTS.attenuatorSplitter;
      expect(losses[index]!.fittingsPa).toBeCloseTo(zeta * velocityPressurePa(velocityMs(section, 600)), 6);
    }
  });

  it('are drawn: the plan symbols and labels, the 3D casing and door', () => {
    const element = main(ACCESSORIES);
    const plan = planOf(element);
    const presentation = buildDuctPlanPresentation(plan);
    expect(presentation.attenuators).toHaveLength(1);
    expect(presentation.attenuators[0]!.splitters).toHaveLength(2);
    expect(presentation.accessDoors).toEqual([expect.objectContaining({ below: true, label: 'AD 450×450' })]);
    expect(presentation.dampers.length).toBeGreaterThan(0);
    const markup = ductRunMarkup(presentation, { k: 1, showTags: true, showJointTicks: true, showMarks: false, showSupports: false });
    expect(markup).toContain('SA ');
    expect(markup).toContain('AD 450');
    const group = buildHvacElementMesh(element, { allElements: [unit, element], ductSettings: resolveDuctSettings({ showSupports: false }) })!;
    group.updateMatrixWorld(true);
    expect(group.getObjectByName('duct-door')).toBeTruthy();
    // The casing stands 50 mm proud of the duct (and its insulation's face is the duct's skin elsewhere).
    const accessories = new THREE.Box3().setFromObject(group.getObjectByName('duct-accessories')!);
    const attenuator = plan.pieces.find((piece) => piece.inlineId === 'i3')!;
    expect(accessories.max.z).toBeGreaterThanOrEqual(attenuator.centreZ + 150 + 50 - 0.5);
  });

  it('are listed and priced: the door in its framed section and the attenuator bought in', () => {
    const plan = planOf(main(ACCESSORIES));
    const rows = buildDuctBom([plan]);
    const accessories = rows.filter((row) => row.category === 'Accessories').map((row) => row.description);
    expect(accessories).toEqual(expect.arrayContaining([
      "Access door 450×450, double skin, insulated, cam locks, in the duct's bottom",
      'Sound attenuator 900 mm, rectangular splitter, casing 50 mm proud',
    ]));
    const fabricated = rows.filter((row) => row.category === 'Fabricated pieces').map((row) => row.description);
    expect(fabricated.some((description) => description.startsWith('Sound attenuator'))).toBe(false);
    expect(fabricated.some((description) => description.includes('framed opening for an access door'))).toBe(true);
    const cost = priceDuctPlans([plan], settings);
    const girth = 2 * (600 + 300);
    expect(cost.accessories).toBeCloseTo(settings.econAccessDoorEach + settings.econAttenuatorEach * (girth / (Math.PI * 200)), 6);
    expect(cost.total).toBeGreaterThan(priceDuctPlans([planOf(main([]))], settings).total);
  });
});

describe('the cards offer accessories', () => {
  it('a straight offers a damper, an access door and an attenuator; the edit takes the clear spot nearest its middle', () => {
    // A take-off at the leg's middle: the accessory is placed clear of it.
    const element = main([]);
    const origin = tapOrigin(element, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'spin-in', vcd: true }, roundLeg(200))!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const branch = buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + origin.direction.x * 800, y: origin.point.y + origin.direction.y * 800 }], legSizes: [roundLeg(200)] }, 'b');
    const scene = [unit, element, branch];
    const options = ductSegmentOptions(scene, settings, 'm', 'leg:0');
    const add = options.find((option) => option.id === 'inline:attenuator')!;
    expect(options.map((option) => option.id)).toEqual(expect.arrayContaining(['inline:damper', 'inline:access-door', 'inline:attenuator']));
    const result = applyDuctSegmentEdit(scene, settings, add.edit);
    expect(result.refused).toBeUndefined();
    const after = scene.map((candidate) => result.updates.find((update) => update.id === candidate.id) ?? candidate);
    const placed = readDuctRunSpec(after.find((candidate) => candidate.id === 'm')!)!.inline!;
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ id: 'i1', kind: 'attenuator', legIndex: 0, lengthMm: 900 });
    const plan = getDuctRunPlan(after.find((candidate) => candidate.id === 'm')!, after, settings)!;
    expect(clashes(plan)).toEqual([]);
    expect(plan.pieces.some((piece) => piece.inlineId === 'i1')).toBe(true);
    expect(result.notes.join(' ')).toMatch(/placed \d+ mm (on|back), clear of the fittings and take-offs/);
  });

  it("an accessory's card takes it out; an attenuator's offers its catalogue lengths", () => {
    const scene = [unit, main(ACCESSORIES)];
    const options = ductSegmentOptions(scene, settings, 'm', 'inline:i3');
    expect(options.map((option) => option.id)).toEqual(['attenuator:600', 'attenuator:900', 'attenuator:1200', 'attenuator:1500', 'inline:remove']);
    expect(options.find((option) => option.id === 'attenuator:900')?.current).toBe(true);
    const longer = applyDuctSegmentEdit(scene, settings, options.find((option) => option.id === 'attenuator:1200')!.edit);
    expect(readDuctRunSpec(longer.updates[0]!)!.inline!.find((item) => item.id === 'i3')!.lengthMm).toBe(1200);
    const removed = applyDuctSegmentEdit(scene, settings, options.find((option) => option.id === 'inline:remove')!.edit);
    expect(readDuctRunSpec(removed.updates[0]!)!.inline!.map((item) => item.id)).toEqual(['i1', 'i2']);
    expect(removed.action).toBe('Sound attenuator removed');
    // A damper's card: its removal, not the take-off damper's.
    expect(ductSegmentOptions(scene, settings, 'm', 'inline:i1').map((option) => option.id)).toEqual(['inline:remove']);
  });
});
