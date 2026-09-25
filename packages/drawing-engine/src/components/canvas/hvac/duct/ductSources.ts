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
  | 'project-configuration';

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
  'project-configuration': {
    document: 'Project configuration (fabricator / supplier stock)',
  },
};

/** A rule's provenance: its source, and whether the value was checked against it. */
export interface DuctRuleProvenance {
  sourceId: DuctSourceId;
  reference?: string;
  verified: boolean;
  note?: string;
}
