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
import { buildPairedGeometry } from '../geometry/offset';
import { kitChannels, kitToWorld, portWorld } from '../geometry/kit';
import type { BranchKit, LineFilter } from '../model/types';

export type PortState = 'valid' | 'invalid' | 'idle';

const KIT_FITTING_RADIUS = 10; // tight arc for the fitting body

export function KitShape({
  kit,
  gapMm,
  gasWidthMm,
  liquidWidthMm,
  filter,
  zoom,
  ghost = false,
  portState,
}: {
  kit: BranchKit;
  gapMm: number;
  gasWidthMm: number;
  liquidWidthMm: number;
  filter: LineFilter;
  zoom: number;
  ghost?: boolean;
  portState?: (portId: string) => PortState;
}): JSX.Element {
  const ch = kitChannels();
  const trunkW = ch.trunk.map((p) => kitToWorld(kit.transform, p));
  const branchW = ch.branch.map((p) => kitToWorld(kit.transform, p));
  const trunk = buildPairedGeometry(trunkW, gapMm, KIT_FITTING_RADIUS);
  const branch = buildPairedGeometry(branchW, gapMm, KIT_FITTING_RADIUS);
  const showGas = filter !== 'liquid';
  const showLiquid = filter !== 'gas';

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
