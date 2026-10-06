/**
 * Typical air-terminal sizes (practice: SMACNA gives none). A pure table with
 * no dependencies, so the equipment library can build its entries from it; the
 * chosen supplier's data replaces it later (your decision, 27 September 2026).
 *
 * The face (kind) and the service are independent: a square 4-way face can be
 * a supply diffuser or a return diffuser, a louvred face a return grille. The
 * element type carries the service (`diffuser` = supply, `return-grille` =
 * return), so drawings made before return diffusers existed read unchanged.
 */
import type { DuctService } from './ductTypes';

export type DuctTerminalKind = 'square-4way' | 'round' | 'linear-slot' | 'return-egg-crate' | 'perforated' | 'louvred';
export type DuctTerminalSpigotSide = 'back' | 'front' | 'left' | 'right';
/** Filter media in a terminal's face (EN 779 classes; the ISO 16890 / MERV equivalents are approximate). */
export type DuctTerminalFilterClass = 'G4' | 'M5';

export const DUCT_TERMINAL_KINDS: readonly DuctTerminalKind[] = ['square-4way', 'round', 'linear-slot', 'return-egg-crate', 'perforated', 'louvred'];
export const DUCT_TERMINAL_FILTER_CLASSES: readonly DuctTerminalFilterClass[] = ['G4', 'M5'];

export interface DuctTerminalSpec {
  kind: DuctTerminalKind;
  service: DuctService;
  mount: 'lay-in' | 'surface';
  /** Visible face (a round face: Ø = width = depth) and its thickness below the plenum (mm). */
  faceWidthMm: number;
  faceDepthMm: number;
  faceHeightMm: number;
  /** Round spigot on the plenum box (mm). */
  neckDiameterMm: number;
  plenumWidthMm: number;
  plenumDepthMm: number;
  plenumHeightMm: number;
  spigotSide: DuctTerminalSpigotSide;
  spigotLengthMm: number;
  /** Linear slot diffusers. */
  slots?: number;
  /** Design airflow through this terminal (m³/h); absent = an equal share of its unit's airflow. */
  designAirflowM3h?: number | null;
  /** Filter media behind the face (a hinged filter grille); absent or null = none. */
  filter?: DuctTerminalFilterClass | null;
}

export const DUCT_TERMINAL_NECKS_MM = [150, 200, 250, 300] as const;

/** Spigot projection from the plenum box: a collar ≥ 51 mm (SMACNA S3.30) plus the bead. Practice. */
export const TERMINAL_SPIGOT_LENGTH_MM = 60;
/** Filter panel behind a filter grille's hinged face (mm, practice). */
export const TERMINAL_FILTER_THICKNESS_MM = 25;

/** The face as a catalogue names it, whatever the service. */
export const TERMINAL_FACE_LABELS: Record<DuctTerminalKind, string> = {
  'square-4way': 'Square 4-way',
  round: 'Round',
  'linear-slot': 'Linear slot',
  'return-egg-crate': 'Egg-crate',
  perforated: 'Perforated',
  louvred: 'Louvred',
};

/** The faces offered for each service (in ceilings a louvred or egg-crate face is a return grille). */
export const TERMINAL_FACES_BY_SERVICE: Record<DuctService, readonly DuctTerminalKind[]> = {
  supply: ['square-4way', 'round', 'linear-slot', 'perforated'],
  return: ['return-egg-crate', 'louvred', 'perforated', 'square-4way', 'round', 'linear-slot'],
};

/** The usual name of each face in the service it is usually used for. */
export const TERMINAL_LABELS: Record<DuctTerminalKind, string> = {
  'square-4way': 'Square 4-way ceiling diffuser',
  round: 'Round ceiling diffuser',
  'linear-slot': 'Linear slot diffuser',
  'return-egg-crate': 'Egg-crate return grille',
  perforated: 'Perforated return diffuser',
  louvred: 'Louvred return grille',
};

const SUPPLY_LABELS: Record<DuctTerminalKind, string> = {
  'square-4way': 'Square 4-way ceiling diffuser',
  round: 'Round ceiling diffuser',
  'linear-slot': 'Linear slot diffuser',
  'return-egg-crate': 'Egg-crate supply grille',
  perforated: 'Perforated supply diffuser',
  louvred: 'Louvred supply grille',
};

const RETURN_LABELS: Record<DuctTerminalKind, string> = {
  'square-4way': 'Square return diffuser',
  round: 'Round return diffuser',
  'linear-slot': 'Linear slot return',
  'return-egg-crate': 'Egg-crate return grille',
  perforated: 'Perforated return diffuser',
  louvred: 'Louvred return grille',
};

/** Filter classes as a schedule names them, with their approximate equivalents. */
export const TERMINAL_FILTER_LABELS: Record<DuctTerminalFilterClass, { label: string; equivalent: string }> = {
  G4: { label: 'G4 coarse', equivalent: '≈ ISO Coarse 60 % · ≈ MERV 7' },
  M5: { label: 'M5 medium', equivalent: '≈ ISO ePM10 50 % · ≈ MERV 8' },
};

/** "Square return diffuser", "Egg-crate return grille with G4 filter" … */
export function terminalLabel(spec: Pick<DuctTerminalSpec, 'kind' | 'service' | 'filter'>): string {
  const name = (spec.service === 'return' ? RETURN_LABELS : SUPPLY_LABELS)[spec.kind];
  return spec.filter ? `${name} with ${spec.filter} filter` : name;
}

/** Faces whose plenum box is square or round: the box reads the same whichever side its spigot is on. */
export const SQUARE_BOX_TERMINAL_KINDS: ReadonlySet<DuctTerminalKind> = new Set(['square-4way', 'round', 'return-egg-crate', 'perforated', 'louvred']);

/** A grille face (rather than a diffuser face): egg-crate and louvred. */
function isGrilleFace(kind: DuctTerminalKind): boolean {
  return kind === 'return-egg-crate' || kind === 'louvred';
}

/**
 * The type tag drawings and schedules use (regional MEP practice): SAD supply
 * air diffuser, SAG supply air grille, LSD linear slot diffuser, RAD return air
 * diffuser, RAG return air grille, LRG linear return grille.
 */
export function terminalTypeTag(spec: Pick<DuctTerminalSpec, 'kind' | 'service'>): string {
  if (spec.kind === 'linear-slot') return spec.service === 'return' ? 'LRG' : 'LSD';
  if (spec.service === 'return') return isGrilleFace(spec.kind) ? 'RAG' : 'RAD';
  return isGrilleFace(spec.kind) ? 'SAG' : 'SAD';
}

/** A short instance tag such as "RAG-3" (what new terminals are labelled). */
export const TERMINAL_TAG_PATTERN = /^([A-Z]{2,4})-(\d+)$/;

/** The service a face is used for when nothing else says. */
export function defaultTerminalService(kind: DuctTerminalKind): DuctService {
  return kind === 'return-egg-crate' || kind === 'perforated' || kind === 'louvred' ? 'return' : 'supply';
}

export interface TypicalTerminalOptions {
  mount?: 'lay-in' | 'surface';
  slots?: number;
  lengthMm?: number;
  service?: DuctService;
  filter?: DuctTerminalFilterClass | null;
}

/**
 * The typical terminal of a kind and neck (practice table): a 595 lay-in face
 * (600 surface) on a 530 plenum box, the box one neck + 100 mm tall; a round
 * face about twice the neck; a linear diffuser's plenum one neck + 100 wide.
 */
export function typicalTerminalSpec(kind: DuctTerminalKind, neckDiameterMm: number, options: TypicalTerminalOptions = {}): DuctTerminalSpec {
  const neck = Math.max(100, neckDiameterMm);
  const mount = options.mount ?? 'lay-in';
  const service = options.service ?? defaultTerminalService(kind);
  const filter = options.filter ?? null;
  const plenumHeightMm = neck + 100;
  const common = { service, mount, neckDiameterMm: neck, plenumHeightMm, spigotSide: 'back' as const, spigotLengthMm: TERMINAL_SPIGOT_LENGTH_MM, ...(filter ? { filter } : {}) };
  switch (kind) {
    case 'round': {
      const face = Math.max(300, 2 * neck + 50);
      return { ...common, kind, faceWidthMm: face, faceDepthMm: face, faceHeightMm: 40, plenumWidthMm: neck + 200, plenumDepthMm: neck + 200 };
    }
    case 'linear-slot': {
      const slots = Math.min(4, Math.max(1, Math.round(options.slots ?? 2)));
      const length = Math.max(600, options.lengthMm ?? 1200);
      return { ...common, kind, faceWidthMm: length, faceDepthMm: slots * 20 + 50, faceHeightMm: 30, plenumWidthMm: length - 50, plenumDepthMm: neck + 100, slots };
    }
    case 'return-egg-crate':
    case 'perforated':
    case 'louvred': {
      const face = mount === 'surface' ? 600 : 595;
      return { ...common, kind, faceWidthMm: face, faceDepthMm: face, faceHeightMm: kind === 'louvred' ? 35 : 30, plenumWidthMm: 530, plenumDepthMm: 530 };
    }
    default: {
      const face = mount === 'surface' ? 600 : 595;
      return { ...common, kind: 'square-4way', faceWidthMm: face, faceDepthMm: face, faceHeightMm: mount === 'surface' ? 40 : 35, plenumWidthMm: 530, plenumDepthMm: 530 };
    }
  }
}
