import type CameraControls from 'camera-controls';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HybridViewportController } from './hybridViewportController';
import { resolveHybridCameraViewPose, worldToScreen } from './hybridViewportMath';

class TestRect {
  constructor(public x = 0, public y = 0, public width = 1200, public height = 800) {}
  get left(): number { return this.x; }
  get top(): number { return this.y; }
  get right(): number { return this.x + this.width; }
  get bottom(): number { return this.y + this.height; }
}

class TestElement extends EventTarget {
  style = {};
  ownerDocument = new EventTarget();
  getBoundingClientRect(): TestRect { return new TestRect(); }
  setAttribute(): void {}
  removeAttribute(): void {}
}

describe('HybridViewportController view motion', () => {
  let controller: HybridViewportController;
  const viewport = { width: 1200, height: 800 };

  beforeEach(() => {
    vi.stubGlobal('DOMRect', TestRect);
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      matchMedia: vi.fn(() => ({ matches: false })),
    }));
    controller = new HybridViewportController();
    controller.attach(new TestElement() as unknown as HTMLElement, viewport.width, viewport.height);
    controller.setBoardView(0.15, 4200, -2300);
    controller.update(0);
    controller.setContentBounds(new THREE.Box3(
      new THREE.Vector3(-9000, -8000, 0),
      new THREE.Vector3(11000, 9000, 3200),
    ));
  });

  afterEach(() => {
    controller.dispose();
    vi.unstubAllGlobals();
  });

  const navigation = (): CameraControls => Reflect.get(controller, 'controls') as CameraControls;

  it('eases plan to iso in a bounded half second and keeps the requested toolbar view', () => {
    const changed = vi.fn();
    controller.onChange = changed;
    const start = controller.camera.position.clone();
    controller.setIsometricView();
    expect(changed).toHaveBeenCalled();
    expect(controller.camera.position.distanceTo(start)).toBeLessThan(1e-6);
    expect(controller.cameraView).toBe('iso');
    expect(controller.isTransitioning).toBe(true);
    controller.update(0.05);
    expect(controller.polar).toBeGreaterThan(0);
    expect(controller.polar).toBeLessThan(resolveHybridCameraViewPose('iso').polar * 0.02);
    expect(controller.cameraView).toBe('iso');
    controller.update(0.05, 0.2);
    expect(controller.polar).toBeCloseTo(resolveHybridCameraViewPose('iso').polar / 2, 5);
    controller.update(0.05, 0.25);
    expect(controller.isTransitioning).toBe(false);
    expect(controller.polar).toBeCloseTo(resolveHybridCameraViewPose('iso').polar, 10);
    expect(controller.azimuthWrapped).toBeCloseTo(-Math.PI / 4, 10);
  });

  it('does not start an unnecessary transition when the active view is selected again', () => {
    controller.resetToPlan();
    expect(controller.isTransitioning).toBe(false);
    controller.setIsometricView(false);
    controller.setIsometricView();
    expect(controller.isTransitioning).toBe(false);
  });

  it('preserves the working scale and floor anchor through a plan/iso round trip', () => {
    const initial = controller.deriveBoardView();
    const anchor = controller.screenToPlane(600, 400)!;
    controller.setIsometricView();
    controller.update(0.05, 0.5);
    expect(controller.camera.zoom).toBe(0.15);
    const screen = worldToScreen(anchor, controller.camera, viewport);
    expect(screen.x).toBeCloseTo(600, 5);
    expect(screen.y).toBeCloseTo(400, 5);
    controller.resetToPlan();
    controller.update(0.05, 0.5);
    const returned = controller.deriveBoardView();
    expect(returned.zoom).toBeCloseTo(initial.zoom, 10);
    expect(returned.panPxX).toBeCloseTo(initial.panPxX, 5);
    expect(returned.panPxY).toBeCloseTo(initial.panPxY, 5);
    expect(controller.isFlatView(1e-5)).toBe(true);
    expect(navigation().maxPolarAngle).toBe(0);
  });

  it('retargets from the rendered pose without jumping to the old destination', () => {
    controller.setIsometricView();
    controller.update(0.05, 0.2);
    const position = controller.camera.position.clone();
    const quaternion = controller.camera.quaternion.clone();
    controller.setSideView();
    expect(controller.camera.position.distanceTo(position)).toBeLessThan(1e-6);
    expect(controller.camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-7);
    expect(controller.cameraView).toBe('side');
    controller.update(0.05, 0.5);
    expect(controller.cameraView).toBe('side');
    expect(controller.isTransitioning).toBe(false);
    expect(controller.polar).toBeCloseTo(Math.PI / 2, 10);
  });

  it('does not drop the orbit focal offset at the start of view or fit commands', () => {
    controller.setIsometricView(false);
    const pivot = controller.screenToPlane(900, 300)!;
    navigation().setOrbitPoint(pivot.x, pivot.y, pivot.z);
    controller.update(0);
    expect(navigation().getFocalOffset(new THREE.Vector3(), false).length()).toBeGreaterThan(100);
    const before = controller.camera.position.clone();
    controller.resetToPlan();
    expect(controller.camera.position.distanceTo(before)).toBeLessThan(1e-6);
    controller.update(0.05, 0.15);
    const beforeFit = controller.camera.position.clone();
    expect(controller.fitContent()).toBe(true);
    expect(controller.camera.position.distanceTo(beforeFit)).toBeLessThan(1e-6);
    controller.update(0.05, 0.5);
    expect(navigation().getFocalOffset(new THREE.Vector3(), false).length()).toBe(0);
    expect(controller.isFlatView(1e-5)).toBe(true);
  });

  it('keeps programmatic motion out of the plan magnet and only locks at completion', () => {
    controller.setIsometricView();
    controller.update(0.01);
    navigation().dispatchEvent({ type: 'rest' });
    expect(navigation().maxPolarAngle).toBeGreaterThan(0);
    controller.update(0.05, 0.49);
    controller.resetToPlan();
    controller.update(0.05, 0.49);
    expect(navigation().maxPolarAngle).toBeGreaterThan(0);
    controller.update(0.01);
    expect(navigation().maxPolarAngle).toBe(0);
  });

  it('hands navigation back immediately when the user pans during a transition', () => {
    controller.setIsometricView();
    controller.update(0.05, 0.25);
    const polar = controller.polar;
    controller.truckPixels(50, 25);
    expect(controller.isTransitioning).toBe(false);
    controller.update(0.05, 1);
    expect(controller.polar).toBeCloseTo(polar, 10);
  });

  it('restores plan framing after fitting an elevation', () => {
    const initial = controller.deriveBoardView();
    controller.setFrontView(false);
    expect(controller.camera.zoom).not.toBe(0.15);
    controller.resetToPlan(false);
    const restored = controller.deriveBoardView();
    expect(restored.zoom).toBeCloseTo(initial.zoom, 10);
    expect(restored.panPxX).toBeCloseTo(initial.panPxX, 5);
    expect(restored.panPxY).toBeCloseTo(initial.panPxY, 5);
  });

  it('honours explicit Fit across view changes until the user navigates manually', () => {
    expect(controller.fitContent('plan', false)).toBe(true);
    controller.setIsometricView();
    controller.update(0.05, 0.5);
    for (const x of [-9000, 11000]) {
      for (const y of [-8000, 9000]) {
        for (const z of [0, 3200]) {
          const screen = worldToScreen(new THREE.Vector3(x, y, z), controller.camera, viewport);
          expect(screen.x).toBeGreaterThanOrEqual(24 - 1e-5);
          expect(screen.x).toBeLessThanOrEqual(viewport.width - 24 + 1e-5);
          expect(screen.y).toBeGreaterThanOrEqual(24 - 1e-5);
          expect(screen.y).toBeLessThanOrEqual(viewport.height - 24 + 1e-5);
        }
      }
    }
    const fittedZoom = controller.camera.zoom;
    controller.resetToPlan(false);
    expect(controller.camera.zoom).not.toBe(fittedZoom);
    controller.truckPixels(50, 25);
    controller.update(0);
    const manuallyFramedZoom = controller.camera.zoom;
    controller.setIsometricView(false);
    expect(controller.camera.zoom).toBe(manuallyFramedZoom);
  });

  it('uses the shortest azimuth path even after several manual orbits', () => {
    controller.setIsometricView(false);
    void navigation().rotateTo(Math.PI * 6 + THREE.MathUtils.degToRad(170), 0.7, false);
    controller.update(0);
    const start = controller.azimuth;
    controller.setIsometricView();
    controller.update(0.05, 0.25);
    expect(controller.azimuth - start).toBeCloseTo(THREE.MathUtils.degToRad(145) / 2, 8);
    controller.update(0.05, 0.25);
    expect(controller.azimuthWrapped).toBeCloseTo(-Math.PI / 4, 10);
  });

  it('respects reduced motion and explicit immediate view commands', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    controller.setIsometricView();
    expect(controller.cameraView).toBe('iso');
    expect(controller.isTransitioning).toBe(false);
    expect(controller.polar).toBeCloseTo(resolveHybridCameraViewPose('iso').polar, 10);
    controller.resetToPlan();
    expect(controller.isFlatView(1e-5)).toBe(true);
    expect(controller.isTransitioning).toBe(false);
  });

  it.each([30, 60, 144])('completes in 500 ms at %i Hz without a damping tail', (fps) => {
    controller.setIsometricView();
    for (let frame = 0; frame < fps / 2; frame += 1) controller.update(1 / fps);
    expect(controller.isTransitioning).toBe(false);
    expect(controller.cameraView).toBe('iso');
    expect(controller.polar).toBeCloseTo(resolveHybridCameraViewPose('iso').polar, 10);
    const endpoint = controller.camera.position.clone();
    controller.update(1 / fps);
    expect(controller.camera.position.distanceTo(endpoint)).toBeLessThan(1e-6);
  });
});
