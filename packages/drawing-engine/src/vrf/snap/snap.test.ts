import { describe, it, expect } from 'vitest';
import { produce } from 'immer';

import { SnapIndex, snap, worldTolerance, nearestGrid, projectOntoGuide, snapMemoKey } from './index';
import { emptyDoc, PIPE_SIZES, type BoardDoc } from '../model/types';
import { createRefnetKit, portPairCenterWorld } from '../geometry/kit';
import { connectRunEnd } from '../model/ops';
import type { ViewTransform } from '../geometry/transform';

const size = PIPE_SIZES[1]!;
const OPTS = { gapMm: 30 };
const view = (zoom: number): ViewTransform => ({ zoom, panX: 0, panY: 0 });

function docWith(mut: (d: BoardDoc) => void): BoardDoc {
  return produce(emptyDoc(), mut);
}

describe('snap — priority port → endpoint → parallel → grid', () => {
  it('a port beats an endpoint at equal distance', () => {
    const doc = docWith((d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: 0, y: 0 }, rotation: 0, mirror: false }, 30);
      // open run whose end sits exactly on the kit inlet centre
      d.runs['r'] = { id: 'r', spine: [{ x: -500, y: 0 }, { x: -100, y: 0 }], lineType: 'paired', size, bendRadiusMm: 200 };
    });
    const inCentre = portPairCenterWorld(doc.kits['k']!, 'in')!; // (-100, 0)
    const res = snap(inCentre, view(1), doc, OPTS)!;
    expect(res.kind).toBe('port');
    expect(res.tier).toBe(0);
  });

  it('an endpoint beats a parallel guide even when the guide is nearer', () => {
    const doc = docWith((d) => {
      d.runs['r'] = { id: 'r', spine: [{ x: 0, y: 100 }, { x: 100, y: 100 }], lineType: 'paired', size, bendRadiusMm: 200 };
    });
    // endpoint (100,100) is 5mm away; the v-guide x=100 is 0mm away — endpoint still wins.
    const res = snap({ x: 100, y: 105 }, view(1), doc, { gapMm: 30, tolerancePx: 20 })!;
    expect(res.kind).toBe('endpoint');
  });

  it('tolerance shrinks with zoom: a port in range at 1× falls through to grid at 4×', () => {
    const doc = docWith((d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: 200, y: 0 }, rotation: 0, mirror: false }, 30);
    });
    // in-centre = (100,0); cursor 6mm away. No endpoints -> no guides.
    const near = snap({ x: 106, y: 0 }, view(1), doc, OPTS)!; // tol 8 -> hit
    expect(near.kind).toBe('port');
    const far = snap({ x: 106, y: 0 }, view(4), doc, OPTS)!; // tol 2 -> miss -> grid
    expect(far.kind).toBe('grid');
  });

  it('worldTolerance clamps at extreme zoom (floor and ceil)', () => {
    expect(worldTolerance(view(40), { gapMm: 30, tolerancePx: 8 })).toBe(0.5); // 0.2 -> floor
    expect(worldTolerance(view(0.05), { gapMm: 30, tolerancePx: 50 })).toBe(500); // 1000 -> ceil
    expect(worldTolerance(view(2), { gapMm: 30, tolerancePx: 8 })).toBe(4); // 8/2
  });

  it('grid is fallback only, and snaps to the NEAREST grid point (Math.round)', () => {
    const empty = emptyDoc();
    const res = snap({ x: 17, y: 17 }, view(1), empty, { gapMm: 30, gridMm: 10 })!;
    expect(res.kind).toBe('grid');
    expect(res.point).toEqual({ x: 20, y: 20 });
    expect(nearestGrid({ x: 14, y: 26 }, 10)).toEqual({ x: 10, y: 30 });
  });

  it('a nearby port overrides the grid at the same cursor', () => {
    const doc = docWith((d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: 100, y: 0 }, rotation: 0, mirror: false }, 30); // in-centre (0,0)
    });
    const res = snap({ x: 0.3, y: 0.2 }, view(1), doc, OPTS)!;
    expect(res.kind).toBe('port');
  });

  it('picks the closest candidate within a tier', () => {
    const doc = docWith((d) => {
      d.runs['a'] = { id: 'a', spine: [{ x: -100, y: 0 }, { x: 3, y: 0 }], lineType: 'paired', size, bendRadiusMm: 200 };
      d.runs['b'] = { id: 'b', spine: [{ x: -100, y: 20 }, { x: 5, y: 0 }], lineType: 'paired', size, bendRadiusMm: 200 };
      d.runs['c'] = { id: 'c', spine: [{ x: -100, y: 40 }, { x: 7, y: 0 }], lineType: 'paired', size, bendRadiusMm: 200 };
    });
    const res = snap({ x: 0, y: 0 }, view(1), doc, { gapMm: 30, tolerancePx: 10 })!;
    expect(res.kind).toBe('endpoint');
    expect(res.ref?.runId).toBe('a'); // endpoint at (3,0) is nearest
  });

  it('horizontal and vertical guides project correctly', () => {
    const doc = docWith((d) => {
      d.runs['r'] = { id: 'r', spine: [{ x: 100, y: 200 }, { x: 100, y: 180 }], lineType: 'paired', size, bendRadiusMm: 200 };
    });
    // endpoint is (100,180); its outward is vertical, so the h-guide is y=180 and v-guide x=100.
    // Cursor far along x on the h-guide, away from the endpoint point itself.
    const h = snap({ x: 400, y: 180.4 }, view(1), doc, { gapMm: 30, tolerancePx: 3 })!;
    expect(h.kind).toBe('parallel');
    expect(h.point.x).toBeCloseTo(400, 6);
    expect(h.point.y).toBeCloseTo(180, 6);
  });

  it('segment-parallel guide uses perpendicular distance and ignores along-line offset', () => {
    const inv = 1 / Math.SQRT2;
    const c: any = { point: { x: 0, y: 0 }, kind: 'parallel', dir: { x: inv, y: inv }, ref: { guide: 'seg' } };
    const near = projectOntoGuide(c, { x: 10, y: 11 });
    expect(near.point.x).toBeCloseTo(10.5, 6);
    expect(near.point.y).toBeCloseTo(10.5, 6);
    expect(near.distanceMm).toBeCloseTo(Math.SQRT2 / 2, 6);
    // A point exactly on the (infinite) line snaps even far from the seed.
    const far = projectOntoGuide(c, { x: 1000, y: 1000 });
    expect(far.distanceMm).toBeCloseTo(0, 6);
  });

  it('rbush corner rejection: a hit inside the square box but outside the circle is dropped', () => {
    const doc = docWith((d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: 100, y: 0 }, rotation: 0, mirror: false }, 30); // in-centre (0,0)
    });
    // tol = 8; port at (0,0). Cursor at (7,7): inside the 8×8 box but dist = 9.9 > 8.
    const res = snap({ x: 7, y: 7 }, view(1), doc, { gapMm: 30, tolerancePx: 8 })!;
    expect(res.kind).toBe('grid');
  });

  it('connecting an endpoint removes it as a candidate and changes the memo key', () => {
    const base = docWith((d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: 0, y: 0 }, rotation: 0, mirror: false }, 30);
      d.runs['r'] = { id: 'r', spine: [{ x: -500, y: 0 }, { x: -100, y: 0 }], lineType: 'paired', size, bendRadiusMm: 200 };
    });
    const idx = new SnapIndex(base, OPTS);
    const key0 = idx.memoKey;
    const connected = produce(base, (d) => connectRunEnd(d, 'r', 'end', 'k', 'in'));
    idx.ensure(connected, OPTS);
    expect(idx.memoKey).not.toBe(key0);
    // at the old endpoint location, the only remaining target is the port pair centre
    const res = idx.query({ x: -100, y: 0 }, view(1))!;
    expect(res.kind).toBe('port');
  });

  it('memo key ignores view/tool but reacts to kit rotation and gap', () => {
    const doc = docWith((d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: 0, y: 0 }, rotation: 0, mirror: false }, 30);
    });
    const k0 = snapMemoKey(doc, { gapMm: 30 });
    const rotated = produce(doc, (d) => {
      d.kits['k']!.transform.rotation = 0.5;
    });
    expect(snapMemoKey(rotated, { gapMm: 30 })).not.toBe(k0);
    expect(snapMemoKey(doc, { gapMm: 31 })).not.toBe(k0);
  });

  it('the indexed port equals portPairCenterWorld after rotation + mirror', () => {
    const doc = docWith((d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: 40, y: -20 }, rotation: 1.1, mirror: true }, 30);
    });
    const c = portPairCenterWorld(doc.kits['k']!, 'in')!;
    const res = snap(c, view(1), doc, OPTS)!;
    expect(res.kind).toBe('port');
    expect(res.point.x).toBeCloseTo(c.x, 6);
    expect(res.point.y).toBeCloseTo(c.y, 6);
  });

  it('a NaN cursor returns null', () => {
    expect(snap({ x: NaN, y: 0 }, view(1), emptyDoc(), OPTS)).toBeNull();
  });

  it('tolerance boundary: a candidate exactly at tol is included', () => {
    const doc = docWith((d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: 100, y: 0 }, rotation: 0, mirror: false }, 30); // in-centre (0,0)
    });
    const res = snap({ x: 8, y: 0 }, view(1), doc, { gapMm: 30, tolerancePx: 8 })!; // dist exactly 8 = tol
    expect(res.kind).toBe('port');
  });
});
