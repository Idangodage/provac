/**
 * The Auto route benchmark set: the user's building (as drawn and put right)
 * and synthetic buildings laid out like its rooms, grown in indoor units and
 * terminals. The golden-master test (autoRouteCorpus.golden.test.ts) holds
 * every speed-up to the same answers on these; the benchmark
 * (autoRouteCorpus.bench.test.ts) times them.
 *
 * A synthetic building: each ducted unit (FDUM140) in its own walled bay laid
 * out like the user's FDUM140 rooms (the unit 3.5 m from a row of supply
 * diffusers and a row of return grilles, terminals 2.5 m apart), then a wing
 * of FDT28 cassettes 4 m apart in two rows; the FDC280 outside the far wall
 * and a floor gully in the wing's corner. Closer terminals leave no room for
 * their take-offs (the units would stay as they are, which tests less).
 */
import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Point2D } from '../../../../types';
import { runAutoRoute } from '../autoRouteController';
import { useCondensatePreviewStore } from '../condensate/condensatePreviewStore';
import { terminalCeilingPlane } from '../duct/ductTerminals';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';
import type { AutoRouteServices, UnifiedAutoRouteResult } from '../unifiedAutoRoute';

import { drawUsersBuilding } from './usersBuilding';

export interface SyntheticBuildingSpec {
  /** Ducted units, one per bay. */
  ducted: number;
  /** Supply diffusers per ducted unit (as many return grilles). */
  terminals: number;
  /** Cassettes in the wing. */
  cassettes: number;
}

let serial = 0;
/** An element as placement makes it from a library entry, centred at `centre`. */
function place(definitionId: string, centre: Point2D, properties: Record<string, unknown> = {}): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  serial += 1;
  return {
    id: `${definitionId}-${serial}`, type: def.type, category: def.equipmentCategory, subtype: def.subtype, modelLabel: def.modelLabel,
    position: { x: centre.x - def.widthMm / 2, y: centre.y - def.depthMm / 2 }, rotation: 0,
    width: def.widthMm, depth: def.depthMm, height: def.heightMm, elevation: def.elevationMm, mountType: def.mountType,
    label: def.name, supplyZoneRatio: def.supplyZoneRatio ?? 0.5,
    properties: { definitionId: def.id, ...(def.defaultProperties ?? {}), ...properties },
  } as HvacElement;
}

/** The FDUM140 room of the user's building: 9.34 m deep, the unit 3.5 m from each terminal row. */
const BAY_DEPTH_MM = 9344;
const UNIT_Y_MM = 4694;
const SUPPLY_ROW_Y_MM = 1205;
const RETURN_ROW_Y_MM = 8205;
const TERMINAL_PITCH_MM = 2500;
const CASSETTE_PITCH_MM = 4000;

/** Draws a synthetic building into the store: walls, one room per bay and the wing, units and terminals. */
export function drawSyntheticBuilding(spec: SyntheticBuildingSpec): void {
  serial = 0;
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  const store = useSmartDrawingStore;
  store.setState({ hvacElements: [], walls: [], rooms: [], pipeRoutingSettings: { ...DEFAULT_PIPE_ROUTING_SETTINGS } } as never);
  useCondensatePreviewStore.getState().clear();
  const bayWidth = Math.max(8040, 3000 + TERMINAL_PITCH_MM * (spec.terminals - 1));
  const wingWidth = spec.cassettes ? Math.ceil(spec.cassettes / 2) * CASSETTE_PITCH_MM + 2000 : 0;
  const width = spec.ducted * bayWidth + wingWidth;
  const wall = (a: Point2D, b: Point2D, thickness: number) =>
    store.getState().addWall({ startPoint: a, endPoint: b, thickness } as never, { skipHistory: true, skipRoomDetection: true });
  const corners: Point2D[] = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: BAY_DEPTH_MM }, { x: 0, y: BAY_DEPTH_MM }];
  corners.forEach((corner, index) => wall(corner, corners[(index + 1) % 4]!, 200));
  const rooms: Array<{ name: string; minX: number; maxX: number }> = [];
  for (let k = 0; k < spec.ducted; k += 1) {
    if (k > 0) wall({ x: k * bayWidth, y: 0 }, { x: k * bayWidth, y: BAY_DEPTH_MM }, 150);
    rooms.push({ name: `Bay ${k + 1}`, minX: k * bayWidth, maxX: (k + 1) * bayWidth });
  }
  if (spec.cassettes) {
    if (spec.ducted) wall({ x: spec.ducted * bayWidth, y: 0 }, { x: spec.ducted * bayWidth, y: BAY_DEPTH_MM }, 150);
    rooms.push({ name: 'Wing', minX: spec.ducted * bayWidth, maxX: width });
  }
  for (const room of rooms) {
    store.getState().addRoom({ name: room.name, wallIds: [], vertices: [
      { x: room.minX + 90, y: 90 }, { x: room.maxX - 90, y: 90 }, { x: room.maxX - 90, y: BAY_DEPTH_MM - 90 }, { x: room.minX + 90, y: BAY_DEPTH_MM - 90 },
    ] } as never);
  }
  const units: HvacElement[] = [];
  const terminals: HvacElement[] = [];
  for (let k = 0; k < spec.ducted; k += 1) {
    const xs = Array.from({ length: spec.terminals }, (_, index) => k * bayWidth + 1500 + TERMINAL_PITCH_MM * index);
    // Like the user's room: the unit just off the middle terminal.
    units.push(place('vrf-fdum140kxe6f', { x: (xs[0]! + xs.at(-1)!) / 2 + 85, y: UNIT_Y_MM }, { airSystemTag: `DU-${k + 1}` }));
    for (const x of xs) terminals.push(place('terminal-square-595-300', { x, y: SUPPLY_ROW_Y_MM }));
    for (const x of xs) terminals.push(place('terminal-return-eggcrate-595-300', { x, y: RETURN_ROW_Y_MM }));
  }
  for (let n = 0; n < spec.cassettes; n += 1) {
    const column = Math.floor(n / 2);
    units.push(place('vrf-fdt28kxze1', { x: spec.ducted * bayWidth + 2500 + column * CASSETTE_PITCH_MM, y: n % 2 ? BAY_DEPTH_MM - 2500 : 2500 }));
  }
  units.push(place('vrf-fdc280kxze1', { x: width + 1500, y: BAY_DEPTH_MM / 2 }));
  units.push(place('condensate-floor-gully', { x: width - 600, y: BAY_DEPTH_MM - 600 }));
  const plane = terminalCeilingPlane(units);
  const labelled = terminals.map((terminal, index) => ({ ...terminal, elevation: plane, label: `${terminal.type === 'return-grille' ? 'RAG' : 'SAD'}-${index + 1}` }));
  const roomList = store.getState().rooms;
  const roomOf = (element: HvacElement) => {
    const x = element.position.x + element.width / 2;
    return roomList.find((room) => x >= room.vertices[0]!.x && x <= room.vertices[1]!.x)?.id;
  };
  store.getState().commitHvacElementCommand('Place', { add: [...units, ...labelled].map((element) => {
    const roomId = roomOf(element);
    return roomId ? { ...element, roomId } : element;
  }) });
}

export interface AutoRouteCorpusCase {
  name: string;
  /** What the case exercises, for the benchmark table. */
  description: string;
  draw: () => void;
  services: AutoRouteServices;
  /** The benchmark fails a run slower than this (ms; 1.6 times what it took under Vitest on the laptop it was tuned on, on its charger). */
  budgetMs?: number;
}

const EVERYTHING: AutoRouteServices = { gas: true, liquid: true, condensate: true, supplyDuct: true, returnDuct: true };
const PIPES: AutoRouteServices = { gas: true, liquid: true, condensate: true, supplyDuct: false, returnDuct: false };
const DUCTS: AutoRouteServices = { gas: false, liquid: false, condensate: false, supplyDuct: true, returnDuct: true };

const synthetic = (name: string, spec: SyntheticBuildingSpec, services: AutoRouteServices, description: string, budgetMs: number): AutoRouteCorpusCase =>
  ({ name, description, services, budgetMs, draw: () => drawSyntheticBuilding(spec) });

/** Every case, smallest first within each kind. */
export const AUTO_ROUTE_CORPUS: readonly AutoRouteCorpusCase[] = [
  { name: 'building-put-right', description: "The user's building put right: FDU224 (6 + 5), two FDUM140 (3 + 3), four cassettes", services: EVERYTHING,
    budgetMs: 115_000, draw: () => drawUsersBuilding('put-right') },
  { name: 'building-as-drawn', description: "The user's building as drawn: a unit turned away, too few terminals, a drain that cannot fall", services: EVERYTHING,
    budgetMs: 180_000, draw: () => drawUsersBuilding('as-drawn') },
  synthetic('cassettes-4', { ducted: 0, terminals: 0, cassettes: 4 }, PIPES, 'Four cassettes: refrigerant and drains', 25_000),
  synthetic('cassettes-6', { ducted: 0, terminals: 0, cassettes: 6 }, PIPES, 'Six cassettes: refrigerant and drains', 130_000),
  synthetic('ducted-1x5', { ducted: 1, terminals: 5, cassettes: 0 }, DUCTS, 'One FDUM140, 5 + 5 terminals: ducts', 15_000),
  synthetic('ducted-3x3', { ducted: 3, terminals: 3, cassettes: 0 }, DUCTS, 'Three FDUM140, 3 + 3 terminals each: ducts', 45_000),
  // Past the exact limit: the terminals are routed in groups.
  synthetic('ducted-1x11', { ducted: 1, terminals: 11, cassettes: 0 }, DUCTS, 'One FDUM140, 11 + 11 terminals: ducts, routed in groups', 50_000),
  synthetic('mixed-2x3-c4', { ducted: 2, terminals: 3, cassettes: 4 }, EVERYTHING, 'Two FDUM140 (3 + 3) and four cassettes: everything', 65_000),
  synthetic('mixed-3x3-c6', { ducted: 3, terminals: 3, cassettes: 6 }, EVERYTHING, 'Three FDUM140 (3 + 3) and six cassettes: everything', 190_000),
];

/**
 * Draws the case and runs Auto route on it as the toolbar does (all units in
 * the drawing, the panel's defaults); resolves with the preview, or rejects
 * with the message Auto route showed instead.
 */
export async function runCorpusCase(entry: AutoRouteCorpusCase): Promise<UnifiedAutoRouteResult> {
  entry.draw();
  runAutoRoute({ services: entry.services, scope: 'drawing', profile: undefined, duct: { shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false } });
  for (;;) {
    const preview = useCondensatePreviewStore.getState();
    if (preview.unified) return preview.unified;
    if (preview.message) throw new Error(`${entry.name}: ${preview.message}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The cases named in a comma-separated list (all when empty). */
export function selectCorpusCases(names: string | undefined): AutoRouteCorpusCase[] {
  const wanted = (names ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (!wanted.length) return [...AUTO_ROUTE_CORPUS];
  const unknown = wanted.filter((name) => !AUTO_ROUTE_CORPUS.some((entry) => entry.name === name));
  if (unknown.length) throw new Error(`Unknown Auto route corpus case(s): ${unknown.join(', ')}`);
  return AUTO_ROUTE_CORPUS.filter((entry) => wanted.includes(entry.name));
}
