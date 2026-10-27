import { describe, it, expect } from "vitest";

import { unitHasDrainPump } from "../components/canvas/hvac/unitDrainPump";

import {
  DEFAULT_AC_EQUIPMENT_LIBRARY,
  groupAcEquipmentByCategory,
} from "./ac-equipment-library";
import { unitSpecificationFor } from "./unitSpecifications";

const REMOVED_PLACEHOLDER_IDS = [
  "ac-ceiling-cassette-4way",
  "ac-wall-mounted-standard",
  "ac-ceiling-suspended-standard",
  "ac-ducted-standard",
  "ac-outdoor-vrf-single",
  "ac-return-filter-standard",
  "ac-remote-wall-standard",
  "ac-control-panel-standard",
  "ac-accessory-generic",
];

describe("AC equipment library — real MACO VRF models, and units drawn to a maker's dimension drawing", () => {
  it("contains exactly the 7 GLB units, 2 units drawn to MHI drawings, 2 retained branch kits, 3 condensate terminations, 5 supply and 7 return air terminals", () => {
    const ids = DEFAULT_AC_EQUIPMENT_LIBRARY.map((d) => d.id).sort();
    expect(ids).toEqual([
      "ac-branch-kit-dis-22-1g",
      "ac-branch-kit-dis-22-1g-liquid",
      "condensate-external-discharge",
      "condensate-floor-gully",
      "condensate-stack-connection",
      "terminal-linear-2slot-1200-150",
      "terminal-return-eggcrate-595-250",
      "terminal-return-eggcrate-595-300",
      "terminal-return-filter-595-250",
      "terminal-return-linear-2slot-1200-200",
      "terminal-return-louvred-595-250",
      "terminal-return-perforated-595-250",
      "terminal-return-square-595-250",
      "terminal-round-200",
      "terminal-square-595-200",
      "terminal-square-595-250",
      "terminal-square-595-300",
      "vrf-fdc140kxzes1-w",
      "vrf-fdc280kxze1",
      "vrf-fdc280kxzpe1",
      "vrf-fdt28kxze1",
      "vrf-fdu224kxze1",
      "vrf-fdu280kxze1",
      "vrf-fdum140kxe6f",
      "vrf-fdum160kxe6f",
      "vrf-fdum22kxe6f-w",
    ]);
  });

  it("every placeable unit is GLB-backed or drawn to a cited maker drawing (no legacy placeholder units remain)", () => {
    const units = DEFAULT_AC_EQUIPMENT_LIBRARY.filter(
      (d) =>
        d.equipmentCategory === "indoor-unit" ||
        d.equipmentCategory === "outdoor-unit",
    );
    expect(units).toHaveLength(9);
    for (const u of units) {
      if (u.subtype === "mhi-drawing-procedural") {
        expect(u.defaultProperties?.modelUrl).toBeUndefined();
        expect(u.defaultProperties?.drawingReference).toMatch(/PJG000Z287/);
        continue;
      }
      expect(u.defaultProperties?.modelUrl).toMatch(
        /^\/models\/vrf\/maco-vrf-.*\.glb$/,
      );
    }
  });

  it("every ducted unit has a specification, its airflow per fan speed and fan pressure in the duct-design fields", () => {
    const ducted = DEFAULT_AC_EQUIPMENT_LIBRARY.filter((d) => d.type === "ducted-ac");
    expect(ducted.map((d) => d.defaultProperties?.modelCode)).toEqual(["FDUM22KXE6F-W", "FDUM140KXE6F", "FDUM160KXE6F", "FDU224KXZE1", "FDU280KXZE1"]);
    for (const d of ducted) {
      const spec = unitSpecificationFor({ properties: d.defaultProperties ?? {} })!;
      expect(spec).not.toBeNull();
      const airflow = d.defaultProperties?.airflowM3min as Record<string, number>;
      expect(airflow).toEqual(spec.airflowM3min);
      expect(d.defaultProperties?.maxEspPa).toBe(spec.esp!.maxPa);
      expect(d.defaultProperties?.capacityKw).toBe(spec.coolingKw);
      expect(spec.sources.length).toBeGreaterThan(0);
    }
    const fdu = unitSpecificationFor({ properties: { modelCode: "FDU280KXZE1" } })!;
    expect(fdu).toMatchObject({ coolingKw: 28, heatingKw: 31.5, gasMm: 22.22, liquidMm: 9.52, weightKg: 89, body: "drawn-to-dimensions" });
    expect(fdu.esp).toMatchObject({ maxPa: 200, ratedPa: 72, factoryRangePa: [80, 150] });
    expect(fdu.casingMm).toEqual({ height: 379, width: 1600, depth: 893 });
    // The FDUM160 shares the FDUM140's cabinet and 3D model; its own airflow.
    const fdum140 = DEFAULT_AC_EQUIPMENT_LIBRARY.find((d) => d.id === "vrf-fdum140kxe6f")!;
    const fdum160 = DEFAULT_AC_EQUIPMENT_LIBRARY.find((d) => d.id === "vrf-fdum160kxe6f")!;
    expect(fdum160.defaultProperties?.modelUrl).toBe(fdum140.defaultProperties?.modelUrl);
    expect((fdum160.defaultProperties?.airflowM3min as Record<string, number>).hi).toBe(35);
    // No stored pump flag: every ducted unit is pumped (the FDU too, although its drawing shows a gravity drain).
    const fdu280 = DEFAULT_AC_EQUIPMENT_LIBRARY.find((d) => d.id === "vrf-fdu280kxze1")!;
    expect(fdum140.defaultProperties?.hasDrainPump).toBeUndefined();
    expect(unitHasDrainPump({ type: fdum140.type, properties: fdum140.defaultProperties ?? {} })).toBe(true);
    expect(unitHasDrainPump({ type: fdu280.type, properties: fdu280.defaultProperties ?? {} })).toBe(true);
    expect(fdu.drain.pump).toBe(false);
  });

  it("drops every old placeholder id", () => {
    const ids = new Set(DEFAULT_AC_EQUIPMENT_LIBRARY.map((d) => d.id));
    for (const gone of REMOVED_PLACEHOLDER_IDS) {
      expect(ids.has(gone)).toBe(false);
    }
  });

  it("air terminals: supply diffusers and return terminals in their own sections, each with its terminal spec", () => {
    const g = groupAcEquipmentByCategory(DEFAULT_AC_EQUIPMENT_LIBRARY);
    expect(g["air-terminals"].map((d) => d.type)).toEqual(Array(5).fill("diffuser"));
    expect(g["return-air-terminals"].map((d) => d.type)).toEqual(Array(7).fill("return-grille"));
    expect(g["return-air-terminals"].map((d) => d.subtype)).toEqual(["return-egg-crate", "return-egg-crate", "louvred", "perforated", "square-4way", "linear-slot", "return-egg-crate"]);
    for (const d of [...g["air-terminals"], ...g["return-air-terminals"]]) {
      const spec = d.defaultProperties?.terminal as { faceWidthMm: number; faceHeightMm: number; plenumHeightMm: number; service: string };
      expect(d.widthMm).toBe(spec.faceWidthMm);
      expect(d.heightMm).toBe(spec.faceHeightMm + spec.plenumHeightMm);
      expect(d.mountType).toBe("ceiling");
      expect(spec.service).toBe(d.type === "return-grille" ? "return" : "supply");
    }
    const filterGrille = g["return-air-terminals"].find((d) => d.id === "terminal-return-filter-595-250")!;
    expect((filterGrille.defaultProperties?.terminal as { filter?: string }).filter).toBe("G4");
    expect(filterGrille.modelLabel).toBe("Egg-crate return grille with G4 filter Ø250");
    expect(g["return-air-terminals"].find((d) => d.subtype === "square-4way")!.modelLabel).toBe("Square return diffuser Ø250");
  });

  it("palette groups: 6 indoor, 3 outdoor, 2 accessories, 0 controls, 3 drainage", () => {
    const g = groupAcEquipmentByCategory(DEFAULT_AC_EQUIPMENT_LIBRARY);
    expect(g["indoor-units"].map((d) => d.id).sort()).toEqual([
      "vrf-fdt28kxze1",
      "vrf-fdu224kxze1",
      "vrf-fdu280kxze1",
      "vrf-fdum140kxe6f",
      "vrf-fdum160kxe6f",
      "vrf-fdum22kxe6f-w",
    ]);
    expect(g["outdoor-units"]).toHaveLength(3);
    expect(g["accessories"]).toHaveLength(2);
    expect(g["controls"]).toHaveLength(0);
    expect(g["drainage"].map((d) => d.type)).toEqual([
      "condensate-gully",
      "condensate-gully",
      "condensate-gully",
    ]);
  });
});
