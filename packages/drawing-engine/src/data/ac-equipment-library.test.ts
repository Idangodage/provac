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
  it("contains exactly the 5 GLB units + 2 retained branch kits", () => {
    const ids = DEFAULT_AC_EQUIPMENT_LIBRARY.map((d) => d.id).sort();
    expect(ids).toEqual([
      "ac-branch-kit-dis-22-1g",
      "ac-branch-kit-dis-22-1g-liquid",
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

  it("palette groups: 2 indoor, 3 outdoor, 2 accessories, 0 controls", () => {
    const g = groupAcEquipmentByCategory(DEFAULT_AC_EQUIPMENT_LIBRARY);
    expect(g["indoor-units"].map((d) => d.id).sort()).toEqual([
      "vrf-fdt28kxze1",
      "vrf-fdum22kxe6f-w",
    ]);
    expect(g["outdoor-units"]).toHaveLength(3);
    expect(g["accessories"]).toHaveLength(2);
    expect(g["controls"]).toHaveLength(0);
  });
});
