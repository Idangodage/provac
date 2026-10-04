import { describe, it, expect } from "vitest";

import {
  DEFAULT_AC_EQUIPMENT_LIBRARY,
  groupAcEquipmentByCategory,
} from "./ac-equipment-library";

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

describe("AC equipment library — real MACO VRF models only", () => {
  it("contains exactly the 5 GLB units + 2 retained branch kits + 3 condensate terminations + 4 supply and 6 return air terminals", () => {
    const ids = DEFAULT_AC_EQUIPMENT_LIBRARY.map((d) => d.id).sort();
    expect(ids).toEqual([
      "ac-branch-kit-dis-22-1g",
      "ac-branch-kit-dis-22-1g-liquid",
      "condensate-external-discharge",
      "condensate-floor-gully",
      "condensate-stack-connection",
      "terminal-linear-2slot-1200-150",
      "terminal-return-eggcrate-595-250",
      "terminal-return-filter-595-250",
      "terminal-return-linear-2slot-1200-200",
      "terminal-return-louvred-595-250",
      "terminal-return-perforated-595-250",
      "terminal-return-square-595-250",
      "terminal-round-200",
      "terminal-square-595-200",
      "terminal-square-595-250",
      "vrf-fdc140kxzes1-w",
      "vrf-fdc280kxze1",
      "vrf-fdc280kxzpe1",
      "vrf-fdt28kxze1",
      "vrf-fdum22kxe6f-w",
    ]);
  });

  it("every placeable unit is GLB-backed (no legacy placeholder units remain)", () => {
    const units = DEFAULT_AC_EQUIPMENT_LIBRARY.filter(
      (d) =>
        d.equipmentCategory === "indoor-unit" ||
        d.equipmentCategory === "outdoor-unit",
    );
    expect(units).toHaveLength(5);
    for (const u of units) {
      expect(u.defaultProperties?.modelUrl).toMatch(
        /^\/models\/vrf\/maco-vrf-.*\.glb$/,
      );
    }
  });

  it("drops every old placeholder id", () => {
    const ids = new Set(DEFAULT_AC_EQUIPMENT_LIBRARY.map((d) => d.id));
    for (const gone of REMOVED_PLACEHOLDER_IDS) {
      expect(ids.has(gone)).toBe(false);
    }
  });

  it("air terminals: supply diffusers and return terminals in their own sections, each with its terminal spec", () => {
    const g = groupAcEquipmentByCategory(DEFAULT_AC_EQUIPMENT_LIBRARY);
    expect(g["air-terminals"].map((d) => d.type)).toEqual(["diffuser", "diffuser", "diffuser", "diffuser"]);
    expect(g["return-air-terminals"].map((d) => d.type)).toEqual(Array(6).fill("return-grille"));
    expect(g["return-air-terminals"].map((d) => d.subtype)).toEqual(["return-egg-crate", "louvred", "perforated", "square-4way", "linear-slot", "return-egg-crate"]);
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

  it("palette groups: 2 indoor, 3 outdoor, 2 accessories, 0 controls, 3 drainage", () => {
    const g = groupAcEquipmentByCategory(DEFAULT_AC_EQUIPMENT_LIBRARY);
    expect(g["indoor-units"].map((d) => d.id).sort()).toEqual([
      "vrf-fdt28kxze1",
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
