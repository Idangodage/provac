import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { cardinal, dirToLocal, spigotVariants, toLocal, type Frame, type ServiceCtx, type TerminalCtx } from './ductAutoContext';
import { tapOrigin } from './ductBranchTargets';
import { legNormal } from './ductBranches';
import { buildDuctRunDraft, buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { flexInletBendLossPa, flexBendLossPa } from './ductPressure';
import { resolveDuctSettings } from './ductSettings';
import { sideFacing, terminalApproach, terminalFeed, terminalInletTurnable } from './ductTerminalApproach';
import type { DuctTerminalSpigotSide } from './ductTerminalCatalog';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctPoint3 } from './ductTypes';
import { verifyRuns } from './optimizer/ductOptimizer';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const n = port.normal;
const t = legNormal(n);
/** A plan point `along` out from the supply collar and `across` beside it. */
const at = (along: number, across = 0): Point2D => ({ x: port.lip.x + n.x * along + t.x * across, y: port.lip.y + n.y * along + t.y * across });

/** A square Ø200 diffuser centred at `centre`, its inlet on `side` (or on top). */
function diffuser(side: DuctTerminalSpigotSide | 'top', centre = at(3000), extra: Record<string, unknown> = {}, kind: 'square-4way' | 'linear-slot' = 'square-4way'): HvacElement {
  const spec = { ...typicalTerminalSpec(kind, 200), ...(side === 'top' ? { spigotEntry: 'top' as const } : { spigotSide: side }) };
  const envelope = terminalEnvelope(spec);
  return {
    id: 'd1', type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: 'SAD-1', supplyZoneRatio: 0.5, properties: { terminal: spec, ...extra },
  };
}
const SIDES: DuctTerminalSpigotSide[] = ['back', 'front', 'left', 'right'];
/** The side of the diffuser at `at(3000)` whose inlet faces the collar, and the one facing away. */
const sideToward = SIDES.find((side) => {
  const spigot = terminalSpigotPort(diffuser(side))!;
  return spigot.normal.x * -n.x + spigot.normal.y * -n.y > 0.5;
})!;
const sideAway = SIDES.find((side) => {
  const spigot = terminalSpigotPort(diffuser(side))!;
  return spigot.normal.x * n.x + spigot.normal.y * n.y > 0.5;
})!;

/** A run off the supply collar, rigid to 1.5 m out, then its flexible runout into the terminal. */
function runTo(terminal: HvacElement): HvacElement {
  const lip = terminalSpigotPort(terminal)!.lip;
  return buildDuctRunDraftElement({
    port, points: [at(1500), { x: lip.x, y: lip.y, z: lip.z - 100 }], legSizes: [{ widthMm: 400, heightMm: 250 }, roundLeg(200)],
    end: { kind: 'terminal', terminalId: terminal.id, portId: 'spigot', flex: true },
  }, 'run');
}
const approachIssues = (terminal: HvacElement) => {
  const run = runTo(terminal);
  return getDuctRunPlan(run, [unit, terminal, run], settings)!.issues.filter((issue) => issue.code === 'DU_TERMINAL_APPROACH');
};

describe('how a duct comes at the terminal it serves', () => {
  it('measures the feed against the inlet\'s face, and a duct that passes the inlet\'s axis', () => {
    const inlet = { lip: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0 }, widthMm: 200, diameterMm: 200 };
    expect(terminalApproach(inlet, { x: 500, y: 300 }, [])!.behindMm).toBeCloseTo(-500);
    expect(terminalApproach(inlet, { x: -200, y: 0 }, [])!.behindMm).toBeCloseTo(200);
    // Fed from +y: a duct that stays on that side does not pass; one that crosses 400 mm beyond the axis does.
    const stays = terminalApproach(inlet, { x: 800, y: 600 }, [{ x: 800, y: 600 }, { x: 800, y: 0 }, { x: 0, y: 0 }])!;
    expect(stays.passMm).toBe(0);
    const passes = terminalApproach(inlet, { x: 800, y: 600 }, [{ x: 800, y: 600 }, { x: 800, y: -400 }, { x: 300, y: -400 }, { x: 0, y: 0 }])!;
    expect(passes.passMm).toBeCloseTo(400);
    expect(passes.passAt).toEqual({ x: 800, y: -400 });
    // A top collar takes its runout from any side.
    expect(terminalApproach({ ...inlet, vertical: true }, { x: -900, y: 0 }, [])).toBeNull();
  });

  it('takes the feed where the terminal\'s own duct leaves shared duct: a branch\'s start, a main\'s last take-off, else the collar', () => {
    const main = buildDuctRunDraftElement({ port, points: [at(4000)], legSizes: [{ widthMm: 400, heightMm: 250 }], end: 'end-cap' }, 'main');
    expect(terminalFeed('main', readDuctRunSpec(main)!, [main])!.feed).toEqual({ x: port.lip.x, y: port.lip.y });
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 1200, side: 1, style: 'spin-in', vcd: true }, roundLeg(200));
    expect(origin && origin.kind === 'tap').toBe(true);
    const from = origin as Extract<NonNullable<typeof origin>, { kind: 'tap' }>;
    const branch = buildDuctRunDraft({
      origin: from, points: [{ x: from.point.x + from.direction.x * 1000, y: from.point.y + from.direction.y * 1000, z: from.bottomZ }],
      legSizes: [roundLeg(200)], end: 'end-cap',
    }, 'branch', [main]).element;
    const scene = [main, branch];
    const fed = terminalFeed('main', readDuctRunSpec(main)!, scene)!;
    expect(fed.feed.x).toBeCloseTo(at(1200).x, 3);
    expect(fed.feed.y).toBeCloseTo(at(1200).y, 3);
    expect(fed.points[0]).toEqual(fed.feed);
    const own = terminalFeed('branch', readDuctRunSpec(branch)!, scene)!;
    expect(own.feed).toEqual({ x: from.point.x, y: from.point.y });
  });

  it('a duct fed from in front of the inlet is fine; from behind, the planner says so and which side faces it', () => {
    expect(approachIssues(diffuser(sideToward))).toEqual([]);
    const issues = approachIssues(diffuser(sideAway));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.message).toMatch(new RegExp(`^SAD-1 is fed from behind its inlet: its duct leaves \\d+ mm behind the inlet's face and goes round the box\\. Turn its inlet to the ${sideToward} side`));
    expect(sideFacing(diffuser(sideAway), { x: port.lip.x, y: port.lip.y })).toBe(sideToward);
  });

  it('a side set by hand, or a face that cannot turn, gets advice it can follow; a top collar is not judged', () => {
    const byHand = approachIssues(diffuser(sideAway, at(3000), { spigotSideSetBy: 'user' }));
    expect(byHand[0]?.message).toMatch(new RegExp(`Its spigot side is set by hand; the ${sideToward} side faces the duct\\.$`));
    expect(terminalInletTurnable(diffuser(sideAway, at(3000), { spigotSideSetBy: 'user' }))).toBe(false);
    const slot = approachIssues(diffuser(sideAway, at(3000), {}, 'linear-slot'));
    expect(slot[0]?.message).toMatch(/Take the duct off in front of its inlet\.$/);
    expect(approachIssues(diffuser('top'))).toEqual([]);
  });

  it('in an Auto design, an inlet that could have turned makes it an error; one fixed by hand stays a warning', () => {
    const frame: Frame = { origin: { x: port.lip.x, y: port.lip.y }, n, t };
    const contextFor = (terminal: HvacElement): ServiceCtx => {
      const spigot = terminalSpigotPort(terminal)!;
      const placed: TerminalCtx = {
        element: terminal, spec: readDuctTerminalSpec(terminal)!, port: spigot, lip: toLocal(frame, spigot.lip), normal: cardinal(dirToLocal(frame, spigot.normal)),
        airflowM3h: 300, fixed: false, neck: 200, branch: 200,
      };
      placed.variants = spigotVariants(frame, placed, true);
      return {
        service: 'supply', unitId: 'u', frame, port, bottomZ: port.lip.z - port.heightMm / 2, terminals: [placed], airflowM3h: 300,
        baseScene: [unit, terminal], settings, obstacles: [], maxHeightMm: 500, construction: settings.defaultConstruction, ids: () => 'x',
      };
    };
    const turnable = diffuser(sideAway);
    const verified = verifyRuns(contextFor(turnable), [runTo(turnable)]);
    expect(verified.issues.filter((issue) => issue.code === 'DU_TERMINAL_APPROACH').map((issue) => issue.severity)).toEqual(['error']);
    const fixed = diffuser(sideAway, at(3000), { spigotSideSetBy: 'user' });
    const kept = verifyRuns(contextFor(fixed), [runTo(fixed)]);
    expect(kept.issues.filter((issue) => issue.code === 'DU_TERMINAL_APPROACH').map((issue) => issue.severity)).toEqual(['warning']);
  });
});

describe('the price of turning into an inlet (router only)', () => {
  /** A straight of `before` mm along +x, a quarter circle of radius 300 to +y, then `after` mm straight. */
  const runout = (before: number, after: number): DuctPoint3[] => {
    const points: DuctPoint3[] = [];
    for (let x = 0; x <= before; x += 50) points.push({ x, y: 0, z: 0 });
    for (let k = 1; k <= 18; k += 1) {
      const angle = (k / 18) * (Math.PI / 2);
      points.push({ x: before + 300 * Math.sin(angle), y: 300 - 300 * Math.cos(angle), z: 0 });
    }
    for (let y = 350; y <= 300 + after; y += 50) points.push({ x: before + 300, y, z: 0 });
    return points;
  };

  it('counts a bend ending within three diameters of the inlet, not one further back', () => {
    const into = runout(1000, 100);
    expect(flexInletBendLossPa(into, 200, 300)).toBeCloseTo(flexBendLossPa(into, 200, 300), 6);
    expect(flexInletBendLossPa(into, 200, 300)).toBeGreaterThan(0.5);
    const early = runout(100, 1200);
    expect(flexBendLossPa(early, 200, 300)).toBeGreaterThan(0.5);
    expect(flexInletBendLossPa(early, 200, 300)).toBe(0);
    const straight = runout(1000, -400).slice(0, 21);
    expect(flexInletBendLossPa(straight, 200, 300)).toBe(0);
  });
});
