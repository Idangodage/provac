export interface PipeHandleCandidate {
  key: string;
  x: number;
  y: number;
  /** Larger values win when projected controls overlap. */
  priority: number;
}

/** Presentation only: retain original control identities and model coordinates. */
export function selectPipeHandleCandidates<T extends PipeHandleCandidate>(
  candidates: readonly T[],
  selectedKey?: string,
  minimumSpacingPx = 20,
): T[] {
  const spacing = Math.max(1, minimumSpacingPx);
  const cells = new Map<string, T[]>();
  const accepted = new Set<T>();
  const ranked = candidates.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point, order) => ({ point, order }))
    .sort((a, b) => Number(b.point.key === selectedKey) - Number(a.point.key === selectedKey)
      || b.point.priority - a.point.priority || a.order - b.order);
  for (const { point } of ranked) {
    const x = Math.floor(point.x / spacing); const y = Math.floor(point.y / spacing);
    let overlaps = false;
    for (let dx = -1; dx <= 1 && !overlaps; dx++) {
      for (let dy = -1; dy <= 1 && !overlaps; dy++) {
        overlaps = (cells.get(`${x + dx},${y + dy}`) ?? []).some(other =>
          Math.hypot(point.x - other.x, point.y - other.y) < spacing);
      }
    }
    if (overlaps) continue;
    const key = `${x},${y}`;
    const cell = cells.get(key) ?? [];
    cell.push(point); cells.set(key, cell); accepted.add(point);
  }
  return candidates.filter(point => accepted.has(point));
}
