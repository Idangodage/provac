'use client';

/**
 * Copper tube rendering. The cross-section "dark edge → light centre → dark edge"
 * shading is built from concentric strokes of the SAME centreline path, from a
 * wide dark band down to a thin bright highlight. Because every band is a stroke
 * of the path, the shading follows the tube through bends with no seam or flip.
 * Rendered inside a world-scaled layer, so widths are world-true (scale with zoom).
 */

import { Fragment, memo, useMemo } from 'react';
import { Line } from 'react-konva';

import { samplePath, type Path } from '../geometry/path';
import { buildPairedGeometry, type PairedGeometry } from '../geometry/offset';
import type { LineFilter, PipeRun } from '../model/types';

/** Wide→narrow, dark→light. A symmetric stroke stack reads as a lit cylinder. */
const COPPER_BANDS = [
  { f: 1.0, c: '#43230f' },
  { f: 0.84, c: '#6f3a1b' },
  { f: 0.62, c: '#a25f30' },
  { f: 0.4, c: '#d1904f' },
  { f: 0.2, c: '#efc487' },
  { f: 0.07, c: '#f9e2bd' },
];

function toPoints(path: Path): number[] {
  return samplePath(path, 1.2).flatMap((p) => [p.x, p.y]);
}

/** Memoized: a run/kit whose path is unchanged skips both re-sampling and reconcile
 *  (identity-stable path from the geometry cache), which keeps drags under budget. */
export const CopperTube = memo(function CopperTube({ path, widthMm }: { path: Path; widthMm: number }): JSX.Element | null {
  const pts = useMemo(() => toPoints(path), [path]);
  if (pts.length < 4) return null;
  return (
    <Fragment>
      {COPPER_BANDS.map((b, i) => (
        <Line
          key={i}
          points={pts}
          stroke={b.c}
          strokeWidth={Math.max(0.2, widthMm * b.f)}
          lineCap="round"
          lineJoin="round"
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}
    </Fragment>
  );
});

export function PairedRunShape({
  geometry,
  gasWidthMm,
  liquidWidthMm,
  filter,
  preview = false,
}: {
  geometry: PairedGeometry;
  gasWidthMm: number;
  liquidWidthMm: number;
  filter: LineFilter;
  preview?: boolean;
}): JSX.Element {
  const showGas = filter !== 'liquid';
  const showLiquid = filter !== 'gas';
  return (
    <Fragment>
      {showGas ? <CopperTube path={geometry.gas} widthMm={gasWidthMm} /> : null}
      {showLiquid ? <CopperTube path={geometry.liquid} widthMm={liquidWidthMm} /> : null}
      {preview ? (
        // Faint centre guide while drawing.
        <Line
          points={samplePath(geometry.center, 2).flatMap((p) => [p.x, p.y])}
          stroke="#2f9e68"
          strokeWidth={Math.max(0.4, gasWidthMm * 0.06)}
          dash={[6, 5]}
          lineCap="round"
          listening={false}
        />
      ) : null}
    </Fragment>
  );
}

/** A committed run — geometry memoized on (spine, gap, bendRadius). */
export function RunShape({
  run,
  gapMm,
  filter,
}: {
  run: PipeRun;
  gapMm: number;
  filter: LineFilter;
}): JSX.Element {
  const geometry = useMemo(
    () => buildPairedGeometry(run.spine, gapMm, run.bendRadiusMm),
    [run.spine, gapMm, run.bendRadiusMm],
  );
  return (
    <PairedRunShape
      geometry={geometry}
      gasWidthMm={run.size.gasOuterMm}
      liquidWidthMm={run.size.liquidOuterMm}
      filter={filter}
    />
  );
}
