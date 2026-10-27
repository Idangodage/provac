/**
 * Runs once per opened drawing: units whose pipes and drains still start on
 * their old drawn ports are re-attached to the maker's stubs as one undoable
 * change, and the status bar says so (connectionMigration.ts).
 */
import { useSmartDrawingStore } from '../../../store';

import { condensateEditContext } from './condensate/condensateEditController';
import { planConnectionMigration } from './connectionMigration';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function migrateUnitConnectionsAfterOpen(): void {
  const state = useSmartDrawingStore.getState();
  const plan = planConnectionMigration(state.hvacElements, condensateEditContext());
  if (!plan) return;
  if (plan.unitIds.length) {
    state.commitHvacElementCommand("Connections moved to the maker's stubs",
      { updates: plan.updates, add: plan.add, removeIds: plan.removeIds });
  }
  const notes = [
    plan.unitIds.length ? `Connections moved to the maker's stubs on ${plural(plan.unitIds.length, 'unit')}: Undo puts them back.` : '',
    plan.keptUnitIds.length
      ? `${plural(plan.keptUnitIds.length, 'unit')} kept the old connections: moving them would add a design error.` : '',
    ...plan.messages,
  ].filter(Boolean);
  if (notes.length) useSmartDrawingStore.getState().setProcessingStatus(notes.join(' '), false);
}
