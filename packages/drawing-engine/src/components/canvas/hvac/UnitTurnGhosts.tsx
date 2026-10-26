'use client';

/**
 * An Auto route preview's turned cassettes on the plan: each one's footprint
 * as it will be (dashed), where its pipes will leave it, a turn arrow, and
 * what the turn saves. Drawn in the drawing's own frame (inside an overlay
 * group that carries the view transform).
 */
import React from 'react';

import type { HvacElement, Point2D } from '../../../types';

import { Tag, pathData } from './condensate/condensatePlanGlyphs';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';
import { unitTurnText, type UnitTurn } from './unitOrientation';

const COLOR = '#0d9488';

function footprint(element: HvacElement): Point2D[] {
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const radians = ((element.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx! * element.width) / 2;
    const y = (sy! * element.depth) / 2;
    return { x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos };
  });
}

export function UnitTurnGhosts({ turns, units, hpx }: { turns: readonly UnitTurn[]; units: readonly HvacElement[]; hpx: (n: number) => number }) {
  if (!turns.length) return null;
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return (
    <g data-testid="unit-turn-ghosts" style={{ pointerEvents: 'none' }}>
      {turns.map((turn) => {
        const unit = byId.get(turn.unitId);
        if (!unit) return null;
        const corners = footprint(unit);
        const centre = { x: unit.position.x + unit.width / 2, y: unit.position.y + unit.depth / 2 };
        const radius = Math.min(unit.width, unit.depth) * 0.28;
        // A clockwise arc of the turn's sense (a three-quarter turn reads as a quarter the other way).
        const sweep = turn.angleDeg === 270 ? -1 : 1;
        const start = { x: centre.x + radius, y: centre.y };
        const endAngle = (sweep * Math.min(turn.angleDeg === 180 ? 180 : 90, 160) * Math.PI) / 180;
        const end = { x: centre.x + radius * Math.cos(endAngle), y: centre.y + radius * Math.sin(endAngle) };
        const bundle = getRefrigerantPipeBundleSnapTargets([unit]).find((target) => target.connectionKind === 'unit-port');
        return (
          <g key={turn.unitId} data-testid="unit-turn-ghost" data-unit={turn.unitId} data-angle={turn.angleDeg}>
            <path d={`${pathData(corners)} Z`} fill="rgba(13,148,136,0.06)" stroke={COLOR} strokeWidth={hpx(2)} strokeDasharray={`${hpx(7)} ${hpx(4)}`} />
            <path d={`M ${start.x} ${start.y} A ${radius} ${radius} 0 0 ${sweep > 0 ? 1 : 0} ${end.x} ${end.y}`} fill="none" stroke={COLOR} strokeWidth={hpx(2.2)} strokeLinecap="round" />
            <circle cx={end.x} cy={end.y} r={hpx(3.5)} fill={COLOR} />
            {bundle ? (
              <path d={pathData([bundle.point, { x: bundle.point.x + bundle.direction.x * hpx(26), y: bundle.point.y + bundle.direction.y * hpx(26) }])}
                stroke={COLOR} strokeWidth={hpx(3)} strokeLinecap="round" />
            ) : null}
            <Tag x={centre.x - unit.width / 2} y={centre.y - unit.depth / 2 - hpx(10)} text={unitTurnText(turn)} hpx={hpx} tone="ok" />
          </g>
        );
      })}
    </g>
  );
}

export default UnitTurnGhosts;
