/**
 * Where every duct construction number comes from. Rules and catalog rows cite
 * a source id; the panel shows the document and whether the value has been
 * checked against it. See docs/hvac-duct-smacna-research.md.
 */

export type DuctSourceId =
  | 'smacna-1995'
  | 'ductmate-spec'
  | 'institutional-specs'
  | 'fabricator-practice'
  | 'astm-a653'
  | 'fdum22-glb-measured'
  | 'project-practice'
  | 'project-configuration'
  | 'armacell-520'
  | 'mhi-fdum22-data';

export interface DuctSource {
  document: string;
  url?: string;
}

export const DUCT_SOURCES: Record<DuctSourceId, DuctSource> = {
  'smacna-1995': {
    document: 'SMACNA HVAC Duct Construction Standards, Metal and Flexible, 2nd ed. 1995 (Addendum 1, 1997)',
    url: 'https://law.resource.org/pub/us/cfr/ibr/005/smacna.duct.1995.html',
  },
  'ductmate-spec': {
    document: "Ductmate '25'/'35'/'45' systems specification",
    url: 'https://ductmate.com/wp-content/uploads/2019/01/DuctmateSystemsSpec.pdf',
  },
  'institutional-specs': {
    document: 'Owner construction specifications citing SMACNA (Dartmouth 23 31 13, Texas State 23 31 00)',
  },
  'fabricator-practice': {
    document: 'Common fabricator practice (no primary document)',
  },
  'astm-a653': {
    document: 'Steel density 7850 kg/m³ + ASTM A653 G-60 zinc coating (183 g/m², both sides)',
  },
  'fdum22-glb-measured': {
    document: 'Collars measured on the MEPcontent MACO VRF FDUM22KXE6F-W model; face assignment confirmed against MHI dimensions',
  },
  'project-practice': {
    document: 'Project practice: SMACNA gives no value; set to the fabricator\'s standard',
  },
  'project-configuration': {
    document: 'Project configuration (fabricator / supplier stock)',
  },
  'mhi-fdum22-data': {
    document: 'MHI FDUM22KXE6F product data: airflow P-Hi 13 / Hi 10 / Me 9 / Lo 8 m³/min (cooling), maximum external static pressure 100 Pa (MHIAE and Form MHI product pages, read 28 September 2026)',
    url: 'https://mhiae.com/units/fdum22kxe6f/',
  },
  'armacell-520': {
    document: 'Armacell ArmaFlex 520 adhesive product brochure (coverage 7–9 m²/L, both faces, sheet)',
    url: 'https://www.armacell.com/sites/default/files/2025/06/10/ArmaFlex%20520%20Adhesive%20-%20Product%20Brochure%20-%20en-LU.pdf',
  },
};

/** Practice and configuration values have no document to verify against; the panel labels them as such. */
export function isPracticeSource(sourceId: DuctSourceId): boolean {
  return sourceId === 'project-practice' || sourceId === 'fabricator-practice' || sourceId === 'project-configuration';
}

/** A rule's provenance: its source, and whether the value was checked against it. */
export interface DuctRuleProvenance {
  sourceId: DuctSourceId;
  reference?: string;
  verified: boolean;
  note?: string;
}
