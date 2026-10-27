// The field pair at a unit's maker stubs (27 October 2026): it starts on the stubs, leaves along them, and its gas and
// liquid insulation never run into each other near the unit — drawn in any direction, or laid by Auto route, at any
// turn of the unit. Where the two ends hold gas and liquid on opposite sides, the lines swap where they already pass
// each other clear in height (the outdoor unit), not at an indoor unit's close-set stubs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../types';

import { resolveCondensateSettings } from './condensate/condensateSettings';
import { getActiveDuctSettings, resolveDuctSettings, setActiveDuctSettings } from './duct/ductSettings';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { insulatedLineFromUnit, insulationGapNearUnit, refrigerantLineNodes3d } from './refrigerantInsulationClearance';
import { buildRefrigerantPipeElements, getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';
import { planUnifiedAutoRoute } from './unifiedAutoRoute';

const originalRouting = getActivePipeRoutingSettings();
const originalDucts = getActiveDuctSettings();
const routing = { ...DEFAULT_PIPE_ROUTING_SETTINGS, ceilingLimitMm: 3300 };
const ducts = resolveDuctSettings({ soffitMm: 3300 });

beforeEach(() => { setActivePipeRoutingSettings(routing); setActiveDuctSettings(ducts); });
afterEach(() => { setActivePipeRoutingSettings(originalRouting); setActiveDuctSettings(originalDucts); });

/** A library unit with its centre at `centre`, turned `rotation`, its underside at 2400. */
function unit(definitionId: string, rotation = 0, centre: Point2D = { x: 3542, y: 3148.5 }): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id: 'indoor', type: definition.type, category: 'indoor-unit', rotation,
    position: { x: centre.x - definition.widthMm / 2, y: centre.y - definition.depthMm / 2 },
    width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, elevation: 2400,
    mountType: 'ceiling', label: 'Indoor', supplyZoneRatio: 0.5, properties: { ...(definition.defaultProperties ?? {}) },
  } as HvacElement;
}

function outdoorUnit(): HvacElement {
  const outdoor: HvacElement = {
    id: 'outdoor', type: 'outdoor-unit', category: 'outdoor-unit', position: { x: 8800, y: 4500 },
    rotation: 180, width: 900, depth: 450, height: 1200, elevation: 0, mountType: 'floor',
    label: 'Outdoor unit', supplyZoneRatio: 0, properties: {},
  };
  outdoor.elevation += 1437 - getRefrigerantPipeBundleSnapTargets([outdoor])[0]!.gasElevationMm;
  return outdoor;
}

const MAKER_UNITS = ['vrf-fdt28kxze1', 'vrf-fdum22kxe6f-w', 'vrf-fdum140kxe6f', 'vrf-fdu224kxze1'];
const MIN_GAP_MM = 2;

describe('a pair drawn from the maker stubs', () => {
  it('starts on the stubs, leaves along them and keeps its insulation apart, in every direction', () => {
    for (const id of MAKER_UNITS) {
      const indoor = unit(id);
      const target = getRefrigerantPipeBundleSnapTargets([indoor]).find((entry) => entry.connectionKind === 'unit-port')!;
      const d = target.direction; const n = { x: -d.y, y: d.x };
      const at = (along: number, across: number): Point2D => ({ x: target.point.x + d.x * along + n.x * across, y: target.point.y + d.y * along + n.y * across });
      const routes: Record<string, Point2D[]> = {
        straight: [at(0, 0), at(2000, 0)],
        left: [at(0, 0), at(700, 0), at(700, 1500)],
        right: [at(0, 0), at(700, 0), at(700, -1500)],
        back: [at(0, 0), at(700, 0), at(700, 900), at(-1500, 900)],
      };
      for (const [name, route] of Object.entries(routes)) {
        const label = `${id} ${name}`;
        const pipes = buildRefrigerantPipeElements(route, {
          startBundleConnection: target,
          gasPipeDiameterMm: indoor.properties.refrigerantGasPipeDiameterMm as number | undefined,
          liquidPipeDiameterMm: indoor.properties.refrigerantLiquidPipeDiameterMm as number | undefined,
        }).map((element, index) => ({ ...element, id: `pipe-${index}` }) as HvacElement);
        const scene = [indoor, ...pipes];
        for (const pipe of pipes) {
          const gas = pipe.properties.lineKind === 'gas';
          const nodes = refrigerantLineNodes3d(pipe, scene);
          const stub = gas ? target.gasPoint : target.liquidPoint;
          expect(nodes[0]!.x, label).toBeCloseTo(stub.x, 3);
          expect(nodes[0]!.y, label).toBeCloseTo(stub.y, 3);
          expect(nodes[0]!.z, label).toBeCloseTo(gas ? target.gasElevationMm : target.liquidElevationMm, 3);
          // The first leg runs out along the stub.
          const leg = { x: nodes[1]!.x - nodes[0]!.x, y: nodes[1]!.y - nodes[0]!.y };
          const length = Math.hypot(leg.x, leg.y);
          expect(length, label).toBeGreaterThan(1);
          expect((leg.x * d.x + leg.y * d.y) / length, label).toBeCloseTo(1, 6);
        }
        const gasLine = insulatedLineFromUnit(pipes.find((pipe) => pipe.properties.lineKind === 'gas')!, indoor.id, scene)!;
        const liquidLine = insulatedLineFromUnit(pipes.find((pipe) => pipe.properties.lineKind === 'liquid')!, indoor.id, scene)!;
        expect(insulationGapNearUnit(gasLine, liquidLine).gapMm, label).toBeGreaterThanOrEqual(MIN_GAP_MM);
      }
    }
  });

  it('swaps gas and liquid at the outdoor unit, where they pass clear in height, not at the indoor stubs', () => {
    const indoor = unit('vrf-fdum140kxe6f');
    const outdoor = outdoorUnit();
    const ports = getRefrigerantPipeBundleSnapTargets([indoor, outdoor]);
    const inPort = ports.find((port) => port.sourceElementId === indoor.id && port.connectionKind === 'unit-port')!;
    const outPort = ports.find((port) => port.sourceElementId === outdoor.id && port.connectionKind === 'unit-port')!;
    const route = [outPort.point, { x: outPort.point.x - 600, y: outPort.point.y }, { x: outPort.point.x - 600, y: inPort.point.y }, inPort.point];
    const pipes = buildRefrigerantPipeElements(route, { startBundleConnection: outPort, endBundleConnection: inPort })
      .map((element, index) => ({ ...element, id: `pipe-${index}` }) as HvacElement);
    const scene = [indoor, outdoor, ...pipes];
    const gas = insulatedLineFromUnit(pipes.find((pipe) => pipe.properties.lineKind === 'gas')!, indoor.id, scene)!;
    const liquid = insulatedLineFromUnit(pipes.find((pipe) => pipe.properties.lineKind === 'liquid')!, indoor.id, scene)!;
    // Near the indoor unit the lines keep the stubs' order (gas on the −y side) along their first metre.
    const across = (nodes: readonly { y: number }[]) => nodes.slice(0, 4).map((node) => node.y);
    for (let index = 0; index < 4; index += 1) expect(across(gas.nodes)[index]!).toBeLessThan(across(liquid.nodes)[index]!);
    expect(insulationGapNearUnit(gas, liquid).gapMm).toBeGreaterThanOrEqual(MIN_GAP_MM);
  });
});

describe('Auto route at the maker stubs', () => {
  for (const id of ['vrf-fdum140kxe6f', 'vrf-fdu224kxze1', 'vrf-fdt28kxze1']) {
    for (const rotation of [0, 180]) {
      it(`connects ${id} turned ${rotation}° with its insulation apart`, async () => {
        const indoor = unit(id, rotation);
        const scene = [indoor, outdoorUnit()];
        const result = await planUnifiedAutoRoute(scene, {
          services: { gas: true, liquid: true, condensate: false, supplyDuct: false, returnDuct: false },
          refrigerant: { settings: routing, objective: 'balanced' }, condensate: { settings: resolveCondensateSettings({ soffitMm: 3300 }) },
          duct: { settings: ducts, shape: 'rect', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing' },
        });
        expect(result.refrigerant?.complete, result.issues.join('\n')).toBe(true);
        const added = result.refrigerant!.elementsToAdd as HvacElement[];
        const all = [...scene, ...added];
        const line = (kind: string) => insulatedLineFromUnit(added.find((element) => element.properties.lineKind === kind
          && insulatedLineFromUnit(element, indoor.id, all))!, indoor.id, all)!;
        expect(insulationGapNearUnit(line('gas'), line('liquid')).gapMm).toBeGreaterThanOrEqual(MIN_GAP_MM);
      }, 120000);
    }
  }
});
