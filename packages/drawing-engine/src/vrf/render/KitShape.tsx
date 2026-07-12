'use client';

/**
 * Branch-kit rendering, split for performance:
 *  - KitBody: the copper body in the kit's LOCAL frame, inside a Konva Group carrying
 *    the kit transform, and .cache()d — so moving/rotating a kit re-blits the cached
 *    bitmap instead of re-stroking ~24 concentric bands. Cached at a zoom-aware
 *    pixelRatio so it stays crisp; re-caches only when the geometry or zoom bucket
 *    changes (NOT during a drag/pan, where zoom is constant).
 *  - KitPorts: the 6 port ring glyphs in WORLD coords, screen-constant, rendered in
 *    the overlays layer (they carry selection/connection state and must stay sharp).
 */

import { Fragment, memo, useEffect, useRef } from 'react';
import { Circle, Group } from 'react-konva';
import type Konva from 'konva';

import { CopperTube } from './PipeShape';
import { kitRotationDeg, portWorld, type KitBodyGeometry } from '../geometry/kit';
import type { BranchKit } from '../model/types';

export type PortState = 'valid' | 'invalid' | 'idle';

/** pixelRatio for the cached body: >= zoom keeps it crisp; capped to bound memory. */
export function cachePixelRatio(zoom: number): number {
  return Math.min(6, Math.max(1, Math.ceil(zoom)));
}

export const KitBody = memo(function KitBody({
  kit,
  body,
  gasWidthMm,
  liquidWidthMm,
  only,
  zoom,
  cache = true,
  opacity = 1,
}: {
  kit: BranchKit;
  body: KitBodyGeometry;
  gasWidthMm: number;
  liquidWidthMm: number;
  /** Render only ONE line (for the per-line visibility groups). */
  only?: 'gas' | 'liquid';
  zoom: number;
  /** Cache the body group (off for the transient ghost, which moves every frame). */
  cache?: boolean;
  opacity?: number;
}): JSX.Element {
  const ref = useRef<Konva.Group | null>(null);
  const pr = cachePixelRatio(zoom);
  const showGas = only ? only === 'gas' : true;
  const showLiquid = only ? only === 'liquid' : true;

  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    if (!cache) {
      g.clearCache();
      return;
    }
    g.cache({ pixelRatio: pr });
    g.getLayer()?.batchDraw();
    return () => {
      g.clearCache();
    };
    // Re-cache only when the local geometry, widths, filter, or zoom bucket changes.
  }, [cache, pr, body, gasWidthMm, liquidWidthMm, showGas, showLiquid]);

  return (
    <Group
      ref={ref}
      x={kit.transform.pos.x}
      y={kit.transform.pos.y}
      rotation={kitRotationDeg(kit)}
      scaleX={kit.transform.mirror ? -1 : 1}
      opacity={opacity}
      listening={false}
    >
      {showGas ? <CopperTube path={body.trunk.gas} widthMm={gasWidthMm} /> : null}
      {showLiquid ? <CopperTube path={body.trunk.liquid} widthMm={liquidWidthMm} /> : null}
      {showGas ? <CopperTube path={body.branch.gas} widthMm={gasWidthMm} /> : null}
      {showLiquid ? <CopperTube path={body.branch.liquid} widthMm={liquidWidthMm} /> : null}
    </Group>
  );
});

/** The 6 port ring glyphs (world coords, screen-constant). Overlays layer. */
export function KitPorts({
  kit,
  zoom,
  filter = 'both',
  portState,
}: {
  kit: BranchKit;
  zoom: number;
  filter?: 'gas' | 'liquid' | 'both';
  portState?: (portId: string) => PortState;
}): JSX.Element {
  const showGas = filter !== 'liquid';
  const showLiquid = filter !== 'gas';
  return (
    <Fragment>
      {kit.ports.map((port) => {
        if ((port.type === 'gas' && !showGas) || (port.type === 'liquid' && !showLiquid)) return null;
        const w = portWorld(kit, port);
        const state = portState?.(port.id) ?? 'idle';
        const color =
          state === 'valid' ? '#2f9e68' : state === 'invalid' ? '#d64545' : port.type === 'gas' ? '#1f6fb2' : '#b5742f';
        return (
          <Circle
            key={port.id}
            x={w.pos.x}
            y={w.pos.y}
            radius={5.5 / zoom}
            fill="#fff"
            stroke={color}
            strokeWidth={(state === 'idle' ? 1.8 : 2.4) / zoom}
            dash={state === 'valid' ? [3.2 / zoom, 3.2 / zoom] : undefined}
            listening={false}
          />
        );
      })}
    </Fragment>
  );
}
