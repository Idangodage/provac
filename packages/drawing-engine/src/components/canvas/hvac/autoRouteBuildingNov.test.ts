/**
 * The user's own drawing (their JSON export of 1 November 2026, three FDUM with
 * eight, seven and eight terminals, three FDT28 cassettes, one FDC280 and one
 * gully), through the whole Auto route. Its six 3D screenshots are what the
 * audit in docs/hvac-building-audit.md put right.
 *
 * A minute of routing, so it runs only on request (with the duct benchmark):
 * `AUTO_ROUTE_BUILDING=1 npx vitest run src/components/canvas/hvac/autoRouteBuildingNov.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement, Room, Wall } from '../../../types';

import scene from './__fixtures__/users-building-nov-scene.json';
import { resolveCondensateSettings } from './condensate/condensateSettings';
import { ductWallInputs } from './duct/ductBuilding';
import { savedDuctSettings, setActiveDuctSettings, type DuctDesignSettings } from './duct/ductSettings';
import { isDuctTerminalElement } from './duct/ductTerminals';
import { isDuctElement, readDuctRunSpec } from './duct/ductTypes';
import { resolvePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { planUnifiedAutoRoute, unifiedRouteCommand, type UnifiedAutoRouteResult } from './unifiedAutoRoute';
import { applyServiceRouteCommand } from './serviceRouteValidation';
import { autoTurnSettingsOf } from './unitOrientation';

const ENABLED = Boolean((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AUTO_ROUTE_BUILDING);

const fixture = scene as unknown as {
  hvacElements: HvacElement[]; walls: Wall[]; rooms: Room[];
  pipeRoutingSettings?: Record<string, unknown>; ductSettings?: Partial<DuctDesignSettings>; condensateSettings?: Record<string, unknown>;
};

async function autoRoute(): Promise<{ result: UnifiedAutoRouteResult; after: HvacElement[] }> {
  const pipes = resolvePipeRoutingSettings(fixture.pipeRoutingSettings ?? {});
  const ducts = savedDuctSettings(fixture.ductSettings ?? {});
  setActivePipeRoutingSettings(pipes);
  setActiveDuctSettings(ducts);
  const result = await planUnifiedAutoRoute(fixture.hvacElements, {
    services: { gas: true, liquid: true, condensate: true, supplyDuct: true, returnDuct: true },
    refrigerant: { settings: pipes, objective: 'balanced', walls: fixture.walls, rebuildExisting: true },
    condensate: { settings: resolveCondensateSettings(fixture.condensateSettings ?? {}), walls: fixture.walls, rooms: fixture.rooms },
    orientation: autoTurnSettingsOf(pipes),
    duct: { settings: ducts, shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing',
      walls: ductWallInputs(fixture.walls), rooms: fixture.rooms.map((room) => ({ id: room.id, vertices: room.vertices, designCriteria: room.designCriteria ?? null })) },
  } as Parameters<typeof planUnifiedAutoRoute>[1]);
  return { result, after: applyServiceRouteCommand(fixture.hvacElements, unifiedRouteCommand(result)) };
}

describe.runIf(ENABLED)("the user's drawing of 1 November through Auto route", () => {
  it('leaves nothing out: every room its ducts, every unit its pipes and drain, nothing refused', async () => {
    const { result, after } = await autoRoute();
    expect(result.blockingIssues ?? []).toEqual([]);
    expect(result.ducts!.units.map((unit) => `${unit.tag} ${unit.status}`).sort()).toEqual(['DU-1 designed', 'DU-2 designed', 'DU-3 designed']);
    const served = new Set(after.filter(isDuctElement).flatMap((run) => {
      const end = readDuctRunSpec(run)?.end;
      return end?.kind === 'terminal' ? [end.terminalId] : [];
    }));
    expect(after.filter(isDuctTerminalElement).filter((terminal) => !served.has(terminal.id)).map((terminal) => terminal.label)).toEqual([]);
    expect(result.refrigerant!.unconnectedIndoorIds).toEqual([]);
    expect(result.condensate!.metrics.unitsConnected).toBe(result.condensate!.metrics.unitsTotal);
  }, 600_000);
});
