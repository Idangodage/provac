/**
 * Typical air-terminal sizes (practice: SMACNA gives none). A pure table with
 * no dependencies, so the equipment library can build its entries from it; the
 * chosen supplier's data replaces it later (your decision, 27 September 2026).
 */
import type { DuctService } from './ductTypes';

export type DuctTerminalKind = 'square-4way' | 'round' | 'linear-slot' | 'return-egg-crate';
export type DuctTerminalSpigotSide = 'back' | 'front' | 'left' | 'right';

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
}

export const DUCT_TERMINAL_NECKS_MM = [150, 200, 250, 300] as const;

/** Spigot projection from the plenum box: a collar ≥ 51 mm (SMACNA S3.30) plus the bead. Practice. */
export const TERMINAL_SPIGOT_LENGTH_MM = 60;

export const TERMINAL_LABELS: Record<DuctTerminalKind, string> = {
  'square-4way': 'Square 4-way ceiling diffuser',
  round: 'Round ceiling diffuser',
  'linear-slot': 'Linear slot diffuser',
  'return-egg-crate': 'Egg-crate return grille',
};

/**
 * The typical terminal of a kind and neck (practice table): a 595 lay-in face
 * (600 surface) on a 530 plenum box, the box one neck + 100 mm tall; a round
 * face about twice the neck; a linear diffuser's plenum one neck + 100 wide.
 */
export function typicalTerminalSpec(
  kind: DuctTerminalKind,
  neckDiameterMm: number,
  options: { mount?: 'lay-in' | 'surface'; slots?: number; lengthMm?: number } = {},
): DuctTerminalSpec {
  const neck = Math.max(100, neckDiameterMm);
  const mount = options.mount ?? 'lay-in';
  const plenumHeightMm = neck + 100;
  switch (kind) {
    case 'round': {
      const face = Math.max(300, 2 * neck + 50);
      return {
        kind, service: 'supply', mount, faceWidthMm: face, faceDepthMm: face, faceHeightMm: 40, neckDiameterMm: neck,
        plenumWidthMm: neck + 200, plenumDepthMm: neck + 200, plenumHeightMm, spigotSide: 'back', spigotLengthMm: TERMINAL_SPIGOT_LENGTH_MM,
      };
    }
    case 'linear-slot': {
      const slots = Math.min(4, Math.max(1, Math.round(options.slots ?? 2)));
      const length = Math.max(600, options.lengthMm ?? 1200);
      return {
        kind, service: 'supply', mount, faceWidthMm: length, faceDepthMm: slots * 20 + 50, faceHeightMm: 30, neckDiameterMm: neck,
        plenumWidthMm: length - 50, plenumDepthMm: neck + 100, plenumHeightMm, spigotSide: 'back', spigotLengthMm: TERMINAL_SPIGOT_LENGTH_MM, slots,
      };
    }
    case 'return-egg-crate':
      return {
        kind, service: 'return', mount, faceWidthMm: 595, faceDepthMm: 595, faceHeightMm: 30, neckDiameterMm: neck,
        plenumWidthMm: 530, plenumDepthMm: 530, plenumHeightMm, spigotSide: 'back', spigotLengthMm: TERMINAL_SPIGOT_LENGTH_MM,
      };
    default: {
      const face = mount === 'surface' ? 600 : 595;
      return {
        kind: 'square-4way', service: 'supply', mount, faceWidthMm: face, faceDepthMm: face, faceHeightMm: mount === 'surface' ? 40 : 35,
        neckDiameterMm: neck, plenumWidthMm: 530, plenumDepthMm: 530, plenumHeightMm, spigotSide: 'back', spigotLengthMm: TERMINAL_SPIGOT_LENGTH_MM,
      };
    }
  }
}
