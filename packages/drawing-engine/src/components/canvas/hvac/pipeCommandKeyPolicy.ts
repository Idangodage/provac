export type PipeCommandKeyAction = 'none' | 'commit' | 'cancel';

/**
 * Professional command semantics: Enter accepts, Escape cancels. Escape never
 * commits a partially authored route merely because it already has two points.
 */
export function resolvePipeCommandKeyAction(
  key: string,
  routePointCount: number,
): PipeCommandKeyAction {
  if (key === 'Escape') {
    return routePointCount > 0 ? 'cancel' : 'none';
  }
  if (key === 'Enter') return 'commit';
  return 'none';
}
