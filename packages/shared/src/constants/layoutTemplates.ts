/**
 * Floor Layout Templates
 * Pre-configured layouts for common HVAC project types
 */

export enum LayoutCategory {
  RESIDENTIAL = "residential",
  COMMERCIAL = "commercial",
  HOSPITALITY = "hospitality",
  INDUSTRIAL = "industrial",
}

export interface TemplateComponent {
  type: string;
  id?: string;
  label?: string;
  width?: number;
  height?: number;
  position?: string;
  room?: string;
  side?: string;
  count?: number;
  adjacentTo?: string;
  rows?: number;
  cols?: number;
  spacing?: number;
  ceilingHeight?: number;
  requiresExhaust?: boolean;
  positions?: string[];
  gridSpacing?: number;
}

export interface DuctRoute {
  from: string;
  to?: string;
  path?: string;
  branch?: boolean;
  layout?: string;
}

export interface LayoutTemplate {
  id: string;
  name: string;
  category: LayoutCategory | null;
  description: string;
  thumbnail?: string;
  previewImage?: string;
  defaultComponents: TemplateComponent[];
  suggestedDuctRoutes: DuctRoute[];
  defaultSettings: {
    ceilingHeight: number;
    supplyAirTemp: number;
    returnAirTemp: number;
  };
}

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // RESIDENTIAL
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "single-room",
    name: "Single Room",
    category: LayoutCategory.RESIDENTIAL,
    description: "Single room with one supply/return point",
    defaultComponents: [
      { type: "ROOM", width: 5000, height: 4000 },
      { type: "DIFFUSER", position: "center" },
      { type: "RETURN_GRILLE", position: "corner" },
    ],
    suggestedDuctRoutes: [{ from: "main", to: "diffuser", path: "direct" }],
    defaultSettings: {
      ceilingHeight: 2700,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },

  {
    id: "adjacent-rooms",
    name: "Adjacent Rooms",
    category: LayoutCategory.RESIDENTIAL,
    description: "Two or more rooms sharing a common wall",
    defaultComponents: [
      { type: "ROOM", id: "room1", width: 4000, height: 4000 },
      { type: "ROOM", id: "room2", width: 4000, height: 4000, adjacentTo: "room1" },
      { type: "DIFFUSER", room: "room1" },
      { type: "DIFFUSER", room: "room2" },
    ],
    suggestedDuctRoutes: [
      { from: "main", to: "room1", branch: true },
      { from: "main", to: "room2", branch: true },
    ],
    defaultSettings: {
      ceilingHeight: 2700,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },

  {
    id: "apartment-multi-room",
    name: "Apartment Multi-Room",
    category: LayoutCategory.RESIDENTIAL,
    description: "Multiple rooms in apartment layout",
    defaultComponents: [
      { type: "ROOM", id: "living", width: 6000, height: 5000, label: "Living" },
      { type: "ROOM", id: "bed1", width: 4000, height: 4000, label: "Bedroom 1" },
      { type: "ROOM", id: "bed2", width: 3500, height: 3500, label: "Bedroom 2" },
      { type: "ROOM", id: "kitchen", width: 3000, height: 3000, label: "Kitchen" },
    ],
    suggestedDuctRoutes: [{ from: "main", layout: "trunk-and-branch" }],
    defaultSettings: {
      ceilingHeight: 2700,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // COMMERCIAL
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "open-plan-office",
    name: "Open Plan Office",
    category: LayoutCategory.COMMERCIAL,
    description: "Large open floor plate with multiple diffusers",
    defaultComponents: [
      { type: "ROOM", width: 20000, height: 15000 },
      { type: "DIFFUSER_GRID", rows: 4, cols: 5, spacing: 4000 },
      { type: "RETURN_GRILLE_GRID", rows: 2, cols: 3 },
    ],
    suggestedDuctRoutes: [{ from: "main", layout: "trunk-and-branch" }],
    defaultSettings: {
      ceilingHeight: 2700,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },

  {
    id: "corridor-single-side",
    name: "Corridor - Single Side",
    category: LayoutCategory.COMMERCIAL,
    description: "Rooms along one side of corridor",
    defaultComponents: [
      { type: "CORRIDOR", width: 2000, height: 20000 },
      { type: "ROOM_ARRAY", side: "left", count: 5, width: 4000, height: 4000 },
    ],
    suggestedDuctRoutes: [{ from: "main", layout: "linear-branch" }],
    defaultSettings: {
      ceilingHeight: 2700,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },

  {
    id: "corridor-both-sides",
    name: "Corridor - Both Sides",
    category: LayoutCategory.COMMERCIAL,
    description: "Rooms on both sides of central corridor",
    defaultComponents: [
      { type: "CORRIDOR", width: 2000, height: 20000, position: "center" },
      { type: "ROOM_ARRAY", side: "left", count: 5, width: 4000, height: 4000 },
      { type: "ROOM_ARRAY", side: "right", count: 5, width: 4000, height: 4000 },
    ],
    suggestedDuctRoutes: [
      { from: "main", layout: "dual-linear-branch" },
    ],
    defaultSettings: {
      ceilingHeight: 2700,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // HOSPITALITY
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "banquet-hall",
    name: "Banquet / Conference Hall",
    category: LayoutCategory.HOSPITALITY,
    description: "Large hall with high airflow requirements",
    defaultComponents: [
      { type: "ROOM", width: 30000, height: 20000, ceilingHeight: 4500 },
      { type: "DIFFUSER_GRID", rows: 6, cols: 8, spacing: 4000 },
      { type: "HIGH_CAPACITY_RETURN", count: 4 },
    ],
    suggestedDuctRoutes: [{ from: "main", layout: "loop-system" }],
    defaultSettings: {
      ceilingHeight: 4500,
      supplyAirTemp: 13,
      returnAirTemp: 25,
    },
  },

  {
    id: "hotel-layout",
    name: "Hotel Floor Layout",
    category: LayoutCategory.HOSPITALITY,
    description: "Hotel corridor with guest rooms",
    defaultComponents: [
      { type: "CORRIDOR", width: 1800, height: 30000 },
      { type: "ROOM_ARRAY", side: "both", count: 10, width: 4000, height: 6000, label: "Guest Room" },
    ],
    suggestedDuctRoutes: [{ from: "main", layout: "hotel-riser-branch" }],
    defaultSettings: {
      ceilingHeight: 2700,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },

  {
    id: "restaurant-kitchen",
    name: "Restaurant with Kitchen",
    category: LayoutCategory.HOSPITALITY,
    description: "Dining area with commercial kitchen requiring exhaust",
    defaultComponents: [
      { type: "ROOM", id: "dining", width: 15000, height: 10000, label: "Dining" },
      { type: "ROOM", id: "kitchen", width: 8000, height: 6000, label: "Kitchen", requiresExhaust: true },
    ],
    suggestedDuctRoutes: [
      { from: "supply_main", to: "dining" },
      { from: "exhaust_main", to: "kitchen" },
    ],
    defaultSettings: {
      ceilingHeight: 3000,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // INDUSTRIAL
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "warehouse",
    name: "Warehouse",
    category: LayoutCategory.INDUSTRIAL,
    description: "Large volume space with spot cooling/ventilation",
    defaultComponents: [
      { type: "ROOM", width: 50000, height: 30000, ceilingHeight: 8000 },
      { type: "SPOT_COOLING", positions: ["office-area", "packing-area"] },
    ],
    suggestedDuctRoutes: [{ from: "main", layout: "spot-delivery" }],
    defaultSettings: {
      ceilingHeight: 8000,
      supplyAirTemp: 16,
      returnAirTemp: 28,
    },
  },

  {
    id: "server-room",
    name: "Server / Data Center",
    category: LayoutCategory.INDUSTRIAL,
    description: "Precision cooling for IT equipment",
    defaultComponents: [
      { type: "ROOM", width: 10000, height: 8000 },
      { type: "RAISED_FLOOR_SUPPLY", gridSpacing: 600 },
      { type: "CEILING_RETURN", gridSpacing: 1200 },
    ],
    suggestedDuctRoutes: [{ from: "crac", layout: "underfloor-plenum" }],
    defaultSettings: {
      ceilingHeight: 3000,
      supplyAirTemp: 12,
      returnAirTemp: 35,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BLANK
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "blank",
    name: "Blank Canvas",
    category: null,
    description: "Start from scratch with empty canvas",
    defaultComponents: [],
    suggestedDuctRoutes: [],
    defaultSettings: {
      ceilingHeight: 2700,
      supplyAirTemp: 14,
      returnAirTemp: 24,
    },
  },
];

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: LayoutCategory): LayoutTemplate[] {
  return LAYOUT_TEMPLATES.filter((t) => t.category === category);
}

/**
 * Get template by ID
 */
export function getTemplateById(id: string): LayoutTemplate | undefined {
  return LAYOUT_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get all categories with their templates
 */
export function getTemplateCategories(): { category: LayoutCategory; templates: LayoutTemplate[] }[] {
  const categories = Object.values(LayoutCategory);
  return categories.map((category) => ({
    category,
    templates: getTemplatesByCategory(category),
  }));
}
