import type { HvacElement } from '../../../types';

export type PipeRegenerationPolicy = 'retain' | 'reconsider';

export interface AutoRouteOwnership {
  version: 1;
  networkId: string;
  outdoorUnitId: string;
  indoorUnitIds: string[];
  signature: string;
  editPolicy?: PipeRegenerationPolicy;
  /** Consent applies to this exact geometry; subsequent edits are retained again. */
  reconsideredSignature?: string;
  [key: string]: unknown;
}

export function getAutoRouteOwnership(element: HvacElement): AutoRouteOwnership | null {
  const value = element.properties.autoRouteNetwork as Partial<AutoRouteOwnership> | undefined;
  return value?.version === 1 && typeof value.networkId === 'string' && typeof value.outdoorUnitId === 'string'
    && Array.isArray(value.indoorUnitIds) && value.indoorUnitIds.every(id => typeof id === 'string')
    && typeof value.signature === 'string' ? value as AutoRouteOwnership : null;
}

/** Preserve the version-one fingerprint so existing saved networks remain recognizable. */
export function autoRouteElementSignature(element: HvacElement): string {
  return ownedElementSignature(element, 'autoRouteNetwork');
}

/** Fingerprint of an element excluding its own ownership record (`ownershipKey`). */
export function ownedElementSignature(element: HvacElement, ownershipKey: string): string {
  const properties = { ...element.properties };
  delete properties[ownershipKey];
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)])) : value;
  const serialized = JSON.stringify(canonical({ ...element, category: element.category ?? 'accessory',
    modelLabel: element.modelLabel ?? element.label, supplyZoneRatio: element.supplyZoneRatio ?? 0.5, properties }));
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

export function isPipeRouteLocked(element: HvacElement): boolean {
  return ['networkLevelLocked', 'routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed']
    .some(key => element.properties[key] === true)
    || (Array.isArray(element.properties.bypasses) && element.properties.bypasses.length > 0);
}

export function pipeRegenerationPolicy(element: HvacElement): PipeRegenerationPolicy | 'generated' | 'manual' {
  const owner = getAutoRouteOwnership(element);
  if (!owner) return 'manual';
  if (owner.editPolicy === 'retain') return 'retain';
  const signature = autoRouteElementSignature(element);
  if (owner.editPolicy === 'reconsider' && owner.reconsideredSignature === signature) return 'reconsider';
  return owner.signature === signature ? 'generated' : 'retain';
}

export function isPipeRegenerationProtected(element: HvacElement): boolean {
  return isPipeRouteLocked(element) || pipeRegenerationPolicy(element) === 'retain';
}

/** One retained member protects its complete circuit, including the paired service. */
export function protectedPipeNetworkElementIds(scene: readonly HvacElement[]): Set<string> {
  const protectedMembers = scene.filter(isPipeRegenerationProtected);
  const networks = new Set(protectedMembers.map(element => getAutoRouteOwnership(element)?.networkId)
    .filter((id): id is string => typeof id === 'string'));
  return new Set(scene.filter(element => isPipeRegenerationProtected(element)
    || networks.has(getAutoRouteOwnership(element)?.networkId ?? '')).map(element => element.id));
}

export function withPipeRegenerationPolicy(element: HvacElement, policy: PipeRegenerationPolicy): HvacElement {
  const owner = getAutoRouteOwnership(element);
  if (!owner) return element;
  const nextOwner = { ...owner, editPolicy: policy };
  if (policy === 'reconsider') nextOwner.reconsideredSignature = autoRouteElementSignature(element);
  else delete nextOwner.reconsideredSignature;
  return { ...element, properties: { ...element.properties, autoRouteNetwork: nextOwner } };
}

/** Store edits preserve ownership and identify manual changes without touching IDs or geometry. */
export function retainGeneratedPipeEdit(previous: HvacElement, next: HvacElement): HvacElement {
  const condensateOwner = next.properties.condensateNetwork as { version?: unknown; signature?: unknown } | undefined;
  if (condensateOwner?.version === 1 && typeof condensateOwner.signature === 'string') {
    // Same rule for generated condensate networks: a field edit is kept on regenerate.
    const signature = ownedElementSignature(next, 'condensateNetwork');
    if (signature === ownedElementSignature(previous, 'condensateNetwork') || signature === condensateOwner.signature) return next;
    return { ...next, properties: { ...next.properties, condensateNetwork: { ...condensateOwner, editPolicy: 'retain' } } };
  }
  const owner = getAutoRouteOwnership(next);
  if (!owner) return next;
  const signature = autoRouteElementSignature(next);
  if (signature === autoRouteElementSignature(previous) || signature === owner.signature) return next;
  return withPipeRegenerationPolicy(next, 'retain');
}
