/**
 * The user's building (screenshots of 23 October 2026), drawn into the store
 * for tests: an FDU224KXZE1 in the top hall, FDUM140KXE6Fs bottom left and in
 * the middle room, four FDT28KXZE1 cassettes in the east wing, an FDC280KXZE1
 * outside and one floor gully. Walls, rooms and every position were measured
 * off the plan (43.457 mm per pixel).
 *
 * "as-drawn" is the screenshot: the FDU224 turned away from its terminals, too
 * few terminals, no drain pump on the FDU224. "put-right" is the same building
 * after the fixes Auto route offers: the FDU224 turned 180°, six + five Ø300
 * terminals on it and three + three on each FDUM140, its drain pump fitted.
 */
import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Point2D } from '../../../../types';
import { useCondensatePreviewStore } from '../condensate/condensatePreviewStore';
import { terminalCeilingPlane } from '../duct/ductTerminals';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

const MM_PER_PIXEL = 17600 / 405;
/** A point measured on the screenshot (pixels), in model millimetres. */
const P = (px: number, py: number): Point2D => ({ x: (px - 158) * MM_PER_PIXEL, y: (py - 38) * MM_PER_PIXEL });
const M = (xm: number, ym: number): Point2D => ({ x: xm * 1000, y: ym * 1000 });

let serial = 0;
/** An element as placement makes it from a library entry, centred at `centre`. */
function place(definitionId: string, centre: Point2D, extra: Partial<HvacElement> = {}, properties: Record<string, unknown> = {}): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  serial += 1;
  return {
    id: `${definitionId}-${serial}`, type: def.type, category: def.equipmentCategory, subtype: def.subtype, modelLabel: def.modelLabel,
    position: { x: centre.x - def.widthMm / 2, y: centre.y - def.depthMm / 2 }, rotation: 0,
    width: def.widthMm, depth: def.depthMm, height: def.heightMm, elevation: def.elevationMm, mountType: def.mountType,
    label: def.name, supplyZoneRatio: def.supplyZoneRatio ?? 0.5,
    properties: { definitionId: def.id, ...(def.defaultProperties ?? {}), ...properties },
    ...extra,
  } as HvacElement;
}

export const USERS_BUILDING_IDS = {
  fdu224: 'vrf-fdu224kxze1-1', bottomLeft: 'vrf-fdum140kxe6f-2', middle: 'vrf-fdum140kxe6f-3',
  cassetteNe: 'vrf-fdt28kxze1-5', outdoor: 'vrf-fdc280kxze1-8',
} as const;

/** Draws the building into the store: walls, rooms, units and terminals. */
export function drawUsersBuilding(variant: 'as-drawn' | 'put-right'): void {
  serial = 0;
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  const store = useSmartDrawingStore;
  store.setState({ hvacElements: [], walls: [], rooms: [], pipeRoutingSettings: { ...DEFAULT_PIPE_ROUTING_SETTINGS } } as never);
  useCondensatePreviewStore.getState().clear();
  const X = 561.5;
  const walls: Array<[number, number, number, number, number]> = [
    [158, 38, X, 38, 200], [X, 38, X, 190, 200], [X, 190, 877, 190, 200], [877, 190, 877, 400, 200], [877, 400, 685, 400, 200],
    [685, 400, 685, 460, 200], [685, 460, 158, 460, 200], [158, 460, 158, 38, 200],
    [158, 245, X, 245, 150], [343, 245, 343, 460, 150], [X, 190, X, 460, 150], [718, 190, 718, 313, 150], [X, 313, 877, 313, 150],
  ];
  for (const [ax, ay, bx, by, thickness] of walls) {
    store.getState().addWall({ startPoint: P(ax, ay), endPoint: P(bx, by), thickness } as never, { skipHistory: true, skipRoomDetection: true });
  }
  const inset = (points: Point2D[]): Point2D[] => {
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    return points.map((p) => ({ x: p.x + Math.sign(cx - p.x) * 90, y: p.y + Math.sign(cy - p.y) * 90 }));
  };
  const rooms: Array<[string, Array<[number, number]>]> = [
    ['Top hall', [[158, 38], [X, 38], [X, 245], [158, 245]]],
    ['Bottom left', [[158, 245], [343, 245], [343, 460], [158, 460]]],
    ['Middle', [[343, 245], [X, 245], [X, 460], [343, 460]]],
    ['Wing NW', [[X, 190], [718, 190], [718, 313], [X, 313]]],
    ['Wing NE', [[718, 190], [877, 190], [877, 313], [718, 313]]],
    ['Wing S', [[X, 313], [877, 313], [877, 400], [685, 400], [685, 460], [X, 460]]],
  ];
  for (const [name, vertices] of rooms) {
    const points = vertices.map(([x, y]) => P(x, y));
    store.getState().addRoom({ vertices: name === 'Wing S' ? points : inset(points), wallIds: [], name } as never);
  }
  const putRight = variant === 'put-right';
  const units = [
    place('vrf-fdu224kxze1', P(370, 147), putRight ? { rotation: 180 } : {}, { airSystemTag: 'DU-1', ...(putRight ? { hasDrainPump: true } : {}) }),
    place('vrf-fdum140kxe6f', P(252, 353), {}, { airSystemTag: 'DU-2' }),
    place('vrf-fdum140kxe6f', P(455, 355), {}, { airSystemTag: 'DU-3' }),
    place('vrf-fdt28kxze1', P(640, 250)), place('vrf-fdt28kxze1', P(812, 245)),
    place('vrf-fdt28kxze1', P(633, 368)), place('vrf-fdt28kxze1', P(812, 348)),
    place('vrf-fdc280kxze1', P(770, 425)),
    place('condensate-floor-gully', P(702, 387)),
  ];
  const diffuser = 'terminal-square-595-250'; const grille = 'terminal-return-eggcrate-595-250';
  const big = 'terminal-square-595-300'; const bigGrille = 'terminal-return-eggcrate-595-300';
  const terminals = putRight ? [
    ...[1.5, 4.5, 7.5, 10.5, 13.5, 16.5].map((x) => place(big, M(x, 1.4))),
    ...[2, 5.5, 9, 12.5, 16].map((x) => place(bigGrille, M(x, 7.8))),
    ...[1.5, 4, 6.5].map((x) => place(big, M(x, 10.2))), ...[1.5, 4, 6.5].map((x) => place(bigGrille, M(x, 17.2))),
    ...[9.5, 12.9, 16.3].map((x) => place(big, M(x, 10.2))), ...[9.5, 12.9, 16.3].map((x) => place(bigGrille, M(x, 17.2))),
  ] : [
    place(diffuser, P(208, 68)), place(diffuser, P(512, 72)), place(grille, P(225, 213)), place(grille, P(522, 213)),
    place(diffuser, P(250, 270)), place(grille, P(250, 432)),
    place(diffuser, P(385, 270)), place(diffuser, P(528, 275)), place(grille, P(383, 420)), place(grille, P(535, 420)),
  ];
  const plane = terminalCeilingPlane(units);
  const labelled = terminals.map((terminal, index) => ({ ...terminal, elevation: plane, label: `${terminal.type === 'return-grille' ? 'RAG' : 'SAD'}-${index + 1}` }));
  const roomList = store.getState().rooms;
  const roomOf = (point: Point2D) => roomList.find((room) => {
    let inside = false;
    const v = room.vertices;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      if ((v[i]!.y > point.y) !== (v[j]!.y > point.y) && point.x < ((v[j]!.x - v[i]!.x) * (point.y - v[i]!.y)) / (v[j]!.y - v[i]!.y) + v[i]!.x) inside = !inside;
    }
    return inside;
  })?.id;
  const all = [...units, ...labelled].map((element) => {
    const room = roomOf({ x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 });
    return room ? { ...element, roomId: room } : element;
  });
  store.getState().commitHvacElementCommand('Place', { add: all });
}
