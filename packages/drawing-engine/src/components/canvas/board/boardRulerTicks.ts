/**
 * Finite ruler ticks, bounded by the available screen pixels. Index-based
 * sampling avoids g += step getting stuck when the world origin exceeds the
 * floating-point precision of a tick (for example near edge-on projections).
 */
export function getBoardRulerTicks(
  worldStart: number,
  worldEnd: number,
  stepMm: number,
  viewportExtentPx: number,
): number[] {
  if (![worldStart, worldEnd, stepMm, viewportExtentPx].every(Number.isFinite) ||
    worldEnd < worldStart || stepMm <= 0 || viewportExtentPx <= 0) return [];

  const first = Math.ceil(worldStart / stepMm) * stepMm;
  if (!Number.isFinite(first) || first > worldEnd) return [];
  // Adaptive ruler spacing ordinarily exceeds one pixel. This cap also keeps
  // malformed or poorly conditioned viewports from blocking the render thread.
  const limit = Math.min(16_384, Math.ceil(viewportExtentPx) + 2);
  const count = Math.min(limit, Math.floor((worldEnd - first) / stepMm) + 1);
  const ticks: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const tick = first + index * stepMm;
    if (!Number.isFinite(tick) || tick > worldEnd) break;
    if (tick < worldStart || tick <= previous) continue;
    ticks.push(tick);
    previous = tick;
  }
  return ticks;
}
