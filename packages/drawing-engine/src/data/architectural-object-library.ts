/**
 * Architectural object library definitions for plan placement.
 */

export type ArchitecturalObjectCategory =
  | 'doors'
  | 'windows'
  | 'furniture'
  | 'fixtures'
  | 'symbols'
  | 'my-library';

export type ArchitecturalObjectView = 'plan-2d';
export type DoorType = 'single-swing' | 'double-swing' | 'sliding' | 'bi-fold' | 'overhead';
export type WindowType = 'casement' | 'sliding' | 'fixed' | 'awning';
export type FurnitureZone = 'bedroom' | 'living-room' | 'dining' | 'kitchen-bath';
export type FixtureType = 'plumbing' | 'appliance';

export interface ArchitecturalObjectDefinition {
  id: string;
  name: string;
  category: ArchitecturalObjectCategory;
  type: string;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  openingWidthMm?: number;
  sillHeightMm?: number;
  swingAngleDeg?: number;
  fireRating?: string;
  material?: 'wood' | 'metal' | 'glass' | 'composite';
  hardware?: 'lever' | 'knob' | 'slider' | 'none';
  glazingType?: 'single' | 'double' | 'triple';
  frameMaterial?: 'wood' | 'aluminum' | 'uPVC' | 'steel';
  uValue?: number;
  symbolPath?: string;
  /** Links to a Canvas 2D multi-view renderer in FurnitureSymbolRenderer */
  renderType?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  defaultRotationDeg?: number;
  vendor?: string;
  cost?: number;
  boQCode?: string;
  view: ArchitecturalObjectView;
}

export type ObjectSortMode = 'name' | 'type' | 'size' | 'recent';

export const ARCHITECTURAL_OBJECT_CATEGORIES: Array<{
  id: ArchitecturalObjectCategory;
  label: string;
}> = [
  { id: 'doors', label: 'Doors' },
  { id: 'windows', label: 'Windows' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'fixtures', label: 'Fixtures' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'my-library', label: 'My Library' },
];

function objectBase(
  id: string,
  name: string,
  category: ArchitecturalObjectCategory,
  type: string,
  widthMm: number,
  depthMm: number,
  heightMm: number,
  tags: string[],
  extra?: Partial<ArchitecturalObjectDefinition>
): ArchitecturalObjectDefinition {
  return {
    id,
    name,
    category,
    type,
    widthMm,
    depthMm,
    heightMm,
    tags,
    view: 'plan-2d',
    ...extra,
  };
}

function door(
  id: string,
  name: string,
  type: DoorType,
  widthMm: number,
  extra?: Partial<ArchitecturalObjectDefinition>
): ArchitecturalObjectDefinition {
  return objectBase(
    id,
    name,
    'doors',
    type,
    widthMm,
    45,
    2100,
    ['door', type, `${widthMm}`],
    {
      openingWidthMm: widthMm,
      swingAngleDeg: type.includes('swing') ? 90 : 0,
      material: 'wood',
      hardware: type.includes('sliding') ? 'slider' : 'lever',
      ...extra,
    }
  );
}

function windowObject(
  id: string,
  name: string,
  type: WindowType,
  widthMm: number,
  extra?: Partial<ArchitecturalObjectDefinition>
): ArchitecturalObjectDefinition {
  return objectBase(
    id,
    name,
    'windows',
    type,
    widthMm,
    120,
    1200,
    ['window', type, `${widthMm}`],
    {
      openingWidthMm: widthMm,
      sillHeightMm: 900,
      glazingType: 'double',
      frameMaterial: 'aluminum',
      uValue: 2.2,
      material: 'glass',
      ...extra,
    }
  );
}

function furniture(
  id: string,
  name: string,
  zone: FurnitureZone,
  widthMm: number,
  depthMm: number,
  heightMm: number = 750,
  renderType?: string,
  extraTags: string[] = []
): ArchitecturalObjectDefinition {
  return objectBase(
    id,
    name,
    'furniture',
    zone,
    widthMm,
    depthMm,
    heightMm,
    ['furniture', zone, ...extraTags],
    renderType ? { renderType } : undefined
  );
}

function fixture(
  id: string,
  name: string,
  type: FixtureType,
  widthMm: number,
  depthMm: number,
  heightMm: number = 850,
  renderType?: string
): ArchitecturalObjectDefinition {
  return objectBase(
    id,
    name,
    'fixtures',
    type,
    widthMm,
    depthMm,
    heightMm,
    ['fixture', type],
    renderType ? { renderType } : undefined
  );
}

function drawingSymbol(
  id: string,
  name: string,
  widthMm: number,
  depthMm: number,
  symbolPath: string,
  tags: string[]
): ArchitecturalObjectDefinition {
  return objectBase(
    id,
    name,
    'symbols',
    'drawing-symbol',
    widthMm,
    depthMm,
    10,
    ['symbol', ...tags],
    {
      symbolPath,
      material: 'composite',
      hardware: 'none',
      defaultRotationDeg: 0,
    }
  );
}

export const DEFAULT_ARCHITECTURAL_OBJECT_LIBRARY: ArchitecturalObjectDefinition[] = [
  // Doors
  door('door-single-700', 'Single Swing 700', 'single-swing', 700),
  door('door-single-800', 'Single Swing 800', 'single-swing', 800),
  door('door-single-900', 'Single Swing 900', 'single-swing', 900),
  door('door-single-1000', 'Single Swing 1000', 'single-swing', 1000),
  door('door-double-1400', 'Double Swing 1400', 'double-swing', 1400, { swingAngleDeg: 90 }),
  door('door-double-1600', 'Double Swing 1600', 'double-swing', 1600, { swingAngleDeg: 90 }),
  door('door-double-1800', 'Double Swing 1800', 'double-swing', 1800, { swingAngleDeg: 90 }),
  door('door-sliding-900', 'Sliding 900', 'sliding', 900, { material: 'glass', hardware: 'slider' }),
  door('door-sliding-1200', 'Sliding 1200', 'sliding', 1200, { material: 'glass', hardware: 'slider' }),
  door('door-sliding-1500', 'Sliding 1500', 'sliding', 1500, { material: 'glass', hardware: 'slider' }),
  door('door-bifold-900', 'Bi-fold 900', 'bi-fold', 900, { hardware: 'lever' }),
  door('door-bifold-1200', 'Bi-fold 1200', 'bi-fold', 1200, { hardware: 'lever' }),
  door('door-overhead-2400', 'Overhead Garage 2400', 'overhead', 2400, { heightMm: 2400, hardware: 'none', material: 'metal' }),
  door('door-overhead-3000', 'Overhead Garage 3000', 'overhead', 3000, { heightMm: 2400, hardware: 'none', material: 'metal' }),

  // Windows
  windowObject('window-casement-600', 'Casement 600', 'casement', 600),
  windowObject('window-casement-900', 'Casement 900', 'casement', 900),
  windowObject('window-casement-1200', 'Casement 1200', 'casement', 1200),
  windowObject('window-sliding-1200', 'Sliding 1200', 'sliding', 1200),
  windowObject('window-sliding-1500', 'Sliding 1500', 'sliding', 1500),
  windowObject('window-sliding-1800', 'Sliding 1800', 'sliding', 1800),
  windowObject('window-fixed-900', 'Fixed 900', 'fixed', 900),
  windowObject('window-fixed-1200', 'Fixed 1200', 'fixed', 1200),
  windowObject('window-fixed-1500', 'Fixed 1500', 'fixed', 1500),
  windowObject('window-awning-600', 'Awning 600', 'awning', 600),
  windowObject('window-awning-900', 'Awning 900', 'awning', 900),

  // Furniture - Bedroom
  furniture('furn-bed-single', 'Single Bed', 'bedroom', 900, 1900, 500, 'bed-single'),
  furniture('furn-bed-double', 'Double Bed', 'bedroom', 1350, 1900, 500, 'bed-double'),
  furniture('furn-bed-queen', 'Queen Bed', 'bedroom', 1500, 2000, 500, 'bed-queen'),
  furniture('furn-bed-king', 'King Bed', 'bedroom', 1800, 2000, 500, 'bed-king'),
  furniture('furn-nightstand', 'Nightstand', 'bedroom', 500, 500, 600, 'nightstand'),
  furniture('furn-dresser', 'Dresser', 'bedroom', 900, 500, 900, 'dresser'),
  furniture('furn-wardrobe', 'Wardrobe', 'bedroom', 1000, 600, 2100, 'wardrobe'),

  // Furniture - Living
  furniture('furn-sofa-2', '2-Seater Sofa', 'living-room', 1500, 900, 900, 'sofa-2'),
  furniture('furn-sofa-3', '3-Seater Sofa', 'living-room', 2200, 900, 900, 'sofa-3'),
  furniture('furn-armchair', 'Armchair', 'living-room', 850, 850, 880, 'armchair'),
  furniture('furn-office-chair', 'Office Swivel Chair', 'living-room', 680, 680, 1150, 'office-chair'),
  furniture('furn-coffee-table', 'Coffee Table', 'living-room', 1100, 550, 420, 'coffee-table'),
  furniture('furn-tv-stand', 'TV Stand', 'living-room', 1500, 450, 550, 'tv-stand'),
  furniture('furn-bookshelf', 'Bookshelf', 'living-room', 800, 300, 2100, 'bookshelf'),

  // Furniture - Dining
  furniture('furn-table-4', 'Dining Table 4-Seat', 'dining', 1200, 800, 750, 'dining-table'),
  furniture('furn-table-6', 'Dining Table 6-Seat', 'dining', 1500, 800, 750, 'dining-table'),
  furniture('furn-table-8', 'Dining Table 8-Seat', 'dining', 2000, 1000, 750, 'dining-table'),
  furniture('furn-round-table', 'Round Table Ø900', 'dining', 900, 900, 750, 'round-table'),
  furniture('furn-chair', 'Dining Chair', 'dining', 450, 450, 830, 'dining-chair'),
  furniture('furn-buffet', 'Buffet', 'dining', 1500, 500, 900, 'buffet'),

  // Furniture - Meeting Tables with chairs (separate circular / square variants)
  furniture(
    'furn-circular-table-chairs',
    'Circular Meeting Table with Chairs',
    'dining',
    1600,
    1600,
    750,
    'circular-table-chairs',
    ['meeting', 'meeting-table', 'circular', 'chairs']
  ),
  furniture(
    'furn-square-table-chairs',
    'Square Meeting Table with Chairs',
    'dining',
    1800,
    1400,
    750,
    'square-table-chairs',
    ['meeting', 'meeting-table', 'square', 'chairs']
  ),

  // Fixtures / Kitchen-Bath
  fixture('fix-sink', 'Sink', 'plumbing', 600, 500, 900, 'sink'),
  fixture('fix-stove', 'Stove', 'appliance', 600, 600, 900, 'stove'),
  fixture('fix-fridge', 'Refrigerator', 'appliance', 700, 700, 1800, 'fridge'),
  fixture('fix-toilet', 'Toilet', 'plumbing', 450, 750, 800, 'toilet'),
  fixture('fix-bathtub', 'Bathtub', 'plumbing', 1700, 800, 600, 'bathtub'),
  fixture('fix-shower', 'Shower', 'plumbing', 900, 900, 2100, 'shower'),

  // Symbols
  drawingSymbol(
    'sym-north-arrow',
    'North Arrow',
    300,
    300,
    'M 50 6 L 88 68 L 64 68 L 64 94 L 36 94 L 36 68 L 12 68 Z',
    ['north', 'orientation']
  ),
  drawingSymbol(
    'sym-title-block',
    'Title Block',
    1800,
    500,
    'M 5 5 L 95 5 L 95 95 L 5 95 Z M 5 70 L 95 70 M 35 70 L 35 95 M 65 70 L 65 95',
    ['title', 'sheet']
  ),
  drawingSymbol(
    'sym-revision-cloud',
    'Revision Symbol',
    500,
    300,
    'M 10 55 C 20 20 40 20 50 45 C 60 20 80 20 90 55 C 80 88 60 88 50 65 C 40 88 20 88 10 55',
    ['revision', 'annotation']
  ),
];

export function groupArchitecturalObjectsByCategory(
  objects: ArchitecturalObjectDefinition[]
): Record<ArchitecturalObjectCategory, ArchitecturalObjectDefinition[]> {
  return objects.reduce(
    (acc, definition) => {
      acc[definition.category].push(definition);
      return acc;
    },
    {
      doors: [],
      windows: [],
      furniture: [],
      fixtures: [],
      symbols: [],
      'my-library': [],
    } as Record<ArchitecturalObjectCategory, ArchitecturalObjectDefinition[]>
  );
}

export function searchArchitecturalObjects(
  objects: ArchitecturalObjectDefinition[],
  query: string
): ArchitecturalObjectDefinition[] {
  if (!query.trim()) return objects;
  const normalized = query.trim().toLowerCase();
  return objects.filter((entry) => {
    if (entry.name.toLowerCase().includes(normalized)) return true;
    if (entry.type.toLowerCase().includes(normalized)) return true;
    if (entry.tags.some((tag) => tag.toLowerCase().includes(normalized))) return true;
    return false;
  });
}

export function sortArchitecturalObjects(
  objects: ArchitecturalObjectDefinition[],
  mode: ObjectSortMode,
  recentUsage: Record<string, number>
): ArchitecturalObjectDefinition[] {
  const ranked = [...objects];
  ranked.sort((a, b) => {
    if (mode === 'type') {
      return a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
    }
    if (mode === 'size') {
      const areaA = a.widthMm * a.depthMm;
      const areaB = b.widthMm * b.depthMm;
      return areaA - areaB || a.name.localeCompare(b.name);
    }
    if (mode === 'recent') {
      const scoreA = recentUsage[a.id] ?? 0;
      const scoreB = recentUsage[b.id] ?? 0;
      return scoreB - scoreA || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });
  return ranked;
}
