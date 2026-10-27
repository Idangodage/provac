/**
 * Manufacturer specifications of the placeable AC units, by model code: what
 * the unit panel shows and what duct design reads beyond the airflow (the
 * fan's ESP range and settings). Every unit carries its sources; a value not
 * in a source is left out rather than guessed.
 *
 * Sources:
 *  - MHI spec sheet '12•KX-DB-175 (PJG000Z033), KX VRF FDUM KXE6F series
 *    (duct connected, low/middle static pressure);
 *  - MHI technical manual '14•KX-T-222, FDU224/280KXZE1 (duct connected, high
 *    static pressure): §1.1 specifications, §2.1 exterior dimensions
 *    (PJG000Z287), §4.1 characteristics of fan;
 *  - MEPcontent MACO VRF IFC files (duct connection sizes of FDUM140KXE6F).
 */
import type { FanSpeed } from '../components/canvas/hvac/duct/ductSizing';
import type { HvacElement } from '../types';

export interface UnitSpecSource {
  id: string;
  /** The document as its maker titles it. */
  document: string;
  /** Where in it. */
  reference: string;
  url?: string;
}

export interface UnitEspSpecification {
  /** Highest external static pressure the fan can be set to (Pa), and the airflow it is rated at there (m³/min). */
  maxPa: number;
  atAirflowM3min: number | null;
  /** The ESP the rated capacity is measured at (Pa). */
  ratedPa: number | null;
  /** Settings the wired remote offers (Pa), ascending. */
  settingsPa?: number[];
  /** The setting range as delivered (Pa), and what extends it. */
  factoryRangePa?: [number, number];
  extendedBy?: string;
}

export interface AcUnitSpecification {
  modelCode: string;
  manufacturer: string;
  /** Product range and type as the maker names them. */
  range: string;
  coolingKw: number;
  heatingKw: number | null;
  /** Airflow by fan speed (m³/min, cooling, standard). */
  airflowM3min: Record<FanSpeed, number> | null;
  esp: UnitEspSpecification | null;
  /** Casing H × W × D (mm), without collars, connections or hanger plates. */
  casingMm: { height: number; width: number; depth: number };
  weightKg: number | null;
  refrigerant: string;
  liquidMm: number;
  gasMm: number;
  joint: 'flare' | 'brazing';
  drain: { connection: string; pump: boolean };
  power: { supply: string; inputKw: string | null };
  /** Sound pressure by fan speed (dB(A), anechoic). */
  soundDbA: Partial<Record<FanSpeed, number>> | null;
  fan: string | null;
  /** Duct connections as the maker gives them (W × H, mm). */
  collars: { supply: [number, number]; return: [number, number] } | null;
  /** The 3D body: the maker's model (converted IFC), or drawn to the maker's dimension drawing. */
  body: 'catalog-3d' | 'drawn-to-dimensions';
  sources: UnitSpecSource[];
}

const KX_DB_175: UnitSpecSource = {
  id: 'mhi-kx-db-175',
  document: 'MHI spec sheet \'12•KX-DB-175 — FDUM KXE6F (duct connected, low/middle static pressure)',
  reference: 'Specifications, PJG000Z033',
  url: 'https://mhi-hvac.co.uk/wp-content/uploads/FDUM-KXE6F-Spec-sheet.pdf',
};

const KX_T_222: UnitSpecSource = {
  id: 'mhi-kx-t-222',
  document: 'MHI technical manual \'14•KX-T-222 — FDU224/280KXZE1 (duct connected, high static pressure)',
  reference: '§1.1 specifications; §2.1 exterior dimensions (PJG000Z287); §4.1 characteristics of fan',
  url: 'https://www.coolmark.nl/media/files/handboek/mhi/2014%20(FDU224-280KXZE1)%20KX-T-222.pdf',
};

const MEPCONTENT_FDUM140: UnitSpecSource = {
  id: 'mepcontent-maco-fdum140kxe6f',
  document: 'MEPcontent MACO VRF IFC — FDUM140KXE6F',
  reference: 'Supply / Return Air Duct Width × Height properties; collars measured on the converted model',
};

const FDUM_SMALL = {
  manufacturer: 'Mitsubishi Heavy Industries',
  range: 'KX VRF · duct connected, low/middle static pressure (FDUM)',
  casingMm: { height: 280, width: 750, depth: 635 },
  weightKg: 29,
  refrigerant: 'R410A',
  joint: 'flare' as const,
  drain: { connection: 'VP20 (VP25 with the attached socket)', pump: true },
  fan: 'Centrifugal × 1, 100 W',
};

const FDUM_LARGE = {
  manufacturer: 'Mitsubishi Heavy Industries',
  range: 'KX VRF · duct connected, low/middle static pressure (FDUM)',
  casingMm: { height: 280, width: 1370, depth: 740 },
  weightKg: 54,
  refrigerant: 'R410A',
  liquidMm: 9.52,
  gasMm: 15.88,
  joint: 'flare' as const,
  drain: { connection: 'VP20 (VP25 with the attached socket)', pump: true },
  fan: 'Centrifugal × 3, 100 + 200 W',
  collars: { supply: [1200, 170] as [number, number], return: [1280, 235] as [number, number] },
  body: 'catalog-3d' as const,
  sources: [KX_DB_175, MEPCONTENT_FDUM140],
};

/** FDU224/280KXZE1 ESP settings: 80–150 Pa as delivered; 10–200 Pa with SW8-4 ON (wired remote RC-EX1A / RC-E5). */
const FDU_ESP_SETTINGS = [10, 20, 40, 60, 80, 100, 120, 140, 150, 160, 180, 200];

const FDU = {
  manufacturer: 'Mitsubishi Heavy Industries',
  range: 'KX VRF · duct connected, high static pressure (FDU)',
  airflowM3min: { 'p-hi': 80, hi: 72, me: 64, lo: 56 },
  esp: {
    maxPa: 200, atAirflowM3min: 80, ratedPa: 72, settingsPa: FDU_ESP_SETTINGS, factoryRangePa: [80, 150] as [number, number],
    extendedBy: 'SW8-4 ON, set from the RC-EX1A / RC-E5 wired remote',
  },
  casingMm: { height: 379, width: 1600, depth: 893 },
  weightKg: 89,
  refrigerant: 'R410A',
  liquidMm: 9.52,
  joint: 'brazing' as const,
  // The maker's drawing shows a gravity drain; the project still draws a built-in pump (condensatePorts unitHasDrainPump).
  drain: { connection: 'VP25 (O.D. 32)', pump: false },
  power: { supply: '1 phase 220–240 V 50 Hz / 220 V 60 Hz', inputKw: '1.16–1.20' },
  soundDbA: { 'p-hi': 52, hi: 50, me: 47, lo: 45 },
  fan: 'Centrifugal × 3, 130 + 350 W',
  collars: { supply: [1450, 250] as [number, number], return: [1450, 250] as [number, number] },
  body: 'drawn-to-dimensions' as const,
  sources: [KX_T_222],
};

export const UNIT_SPECIFICATIONS: Readonly<Record<string, AcUnitSpecification>> = {
  'FDUM22KXE6F-W': {
    ...FDUM_SMALL,
    modelCode: 'FDUM22KXE6F-W',
    coolingKw: 2.2,
    heatingKw: 2.5,
    airflowM3min: { 'p-hi': 13, hi: 10, me: 9, lo: 8 },
    esp: { maxPa: 100, atAirflowM3min: 13, ratedPa: 35 },
    liquidMm: 6.35,
    gasMm: 9.52,
    power: { supply: '1 phase 220–240 V 50 Hz / 220 V 60 Hz', inputKw: '0.10' },
    soundDbA: { 'p-hi': 37, hi: 32, me: 29, lo: 26 },
    // As measured on the maker's 3D model (the sheet: about 680 × 170 and 660 × 200).
    collars: { supply: [674, 164], return: [654, 194] },
    body: 'catalog-3d',
    sources: [KX_DB_175],
  },
  FDUM140KXE6F: {
    ...FDUM_LARGE,
    modelCode: 'FDUM140KXE6F',
    coolingKw: 14,
    heatingKw: 16,
    airflowM3min: { 'p-hi': 39, hi: 32, me: 26, lo: 20 },
    esp: { maxPa: 100, atAirflowM3min: 39, ratedPa: 60 },
    power: { supply: '1 phase 220–240 V 50 Hz / 220 V 60 Hz', inputKw: '0.33' },
    soundDbA: { 'p-hi': 45, hi: 40, me: 34, lo: 29 },
  },
  FDUM160KXE6F: {
    ...FDUM_LARGE,
    modelCode: 'FDUM160KXE6F',
    coolingKw: 16,
    heatingKw: 18,
    airflowM3min: { 'p-hi': 48, hi: 35, me: 28, lo: 22 },
    esp: { maxPa: 100, atAirflowM3min: 48, ratedPa: 60 },
    power: { supply: '1 phase 220–240 V 50 Hz / 220 V 60 Hz', inputKw: '0.45' },
    soundDbA: { 'p-hi': 47, hi: 40, me: 35, lo: 30 },
  },
  FDU224KXZE1: { ...FDU, modelCode: 'FDU224KXZE1', coolingKw: 22.4, heatingKw: 25, gasMm: 19.05 },
  FDU280KXZE1: { ...FDU, modelCode: 'FDU280KXZE1', coolingKw: 28, heatingKw: 31.5, gasMm: 22.22 },
};

/** The specification of a placed unit: by its model code (or model), else null. */
export function unitSpecificationFor(element: Pick<HvacElement, 'properties'>): AcUnitSpecification | null {
  for (const key of ['modelCode', 'model']) {
    const value = element.properties?.[key];
    if (typeof value === 'string' && UNIT_SPECIFICATIONS[value]) return UNIT_SPECIFICATIONS[value]!;
  }
  return null;
}

/** m³/min → m³/h. */
export function m3minToM3h(value: number): number {
  return value * 60;
}
