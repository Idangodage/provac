/**
 * The building the drawing's duct plans read (its walls and rooms), kept in
 * step with the store. A component that plans ducts takes it into its memo
 * keys, so a moved wall re-plans the runs (their sleeves and fire dampers);
 * the call also keeps the active building current for the engines that are
 * not handed it (the 3D builder, the clash checks).
 */
import { useMemo } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';

import { syncActiveDuctBuilding, type DuctBuilding } from './ductBuilding';

export function useDuctBuilding(): DuctBuilding {
  const { walls, rooms } = useSmartDrawingStore((state) => ({ walls: state.walls, rooms: state.rooms }), shallow);
  return useMemo(() => syncActiveDuctBuilding(walls, rooms), [walls, rooms]);
}
