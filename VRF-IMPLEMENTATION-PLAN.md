# VRF AC System - Phase 01 Implementation Plan

## Context

The Provac HVAC web platform has a nearly-complete 2D Smart Drawing Board with walls, rooms, dimensions, sketch tools, and an HVAC component library. The next major step is implementing the full VRF AC system workflow: design on drawing board -> heat load calculation -> BOQ generation -> covering letter -> proposal assembly. This plan covers all 6 milestones needed for Phase 01 completion.

---

## Overview

| Milestone | Description | Timeline | Chunks |
|-----------|-------------|----------|--------|
| 1 | VRF System Design Engine | Weeks 1-4 | 10 chunks |
| 2 | Heat Load Calculator | Week 5 | 3 chunks |
| 3 | Smart BOQ | Weeks 6-7 | 4 chunks |
| 4 | Smart Covering Letter | Weeks 7-8 | 2 chunks |
| 5 | Compliance & Proposal | Week 8 | 2 chunks |
| 6 | PDF/CAD Import with AI | Week 9 | 2 chunks |

---

## MILESTONE 1: VRF System Design Engine (Weeks 1-4)

### 1.1 VRF System Data Model & Store (2-3 days)

**Goal:** Establish the VRF system graph structure in the drawing store.

**New files:**
- `packages/drawing-engine/src/types/vrf.ts` — Types: `VRFSystem`, `VRFIndoorUnit`, `VRFOutdoorUnit`, `VRFBranchKit`, `VRFRefrigerantLine`, `VRFSystemTopology`, `VRFConnectionPort`
- `packages/drawing-engine/src/store/slices/vrfSlice.ts` — Zustand slice: CRUD for all VRF entities, `addSystemFromCatalog`, `getSystemTopology`, `validateSystem`

**Modify:**
- `packages/drawing-engine/src/types/index.ts` — re-export VRF types
- `packages/drawing-engine/src/store/index.ts` — integrate VRF slice

**Pattern:** Follow `wallSlice.ts` (StateCreator, separate state/actions interfaces, Immer mutations)

**Types to define:**
```typescript
// VRFSystem - root entity tying all components together
interface VRFSystem {
  id: string;
  name: string;
  manufacturer: 'daikin' | 'mitsubishi' | 'samsung' | 'lg' | 'toshiba' | 'hitachi' | 'midea';
  refrigerant: 'R410A' | 'R32' | 'R134a';
  outdoorUnitId: string;
  indoorUnitIds: string[];
  branchKitIds: string[];
  refrigerantLineIds: string[];
  maxCapacity: number; // kW
  totalConnectedCapacity: number; // kW
  capacityRatio: number; // %
  status: 'draft' | 'valid' | 'warning' | 'error';
  validationMessages: ValidationMessage[];
  floorId?: string;
}

// VRFOutdoorUnit - placed outside building
interface VRFOutdoorUnit {
  id: string;
  systemId: string;
  model: string;
  manufacturer: string;
  capacity: number; // kW
  powerInput: number; // kW
  refrigerant: string;
  position: { x: number; y: number };
  rotation: number;
  dimensions: { width: number; depth: number; height: number };
  connectionPorts: VRFConnectionPort[];
  weight: number; // kg
  noiseLevel: number; // dB(A)
  maxConnections: number;
}

// VRFIndoorUnit - placed inside rooms
interface VRFIndoorUnit {
  id: string;
  systemId: string;
  roomId?: string;
  model: string;
  type: 'ducted' | 'cassette_4way' | 'cassette_2way' | 'wall_mounted' | 'floor_standing' | 'ceiling_suspended' | 'floor_concealed';
  capacity: number; // kW
  airflow: number; // L/s
  esp: number; // Pa (for ducted units)
  position: { x: number; y: number };
  rotation: number;
  dimensions: { width: number; depth: number; height: number };
  connectionPorts: VRFConnectionPort[];
  mountType: 'ceiling' | 'wall' | 'floor';
  elevationFromFloor: number; // mm
  drainConnectionSide: 'left' | 'right';
  supplyAirDirection: number; // degrees
  returnAirPosition: 'back' | 'bottom';
}

// VRFBranchKit - Y-branch or header connecting pipes
interface VRFBranchKit {
  id: string;
  systemId: string;
  type: 'y_branch' | 'header_2port' | 'header_3port' | 'header_4port' | 'header_5port' | 'header_6port' | 'header_7port' | 'header_8port';
  model: string;
  position: { x: number; y: number };
  rotation: number;
  mainPipeSize: number; // mm
  branchPipeSize: number; // mm
  capacityRange: { min: number; max: number }; // HP
  connectionPorts: VRFConnectionPort[];
}

// VRFRefrigerantLine - gas or liquid pipe between components
interface VRFRefrigerantLine {
  id: string;
  systemId: string;
  lineType: 'liquid' | 'gas' | 'suction';
  pipeSize: number; // mm diameter
  wallThickness: number; // mm
  material: 'copper';
  fromPortId: string;
  toPortId: string;
  waypoints: { x: number; y: number }[];
  totalLength: number; // m (computed)
  verticalRise: number; // m
  insulation: {
    material: 'elastomeric' | 'polyethylene';
    thickness: number; // mm
  };
  isMainLine: boolean; // main header vs branch line
}

// Connection port on any VRF component
interface VRFConnectionPort {
  id: string;
  componentId: string;
  portType: 'liquid_in' | 'liquid_out' | 'gas_in' | 'gas_out' | 'main_in' | 'branch_out';
  side: 'top' | 'bottom' | 'left' | 'right';
  position: { x: number; y: number }; // relative to component
  pipeSize: number; // mm
  isConnected: boolean;
  connectedLineId?: string;
}

// System topology tree for routing
interface VRFSystemTopology {
  root: VRFTopologyNode; // ODU
  totalPipingLength: number;
  maxPipingLength: number;
  maxHeightDifference: number;
  longestBranchLength: number;
}

interface VRFTopologyNode {
  componentId: string;
  componentType: 'outdoor_unit' | 'branch_kit' | 'indoor_unit';
  children: VRFTopologyNode[];
  distanceFromRoot: number; // m
  heightFromRoot: number; // m
}
```

**Store actions:**
```typescript
interface VRFSliceActions {
  // System CRUD
  addVRFSystem: (system: Partial<VRFSystem>) => string;
  removeVRFSystem: (systemId: string) => void;
  updateVRFSystem: (systemId: string, updates: Partial<VRFSystem>) => void;

  // Outdoor Unit
  addOutdoorUnit: (systemId: string, unit: Partial<VRFOutdoorUnit>) => string;
  updateOutdoorUnit: (unitId: string, updates: Partial<VRFOutdoorUnit>) => void;
  moveOutdoorUnit: (unitId: string, position: { x: number; y: number }) => void;

  // Indoor Unit
  addIndoorUnit: (systemId: string, unit: Partial<VRFIndoorUnit>) => string;
  removeIndoorUnit: (unitId: string) => void;
  updateIndoorUnit: (unitId: string, updates: Partial<VRFIndoorUnit>) => void;
  moveIndoorUnit: (unitId: string, position: { x: number; y: number }) => void;
  assignIndoorUnitToRoom: (unitId: string, roomId: string) => void;

  // Branch Kit
  addBranchKit: (systemId: string, kit: Partial<VRFBranchKit>) => string;
  removeBranchKit: (kitId: string) => void;
  updateBranchKit: (kitId: string, updates: Partial<VRFBranchKit>) => void;

  // Refrigerant Lines
  addRefrigerantLine: (systemId: string, line: Partial<VRFRefrigerantLine>) => string;
  removeRefrigerantLine: (lineId: string) => void;
  updateRefrigerantLine: (lineId: string, updates: Partial<VRFRefrigerantLine>) => void;

  // Auto-routing
  autoGeneratePiping: (systemId: string) => void;
  recalculateRouting: (systemId: string) => void;

  // Topology & Validation
  getSystemTopology: (systemId: string) => VRFSystemTopology;
  validateSystem: (systemId: string) => ValidationResult;

  // Catalog Import
  addSystemFromCatalog: (catalogData: VRFCatalogData) => string;

  // Selection helpers
  getVRFComponentAtPoint: (point: { x: number; y: number }) => VRFComponent | null;
  getSystemByComponentId: (componentId: string) => VRFSystem | null;
}
```

---

### 1.2 VRF Component Renderers (2-3 days)

**Goal:** Render VRF outdoor units, indoor units, branch kits, and refrigerant lines on the Fabric.js canvas.

**New files:**
- `packages/drawing-engine/src/components/canvas/hvac/VRFPlanRenderer.ts`
- `packages/drawing-engine/src/components/canvas/hvac/VRFSymbols.ts`

**Modify:**
- `packages/drawing-engine/src/components/DrawingCanvas.tsx` — instantiate VRF renderer, wire to store

**Pattern:** Follow `HvacPlanRenderer.ts`

**Rendering specifications:**

**Outdoor Unit (ODU):**
- Rectangle with compressor symbol inside
- Model label text above
- Connection ports shown as small circles (green=connected, red=unconnected)
- Dimensions to scale based on actual unit size
- Rotation handle
- Color: dark gray fill, blue border

**Indoor Unit (IDU) - by type:**
- **Ducted:** Rectangle with duct stub extensions, dashed ceiling convention, airflow arrows
- **Cassette 4-way:** Square with 4 directional airflow arrows
- **Cassette 2-way:** Rectangle with 2 directional arrows
- **Wall mounted:** Rectangle with downward airflow arrow, wall-mount indicator
- **Floor standing:** Rectangle with upward airflow arrow
- **Ceiling suspended:** Rectangle with downward arrows, suspension indicators

**Branch Kit:**
- Y-branch: Y-shaped symbol with port size labels
- Header: Rectangle with multiple port circles along one side

**Refrigerant Lines:**
- Gas line: thick dashed line (red/orange color)
- Liquid line: thin solid line (blue color)
- Both run as paired lines with 10mm visual gap
- Directional arrows every 2m along the line
- Insulation shown as outer border when selected
- Line labels: pipe size (e.g., "Ø15.88")

**Interactive behaviors:**
- Hover: highlight component + show tooltip (model, capacity)
- Click: select component, show in properties panel
- Drag: move component, trigger re-routing of connected lines
- Right-click: context menu (delete, duplicate, rotate, show in BOQ)
- Double-click IDU: open model selection dialog

---

### 1.3 VRF Placement Tools (2-3 days)

**Goal:** Interactive tools for placing VRF components on the drawing.

**New files:**
- `packages/drawing-engine/src/tools/VRFPlacementTool.ts`

**Modify:**
- `packages/drawing-engine/src/types/index.ts` — extend `DrawingTool` union with `'vrf-place-outdoor' | 'vrf-place-indoor' | 'vrf-place-branch' | 'vrf-draw-pipe'`
- `packages/drawing-engine/src/components/Toolbar.tsx` — VRF tool group
- `packages/drawing-engine/src/components/ObjectLibraryPanel.tsx` — VRF category with component cards

**Tool behaviors:**

**Place Outdoor Unit:**
1. Select model from library panel or toolbar dropdown
2. Ghost preview follows cursor
3. Snap to grid, building exterior
4. Click to place, creates new VRF system automatically
5. Opens properties panel for configuration

**Place Indoor Unit:**
1. Must have at least one VRF system created
2. Select IDU type and model from library
3. Ghost preview follows cursor, shows snap indicators
4. Auto-detect room under cursor, associate IDU with room
5. Snap to ceiling grid for cassette units, wall proximity for wall-mounted
6. Click to place, auto-add to nearest VRF system (or let user select)
7. If ducted type, auto-create duct stub

**Place Branch Kit:**
1. Select branch kit type from library
2. Place along refrigerant line path
3. Auto-split existing line and insert branch kit

**Draw Refrigerant Pipe (manual):**
1. Click-to-draw mode (similar to wall tool)
2. Click start port on component -> route orthogonally -> click end port
3. Auto-select pipe size based on downstream capacity
4. Show real-time length and validation indicators

---

### 1.4 Auto-Routing Refrigerant Piping (3 days)

**Goal:** Automatically generate optimal piping routes from ODU through branch kits to all IDUs.

**New files:**
- `packages/drawing-engine/src/utils/vrfAutoRouter.ts`

**Modify:**
- `packages/drawing-engine/src/store/slices/vrfSlice.ts` — add `autoGeneratePiping`, `recalculateRouting`

**Algorithm:**
1. Build minimum spanning tree (MST) from ODU to all IDU positions using Prim's algorithm
2. At each branch point, insert appropriate branch kit (Y-branch for 2 branches, header for 3+)
3. Route pipes using Manhattan (orthogonal) routing:
   - Prefer corridors and ceiling spaces
   - Avoid wall intersections (use R-tree spatial index for collision detection)
   - Maintain minimum bend radius
   - Route along shortest orthogonal path with obstacle avoidance (A* pathfinding on grid)
4. Size pipes based on cumulative downstream capacity:
   - Main header: sized for total system capacity
   - Each branch: sized for sum of downstream IDU capacities
   - Reference pipe size selection table from `VRF_COMPONENTS.REFRIGERANT_PIPE.sizes`
5. Validate against `DEFAULT_VRF_LIMITS`:
   - Total piping length ≤ 165m
   - Height difference ≤ 50m
   - IDU-to-branch distance ≤ 40m
   - Max 64 connections
6. Apply insulation to all lines automatically

**Re-routing triggers:**
- IDU moved or removed
- ODU moved
- New IDU added
- Branch kit manually repositioned

---

### 1.5 VRF Properties Panel Integration (1-2 days)

**Goal:** Edit all VRF properties through existing PropertiesPanel.

**Modify:**
- `packages/drawing-engine/src/components/PropertiesPanel.tsx`

**Property sections:**

**When ODU selected:**
- System name (text input)
- Manufacturer (dropdown)
- Model (searchable dropdown filtered by manufacturer)
- Capacity (kW, read-only from model)
- Refrigerant type
- Power input (kW)
- Connected IDUs count / max connections
- Total connected capacity / capacity ratio
- Noise level
- Dimensions (W x D x H)

**When IDU selected:**
- Associated room (dropdown of detected rooms)
- Unit type (ducted/cassette/wall/floor)
- Model (searchable dropdown)
- Capacity (kW)
- Airflow (L/s)
- ESP (Pa, for ducted)
- Mount type & elevation
- Drain side
- Supply air direction

**When branch kit selected:**
- Type (Y-branch / header)
- Model
- Port count
- Main pipe size / branch pipe size
- Capacity range

**When refrigerant line selected:**
- Line type (liquid/gas)
- Pipe diameter (mm)
- Length (computed, read-only)
- Vertical rise (m)
- Insulation material & thickness

**System summary panel (always visible when VRF component selected):**
- System name
- Total capacity / connected capacity / ratio
- Total piping length
- Validation status with expandable messages

---

### 1.6 Duct Drawing System (2-3 days)

**Goal:** Draw duct runs from ducted indoor units with integrated calculator.

**New files:**
- `packages/drawing-engine/src/types/duct.ts`
- `packages/drawing-engine/src/store/slices/ductSlice.ts`
- `packages/drawing-engine/src/tools/DuctDrawingTool.ts`
- `packages/drawing-engine/src/components/canvas/hvac/DuctPlanRenderer.ts`
- `packages/drawing-engine/src/components/DuctCalculatorPanel.tsx`

**Modify:**
- `packages/drawing-engine/src/store/index.ts` — integrate duct slice
- `packages/drawing-engine/src/components/Toolbar.tsx` — duct tools

**Types:**
```typescript
interface DuctRun {
  id: string;
  systemType: 'supply' | 'return' | 'exhaust' | 'fresh_air';
  sourceComponentId: string; // IDU or AHU
  segments: DuctSegment[];
  fittings: DuctFitting[];
  terminals: DuctTerminal[];
  totalAirflow: number; // L/s
  totalPressureDrop: number; // Pa
  floorId?: string;
}

interface DuctSegment {
  id: string;
  runId: string;
  shape: 'rectangular' | 'round' | 'flat_oval';
  width: number; // mm
  height: number; // mm
  diameter?: number; // mm (for round)
  length: number; // m
  material: 'galvanized_steel' | 'aluminum' | 'stainless_steel';
  gauge: number;
  insulation: { type: string; thickness: number } | null;
  airflow: number; // L/s
  velocity: number; // m/s
  pressureDrop: number; // Pa/m
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  elevation: number; // mm from floor
}

interface DuctFitting {
  id: string;
  runId: string;
  type: 'elbow' | 'tee' | 'reducer' | 'offset' | 'transition' | 'end_cap' | 'wye';
  position: { x: number; y: number };
  rotation: number;
  properties: Record<string, any>; // type-specific properties
  pressureDrop: number; // Pa
}

interface DuctTerminal {
  id: string;
  runId: string;
  type: 'diffuser' | 'grille' | 'register';
  subType: string; // e.g., 'square_4way', 'linear_slot', 'return_grille'
  model?: string;
  position: { x: number; y: number };
  roomId?: string;
  airflow: number; // L/s
  neckSize: number; // mm
  throwDistance?: number; // m
  noiseLevel?: number; // NC
  hasVCD: boolean;
  vcdPosition?: number; // 0-100%
}
```

**Duct Calculator Panel:**
- Input: total airflow (L/s), max velocity (m/s), friction rate (Pa/m)
- Output: recommended duct size, actual velocity, actual friction
- Method: equal friction or velocity reduction
- Shows size options with velocity/pressure comparison
- Auto-apply to selected segment

---

### 1.7 Diffuser/Grille/VCD Placement & Dynamic Airflow (2 days)

**Goal:** Place air terminals with automatic airflow cascading through duct network.

**New files:**
- `packages/drawing-engine/src/tools/TerminalPlacementTool.ts`
- `packages/drawing-engine/src/utils/airflowCalculator.ts`

**Modify:**
- `packages/drawing-engine/src/store/slices/ductSlice.ts` — airflow recalculation
- `packages/drawing-engine/src/components/canvas/hvac/DuctPlanRenderer.ts` — terminal rendering

**Airflow calculation logic:**
```
When terminal added/removed/modified:
1. For each duct run:
   a. Sum airflow at each terminal
   b. Walk upstream from terminals to source
   c. At each segment: airflow = sum of downstream terminal airflows
   d. Resize segment: use duct calculator to get new size at target velocity
   e. Update velocity and pressure drop
   f. If segment size changed, update fittings (reducers at size changes)
2. Update total run pressure drop
3. Check against IDU ESP capacity
4. Flag warnings if pressure exceeds ESP
```

**Terminal placement:**
- Snap to ceiling grid pattern (e.g., 600x600mm tile grid)
- Auto-detect room and associate
- Default airflow from room cooling load / number of terminals
- VCD auto-added on branch duct to terminal

---

### 1.8 Auto-Support Generation (1-2 days)

**Goal:** Automatically add duct/pipe supports with all hardware.

**New files:**
- `packages/drawing-engine/src/utils/supportAutoGenerator.ts`

**Modify:**
- `packages/drawing-engine/src/store/slices/ductSlice.ts` & `vrfSlice.ts` — trigger support generation

**Support rules:**
```
Duct Supports:
- Trapeze hanger every 2400mm (max) for rectangular ducts
- Components per support: 2x threaded rod (M10 for <600mm, M12 for >600mm),
  2x drop-in anchor, 2x hex nut, 2x flat washer, 1x C-channel or L-angle
- Rod length = ceiling height - duct elevation - duct height
- Channel size based on duct width

Pipe Supports:
- Pipe clamp every 1500mm for refrigerant pipes
- Components per support: 1x pipe clamp (sized to pipe OD + insulation),
  1x threaded rod (M8/M10), 1x drop-in anchor, 1x hex nut, 1x flat washer
- Vibration isolator at equipment connections

Drain Pipe Supports:
- Pipe clamp every 1200mm
- Gradient: 1:100 minimum fall
```

**Output:** Array of support assemblies with position, components list, and quantities for BOQ.

---

### 1.9 VRF Catalog Import (2 days)

**Goal:** Upload VRF catalog and auto-place equipment.

**New files:**
- `packages/drawing-engine/src/utils/vrfCatalogParser.ts`
- `packages/drawing-engine/src/components/VRFCatalogImportDialog.tsx`

**Import flow:**
1. Upload Excel/CSV file
2. Parse columns: Model, Type (ducted/cassette/wall), Capacity, Quantity, Floor
3. Fuzzy match models against `VRF_COMPONENTS` definitions
4. Show preview table with matched/unmatched items
5. User confirms matches, assigns unmatched manually
6. Auto-create VRF system with ODU
7. Distribute IDUs across rooms based on room cooling loads (from heat load or room area)
8. Call `autoGeneratePiping` to connect everything
9. User can manually adjust placements after import

---

### 1.10 Pre-Design Checklist & Validation (1-2 days)

**Goal:** Validate complete VRF design before BOQ generation.

**New files:**
- `packages/drawing-engine/src/utils/vrfDesignChecker.ts`
- `packages/drawing-engine/src/components/DesignChecklistDialog.tsx`

**Checklist items:**
```
CRITICAL (blocks BOQ):
□ Every conditioned room has at least one indoor unit
□ Every VRF system has an outdoor unit
□ All refrigerant lines are connected (no orphan ports)
□ Piping within VRF manufacturer limits
□ Capacity ratio within acceptable range (50-130%)

WARNING (allows BOQ with acknowledgment):
□ Every ducted unit has at least one diffuser
□ Supply diffuser airflow meets room requirement
□ Return air path provided for every conditioned room
□ VCDs installed on all branch ducts
□ Access doors on duct runs > 3m
□ Flexible connectors at equipment connections
□ Drain piping connected to all IDUs
□ Supports generated for all duct and pipe runs

INFO:
□ Fire dampers at fire-rated wall penetrations
□ Smoke dampers at smoke compartment boundaries
□ Insulation specified for all exposed ductwork
□ Vibration isolators at equipment connections
```

**UI:** Dialog with categorized checklist, pass/fail/warning badges, click to navigate to issue on drawing.

---

## MILESTONE 2: Heat Load Calculator (Week 5)

### 2.1 Heat Load Calculation Engine (3 days)

**Goal:** Full cooling/heating load calculation per room using CLTD/CLF method.

**New files:**
- `packages/shared/src/types/heatLoad.ts` — `HeatLoadInput`, `HeatLoadResult`, `LoadBreakdown`, `WallLoadContribution`
- `packages/shared/src/utils/heatLoadCalculator.ts`

**Reuse:** `DEFAULT_HVAC_DESIGN_CONDITIONS`, `DEFAULT_ROOM_HVAC_TEMPLATES` from `packages/drawing-engine/src/attributes/hvac.ts`; `Room3D` already has `calculatedCoolingLoadW`, `calculatedHeatingLoadW`, `loadBreakdown`

**Calculation method (CLTD/CLF):**
```
Total Cooling Load = Σ(External Loads) + Σ(Internal Loads) + Ventilation Load

External Loads:
- Wall transmission: Q = U × A × CLTD_corrected
- Roof transmission: Q = U × A × CLTD_corrected
- Window conduction: Q = U × A × CLTD
- Window solar: Q = A × SHGC × SC × CLF
- Floor: Q = U × A × ΔT (for exposed floors only)

Internal Loads:
- People (sensible): Q = N × SHG × CLF
- People (latent): Q = N × LHG
- Lighting: Q = W × CLF × BF
- Equipment: Q = W × CLF
- Infiltration (sensible): Q = 1.23 × CFM × ΔT
- Infiltration (latent): Q = 3010 × CFM × ΔW

Ventilation Load:
- Sensible: Q = 1.23 × OA_CFM × (T_outside - T_room)
- Latent: Q = 3010 × OA_CFM × (W_outside - W_room)

Safety factor: +10% typical
```

### 2.2 Heat Load Calculator UI (2-3 days)

**New files:**
- `apps/web/src/app/(dashboard)/projects/[id]/heat-load/page.tsx`
- `packages/drawing-engine/src/components/HeatLoadPanel.tsx`
- `packages/drawing-engine/src/components/HeatLoadResultsTable.tsx`

**Layout:** Split view — left: input form, right: 2D/3D model

**Bidirectional integration:**
- Drawing -> Calculator: room areas, wall U-values, window counts auto-populate
- Calculator -> Drawing: update `Room3D` properties, cooling/heating load values

### 2.3 Wall Thermal Properties Panel (1 day)

**Modify:**
- `packages/drawing-engine/src/components/PropertiesPanel.tsx` — thermal subsection when wall selected: U-value, R-value, area, thickness, material layers, exposure direction, heat contribution

---

## MILESTONE 3: Smart BOQ (Weeks 6-7)

### 3.1 Drawing-to-BOQ Generator (3 days)

**New files:**
- `packages/shared/src/utils/boqGenerator.ts` — Walks entire drawing store, generates categorized BOQ with `sourceComponentId` traceability

**Modify:**
- `packages/api/src/routers/boq.ts` — `generateFromDrawing` mutation
- `packages/boq-engine/src/types/index.ts` — extend with `sourceComponentId`, `markupPercent`, `markupType`, `floorId`, `systemId`

**BOQ generation traversal:**
```
For each VRF System:
  → Outdoor Unit (1x) + base frame, power cable, isolator switch
  → Each Indoor Unit + drain pump (if needed), condensate pipe, control wire
  → Each Branch Kit
  → Each Refrigerant Line → pipe length by size, insulation by size
  → Each Support Point → threaded rod, anchor, nut, washer, clamp (quantities computed)

For each Duct Run:
  → Each Segment → duct area (m²) × material rate, or linear meter
  → Each Fitting → by type and size
  → Each Terminal → diffuser/grille with neck adapter
  → Each VCD/Fire Damper/Access Door
  → Each Support → trapeze channel, rod, anchors, nuts, washers
  → Insulation → external wrap area (m²)
  → Flexible Connectors at equipment

Miscellaneous:
  → Cable tray / wire ties / test ports
  → Refrigerant charge (additional kg beyond factory charge)
  → Commissioning & testing items
```

### 3.2 Enhanced BOQ Editor (2-3 days)

**Modify:**
- `packages/boq-engine/src/components/BOQTable.tsx` — Excel-compatible grid

**New files:**
- `packages/boq-engine/src/components/AdvanceCostingSheet.tsx` — Per-item cost breakdown
- `packages/boq-engine/src/components/BOQMarkupControls.tsx` — Markup per row/category

**Features:**
- Copy/paste TSV format (Excel-compatible via Clipboard API)
- Tab/Enter cell navigation
- Category-level and grand total subtotals
- Row-level markup: equipment %, material %, labour %, other %
- Multi-system grouping (by VRF system name)
- Multi-floor grouping
- Reusable template items (save & load item groups)
- Advance costing tabs per item: material, fabrication, installation, testing, overhead

### 3.3 Supplier Price Inquiry & Logging (2 days)

**New Prisma models:** `Supplier`, `SupplierInquiry`, `SupplierPriceResponse`

**New files:**
- `packages/api/src/routers/supplier.ts` — CRUD, inquiry generation, price logging, price application
- `packages/boq-engine/src/components/SupplierInquiryDialog.tsx`
- `packages/boq-engine/src/components/SupplierPriceLog.tsx`

**Inquiry format (real-world standard):**
```
PRICE INQUIRY
From: [Company Name]
To: [Supplier Name]
Date: [Date]
Project: [Project Name]
Required by: [Date]

| # | Description | Model/Spec | Unit | Qty | Unit Price | Total |
|---|------------|------------|------|-----|-----------|-------|
| 1 | VRF ODU 20HP | RXYQ20TAY1 | Nos | 1 | | |
| 2 | Ducted IDU 2.2kW | FXDQ20A | Nos | 4 | | |
| ... | ... | ... | ... | ... | | |
| 45 | Hex Nut M10 GI | - | Nos | 120 | | |
| 46 | Flat Washer M10 GI | - | Nos | 240 | | |

Terms: [Delivery, Payment, Validity]
```

### 3.4 BOQ-Drawing Traceability (1 day)

**Modify:**
- `packages/boq-engine/src/components/BOQTable.tsx` — "Locate" icon per row
- `packages/drawing-engine/src/components/DrawingCanvas.tsx` — `highlightComponentById()`, "Show in BOQ" context menu

---

## MILESTONE 4: Smart Covering Letter (Weeks 7-8)

### 4.1 Covering Letter Data Integration (2 days)

**New files:**
- `packages/document-editor/src/utils/dataPopulator.ts` — Merge project + BOQ + heat load data

**Modify:**
- `packages/document-editor/src/types/index.ts` — extend `QuotationFormData`
- `packages/document-editor/src/store/editorStore.ts` — `populateFromProject` action

### 4.2 Enhanced Page Layout Canvas (2-3 days)

**New files:**
- `packages/document-editor/src/components/canvas/AlignmentGuides.tsx` — Canva-like snap guides
- `packages/document-editor/src/components/canvas/DottedGrid.tsx` — Zoom-responsive grid
- `packages/document-editor/src/components/editor/EquipmentTable.tsx` — Auto-populated AC unit table

**Modify:**
- `packages/document-editor/src/components/CoveringLetterEditor.tsx` — rulers, header/footer, logo

---

## MILESTONE 5: Compliance & Proposal (Week 8)

### 5.1 Compliance Sheet Builder (2 days)

**New files:**
- `apps/web/src/app/(dashboard)/projects/[id]/compliance/page.tsx`
- `packages/api/src/routers/compliance.ts`
- `packages/shared/src/constants/complianceTemplates.ts`

### 5.2 Proposal Assembly & PDF (2-3 days)

**Modify:**
- `packages/pdf-generator/src/templates/ProposalTemplate.tsx` — all sections
- `packages/api/src/routers/proposal.ts` — `generatePdf` mutation

**New files:**
- `packages/pdf-generator/src/templates/DrawingPageTemplate.tsx`
- `packages/pdf-generator/src/templates/SystemSummaryTemplate.tsx`

---

## MILESTONE 6: PDF/CAD Import with AI (Week 9)

### 6.1 Enhanced Drawing Import (3 days)

**Modify:**
- `packages/ocr-engine/src/drawing-recognizer.ts`

**New files:**
- `packages/ocr-engine/src/wall-detector.ts`
- `packages/ocr-engine/src/symbol-classifier.ts`
- `packages/drawing-engine/src/components/ImportReviewDialog.tsx`

### 6.2 Detected Elements to Drawing (2 days)

**New files:**
- `packages/drawing-engine/src/utils/importConverter.ts`

**Modify:**
- `packages/drawing-engine/src/store/index.ts` — `importDetectedElements` action

---

## Database Schema Additions

Add to `packages/database/prisma/schema.prisma`:

```prisma
model VRFSystem {
  id            String   @id @default(cuid())
  projectId     String
  project       Project  @relation(fields: [projectId], references: [id])
  drawingId     String?
  drawing       Drawing? @relation(fields: [drawingId], references: [id])
  name          String
  manufacturer  String
  refrigerant   String
  maxCapacity   Float
  status        String   @default("draft")
  topology      Json?    // VRFSystemTopology
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

model Supplier {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  name           String
  contactName    String?
  contactEmail   String?
  contactPhone   String?
  categories     String[] // ["vrf_equipment", "ductwork", "accessories"]
  notes          String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  inquiries      SupplierInquiry[]
}

model SupplierInquiry {
  id          String   @id @default(cuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])
  supplierId  String
  supplier    Supplier @relation(fields: [supplierId], references: [id])
  status      String   @default("draft") // draft, sent, received, applied
  sentAt      DateTime?
  categories  String[]
  itemCount   Int
  items       Json     // BOQ items snapshot
  responses   SupplierPriceResponse[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model SupplierPriceResponse {
  id              String   @id @default(cuid())
  inquiryId       String
  inquiry         SupplierInquiry @relation(fields: [inquiryId], references: [id])
  itemDescription String
  modelNumber     String?
  unitPrice       Float
  currency        String
  validUntil      DateTime?
  appliedAt       DateTime?
  appliedBy       String?
  notes           String?
  createdAt       DateTime @default(now())
}

model HeatLoadCalculation {
  id          String   @id @default(cuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])
  drawingId   String?
  drawing     Drawing? @relation(fields: [drawingId], references: [id])
  inputs      Json     // HeatLoadInput per room
  results     Json     // HeatLoadResult per room
  totalCoolingLoad Float
  totalHeatingLoad Float
  calculatedAt DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model Floor {
  id          String   @id @default(cuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id])
  drawingId   String?
  drawing     Drawing? @relation(fields: [drawingId], references: [id])
  floorNumber Int
  name        String   // "Ground Floor", "1st Floor", etc.
  elevation   Float    // meters from ground level
  floorHeight Float    @default(3.0) // floor-to-floor height
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

Extend existing models:
```prisma
// Add to BOQItem:
sourceComponentId String?
markupPercent     Float?
markupType        String? // "equipment" | "material" | "labour" | "other"
floorId           String?
systemId          String?

// Add to DrawingComponent:
vrfSystemId       String?
```

---

## Dependency Graph & Critical Path

```
1.1 (VRF Store) -> 1.2 (Renderers) -> 1.3 (Placement) -> 1.4 (Auto-Routing)
                                                    |
                                              1.5 (Properties)
                                                    |
1.6 (Ducts) -> 1.7 (Diffusers) -> 1.8 (Supports) -> 1.10 (Checklist)
                                                           |
2.1 (Heat Load Engine) -> 2.2 (Heat Load UI)              |
                                                           v
                                              3.1 (BOQ Generator) -> 3.2 (BOQ Editor) -> 3.3 (Supplier)
                                                           |
                                              4.1 (Letter Data) -> 4.2 (Page Layout)
                                                           |
                                              5.1 (Compliance) -> 5.2 (Proposal PDF)

6.1 & 6.2 (AI Import) — independent, can run anytime
```

**Critical path:** 1.1 -> 1.2 -> 1.3 -> 1.4 -> 1.6 -> 1.7 -> 1.10 -> 3.1 -> 5.2

**Parallel tracks:**
- Track A: Milestones 1 (VRF drawing) -> 3 (BOQ) -> 5 (Proposal)
- Track B: Milestone 2 (Heat Load) — starts after 1.1
- Track C: Milestone 6 (AI Import) — independent
- Track D: Milestone 4 (Covering Letter) — starts after 3.1

---

## Key Existing Files to Reuse

| File | What to reuse |
|------|---------------|
| `packages/shared/src/constants/hvacComponents.ts` | VRF_COMPONENTS, AIR_TERMINALS, SUPPORT_SYSTEMS |
| `packages/shared/src/utils/calculations.ts` | `validateVRFSystem()`, duct sizing, `ductWeightPerMeter()` |
| `packages/drawing-engine/src/attributes/hvac.ts` | Design conditions, room HVAC templates |
| `packages/drawing-engine/src/store/slices/wallSlice.ts` | Zustand slice pattern |
| `packages/drawing-engine/src/components/canvas/hvac/HvacPlanRenderer.ts` | Fabric.js renderer pattern |
| `packages/drawing-engine/src/store/index.ts` | Store integration pattern |
| `packages/ocr-engine/src/drawing-recognizer.ts` | Import foundation |

---

## Verification Plan

1. **VRF Drawing:** Place ODU + 4 IDUs in different rooms -> auto-routing generates piping + branch kits -> move IDU -> re-routes
2. **Duct System:** Draw duct from ducted IDU -> place 3 diffusers -> remove 1 -> duct resizes, airflow adjusts
3. **Heat Load:** Select rooms -> calculator auto-populates -> change values -> results update
4. **BOQ:** Click "Generate BOQ" -> every component appears (nuts/bolts/washers) -> edit markup -> totals update
5. **Covering Letter:** Open editor -> project data auto-fills -> move text boxes -> alignment guides work
6. **Proposal:** Assemble all sections -> generate PDF -> all sections included
7. **Import:** Upload PDF floor plan -> wall/door/window detection -> accept -> editable objects appear
