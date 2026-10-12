import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import type { SegmentFocus } from '../segments/segmentUiStore';

import { createDuctSegmentProvider } from './DuctSegmentCard';
import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { ductSegmentOptions, evaluateDuctSegmentOption } from './ductSegmentOptions';
import { ductSegments, neighbourSegment } from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { defaultSizingBasis, linkSizingBasis } from './ductSystemSizing';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });

function diffuser(id: string, centre: Point2D): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: null };
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 270,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

/** A 600×300 main, 3 m then a turn and 2.5 m on, with two round take-offs to diffusers; sized for 900 m³/h. */
function system(): HvacElement[] {
  let main = buildDuctRunDraftElement({ port, points: [S(3000), S(3000, 2500)], legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }] }, 'main');
  main = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, sizing: linkSizingBasis({ ...defaultSizingBasis(settings, 'supply', null), airflowM3h: 900 }, 900) });
  const terminals = [diffuser('d1', S(1700, 1500)), diffuser('d2', S(3000 + 1500, 1500))];
  const branches = [
    { id: 'b1', legIndex: 0, station: 1700, terminal: terminals[0]! },
    { id: 'b2', legIndex: 1, station: 1500, terminal: terminals[1]! },
  ].map(({ id, legIndex, station, terminal }) => {
    const round = roundLeg(200);
    const origin = tapOrigin(main, settings, { legIndex, stationMm: station, side: legIndex === 0 ? -1 : 1, style: 'spin-in', vcd: true }, round)!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const lip = terminalSpigotPort(terminal)!;
    return buildDuctRunDraftElement({
      origin, points: [{ x: origin.point.x + origin.direction.x * 400, y: origin.point.y + origin.direction.y * 400 }, { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - lip.heightMm / 2 }],
      legSizes: [round, round], end: { kind: 'terminal', terminalId: terminal.id, portId: lip.portId, flex: true },
    }, id);
  });
  return [unit, ...terminals, main, ...branches];
}

const focusOn = (runId: string, key: string): SegmentFocus => ({ runId, key, anchorMark: null, view: '2d' });

describe('the duct segment provider (the shared card reads ducts through it)', () => {
  const scene = system();
  const provider = createDuctSegmentProvider(settings);
  const plan = getDuctRunPlan(scene.find((element) => element.id === 'main')!, scene, settings)!;
  const segmentOf = (key: string) => ductSegments(plan).find((segment) => segment.key === key)!;

  it('heads a segment with what it is, its size and its marks, in its service colour', () => {
    const model = provider.model(scene, focusOn('main', 'leg:0'))!;
    const segment = segmentOf('leg:0');
    expect(provider.domain).toBe('duct');
    expect(provider.testIdPrefix).toBe('duct-segment');
    expect(model.head).toMatchObject({ title: segment.title, size: segment.size, detail: segment.detail, kind: segment.kind, tone: 'bg-blue-50 text-blue-600' });
    expect(model.head.tag).toBe(segment.marks.length > 1 ? `${segment.marks[0]}…${segment.marks[segment.marks.length - 1]}` : segment.marks[0]);
  });

  it('offers the duct engine\'s options, evaluated by it', () => {
    const model = provider.model(scene, focusOn('main', 'leg:0'))!;
    expect(model.options.map((option) => option.id)).toEqual(ductSegmentOptions(scene, settings, 'main', 'leg:0').map((option) => option.id));
    const option = model.options.find((candidate) => !candidate.current && !candidate.disabledReason)!;
    expect(model.evaluate(option)).toBe(evaluateDuctSegmentOption(scene, settings, 'main', 'leg:0', option));
  });

  it('lists sizes, swaps and terminal faces under Swap, accessories under Add, and tuning only in Edit', () => {
    for (const [runId, key] of [['main', 'leg:0'], ['main', 'node:1'], ['b1', 'end:flex']] as const) {
      const model = provider.model(scene, focusOn(runId, key))!;
      for (const option of model.options) {
        const expected = option.group === 'size' || option.group === 'swap' || option.id.startsWith('face:') ? 'swap' : option.group === 'accessory' ? 'add' : null;
        expect(model.tabOf(option)).toBe(expected);
      }
    }
    // A runout to a terminal: its necks are the Edit tab's quick picks, its faces are swaps.
    const runout = provider.model(scene, focusOn('b1', 'end:flex'))!;
    expect(runout.options.filter((option) => option.id.startsWith('neck:')).map((option) => runout.tabOf(option))).toContain(null);
    expect(runout.options.filter((option) => option.id.startsWith('face:')).every((option) => runout.tabOf(option) === 'swap')).toBe(true);
    expect(runout.options.some((option) => option.id.startsWith('face:'))).toBe(true);
  });

  it('reads a segment once per drawing, whichever part of it or view the focus came from', () => {
    const focus = focusOn('main', 'leg:0');
    expect(provider.model(scene, focus)).toBe(provider.model(scene, { ...focus, anchorMark: 'x', view: '3d' }));
    expect(provider.model([...scene], focus)).not.toBe(provider.model(scene, focus));
  });

  it('steps along the run to the neighbouring segments', () => {
    const model = provider.model(scene, focusOn('main', 'node:1'))!;
    for (const direction of [-1, 1] as const) {
      const next = neighbourSegment(plan, 'node:1', direction)!;
      expect(model.neighbour(direction)).toEqual({ key: next.key, anchorMark: next.marks[0] ?? null });
    }
  });

  it('keeps its segment after an edit, else the leg it was on, else closes', () => {
    const focus = focusOn('main', 'leg:0');
    expect(provider.rekey(scene, focus, provider.model(scene, focus)!.rekeyToken)).toBe(focus);
    const gone = focusOn('main', 'gone:0');
    const back = provider.rekey(scene, gone, { legIndex: 1 })!;
    expect(back).toMatchObject({ runId: 'main', key: 'leg:1', anchorMark: segmentOf('leg:1').marks[0] ?? null, view: '2d' });
    expect(provider.rekey(scene, gone, { legIndex: 9 })).toBeNull();
  });

  it('shows no card for a segment or a run that is gone', () => {
    expect(provider.model(scene, focusOn('main', 'gone:0'))).toBeNull();
    expect(provider.model(scene, focusOn('nope', 'leg:0'))).toBeNull();
  });
});
