import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { jogOffset } from './ductOffsets';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const at = (offsets: Point2D[]) => {
  let cursor = { x: supply.lip.x, y: supply.lip.y };
  return offsets.map((offset) => (cursor = { x: cursor.x + offset.x, y: cursor.y + offset.y }));
};
const planOf = (points: Point2D[]) => {
  const element = buildDuctRunDraftElement({ port: supply, points }, 'r');
  return planDuctRun(element, { settings, scene: [unit, element] })!;
};

describe('offsets (SMACNA Fig. 2-7)', () => {
  it('a short 45° jog becomes one mitred offset (Type 2) with the drawn geometry', () => {
    // Down 3000, then 45° across 300 mm (a 424 mm diagonal), then down again.
    const plan = planOf(at([{ x: 0, y: -3000 }, { x: 300, y: -300 }, { x: 0, y: -3000 }]));
    const offsets = plan.pieces.filter((piece) => piece.kind === 'offset');
    expect(offsets).toHaveLength(1);
    expect(plan.pieces.some((piece) => piece.kind === 'elbow')).toBe(false);
    const offset = offsets[0]!.offset!;
    expect(offset.type).toBe('mitered');
    expect(offset.angleDeg).toBeCloseTo(45, 6);
    expect(offset.lateralOffsetMm).toBeCloseTo(300, 6);
    expect(plan.status).toBe('ok');
    const consumed = plan.pieces.reduce((total, piece) => total + (piece.stationEndMm - piece.stationStartMm), 0);
    expect(consumed).toBeCloseTo(plan.polylineLengthMm, 6);
  });

  it('a long 45° jog keeps its two 45° elbows', () => {
    const plan = planOf(at([{ x: 0, y: -3000 }, { x: 2000, y: -2000 }, { x: 0, y: -3000 }]));
    expect(plan.pieces.filter((piece) => piece.kind === 'elbow')).toHaveLength(2);
    expect(plan.pieces.some((piece) => piece.kind === 'offset')).toBe(false);
  });

  it('a 90° Z too tight for two elbows becomes an ogee with a 150 mm throat or more (Type 3)', () => {
    // A 300 mm sideways step: two square vaned elbows need 674 + 2 × 50 of middle leg.
    const plan = planOf(at([{ x: 0, y: -3000 }, { x: 300, y: 0 }, { x: 0, y: -3000 }]));
    const piece = plan.pieces.find((candidate) => candidate.kind === 'offset')!;
    expect(piece.offset!.type).toBe('ogee');
    expect(piece.offset!.throatRadiusMm).toBeGreaterThanOrEqual(150);
    expect(piece.offset!.lateralOffsetMm).toBeCloseTo(300, 6);
    expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    // The S is continuous: its centreline starts on the incoming line and ends on the outgoing one.
    const line = piece.offset!.centreline;
    expect(line[0]!.x).toBeCloseTo(supply.lip.x, 6);
    expect(line.at(-1)!.x).toBeCloseTo(supply.lip.x + 300, 6);
    const consumed = plan.pieces.reduce((total, candidate) => total + (candidate.stationEndMm - candidate.stationStartMm), 0);
    expect(consumed).toBeCloseTo(plan.polylineLengthMm, 6);
  });

  it('draws, schedules and outlines the offset', () => {
    const plan = planOf(at([{ x: 0, y: -3000 }, { x: 300, y: 0 }, { x: 0, y: -3000 }]));
    const presentation = buildDuctPlanPresentation(plan);
    expect(presentation.piecePolygons.some((polygon) => polygon.kind === 'offset')).toBe(true);
    expect(buildDuctBom([plan]).some((row) => row.description.startsWith('Offset, ogee'))).toBe(true);
  });

  it('geometry: an ogee needs no more than 90° per arc, otherwise it is two elbows', () => {
    expect(jogOffset({ x: 0, y: 0 }, { x: 0, y: 5000 }, { x: 1, y: 0 }, 400, 50, 600)).toBeNull();
    const ogee = jogOffset({ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 1, y: 0 }, 400, 50, 600)!;
    expect(ogee.type).toBe('ogee');
    expect(ogee.angleDeg).toBeLessThan(90);
  });
});
