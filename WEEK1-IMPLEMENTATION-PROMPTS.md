# Week 1 — Detailed Implementation Prompts

## Overview

Week 1 covers the foundational VRF system infrastructure:
- **Chunk 1.1:** VRF System Data Model & Zustand Store Slice
- **Chunk 1.2:** VRF Component Renderers (Fabric.js canvas rendering)

Both chunks must follow the **exact existing codebase patterns** to maintain consistency.

---

---

# PROMPT 1: VRF System Data Model & Zustand Store Slice

---

## Task

Create the complete VRF (Variable Refrigerant Flow) system data model types and Zustand store slice for the Provac HVAC web platform. This is the foundational data layer that all VRF features (placement, routing, BOQ generation, validation) will depend on.

---

## Pre-Read Required Files (READ THESE FIRST)

Before writing any code, read and understand these files thoroughly:

1. **`packages/drawing-engine/src/store/slices/wallSlice.ts`** — This is the **primary pattern** to follow. Study:
   - How `WallSliceState` and `WallSliceActions` interfaces are structured
   - How the slice function uses `set()` callback with spread-based immutable updates
   - How geometry recomputation is triggered on relevant field changes
   - How `clampThickness`, `clampHeight` validate numeric bounds
   - How `createWall()` factory provides defaults
   - How wall connections are managed (connect/disconnect cleanup)
   - How bulk operations (`deleteWalls`, `clearAllWalls`) cascade cleanups

2. **`packages/drawing-engine/src/store/index.ts`** — Study how slices are composed into the main store:
   - The `create<DrawingStore>()` pattern with `devtools` middleware
   - How state and actions from each slice are spread into the root store
   - How cross-slice interactions work (e.g., wall deletion triggering room updates)

3. **`packages/drawing-engine/src/types/index.ts`** — Study existing type exports and how they're organized

4. **`packages/shared/src/constants/hvacComponents.ts`** — Study the VRF component definitions:
   - `VRF_COMPONENTS` object: outdoor units, indoor units (ducted), branch kits (Y-branch, header), refrigerant pipes, insulation
   - Property schemas with types, units, min/max validation, conditional fields
   - Size arrays, capacity ranges, model naming conventions
   - Pay attention to the `properties` array structure — each property has `key`, `label`, `type`, `unit`, `options`, `min`, `max`, `conditions`

5. **`packages/shared/src/utils/calculations.ts`** — Study the existing VRF validation:
   - `validateVRFSystem(params)` — takes totalPipingLength, maxHeightDifference, maxBranchLength, connectionCount
   - `DEFAULT_VRF_LIMITS` — { maxPipingLength: 165, maxHeightDifference: 50, maxBranchToIDU: 40, maxConnections: 64 }
   - Returns `{ status, checks[] }` with per-limit pass/warning/error results

6. **`packages/drawing-engine/src/attributes/hvac.ts`** — Study HVAC design foundations:
   - `DEFAULT_HVAC_DESIGN_CONDITIONS` — location, temps, altitude, peak timing
   - `DEFAULT_ROOM_HVAC_TEMPLATES` — per room type: occupancy, lighting, equipment W/m², schedules
   - `Room3D` type fields: `calculatedCoolingLoadW`, `calculatedHeatingLoadW`, `loadBreakdown`

---

## Step 1: Create VRF Types

**File:** `packages/drawing-engine/src/types/vrf.ts`

### 1.1 Core Entity Types

Define all VRF system types with comprehensive documentation. Every field must have a JSDoc comment explaining its purpose, unit, and valid range where applicable.

```typescript
// ─── Manufacturer & Refrigerant Enums ────────────────────────────────

/** Supported VRF system manufacturers */
export type VRFManufacturer =
  | 'daikin'
  | 'mitsubishi_electric'
  | 'mitsubishi_heavy'
  | 'samsung'
  | 'lg'
  | 'toshiba'
  | 'hitachi'
  | 'midea'
  | 'gree'
  | 'fujitsu';

/** Refrigerant types used in VRF systems */
export type VRFRefrigerant = 'R410A' | 'R32' | 'R134a' | 'R407C';

/** Indoor unit mounting/type classification */
export type VRFIndoorUnitType =
  | 'ducted'
  | 'ducted_slim'
  | 'cassette_4way'
  | 'cassette_2way'
  | 'cassette_1way'
  | 'wall_mounted'
  | 'floor_standing'
  | 'ceiling_suspended'
  | 'floor_concealed'
  | 'ceiling_concealed';

/** Branch kit configuration type */
export type VRFBranchKitType =
  | 'y_branch'
  | 'header_2port'
  | 'header_3port'
  | 'header_4port'
  | 'header_5port'
  | 'header_6port'
  | 'header_7port'
  | 'header_8port';

/** Refrigerant line classification */
export type VRFLineType = 'liquid' | 'gas' | 'suction';

/** Connection port function */
export type VRFPortType =
  | 'liquid_in'
  | 'liquid_out'
  | 'gas_in'
  | 'gas_out'
  | 'main_in'
  | 'branch_out';

/** Component side for port positioning */
export type ComponentSide = 'top' | 'bottom' | 'left' | 'right';

/** VRF system validation status */
export type VRFSystemStatus = 'draft' | 'valid' | 'warning' | 'error';

/** Mount type for indoor units */
export type VRFMountType = 'ceiling' | 'wall' | 'floor';
```

### 1.2 VRF System (Root Entity)

```typescript
/**
 * Root VRF system entity that ties together all components.
 * A project can have multiple VRF systems (e.g., one per zone or floor).
 */
export interface VRFSystem {
  /** Unique identifier */
  id: string;

  /** User-friendly system name (e.g., "VRF System A - Ground Floor") */
  name: string;

  /** Equipment manufacturer */
  manufacturer: VRFManufacturer;

  /** Refrigerant type */
  refrigerant: VRFRefrigerant;

  /** Series/product line name (e.g., "VRV IV", "City Multi S") */
  seriesName: string;

  /** Reference to the outdoor unit */
  outdoorUnitId: string;

  /** All indoor unit IDs in this system */
  indoorUnitIds: string[];

  /** All branch kit IDs in this system */
  branchKitIds: string[];

  /** All refrigerant line IDs in this system */
  refrigerantLineIds: string[];

  /** Maximum system capacity in kW (from ODU rating) */
  maxCapacity: number;

  /** Sum of all connected IDU capacities in kW */
  totalConnectedCapacity: number;

  /** Capacity ratio: (totalConnected / maxCapacity) × 100. Valid: 50-130% */
  capacityRatio: number;

  /** System heat recovery/heat pump mode */
  systemMode: 'heat_pump' | 'heat_recovery';

  /** Current validation status */
  status: VRFSystemStatus;

  /** Validation messages from the last check */
  validationMessages: VRFValidationMessage[];

  /** Associated floor ID for multi-story projects */
  floorId?: string;

  /** Color tag for visual identification on canvas (hex color) */
  colorTag: string;

  /** Whether piping has been auto-generated */
  pipingGenerated: boolean;

  /** Timestamp of last modification */
  updatedAt: number;

  /** Creation timestamp */
  createdAt: number;
}

export interface VRFValidationMessage {
  /** Severity level */
  level: 'info' | 'warning' | 'error';
  /** Validation rule code (e.g., "MAX_PIPING_LENGTH") */
  code: string;
  /** Human-readable message */
  message: string;
  /** ID of the component causing the issue, if applicable */
  componentId?: string;
  /** Current value that triggered the message */
  currentValue?: number;
  /** Limit value being compared against */
  limitValue?: number;
}
```

### 1.3 VRF Outdoor Unit

```typescript
/**
 * VRF Outdoor Unit (ODU/Condensing Unit).
 * Placed outside the building, typically on rooftop or ground level.
 * One ODU per VRF system.
 */
export interface VRFOutdoorUnit {
  id: string;
  systemId: string;

  // ─── Equipment Specification ─────────────────────
  /** Model number (e.g., "RXYQ20TAY1") */
  model: string;
  /** Manufacturer (inherited from system, but stored for independence) */
  manufacturer: VRFManufacturer;
  /** Nominal cooling capacity in kW */
  coolingCapacity: number;
  /** Nominal heating capacity in kW */
  heatingCapacity: number;
  /** Power input at nominal conditions in kW */
  powerInput: number;
  /** Refrigerant type */
  refrigerant: VRFRefrigerant;
  /** Refrigerant factory charge in kg */
  factoryCharge: number;
  /** Maximum number of connectable indoor units */
  maxConnections: number;
  /** COP (Coefficient of Performance) */
  cop: number;
  /** EER (Energy Efficiency Ratio) */
  eer: number;

  // ─── Physical Properties ─────────────────────────
  /** Position on canvas in mm */
  position: { x: number; y: number };
  /** Rotation angle in degrees (0-360) */
  rotation: number;
  /** Physical dimensions in mm */
  dimensions: { width: number; depth: number; height: number };
  /** Operating weight in kg */
  weight: number;
  /** Sound pressure level at 1m in dB(A) */
  noiseLevel: number;

  // ─── Electrical ──────────────────────────────────
  /** Power supply (e.g., "380-415V/3Ph/50Hz") */
  powerSupply: string;
  /** Running current in Amps */
  runningCurrent: number;
  /** MCA (Minimum Circuit Ampacity) */
  mca: number;

  // ─── Connection Ports ────────────────────────────
  /** Refrigerant connection ports */
  connectionPorts: VRFConnectionPort[];

  // ─── Visual State ────────────────────────────────
  /** Whether this unit is currently visible on canvas */
  visible: boolean;
  /** Whether this unit is locked from editing */
  locked: boolean;
  /** Layer z-index for rendering order */
  zIndex: number;
}
```

### 1.4 VRF Indoor Unit

```typescript
/**
 * VRF Indoor Unit (IDU/Fan Coil Unit).
 * Placed inside rooms, associated with a room for load matching.
 */
export interface VRFIndoorUnit {
  id: string;
  systemId: string;

  // ─── Room Association ────────────────────────────
  /** Associated room ID (from room detection) */
  roomId?: string;
  /** Room name (denormalized for display) */
  roomName?: string;

  // ─── Equipment Specification ─────────────────────
  /** Model number */
  model: string;
  /** Indoor unit type/form factor */
  type: VRFIndoorUnitType;
  /** Nominal cooling capacity in kW */
  coolingCapacity: number;
  /** Nominal heating capacity in kW */
  heatingCapacity: number;
  /** Nominal airflow in L/s */
  airflow: number;
  /** External static pressure in Pa (relevant for ducted types) */
  esp: number;
  /** Sound pressure level in dB(A) */
  noiseLevel: number;
  /** Power input in W */
  powerInput: number;

  // ─── Physical Properties ─────────────────────────
  /** Position on canvas in mm */
  position: { x: number; y: number };
  /** Rotation angle in degrees */
  rotation: number;
  /** Physical dimensions in mm */
  dimensions: { width: number; depth: number; height: number };
  /** Weight in kg */
  weight: number;
  /** Mount type */
  mountType: VRFMountType;
  /** Elevation from finished floor level in mm */
  elevationFromFloor: number;

  // ─── Connections ─────────────────────────────────
  /** Drain connection side */
  drainConnectionSide: 'left' | 'right';
  /** Supply air discharge direction in degrees (0=forward, 90=down) */
  supplyAirDirection: number;
  /** Return air position relative to unit */
  returnAirPosition: 'back' | 'bottom';
  /** Refrigerant connection ports */
  connectionPorts: VRFConnectionPort[];

  // ─── Duct Association (for ducted types) ─────────
  /** Connected supply duct run ID */
  supplyDuctRunId?: string;
  /** Connected return duct run ID */
  returnDuctRunId?: string;

  // ─── Visual State ────────────────────────────────
  visible: boolean;
  locked: boolean;
  zIndex: number;
}
```

### 1.5 Branch Kit, Refrigerant Line, Connection Port

```typescript
/**
 * VRF Branch Kit — connects main refrigerant header to branch lines.
 * Y-branch for 2-way splits, header for multi-way distribution.
 */
export interface VRFBranchKit {
  id: string;
  systemId: string;

  /** Branch kit type */
  type: VRFBranchKitType;
  /** Model number (e.g., "KHRP26A22T") */
  model: string;
  /** Position on canvas in mm */
  position: { x: number; y: number };
  /** Rotation in degrees */
  rotation: number;
  /** Main (inlet) pipe size in mm */
  mainPipeSize: number;
  /** Branch (outlet) pipe size in mm */
  branchPipeSize: number;
  /** Applicable capacity range in HP */
  capacityRange: { min: number; max: number };
  /** Connection ports */
  connectionPorts: VRFConnectionPort[];

  visible: boolean;
  locked: boolean;
  zIndex: number;
}

/**
 * VRF Refrigerant Line — copper pipe connecting two VRF components.
 * Always exists in liquid/gas pairs between the same components.
 */
export interface VRFRefrigerantLine {
  id: string;
  systemId: string;

  /** Line classification */
  lineType: VRFLineType;
  /** Pipe outer diameter in mm */
  pipeSize: number;
  /** Pipe wall thickness in mm */
  wallThickness: number;
  /** Always copper for VRF */
  material: 'copper';

  /** Source port ID */
  fromPortId: string;
  /** Destination port ID */
  toPortId: string;
  /** Route waypoints in mm (ordered from→to) */
  waypoints: Array<{ x: number; y: number }>;

  /** Computed total route length in meters */
  totalLength: number;
  /** Computed total vertical rise in meters */
  verticalRise: number;

  /** Insulation specification */
  insulation: {
    material: 'elastomeric' | 'polyethylene' | 'none';
    thickness: number; // mm (0 if none)
  };

  /** Whether this is a main header line (vs branch line) */
  isMainLine: boolean;
  /** Paired line ID (gas line's paired liquid line, and vice versa) */
  pairedLineId?: string;

  visible: boolean;
  locked: boolean;
  zIndex: number;
}

/**
 * Connection port on any VRF component.
 * Represents the physical pipe connection point.
 */
export interface VRFConnectionPort {
  /** Unique port identifier */
  id: string;
  /** Parent component ID */
  componentId: string;
  /** Port function */
  portType: VRFPortType;
  /** Which side of the component this port is on */
  side: ComponentSide;
  /** Position relative to component origin in mm */
  relativePosition: { x: number; y: number };
  /** Expected pipe diameter in mm */
  pipeSize: number;
  /** Whether a line is connected */
  isConnected: boolean;
  /** Connected refrigerant line ID */
  connectedLineId?: string;
}
```

### 1.6 Topology & Utility Types

```typescript
/**
 * Tree representation of the VRF piping network.
 * Used for routing, validation, and pipe sizing.
 */
export interface VRFSystemTopology {
  /** Root node (outdoor unit) */
  root: VRFTopologyNode;
  /** Total equivalent piping length in meters */
  totalPipingLength: number;
  /** Farthest piping run in meters */
  longestBranchLength: number;
  /** Maximum height difference between ODU and any IDU in meters */
  maxHeightDifference: number;
  /** Total number of indoor unit connections */
  connectionCount: number;
}

export interface VRFTopologyNode {
  /** Component ID (ODU, branch kit, or IDU) */
  componentId: string;
  /** Component classification */
  componentType: 'outdoor_unit' | 'branch_kit' | 'indoor_unit';
  /** Display label */
  label: string;
  /** Child nodes (downstream components) */
  children: VRFTopologyNode[];
  /** Distance from ODU along pipe route in meters */
  distanceFromRoot: number;
  /** Height relative to ODU in meters (positive = above) */
  heightFromRoot: number;
  /** Cumulative downstream capacity in kW */
  downstreamCapacity: number;
  /** Required pipe size for this branch in mm */
  requiredPipeSize: { liquid: number; gas: number };
}

/**
 * Union type for any VRF component (for generic selection handling).
 */
export type VRFComponent =
  | { kind: 'outdoor_unit'; data: VRFOutdoorUnit }
  | { kind: 'indoor_unit'; data: VRFIndoorUnit }
  | { kind: 'branch_kit'; data: VRFBranchKit }
  | { kind: 'refrigerant_line'; data: VRFRefrigerantLine };

/**
 * Catalog import data structure.
 */
export interface VRFCatalogData {
  manufacturer: VRFManufacturer;
  seriesName: string;
  refrigerant: VRFRefrigerant;
  outdoorUnit: {
    model: string;
    capacity: number;
  };
  indoorUnits: Array<{
    model: string;
    type: VRFIndoorUnitType;
    capacity: number;
    quantity: number;
    floorAssignment?: string;
    roomAssignment?: string;
  }>;
}

/**
 * System-level color tags for visual identification.
 * Each VRF system gets a distinct color on the canvas.
 */
export const VRF_SYSTEM_COLORS = [
  '#2563EB', // Blue
  '#DC2626', // Red
  '#16A34A', // Green
  '#9333EA', // Purple
  '#EA580C', // Orange
  '#0891B2', // Cyan
  '#CA8A04', // Yellow
  '#DB2777', // Pink
] as const;

/**
 * Default values for creating new VRF components.
 */
export const VRF_DEFAULTS = {
  system: {
    manufacturer: 'daikin' as VRFManufacturer,
    refrigerant: 'R410A' as VRFRefrigerant,
    systemMode: 'heat_pump' as const,
    colorTag: '#2563EB',
  },
  outdoorUnit: {
    rotation: 0,
    visible: true,
    locked: false,
    zIndex: 100,
  },
  indoorUnit: {
    rotation: 0,
    mountType: 'ceiling' as VRFMountType,
    elevationFromFloor: 2700, // mm (typical ceiling height)
    drainConnectionSide: 'right' as const,
    supplyAirDirection: 0,
    returnAirPosition: 'back' as const,
    visible: true,
    locked: false,
    zIndex: 101,
  },
  branchKit: {
    rotation: 0,
    visible: true,
    locked: false,
    zIndex: 99,
  },
  refrigerantLine: {
    material: 'copper' as const,
    insulation: {
      material: 'elastomeric' as const,
      thickness: 13, // mm (standard for VRF)
    },
    visible: true,
    locked: false,
    zIndex: 98,
  },
} as const;
```

### 1.7 Export from types/index.ts

Add to `packages/drawing-engine/src/types/index.ts`:
```typescript
export * from './vrf';
```

---

## Step 2: Create VRF Store Slice

**File:** `packages/drawing-engine/src/store/slices/vrfSlice.ts`

### 2.1 State Interface

```typescript
export interface VRFSliceState {
  // ─── Entity Collections ──────────────────────────
  /** All VRF systems in the current drawing */
  vrfSystems: VRFSystem[];
  /** All outdoor units */
  vrfOutdoorUnits: VRFOutdoorUnit[];
  /** All indoor units */
  vrfIndoorUnits: VRFIndoorUnit[];
  /** All branch kits */
  vrfBranchKits: VRFBranchKit[];
  /** All refrigerant lines */
  vrfRefrigerantLines: VRFRefrigerantLine[];

  // ─── Selection & Tool State ──────────────────────
  /** Currently selected VRF component ID */
  selectedVRFComponentId: string | null;
  /** Currently selected VRF component kind */
  selectedVRFComponentKind: VRFComponent['kind'] | null;
  /** Active VRF tool mode */
  vrfToolMode: 'place-outdoor' | 'place-indoor' | 'place-branch' | 'draw-pipe' | null;
  /** Model being placed (during placement tool) */
  vrfPlacementModel: string | null;
  /** IDU type being placed (during indoor placement) */
  vrfPlacementIndoorType: VRFIndoorUnitType | null;
  /** System ID being edited/added to */
  activeVRFSystemId: string | null;

  // ─── Ghost Preview State ─────────────────────────
  /** Ghost preview position during placement */
  vrfGhostPosition: { x: number; y: number } | null;
  /** Ghost preview rotation during placement */
  vrfGhostRotation: number;

  // ─── Pipe Drawing State ──────────────────────────
  /** Active pipe drawing start port */
  vrfPipeDrawingFromPort: string | null;
  /** Current pipe drawing waypoints */
  vrfPipeDrawingWaypoints: Array<{ x: number; y: number }>;
}
```

### 2.2 Actions Interface

```typescript
export interface VRFSliceActions {
  // ─── System CRUD ─────────────────────────────────
  addVRFSystem: (params: {
    name?: string;
    manufacturer?: VRFManufacturer;
    refrigerant?: VRFRefrigerant;
    systemMode?: 'heat_pump' | 'heat_recovery';
    floorId?: string;
  }) => string; // returns system ID

  removeVRFSystem: (systemId: string) => void; // cascades delete all children
  updateVRFSystem: (systemId: string, updates: Partial<Pick<VRFSystem, 'name' | 'manufacturer' | 'refrigerant' | 'seriesName' | 'systemMode' | 'floorId' | 'colorTag'>>) => void;

  // ─── Outdoor Unit CRUD ───────────────────────────
  addOutdoorUnit: (systemId: string, params: {
    model: string;
    position: { x: number; y: number };
    // All other fields derived from model lookup in VRF_COMPONENTS
  }) => string;

  updateOutdoorUnit: (unitId: string, updates: Partial<VRFOutdoorUnit>) => void;
  moveOutdoorUnit: (unitId: string, position: { x: number; y: number }) => void;
  rotateOutdoorUnit: (unitId: string, rotation: number) => void;

  // ─── Indoor Unit CRUD ────────────────────────────
  addIndoorUnit: (systemId: string, params: {
    model: string;
    type: VRFIndoorUnitType;
    position: { x: number; y: number };
    roomId?: string;
  }) => string;

  removeIndoorUnit: (unitId: string) => void; // also removes connected lines
  updateIndoorUnit: (unitId: string, updates: Partial<VRFIndoorUnit>) => void;
  moveIndoorUnit: (unitId: string, position: { x: number; y: number }) => void;
  rotateIndoorUnit: (unitId: string, rotation: number) => void;
  assignIndoorUnitToRoom: (unitId: string, roomId: string | null) => void;

  // ─── Branch Kit CRUD ─────────────────────────────
  addBranchKit: (systemId: string, params: {
    type: VRFBranchKitType;
    model: string;
    position: { x: number; y: number };
  }) => string;

  removeBranchKit: (kitId: string) => void;
  updateBranchKit: (kitId: string, updates: Partial<VRFBranchKit>) => void;
  moveBranchKit: (kitId: string, position: { x: number; y: number }) => void;

  // ─── Refrigerant Line CRUD ───────────────────────
  addRefrigerantLine: (systemId: string, params: {
    lineType: VRFLineType;
    fromPortId: string;
    toPortId: string;
    waypoints: Array<{ x: number; y: number }>;
    pipeSize: number;
  }) => string;

  removeRefrigerantLine: (lineId: string) => void;
  updateRefrigerantLine: (lineId: string, updates: Partial<VRFRefrigerantLine>) => void;
  updateRefrigerantLineWaypoints: (lineId: string, waypoints: Array<{ x: number; y: number }>) => void;

  // ─── Auto-Routing ────────────────────────────────
  /** Generate all piping for a system (branch kits + refrigerant lines) */
  autoGeneratePiping: (systemId: string) => void;
  /** Recalculate routing after component moved/added/removed */
  recalculateRouting: (systemId: string) => void;
  /** Clear all auto-generated piping for re-routing */
  clearSystemPiping: (systemId: string) => void;

  // ─── Topology & Validation ───────────────────────
  /** Build and return the system topology tree */
  getSystemTopology: (systemId: string) => VRFSystemTopology | null;
  /** Run validation checks against VRF limits */
  validateSystem: (systemId: string) => VRFValidationMessage[];
  /** Recalculate system-level computed fields (totalConnectedCapacity, capacityRatio, status) */
  recalculateSystemMetrics: (systemId: string) => void;

  // ─── Selection & Tool ────────────────────────────
  selectVRFComponent: (componentId: string | null, kind?: VRFComponent['kind'] | null) => void;
  setVRFToolMode: (mode: VRFSliceState['vrfToolMode']) => void;
  setVRFPlacementModel: (model: string | null, indoorType?: VRFIndoorUnitType | null) => void;
  setActiveVRFSystem: (systemId: string | null) => void;

  // ─── Ghost Preview ───────────────────────────────
  updateVRFGhostPosition: (position: { x: number; y: number } | null) => void;
  updateVRFGhostRotation: (rotation: number) => void;

  // ─── Pipe Drawing ────────────────────────────────
  startPipeDrawing: (fromPortId: string) => void;
  addPipeWaypoint: (point: { x: number; y: number }) => void;
  undoPipeWaypoint: () => void;
  commitPipeDrawing: (toPortId: string) => void;
  cancelPipeDrawing: () => void;

  // ─── Catalog Import ──────────────────────────────
  addSystemFromCatalog: (data: VRFCatalogData) => string;

  // ─── Lookup Helpers ──────────────────────────────
  getVRFComponentAtPoint: (point: { x: number; y: number }, tolerance?: number) => VRFComponent | null;
  getSystemByComponentId: (componentId: string) => VRFSystem | null;
  getOutdoorUnit: (unitId: string) => VRFOutdoorUnit | undefined;
  getIndoorUnit: (unitId: string) => VRFIndoorUnit | undefined;
  getBranchKit: (kitId: string) => VRFBranchKit | undefined;
  getRefrigerantLine: (lineId: string) => VRFRefrigerantLine | undefined;
  getIndoorUnitsForSystem: (systemId: string) => VRFIndoorUnit[];
  getRefrigerantLinesForSystem: (systemId: string) => VRFRefrigerantLine[];
  getConnectedLinesForComponent: (componentId: string) => VRFRefrigerantLine[];

  // ─── Bulk Operations ─────────────────────────────
  deleteSelectedVRFComponent: () => void;
  duplicateVRFComponent: (componentId: string, offset?: { x: number; y: number }) => string | null;
  clearAllVRFData: () => void;
}
```

### 2.3 Implementation Requirements

**ID Generation:** Use `nanoid(12)` for all entity IDs (consistent with existing codebase).

**Immutable Updates:** Use the same `set((state) => ({ ... }))` spread pattern from `wallSlice.ts`. Do NOT use Immer `produce` unless the existing store uses it — match exactly.

**Computed Field Auto-Recalculation:**
When any of these actions are called, auto-trigger `recalculateSystemMetrics(systemId)`:
- `addIndoorUnit`, `removeIndoorUnit`, `updateIndoorUnit` (if capacity changes)
- `addRefrigerantLine`, `removeRefrigerantLine`, `updateRefrigerantLine`
- `addBranchKit`, `removeBranchKit`
- `autoGeneratePiping`, `recalculateRouting`

`recalculateSystemMetrics` must:
1. Sum all IDU cooling capacities → `totalConnectedCapacity`
2. Calculate `capacityRatio = (totalConnectedCapacity / maxCapacity) * 100`
3. Call `validateSystem` → update `validationMessages` and `status`
4. Update `updatedAt` timestamp

**Cascade Deletions:**
- `removeVRFSystem`: delete all ODUs, IDUs, branch kits, lines belonging to that system
- `removeIndoorUnit`: disconnect and delete all lines connected to that IDU's ports
- `removeBranchKit`: disconnect all lines connected to its ports, reconnect upstream/downstream if possible
- `removeRefrigerantLine`: update port `isConnected` flags on both connected components, also remove paired line if it exists

**Validation Integration:**
Wire `validateSystem` to call `validateVRFSystem()` from `packages/shared/src/utils/calculations.ts`, computing:
- `totalPipingLength`: sum of all `VRFRefrigerantLine.totalLength` in the system
- `maxHeightDifference`: max of all `VRFRefrigerantLine.verticalRise`
- `maxBranchLength`: longest distance from any branch kit to its connected IDU
- `connectionCount`: `indoorUnitIds.length`

**Port Management:**
When connecting a line to a port, update:
- Port's `isConnected = true` and `connectedLineId = lineId`
When disconnecting:
- Port's `isConnected = false` and `connectedLineId = undefined`

**Color Tag Auto-Assignment:**
When creating a new system, assign the next available color from `VRF_SYSTEM_COLORS` that isn't already used by another system.

---

## Step 3: Integrate into Main Store

**File:** `packages/drawing-engine/src/store/index.ts`

Follow the exact composition pattern used for `wallSlice`:
1. Import VRF slice state and actions types
2. Add to the combined `DrawingStore` type
3. Spread VRF slice into the `create()` factory
4. Ensure VRF initial state is included in any reset/clear functions

**File:** `packages/drawing-engine/src/store/slices/index.ts`

Export the VRF slice:
```typescript
export { createVRFSlice } from './vrfSlice';
export type { VRFSliceState, VRFSliceActions } from './vrfSlice';
```

---

## Quality Checklist

- [ ] All types have JSDoc comments
- [ ] All numeric fields document their unit (mm, kW, Pa, etc.)
- [ ] VRF_DEFAULTS provides sensible defaults for factory functions
- [ ] `VRF_SYSTEM_COLORS` provides 8 distinct colors for multi-system visual clarity
- [ ] Every CRUD action validates input bounds (e.g., rotation clamped to 0-360)
- [ ] Cascade deletes properly clean up all references
- [ ] Port connection state stays synchronized with line state
- [ ] `recalculateSystemMetrics` is called after every mutation that affects capacity or piping
- [ ] Validation messages include specific `componentId` for click-to-navigate in UI
- [ ] Store follows exact same patterns as `wallSlice.ts`
- [ ] No direct state mutation — all updates through `set()` callback

---

---

# PROMPT 2: VRF Component Renderers (Fabric.js Canvas)

---

## Task

Create Fabric.js renderers for all VRF components (outdoor units, indoor units, branch kits, refrigerant lines) on the smart drawing board canvas. The renderers must produce **modern, professional, visually clear** plan-view representations that match real-world HVAC engineering drawing conventions while being intuitive for non-expert users.

---

## Pre-Read Required Files (READ THESE FIRST)

1. **`packages/drawing-engine/src/components/canvas/hvac/HvacPlanRenderer.ts`** — Primary pattern. Study:
   - How `HvacGroup` Fabric groups are composed (bgRect, outline, dividerLine, grillLines, labels, selectionHalo)
   - The `groups` Map for tracking rendered objects by ID
   - `selectedIds` Set and `hoveredId` for interaction state
   - Color constants: `rgba(42,127,255,...)` palette
   - How `MM_TO_PX` scaling works
   - How groups are added/removed from canvas
   - Selection halo visibility toggle pattern

2. **`packages/drawing-engine/src/components/canvas/wall/WallRenderer.ts`** — Study `VISUAL_CONFIG`:
   - How design tokens are consolidated in a single config object
   - Selection/hover stroke colors and widths
   - Endpoint handle styling (radius, stroke, fill, shadow)
   - Dimension label styling

3. **`packages/drawing-engine/src/components/DrawingCanvas.tsx`** — Study:
   - How renderers are instantiated and stored as refs
   - How canvas events (`mouse:over`, `mouse:out`, `mouse:down`, `object:moving`) are handled
   - How rendering layers are ordered
   - How selection is propagated to the store
   - How context menus are triggered and positioned

4. **`packages/drawing-engine/src/components/ObjectLibraryPanel.tsx`** — Study glyph rendering:
   - `ObjectPreviewGlyph` SVG rendering patterns for doors/windows
   - How symbols are defined with SVG paths and dimensions
   - Preview thumbnail generation

5. **`packages/shared/src/constants/hvacComponents.ts`** — Reference VRF component physical dimensions and properties for accurate rendering.

6. **VRF types from Chunk 1.1** — All VRF interfaces that drive the rendering.

---

## Step 1: Create VRF Visual Configuration

**File:** `packages/drawing-engine/src/components/canvas/hvac/vrfVisualConfig.ts`

Define a consolidated visual configuration object (like `VISUAL_CONFIG` in WallRenderer):

```typescript
/**
 * Centralized visual design tokens for VRF component rendering.
 * All colors, sizes, and styles for consistent VRF visualization.
 */
export const VRF_VISUAL_CONFIG = {
  // ─── Outdoor Unit ────────────────────────────────
  outdoorUnit: {
    fill: '#F1F5F9',           // Slate-100 — light neutral fill
    stroke: '#334155',          // Slate-700 — strong border
    strokeWidth: 2,
    cornerRadius: 4,            // Rounded corners for modern look
    compressorSymbolColor: '#475569', // Slate-600
    fanSymbolColor: '#64748B',  // Slate-500
    labelColor: '#1E293B',      // Slate-800
    labelFontSize: 10,
    capacityBadgeBg: '#1E40AF', // Blue-800
    capacityBadgeText: '#FFFFFF',
    capacityBadgeFontSize: 9,
    portRadius: 4,
    shadowColor: 'rgba(0,0,0,0.08)',
    shadowBlur: 6,
    shadowOffsetY: 2,
  },

  // ─── Indoor Unit ─────────────────────────────────
  indoorUnit: {
    ducted: {
      fill: 'rgba(59, 130, 246, 0.06)',   // Blue-500 @ 6% — subtle ceiling tint
      stroke: 'rgba(59, 130, 246, 0.60)',  // Blue-500 @ 60%
      strokeWidth: 1.5,
      strokeDashArray: [6, 3],             // Dashed = ceiling convention
      ductStubColor: 'rgba(59, 130, 246, 0.40)',
      ductStubWidth: 1,
      ductStubLength: 30,                  // px stub extension
    },
    cassette: {
      fill: 'rgba(59, 130, 246, 0.06)',
      stroke: 'rgba(59, 130, 246, 0.60)',
      strokeWidth: 1.5,
      strokeDashArray: [6, 3],
      arrowColor: 'rgba(59, 130, 246, 0.50)',
      arrowSize: 8,
    },
    wallMounted: {
      fill: 'rgba(34, 197, 94, 0.08)',    // Green-500 @ 8%
      stroke: 'rgba(34, 197, 94, 0.60)',   // Green-500 @ 60%
      strokeWidth: 1.5,
      wallIndicatorColor: '#4B5563',        // Gray-600
      wallIndicatorWidth: 2,
    },
    floorUnit: {
      fill: 'rgba(168, 85, 247, 0.06)',    // Purple-500 @ 6%
      stroke: 'rgba(168, 85, 247, 0.55)',   // Purple-500 @ 55%
      strokeWidth: 1.5,
      arrowColor: 'rgba(168, 85, 247, 0.50)',
    },
    // Common IDU properties
    labelColor: 'rgba(30, 58, 138, 0.85)',  // Blue-900 @ 85%
    labelFontSize: 9,
    capacityLabelFontSize: 8,
    capacityLabelColor: '#6B7280',           // Gray-500
    modelLabelFontSize: 7,
    modelLabelColor: '#9CA3AF',              // Gray-400
    roomBadgeBg: 'rgba(59, 130, 246, 0.12)',
    roomBadgeText: '#2563EB',
    roomBadgeFontSize: 8,
  },

  // ─── Branch Kit ──────────────────────────────────
  branchKit: {
    fill: '#FEF3C7',           // Amber-100
    stroke: '#D97706',          // Amber-600
    strokeWidth: 1.5,
    portCircleRadius: 3.5,
    portConnectedFill: '#22C55E',   // Green-500
    portDisconnectedFill: '#EF4444', // Red-500
    portStroke: '#FFFFFF',
    portStrokeWidth: 1,
    labelColor: '#92400E',      // Amber-800
    labelFontSize: 8,
  },

  // ─── Refrigerant Lines ───────────────────────────
  refrigerantLine: {
    gas: {
      stroke: '#F97316',        // Orange-500 — hot gas
      strokeWidth: 2.5,
      strokeDashArray: [8, 4],  // Dashed for gas
      opacity: 0.85,
    },
    liquid: {
      stroke: '#3B82F6',        // Blue-500 — liquid
      strokeWidth: 1.5,
      strokeDashArray: null,     // Solid for liquid
      opacity: 0.85,
    },
    suction: {
      stroke: '#8B5CF6',        // Violet-500
      strokeWidth: 2,
      strokeDashArray: [10, 5],
      opacity: 0.80,
    },
    pairGap: 8,                 // px gap between paired gas/liquid lines
    arrowSize: 6,               // Direction arrow triangle size
    arrowInterval: 150,         // px between direction arrows
    arrowColor: '#6B7280',      // Gray-500
    sizeLabelFontSize: 8,
    sizeLabelColor: '#4B5563',  // Gray-600
    sizeLabelBg: 'rgba(255, 255, 255, 0.85)',
    insulationIndicatorColor: 'rgba(0, 0, 0, 0.08)',
    insulationIndicatorWidth: 2, // px added to each side
  },

  // ─── Connection Ports ────────────────────────────
  port: {
    radius: 4,
    connectedFill: '#22C55E',    // Green-500
    disconnectedFill: '#FCA5A5', // Red-300 (softer than full red)
    hoveredFill: '#FDE047',      // Yellow-300
    stroke: '#FFFFFF',
    strokeWidth: 1.5,
    glowColor: 'rgba(34, 197, 94, 0.3)', // Green glow for snap
    glowRadius: 8,
  },

  // ─── Selection & Interaction ─────────────────────
  selection: {
    haloColor: '#2563EB',        // Blue-600
    haloWidth: 2,
    haloDashArray: [4, 3],
    haloOffset: 4,               // px offset from component edge
    haloOpacity: 0.8,
  },
  hover: {
    fillOverlay: 'rgba(37, 99, 235, 0.06)', // Subtle blue tint
    strokeColor: '#2563EB',
    strokeWidth: 1.5,
  },

  // ─── Tooltip ─────────────────────────────────────
  tooltip: {
    bg: '#1E293B',               // Slate-800
    text: '#F8FAFC',             // Slate-50
    fontSize: 11,
    fontFamily: 'Inter, system-ui, sans-serif',
    padding: { x: 8, y: 5 },
    cornerRadius: 4,
    maxWidth: 200,
    opacity: 0.95,
    offsetY: -12,                // Above the component
  },

  // ─── System Color Badge ──────────────────────────
  systemBadge: {
    size: 6,                     // Small circle in top-right corner
    strokeWidth: 1,
    stroke: '#FFFFFF',
  },

  // ─── Scaling ─────────────────────────────────────
  /** Conversion factor: mm in drawing space → px on canvas */
  MM_TO_PX: 0.1, // Updated at zoom level changes
} as const;
```

---

## Step 2: Create VRF SVG Symbol Definitions

**File:** `packages/drawing-engine/src/components/canvas/hvac/VRFSymbols.ts`

Define plan-view symbol paths for each VRF component type. These must follow **engineering drawing conventions** while being visually appealing.

### Requirements per symbol:

**Outdoor Unit Symbol:**
- Rectangle with rounded corners representing the unit footprint
- Internal: compressor symbol (circle with zigzag path), fan symbol (circle with radial lines)
- External: connection port indicators on the designated side
- Model label area above/below
- Capacity badge (e.g., "20HP") in bottom-right corner
- System color indicator dot in top-right corner

**Indoor Unit Symbols (per type):**

- **Ducted:** Rectangle with dashed border (ceiling convention). Two duct stub lines extending from supply and return sides. Internal: horizontal divider separating supply zone (with "S" label) and return zone (with "R" label). Supply side shows directional arrows.

- **Cassette 4-Way:** Square with dashed border. Four equidistant airflow arrows pointing outward from center (top, right, bottom, left). Small center indicator.

- **Cassette 2-Way:** Rectangle with dashed border. Two opposing airflow arrows pointing outward.

- **Cassette 1-Way:** Rectangle with dashed border. Single airflow arrow pointing from one side.

- **Wall Mounted:** Rectangle with solid wall-side border and dashed other sides. Downward airflow arrows from bottom. Wall indicator bar on top.

- **Floor Standing:** Tall rectangle with solid floor-side border. Upward airflow arrows from top.

- **Ceiling Suspended:** Rectangle with dashed border. Downward airflow arrows. Suspension point indicators (small circles) at two points.

- **Floor Concealed:** Rectangle flush at bottom. Upward supply arrows through grille pattern.

- **Ceiling Concealed:** Rectangle with dashed border. Downward supply through linear slot representation.

**Branch Kit Symbols:**

- **Y-Branch:** Y-shaped path with port circles at the 3 endpoints. Main inlet at bottom, two branch outlets at top. Size label between branches.

- **Header (2-8 port):** Rectangular manifold with port circles spaced evenly along one long edge. Main inlet on opposite side. Port count label inside.

**Each symbol definition must export:**
```typescript
export interface VRFSymbolDefinition {
  /** SVG path data for the main shape */
  paths: Array<{
    d: string;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    strokeDashArray?: number[];
    opacity?: number;
  }>;
  /** Default dimensions in mm (for scaling to canvas) */
  defaultDimensions: { width: number; height: number };
  /** Port positions relative to center, in mm */
  portPositions: Array<{
    id: string;
    type: VRFPortType;
    side: ComponentSide;
    offset: { x: number; y: number }; // from center
  }>;
  /** Label anchor point relative to center */
  labelAnchor: { x: number; y: number };
  /** Capacity badge anchor point */
  capacityBadgeAnchor: { x: number; y: number };
  /** Hit area padding in mm */
  hitAreaPadding: number;
}
```

---

## Step 3: Create VRF Plan Renderer

**File:** `packages/drawing-engine/src/components/canvas/hvac/VRFPlanRenderer.ts`

### Class Architecture:

```typescript
export class VRFPlanRenderer {
  private canvas: fabric.Canvas;
  private store: () => VRFSliceState & VRFSliceActions;

  // ─── Object Tracking ─────────────────────────────
  /** Map of component ID → Fabric group for efficient updates */
  private groups: Map<string, fabric.Group> = new Map();
  /** Map of line ID → Fabric objects for refrigerant lines */
  private lineObjects: Map<string, fabric.Object[]> = new Map();

  // ─── Interaction State ───────────────────────────
  private selectedIds: Set<string> = new Set();
  private hoveredId: string | null = null;

  // ─── Tooltip Management ──────────────────────────
  private tooltipGroup: fabric.Group | null = null;
  private tooltipTimeout: ReturnType<typeof setTimeout> | null = null;

  // ─── Scale Factor ────────────────────────────────
  private mmToPx: number = 0.1;
}
```

### Method Specifications:

#### `renderAll(): void`
- Iterate all VRF systems from store
- For each system, render in order: refrigerant lines (bottom) → branch kits → indoor units → outdoor units (top)
- Clear previously rendered objects before re-rendering
- Batch canvas updates: `canvas.renderOnAddRemove = false` → render all → `canvas.renderOnAddRemove = true` → `canvas.requestRenderAll()`

#### `renderOutdoorUnit(unit: VRFOutdoorUnit): fabric.Group`
Create a Fabric.Group containing:
1. **Background rectangle** — filled, rounded corners, with subtle drop shadow
2. **Compressor symbol** — circle with zigzag polyline inside (positioned in left half)
3. **Fan symbol** — circle with 4 radial lines (positioned in right half)
4. **Model label** — text above the unit (Inter font, 10px, Slate-800)
5. **Capacity badge** — small rounded rect with "XX HP" text (Blue-800 bg, white text)
6. **System color dot** — 6px circle in top-right corner matching `system.colorTag`
7. **Connection ports** — small circles on the designated side (green/red based on `isConnected`)
8. **Selection halo** — dashed blue border, visibility controlled by `selectedIds`

Group properties:
```typescript
{
  left: unit.position.x * mmToPx,
  top: unit.position.y * mmToPx,
  angle: unit.rotation,
  selectable: !unit.locked,
  hasControls: false,
  hasBorders: false,
  lockScalingX: true,
  lockScalingY: true,
  data: { type: 'vrf-outdoor', id: unit.id, systemId: unit.systemId },
  hoverCursor: unit.locked ? 'default' : 'move',
}
```

#### `renderIndoorUnit(unit: VRFIndoorUnit): fabric.Group`
Create a Fabric.Group with type-specific rendering:

**All types share:**
1. Model label (top, 9px, blue-900)
2. Capacity label (bottom, 8px, gray-500, e.g., "2.2 kW")
3. Room badge (if `roomId` exists — small rounded rect with room name, blue-500 @ 12% bg)
4. Connection ports (small circles)
5. Selection halo
6. System color dot

**Type-specific rendering:**

For **ducted**: Rectangle with dashed stroke (ceiling convention). Divider line separating S/R zones. Supply zone with grille lines. Duct stub lines extending from supply and return sides (40px extensions with lighter stroke). "S" and "R" labels in respective zones.

For **cassette_4way**: Square with dashed stroke. Four airflow arrow triangles pointing outward from center, evenly spaced at 90° intervals. Small cross at center.

For **cassette_2way**: Rectangle with dashed stroke. Two opposing arrow triangles on long sides.

For **wall_mounted**: Rectangle with solid top border (wall indicator, thicker stroke 3px, dark). Dashed remaining borders. Downward arrow triangle at bottom center.

For **floor_standing**: Rectangle with solid bottom border. Upward arrows from top.

For **ceiling_suspended**: Rectangle with dashed stroke. Two small filled circles (suspension points) on top edge at 1/3 and 2/3 positions. Downward arrows from bottom.

#### `renderBranchKit(kit: VRFBranchKit): fabric.Group`
1. Y-path or rectangular manifold (based on kit.type)
2. Port circles at connection points (green/red)
3. Pipe size labels next to ports (8px, amber-800)
4. Selection halo
5. Tooltip on hover showing: model, main/branch pipe sizes

#### `renderRefrigerantLine(line: VRFRefrigerantLine): fabric.Object[]`
Returns array of Fabric objects (not a group, since lines can be complex paths):

1. **Main polyline** — follows `line.waypoints`, styled per `VRF_VISUAL_CONFIG.refrigerantLine[line.lineType]`
2. **Direction arrows** — small filled triangles every 150px along the path, pointing in flow direction
3. **Pipe size label** — at midpoint of longest segment, e.g., "Ø15.88" with white background pill

For paired gas+liquid lines:
- Offset the two lines by `pairGap/2` on each side of the logical route
- Gas line on the "outside" (farther from wall), liquid on "inside"

#### `renderConnectionPorts(component: VRFOutdoorUnit | VRFIndoorUnit | VRFBranchKit): fabric.Circle[]`
For each port in `component.connectionPorts`:
- Small circle at the port's absolute position (component position + relative position, accounting for rotation)
- Fill: green if connected, soft red if disconnected
- On hover during pipe drawing mode: enlarge slightly + green glow effect (snap indicator)

#### `updateComponent(componentId: string): void`
1. Remove existing Fabric objects for this component
2. Look up component from store
3. Re-render the component
4. Maintain selection/hover state
5. Request canvas render

#### `removeComponent(componentId: string): void`
1. Get Fabric objects from `groups` or `lineObjects` map
2. Remove from canvas
3. Delete from tracking maps
4. Request canvas render

#### `highlightComponent(componentId: string, highlight: boolean): void`
1. Find the group in `groups` map
2. Toggle selection halo visibility
3. If highlighting, add to `selectedIds`; if un-highlighting, remove
4. Request canvas render

#### `showTooltip(componentId: string, canvasPoint: { x: number; y: number }): void`
1. Clear any existing tooltip timeout
2. Set 300ms delay (avoid flicker on fast mouse movement)
3. After delay, create tooltip group:
   - Dark rounded rectangle background (Slate-800, 95% opacity)
   - Multi-line text: Line 1 = component type + model, Line 2 = capacity, Line 3 = system name
   - Position above the cursor (offsetY: -12)
4. Add to canvas on top layer
5. Store reference in `tooltipGroup`

#### `hideTooltip(): void`
1. Clear timeout
2. Remove `tooltipGroup` from canvas
3. Set `tooltipGroup = null`

#### `clearAll(): void`
1. Remove all VRF objects from canvas
2. Clear `groups` and `lineObjects` maps
3. Clear `selectedIds`
4. Hide tooltip
5. Request canvas render

---

## Step 4: Integrate into DrawingCanvas.tsx

**File:** `packages/drawing-engine/src/components/DrawingCanvas.tsx`

### 4.1 Instantiation

Add alongside existing renderers:
```typescript
const vrfRendererRef = useRef<VRFPlanRenderer | null>(null);

// In canvas initialization effect:
vrfRendererRef.current = new VRFPlanRenderer(fabricCanvas, () => useSmartDrawingStore.getState());
```

### 4.2 Store Subscription

Subscribe to VRF store changes to trigger re-renders:
```typescript
// Subscribe to VRF data changes
useEffect(() => {
  const unsubscribe = useSmartDrawingStore.subscribe(
    (state) => ({
      systems: state.vrfSystems,
      outdoorUnits: state.vrfOutdoorUnits,
      indoorUnits: state.vrfIndoorUnits,
      branchKits: state.vrfBranchKits,
      lines: state.vrfRefrigerantLines,
    }),
    (vrfData, prevVrfData) => {
      if (!vrfRendererRef.current) return;
      // Diff and update only changed components for performance
      // Full re-render if structure changed (add/remove)
      // Targeted update if only position/properties changed
      vrfRendererRef.current.renderAll();
    },
    { equalityFn: shallow }
  );
  return () => unsubscribe();
}, [fabricCanvas]);
```

### 4.3 Event Handling

Wire canvas events for VRF interactions:

**`mouse:over` event:**
```typescript
// When hovering over a VRF object:
if (target?.data?.type?.startsWith('vrf-')) {
  vrfRendererRef.current?.showTooltip(target.data.id, { x: e.pointer.x, y: e.pointer.y });
  store.selectVRFComponent(null); // Don't select on hover, just show tooltip
  canvas.setCursor('pointer');
}
```

**`mouse:out` event:**
```typescript
if (target?.data?.type?.startsWith('vrf-')) {
  vrfRendererRef.current?.hideTooltip();
}
```

**`mouse:down` event (left click):**
```typescript
if (target?.data?.type?.startsWith('vrf-')) {
  const { id, type: componentType, systemId } = target.data;
  const kind = componentType.replace('vrf-', '') as VRFComponent['kind'];
  store.selectVRFComponent(id, kind);
  store.setActiveVRFSystem(systemId);
  vrfRendererRef.current?.highlightComponent(id, true);
}
```

**`mouse:down` event (right click / contextmenu):**
```typescript
if (target?.data?.type?.startsWith('vrf-')) {
  e.e.preventDefault();
  setVrfContextMenu({
    componentId: target.data.id,
    componentKind: target.data.type.replace('vrf-', ''),
    systemId: target.data.systemId,
    x: e.e.clientX,
    y: e.e.clientY,
  });
}
```

**`object:moving` event:**
```typescript
if (target?.data?.type?.startsWith('vrf-')) {
  const newPos = {
    x: target.left! / vrfRendererRef.current.mmToPx,
    y: target.top! / vrfRendererRef.current.mmToPx,
  };

  // Snap to grid
  if (snapToGrid) {
    newPos.x = Math.round(newPos.x / gridSize) * gridSize;
    newPos.y = Math.round(newPos.y / gridSize) * gridSize;
  }

  // Update store position
  const { id, type: componentType } = target.data;
  if (componentType === 'vrf-outdoor') store.moveOutdoorUnit(id, newPos);
  else if (componentType === 'vrf-indoor') store.moveIndoorUnit(id, newPos);
  else if (componentType === 'vrf-branch') store.moveBranchKit(id, newPos);
}
```

**`object:modified` event (after drag ends):**
```typescript
if (target?.data?.type?.startsWith('vrf-')) {
  // Trigger piping recalculation if auto-routing is enabled
  const systemId = target.data.systemId;
  const system = store.getSystemByComponentId(target.data.id);
  if (system?.pipingGenerated) {
    store.recalculateRouting(systemId);
  }
}
```

### 4.4 Context Menu Component

Add a VRF-specific context menu component (render conditionally when `vrfContextMenu` state is set):

```typescript
// State
const [vrfContextMenu, setVrfContextMenu] = useState<{
  componentId: string;
  componentKind: string;
  systemId: string;
  x: number;
  y: number;
} | null>(null);
```

Context menu items:
```
┌──────────────────────────────┐
│  ✏️  Edit Properties          │
│  📋  Duplicate                │
│  🔄  Rotate 90°              │
│  🔄  Rotate Custom...        │
│  ─────────────────────────── │
│  🔗  Show Connected Lines    │
│  📊  Show in BOQ             │  (future, disabled for now)
│  🏠  Assign to Room          │  (only for indoor units)
│  ─────────────────────────── │
│  🔒  Lock/Unlock             │
│  👁  Show/Hide               │
│  ─────────────────────────── │
│  🗑  Delete                   │
└──────────────────────────────┘
```

Style the context menu to match the existing drawing engine's amber/white theme:
- Background: `bg-white rounded-lg shadow-lg border border-amber-200/80`
- Items: `px-3 py-1.5 text-sm text-slate-700 hover:bg-amber-50 cursor-pointer`
- Destructive items (Delete): `text-red-600 hover:bg-red-50`
- Dividers: `border-t border-amber-100 my-1`
- Icons: 16px Lucide icons in matching colors

### 4.5 Layer Ordering

VRF components should render in this z-order (bottom to top):
1. Walls & rooms (existing)
2. **Refrigerant lines** (z-index 98)
3. **Branch kits** (z-index 99)
4. **Outdoor units** (z-index 100)
5. **Indoor units** (z-index 101)
6. Duct work (future, z-index 102-105)
7. Dimensions & annotations (existing, top)

---

## Step 5: VRF Library Panel Integration

**File:** `packages/drawing-engine/src/components/ObjectLibraryPanel.tsx`

Add a new "VRF" category tab to the library panel alongside existing "Symbols" and "Objects" tabs.

### VRF Library Panel Design:

```
┌─────────────────────────────────────┐
│  [Symbols] [Objects] [VRF]          │  ← Tab bar
├─────────────────────────────────────┤
│  System: [VRF System A    ▼]       │  ← Active system selector
│  ─────────────────────────────────  │
│  🔍 Search VRF components...        │  ← Search input
│  ─────────────────────────────────  │
│  📦 Outdoor Units                   │  ← Category accordion
│  ├─ ┌──────┐ ┌──────┐              │
│  │  │ 🏭   │ │ 🏭   │              │  ← Component cards (2-col grid)
│  │  │10HP  │ │20HP  │              │
│  │  │Daikin│ │Daikin│              │
│  │  └──────┘ └──────┘              │
│  │                                   │
│  📦 Indoor Units                     │  ← Category accordion
│  ├─ [Ducted] [Cassette] [Wall] [Flr]│  ← Sub-type filter chips
│  │  ┌──────┐ ┌──────┐              │
│  │  │ ━━━  │ │ ╋    │              │
│  │  │2.2kW │ │3.6kW │              │
│  │  │Ducted│ │4-Way │              │
│  │  └──────┘ └──────┘              │
│  │                                   │
│  📦 Branch Kits                      │
│  ├─ ┌──────┐ ┌──────┐              │
│  │  │  Y   │ │ ═══  │              │
│  │  │Y-Brch│ │Header│              │
│  │  └──────┘ └──────┘              │
│  │                                   │
│  📦 Accessories                      │
│  └─ Pipe clamps, insulation, etc.   │
├─────────────────────────────────────┤
│  [+ New System] [📤 Import Catalog] │  ← Footer actions
└─────────────────────────────────────┘
```

### Component Card Design:

Each card should show:
- Mini symbol preview (40x40px, using the VRF symbol definitions)
- Component name (bold, 11px)
- Key spec (capacity or size, 9px, gray)
- Click to activate placement tool for that component
- Active state: amber-400 border + amber-100 bg (matching existing pattern)
- Hover: amber-50 bg transition

### Styling (matching existing ObjectLibraryPanel):
- Cards: `rounded-lg border px-2 py-2 text-left transition-colors`
- Selected: `border-amber-400 bg-amber-100/70`
- Default: `border-amber-200/80 bg-white hover:bg-amber-50`
- Category headers: `text-xs font-semibold text-slate-500 uppercase tracking-wider`
- Sub-filter chips: `rounded-full border px-2 py-0.5 text-[10px]`

---

## Quality Checklist

- [ ] All VRF symbols follow engineering plan-view conventions (dashed = ceiling, solid = floor/wall)
- [ ] Colors are from the established Tailwind palette and consistent with existing HVAC renderer
- [ ] Tooltip appears with 300ms delay and disappears immediately on mouse out
- [ ] Context menu closes on click outside or Escape key
- [ ] Selection halo matches the blue-600 used in existing wall selection
- [ ] Port connection indicators are clearly visible (green = connected, soft red = unconnected)
- [ ] Refrigerant lines render as proper paired gas+liquid with correct styling
- [ ] Direction arrows on refrigerant lines point in flow direction
- [ ] Labels are readable at default zoom and scale appropriately
- [ ] Drag and drop updates store and triggers line recalculation
- [ ] All Fabric objects have `data` property with component ID and type for event handling
- [ ] Canvas renders are batched to avoid flicker during bulk updates
- [ ] Grid snapping works during VRF component placement
- [ ] Z-ordering ensures VRF components render above walls but below dimensions
- [ ] Library panel cards match the amber/white theme of existing library
- [ ] System color dots provide visual system identification at a glance
- [ ] Drop shadow on outdoor units gives subtle depth differentiation
- [ ] All animations/transitions use 150ms duration consistent with existing UI
- [ ] Memory cleanup: objects removed from canvas when component deleted
- [ ] No console errors during normal interaction lifecycle

---

## Visual Reference Summary

| Component | Fill | Stroke | Border Style | Special |
|-----------|------|--------|-------------|---------|
| ODU | Slate-100 | Slate-700 (2px) | Solid, rounded | Drop shadow, compressor+fan symbols |
| IDU Ducted | Blue-500 @ 6% | Blue-500 @ 60% (1.5px) | Dashed [6,3] | Duct stubs, S/R zones |
| IDU Cassette | Blue-500 @ 6% | Blue-500 @ 60% (1.5px) | Dashed [6,3] | 4/2/1-way airflow arrows |
| IDU Wall | Green-500 @ 8% | Green-500 @ 60% (1.5px) | Mixed solid/dash | Wall indicator bar |
| IDU Floor | Purple-500 @ 6% | Purple-500 @ 55% (1.5px) | Solid | Floor indicator |
| Branch Kit | Amber-100 | Amber-600 (1.5px) | Solid | Port circles, pipe labels |
| Gas Line | — | Orange-500 (2.5px) | Dashed [8,4] | Direction arrows |
| Liquid Line | — | Blue-500 (1.5px) | Solid | Direction arrows |
| Port (connected) | Green-500 | White (1.5px) | — | — |
| Port (disconnected) | Red-300 | White (1.5px) | — | — |
| Selection Halo | — | Blue-600 (2px) | Dashed [4,3] | 4px offset |
| Tooltip | Slate-800 @ 95% | — | Rounded 4px | Above cursor |
