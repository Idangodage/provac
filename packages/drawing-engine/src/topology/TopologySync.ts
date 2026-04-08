/**
 * TopologySync
 *
 * Reactive synchronisation layer that rebuilds BuildingTopology
 * whenever the source Wall[]/Room[] arrays change.
 *
 * Usage in React components:
 *   const topology = useTopology(walls, rooms);
 *
 * The hook memoises the topology instance and only rebuilds when
 * the wall/room arrays change by reference.
 */

import { useMemo, useRef } from 'react';

import type { Room, Wall } from '../types';

import { BuildingTopology } from './BuildingTopology';

/**
 * React hook that returns a BuildingTopology instance, rebuilt
 * automatically when walls or rooms change.
 *
 * The topology is a lightweight derived structure, typically <1ms
 * to rebuild for buildings with up to ~500 walls.
 */
export function useTopology(
  walls: Wall[],
  rooms: Room[],
  tolerance?: number,
): BuildingTopology {
  // Track previous array references to avoid unnecessary rebuilds
  const prevWallsRef = useRef<Wall[]>(walls);
  const prevRoomsRef = useRef<Room[]>(rooms);
  const prevToleranceRef = useRef(tolerance);

  const topology = useMemo(() => {
    return BuildingTopology.fromWallsAndRooms(walls, rooms, tolerance);
  }, [walls, rooms, tolerance]);

  prevWallsRef.current = walls;
  prevRoomsRef.current = rooms;
  prevToleranceRef.current = tolerance;

  return topology;
}

/**
 * Non-reactive factory for use outside React (tests, workers, etc.).
 */
export function createTopology(
  walls: Wall[],
  rooms: Room[],
  tolerance?: number,
): BuildingTopology {
  return BuildingTopology.fromWallsAndRooms(walls, rooms, tolerance);
}
