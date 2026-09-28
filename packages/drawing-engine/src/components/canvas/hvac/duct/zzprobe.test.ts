import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct, type AutoDuctRequest, type AutoDuctResult } from './ductAutoLayout';
import { legNormal } from './ductBranches';
import { buildDuctRunDraftElement } from './ductDraft';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, typicalTerminalSpec, type DuctTerminalKind } from './ductTerminals';
import { readDuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({ soffitMm: 3000 });

function fdum(rotation = 0, properties: Record<string, unknown> = {}): HvacElement {
  return {
    id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation, width: 1084, depth: 697, height: 300,
    elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
    properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb', ...properties },
  };
}

type Frame = { n: Point2D; t: Point2D; lip: Point2D };
function frames(unit: HvacElement): { supply: Frame; ret: Frame } {
  const ports = resolveUnitAirPorts(unit);
  const of = (kind: 'supply' | 'return') => {
    const port = ports.find((candidate) => candidate.kind === kind)!;
    return { n: port.normal, t: legNormal(port.normal), lip: { x: port.lip.x, y: port.lip.y } };
  };
  return { supply: of('supply'), ret: of('return') };
}
const at = (frame: Frame, along: number, across: number): Point2D => ({
  x: frame.lip.x + frame.n.x * along + frame.t.x * across,
  y: frame.lip.y + frame.n.y * along + frame.t.y * across,
});
const minus = (v: Point2D): Point2D => ({ x: -v.x, y: -v.y });

/** A terminal centred at `centre`, its spigot facing `facing` (world). */
function terminal(id: string, centre: Point2D, facing: Point2D, kind: DuctTerminalKind = 'square-4way', neck = 200): HvacElement {
  const spec = typicalTerminalSpec(kind, neck);
  const envelope = terminalEnvelope(spec);
  const rotation = (((Math.atan2(facing.x, -facing.y) * 180) / Math.PI) + 360) % 360;
  return {
    id, type: spec.service === 'return' ? 'return-grille' : 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    rotation, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}

const request = (terminalIds: string[], overrides: Partial<AutoDuctRequest> = {}): AutoDuctRequest => ({
  unitId: 'fdum', terminalIds, fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: true }, rebuildExisting: false, ...overrides,
});

const errorsOf = (result: AutoDuctResult) => [...result.issues, ...result.services.flatMap((service) => service.issues)].filter((issue) => issue.severity === 'error');

/** Every terminal served by a run ending on it in a flexible runout of at most 1.5 m. */
function expectServed(result: AutoDuctResult, ids: string[]): void {
  const plans = result.services.flatMap((service) => service.plans);
  for (const id of ids) {
    const plan = plans.find((candidate) => candidate.spec.end.kind === 'terminal' && candidate.spec.end.terminalId === id);
    expect(plan, id).toBeDefined();
    const flex = plan!.pieces.find((piece) => piece.kind === 'flex');
    expect(flex, id).toBeDefined();
    expect(flex!.lengthMm).toBeLessThanOrEqual(settings.flexMaxLengthMm);
    expect(plan!.pieces.map((piece) => piece.kind).slice(0, 2)).toEqual(['takeoff', 'damper']);
  }
}


describe('probe', () => {
  it('prints', () => {
    const unit = fdum();
    const { supply } = frames(unit);
    const terms = [-3750, -2250, -750, 750, 2250, 3750].map((across, index) => terminal(`r${index + 1}`, at(supply, 3000, across), minus(supply.n)));
    const result = generateAutoDuct([unit, ...terms], request(terms.map((e) => e.id), { shape: 'rect' }), settings);
    for (const design of result.designs) {
      console.log(design.label, JSON.stringify(Object.fromEntries(Object.entries(design.cost).map(([k, v]) => [k, Math.round(v)]))));
      for (const s of design.services) for (const plan of s.plans) {
        console.log('   ', plan.elementId.slice(-3), plan.joints.length + 'j', plan.pieces.map((p) => `${p.kind}${p.split ? '(' + p.split.style + ')' : ''}:${p.diameterMm !== undefined ? 'D' + p.diameterMm : p.widthMm + 'x' + p.heightMm}:${Math.round(p.lengthMm)}:${p.sheetAreaM2.toFixed(2)}`).join(' '));
      }
    }
  });
});
