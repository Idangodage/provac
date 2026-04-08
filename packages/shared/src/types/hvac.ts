/**
 * HVAC Component Types and Interfaces
 * Based on SMACNA HVAC Duct Construction Standards
 */

// ═══════════════════════════════════════════════════════════════════════════
// BASE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ComponentType =
  | "DUCT"
  | "FITTING"
  | "TERMINAL"
  | "EQUIPMENT"
  | "DAMPER"
  | "ACCESSORY";

export type ConnectionType =
  | "DUCT_TO_DUCT"
  | "DUCT_TO_FITTING"
  | "FITTING_TO_FITTING"
  | "DUCT_TO_TERMINAL"
  | "DUCT_TO_EQUIPMENT"
  | "REFRIGERANT";

export interface Position {
  x: number;
  y: number;
  z: number;
  rotation: number;
}

export interface Dimensions {
  width: number;
  height: number;
  length: number;
}

export interface ComponentProperty<T = unknown> {
  type: "number" | "select" | "boolean" | "text" | "object" | "array";
  value?: T;
  unit?: string;
  min?: number;
  max?: number;
  options?: T[];
  condition?: string;
  calculated?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// DUCTWORK
// ═══════════════════════════════════════════════════════════════════════════

export type DuctShape = "rectangular" | "round" | "oval";
export type DuctMaterial = "galvanized" | "aluminum" | "stainless_steel" | "black_iron";
export type DuctJointType = "transverse" | "tdc" | "tdf" | "slip_drive" | "pocket_lock" | "flanged";
export type DuctSeamType = "pittsburgh" | "grooved" | "button_punch" | "welded";

export interface DuctProperties {
  shape: DuctShape;
  width?: number;
  height?: number;
  diameter?: number;
  length: number;
  material: DuctMaterial;
  gauge: number;
  jointType: DuctJointType;
  seamType?: DuctSeamType;
  elevation: number;
}

export interface FlexDuctProperties {
  diameter: number;
  length: number;
  type: "insulated" | "uninsulated" | "acoustic";
  insulation?: "R4" | "R6" | "R8";
}

// ═══════════════════════════════════════════════════════════════════════════
// FITTINGS
// ═══════════════════════════════════════════════════════════════════════════

export type ElbowType = "square" | "radius" | "mitered" | "mitered_no_vane";
export type ReducerType = "concentric" | "eccentric_top" | "eccentric_bottom" | "eccentric_side";

export interface ElbowProperties {
  width: number;
  height: number;
  angle: 15 | 30 | 45 | 60 | 75 | 90;
  elbowType: ElbowType;
  radiusRatio?: 0.5 | 0.75 | 1.0 | 1.5;
  turningVanes: boolean;
  material: DuctMaterial;
  gauge: number;
}

export interface ReducerProperties {
  inletWidth: number;
  inletHeight: number;
  outletWidth: number;
  outletHeight: number;
  length: number;
  reducerType: ReducerType;
  material: DuctMaterial;
}

export interface TeeProperties {
  mainWidth: number;
  mainHeight: number;
  branchWidth: number;
  branchHeight: number;
  teeType: "straight" | "conical" | "45_entry";
  material: DuctMaterial;
}

// ═══════════════════════════════════════════════════════════════════════════
// AIR TERMINALS
// ═══════════════════════════════════════════════════════════════════════════

export type DiffuserPattern = "4-way" | "3-way" | "2-way" | "1-way" | "radial" | "directional";
export type GrilleType = "egg_crate" | "louver" | "perforated" | "linear_bar";

export interface DiffuserProperties {
  type: "square" | "round" | "linear" | "perforated" | "swirl" | "jet";
  faceSize?: string;
  diameter?: number;
  length?: number;
  neckSize: number;
  pattern: DiffuserPattern;
  airflow?: number;
  throwDistance?: number;
  noiseLevel?: number;
}

export interface GrilleProperties {
  width: number;
  height: number;
  type: GrilleType;
  freeArea?: number;
  withFilter: boolean;
  filterType?: "G3" | "G4" | "M5" | "M6";
  backdraftDamper?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// VRF COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

export type RefrigerantPipeType = "liquid" | "gas" | "suction";
export type VRFManufacturer = "Daikin" | "Mitsubishi" | "LG" | "Samsung" | "Toshiba";

export interface BranchKitProperties {
  type: "y_branch" | "header";
  mainPipe: string;
  branchPipe: string;
  maxCapacity?: number;
  manufacturer: VRFManufacturer;
  modelNumber?: string;
  portCount?: number;
}

export interface RefrigerantPipeProperties {
  diameter: string;
  pipeType: RefrigerantPipeType;
  length: number;
  insulation: "9mm" | "13mm" | "19mm" | "25mm";
}

export interface VRFOutdoorProperties {
  model: string;
  capacity: number;
  manufacturer: VRFManufacturer;
  refrigerant: "R410A" | "R32";
}

export interface VRFIndoorProperties {
  model: string;
  type: "ducted" | "cassette" | "wall" | "floor";
  capacity: number;
  esp?: number;
  airflow?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// INSULATION
// ═══════════════════════════════════════════════════════════════════════════

export type InsulationType = "glasswool" | "rockwool" | "elastomeric" | "polyiso" | "polyethylene";
export type InsulationFacing = "foil" | "kraft" | "white_vinyl" | "none";

export interface DuctInsulationProperties {
  location: "external" | "internal";
  type: InsulationType;
  thickness: 25 | 38 | 50 | 75 | 100;
  facing?: InsulationFacing;
  fireRating?: "Class_0" | "Class_1" | "Class_2";
  kValue?: number;
}

export interface PipeInsulationProperties {
  type: InsulationType;
  thickness: 9 | 13 | 19 | 25 | 32 | 38 | 50;
  vaporBarrier: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPPORTS
// ═══════════════════════════════════════════════════════════════════════════

export type SupportMaterial = "galvanized" | "stainless_304" | "stainless_316" | "painted";

export interface ThreadedRodProperties {
  material: SupportMaterial;
  size: "M8" | "M10" | "M12" | "M16" | "M20";
  length: number;
  loadCapacity?: number;
}

export interface TrapezeProperties {
  type: "c_channel" | "l_angle";
  size: string;
  length: number;
  material: SupportMaterial;
  slotted?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCESSORIES
// ═══════════════════════════════════════════════════════════════════════════

export type DamperType = "single_blade" | "opposed_blade" | "parallel_blade";
export type FireRating = "1hr" | "1.5hr" | "2hr" | "3hr";

export interface VolumeDamperProperties {
  width: number;
  height: number;
  type: DamperType;
  actuator: "manual" | "motorized";
  leakageClass?: "1" | "2" | "3";
}

export interface FireDamperProperties {
  width: number;
  height: number;
  fireRating: FireRating;
  type: "curtain" | "multi_blade";
  fusibleLink: "72C" | "100C" | "165C";
  withActuator: boolean;
}

export interface AccessDoorProperties {
  width: number;
  height: number;
  type: "hinged" | "removable" | "cam_lock";
  insulated: boolean;
  insulationThickness?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED COMPONENT INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface HVACComponent {
  id: string;
  type: string;
  name?: string;
  position: Position;
  properties: Record<string, unknown>;
  isLocked: boolean;
  isVisible: boolean;
  layerId?: string;
  groupId?: string;

  // View-specific rendering
  planSymbol?: string;
  sectionSymbol?: string;
  detailSymbol?: string;
}

export interface ComponentConnection {
  id: string;
  fromComponentId: string;
  toComponentId: string;
  connectionType: string;
  properties?: Record<string, unknown>;
}
