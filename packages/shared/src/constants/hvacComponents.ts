/**
 * HVAC Component Library
 * Based on SMACNA HVAC Duct Construction Standards
 */

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function generateRectSizes(
  min: number,
  max: number,
  step: number
): string[] {
  const sizes: string[] = [];
  for (let w = min; w <= max; w += step) {
    for (let h = min; h <= w; h += step) {
      sizes.push(`${w}x${h}`);
    }
  }
  return sizes;
}

function generateRoundSizes(min: number, max: number, step: number): number[] {
  const sizes: number[] = [];
  for (let d = min; d <= max; d += step) {
    sizes.push(d);
  }
  return sizes;
}

// ═══════════════════════════════════════════════════════════════════════════
// DUCTWORK
// ═══════════════════════════════════════════════════════════════════════════

export const DUCT_SECTIONS = {
  RECTANGULAR: {
    id: "rect-duct",
    name: "Rectangular Duct",
    category: "ductwork",
    shapes: ["rectangular"] as const,
    sizes: generateRectSizes(100, 2000, 50),
    materials: ["galvanized", "aluminum", "stainless_steel", "black_iron"] as const,
    gauges: {
      galvanized: [26, 24, 22, 20, 18, 16],
      stainless: [26, 24, 22, 20],
    },
    joints: ["transverse", "tdc", "tdf", "slip_drive", "pocket_lock", "flanged"] as const,
    seams: ["pittsburgh", "grooved", "button_punch", "welded"] as const,
    properties: {
      width: { type: "number", unit: "mm", min: 100, max: 2000 },
      height: { type: "number", unit: "mm", min: 100, max: 2000 },
      length: { type: "number", unit: "mm", min: 100, max: 6000 },
      gauge: { type: "select", options: "by_size" },
      material: { type: "select" },
      jointType: { type: "select" },
      seamType: { type: "select" },
    },
  },

  ROUND: {
    id: "round-duct",
    name: "Round Duct",
    category: "ductwork",
    shapes: ["round"] as const,
    sizes: generateRoundSizes(100, 1600, 25),
    materials: ["galvanized", "aluminum", "spiral_galvanized", "spiral_aluminum"] as const,
    types: ["snap_lock", "spiral", "longitudinal_seam"] as const,
    joints: ["slip_joint", "bead_joint", "flanged", "vanstone"] as const,
    properties: {
      diameter: { type: "number", unit: "mm", min: 100, max: 1600 },
      length: { type: "number", unit: "mm", min: 100, max: 6000 },
      type: { type: "select" },
      gauge: { type: "select" },
      jointType: { type: "select" },
    },
  },

  FLAT_OVAL: {
    id: "flat-oval-duct",
    name: "Flat Oval Duct",
    category: "ductwork",
    shapes: ["oval"] as const,
    properties: {
      majorAxis: { type: "number", unit: "mm" },
      minorAxis: { type: "number", unit: "mm" },
      length: { type: "number", unit: "mm" },
    },
  },

  FLEXIBLE: {
    id: "flex-duct",
    name: "Flexible Duct",
    category: "ductwork",
    shapes: ["round"] as const,
    types: ["insulated", "uninsulated", "acoustic"] as const,
    sizes: [100, 125, 150, 175, 200, 250, 300, 350, 400],
    maxLength: 2000,
    properties: {
      diameter: { type: "select" },
      length: { type: "number", unit: "mm", max: 2000 },
      type: { type: "select" },
      insulation: { type: "select", options: ["R4", "R6", "R8"] },
    },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// DUCT FITTINGS
// ═══════════════════════════════════════════════════════════════════════════

export const DUCT_FITTINGS = {
  ELBOW_RECTANGULAR: {
    id: "elbow-rect",
    name: "Rectangular Elbow",
    category: "fitting",
    subcategory: "elbow",
    types: [
      { id: "square", name: "Square Throat (no vanes)", lossCoef: "high" },
      { id: "radius", name: "Radius Throat", radiusRatios: [0.5, 0.75, 1.0, 1.5] },
      { id: "mitered", name: "Mitered (with vanes)", vaneCount: "auto" },
      { id: "mitered_no_vane", name: "Mitered (no vanes)", lossCoef: "very_high" },
    ],
    angles: [15, 30, 45, 60, 75, 90] as const,
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      angle: { type: "select", options: [15, 30, 45, 60, 75, 90] },
      elbowType: { type: "select" },
      radiusRatio: { type: "select", condition: "type === radius" },
      turningVanes: { type: "boolean", default: true },
    },
  },

  ELBOW_ROUND: {
    id: "elbow-round",
    name: "Round Elbow",
    category: "fitting",
    subcategory: "elbow",
    types: [
      { id: "smooth", name: "Smooth Radius", segments: 1 },
      { id: "3_piece", name: "3-Piece", segments: 3 },
      { id: "5_piece", name: "5-Piece", segments: 5 },
      { id: "gored", name: "Gored", segments: "multiple" },
    ],
    angles: [15, 30, 45, 60, 75, 90] as const,
    properties: {
      diameter: { type: "number", unit: "mm" },
      angle: { type: "select" },
      elbowType: { type: "select" },
      centerlineRadius: { type: "number", unit: "mm" },
    },
  },

  REDUCER_RECTANGULAR: {
    id: "reducer-rect",
    name: "Rectangular Reducer",
    category: "fitting",
    subcategory: "reducer",
    types: [
      { id: "concentric", name: "Concentric (Symmetrical)" },
      { id: "eccentric_top", name: "Eccentric (Top Flat)" },
      { id: "eccentric_bottom", name: "Eccentric (Bottom Flat)" },
      { id: "eccentric_side", name: "Eccentric (Side Flat)" },
    ],
    properties: {
      inletWidth: { type: "number", unit: "mm" },
      inletHeight: { type: "number", unit: "mm" },
      outletWidth: { type: "number", unit: "mm" },
      outletHeight: { type: "number", unit: "mm" },
      length: { type: "number", unit: "mm" },
      reducerType: { type: "select" },
    },
  },

  REDUCER_ROUND: {
    id: "reducer-round",
    name: "Round Reducer",
    category: "fitting",
    subcategory: "reducer",
    types: [
      { id: "concentric", name: "Concentric" },
      { id: "eccentric", name: "Eccentric" },
    ],
    properties: {
      inletDiameter: { type: "number", unit: "mm" },
      outletDiameter: { type: "number", unit: "mm" },
      length: { type: "number", unit: "mm" },
      reducerType: { type: "select" },
    },
  },

  TRANSITION_RECT_TO_ROUND: {
    id: "transition-rect-round",
    name: "Rectangular to Round",
    category: "fitting",
    subcategory: "transition",
    properties: {
      rectWidth: { type: "number", unit: "mm" },
      rectHeight: { type: "number", unit: "mm" },
      roundDiameter: { type: "number", unit: "mm" },
      length: { type: "number", unit: "mm" },
      alignment: { type: "select", options: ["center", "offset_x", "offset_y"] },
    },
  },

  TEE_RECTANGULAR: {
    id: "tee-rect",
    name: "Rectangular Tee",
    category: "fitting",
    subcategory: "branch",
    types: [
      { id: "straight", name: "Straight Branch" },
      { id: "conical", name: "Conical Branch" },
      { id: "45_entry", name: "45° Entry" },
    ],
    properties: {
      mainWidth: { type: "number", unit: "mm" },
      mainHeight: { type: "number", unit: "mm" },
      branchWidth: { type: "number", unit: "mm" },
      branchHeight: { type: "number", unit: "mm" },
      teeType: { type: "select" },
    },
  },

  WYE_RECTANGULAR: {
    id: "wye-rect",
    name: "Rectangular Wye",
    category: "fitting",
    subcategory: "branch",
    properties: {
      mainWidth: { type: "number", unit: "mm" },
      mainHeight: { type: "number", unit: "mm" },
      branch1Size: { type: "object" },
      branch2Size: { type: "object" },
      branchAngle: { type: "number", unit: "degrees", default: 45 },
    },
  },

  OFFSET_RECTANGULAR: {
    id: "offset-rect",
    name: "Rectangular Offset",
    category: "fitting",
    subcategory: "offset",
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      offsetDistance: { type: "number", unit: "mm" },
      offsetDirection: { type: "select", options: ["horizontal", "vertical"] },
      length: { type: "number", unit: "mm" },
    },
  },

  END_CAP_RECTANGULAR: {
    id: "endcap-rect",
    name: "Rectangular End Cap",
    category: "fitting",
    subcategory: "terminal",
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
    },
  },

  END_CAP_ROUND: {
    id: "endcap-round",
    name: "Round End Cap",
    category: "fitting",
    subcategory: "terminal",
    properties: {
      diameter: { type: "number", unit: "mm" },
    },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// AIR TERMINALS
// ═══════════════════════════════════════════════════════════════════════════

export const AIR_TERMINALS = {
  DIFFUSER_SQUARE: {
    id: "diffuser-square",
    name: "Square Ceiling Diffuser",
    category: "terminal",
    subcategory: "supply",
    patterns: ["4-way", "3-way", "2-way", "1-way"] as const,
    sizes: ["225x225", "300x300", "375x375", "450x450", "525x525", "600x600"],
    neckSizes: [150, 200, 250, 300, 350, 400],
    properties: {
      faceSize: { type: "select" },
      neckSize: { type: "select" },
      pattern: { type: "select" },
      airflow: { type: "number", unit: "L/s" },
      throwDistance: { type: "number", unit: "m", calculated: true },
      noiseLevel: { type: "number", unit: "NC", calculated: true },
    },
  },

  DIFFUSER_ROUND: {
    id: "diffuser-round",
    name: "Round Ceiling Diffuser",
    category: "terminal",
    subcategory: "supply",
    patterns: ["radial", "directional"] as const,
    sizes: [200, 250, 300, 350, 400, 450, 500],
    properties: {
      diameter: { type: "select" },
      neckSize: { type: "select" },
      pattern: { type: "select" },
      airflow: { type: "number", unit: "L/s" },
    },
  },

  DIFFUSER_LINEAR_SLOT: {
    id: "diffuser-linear",
    name: "Linear Slot Diffuser",
    category: "terminal",
    subcategory: "supply",
    slots: [1, 2, 3, 4],
    lengths: [600, 900, 1200, 1500, 1800, 2400, 3000],
    properties: {
      length: { type: "select" },
      slotCount: { type: "select" },
      slotWidth: { type: "number", unit: "mm", default: 25 },
      plenum: { type: "select", options: ["with_plenum", "without_plenum"] },
    },
  },

  GRILLE_RETURN: {
    id: "grille-return",
    name: "Return Air Grille",
    category: "terminal",
    subcategory: "return",
    types: ["egg_crate", "louver", "perforated", "linear_bar"] as const,
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      type: { type: "select" },
      freeArea: { type: "number", unit: "%", calculated: true },
      withFilter: { type: "boolean" },
      filterType: { type: "select", options: ["G3", "G4", "M5", "M6"] },
    },
  },

  GRILLE_EXHAUST: {
    id: "grille-exhaust",
    name: "Exhaust Grille",
    category: "terminal",
    subcategory: "exhaust",
    types: ["louver", "mushroom", "weather_proof"] as const,
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      type: { type: "select" },
      backdraftDamper: { type: "boolean" },
    },
  },

  REGISTER: {
    id: "register",
    name: "Supply Register (with damper)",
    category: "terminal",
    subcategory: "supply",
    types: ["single_deflection", "double_deflection", "opposed_blade"] as const,
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      type: { type: "select" },
      damperType: { type: "select", options: ["integral", "separate"] },
    },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// VRF COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

export const VRF_COMPONENTS = {
  BRANCH_KIT_Y: {
    id: "branch-kit-y",
    name: "Y-Branch Kit",
    category: "vrf",
    subcategory: "branch",
    types: [
      { id: "KHRP26A22T", name: "Daikin Y-Branch", capacityRange: "5-16HP" },
      { id: "KHRP26A33T", name: "Daikin Y-Branch", capacityRange: "16-28HP" },
    ],
    properties: {
      mainPipe: { type: "select", options: ["9.52", "12.7", "15.88", "19.05", "22.22", "25.4", "28.58"] },
      branchPipe: { type: "select" },
      maxCapacity: { type: "number", unit: "HP" },
      manufacturer: { type: "select", options: ["Daikin", "Mitsubishi", "LG", "Samsung"] },
    },
  },

  BRANCH_KIT_HEADER: {
    id: "branch-kit-header",
    name: "Header Branch Kit",
    category: "vrf",
    subcategory: "branch",
    ports: [2, 3, 4, 5, 6, 8],
    properties: {
      portCount: { type: "select" },
      mainPipe: { type: "select" },
      branchPipes: { type: "array" },
    },
  },

  REFRIGERANT_PIPE: {
    id: "ref-pipe",
    name: "Refrigerant Pipe",
    category: "vrf",
    subcategory: "pipe",
    types: ["liquid", "gas", "suction"] as const,
    sizes: ["6.35", "9.52", "12.7", "15.88", "19.05", "22.22", "25.4", "28.58", "31.75", "38.1"],
    properties: {
      diameter: { type: "select", unit: "mm" },
      pipeType: { type: "select", options: ["liquid", "gas"] },
      length: { type: "number", unit: "m" },
      insulation: { type: "select", options: ["9mm", "13mm", "19mm", "25mm"] },
    },
  },

  VRF_OUTDOOR: {
    id: "vrf-outdoor",
    name: "VRF Outdoor Unit",
    category: "vrf",
    subcategory: "equipment",
    properties: {
      model: { type: "text" },
      capacity: { type: "number", unit: "kW" },
      manufacturer: { type: "select" },
      refrigerant: { type: "select", options: ["R410A", "R32"] },
    },
  },

  VRF_INDOOR_DUCTED: {
    id: "vrf-indoor-ducted",
    name: "VRF Ducted Indoor Unit",
    category: "vrf",
    subcategory: "equipment",
    properties: {
      model: { type: "text" },
      capacity: { type: "number", unit: "kW" },
      esp: { type: "number", unit: "Pa" },
      airflow: { type: "number", unit: "L/s" },
    },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// INSULATION
// ═══════════════════════════════════════════════════════════════════════════

export const INSULATION = {
  DUCT_EXTERNAL: {
    id: "insulation-duct-ext",
    name: "External Duct Insulation",
    category: "insulation",
    types: [
      { id: "glasswool", name: "Glass Wool", kValue: 0.032 },
      { id: "rockwool", name: "Rock Wool", kValue: 0.035 },
      { id: "elastomeric", name: "Elastomeric Foam", kValue: 0.037 },
      { id: "polyiso", name: "Polyisocyanurate", kValue: 0.023 },
    ],
    thicknesses: [25, 38, 50, 75, 100],
    facings: ["foil", "kraft", "white_vinyl", "none"] as const,
    properties: {
      type: { type: "select" },
      thickness: { type: "select", unit: "mm" },
      facing: { type: "select" },
      fireRating: { type: "select", options: ["Class_0", "Class_1", "Class_2"] },
    },
  },

  DUCT_INTERNAL: {
    id: "insulation-duct-int",
    name: "Internal Duct Lining",
    category: "insulation",
    types: [
      { id: "glasswool_faced", name: "Faced Glass Wool", nrc: 0.75 },
      { id: "acoustic", name: "Acoustic Liner", nrc: 0.85 },
    ],
    thicknesses: [25, 50],
    properties: {
      type: { type: "select" },
      thickness: { type: "select", unit: "mm" },
      erosionResistant: { type: "boolean" },
    },
  },

  PIPE_INSULATION: {
    id: "insulation-pipe",
    name: "Pipe Insulation",
    category: "insulation",
    types: [
      { id: "elastomeric", name: "Elastomeric Foam (Armaflex)", kValue: 0.037 },
      { id: "glasswool_pipe", name: "Glass Wool Pipe Section", kValue: 0.032 },
      { id: "polyethylene", name: "Polyethylene Foam", kValue: 0.038 },
    ],
    thicknesses: [9, 13, 19, 25, 32, 38, 50],
    properties: {
      type: { type: "select" },
      thickness: { type: "select", unit: "mm" },
      temperatureRange: { type: "text", calculated: true },
      vaporBarrier: { type: "boolean" },
    },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// SUPPORTS
// ═══════════════════════════════════════════════════════════════════════════

export const SUPPORT_SYSTEMS = {
  THREADED_ROD: {
    id: "support-rod",
    name: "Threaded Rod / All-Thread",
    category: "support",
    subcategory: "hanger",
    materials: ["galvanized", "stainless_304", "stainless_316"] as const,
    sizes: ["M8", "M10", "M12", "M16", "M20"] as const,
    properties: {
      material: { type: "select" },
      size: { type: "select" },
      length: { type: "number", unit: "mm" },
      loadCapacity: { type: "number", unit: "kg", calculated: true },
    },
  },

  TRAPEZE_C_CHANNEL: {
    id: "support-c-channel",
    name: "C-Channel Trapeze",
    category: "support",
    subcategory: "trapeze",
    sizes: ["41x21", "41x41", "41x62", "41x82"],
    properties: {
      size: { type: "select" },
      length: { type: "number", unit: "mm" },
      material: { type: "select", options: ["galvanized", "stainless"] },
      slotted: { type: "boolean" },
    },
  },

  TRAPEZE_L_ANGLE: {
    id: "support-l-angle",
    name: "L-Angle Trapeze",
    category: "support",
    subcategory: "trapeze",
    sizes: ["30x30x3", "40x40x3", "40x40x4", "50x50x4", "50x50x5", "65x65x5", "75x75x6"],
    properties: {
      size: { type: "select" },
      length: { type: "number", unit: "mm" },
      material: { type: "select", options: ["galvanized", "painted", "stainless"] },
    },
  },

  HANGER_STRAP: {
    id: "hanger-strap",
    name: "Metal Hanger Strap",
    category: "support",
    subcategory: "hanger",
    widths: [20, 25, 32, 40, 50],
    gauges: [20, 18, 16],
    properties: {
      width: { type: "select", unit: "mm" },
      gauge: { type: "select" },
      length: { type: "number", unit: "mm" },
    },
  },

  PIPE_CLAMP: {
    id: "pipe-clamp",
    name: "Pipe Clamp",
    category: "support",
    subcategory: "pipe_support",
    types: ["split_ring", "u_bolt", "cushion_clamp"] as const,
    properties: {
      pipeDiameter: { type: "select", unit: "mm" },
      type: { type: "select" },
      withInsulation: { type: "boolean" },
      insulationThickness: { type: "select", condition: "withInsulation" },
    },
  },

  ANCHOR_EXPANSION: {
    id: "anchor-expansion",
    name: "Expansion Anchor",
    category: "support",
    subcategory: "anchor",
    types: ["wedge", "sleeve", "drop_in"] as const,
    sizes: ["M8", "M10", "M12", "M16"] as const,
    properties: {
      type: { type: "select" },
      size: { type: "select" },
      embedmentDepth: { type: "number", unit: "mm" },
      pulloutLoad: { type: "number", unit: "kN", calculated: true },
    },
  },

  VIBRATION_ISOLATOR: {
    id: "vibration-isolator",
    name: "Vibration Isolator",
    category: "support",
    subcategory: "isolation",
    types: ["spring", "rubber", "neoprene", "spring_rubber"] as const,
    properties: {
      type: { type: "select" },
      loadCapacity: { type: "number", unit: "kg" },
      deflection: { type: "number", unit: "mm" },
      naturalFrequency: { type: "number", unit: "Hz", calculated: true },
    },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// ACCESSORIES
// ═══════════════════════════════════════════════════════════════════════════

export const ACCESSORIES = {
  VOLUME_DAMPER: {
    id: "damper-volume",
    name: "Volume Control Damper (VCD)",
    category: "accessory",
    subcategory: "damper",
    types: ["single_blade", "opposed_blade", "parallel_blade"] as const,
    actuators: ["manual", "motorized"] as const,
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      type: { type: "select" },
      actuator: { type: "select" },
      leakageClass: { type: "select", options: ["1", "2", "3"] },
    },
  },

  FIRE_DAMPER: {
    id: "damper-fire",
    name: "Fire Damper",
    category: "accessory",
    subcategory: "damper",
    ratings: ["1hr", "1.5hr", "2hr", "3hr"] as const,
    types: ["curtain", "multi_blade"] as const,
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      fireRating: { type: "select" },
      type: { type: "select" },
      fusibleLink: { type: "select", options: ["72C", "100C", "165C"] },
      withActuator: { type: "boolean" },
    },
  },

  SMOKE_DAMPER: {
    id: "damper-smoke",
    name: "Smoke Damper",
    category: "accessory",
    subcategory: "damper",
    leakageClasses: ["I", "II", "III"] as const,
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      leakageClass: { type: "select" },
      actuator: { type: "select", options: ["electric", "pneumatic"] },
    },
  },

  ACCESS_DOOR: {
    id: "access-door",
    name: "Duct Access Door",
    category: "accessory",
    subcategory: "access",
    types: ["hinged", "removable", "cam_lock"] as const,
    sizes: ["200x200", "300x300", "400x400", "600x400"],
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      type: { type: "select" },
      insulated: { type: "boolean" },
      insulationThickness: { type: "select", condition: "insulated" },
    },
  },

  FLEX_CONNECTOR: {
    id: "flex-connector",
    name: "Flexible Connector",
    category: "accessory",
    subcategory: "connector",
    materials: ["neoprene", "vinyl", "canvas"] as const,
    properties: {
      width: { type: "number", unit: "mm" },
      height: { type: "number", unit: "mm" },
      length: { type: "number", unit: "mm", default: 150 },
      material: { type: "select" },
      fireRated: { type: "boolean" },
    },
  },

  TEST_HOLE: {
    id: "test-hole",
    name: "Test/Balance Port",
    category: "accessory",
    subcategory: "testing",
    types: ["velocity", "static_pressure", "combination"] as const,
    properties: {
      diameter: { type: "select", options: [25, 32, 40] },
      type: { type: "select" },
      withCap: { type: "boolean", default: true },
    },
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETE COMPONENT LIBRARY
// ═══════════════════════════════════════════════════════════════════════════

export const HVAC_COMPONENT_LIBRARY = {
  ductwork: DUCT_SECTIONS,
  fittings: DUCT_FITTINGS,
  terminals: AIR_TERMINALS,
  vrf: VRF_COMPONENTS,
  insulation: INSULATION,
  supports: SUPPORT_SYSTEMS,
  accessories: ACCESSORIES,
} as const;

export type HVACComponentLibrary = typeof HVAC_COMPONENT_LIBRARY;
