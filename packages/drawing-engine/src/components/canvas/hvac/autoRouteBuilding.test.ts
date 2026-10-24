/**
 * The user's building (screenshots of 23 October 2026), through the app's own
 * Auto route: an FDU224KXZE1 in the top hall, FDUM140KXE6Fs bottom left and in
 * the middle room, four FDT28KXZE1 cassettes in the east wing, an FDC280KXZE1
 * outside and one floor gully. Walls, rooms and every position were measured
 * off the plan (43.457 mm per pixel).
 *
 * "As drawn" is the screenshot: the FDU224 turned away from its terminals, too
 * few terminals, no drain pump on the FDU224. "Put right" is the same building
 * after the fixes Auto route offers: the FDU224 turned 180°, six + five Ø300
 * terminals on it and three + three on each FDUM140, its drain pump fitted.
 *
 * Minutes of routing, so it runs only on request (with the duct benchmark):
 * `AUTO_ROUTE_BUILDING=1 npx vitest run src/components/canvas/hvac/autoRouteBuilding.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { useSmartDrawingStore } from '../../../store';
import type { HvacElement } from '../../../types';
import { isPointInPolygon } from '../../../utils/geometry';

import { drawUsersBuilding, USERS_BUILDING_IDS } from './__fixtures__/usersBuilding';
import { applyAutoRoutePreview, runAutoRoute } from './autoRouteController';
import { useCondensatePreviewStore } from './condensate/condensatePreviewStore';
import { applyDuctProposal } from './duct/ductAutoRoute';
import { readDuctTerminalSpec } from './duct/ductTerminals';
import { proposeTerminals } from './duct/ductUnitAdvice';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

const ENABLED = Boolean((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AUTO_ROUTE_BUILDING);

/** Every service, as the Auto route panel runs it; resolves with the preview. */
async function autoRouteEverything(): Promise<UnifiedAutoRouteResult> {
  runAutoRoute({ services: { gas: true, liquid: true, condensate: true, supplyDuct: true, returnDuct: true }, scope: 'drawing',
    profile: undefined, duct: { shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false } });
  const started = Date.now();
  while (!useCondensatePreviewStore.getState().unified && !useCondensatePreviewStore.getState().message && Date.now() - started < 1_500_000) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const preview = useCondensatePreviewStore.getState();
  expect(preview.message ?? null).toBeNull();
  return preview.unified!;
}

/** New pipe clashes in the preview, against the drawing with the proposal's terminal turns. */
function previewClashes(result: UnifiedAutoRouteResult) {
  const scene = result.ducts
    ? applyDuctProposal(useSmartDrawingStore.getState().hvacElements, { ...result.ducts, elementsToAdd: [], removeElementIds: [] })
    : useSmartDrawingStore.getState().hvacElements;
  const proposed = [...(result.ducts?.elementsToAdd ?? []), ...(result.refrigerant?.elementsToAdd ?? []), ...(result.condensate?.elementsToAdd ?? [])];
  return findNewNetworkPipeClashes([...scene], proposed);
}

const drain = (result: UnifiedAutoRouteResult, unitId: string) => result.condensate?.perUnit.find((unit) => unit.unitId === unitId);

describe.runIf(ENABLED)("the user's building through Auto route", () => {
  it('as drawn: every unit gets refrigerant, the drains route where they can, and each unit says what puts it right', async () => {
    drawUsersBuilding('as-drawn');
    const result = await autoRouteEverything();
    const unit = (id: string) => result.ducts!.units.find((entry) => entry.unitId === id)!;
    // The FDU224: turned away from its terminals and short of them; the bottom-left FDUM140: one diffuser for 1,920 m³/h.
    expect(unit(USERS_BUILDING_IDS.fdu224).status).toBe('kept');
    expect(unit(USERS_BUILDING_IDS.fdu224).advice?.map((advice) => advice.kind === 'turn-unit' ? `turn ${advice.angleDeg}` : `${advice.service} ${advice.total} × Ø${advice.neckMm}`))
      .toEqual(['turn 180', 'supply 6 × Ø300', 'return 5 × Ø300']);
    expect(unit(USERS_BUILDING_IDS.bottomLeft).status).toBe('kept');
    expect(unit(USERS_BUILDING_IDS.bottomLeft).advice?.map((advice) => advice.kind === 'add-terminals' && `${advice.service} ${advice.total} × Ø${advice.neckMm}`))
      .toEqual(['supply 3 × Ø300', 'return 3 × Ø300']);
    // The middle FDUM140 is designed, its four Ø250 necks over the limit: advised, not refused.
    expect(unit(USERS_BUILDING_IDS.middle).status).toBe('designed');
    expect(unit(USERS_BUILDING_IDS.middle).advice?.map((advice) => advice.kind)).toEqual(['add-terminals', 'add-terminals']);
    expect(result.refrigerant?.unconnectedIndoorIds).toEqual([]);
    // 61.6 kW of indoor units on a 28 kW outdoor unit: said, without blocking anything.
    expect(Math.round(result.refrigerant?.connectionRatios?.[0]?.percent ?? 0)).toBe(220);
    expect(drain(result, USERS_BUILDING_IDS.bottomLeft)?.status).toBe('pumped');
    expect(drain(result, USERS_BUILDING_IDS.fdu224)).toMatchObject({ status: 'infeasible', pumpWouldHelp: true });
    expect(previewClashes(result)).toEqual([]);
    expect((result.blockingIssues ?? []).filter((issue) => /intersects/.test(issue))).toEqual([]);
  }, 1_500_000);

  it('as advised: turned, the terminals Auto route proposes, the pump fitted — then everything routes, and Apply takes it', async () => {
    drawUsersBuilding('as-drawn');
    const store = useSmartDrawingStore;
    const fdu = store.getState().hvacElements.find((element) => element.id === USERS_BUILDING_IDS.fdu224)!;
    // "Turn 180° and route again" and "Fit a condensate pump" (no ducts or pipes yet to follow the turn).
    store.getState().commitHvacElementCommand('Turn', { updates: [{ id: fdu.id, updates: { rotation: 180, properties: { ...fdu.properties, hasDrainPump: true } } }] });
    // "Propose terminals", then "Add terminals", for each ducted unit and service, as the panel does it.
    let ids = 0;
    for (const unitId of [USERS_BUILDING_IDS.fdu224, USERS_BUILDING_IDS.bottomLeft, USERS_BUILDING_IDS.middle]) {
      for (const service of ['supply', 'return'] as const) {
        const state = store.getState();
        const unit = state.hvacElements.find((element) => element.id === unitId)!;
        const room = state.rooms.find((candidate) => isPointInPolygon({ x: unit.position.x + unit.width / 2, y: unit.position.y + unit.depth / 2 }, candidate.vertices))!;
        const inRoom = (element: HvacElement) => isPointInPolygon({ x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 }, room.vertices);
        const terminalIds = state.hvacElements.filter((element) => readDuctTerminalSpec(element) && inRoom(element)).map((element) => element.id);
        const airflow = unitId === USERS_BUILDING_IDS.fdu224 ? 4320 : 1920;
        const proposal = proposeTerminals(state.hvacElements, state.rooms, unitId, terminalIds, service, airflow, state.ductSettings, () => `proposed-${ids++}`);
        expect(proposal, `${unitId} ${service}`).not.toBeNull();
        state.commitHvacElementCommand('Add air terminals', { add: proposal!.add, updates: proposal!.updates.map((element) => ({ id: element.id, updates: element })) });
      }
    }
    const result = await autoRouteEverything();
    expect(result.ducts?.units.map((unit) => `${unit.tag}:${unit.status}`), result.ducts?.units.filter((unit) => unit.status !== 'designed')
      .map((unit) => `${unit.tag}: ${unit.notes.slice(0, 4).join(' | ')}`).join(' || ')).toEqual(['DU-1:designed', 'DU-2:designed', 'DU-3:designed']);
    expect(result.ducts?.units.every((unit) => !(unit.advice ?? []).length)).toBe(true);
    expect(result.refrigerant?.unconnectedIndoorIds).toEqual([]);
    expect(result.condensate?.perUnit.every((unit) => unit.status === 'pumped' || unit.status === 'gravity')).toBe(true);
    expect(previewClashes(result)).toEqual([]);
    expect(result.blockingIssues ?? []).toEqual([]);
    expect(applyAutoRoutePreview()).toMatch(/applied/i);
  }, 1_500_000);

  it('put right: three duct layouts, every unit on refrigerant and drained, no clashes, and Apply takes it', async () => {
    drawUsersBuilding('put-right');
    const result = await autoRouteEverything();
    expect(result.ducts?.units.map((unit) => unit.status)).toEqual(['designed', 'designed', 'designed']);
    expect(result.refrigerant?.unconnectedIndoorIds).toEqual([]);
    expect(result.condensate?.perUnit.every((unit) => unit.status === 'pumped' || unit.status === 'gravity')).toBe(true);
    expect(previewClashes(result)).toEqual([]);
    expect(result.blockingIssues ?? []).toEqual([]);
    expect(applyAutoRoutePreview()).toMatch(/applied/i);
  }, 1_500_000);
});
