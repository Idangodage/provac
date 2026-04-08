import type { Room, Wall } from '../../../types';

function toWallMap(walls: ReadonlyArray<Wall> | ReadonlyMap<string, Wall>): ReadonlyMap<string, Wall> {
  if ('get' in walls && 'has' in walls) {
    return walls;
  }

  return new Map(walls.map((wall) => [wall.id, wall] as const));
}

export function isRoomIsolatedFromAttachments(
  room: Room | null | undefined,
  walls: ReadonlyArray<Wall> | ReadonlyMap<string, Wall>
): boolean {
  if (!room || room.wallIds.length < 3) {
    return false;
  }

  if ((room.adjacentRoomIds?.length ?? 0) > 0) {
    return false;
  }

  const wallMap = toWallMap(walls);
  const roomWallIds = new Set(room.wallIds);

  for (const wallId of room.wallIds) {
    const wall = wallMap.get(wallId);
    if (!wall) {
      return false;
    }

    for (const connectedWallId of wall.connectedWalls) {
      if (!roomWallIds.has(connectedWallId)) {
        return false;
      }
    }
  }

  return true;
}
