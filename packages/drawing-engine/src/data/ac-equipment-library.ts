/**
 * AC equipment library definitions for room-aware placement.
 *
 * The placeable UNITS are the real MEPcontent MACO VRF models, converted from
 * the manufacturer IFC4 files to GLB (millimetres, Z-up) via IfcOpenShell.
 * widthMm/depthMm/heightMm are the TRUE axis-aligned extents measured off each
 * GLB, so the 2D-plan footprint and the 3D model occupy the identical envelope;
 * `defaultProperties.modelUrl` is loaded by the 3D layer (GLTFLoader) and served
 * from apps/web/public. The two DIS-22-1G branch kits are retained because the
 * refrigerant pipe tool references them (branchKitProposal / refrigerantBranchKitModel).
 */

import type {
  HvacElementCategory,
  HvacElementType,
  HvacMountType,
} from "../types";

export type AcEquipmentLibraryCategory =
  | "indoor-units"
  | "outdoor-units"
  | "controls"
  | "accessories";

export type AcEquipmentPlacementMode = "room" | "wall" | "outdoor";

export interface AcEquipmentDefinition {
  id: string;
  name: string;
  category: AcEquipmentLibraryCategory;
  equipmentCategory: HvacElementCategory;
  type: HvacElementType;
  subtype: string;
  modelLabel: string;
  placementMode: AcEquipmentPlacementMode;
  mountType: HvacMountType;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  elevationMm: number;
  defaultRotationDeg?: number;
  supplyZoneRatio?: number;
  description: string;
  tags: string[];
  defaultProperties?: Record<string, unknown>;
}

const DEFAULT_CEILING_ELEVATION_MM = 2400;
const DEFAULT_REFRIGERANT_ACCESSORY_ELEVATION_MM = 2600;

function equipment(definition: AcEquipmentDefinition): AcEquipmentDefinition {
  return definition;
}

export const AC_EQUIPMENT_CATEGORY_LABELS: Record<
  AcEquipmentLibraryCategory,
  string
> = {
  "indoor-units": "Indoor Units",
  "outdoor-units": "Outdoor Units",
  controls: "Controls",
  accessories: "Accessories",
};

export const DEFAULT_AC_EQUIPMENT_LIBRARY: AcEquipmentDefinition[] = [
  // --- Indoor units (real GLB) ---
  equipment({
    id: "vrf-fdt28kxze1",
    name: "MHI 4-Way Cassette — FDT28KXZE1 (3D)",
    category: "indoor-units",
    equipmentCategory: "indoor-unit",
    type: "ceiling-cassette-ac",
    subtype: "maco-vrf-glb",
    modelLabel: "MHI FDT28KXZE1",
    placementMode: "room",
    mountType: "ceiling",
    widthMm: 1043,
    depthMm: 950,
    heightMm: 272,
    elevationMm: DEFAULT_CEILING_ELEVATION_MM,
    supplyZoneRatio: 0.5,
    description:
      "Mitsubishi Heavy Industries FDT28KXZE1 4-way ceiling cassette (950×950 panel; footprint spans the pipe/drain connections) — real 3D geometry from the MEPcontent MACO VRF IFC.",
    tags: ["cassette", "ceiling", "indoor", "vrf", "mhi", "maco", "glb", "fdt28kxze1"],
    defaultProperties: {
      source: "ifc-glb",
      modelUrl: "/models/vrf/maco-vrf-fdt28kxze1.glb",
      modelCode: "FDT28KXZE1",
      manufacturer: "Mitsubishi Heavy Industries",
      model: "FDT28KXZE1",
      capacityKw: 2.8,
      mountingType: "ceiling-cassette",
    },
  }),
  equipment({
    id: "vrf-fdum22kxe6f-w",
    name: "MHI Ducted Indoor — FDUM22KXE6F-W (3D)",
    category: "indoor-units",
    equipmentCategory: "indoor-unit",
    type: "ducted-ac",
    subtype: "maco-vrf-glb",
    modelLabel: "MHI FDUM22KXE6F-W",
    placementMode: "room",
    mountType: "ceiling",
    widthMm: 1084,
    depthMm: 697,
    heightMm: 300,
    elevationMm: DEFAULT_CEILING_ELEVATION_MM,
    supplyZoneRatio: 0.5,
    description:
      "Mitsubishi Heavy Industries FDUM22KXE6F-W concealed ducted indoor unit — real 3D geometry from the MEPcontent MACO VRF IFC.",
    tags: ["ducted", "ceiling", "indoor", "vrf", "mhi", "maco", "glb", "fdum22kxe6f-w"],
    defaultProperties: {
      source: "ifc-glb",
      modelUrl: "/models/vrf/maco-vrf-fdum22kxe6f-w.glb",
      modelCode: "FDUM22KXE6F-W",
      manufacturer: "Mitsubishi Heavy Industries",
      model: "FDUM22KXE6F-W",
      capacityKw: 2.2,
      mountingType: "ducted",
    },
  }),

  // --- Outdoor condensing units (real GLB) ---
  equipment({
    id: "vrf-fdc280kxze1",
    name: "MHI Outdoor VRF — FDC280KXZE1 (3D)",
    category: "outdoor-units",
    equipmentCategory: "outdoor-unit",
    type: "outdoor-unit",
    subtype: "maco-vrf-glb",
    modelLabel: "MHI FDC280KXZE1",
    placementMode: "outdoor",
    mountType: "floor",
    widthMm: 1350,
    depthMm: 764,
    heightMm: 1690,
    elevationMm: 0,
    supplyZoneRatio: 0.5,
    description:
      "Mitsubishi Heavy Industries FDC280KXZE1 outdoor condensing unit — real 3D geometry from the MEPcontent MACO VRF IFC.",
    tags: ["outdoor", "condensing", "vrf", "mhi", "maco", "glb", "fdc280kxze1"],
    defaultProperties: {
      source: "ifc-glb",
      modelUrl: "/models/vrf/maco-vrf-fdc280kxze1.glb",
      modelCode: "FDC280KXZE1",
      manufacturer: "Mitsubishi Heavy Industries",
      model: "FDC280KXZE1",
      capacityKw: 28,
      mountingType: "outdoor",
    },
  }),
  equipment({
    id: "vrf-fdc280kxzpe1",
    name: "MHI Outdoor VRF — FDC280KXZPE1 (3D)",
    category: "outdoor-units",
    equipmentCategory: "outdoor-unit",
    type: "outdoor-unit",
    subtype: "maco-vrf-glb",
    modelLabel: "MHI FDC280KXZPE1",
    placementMode: "outdoor",
    mountType: "floor",
    widthMm: 970,
    depthMm: 450,
    heightMm: 1505,
    elevationMm: 0,
    supplyZoneRatio: 0.5,
    description:
      "Mitsubishi Heavy Industries FDC280KXZPE1 slim outdoor unit — real 3D geometry from the MEPcontent MACO VRF IFC.",
    tags: ["outdoor", "condensing", "vrf", "mhi", "maco", "glb", "fdc280kxzpe1"],
    defaultProperties: {
      source: "ifc-glb",
      modelUrl: "/models/vrf/maco-vrf-fdc280kxzpe1.glb",
      modelCode: "FDC280KXZPE1",
      manufacturer: "Mitsubishi Heavy Industries",
      model: "FDC280KXZPE1",
      capacityKw: 28,
      mountingType: "outdoor",
    },
  }),
  equipment({
    id: "vrf-fdc140kxzes1-w",
    name: "MHI Outdoor VRF — FDC140KXZES1-W (3D)",
    category: "outdoor-units",
    equipmentCategory: "outdoor-unit",
    type: "outdoor-unit",
    subtype: "maco-vrf-glb",
    modelLabel: "MHI FDC140KXZES1-W",
    placementMode: "outdoor",
    mountType: "floor",
    widthMm: 970,
    depthMm: 450,
    heightMm: 845,
    elevationMm: 0,
    supplyZoneRatio: 0.5,
    description:
      "Mitsubishi Heavy Industries FDC140KXZES1-W single-fan outdoor unit — real 3D geometry from the MEPcontent MACO VRF IFC.",
    tags: ["outdoor", "condensing", "vrf", "mhi", "maco", "glb", "fdc140kxzes1-w"],
    defaultProperties: {
      source: "ifc-glb",
      modelUrl: "/models/vrf/maco-vrf-fdc140kxzes1-w.glb",
      modelCode: "FDC140KXZES1-W",
      manufacturer: "Mitsubishi Heavy Industries",
      model: "FDC140KXZES1-W",
      capacityKw: 14,
      mountingType: "outdoor",
    },
  }),

  // --- Refrigerant branch kits (retained: used by the pipe tool) ---
  equipment({
    id: "ac-branch-kit-dis-22-1g",
    name: "Copper Branch Kit (Gas)",
    category: "accessories",
    equipmentCategory: "accessory",
    type: "refrigerant-branch-kit",
    subtype: "dis-22-1g-gas",
    modelLabel: "DIS-22-1G Gas",
    placementMode: "room",
    mountType: "ceiling",
    widthMm: 442,
    depthMm: 180,
    heightMm: 90,
    elevationMm: DEFAULT_REFRIGERANT_ACCESSORY_ELEVATION_MM,
    supplyZoneRatio: 0.5,
    description:
      "Gas-side VRF branching kit based on DIS-22-1G dimensional data.",
    tags: ["branch-kit", "gas", "refnet", "refrigerant", "vrf"],
    defaultProperties: {
      branchKitType: "dis-22-1g",
      branchKitLineKind: "gas",
      branchKitWallAllowanceMm: 0.9,
      gasInletDiameterMm: 15.88,
      gasRunOutletDiameterMm: 15.88,
      gasBranchOutletDiameterMm: 15.88,
      liquidInletDiameterMm: 9.52,
      liquidRunOutletDiameterMm: 9.52,
      liquidBranchOutletDiameterMm: 9.52,
    },
  }),
  equipment({
    id: "ac-branch-kit-dis-22-1g-liquid",
    name: "Copper Branch Kit (Liquid)",
    category: "accessories",
    equipmentCategory: "accessory",
    type: "refrigerant-branch-kit",
    subtype: "dis-22-1g-liquid",
    modelLabel: "DIS-22-1G Liquid",
    placementMode: "room",
    mountType: "ceiling",
    widthMm: 370,
    depthMm: 180,
    heightMm: 90,
    elevationMm: DEFAULT_REFRIGERANT_ACCESSORY_ELEVATION_MM,
    supplyZoneRatio: 0.5,
    description:
      "Liquid-side VRF branching kit based on DIS-22-1G dimensional data.",
    tags: ["branch-kit", "liquid", "refnet", "refrigerant", "vrf"],
    defaultProperties: {
      branchKitType: "dis-22-1g",
      branchKitLineKind: "liquid",
      branchKitWallAllowanceMm: 0.9,
      gasInletDiameterMm: 15.88,
      gasRunOutletDiameterMm: 15.88,
      gasBranchOutletDiameterMm: 15.88,
      liquidInletDiameterMm: 9.52,
      liquidRunOutletDiameterMm: 9.52,
      liquidBranchOutletDiameterMm: 9.52,
    },
  }),
];

export function groupAcEquipmentByCategory(
  definitions: AcEquipmentDefinition[],
): Record<AcEquipmentLibraryCategory, AcEquipmentDefinition[]> {
  return definitions.reduce<
    Record<AcEquipmentLibraryCategory, AcEquipmentDefinition[]>
  >(
    (acc, definition) => {
      acc[definition.category].push(definition);
      return acc;
    },
    {
      "indoor-units": [],
      "outdoor-units": [],
      controls: [],
      accessories: [],
    },
  );
}
