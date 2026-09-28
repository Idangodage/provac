/**
 * Store glue for the duct auto layout: which unit and terminals the selection
 * means, Generate (into the preview), Apply (one command, one undo) and Discard.
 */
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { generateAutoDuct, type AutoDuctRequest } from './ductAutoLayout';
import { useDuctAutoPreviewStore } from './ductAutoPreviewStore';
import { isDuctTerminalElement, listTerminalPorts } from './ductTerminals';
import { isDuctElement, readDuctRunSpec } from './ductTypes';

/** Distance within which unconnected terminals count as a unit's when none are selected (mm). */
const NEARBY_TERMINALS_MM = 10000;

export interface AutoDuctSelection {
  unit: HvacElement;
  /** The terminals chosen: the selected ones, else the unconnected ones in the unit's room. */
  terminals: HvacElement[];
  fromSelection: boolean;
}

/** The ducted unit and terminals a selection means, or null when it holds no single ducted unit. */
export function autoDuctSelection(selectedIds: readonly string[], scene: readonly HvacElement[]): AutoDuctSelection | null {
  const selected = scene.filter((element) => selectedIds.includes(element.id));
  const units = selected.filter((element) => element.type === 'ducted-ac');
  if (units.length !== 1) return null;
  const unit = units[0]!;
  const picked = selected.filter(isDuctTerminalElement);
  if (picked.length) return { unit, terminals: picked, fromSelection: true };
  const served = new Set<string>();
  for (const element of scene) {
    const end = isDuctElement(element) ? readDuctRunSpec(element)?.end : null;
    if (end?.kind === 'terminal') served.add(end.terminalId);
  }
  const centre = { x: unit.position.x + unit.width / 2, y: unit.position.y + unit.depth / 2 };
  const ports = new Map(listTerminalPorts(scene).map((port) => [port.unitId, port]));
  const terminals = scene.filter((element) => {
    if (!isDuctTerminalElement(element) || served.has(element.id)) return false;
    if (unit.roomId && element.roomId) return element.roomId === unit.roomId;
    const port = ports.get(element.id);
    return Boolean(port) && Math.hypot(port!.lip.x - centre.x, port!.lip.y - centre.y) <= NEARBY_TERMINALS_MM;
  });
  return { unit, terminals, fromSelection: false };
}

export function generateAutoDuctPreview(request: AutoDuctRequest): void {
  const { hvacElements, ductSettings } = useSmartDrawingStore.getState();
  const result = generateAutoDuct(hvacElements, request, ductSettings);
  useDuctAutoPreviewStore.getState().setPreview(result, request, hvacElements);
}

export function discardAutoDuctPreview(): void {
  useDuctAutoPreviewStore.getState().clear();
}

/** Commits the preview as one command; returns what happened. */
export function applyAutoDuctPreview(): string {
  const state = useSmartDrawingStore.getState();
  const { result, scene } = useDuctAutoPreviewStore.getState();
  if (!result) return 'Nothing to apply.';
  if (scene !== state.hvacElements) {
    useDuctAutoPreviewStore.getState().clear('The drawing changed since the preview; generate it again.');
    return 'The drawing changed since the preview; generate it again.';
  }
  if (!result.runs.length) return 'The preview has no ducts to add.';
  const ids = result.runs.map((run) => run.id);
  state.commitHvacElementCommand('Auto duct', { add: result.runs, removeIds: result.removeIds, selectedIds: ids });
  const message = `Auto duct: ${result.runs.length} run${result.runs.length === 1 ? '' : 's'} added${result.removeIds.length ? `, ${result.removeIds.length} replaced` : ''}.`;
  useDuctAutoPreviewStore.getState().clear(message);
  state.setProcessingStatus(message, false);
  return message;
}
