/**
 * Turns a previewed condensate generation into ONE undoable store command,
 * refusing results computed against a drawing that has since changed.
 */
import type { HvacElement, Room, Wall } from '../../../../types';
import type { PipeRoutingSettings } from '../pipeRoutingSettings';

import { hashCondensateText } from './condensateElements';
import type { CondensateGenerationResult } from './condensateGenerator';
import type { CondensateDesignSettings } from './condensateSettings';
import { isCondensatePipe } from './condensateTypes';

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

export function prepareCondensateCommand(
  signature: string,
  latest: CondensateCommandSource,
  result: CondensateGenerationResult,
  hopUpdates: Array<{ id: string; updates: Partial<HvacElement> }> = [],
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
  const existing = new Map(latest.scene.map((element) => [element.id, element]));
  const removeIds = result.removeElementIds.filter((id) => isCondensatePipe(existing.get(id)));
  const updates = hopUpdates.filter(({ id }) => existing.get(id)?.type === 'refrigerant-pipe');
  return {
    command: {
      add: result.elementsToAdd,
      removeIds,
      ...(updates.length ? { updates } : {}),
      selectedIds: [],
    },
  };
}
