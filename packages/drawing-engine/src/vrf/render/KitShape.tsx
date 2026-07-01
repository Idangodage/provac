'use client';

/**
 * Branch-kit render: the copper body (trunk + branch paired tubes) in world units
 * plus the 6 port ring glyphs. Rings are screen-constant (radius / zoom). Port
 * state colours the ring: valid = green dashed, invalid (wrong type) = red, else a
 * neutral gas(blue)/liquid(amber) ring.
 */

import { Fragment } from 'react';
import { Circle } from 'react-konva';

import { CopperTube } from './PipeShape';
import { buildKitBodyGeometry, portWorld, type KitBodyGeometry } from '../geometry/kit';
import type { BranchKit, LineFilter } from '../model/types';

export type PortState = 'valid' | 'invalid' | 'idle';

export function KitShape({
  kit,
  body,
  gasWidthMm,
  liquidWidthMm,
  filter = 'both',
  only,
  zoom,
  ghost = false,
  portState,
}: {
  kit: BranchKit;
  /** Precomputed copper body (shared across the gas + liquid passes). Falls back to
   *  a per-instance compute when omitted (e.g. the single ghost render). */
  body?: KitBodyGeometry;
  gasWidthMm: number;
  liquidWidthMm: number;
  filter?: LineFilter;
  /** Render only ONE line (for per-line visibility groups). Overrides `filter`. */
  only?: 'gas' | 'liquid';
  zoom: number;
  ghost?: boolean;
  portState?: (portId: string) => PortState;
}): JSX.Element {
  const { trunk, branch } = body ?? buildKitBodyGeometry(kit);
  const showGas = only ? only === 'gas' : filter !== 'liquid';
  const showLiquid = only ? only === 'liquid' : filter !== 'gas';

  return (
    <Fragment>
      <Circle
        // faint body glow so the ghost/selected kit reads as one component
        opacity={ghost ? 0.85 : 1}
        x={kit.transform.pos.x}
        y={kit.transform.pos.y}
        radius={0}
        listening={false}
      />
      {showGas ? <CopperTube path={trunk.gas} widthMm={gasWidthMm} /> : null}
      {showLiquid ? <CopperTube path={trunk.liquid} widthMm={liquidWidthMm} /> : null}
      {showGas ? <CopperTube path={branch.gas} widthMm={gasWidthMm} /> : null}
      {showLiquid ? <CopperTube path={branch.liquid} widthMm={liquidWidthMm} /> : null}

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
