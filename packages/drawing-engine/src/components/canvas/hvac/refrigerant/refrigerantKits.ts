/**
 * A refrigerant branch kit as its segment card shows it: its model, the lines
 * it splits, its three ports per line (inlet, run outlet, branch outlet) where
 * the plan draws them, its roll, and its outline in plan (a rounded hull round
 * its ports and centre) — the same port points the plan overlay draws the kit
 * through, so the outline sits on the drawn fitting.
 *
 * PURE: elements in, kits out.
 */
import type { HvacElement, Point2D } from '../../../../types';
import {
  buildRefrigerantBranchKitViewModel,
  isRefrigerantBranchKitType,
  resolveRefrigerantBranchKitConnectionIdentity,
} from '../refrigerantBranchKitModel';

/** A branch kit's segment card is the kit's own: its run is the kit element, its key this. */
export const KIT_KEY = 'kit';

export interface RefrigerantKitLinePorts {
  line: 'gas' | 'liquid';
  inlet: Point2D;
  run: Point2D;
  branch: Point2D;
}

export interface RefrigerantKit {
  elementId: string;
  /** The model as drawn and scheduled (e.g. DIS-22-1G). */
  model: string;
  lines: Array<'gas' | 'liquid'>;
  ports: RefrigerantKitLinePorts[];
  centre: Point2D;
  /** Its centre's height (mm). */
  levelMm: number;
  /** Its roll about its inlet axis (deg; 0 for a level split). */
  rollDeg: number;
  /** In plan, round its ports and centre (mm). */
  outline: Point2D[];
}

/** How far the outline stands round each port: a kit's insulated tube and a little air (mm). */
const OUTLINE_REACH_MM = 34;

/** The convex hull of points (monotone chain), counter-clockwise. */
function hull(points: readonly Point2D[]): Point2D[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point2D, a: Point2D, b: Point2D) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point2D[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point2D[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const KIT_CACHE = new WeakMap<HvacElement, RefrigerantKit | null>();

/** A branch kit's ports and outline (null for anything else). */
export function refrigerantKitOf(element: HvacElement): RefrigerantKit | null {
  if (KIT_CACHE.has(element)) return KIT_CACHE.get(element)!;
  const kit = buildKit(element);
  KIT_CACHE.set(element, kit);
  return kit;
}

function buildKit(element: HvacElement): RefrigerantKit | null {
  if (!isRefrigerantBranchKitType(element.type)) return null;
  const raw = element.properties.branchKitLineKind;
  const kind = raw === 'gas' ? 'gas' : raw === 'liquid' ? 'liquid' : 'both';
  const model = buildRefrigerantBranchKitViewModel(element);
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const rotationDeg = element.rotation ?? 0;
  const identity = (role: 'inlet' | 'run-outlet' | 'branch-outlet') =>
    resolveRefrigerantBranchKitConnectionIdentity({ model, role, lineSelection: kind, worldCenter: centre, rotationDeg });
  const inlet = identity('inlet');
  const run = identity('run-outlet');
  const branch = identity('branch-outlet');
  if (!inlet || !run || !branch) return null;
  const lines: Array<'gas' | 'liquid'> = kind === 'both' ? ['gas', 'liquid'] : [kind];
  const ports = lines.map((line) => ({
    line,
    inlet: { ...(line === 'gas' ? inlet.gasPoint : inlet.liquidPoint) },
    run: { ...(line === 'gas' ? run.gasPoint : run.liquidPoint) },
    branch: { ...(line === 'gas' ? branch.gasPoint : branch.liquidPoint) },
  }));
  const samples: Point2D[] = [];
  for (const point of [centre, ...ports.flatMap((port) => [port.inlet, port.run, port.branch])]) {
    for (let index = 0; index < 16; index += 1) {
      const angle = (index / 16) * Math.PI * 2;
      samples.push({ x: point.x + Math.cos(angle) * OUTLINE_REACH_MM, y: point.y + Math.sin(angle) * OUTLINE_REACH_MM });
    }
  }
  const label = [element.modelLabel, element.properties.model, element.properties.modelCode, element.subtype]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const roll = element.properties.branchKitRollDeg;
  return {
    elementId: element.id,
    // Catalogue model codes read in capitals (dis-22-1g → DIS-22-1G).
    model: label ? (/^dis-[\w-]+$/i.test(label) ? label.toUpperCase() : label) : 'Y-joint',
    lines,
    ports,
    centre,
    levelMm: element.elevation + element.height / 2,
    rollDeg: typeof roll === 'number' && Number.isFinite(roll) ? roll : 0,
    outline: hull(samples),
  };
}
