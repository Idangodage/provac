/**
 * A duct run that crosses itself is a clash: its pieces against its own
 * pieces further along (not the piece each is joined to). On the canvas for
 * drawn runs, and in Auto duct's verification (where it steers the router).
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctRunDraftElement } from './ductDraft';
import { DEFAULT_DUCT_SETTINGS } from './ductSettings';
import { validateDuctRuns } from './ductValidation';
import { clashMessage, findDuctClashes } from './ductVolumes';

const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const bottom = port.lip.z - port.heightMm / 2;

/** A 250 × 250 run off the supply collar through `points` ([along, across] from the collar, mm), ending capped. */
function run(id: string, points: Array<[number, number]>, size = 250): HvacElement {
  return buildDuctRunDraftElement({
    port, points: points.map(([along, across]) => ({ x: port.lip.x + across, y: port.lip.y - along, z: bottom })),
    legSizes: [{ widthMm: size, heightMm: size }], end: 'end-cap',
  }, id);
}
const selfClashes = (element: HvacElement) => findDuctClashes([unit, element], DEFAULT_DUCT_SETTINGS, []).filter((clash) => clash.kind === 'self');

describe('a run that crosses itself', () => {
  it('doubling back over itself (the return leg closer than the duct is wide) is a clash, named piece by piece', () => {
    const element = run('back', [[2500, 0], [2500, 200], [900, 200]]);
    const [clash] = selfClashes(element);
    expect(clash).toMatchObject({ ductId: 'back', otherId: 'back', kind: 'self' });
    expect(clash!.otherMark).toMatch(/^[A-Z]-\d+/);
    expect(clashMessage(clash!)).toBe(`${clash!.mark} crosses ${clash!.otherMark} of its own run.`);
  });

  it('crossing its own straight further back is a clash', () => {
    expect(selfClashes(run('loop', [[2500, 0], [2500, 1200], [1500, 1200], [1500, -1000]]))).toHaveLength(1);
  });

  it('an offset, two elbows back to back, and a U-turn with room between its legs keep clear of themselves', () => {
    expect(selfClashes(run('offset', [[1200, 0], [1700, 500], [3200, 500]]))).toEqual([]);
    expect(selfClashes(run('s-bend', [[1500, 0], [1500, 700], [3000, 700]]))).toEqual([]);
    expect(selfClashes(run('u-turn', [[2500, 0], [2500, 1500], [900, 1500]]))).toEqual([]);
  });

  it('on the canvas: the check names both pieces and says how to clear it', () => {
    const element = run('drawn', [[2500, 0], [2500, 1200], [1500, 1200], [1500, -1000]]);
    const issue = validateDuctRuns([unit, element], DEFAULT_DUCT_SETTINGS).issues.find((entry) => entry.id === 'DU_CLASH:drawn:self');
    expect(issue).toMatchObject({ level: 'error', code: 'DU_CLASH', entityId: 'drawn' });
    expect(issue!.message).toMatch(/: [A-Z]-\d+ crosses [A-Z]-\d+ of the same run at \(-?\d+, -?\d+, z \d+\)\.$/);
    expect(issue!.suggestedFix).toMatch(/does not double back over itself/);
  });
});
