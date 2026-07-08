'use client';

/**
 * camera-controls wrapper for the 2D↔3D plane tilt — modelled on the reference
 * app's ViewportController (D:\myWorks\Advance canvas board, SPEC §10). Ortho /
 * parallel projection, Z-up, frustum in pixels with `zoom = px-per-mm`, so
 * polar 0 (top-down) reads 1:1 with the 2D board. RMB = damped ROTATE that opens
 * PLAN→TILT (max polar 58°) and pivots under the cursor; releasing near flat
 * (polar < 5°) snaps back to exact plan.
 *
 * ProvacX keeps the board's zoom/pan in its own store, so this controller owns
 * ONLY the tilt rotation: `syncBoard()` feeds the current zoom + centre each
 * frame and camera-controls adds polar/azimuth on top. No bidirectional sync.
 */
import CameraControls from 'camera-controls';
import * as THREE from 'three';

CameraControls.install({ THREE });

const TILT_MAX_POLAR = THREE.MathUtils.degToRad(58);
const PLAN_SNAP_POLAR = THREE.MathUtils.degToRad(5);

export class HybridViewportController {
  readonly camera: THREE.OrthographicCamera;
  private controls: CameraControls | null = null;
  private el: HTMLElement | null = null;
  private capHandlers: Array<[string, EventListener]> = [];
  private planeZ = 0;
  /** Called on any camera change (input or damping tween) so the host can pump a frame. */
  onChange: (() => void) | null = null;

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1e9);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, 0, 1_000_000);
  }

  attach(el: HTMLElement, width: number, height: number): void {
    this.el = el;
    const controls = new CameraControls(this.camera, el);
    this.controls = controls;
    controls.dollyToCursor = true;
    controls.smoothTime = 0.08;
    controls.draggingSmoothTime = 0.045;

    const A = CameraControls.ACTION;
    // Only RMB tilts; the board owns zoom/pan (ProvacX store), so everything else off.
    controls.mouseButtons.left = A.NONE;
    controls.mouseButtons.middle = A.NONE;
    controls.mouseButtons.wheel = A.NONE;
    controls.mouseButtons.right = A.ROTATE;
    controls.touches.one = A.NONE;
    controls.touches.two = A.NONE;
    controls.touches.three = A.TOUCH_ROTATE;

    // Start in PLAN: polar locked to 0 (top-down == the 2D board).
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = 0;
    void controls.setLookAt(0, 0, 1_000_000, 0, 0, 0, false);

    const kick = (): void => this.onChange?.();
    controls.addEventListener('update', kick);
    controls.addEventListener('controlstart', kick);
    controls.addEventListener('control', kick);
    controls.addEventListener('wake', kick);
    controls.addEventListener('transitionstart', kick);
    controls.addEventListener('controlend', () => this.planBackSnap());
    controls.addEventListener('rest', () => this.planBackSnap());

    // RMB opens the tilt band + pivots the orbit under the cursor (SPEC §10).
    this.cap(el, 'pointerdown', (ev) => {
      const e = ev as PointerEvent;
      if (e.button !== 2 || e.shiftKey) return;
      controls.maxPolarAngle = TILT_MAX_POLAR;
      const rect = el.getBoundingClientRect();
      const hit = this.screenToPlane(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) controls.setOrbitPoint(hit.x, hit.y, hit.z);
    });
    // RMB is reserved for the tilt gesture — no browser menu.
    this.cap(el, 'contextmenu', (ev) => ev.preventDefault());

    this.setSize(width, height);
  }

  /** Feed the board's zoom + world centre each frame; controls only add the tilt. */
  syncBoard(pxPerMm: number, centerX: number, centerY: number, planeZ = 0): void {
    if (!this.controls) return;
    this.planeZ = planeZ;
    void this.controls.zoomTo(Math.max(pxPerMm, 1e-6), false);
    void this.controls.moveTo(centerX, centerY, planeZ, false);
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
  }

  /** Per-frame pump — returns true while camera-controls is still animating. */
  update(delta: number): boolean {
    return this.controls?.update(delta) ?? false;
  }

  /** Programmatic return to flat plan (double-click / reset). */
  resetToPlan(animate = true): void {
    if (!this.controls) return;
    void this.controls.rotatePolarTo(0, animate);
    this.controls.maxPolarAngle = 0;
  }

  get polar(): number {
    return this.controls?.polarAngle ?? 0;
  }
  get azimuth(): number {
    return this.controls?.azimuthAngle ?? 0;
  }

  dispose(): void {
    for (const [name, fn] of this.capHandlers) this.el?.removeEventListener(name, fn, true);
    this.capHandlers = [];
    this.controls?.dispose();
    this.controls = null;
    this.el = null;
  }

  private planBackSnap(): void {
    if (!this.controls) return;
    if (this.controls.polarAngle < PLAN_SNAP_POLAR && this.controls.maxPolarAngle > 0) {
      void this.controls.rotatePolarTo(0, true);
      this.controls.maxPolarAngle = 0;
    }
  }

  private screenToPlane(x: number, y: number): THREE.Vector3 | null {
    this.camera.updateMatrixWorld();
    const ndcX = (x / (this.camera.right - this.camera.left)) * 2 - 1;
    const ndcY = 1 - (y / (this.camera.top - this.camera.bottom)) * 2;
    const origin = new THREE.Vector3(ndcX, ndcY, -1).unproject(this.camera);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld).normalize();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.planeZ);
    const ray = new THREE.Ray(origin, dir);
    return ray.intersectPlane(plane, new THREE.Vector3());
  }

  private cap(el: HTMLElement, name: string, fn: EventListener): void {
    el.addEventListener(name, fn, true);
    this.capHandlers.push([name, fn]);
  }
}
