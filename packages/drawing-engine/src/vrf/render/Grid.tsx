'use client';

/**
 * Grid + rulers, in mm. Lines are computed at SCREEN positions from the world
 * grid via the single view transform, so they stay crisp (1 device-independent
 * px) at any zoom while the ruler labels read true world millimetres.
 */

import { Fragment } from 'react';
import { Layer, Line, Rect, Text } from 'react-konva';

import {
  visibleWorldBounds,
  worldToScreen,
  type ViewTransform,
} from '../geometry/transform';

const RULER_PX = 22;
const COLORS = {
  bg: '#fbfbfa',
  minor: '#ececea',
  major: '#dcdbd7',
  axis: '#b7b6b0',
  rulerBg: '#f4f3f0',
  rulerLine: '#d8d7d2',
  tick: '#a9a8a2',
  text: '#78766f',
};

/** A "nice" grid step (mm) so a cell is ~targetPx on screen: 1/2/5 × 10^k. */
function niceStepMm(zoom: number, targetPx = 68): number {
  const raw = targetPx / zoom;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const mult = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return mult * pow;
}

function formatMm(mm: number): string {
  const abs = Math.abs(mm);
  if (abs >= 1000) return `${(mm / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}m`;
  return `${Math.round(mm)}`;
}

interface GridProps {
  view: ViewTransform;
  width: number;
  height: number;
}

export function Grid({ view, width, height }: GridProps): JSX.Element {
  const step = niceStepMm(view.zoom);
  const major = step * 5;
  const bounds = visibleWorldBounds(view, width, height);

  const startX = Math.floor(bounds.minX / step) * step;
  const startY = Math.floor(bounds.minY / step) * step;

  const vLines: JSX.Element[] = [];
  const vTicks: JSX.Element[] = [];
  for (let wx = startX; wx <= bounds.maxX; wx += step) {
    const sx = Math.round(worldToScreen(view, { x: wx, y: 0 }).x) + 0.5;
    const isMajor = Math.abs(wx % major) < step / 2;
    const isAxis = Math.abs(wx) < step / 2;
    vLines.push(
      <Line
        key={`v${wx}`}
        points={[sx, RULER_PX, sx, height]}
        stroke={isAxis ? COLORS.axis : isMajor ? COLORS.major : COLORS.minor}
        strokeWidth={1}
        listening={false}
      />,
    );
    if (isMajor) {
      vTicks.push(
        <Fragment key={`vt${wx}`}>
          <Line points={[sx, RULER_PX - 5, sx, RULER_PX]} stroke={COLORS.tick} strokeWidth={1} listening={false} />
          <Text x={sx + 2} y={4} text={formatMm(wx)} fontSize={10} fill={COLORS.text} listening={false} />
        </Fragment>,
      );
    }
  }

  const hLines: JSX.Element[] = [];
  const hTicks: JSX.Element[] = [];
  for (let wy = startY; wy <= bounds.maxY; wy += step) {
    const sy = Math.round(worldToScreen(view, { x: 0, y: wy }).y) + 0.5;
    const isMajor = Math.abs(wy % major) < step / 2;
    const isAxis = Math.abs(wy) < step / 2;
    hLines.push(
      <Line
        key={`h${wy}`}
        points={[RULER_PX, sy, width, sy]}
        stroke={isAxis ? COLORS.axis : isMajor ? COLORS.major : COLORS.minor}
        strokeWidth={1}
        listening={false}
      />,
    );
    if (isMajor) {
      hTicks.push(
        <Fragment key={`ht${wy}`}>
          <Line points={[RULER_PX - 5, sy, RULER_PX, sy]} stroke={COLORS.tick} strokeWidth={1} listening={false} />
          <Text x={2} y={sy + 2} text={formatMm(wy)} fontSize={10} fill={COLORS.text} listening={false} />
        </Fragment>,
      );
    }
  }

  return (
    <Layer listening={false}>
      <Rect x={0} y={0} width={width} height={height} fill={COLORS.bg} />
      {vLines}
      {hLines}
      {/* Ruler chrome on top of the grid. */}
      <Rect x={0} y={0} width={width} height={RULER_PX} fill={COLORS.rulerBg} />
      <Rect x={0} y={0} width={RULER_PX} height={height} fill={COLORS.rulerBg} />
      <Line points={[0, RULER_PX + 0.5, width, RULER_PX + 0.5]} stroke={COLORS.rulerLine} strokeWidth={1} listening={false} />
      <Line points={[RULER_PX + 0.5, 0, RULER_PX + 0.5, height]} stroke={COLORS.rulerLine} strokeWidth={1} listening={false} />
      <Rect x={0} y={0} width={RULER_PX} height={RULER_PX} fill={COLORS.rulerBg} />
      {vTicks}
      {hTicks}
      <Text x={4} y={RULER_PX + 3} text="mm" fontSize={9} fill={COLORS.text} listening={false} />
    </Layer>
  );
}

export { RULER_PX, niceStepMm };
