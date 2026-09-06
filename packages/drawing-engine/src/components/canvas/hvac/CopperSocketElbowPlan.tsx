import type { Point2D } from '../../../types';

import { copperSocketCoverOutline, copperSocketCupOutline } from './copperSocketElbowPlanGeometry';
import type { CopperSocketElbowPlacement } from './copperSocketElbowRoute';
import { pipePolylinePath } from './pipePlanPresentation';

const shifted = (point: Point2D, direction: Point2D, distance: number): Point2D =>
  ({ x: point.x + direction.x * distance, y: point.y + direction.y * distance });
const polygon = (points: Point2D[]) => `${pipePolylinePath(points)} Z`;

/** Actual-size CxC symbols share the resolved faces and insertion depths with
 * the 3D solid. This is an inspection view, not an instruction to omit covers. */
export function CopperSocketElbowPlan({ fitting, insulated, insulationThicknessMm, insulationColor }: {
  fitting: CopperSocketElbowPlacement;
  insulated: boolean;
  insulationThicknessMm: number;
  insulationColor: string;
}) {
  const { spec } = fitting;
  const cupRadius = spec.socketOutsideDiameterMm / 2;
  const title = `${spec.angleDeg}° C×C copper elbow · ${spec.tubeOutsideDiameterMm} mm OD · ${spec.dimensionBasis === 'planning' ? 'Planning dimensions' : 'Catalogue dimensions; parametric body'} · insertion ${spec.insertionDepthMm} mm`;
  if (insulated) return <path d={polygon(copperSocketCoverOutline(fitting, cupRadius + insulationThicknessMm))} fill={insulationColor}
    data-copper-socket-elbow={spec.angleDeg} data-fitting-cover="conservative-envelope"><title>{title}</title></path>;
  return <g data-copper-socket-elbow={spec.angleDeg} data-fitting-profile={spec.id}>
    <title>{title}</title>
    <path d={pipePolylinePath(fitting.path)} fill="none" stroke="#b97143" strokeWidth={spec.bodyOutsideDiameterMm} strokeLinecap="butt" strokeLinejoin="round" />
    {[[fitting.startFace, fitting.startStop, fitting.startDirection], [fitting.endFace, fitting.endStop, fitting.endDirection]]
      .map(([face, stop, direction], index) => <g key={index}>
        <path d={polygon(copperSocketCupOutline(face!, stop!, direction!, cupRadius))} fill="#cb8a60" stroke="#965931" strokeWidth={0.4} />
        <path d={pipePolylinePath([shifted(face!, { x: -direction!.y, y: direction!.x }, cupRadius),
          shifted(face!, { x: -direction!.y, y: direction!.x }, -cupRadius)])}
          fill="none" stroke="#784026" strokeWidth={Math.max(0.4, spec.wallThicknessMm * 0.7)} />
      </g>)}
    <path d={pipePolylinePath(fitting.path)} fill="none" stroke="#f3c6a0" strokeWidth={Math.max(0.7, spec.bodyOutsideDiameterMm * 0.18)} strokeOpacity={0.75} />
  </g>;
}
