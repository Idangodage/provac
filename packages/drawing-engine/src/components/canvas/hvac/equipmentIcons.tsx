/**
 * Line-art icons for HVAC equipment: one 24-unit grid, 1.5 stroke, round
 * caps, currentColor (the same weight as the toolbar's icons), each drawn as
 * the thing reads on a drawing: a cassette's four slots, a ducted unit's two
 * collars, an outdoor unit's fan, a Y branch joint, a diffuser's plan symbol.
 */
import type { ReactElement, SVGProps } from 'react';

import type { AcEquipmentDefinition, AcEquipmentLibraryCategory } from '../../../data';

export type EquipmentIconKind =
  | 'cassette' | 'wall-unit' | 'ceiling-suspended' | 'ducted' | 'outdoor'
  | 'branch-kit' | 'floor-gully' | 'stack' | 'wall-discharge' | 'drop'
  | 'diffuser-square' | 'diffuser-round' | 'diffuser-linear' | 'return-grille'
  | 'grille-louvred' | 'diffuser-perforated' | 'grille-filter'
  | 'controller' | 'remote' | 'filter' | 'generic';

const PATHS: Record<EquipmentIconKind, ReactElement> = {
  cassette: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M7 5.9h10M7 18.1h10M5.9 7v10M18.1 7v10" />
      <rect x="8.75" y="8.75" width="6.5" height="6.5" rx="0.8" />
      <path d="M8.75 12h6.5M12 8.75v6.5" strokeWidth="1" />
    </>
  ),
  'wall-unit': (
    <>
      <rect x="2.5" y="4.5" width="19" height="9" rx="3" />
      <path d="M5.5 11h13" />
      <circle cx="17.6" cy="7.6" r="0.7" fill="currentColor" stroke="none" />
      <path d="M7.5 16.5q-1 1.9 0 3.8M12 16.5q-1 1.9 0 3.8M16.5 16.5q-1 1.9 0 3.8" />
    </>
  ),
  'ceiling-suspended': (
    <>
      <path d="M2 3h20M7 3v3.5M17 3v3.5" />
      <rect x="3" y="6.5" width="18" height="7" rx="2" />
      <path d="M5.5 13.5l1.2 2.5h10.6l1.2-2.5" />
      <path d="M8.5 18.5v2.5M12 18.5v2.5M15.5 18.5v2.5" />
    </>
  ),
  ducted: (
    <>
      <rect x="5.5" y="6.5" width="13" height="11" rx="1.5" />
      <path d="M5.5 9.25H2.5v5.5h3M18.5 8.25h3v7.5h-3" />
      <circle cx="12" cy="12" r="3.1" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
      <path d="M12 8.9v2.3M14.7 13.55l-2-1.15M9.3 13.55l2-1.15" strokeWidth="1.1" />
    </>
  ),
  outdoor: (
    <>
      <rect x="2.5" y="4.5" width="19" height="14.5" rx="1.5" />
      <circle cx="9.75" cy="11.75" r="4.9" />
      <circle cx="9.75" cy="11.75" r="2.3" strokeWidth="1.1" />
      <circle cx="9.75" cy="11.75" r="0.7" fill="currentColor" stroke="none" />
      <path d="M16.25 8h3M16.25 10.5h3M16.25 13h3M16.25 15.5h3" strokeWidth="1.1" />
      <path d="M5 19v1.75M19 19v1.75" />
    </>
  ),
  'branch-kit': (
    <>
      <path d="M2.5 12H8.5" />
      <path d="M8.5 12c3.2 0 3.8-4.75 7.5-4.75h5.5M8.5 12c3.2 0 3.8 4.75 7.5 4.75h5.5" />
      <path d="M8.5 10.25v3.5M17.5 5.5v3.5M17.5 15v3.5" />
    </>
  ),
  'floor-gully': (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <rect x="7" y="7" width="10" height="10" rx="1" />
      <path d="M9.25 9.5h5.5M9.25 12h5.5M9.25 14.5h5.5" strokeWidth="1.1" />
    </>
  ),
  stack: (
    <>
      <path d="M15 2.5v19M19.5 2.5v19" />
      <path d="M3 9.75h12M3 13.75h12" />
      <circle cx="8.5" cy="11.75" r="1.6" />
      <path d="M15 8.25h4.5M15 15.25h4.5" strokeWidth="1" />
    </>
  ),
  'wall-discharge': (
    <>
      <path d="M10 2.5v19M14 2.5v19" />
      <path d="M10 6.5l4-3M10 10.5l4-3M10 14.5l4-3M10 18.5l4-3M10 21.5l4-3" strokeWidth="0.9" />
      <path d="M2.5 12H18c1.66 0 3 1.34 3 3v2" />
      <circle cx="21" cy="20" r="0.95" fill="currentColor" stroke="none" />
    </>
  ),
  drop: (
    <path d="M12 3.25c3.1 4.1 6 7.3 6 10.6a6 6 0 0 1-12 0c0-3.3 2.9-6.5 6-10.6z" />
  ),
  'diffuser-square': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <rect x="7.75" y="7.75" width="8.5" height="8.5" rx="0.6" />
      <path d="M3.9 3.9l3.85 3.85M20.1 3.9l-3.85 3.85M3.9 20.1l3.85-3.85M20.1 20.1l-3.85-3.85" />
    </>
  ),
  'diffuser-round': (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  'diffuser-linear': (
    <>
      <rect x="2" y="7.5" width="20" height="9" rx="1.5" />
      <path d="M5 10.5h14M5 13.5h14" />
    </>
  ),
  'return-grille': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M6.6 3v18M10.2 3v18M13.8 3v18M17.4 3v18M3 6.6h18M3 10.2h18M3 13.8h18M3 17.4h18" strokeWidth="0.9" />
    </>
  ),
  'grille-louvred': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M6 9l3-3M6 13l7-7M6 17l11-11M9 18l9-9M13 18l5-5" strokeWidth="1.1" />
    </>
  ),
  'diffuser-perforated': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <rect x="6" y="6" width="12" height="12" rx="0.6" strokeWidth="1" />
      {[8.25, 12, 15.75].flatMap((x) => [8.25, 12, 15.75].map((y) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="0.85" fill="currentColor" stroke="none" />
      )))}
    </>
  ),
  'grille-filter': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M8.4 3v18M15.6 3v18M3 8.4h18M3 15.6h18" strokeWidth="0.9" />
      <path d="M5 13.5l1.75-3 1.75 3 1.75-3 1.75 3 1.75-3 1.75 3 1.75-3 1.75 3" strokeWidth="1.3" />
    </>
  ),
  controller: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <rect x="7.5" y="5.5" width="9" height="6" rx="1" />
      <circle cx="9" cy="15" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="15" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="0.9" fill="currentColor" stroke="none" />
      <path d="M9 18.25h6" />
    </>
  ),
  remote: (
    <>
      <rect x="8" y="2.5" width="8" height="19" rx="2.5" />
      <rect x="9.75" y="5" width="4.5" height="3.5" rx="0.6" />
      <circle cx="12" cy="12" r="1.3" />
      <path d="M10 15.5h4M10 18h4" />
    </>
  ),
  filter: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M5.5 7.5l1.75 9 1.75-9 1.75 9 1.75-9 1.75 9 1.75-9 1.75 9 1.5-7.5" strokeWidth="1.1" />
    </>
  ),
  generic: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="M8 10h8M8 14h5" />
    </>
  ),
};

export interface EquipmentIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  kind: EquipmentIconKind;
  size?: number;
}

export function EquipmentIcon({ kind, size = 24, strokeWidth = 1.5, ...rest }: EquipmentIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {PATHS[kind]}
    </svg>
  );
}

/** The icon a library entry reads as. */
export function equipmentIconKind(definition: Pick<AcEquipmentDefinition, 'type' | 'subtype'> & Partial<Pick<AcEquipmentDefinition, 'defaultProperties'>>): EquipmentIconKind {
  switch (definition.type) {
    case 'ceiling-cassette-ac': return 'cassette';
    case 'wall-mounted-ac': return 'wall-unit';
    case 'ceiling-suspended-ac': return 'ceiling-suspended';
    case 'ducted-ac': return 'ducted';
    case 'outdoor-unit': return 'outdoor';
    case 'refrigerant-branch-kit': return 'branch-kit';
    case 'condensate-gully':
      return definition.subtype === 'stack-connection' ? 'stack' : definition.subtype === 'external-discharge' ? 'wall-discharge' : 'floor-gully';
    case 'diffuser':
    case 'return-grille': {
      const terminal = definition.defaultProperties?.terminal as { filter?: string | null } | undefined;
      if (terminal?.filter) return 'grille-filter';
      switch (definition.subtype) {
        case 'round': return 'diffuser-round';
        case 'linear-slot': return 'diffuser-linear';
        case 'louvred': return 'grille-louvred';
        case 'perforated': return 'diffuser-perforated';
        case 'square-4way': return 'diffuser-square';
        default: return definition.type === 'return-grille' ? 'return-grille' : 'diffuser-square';
      }
    }
    case 'control-panel': return 'controller';
    case 'remote-controller': return 'remote';
    case 'filter': return 'filter';
    default: return 'generic';
  }
}

export const EQUIPMENT_CATEGORY_ICONS: Record<AcEquipmentLibraryCategory, EquipmentIconKind> = {
  'indoor-units': 'cassette',
  'outdoor-units': 'outdoor',
  controls: 'controller',
  accessories: 'branch-kit',
  drainage: 'drop',
  'air-terminals': 'diffuser-square',
  'return-air-terminals': 'return-grille',
};
