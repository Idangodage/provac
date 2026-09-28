import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';

/** The catalog FDUM22 as placed (ac-equipment-library: 1084 × 697 × 300, modelCode). */
function fdum22(overrides: Partial<HvacElement> = {}): HvacElement {
  return {
    id: 'fdum', type: 'ducted-ac', position: { x: 1000, y: 2000 }, rotation: 0, width: 1084, depth: 697, height: 300,
    elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
    properties: { source: 'ifc-glb', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb', modelCode: 'FDUM22KXE6F-W' },
    ...overrides,
  };
}

const centre = { x: 1000 + 1084 / 2, y: 2000 + 697 / 2 };

describe('FDUM22KXE6F-W air ports (measured)', () => {
  const ports = resolveUnitAirPorts(fdum22());
  const supply = ports.find((port) => port.kind === 'supply')!;
  const ret = ports.find((port) => port.kind === 'return')!;

  it('supply is the −Y collar, 674 × 164 mm', () => {
    expect(supply.source).toBe('measured');
    expect(supply.provenance.verified).toBe(true);
    expect(supply.widthMm).toBe(674);
    expect(supply.heightMm).toBe(164);
    expect(supply.normal).toEqual({ x: 0, y: -1 });
    expect(supply.lip.x).toBeCloseTo(centre.x - 117, 6);
    expect(supply.lip.y).toBeCloseTo(centre.y - 348.5, 6);
    expect(supply.lip.z).toBeCloseTo(2600 + 152, 6);
  });

  it('return is the +Y collar, 654 × 194 mm', () => {
    expect(ret.widthMm).toBe(654);
    expect(ret.heightMm).toBe(194);
    expect(ret.normal).toEqual({ x: 0, y: 1 });
    expect(ret.lip.x).toBeCloseTo(centre.x - 117, 6);
    expect(ret.lip.y).toBeCloseTo(centre.y + 348.5, 6);
    expect(ret.lip.z).toBeCloseTo(2600 + 139, 6);
  });

  it('turns with the unit', () => {
    const rotated = resolveUnitAirPorts(fdum22({ rotation: 90 })).find((port) => port.kind === 'supply')!;
    expect(rotated.normal.x).toBeCloseTo(1, 9);
    expect(rotated.normal.y).toBeCloseTo(0, 9);
    expect(rotated.lip.x).toBeCloseTo(centre.x + 348.5, 6);
    expect(rotated.lip.y).toBeCloseTo(centre.y - 117, 6);
  });

  it('falls back to flagged placeholder openings for units without measured collars', () => {
    const generic = resolveUnitAirPorts(fdum22({ properties: {} }));
    expect(generic).toHaveLength(2);
    expect(generic.every((port) => port.source === 'procedural' && !port.provenance.verified)).toBe(true);
  });
});

/**
 * Minimal GLB reader: merged vertex positions of every mesh (the FDUM22 file is
 * one node with an identity transform under a root).
 */
function readGlbPositions(bytes: Uint8Array): Float32Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
    meshes: Array<{ primitives: Array<{ attributes: { POSITION: number } }> }>;
    accessors: Array<{ bufferView: number; byteOffset?: number; count: number }>;
    bufferViews: Array<{ byteOffset?: number }>;
  };
  const binStart = 20 + jsonLength + 8;
  return json.meshes.flatMap((mesh) => mesh.primitives.map((primitive) => {
    const accessor = json.accessors[primitive.attributes.POSITION]!;
    const offset = binStart + (json.bufferViews[accessor.bufferView]!.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + accessor.count * 12));
  }));
}

describe('measured ports agree with the real GLB collars', () => {
  it('each port lip matches the outermost collar face of the model within 2 mm', async () => {
    const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(path: URL): Uint8Array };
    const bytes = fs.readFileSync(new URL('../../../../../../../apps/web/public/models/vrf/maco-vrf-fdum22kxe6f-w.glb', import.meta.url));
    const vertices: Array<[number, number, number]> = [];
    for (const positions of readGlbPositions(bytes)) {
      for (let index = 0; index < positions.length; index += 3) vertices.push([positions[index]!, positions[index + 1]!, positions[index + 2]!]);
    }
    const xs = vertices.map((v) => v[0]);
    const ys = vertices.map((v) => v[1]);
    const zs = vertices.map((v) => v[2]);
    // glbModelCache: bounding-box centre to the origin, bottom face to z = 0.
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const bottom = Math.min(...zs);
    const local = vertices.map(([x, y, z]) => [x - cx, y - cy, z - bottom] as const);
    const lipOn = (sign: 1 | -1) => {
      const extreme = sign > 0 ? Math.max(...local.map((v) => v[1])) : Math.min(...local.map((v) => v[1]));
      const lip = local.filter((v) => Math.abs(v[1] - extreme) < 0.5);
      const lx = lip.map((v) => v[0]);
      const lz = lip.map((v) => v[2]);
      return {
        y: extreme,
        centreX: (Math.min(...lx) + Math.max(...lx)) / 2,
        width: Math.max(...lx) - Math.min(...lx),
        centreZ: (Math.min(...lz) + Math.max(...lz)) / 2,
        height: Math.max(...lz) - Math.min(...lz),
      };
    };
    const element = fdum22({ position: { x: -1084 / 2, y: -697 / 2 }, elevation: 0 });
    for (const port of resolveUnitAirPorts(element)) {
      const lip = lipOn(port.normal.y > 0 ? 1 : -1);
      expect(Math.abs(port.lip.y - lip.y)).toBeLessThan(2);
      expect(Math.abs(port.lip.x - lip.centreX)).toBeLessThan(2);
      expect(Math.abs(port.lip.z - lip.centreZ)).toBeLessThan(2);
      expect(Math.abs(port.widthMm - lip.width)).toBeLessThan(2);
      expect(Math.abs(port.heightMm - lip.height)).toBeLessThan(2);
    }
  });
});
