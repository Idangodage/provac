/**
 * Turns a previewed condensate generation into ONE undoable store command,
 * refusing results computed against a drawing that has since changed.
 */
import type { HvacElement, Room, Wall } from '../../../../types';
import type { PipeRoutingSettings } from '../pipeRoutingSettings';
import { serviceRouteCommitIssues } from '../serviceRouteValidation';

import { hashCondensateText } from './condensateElements';
import type { CondensateGenerationResult } from './condensateGenerator';
import type { CondensateDesignSettings } from './condensateSettings';
import { getCondensateOwnership, isCondensatePipe } from './condensateTypes';

export interface CondensateCommandSource {
  scene: readonly HvacElement[];
  settings: CondensateDesignSettings;
  routingSettings: PipeRoutingSettings;
  walls: readonly Wall[];
  rooms: readonly Room[];
}

export interface CondensateElementCommand {
  add?: HvacElement[];
  removeIds?: string[];
  updates?: Array<{ id: string; updates: Partial<HvacElement> }>;
  selectedIds?: string[];
}

/** Signature over everything the generator reads (display-only routing fields excluded). */
export function condensateSourceSignature(source: CondensateCommandSource): string {
  const { fittingDisplay: _display, ...routing } = source.routingSettings;
  const walls = source.walls.map((wall) => [wall.id, wall.startPoint, wall.endPoint, wall.thickness, wall.properties3D?.height, wall.properties3D?.baseElevation]);
  const rooms = source.rooms.map((room) => [room.id, room.properties3D?.ceilingHeight]);
  return hashCondensateText(JSON.stringify([source.scene, source.settings, routing, walls, rooms]));
}

export function incompleteCondensateRefusal(scene: readonly HvacElement[], result: CondensateGenerationResult): string | null {
  if (!result.removeElementIds.length) return null;
  const removed = new Set(result.removeElementIds);
  const served = new Set(result.perUnit.filter((unit) => unit.status === 'gravity' || unit.status === 'pumped').map((unit) => unit.unitId));
  const lost = scene.filter((element) => removed.has(element.id)).some((element) =>
    getCondensateOwnership(element)?.unitIds.some((id) => !served.has(id)));
  return lost || !result.elementsToAdd.length
    ? 'The replacement drain network is incomplete. Existing drains were preserved; connect every affected unit before replacing them.' : null;
}

export function prepareCondensateCommand(
  signature: string,
  latest: CondensateCommandSource,
  result: CondensateGenerationResult,
  hopUpdates: Array<{ id: string; updates: Partial<HvacElement> }> = [],
  coordinatedScene: readonly HvacElement[] = latest.scene,
): { command?: CondensateElementCommand; issue?: string } {
  if (condensateSourceSignature(latest) !== signature) {
    return { issue: 'The drawing changed after this preview was calculated. Generate again to apply an up-to-date network.' };
  }
  if (!result.elementsToAdd.length && !result.removeElementIds.length) {
    return { issue: result.issues[0] ?? 'Nothing to apply.' };
  }
  if (!result.elementsToAdd.every(isCondensatePipe)) {
    return { issue: 'The generated network contains an unexpected element type; nothing was applied.' };
  }
  const incomplete = incompleteCondensateRefusal(latest.scene, result);
  if (incomplete) return { issue: incomplete };
  const existing = new Map(latest.scene.map((element) => [element.id, element]));
  const removeIds = result.removeElementIds.filter((id) => isCondensatePipe(existing.get(id)));
  const updates = hopUpdates.filter(({ id }) => existing.get(id)?.type === 'refrigerant-pipe');
  if (result.crossings.some((crossing) => crossing.relation === 'unresolved')
    || result.hopProposals.some((proposal) => !proposal.withinSoffit)) {
    return { issue: 'Drain routing contains an unresolved crossing or a hop outside the ceiling void. Route again before applying.' };
  }
  const issues = serviceRouteCommitIssues(coordinatedScene, { add: result.elementsToAdd, removeIds, updates }, {
    condensate: latest.settings, routing: latest.routingSettings,
  });
  if (issues.length) return { issue: `Nothing was applied. ${issues[0]}` };
  return {
    command: {
      add: result.elementsToAdd,
      removeIds,
      ...(updates.length ? { updates } : {}),
      selectedIds: [],
    },
  };
}
