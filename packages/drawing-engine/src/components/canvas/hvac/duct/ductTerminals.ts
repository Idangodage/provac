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
import type { DuctDesignSettings } from './ductSettings';
import type { DuctRuleProvenance } from './ductSources';
import {
  DUCT_TERMINAL_FILTER_CLASSES,
  DUCT_TERMINAL_KINDS,
  TERMINAL_TAG_PATTERN,
  terminalTypeTag,
  typicalTerminalSpec,
  type DuctTerminalFilterClass,
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

/** How many filter panels the runs serve: one per filter return grille a run ends on. */
export function filterPanelsServed(plans: ReadonlyArray<{ spec: { end: { kind: string; terminalId?: string } } }>, scene: readonly HvacElement[]): number {
  const served = new Set(plans.flatMap((plan) => (plan.spec.end.kind === 'terminal' && plan.spec.end.terminalId ? [plan.spec.end.terminalId] : [])));
  return scene.filter((element) => served.has(element.id) && Boolean(readDuctTerminalSpec(element)?.filter)).length;
}

export function isDuctTerminalElement(element: Pick<HvacElement, 'type'>): boolean {
  return element.type === 'diffuser' || element.type === 'return-grille';
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const SIDES: readonly DuctTerminalSpigotSide[] = ['back', 'front', 'left', 'right'];

/**
 * Tolerant reader: an old diffuser or grille without a spec gets the typical
 * one of its type. The element type carries the service whatever the face, so
 * a square face on a `return-grille` element is a return diffuser.
 */
export function readDuctTerminalSpec(element: Pick<HvacElement, 'type' | 'properties'>): DuctTerminalSpec | null {
  if (!isDuctTerminalElement(element)) return null;
  const raw = element.properties.terminal as Record<string, unknown> | undefined;
  const service = element.type === 'return-grille' ? 'return' : 'supply';
  const fallbackKind: DuctTerminalKind = service === 'return' ? 'return-egg-crate' : 'square-4way';
  const kind = DUCT_TERMINAL_KINDS.includes(raw?.kind as DuctTerminalKind) ? (raw!.kind as DuctTerminalKind) : fallbackKind;
  const neck = finite(raw?.neckDiameterMm) ? raw!.neckDiameterMm : service === 'return' ? 250 : 200;
  const filter = DUCT_TERMINAL_FILTER_CLASSES.includes(raw?.filter as DuctTerminalFilterClass) ? raw!.filter as DuctTerminalFilterClass : null;
  const base = typicalTerminalSpec(kind, neck, {
    service,
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
    service,
    designAirflowM3h: finite(raw?.designAirflowM3h) && (raw!.designAirflowM3h as number) > 0 ? raw!.designAirflowM3h as number : null,
    ...(filter ? { filter } : {}),
  };
}

/**
 * The next instance tag for a terminal of this type, e.g. "RAG-3": one past the
 * highest number already used with the prefix, so a deleted terminal's tag is
 * never handed to another (schedules and site marks stay unambiguous).
 */
export function nextTerminalTag(scene: ReadonlyArray<Pick<HvacElement, 'label'>>, spec: Pick<DuctTerminalSpec, 'kind' | 'service'>): string {
  const prefix = terminalTypeTag(spec);
  let highest = 0;
  for (const element of scene) {
    const match = TERMINAL_TAG_PATTERN.exec((element.label ?? '').trim());
    if (match && match[1] === prefix) highest = Math.max(highest, Number(match[2]));
  }
  return `${prefix}-${highest + 1}`;
}

/** What a terminal's pressure drop is worked from (Duct systems settings). */
export type TerminalDropSettings = Pick<DuctDesignSettings,
  'autoDiffuserDropPa' | 'autoGrilleDropPa' | 'filterG4RatedDropPa' | 'filterM5RatedDropPa' | 'filterRatedVelocityMs' | 'filterDesignFactor'>;

/** The face area the air (and a filter behind it) passes through (m²). */
export function terminalFaceAreaM2(spec: Pick<DuctTerminalSpec, 'kind' | 'faceWidthMm' | 'faceDepthMm'>): number {
  const area = spec.kind === 'round' ? (Math.PI / 4) * spec.faceWidthMm ** 2 : spec.faceWidthMm * spec.faceDepthMm;
  return Math.max(area, 1) / 1e6;
}

/**
 * The drop across a filter grille's media at an airflow (Pa, practice): the
 * class's clean drop at its rated face velocity, scaled linearly with the face
 * velocity (panel media run laminar at these speeds) and by the mid-life
 * design factor between clean and change-out.
 */
export function terminalFilterDropPa(spec: Pick<DuctTerminalSpec, 'kind' | 'faceWidthMm' | 'faceDepthMm' | 'filter'>, airflowM3h: number, settings: TerminalDropSettings): number {
  if (!spec.filter || !(airflowM3h > 0)) return 0;
  const faceVelocityMs = airflowM3h / 3600 / terminalFaceAreaM2(spec);
  const rated = spec.filter === 'M5' ? settings.filterM5RatedDropPa : settings.filterG4RatedDropPa;
  return rated * (faceVelocityMs / Math.max(settings.filterRatedVelocityMs, 0.1)) * settings.filterDesignFactor;
}

/**
 * The pressure across a terminal at its airflow (Pa): the service's placeholder
 * drop for the face (supply diffuser, return grille) and its filter, if any.
 * One formula for the optimiser's model and for the verified pressure.
 */
export function terminalPressureDropPa(spec: Pick<DuctTerminalSpec, 'kind' | 'service' | 'faceWidthMm' | 'faceDepthMm' | 'filter'>, airflowM3h: number, settings: TerminalDropSettings): number {
  const base = spec.service === 'return' ? settings.autoGrilleDropPa : settings.autoDiffuserDropPa;
  return base + terminalFilterDropPa(spec, airflowM3h, settings);
}

/** Each terminal's drop in a scene, for `systemPressure` (null for an id that is not a terminal). */
export function terminalDropLookup(scene: readonly HvacElement[], settings: TerminalDropSettings): (terminalId: string, airflowM3h: number) => number | null {
  const specs = new Map<string, DuctTerminalSpec>();
  for (const element of scene) {
    const spec = isDuctTerminalElement(element) ? readDuctTerminalSpec(element) : null;
    if (spec) specs.set(element.id, spec);
  }
  return (terminalId, airflowM3h) => {
    const spec = specs.get(terminalId);
    return spec ? terminalPressureDropPa(spec, airflowM3h, settings) : null;
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
