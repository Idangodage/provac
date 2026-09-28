/**
 * Air terminals as duct ends: ceiling diffusers and return grilles, each with
 * a plenum box and a round side spigot that a run (usually a flexible runout,
 * SMACNA Fig. 2-15) connects to.
 *
 * SMACNA gives no terminal dimensions. The sizes here are typical catalog
 * sizes, flagged as practice until the chosen supplier's data replaces them
 * (your decision, 27 September 2026).
 *
 * Local frame (the same as units and their 3D group): origin at the footprint
 * centre, X/Y along the element axes (Y down in plan), z up from the element
 * elevation, which is the ceiling plane (the face's underside).
 */
import type { HvacElement, Point2D } from '../../../../types';

import { toWorldAirPort, type DuctAirPort, type LocalAirPortSpec } from './ductAirPorts';
import type { DuctRuleProvenance } from './ductSources';
import {
  typicalTerminalSpec,
  type DuctTerminalKind,
  type DuctTerminalSpec,
  type DuctTerminalSpigotSide,
} from './ductTerminalCatalog';

export * from './ductTerminalCatalog';

/** Ceiling plane when no ceiling unit gives one (the units' default mounting level). */
export const DEFAULT_TERMINAL_CEILING_MM = 2400;

export const TERMINAL_PROVENANCE: DuctRuleProvenance = {
  sourceId: 'project-practice', verified: false,
  note: 'Typical catalog size (SMACNA gives none); replace with the supplier\'s data.',
};

export function isDuctTerminalElement(element: Pick<HvacElement, 'type'>): boolean {
  return element.type === 'diffuser' || element.type === 'return-grille';
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const KINDS: readonly DuctTerminalKind[] = ['square-4way', 'round', 'linear-slot', 'return-egg-crate'];
const SIDES: readonly DuctTerminalSpigotSide[] = ['back', 'front', 'left', 'right'];

/** Tolerant reader: an old diffuser or grille without a spec gets the typical one of its type. */
export function readDuctTerminalSpec(element: Pick<HvacElement, 'type' | 'properties'>): DuctTerminalSpec | null {
  if (!isDuctTerminalElement(element)) return null;
  const raw = element.properties.terminal as Record<string, unknown> | undefined;
  const fallbackKind: DuctTerminalKind = element.type === 'return-grille' ? 'return-egg-crate' : 'square-4way';
  const kind = KINDS.includes(raw?.kind as DuctTerminalKind) ? (raw!.kind as DuctTerminalKind) : fallbackKind;
  const neck = finite(raw?.neckDiameterMm) ? raw!.neckDiameterMm : kind === 'return-egg-crate' ? 250 : 200;
  const base = typicalTerminalSpec(kind, neck, {
    mount: raw?.mount === 'surface' ? 'surface' : 'lay-in',
    ...(finite(raw?.slots) ? { slots: raw!.slots } : {}),
    ...(finite(raw?.faceWidthMm) && kind === 'linear-slot' ? { lengthMm: raw!.faceWidthMm } : {}),
  });
  const read = (key: keyof DuctTerminalSpec, min: number) => (finite(raw?.[key]) ? Math.max(min, raw![key] as number) : base[key] as number);
  return {
    ...base,
    faceWidthMm: read('faceWidthMm', 100),
    faceDepthMm: read('faceDepthMm', 40),
    faceHeightMm: read('faceHeightMm', 5),
    plenumWidthMm: read('plenumWidthMm', 100),
    plenumDepthMm: read('plenumDepthMm', 100),
    plenumHeightMm: read('plenumHeightMm', 100),
    spigotLengthMm: read('spigotLengthMm', 51),
    spigotSide: SIDES.includes(raw?.spigotSide as DuctTerminalSpigotSide) ? (raw!.spigotSide as DuctTerminalSpigotSide) : base.spigotSide,
    service: element.type === 'return-grille' ? 'return' : 'supply',
  };
}

/** The element's plan footprint and height for a spec (the face; the plenum sits above it). */
export function terminalEnvelope(spec: DuctTerminalSpec): { widthMm: number; depthMm: number; heightMm: number } {
  return { widthMm: spec.faceWidthMm, depthMm: spec.faceDepthMm, heightMm: spec.faceHeightMm + spec.plenumHeightMm };
}

const SIDE_NORMAL: Record<DuctTerminalSpigotSide, Point2D> = {
  back: { x: 0, y: -1 }, front: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

/** The spigot in the terminal's local frame: on the plenum side, half way up the box. */
export function localTerminalSpigot(spec: DuctTerminalSpec): LocalAirPortSpec {
  const normal = SIDE_NORMAL[spec.spigotSide];
  const half = Math.abs(normal.x) > 0 ? spec.plenumWidthMm / 2 : spec.plenumDepthMm / 2;
  const reach = half + spec.spigotLengthMm;
  return {
    id: 'spigot',
    kind: spec.service,
    lip: { x: normal.x * reach, y: normal.y * reach, z: spec.faceHeightMm + spec.plenumHeightMm / 2 },
    normal,
    widthMm: spec.neckDiameterMm,
    heightMm: spec.neckDiameterMm,
    collarDepthMm: spec.spigotLengthMm,
  };
}

/** The terminal's spigot in world millimetres (round: width = height = Ø). */
export function terminalSpigotPort(element: HvacElement): DuctAirPort | null {
  const spec = readDuctTerminalSpec(element);
  if (!spec) return null;
  return { ...toWorldAirPort(element, localTerminalSpigot(spec), 'element'), diameterMm: spec.neckDiameterMm, provenance: TERMINAL_PROVENANCE };
}

export function listTerminalPorts(elements: readonly HvacElement[]): DuctAirPort[] {
  return elements.flatMap((element) => {
    const port = isDuctTerminalElement(element) ? terminalSpigotPort(element) : null;
    return port ? [port] : [];
  });
}

export function findTerminalPort(elements: readonly HvacElement[], terminalId: string, portId = 'spigot'): DuctAirPort | null {
  const terminal = elements.find((element) => element.id === terminalId);
  const port = terminal ? terminalSpigotPort(terminal) : null;
  return port && port.portId === portId ? port : null;
}

/**
 * The ceiling plane terminals sit in: where the ceiling units already hang
 * (a cassette's face, a ducted unit's underside), else the default.
 */
export function terminalCeilingPlane(elements: readonly HvacElement[]): number {
  const cassettes = elements.filter((element) => element.type === 'ceiling-cassette-ac').map((element) => element.elevation);
  if (cassettes.length > 0) return [...cassettes].sort((a, b) => a - b)[Math.floor(cassettes.length / 2)]!;
  const ducted = elements.filter((element) => element.type === 'ducted-ac').map((element) => element.elevation);
  return ducted.length > 0 ? Math.min(...ducted) : DEFAULT_TERMINAL_CEILING_MM;
}
