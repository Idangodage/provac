/** A transient route replaces its committed ID without changing the scene's model array. */
export function composeHybridPipePreviewScene<T extends { id: string }>(
  committed: readonly T[],
  drafts: readonly T[] | null,
  edits: readonly T[] | null,
): { previews: T[]; allElements: T[]; hiddenIds: Set<string> } {
  const replacements = new Map<string, T>();
  for (const element of edits ?? []) replacements.set(element.id, element);
  for (const element of drafts ?? []) replacements.set(element.id, element);
  const committedIds = new Set(committed.map(element => element.id));
  return {
    previews: [...replacements.values()],
    allElements: [
      ...committed.map(element => replacements.get(element.id) ?? element),
      ...[...replacements.values()].filter(element => !committedIds.has(element.id)),
    ],
    hiddenIds: new Set(replacements.keys()),
  };
}
