'use client';

/**
 * THE one camera owner for the board — camera-controls wrapper following the
 * reference app's ViewportController (D:\myWorks\Advance canvas board,
 * docs/SPEC.md §10) practice:
 *
 *  - The CAMERA owns all navigation: wheel = zoom-to-cursor, MMB = truck (pan),
 *    RMB = rotate (plan⇄tilt magnetics), Shift+RMB = pan, two-finger touch =
 *    pinch-zoom+pan. LMB is NEVER the camera's — tools own it (reference LAW 6).
 *  - Everything else DERIVES from the camera: each frame the host reads
 *    `deriveBoardView()` (the flat-equivalent Fabric viewport of the current
 *    camera pose) and applies it to the Fabric canvas, refs, and store.
 *    The old direction (Fabric wheel/pan → camera `syncBoard`) is gone.
 *  - Ortho / parallel projection, Z-up, frustum in pixels with
 *    `zoom = px-per-mm`, so polar 0 (top-down) reads 1:1 with the 2D board.
 *  - RMB opens PLAN→TILT (max polar 58°) pivoting under the cursor; releasing
 *    near flat (polar < 5°) snaps back to exact plan.
 */
import CameraControls from 'camera-controls';
import * as THREE from 'three';

import {
  clampOrthoZoom,
  deriveBoardViewFromCamera,
  resolveHybridCameraViewFromPose,
  resolveHybridCameraViewPose,
  screenToWorldOnPlaneZ,
  type DerivedBoardView,
  type HybridCameraView,
} from './hybridViewportMath';

CameraControls.install({ THREE });

// All numeric pose/projection math lives in hybridViewportMath.ts (pure,
// property-tested — the reference-app practice). This class only owns the
// camera-controls wiring and input mapping.
export type { DerivedBoardView } from './hybridViewportMath';
export type { HybridCameraView } from './hybridViewportMath';

const TILT_MAX_POLAR = THREE.MathUtils.degToRad(58);
const PLAN_SNAP_POLAR = THREE.MathUtils.degToRad(5);
/** Magnetic azimuth squaring: releasing within this of square snaps to 0. */
const PLAN_SNAP_AZIMUTH = THREE.MathUtils.degToRad(5);
const FLAT_POLAR_EPSILON = THREE.MathUtils.degToRad(0.02);

export class HybridViewportController {
  readonly camera: THREE.OrthographicCamera;
  private controls: CameraControls | null = null;
  private el: HTMLElement | null = null;
  private capHandlers: Array<[string, EventListener]> = [];
  private windowHandlers: Array<[string, EventListener]> = [];
  private planeZ = 0;
  private viewport = { width: 2, height: 2 };
  /**
   * True while the RMB tilt gesture is physically held. camera-controls fires
   * `rest` whenever damping settles — INCLUDING mid-drag when the pointer
   * pauses — and back-snapping then would gradually pull a held gesture back
   * to 2D. The plan back-snap must only ever run after release.
   */
  private rotateGestureActive = false;
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
    controls.minZoom = clampOrthoZoom(0);
    controls.maxZoom = clampOrthoZoom(Number.POSITIVE_INFINITY);

    const A = CameraControls.ACTION;
    // Reference §10 input map: camera owns navigation, tools own LMB.
    controls.mouseButtons.left = A.NONE;
    controls.mouseButtons.middle = A.TRUCK;
    controls.mouseButtons.wheel = A.ZOOM; // ortho zoom-to-cursor
    controls.mouseButtons.right = A.ROTATE;
    controls.touches.one = A.NONE;
    controls.touches.two = A.TOUCH_ZOOM_TRUCK;
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

    // Capture-phase adjustments BEFORE camera-controls sees the event
    // (reference practice): RMB opens the tilt band + pivots under the cursor;
    // Shift+RMB pans instead; Shift+wheel is precision zoom; trackpad
    // horizontal two-finger scroll trucks.
    this.cap(el, 'pointerdown', (ev) => {
      const e = ev as PointerEvent;
      if (e.button !== 2) return;
      if (e.shiftKey) {
        controls.mouseButtons.right = A.TRUCK;
        return;
      }
      this.rotateGestureActive = true;
      controls.mouseButtons.right = A.ROTATE;
      // Preserve the established PLAN->TILT limit, but do not clamp an
      // explicit front/side elevation the instant RMB orbit begins.
      controls.maxPolarAngle = Math.max(TILT_MAX_POLAR, controls.polarAngle);
      const rect = el.getBoundingClientRect();
      const hit = this.screenToPlane(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) controls.setOrbitPoint(hit.x, hit.y, hit.z);
    });
    // Release ends the gesture wherever the pointer is (window, capture phase:
    // camera-controls may have pointer capture) — only THEN may plan back-snap.
    const endRotateGesture = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (e.type === 'pointerup' && e.button !== 2) return;
      if (!this.rotateGestureActive) return;
      this.rotateGestureActive = false;
      this.planBackSnap();
    };
    this.capWindow('pointerup', endRotateGesture);
    this.capWindow('pointercancel', endRotateGesture);
    this.cap(el, 'wheel', (ev) => {
      const e = ev as WheelEvent;
      controls.dollySpeed = e.shiftKey ? 0.2 : 1.0;
      if (!e.ctrlKey && e.deltaX !== 0) {
        e.preventDefault();
        e.stopPropagation();
        this.truckPixels(e.deltaX, e.deltaY);
      }
    });
    // RMB is reserved for the tilt gesture — no browser menu.
    this.cap(el, 'contextmenu', (ev) => ev.preventDefault());

    this.setSize(width, height);
  }

  /**
   * Programmatic view set (store→camera bridge: initial pose, toolbar zoom
   * buttons, fit). NOT called per frame — the camera is the owner; per-frame
   * flow is the other way (`deriveBoardView`).
   */
  setBoardView(pxPerMm: number, centerWorldX: number, centerWorldY: number, planeZ = 0): void {
    if (!this.controls) return;
    this.planeZ = planeZ;
    // Clear any RMB-pivot focal offset first: with an offset, the TARGET does
    // not project to the screen centre, so a target-based set would disagree
    // with the pose-based derivation forever (the derive→store→bridge loop
    // would never converge and the board would drift/rubber-band).
    this.controls.setFocalOffset(0, 0, 0, false);
    void this.controls.zoomTo(clampOrthoZoom(pxPerMm), false);
    void this.controls.moveTo(centerWorldX, centerWorldY, planeZ, false);
  }

  /**
   * The flat-equivalent Fabric viewport of the CURRENT camera pose — the
   * single source every DOM layer derives from each frame. Valid at any tilt:
   * the plan sheet transform composes the tilt on top of this flat mapping.
   *
   * POSE-based, never target-based: `setOrbitPoint` (RMB pivot-under-cursor)
   * moves camera-controls' target to the CURSOR point while keeping the view
   * via a focal offset — so the target does NOT project to the screen centre.
   * Deriving from the target made the whole board jump to re-centre on the
   * cursor the moment RMB went down. Unprojecting the actual screen centre
   * onto the board plane is correct for any target/focal-offset state.
   */
  deriveBoardView(): DerivedBoardView {
    this.camera.updateMatrixWorld();
    return deriveBoardViewFromCamera(
      this.camera,
      this.viewport,
      this.planeZ,
      this.controls?.getTarget(new THREE.Vector3()),
    );
  }

  /** Pan by screen pixels (trackpad horizontal scroll / external pan calls). */
  truckPixels(dxPx: number, dyPx: number): void {
    if (!this.controls) return;
    const mmPerPx = 1 / Math.max(this.camera.zoom, 1e-9);
    // Sign matches the reference app: scroll right/down moves content left/up.
    void this.controls.truck(-dxPx * mmPerPx, -dyPx * mmPerPx, false);
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.viewport = { width: w, height: h };
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

  /**
   * Programmatic return to flat plan (double-click / reset / 2D button).
   * Returns azimuth to 0 as well: the flat Fabric board cannot represent a
   * rotated view, so PLAN means polar 0 AND azimuth 0 — otherwise the grid
   * renders rotated/offset under the unrotated plan (the "plane jumped" bug).
   */
  resetToPlan(animate = true): void {
    if (!this.controls) return;
    this.controls.normalizeRotations();
    void this.controls.rotateTo(0, 0, animate);
    this.controls.maxPolarAngle = 0;
  }

  /** Set one of the canonical manipulation views without moving the model. */
  setCameraView(view: HybridCameraView, animate = true): void {
    if (!this.controls) return;
    if (view === 'plan') {
      this.resetToPlan(animate);
      return;
    }
    const pose = resolveHybridCameraViewPose(view);
    this.rotateGestureActive = false;
    this.controls.normalizeRotations();
    this.controls.setFocalOffset(0, 0, 0, false);
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.max(TILT_MAX_POLAR, pose.polar);
    void this.controls.rotateTo(pose.azimuth, pose.polar, animate);
  }

  setFrontView(animate = true): void {
    this.setCameraView('front', animate);
  }

  setSideView(animate = true): void {
    this.setCameraView('side', animate);
  }

  setIsometricView(animate = true): void {
    this.setCameraView('iso', animate);
  }

  /**
   * SketchUp-style explicit 2D↔3D toggle: SmoothDamp the camera to the given
   * polar tilt (camera-only — the model never moves). Pivots on the current
   * target, exactly like the RMB gesture.
   */
  tiltTo(polarRad: number, animate = true): void {
    if (!this.controls) return;
    if (polarRad <= PLAN_SNAP_POLAR) {
      this.resetToPlan(animate);
      return;
    }
    this.controls.maxPolarAngle = TILT_MAX_POLAR;
    void this.controls.rotatePolarTo(Math.min(polarRad, TILT_MAX_POLAR), animate);
  }

  get isTilted(): boolean {
    return (this.controls?.polarAngle ?? 0) > FLAT_POLAR_EPSILON;
  }

  get polar(): number {
    return this.controls?.polarAngle ?? 0;
  }
  get azimuth(): number {
    return this.controls?.azimuthAngle ?? 0;
  }
  get cameraView(): HybridCameraView {
    return resolveHybridCameraViewFromPose(this.polar, this.azimuthWrapped);
  }
  /** Azimuth wrapped to (−π, π] — camera-controls accumulates full turns. */
  get azimuthWrapped(): number {
    const az = this.controls?.azimuthAngle ?? 0;
    return THREE.MathUtils.euclideanModulo(az + Math.PI, Math.PI * 2) - Math.PI;
  }

  /**
   * True only when the view is the exact flat plan: polar AND azimuth at 0.
   * The DOM sheet may only drop its CSS matrix (for crisp text) in this state
   * — with any residual rotation the matrix must stay applied or the plan
   * visibly mismatches the grid.
   */
  isFlatView(epsilonRad: number): boolean {
    return this.polar <= epsilonRad && Math.abs(this.azimuthWrapped) <= epsilonRad;
  }

  dispose(): void {
    for (const [name, fn] of this.capHandlers) this.el?.removeEventListener(name, fn, true);
    this.capHandlers = [];
    if (typeof window !== 'undefined') {
      for (const [name, fn] of this.windowHandlers) window.removeEventListener(name, fn, true);
    }
    this.windowHandlers = [];
    this.controls?.dispose();
    this.controls = null;
    this.el = null;
  }

  private planBackSnap(): void {
    if (!this.controls) return;
    // Never snap while the tilt gesture is still held (see rotateGestureActive).
    if (this.rotateGestureActive) return;
    if (this.controls.polarAngle < PLAN_SNAP_POLAR && this.controls.maxPolarAngle > 0) {
      // Settle FLAT at the CURRENT orientation (reference SPEC §10: "plan may
      // be rotated in azimuth deliberately") — never spin the scene back to
      // square automatically; the rotated plan renders through the sheet
      // matrix and squaring up is the user's explicit 2D-button action.
      // Only a small magnetic band snaps azimuth home, mirroring the polar
      // back-snap feel.
      this.controls.normalizeRotations();
      void this.controls.rotatePolarTo(0, true);
      if (Math.abs(this.azimuthWrapped) < PLAN_SNAP_AZIMUTH) {
        void this.controls.rotateAzimuthTo(0, true);
      }
      this.controls.maxPolarAngle = 0;
    }
  }

  /** Screen px → world point on the board plane (public conversion API,
   * mirroring the reference ViewportController.screenToWorldOnPlane). */
  screenToPlane(x: number, y: number): THREE.Vector3 | null {
    this.camera.updateMatrixWorld();
    return screenToWorldOnPlaneZ(x, y, this.camera, this.viewport, this.planeZ);
  }

  private cap(el: HTMLElement, name: string, fn: EventListener): void {
    el.addEventListener(name, fn, true);
    this.capHandlers.push([name, fn]);
  }

  private capWindow(name: string, fn: EventListener): void {
    if (typeof window === 'undefined') return;
    window.addEventListener(name, fn, true);
    this.windowHandlers.push([name, fn]);
  }
}
