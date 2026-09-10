import type { HvacElement, Point2D } from '../../../types';

import type { BranchKitProposalValidity } from './branchKitProposal';
import type { RefrigerantPipeAngleMode, RefrigerantPipeBundleConnection, RefrigerantPipeLineMode, RefrigerantPipeMaterial } from './refrigerantPipePairModel';

export function resolvePipeDraftAngleMode(
  mode: RefrigerantPipeAngleMode, material: RefrigerantPipeMaterial,
): Exclude<RefrigerantPipeAngleMode, 'auto'> {
  return mode === 'auto' ? material === 'hard' ? 'diagonal' : 'free' : mode;
}

/** The same rule applies to world XY or a workplane's U/V coordinates. */
export function constrainPipeDraftDelta(delta: Point2D, options: {
  angleMode: RefrigerantPipeAngleMode;
  material: RefrigerantPipeMaterial;
  shift?: boolean;
  alt?: boolean;
}): Point2D | null {
  if (![delta.x, delta.y].every(Number.isFinite)) return null;
  const mode = options.alt ? 'free' : options.shift ? 'ortho' : resolvePipeDraftAngleMode(options.angleMode, options.material);
  if (mode === 'free') return { ...delta };
  if (mode === 'ortho') return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
  const length = Math.hypot(delta.x, delta.y);
  const angle = Math.round(Math.atan2(delta.y, delta.x) / (Math.PI / 4)) * Math.PI / 4;
  return { x: length * Math.cos(angle), y: length * Math.sin(angle) };
}

export interface PipeSnapIndicator {
  x: number;
  y: number;
  label?: string;
}

/** A visible gas port is an anchor for the selected pair tool. Only a proven
 * lone field pipe overrides the requested services when continuing a run. */
export function resolvePipeStartMode(
  bundle: RefrigerantPipeBundleConnection,
  requested: RefrigerantPipeLineMode,
  scene: HvacElement[],
): RefrigerantPipeLineMode {
  if (bundle.connectionKind !== 'field-pipe') return requested;
  if (bundle.gasSourceElementId && bundle.liquidSourceElementId &&
    bundle.gasSourceElementId !== bundle.liquidSourceElementId) return requested;
  const source = scene.find((element) => element.id === bundle.sourceElementId);
  if (source?.type !== 'refrigerant-pipe') return requested;
  return source.properties.lineKind === 'liquid' ? 'liquid' : 'gas';
}

export function canOfferPipeBranch(options: {
  planRouting: boolean;
  lineMode: RefrigerantPipeLineMode;
  hasStart: boolean;
  hasEndpointSnap: boolean;
  freePointer: boolean;
}): boolean {
  return options.planRouting && options.lineMode === 'pair' && options.hasStart
    && !options.hasEndpointSnap && !options.freePointer;
}

/** A displayed fitting proposal owns completion: never save a plain crossing
 * when the user accepts a preview of an actual connected branch. */
export function resolvePipeFinishAction(validity?: BranchKitProposalValidity | null): 'route' | 'branch' | 'blocked' {
  return validity === 'invalid' ? 'blocked' : validity ? 'branch' : 'route';
}

export function describePipeConnection(bundle: RefrigerantPipeBundleConnection, mode: RefrigerantPipeLineMode): string {
  const service = mode === 'pair' ? 'Gas + liquid' : mode === 'gas' ? 'Gas' : 'Liquid';
  const role = bundle.connectionKind === 'unit-port'
    ? 'unit ports'
    : bundle.terminalRole
      ? bundle.terminalRole.replaceAll('-', ' ')
      : 'open end';
  const level = mode === 'gas' ? bundle.gasElevationMm : mode === 'liquid' ? bundle.liquidElevationMm : bundle.elevationMm;
  return `${service} · ${role} · ${(level / 1000).toFixed(2)} m`;
}
