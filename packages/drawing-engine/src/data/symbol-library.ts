/**
 * HVAC Symbol Library
 * 
 * Standard MEP symbols for HVAC drawings.
 * Follows industry-standard symbology for mechanical systems.
 */

import type { Point2D } from '../types';

// =============================================================================
// Symbol Types
// =============================================================================

export interface SymbolDefinition {
  id: string;
  name: string;
  category: SymbolCategory;
  description?: string;
  defaultWidth: number;
  defaultHeight: number;
  svgPath: string;
  connectionPoints?: Point2D[];
  metadata?: Record<string, unknown>;
}

export type SymbolCategory =
  | 'indoor-units'
  | 'outdoor-units'
  | 'diffusers'
  | 'grilles'
  | 'dampers'
  | 'fans'
  | 'ducts'
  | 'pipes'
  | 'valves'
  | 'sensors'
  | 'controls'
  | 'electrical'
  | 'plumbing'
  | 'annotations';

// =============================================================================
// Category Definitions
// =============================================================================

export const SYMBOL_CATEGORIES: { id: SymbolCategory; label: string; icon: string }[] = [
  { id: 'indoor-units', label: 'Indoor Units', icon: 'AirVent' },
  { id: 'outdoor-units', label: 'Outdoor Units', icon: 'Fan' },
  { id: 'diffusers', label: 'Diffusers', icon: 'Grid3X3' },
  { id: 'grilles', label: 'Grilles', icon: 'LayoutGrid' },
  { id: 'dampers', label: 'Dampers', icon: 'SlidersHorizontal' },
  { id: 'fans', label: 'Fans', icon: 'Fan' },
  { id: 'ducts', label: 'Duct Fittings', icon: 'BoxSelect' },
  { id: 'pipes', label: 'Piping', icon: 'Pipette' },
  { id: 'valves', label: 'Valves', icon: 'CircleDot' },
  { id: 'sensors', label: 'Sensors', icon: 'Thermometer' },
  { id: 'controls', label: 'Controls', icon: 'Gauge' },
  { id: 'electrical', label: 'Electrical', icon: 'Zap' },
  { id: 'plumbing', label: 'Plumbing', icon: 'Droplet' },
  { id: 'annotations', label: 'Annotations', icon: 'MessageSquare' },
];

// =============================================================================
// Indoor Units
// =============================================================================

const INDOOR_UNITS: SymbolDefinition[] = [
  {
    id: 'wall-mount-ac',
    name: 'Wall Mount AC',
    category: 'indoor-units',
    description: 'Wall-mounted split system indoor unit',
    defaultWidth: 1.2,
    defaultHeight: 0.4,
    svgPath: 'M 0 0 L 100 0 L 100 30 L 0 30 Z M 10 15 L 90 15 M 10 22 L 90 22',
    connectionPoints: [{ x: 50, y: 30 }],
  },
  {
    id: 'cassette-4way',
    name: '4-Way Cassette',
    category: 'indoor-units',
    description: 'Ceiling cassette with 4-way airflow',
    defaultWidth: 0.84,
    defaultHeight: 0.84,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 10 L 90 10 L 90 90 L 10 90 Z M 50 10 L 50 90 M 10 50 L 90 50',
    connectionPoints: [
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 },
    ],
  },
  {
    id: 'cassette-2way',
    name: '2-Way Cassette',
    category: 'indoor-units',
    description: 'Ceiling cassette with 2-way airflow',
    defaultWidth: 1.2,
    defaultHeight: 0.6,
    svgPath: 'M 0 0 L 100 0 L 100 50 L 0 50 Z M 10 10 L 90 10 L 90 40 L 10 40 Z M 10 25 L 90 25',
    connectionPoints: [
      { x: 0, y: 25 },
      { x: 100, y: 25 },
    ],
  },
  {
    id: 'floor-standing',
    name: 'Floor Standing',
    category: 'indoor-units',
    description: 'Floor-standing indoor unit',
    defaultWidth: 0.6,
    defaultHeight: 1.8,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 20 10 L 80 10 L 80 80 L 20 80 Z M 30 85 L 70 85 L 70 95 L 30 95 Z',
    connectionPoints: [{ x: 50, y: 0 }],
  },
  {
    id: 'concealed-duct',
    name: 'Concealed Duct Unit',
    category: 'indoor-units',
    description: 'Ducted indoor unit for ceiling void',
    defaultWidth: 1.4,
    defaultHeight: 0.5,
    svgPath: 'M 0 0 L 100 0 L 100 40 L 0 40 Z M 5 5 L 30 5 L 30 35 L 5 35 Z M 70 5 L 95 5 L 95 35 L 70 35 Z',
    connectionPoints: [
      { x: 17.5, y: 0 },
      { x: 82.5, y: 0 },
    ],
  },
  {
    id: 'fcu-horizontal',
    name: 'FCU Horizontal',
    category: 'indoor-units',
    description: 'Fan coil unit - horizontal configuration',
    defaultWidth: 1.2,
    defaultHeight: 0.4,
    svgPath: 'M 0 10 L 100 10 L 100 40 L 0 40 Z M 80 0 A 20 20 0 1 1 80 1 M 10 25 L 60 25',
    connectionPoints: [
      { x: 0, y: 25 },
      { x: 100, y: 25 },
    ],
  },
];

// =============================================================================
// Outdoor Units
// =============================================================================

const OUTDOOR_UNITS: SymbolDefinition[] = [
  {
    id: 'condensing-unit',
    name: 'Condensing Unit',
    category: 'outdoor-units',
    description: 'Standard outdoor condensing unit',
    defaultWidth: 1.0,
    defaultHeight: 0.8,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 50 50 m -30 0 a 30 30 0 1 1 60 0 a 30 30 0 1 1 -60 0',
    connectionPoints: [{ x: 50, y: 100 }],
  },
  {
    id: 'vrf-outdoor',
    name: 'VRF Outdoor Unit',
    category: 'outdoor-units',
    description: 'Variable refrigerant flow outdoor unit',
    defaultWidth: 1.6,
    defaultHeight: 1.2,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 50 m -15 0 a 15 15 0 1 1 30 0 a 15 15 0 1 1 -30 0 M 75 50 m -15 0 a 15 15 0 1 1 30 0 a 15 15 0 1 1 -30 0',
    connectionPoints: [{ x: 50, y: 100 }],
  },
  {
    id: 'chiller',
    name: 'Chiller',
    category: 'outdoor-units',
    description: 'Water-cooled chiller unit',
    defaultWidth: 3.0,
    defaultHeight: 1.5,
    svgPath: 'M 0 0 L 100 0 L 100 60 L 0 60 Z M 10 10 L 45 10 L 45 50 L 10 50 Z M 55 10 L 90 10 L 90 50 L 55 50 Z',
    connectionPoints: [
      { x: 27.5, y: 60 },
      { x: 72.5, y: 60 },
    ],
  },
];

// =============================================================================
// Diffusers
// =============================================================================

const DIFFUSERS: SymbolDefinition[] = [
  {
    id: 'diffuser-square',
    name: 'Square Diffuser',
    category: 'diffusers',
    description: '4-way square ceiling diffuser',
    defaultWidth: 0.6,
    defaultHeight: 0.6,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 75 25 L 75 75 L 25 75 Z M 50 0 L 50 25 M 100 50 L 75 50 M 50 100 L 50 75 M 0 50 L 25 50',
    connectionPoints: [{ x: 50, y: 50 }],
  },
  {
    id: 'diffuser-round',
    name: 'Round Diffuser',
    category: 'diffusers',
    description: 'Round ceiling diffuser',
    defaultWidth: 0.4,
    defaultHeight: 0.4,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 50 20 A 30 30 0 1 1 50 80 A 30 30 0 1 1 50 20',
    connectionPoints: [{ x: 50, y: 50 }],
  },
  {
    id: 'diffuser-linear',
    name: 'Linear Diffuser',
    category: 'diffusers',
    description: 'Linear slot diffuser',
    defaultWidth: 1.2,
    defaultHeight: 0.15,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 40 L 90 40 M 10 60 L 90 60',
    connectionPoints: [{ x: 50, y: 50 }],
  },
  {
    id: 'diffuser-jet',
    name: 'Jet Diffuser',
    category: 'diffusers',
    description: 'High-velocity jet nozzle diffuser',
    defaultWidth: 0.3,
    defaultHeight: 0.3,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 50 50 L 50 0 M 50 50 L 85 25 M 50 50 L 85 75 M 50 50 L 50 100 M 50 50 L 15 75 M 50 50 L 15 25',
    connectionPoints: [{ x: 50, y: 50 }],
  },
];

// =============================================================================
// Grilles
// =============================================================================

const GRILLES: SymbolDefinition[] = [
  {
    id: 'grille-supply',
    name: 'Supply Grille',
    category: 'grilles',
    description: 'Supply air grille',
    defaultWidth: 0.6,
    defaultHeight: 0.3,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 25 L 90 25 M 10 50 L 90 50 M 10 75 L 90 75',
    connectionPoints: [{ x: 50, y: 50 }],
  },
  {
    id: 'grille-return',
    name: 'Return Grille',
    category: 'grilles',
    description: 'Return air grille',
    defaultWidth: 0.6,
    defaultHeight: 0.3,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 20 L 90 20 L 90 80 L 10 80 Z M 20 35 L 80 35 M 20 50 L 80 50 M 20 65 L 80 65',
    connectionPoints: [{ x: 50, y: 50 }],
  },
  {
    id: 'grille-transfer',
    name: 'Transfer Grille',
    category: 'grilles',
    description: 'Door/wall transfer grille',
    defaultWidth: 0.4,
    defaultHeight: 0.2,
    svgPath: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 20 30 L 80 30 M 20 50 L 80 50 M 20 70 L 80 70',
    connectionPoints: [],
  },
];

// =============================================================================
// Dampers
// =============================================================================

const DAMPERS: SymbolDefinition[] = [
  {
    id: 'damper-manual',
    name: 'Manual Damper',
    category: 'dampers',
    description: 'Manually operated volume damper',
    defaultWidth: 0.3,
    defaultHeight: 0.3,
    svgPath: 'M 0 50 L 100 50 M 50 20 L 50 80 M 30 50 L 50 30 L 70 50',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
  {
    id: 'damper-motorized',
    name: 'Motorized Damper',
    category: 'dampers',
    description: 'Motorized volume control damper',
    defaultWidth: 0.3,
    defaultHeight: 0.4,
    svgPath: 'M 0 60 L 100 60 M 50 30 L 50 90 M 30 60 L 50 40 L 70 60 M 40 10 L 60 10 L 60 30 L 40 30 Z',
    connectionPoints: [
      { x: 0, y: 60 },
      { x: 100, y: 60 },
    ],
  },
  {
    id: 'damper-fire',
    name: 'Fire Damper',
    category: 'dampers',
    description: 'Fire-rated damper with fusible link',
    defaultWidth: 0.3,
    defaultHeight: 0.3,
    svgPath: 'M 0 50 L 100 50 M 20 30 L 80 30 L 80 70 L 20 70 Z M 35 45 L 65 45 L 65 55 L 35 55 Z',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
  {
    id: 'damper-smoke',
    name: 'Smoke Damper',
    category: 'dampers',
    description: 'Smoke control damper',
    defaultWidth: 0.3,
    defaultHeight: 0.3,
    svgPath: 'M 0 50 L 100 50 M 20 30 L 80 30 L 80 70 L 20 70 Z M 30 50 L 70 50 M 50 35 L 50 65',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
];

// =============================================================================
// Fans
// =============================================================================

const FANS: SymbolDefinition[] = [
  {
    id: 'fan-axial',
    name: 'Axial Fan',
    category: 'fans',
    description: 'Axial flow fan',
    defaultWidth: 0.5,
    defaultHeight: 0.5,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 50 50 L 30 20 M 50 50 L 70 20 M 50 50 L 80 50 M 50 50 L 70 80 M 50 50 L 30 80 M 50 50 L 20 50',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
  {
    id: 'fan-centrifugal',
    name: 'Centrifugal Fan',
    category: 'fans',
    description: 'Centrifugal blower fan',
    defaultWidth: 0.6,
    defaultHeight: 0.5,
    svgPath: 'M 0 80 L 0 20 C 0 0 30 0 50 0 A 40 40 0 1 1 50 80 L 0 80 M 100 40 L 120 40',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 120, y: 40 },
    ],
  },
  {
    id: 'fan-exhaust',
    name: 'Exhaust Fan',
    category: 'fans',
    description: 'Exhaust/extract fan',
    defaultWidth: 0.4,
    defaultHeight: 0.4,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 50 50 L 50 10 M 40 20 L 50 10 L 60 20',
    connectionPoints: [{ x: 50, y: 100 }],
  },
];

// =============================================================================
// Duct Fittings
// =============================================================================

const DUCT_FITTINGS: SymbolDefinition[] = [
  {
    id: 'duct-elbow-90',
    name: '90° Elbow',
    category: 'ducts',
    description: '90 degree duct elbow',
    defaultWidth: 0.3,
    defaultHeight: 0.3,
    svgPath: 'M 0 0 L 0 100 A 100 100 0 0 0 100 0 L 100 0',
    connectionPoints: [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ],
  },
  {
    id: 'duct-tee',
    name: 'Tee',
    category: 'ducts',
    description: 'Duct tee fitting',
    defaultWidth: 0.3,
    defaultHeight: 0.3,
    svgPath: 'M 0 50 L 100 50 M 50 50 L 50 100',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
    ],
  },
  {
    id: 'duct-cross',
    name: 'Cross',
    category: 'ducts',
    description: 'Duct cross fitting',
    defaultWidth: 0.3,
    defaultHeight: 0.3,
    svgPath: 'M 0 50 L 100 50 M 50 0 L 50 100',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ],
  },
  {
    id: 'duct-reducer',
    name: 'Reducer',
    category: 'ducts',
    description: 'Duct size reducer',
    defaultWidth: 0.4,
    defaultHeight: 0.3,
    svgPath: 'M 0 20 L 0 80 L 100 60 L 100 40 Z',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
  {
    id: 'duct-flex',
    name: 'Flexible Duct',
    category: 'ducts',
    description: 'Flexible duct connection',
    defaultWidth: 0.5,
    defaultHeight: 0.2,
    svgPath: 'M 0 50 Q 25 30 50 50 Q 75 70 100 50',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
];

// =============================================================================
// Valves
// =============================================================================

const VALVES: SymbolDefinition[] = [
  {
    id: 'valve-gate',
    name: 'Gate Valve',
    category: 'valves',
    description: 'Gate valve for isolation',
    defaultWidth: 0.2,
    defaultHeight: 0.2,
    svgPath: 'M 0 50 L 30 30 L 30 70 Z M 70 30 L 70 70 L 100 50 Z M 30 50 L 70 50',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
  {
    id: 'valve-ball',
    name: 'Ball Valve',
    category: 'valves',
    description: 'Ball valve for quick shutoff',
    defaultWidth: 0.2,
    defaultHeight: 0.2,
    svgPath: 'M 0 50 L 35 50 M 65 50 L 100 50 M 50 50 m -15 0 a 15 15 0 1 1 30 0 a 15 15 0 1 1 -30 0',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
  {
    id: 'valve-check',
    name: 'Check Valve',
    category: 'valves',
    description: 'Non-return check valve',
    defaultWidth: 0.2,
    defaultHeight: 0.2,
    svgPath: 'M 0 50 L 100 50 M 50 50 m -20 0 a 20 20 0 1 1 40 0 a 20 20 0 1 1 -40 0 M 45 35 L 55 50 L 45 65',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
  {
    id: 'valve-prv',
    name: 'PRV',
    category: 'valves',
    description: 'Pressure reducing valve',
    defaultWidth: 0.25,
    defaultHeight: 0.25,
    svgPath: 'M 0 50 L 30 30 L 30 70 Z M 70 30 L 70 70 L 100 50 Z M 30 50 L 70 50 M 50 20 L 50 30',
    connectionPoints: [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
  },
];

// =============================================================================
// Sensors
// =============================================================================

const SENSORS: SymbolDefinition[] = [
  {
    id: 'sensor-temp',
    name: 'Temperature Sensor',
    category: 'sensors',
    description: 'Temperature sensor/thermostat',
    defaultWidth: 0.15,
    defaultHeight: 0.15,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 50 20 L 50 50 L 70 70',
    connectionPoints: [],
  },
  {
    id: 'sensor-humidity',
    name: 'Humidity Sensor',
    category: 'sensors',
    description: 'Relative humidity sensor',
    defaultWidth: 0.15,
    defaultHeight: 0.15,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 35 50 L 65 50 M 50 35 L 50 65',
    connectionPoints: [],
  },
  {
    id: 'sensor-pressure',
    name: 'Pressure Sensor',
    category: 'sensors',
    description: 'Duct/pipe pressure sensor',
    defaultWidth: 0.15,
    defaultHeight: 0.15,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 30 70 Q 50 20 70 70',
    connectionPoints: [],
  },
  {
    id: 'sensor-co2',
    name: 'CO2 Sensor',
    category: 'sensors',
    description: 'Carbon dioxide sensor',
    defaultWidth: 0.15,
    defaultHeight: 0.15,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 30 60 L 40 40 L 60 40 L 70 60',
    connectionPoints: [],
  },
];

// =============================================================================
// Annotations
// =============================================================================

const ANNOTATIONS: SymbolDefinition[] = [
  {
    id: 'note-bubble',
    name: 'Note Bubble',
    category: 'annotations',
    description: 'General note callout',
    defaultWidth: 0.4,
    defaultHeight: 0.3,
    svgPath: 'M 10 0 L 90 0 Q 100 0 100 10 L 100 60 Q 100 70 90 70 L 30 70 L 10 90 L 20 70 L 10 70 Q 0 70 0 60 L 0 10 Q 0 0 10 0',
    connectionPoints: [],
  },
  {
    id: 'section-mark',
    name: 'Section Mark',
    category: 'annotations',
    description: 'Section cut indicator',
    defaultWidth: 0.3,
    defaultHeight: 0.3,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 M 0 50 L 100 50',
    connectionPoints: [],
  },
  {
    id: 'detail-mark',
    name: 'Detail Mark',
    category: 'annotations',
    description: 'Detail callout circle',
    defaultWidth: 0.25,
    defaultHeight: 0.25,
    svgPath: 'M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0',
    connectionPoints: [],
  },
  {
    id: 'north-arrow',
    name: 'North Arrow',
    category: 'annotations',
    description: 'Orientation indicator',
    defaultWidth: 0.3,
    defaultHeight: 0.4,
    svgPath: 'M 50 0 L 70 100 L 50 75 L 30 100 Z M 50 0 L 50 75',
    connectionPoints: [],
  },
];

// =============================================================================
// Symbol Registry
// =============================================================================

export const SYMBOL_LIBRARY: SymbolDefinition[] = [
  ...INDOOR_UNITS,
  ...OUTDOOR_UNITS,
  ...DIFFUSERS,
  ...GRILLES,
  ...DAMPERS,
  ...FANS,
  ...DUCT_FITTINGS,
  ...VALVES,
  ...SENSORS,
  ...ANNOTATIONS,
];

// =============================================================================
// Lookup Functions
// =============================================================================

export function getSymbolById(id: string): SymbolDefinition | undefined {
  return SYMBOL_LIBRARY.find((s) => s.id === id);
}

export function getSymbolsByCategory(category: SymbolCategory): SymbolDefinition[] {
  return SYMBOL_LIBRARY.filter((s) => s.category === category);
}

export function searchSymbols(query: string): SymbolDefinition[] {
  const lowerQuery = query.toLowerCase();
  return SYMBOL_LIBRARY.filter(
    (s) =>
      s.name.toLowerCase().includes(lowerQuery) ||
      s.description?.toLowerCase().includes(lowerQuery) ||
      s.category.toLowerCase().includes(lowerQuery)
  );
}

export function getCategoryLabel(category: SymbolCategory): string {
  return SYMBOL_CATEGORIES.find((c) => c.id === category)?.label ?? category;
}
