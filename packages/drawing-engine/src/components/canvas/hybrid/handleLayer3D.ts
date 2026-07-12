/**
 * Micro-edit handle layer for the hybrid 3D scene — faithful port of the
 * reference app's `engine/overlays/handleLayer.ts`: InstancedMesh pools per
 * handle kind (square endpoint, 45°-diamond midpoint-insert), constant ~10 px
 * screen-space size, per-instance state colors, drawn topmost with depth test
 * off, and a pure screen-space `hitTest` that runs BEFORE any raycast.
 */
import * as THREE from "three";

export type HandleKind3D = "endpoint" | "midpointInsert" | "pipeVertex";
export type HandleState3D = "idle" | "hover" | "active";

export type HandleEditTarget3D =
  | { kind: "pipeVertex"; nodeIndex: number }
  | { kind: "wallNode" }
  | { kind: "wallEdge" };

export interface HandleDef3D {
  id: string;
  kind: HandleKind3D;
  /** Model-space position (the layer lives under the mirrored view basis). */
  p: readonly [number, number, number];
  /** Wall edge or node the handle edits. */
  entityId: string;
  /** Optional typed edit metadata; omitted by legacy wall handles. */
  editTarget?: HandleEditTarget3D;
  state?: HandleState3D;
}

const HANDLE_PX = 10;
const HANDLE_CAP = 512;
export const HANDLE_HIT_RADIUS_PX = 6;

const HANDLE_COLORS: Record<HandleState3D, number> = {
  idle: 0xf5f7fa,
  hover: 0x4f8cff,
  active: 0x2f6fe0,
};

function makePool(geometry: THREE.BufferGeometry): THREE.InstancedMesh {
  const material = new THREE.MeshBasicMaterial({
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, HANDLE_CAP);
  mesh.renderOrder = 900;
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

export class HandleLayer3D {
  readonly group = new THREE.Group();
  private readonly pools: Record<HandleKind3D, THREE.InstancedMesh>;
  private defs: HandleDef3D[] = [];
  private unitsPerPixel = 1;

  constructor() {
    this.group.name = "hybrid-handle-layer";
    this.group.renderOrder = 900;
    const square = new THREE.PlaneGeometry(1, 1);
    const diamond = new THREE.PlaneGeometry(0.9, 0.9);
    diamond.rotateZ(Math.PI / 4);
    const pipeVertex = new THREE.CircleGeometry(0.58, 16);
    this.pools = {
      endpoint: makePool(square),
      midpointInsert: makePool(diamond),
      pipeVertex: makePool(pipeVertex),
    };
    this.group.add(this.pools.endpoint, this.pools.midpointInsert, this.pools.pipeVertex);
  }

  setDefs(defs: HandleDef3D[]): void {
    this.defs = defs;
    this.sync();
  }

  getDefs(): readonly HandleDef3D[] {
    return this.defs;
  }

  setState(handleId: string, state: HandleState3D): boolean {
    let changed = false;
    for (const def of this.defs) {
      const next = def.id === handleId ? state : "idle";
      if ((def.state ?? "idle") !== next) {
        def.state = next;
        changed = true;
      }
    }
    if (changed) this.sync();
    return changed;
  }

  /** Constant on-screen size: scale = HANDLE_PX · units-per-pixel. */
  updateScale(unitsPerPixel: number): void {
    if (Math.abs(unitsPerPixel - this.unitsPerPixel) < 1e-9) return;
    this.unitsPerPixel = unitsPerPixel;
    this.sync();
  }

  /**
   * Screen-space nearest-handle test (radius px) — consulted FIRST, before
   * any BVH raycast, exactly like the reference select tool.
   */
  hitTest(
    screenX: number,
    screenY: number,
    worldToScreen: (p: THREE.Vector3) => { x: number; y: number },
    modelToWorld: (p: readonly [number, number, number]) => THREE.Vector3,
    radiusPx = HANDLE_HIT_RADIUS_PX,
  ): HandleDef3D | null {
    let best: HandleDef3D | null = null;
    let bestDist = radiusPx;
    for (const def of this.defs) {
      const s = worldToScreen(modelToWorld(def.p));
      const d = Math.hypot(s.x - screenX, s.y - screenY);
      if (d <= bestDist) {
        bestDist = d;
        best = def;
      }
    }
    return best;
  }

  dispose(): void {
    for (const pool of Object.values(this.pools)) {
      pool.geometry.dispose();
      (pool.material as THREE.Material).dispose();
    }
  }

  private sync(): void {
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const scale = HANDLE_PX * this.unitsPerPixel;
    const counts: Record<HandleKind3D, number> = {
      endpoint: 0,
      midpointInsert: 0,
      pipeVertex: 0,
    };

    for (const def of this.defs) {
      const pool = this.pools[def.kind];
      const i = counts[def.kind];
      if (i >= HANDLE_CAP) continue;
      matrix.makeScale(scale, scale, 1);
      matrix.setPosition(def.p[0], def.p[1], def.p[2]);
      pool.setMatrixAt(i, matrix);
      pool.setColorAt(i, color.setHex(HANDLE_COLORS[def.state ?? "idle"]));
      counts[def.kind] = i + 1;
    }
    for (const kind of Object.keys(this.pools) as HandleKind3D[]) {
      const pool = this.pools[kind];
      pool.count = counts[kind];
      pool.instanceMatrix.needsUpdate = true;
      if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
    }
  }
}
