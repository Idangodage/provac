/**
 * Duct tool: draw a supply or return run from a ducted unit's real collar, or
 * a branch off an existing run.
 *
 *  - Hover shows the units' collars and, over a run, where a branch would
 *    start: a take-off on the side wall of a straight section, or one outlet
 *    of a split at the run's end. Click to start there. The first leg leaves
 *    along the collar's normal, square to the parent wall, or along the split
 *    outlet. A run's open end continues that run; an orphaned open start
 *    re-attaches to the run wall behind it; empty space starts a free run,
 *    which becomes a take-off if it is finished on a run's side.
 *  - Each click adds a leg end; legs go straight on or turn 90° (Tab toggles
 *    45° mode). Lengths snap to 10 mm. Each leg keeps the size chosen in the
 *    tool panel when it was clicked, so a size change mid-draw becomes a
 *    transition.
 *  - Level: the tool panel's Level (clear bottom) or [ / ] (±50 mm) sets the
 *    next leg's level; the leg then rises or drops at the point it starts
 *    from (never at a collar or parent wall: the first leg leaves level) and
 *    goes straight on, since a riser only bends the easy way. Finishing with a
 *    level change pending ends the run in that riser or drop.
 *  - A diffuser's or grille's spigot (of the run's service) highlights under
 *    the cursor; clicking it finishes the run there, in a flexible runout from
 *    the last clicked point (the default, SMACNA Fig. 2-15) or in rigid duct
 *    (the tool panel's Terminal connection). A branch that is all runout keeps
 *    its collar and damper as a rigid stub.
 *  - Double-click or Enter finishes (end cap by default); Backspace removes the
 *    last leg; Esc cancels the draft (a second Esc leaves the tool).
 *
 * The live preview is built by the same draft builder as the commit and pushed
 * to the duct overlay imperatively — no store writes and no React renders per
 * pointer move. The commit is ONE `commitHvacElementCommand` (the branch plus,
 * for a split, its parent's new end), so one undo.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { HvacElementCommand } from "../../../store";
import type { HvacElement, Point2D } from "../../../types";
import type { DuctOverlayHandle } from "../hvac/duct/DuctOverlay";
import { listAirPorts, type DuctAirPort } from "../hvac/duct/ductAirPorts";
import { clampBranchSection, findBranchTarget, findReattachTarget, spigotOrigin, splitOrigin, tapOrigin, type DuctBranchTarget } from "../hvac/duct/ductBranchTargets";
import {
  buildDuctRunDraft,
  constrainDuctLeg,
  continueDuctRunSpec,
  ductRunDraftCommand,
  originDirection,
  originPoint,
  reverseDuctRunSpec,
  type DuctDraftEnd,
  type DuctDraftInput,
  type DuctDraftOrigin,
  type DuctDraftPoint,
  type DuctRunDraft,
} from "../hvac/duct/ductDraft";
import { defaultPlenumSize } from "../hvac/duct/ductPlenum";
import { commitDuctRunSpec, reattachDuctRun } from "../hvac/duct/ductEditController";
import { planDuctRunSpec } from "../hvac/duct/ductFabricationPlanner";
import { ductRunElementWithSpec } from "../hvac/duct/ductFollow";
import type { DuctDesignSettings } from "../hvac/duct/ductSettings";
import { listTerminalPorts } from "../hvac/duct/ductTerminals";
import { tapStyleFor, useDuctToolStore } from "../hvac/duct/ductToolStore";
import {
  ductParentRunId,
  isDuctElement,
  readDuctRunSpec,
  roundLeg,
  type DuctLeg,
  type DuctService,
  type DuctSide,
  type DuctSpigotFace,
  type DuctTerminalEnd,
} from "../hvac/duct/ductTypes";
import { MM_TO_PX } from "../scale";

export interface UseDuctToolOptions {
  activeTool: string;
  hvacElements: HvacElement[];
  ductSettings: DuctDesignSettings;
  zoom: number;
  ductOverlayRef: React.RefObject<DuctOverlayHandle | null>;
  commitHvacElementCommand: (action: string, command: HvacElementCommand) => string[];
  setSelectedIds: (ids: string[]) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
  /** The live draft for the 3D view (the draft, and any run it re-plans), or null when none. */
  onDraftElementsChange?: (elements: HvacElement[] | null) => void;
}

export interface UseDuctToolResult {
  handleMouseDown: (point: Point2D) => void;
  handleMouseMove: (point: Point2D) => void;
  handleDoubleClick: () => void;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  handleKeyUp: (event: KeyboardEvent) => void;
  /** Cancel an active draft; true when there was one. */
  cancelDrawing: () => boolean;
}

/** Where the run being drawn starts. Branch origins are re-derived from the parent on every use. */
type DuctToolStart =
  | { kind: "port"; port: DuctAirPort }
  | { kind: "tap"; parentId: string; legIndex: number; stationMm: number; side: DuctSide }
  | { kind: "split"; parentId: string; side: DuctSide }
  /** A round branch off a spigot on a run's plenum. */
  | { kind: "spigot"; parentId: string; face: DuctSpigotFace; alongMm: number; acrossMm: number }
  /** Free space: an open start (finishing on a run's side makes it a take-off). */
  | { kind: "free"; point: Point2D }
  /** Extending an existing run from its open end. */
  | { kind: "continue"; runId: string };

/** Legs shorter than this are ignored. */
const MIN_LEG_MM = 50;
/** [ / ] level step (mm). */
const LEVEL_STEP_MM = 50;
/**
 * The second press of a double-click never adds a leg: the first press put
 * the leg end ON the axis, so the same cursor spot is off it by however far
 * beside the axis the user clicked, which would otherwise become a stray turn.
 */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 6;

function distanceToSegment(point: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared < 1e-9 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/** How the drafted run ends, from the tool panel: an end cap, open, or a plenum box (sized from its last section unless set). */
function toolEnd(lastSection: DuctLeg | undefined): DuctDraftEnd {
  const tool = useDuctToolStore.getState();
  if (tool.endKind !== "plenum") return tool.endKind;
  const size = tool.plenumSize ?? defaultPlenumSize(lastSection ?? { widthMm: 600, heightMm: 300 }, tool.branchDiameterMm);
  return { kind: "plenum", ...size };
}

function portKey(port: Pick<DuctAirPort, "unitId" | "portId">): string {
  return `${port.unitId}:${port.portId}`;
}

/** A run's end on an air terminal's spigot, as the tool panel asks (a flexible runout by default). */
function terminalEndFor(port: DuctAirPort): DuctTerminalEnd {
  return { kind: "terminal", terminalId: port.unitId, portId: port.portId, flex: useDuctToolStore.getState().terminalFlex };
}

/** The path point at a round spigot: its lip, at the clear bottom of a duct centred on it. */
function spigotPathPoint(port: DuctAirPort): DuctDraftPoint & { z: number } {
  const diameter = port.diameterMm ?? port.heightMm;
  return { x: port.lip.x, y: port.lip.y, z: port.lip.z - diameter / 2 };
}

/**
 * The rigid stub an all-runout branch keeps: its collar and damper (the flex's
 * draw band goes on the end), or the flexible connector at a unit collar.
 */
function runoutStubMm(start: DuctToolStart, settings: DuctDesignSettings): number {
  const tool = useDuctToolStore.getState();
  const damper = tool.vcd ? settings.vcdLengthMm : 0;
  if (start.kind === "port") return settings.connectorFabricMm + 2 * settings.connectorMetalMm + 50;
  if (start.kind === "split") return damper + 100;
  const collar = tool.branchShape !== "round" && start.kind === "tap"
    ? Math.max(settings.tapCollarMm, 200)
    : tool.roundTapStyle === "conical" ? Math.max(settings.tapCollarMm, settings.conicalFlareMm + 100) : settings.tapCollarMm;
  return collar + damper;
}

function newRunId(): string {
  return `duct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function targetLabel(target: DuctBranchTarget): string {
  const tool = useDuctToolStore.getState();
  if (target.kind === "spigot") return `Spigot Ø${tool.branchDiameterMm} (${tool.roundTapStyle === "spin-in" ? "spin-in" : "conical"}) on the plenum's ${target.face} face`;
  if (target.kind === "tap" && tool.branchShape === "round") return tool.roundTapStyle === "spin-in" ? "Spin-in collar (round)" : "Conical take-off (round)";
  if (target.kind === "tap") return tool.tapStyle === "shoe-45" ? "Shoe take-off" : "Straight take-off";
  const style = target.spec.end.kind === "split" ? target.spec.end.style : tool.splitStyle;
  return style === "y" ? "Y split outlet" : "Bullhead tee outlet";
}

export function useDuctTool(options: UseDuctToolOptions): UseDuctToolResult {
  const { activeTool, hvacElements, ductSettings, zoom, ductOverlayRef, commitHvacElementCommand, setSelectedIds, setProcessingStatus, onDraftElementsChange } = options;
  const onDraftElementsRef = useRef(onDraftElementsChange);
  onDraftElementsRef.current = onDraftElementsChange;

  const startRef = useRef<DuctToolStart | null>(null);
  /** Clicked leg ends, each at the level its leg runs at. */
  const pointsRef = useRef<Array<DuctDraftPoint & { z: number }>>([]);
  /** Section of each clicked leg, fixed when the leg was clicked. */
  const legSizesRef = useRef<DuctLeg[]>([]);
  const directionRef = useRef<Point2D>({ x: 0, y: -1 });
  const runIdRef = useRef<string>(newRunId());
  const lastCursorRef = useRef<Point2D | null>(null);
  const lastPressRef = useRef<{ at: number; point: Point2D } | null>(null);
  const sceneRef = useRef({ hvacElements, ductSettings });
  sceneRef.current = { hvacElements, ductSettings };

  const ports = useMemo(() => listAirPorts(hvacElements), [hvacElements]);
  const occupiedRuns = useMemo(() => {
    const byPort = new Map<string, string>();
    for (const element of hvacElements) {
      if (!isDuctElement(element)) continue;
      const start = readDuctRunSpec(element)?.start;
      if (start?.kind === "unit-port") byPort.set(`${start.unitId}:${start.portId}`, element.id);
    }
    return byPort;
  }, [hvacElements]);

  const terminalPorts = useMemo(() => listTerminalPorts(hvacElements), [hvacElements]);
  /** Terminal spigots a run already ends on. */
  const servedTerminals = useMemo(() => {
    const keys = new Set<string>();
    for (const element of hvacElements) {
      if (!isDuctElement(element)) continue;
      const end = readDuctRunSpec(element)?.end;
      if (end?.kind === "terminal") keys.add(`${end.terminalId}:${end.portId}`);
    }
    return keys;
  }, [hvacElements]);
  /** The press that finished a run on a terminal: its double-click's second press starts nothing. */
  const swallowRepeatRef = useRef(false);

  const pxToMm = 1 / Math.max(zoom * MM_TO_PX, 1e-3);
  const thresholdMm = Math.max(40, 14 * pxToMm);

  const findPort = useCallback((point: Point2D): DuctAirPort | null => {
    let best: DuctAirPort | null = null;
    let bestDistance = thresholdMm;
    for (const port of ports) {
      const distance = distanceToSegment(point, port.edgeA, port.edgeB);
      if (distance <= bestDistance) {
        best = port;
        bestDistance = distance;
      }
    }
    return best;
  }, [ports, thresholdMm]);

  /** An open (orphaned) run start under the cursor that can re-attach to a run wall behind it. */
  const findOrphanStart = useCallback((point: Point2D) => {
    const { hvacElements: scene, ductSettings: settings } = sceneRef.current;
    const tool = useDuctToolStore.getState();
    for (const element of scene) {
      if (!isDuctElement(element)) continue;
      const spec = readDuctRunSpec(element);
      const start = spec?.path[0];
      if (!spec || spec.start.kind !== "open" || !start) continue;
      if (Math.hypot(point.x - start.x, point.y - start.y) > thresholdMm * 1.5) continue;
      const target = findReattachTarget(element, scene, settings, { style: tapStyleFor(spec.legs[0]), vcd: tool.vcd });
      return target ? { element, target, start: { x: start.x, y: start.y } } : null;
    }
    return null;
  }, [thresholdMm]);

  const parentOf = useCallback((start: DuctToolStart) => {
    if (start.kind !== "tap" && start.kind !== "split" && start.kind !== "spigot") return null;
    const parent = sceneRef.current.hvacElements.find((element) => element.id === start.parentId);
    const spec = parent ? readDuctRunSpec(parent) : null;
    return parent && spec ? { parent, spec } : null;
  }, []);

  /** The run a `continue` start extends. */
  const continuedRun = useCallback((start: DuctToolStart) => {
    if (start.kind !== "continue") return null;
    const element = sceneRef.current.hvacElements.find((candidate) => candidate.id === start.runId);
    const spec = element ? readDuctRunSpec(element) : null;
    return element && spec ? { element, spec } : null;
  }, []);

  /** The section the next clicked leg gets, from the tool panel. */
  const nextSection = useCallback((start: DuctToolStart): DuctLeg | null => {
    const tool = useDuctToolStore.getState();
    const custom = tool.sizeMode === "custom" ? { widthMm: tool.widthMm, heightMm: tool.heightMm } : null;
    if (start.kind === "port") return custom ?? { widthMm: start.port.widthMm, heightMm: start.port.heightMm };
    if (start.kind === "continue") {
      const run = continuedRun(start);
      return run ? custom ?? { ...run.spec.legs[run.spec.legs.length - 1]! } : null;
    }
    const branch = tool.branchShape === "round" && start.kind !== "split"
      ? roundLeg(tool.branchDiameterMm)
      : { widthMm: tool.branchWidthMm, heightMm: tool.branchHeightMm };
    if (start.kind === "free") return branch;
    // A plenum spigot takes a round branch.
    if (start.kind === "spigot") return roundLeg(tool.branchDiameterMm);
    const parent = parentOf(start);
    if (!parent) return null;
    const parentSection = start.kind === "tap" ? parent.spec.legs[start.legIndex] : parent.spec.legs[parent.spec.legs.length - 1];
    if (!parentSection) return null;
    return clampBranchSection(branch, parentSection);
  }, [continuedRun, parentOf]);

  /** A branch's start point depends on its first section (a Y elbow's radius), so it is derived here. */
  const originFor = useCallback((start: DuctToolStart, firstSection: DuctLeg): DuctDraftOrigin | null => {
    if (start.kind === "port") return { kind: "port", port: start.port };
    const tool = useDuctToolStore.getState();
    if (start.kind === "free") return { kind: "free", point: start.point, bottomZ: tool.freeBottomMm, service: tool.freeService };
    if (start.kind === "continue") return null;
    const parent = parentOf(start);
    if (!parent) return null;
    const settings = sceneRef.current.ductSettings;
    if (start.kind === "spigot") {
      return spigotOrigin(parent.parent, settings, { face: start.face, alongMm: start.alongMm, acrossMm: start.acrossMm, style: tool.roundTapStyle, vcd: tool.vcd }, firstSection);
    }
    return start.kind === "tap"
      ? tapOrigin(parent.parent, settings, { legIndex: start.legIndex, stationMm: start.stationMm, side: start.side, style: tapStyleFor(firstSection), vcd: tool.vcd }, firstSection)
      : splitOrigin(parent.parent, settings, { side: start.side, style: tool.splitStyle, vcd: tool.vcd }, firstSection);
  }, [parentOf]);

  /** Sections of the clicked legs plus the live one. */
  const sectionsFor = useCallback((start: DuctToolStart, count: number): DuctLeg[] | null => {
    const legSizes = [...legSizesRef.current];
    const next = nextSection(start);
    if (!next) return null;
    while (legSizes.length < Math.max(count, 1)) legSizes.push(next);
    return legSizes.slice(0, Math.max(count, 1));
  }, [nextSection]);

  const draftInput = useCallback((points: DuctDraftPoint[], end?: DuctDraftEnd): DuctDraftInput | null => {
    const start = startRef.current;
    if (!start) return null;
    const legSizes = sectionsFor(start, points.length);
    if (!legSizes) return null;
    const origin = originFor(start, legSizes[0]!);
    if (!origin) return null;
    const settings = sceneRef.current.ductSettings;
    const parentSpec = parentOf(start)?.spec;
    const construction = parentSpec ? (parentSpec.construction === 'gi-nbr' ? 'gi-nbr' : 'gi-bare') : settings.defaultConstruction;
    const service = origin.kind === 'port' ? origin.port.kind : origin.service;
    const insulationThicknessMm = construction === 'gi-nbr'
      ? parentSpec?.insulationThicknessMm || (service === 'return' ? settings.nbrReturnThicknessMm : settings.nbrSupplyThicknessMm)
      : 0;
    return { origin, points, legSizes, construction, insulationThicknessMm, end: end ?? toolEnd(legSizes[legSizes.length - 1]) };
  }, [originFor, parentOf, sectionsFor]);

  /** The whole draft as it will be stored: a new run (plus a changed parent), or the extended run. */
  const buildToolDraft = useCallback((points: DuctDraftPoint[], end?: DuctDraftEnd): DuctRunDraft | null => {
    const start = startRef.current;
    if (!start) return null;
    if (start.kind === "continue") {
      const run = continuedRun(start);
      const legSizes = sectionsFor(start, points.length);
      if (!run || !legSizes || points.length === 0) return null;
      const spec = continueDuctRunSpec(run.spec, points, legSizes, end ?? toolEnd(legSizes[legSizes.length - 1]));
      return { element: ductRunElementWithSpec(run.element, spec), changed: [] };
    }
    const input = draftInput(points, end);
    return input ? buildDuctRunDraft(input, runIdRef.current, sceneRef.current.hvacElements) : null;
  }, [continuedRun, draftInput, sectionsFor]);

  /** Where the next leg starts (and its level), and the direction the first leg must take (null = any). */
  const anchorAndDirection = useCallback((): { anchor: Point2D; anchorZ: number; firstDirection: Point2D | null } | null => {
    const start = startRef.current;
    if (!start) return null;
    const points = pointsRef.current;
    const lastClick = points[points.length - 1];
    if (start.kind === "continue") {
      const run = continuedRun(start);
      if (!run) return null;
      const last = run.spec.path[run.spec.path.length - 1]!;
      return { anchor: lastClick ?? { x: last.x, y: last.y }, anchorZ: lastClick?.z ?? last.z, firstDirection: directionRef.current };
    }
    const input = draftInput(points);
    if (!input?.origin) return null;
    const origin = input.origin;
    const originZ = origin.kind === "port" ? origin.port.lip.z - origin.port.heightMm / 2 : origin.bottomZ;
    return { anchor: lastClick ?? originPoint(origin), anchorZ: lastClick?.z ?? originZ, firstDirection: originDirection(origin) };
  }, [continuedRun, draftInput]);

  /**
   * The next leg's level. It changes only where a riser may stand: at a
   * clicked point, a free start or a continued run's end; never at a collar or
   * parent wall (the first leg leaves those level, and the change waits).
   */
  const nextLevel = useCallback((): { z: number; changes: boolean; anchorZ: number } | null => {
    const current = anchorAndDirection();
    const start = startRef.current;
    if (!current || !start) return null;
    const wanted = useDuctToolStore.getState().levelMm ?? current.anchorZ;
    const riserHere = pointsRef.current.length > 0 || start.kind === "free" || start.kind === "continue";
    const changes = riserHere && Math.abs(wanted - current.anchorZ) > 0.5;
    return { z: changes ? wanted : current.anchorZ, changes, anchorZ: current.anchorZ };
  }, [anchorAndDirection]);

  const constrained = useCallback((cursor: Point2D) => {
    const current = anchorAndDirection();
    const start = startRef.current;
    if (!current || !start) return null;
    const first = pointsRef.current.length === 0;
    const mode = useDuctToolStore.getState().angleMode;
    if (first && start.kind === "free") return constrainDuctLeg(current.anchor, cursor, { x: 1, y: 0 }, { first: true, mode, free: true });
    // After a riser the leg goes straight on: its elbows only bend the easy way.
    if (nextLevel()?.changes) return constrainDuctLeg(current.anchor, cursor, directionRef.current, { first: true, mode });
    // Continuing a run: its next leg goes straight on or turns, like any later leg.
    const locked = first && start.kind !== "continue";
    return constrainDuctLeg(current.anchor, cursor, locked ? current.firstDirection ?? directionRef.current : directionRef.current, { first: locked, mode });
  }, [anchorAndDirection, nextLevel]);

  /** Keep the panel's Level field on the point the next leg starts from. */
  const publishAnchorLevel = useCallback(() => {
    const current = anchorAndDirection();
    const tool = useDuctToolStore.getState();
    const z = current ? Math.round(current.anchorZ) : null;
    if (tool.anchorLevelMm !== z) tool.setAnchorLevel(z);
  }, [anchorAndDirection]);

  /** The service the draft carries (its start's). */
  const draftService = useCallback((start: DuctToolStart): DuctService | null => {
    if (start.kind === "port") return start.port.kind;
    if (start.kind === "free") return useDuctToolStore.getState().freeService;
    if (start.kind === "continue") return continuedRun(start)?.spec.service ?? null;
    return parentOf(start)?.spec.service ?? null;
  }, [continuedRun, parentOf]);

  /** A free air-terminal spigot of the draft's service under the cursor: the run can finish on it. */
  const findTerminal = useCallback((point: Point2D): DuctAirPort | null => {
    const start = startRef.current;
    const service = start ? draftService(start) : null;
    if (!service) return null;
    let best: DuctAirPort | null = null;
    let bestDistance = Infinity;
    for (const port of terminalPorts) {
      if (port.kind !== service || servedTerminals.has(portKey(port))) continue;
      const distance = Math.hypot(point.x - port.lip.x, point.y - port.lip.y);
      const reach = Math.max(thresholdMm * 1.5, (port.diameterMm ?? port.widthMm) / 2 + thresholdMm);
      if (distance <= reach && distance < bestDistance) {
        best = port;
        bestDistance = distance;
      }
    }
    return best;
  }, [draftService, servedTerminals, terminalPorts, thresholdMm]);

  /** The draft's points when it finishes on `port`: the clicks (or the collar stub of an all-runout branch), then the spigot. */
  const terminalPoints = useCallback((port: DuctAirPort): DuctDraftPoint[] => {
    const start = startRef.current;
    const clicked = pointsRef.current;
    const spigot = spigotPathPoint(port);
    const flex = useDuctToolStore.getState().terminalFlex;
    if (!start || clicked.length > 0 || !flex || start.kind === "free" || start.kind === "continue") return [...clicked, spigot];
    const current = anchorAndDirection();
    if (!current?.firstDirection) return [spigot];
    const length = runoutStubMm(start, sceneRef.current.ductSettings);
    const direction = current.firstDirection;
    return [{ x: current.anchor.x + direction.x * length, y: current.anchor.y + direction.y * length, z: current.anchorZ }, spigot];
  }, [anchorAndDirection]);

  /** The live label on a terminal: the runout's length (flagged over the maximum), or the rigid connection. */
  const terminalLabel = useCallback((draft: DuctRunDraft, port: DuctAirPort): string => {
    const { hvacElements: stored, ductSettings: settings } = sceneRef.current;
    const terminal = stored.find((element) => element.id === port.unitId);
    const name = terminal?.label || (terminal?.type === "return-grille" ? "return grille" : "diffuser");
    const spec = readDuctRunSpec(draft.element);
    if (!spec || spec.end.kind !== "terminal" || !spec.end.flex) return `Rigid duct into the ${name} spigot Ø${Math.round(port.diameterMm ?? port.widthMm)}`;
    const replaced = new Map(draft.changed.map((element) => [element.id, element]));
    const scene = [...stored.filter((element) => element.id !== draft.element.id).map((element) => replaced.get(element.id) ?? element), draft.element];
    const flex = planDuctRunSpec(draft.element.id, spec, { settings, scene }).pieces.find((piece) => piece.kind === "flex");
    if (!flex) return `Flexible runout to ${name}`;
    const over = flex.lengthMm > settings.flexMaxLengthMm + 0.5;
    return `Flex Ø${Math.round(flex.widthMm)} · ${(flex.lengthMm / 1000).toFixed(2)} m to ${name}${over ? ` · over the ${(settings.flexMaxLengthMm / 1000).toFixed(1)} m maximum` : ""}`;
  }, []);

  /** 3D: the draft, the runs it changes, and a take-off's parent (its joints move round the new opening). */
  const publishDraft3d = useCallback((draft: DuctRunDraft) => {
    const parentId = ductParentRunId(readDuctRunSpec(draft.element)!);
    const parent = parentId && !draft.changed.some((element) => element.id === parentId)
      ? sceneRef.current.hvacElements.find((element) => element.id === parentId) : undefined;
    onDraftElementsRef.current?.([draft.element, ...draft.changed, ...(parent ? [parent] : [])]);
  }, []);

  const renderPreview = useCallback((cursor: Point2D | null) => {
    const overlay = ductOverlayRef.current;
    const start = startRef.current;
    if (!overlay || !start) return;
    const terminal = cursor ? findTerminal(cursor) : null;
    overlay.setHoveredPort(terminal ? portKey(terminal) : start.kind === "port" ? portKey(start.port) : null);
    if (terminal) {
      const draft = buildToolDraft(terminalPoints(terminal), terminalEndFor(terminal));
      if (!draft) return;
      publishDraft3d(draft);
      overlay.setDraft({ ...draft, label: { point: { x: terminal.lip.x, y: terminal.lip.y }, text: terminalLabel(draft, terminal) } });
      return;
    }
    const committedPoints = pointsRef.current;
    const leg = cursor ? constrained(cursor) : null;
    const live = leg && leg.lengthMm >= MIN_LEG_MM;
    const level = nextLevel();
    const points: DuctDraftPoint[] = live ? [...committedPoints, { ...leg.point, z: level?.z }] : committedPoints;
    if (points.length === 0) {
      overlay.setDraft(null);
      onDraftElementsRef.current?.(null);
      return;
    }
    const draft = buildToolDraft(points);
    if (!draft) return;
    publishDraft3d(draft);
    const section = sectionsFor(start, points.length)?.[points.length - 1];
    const rise = level?.changes ? `${level.z > level.anchorZ ? "▲" : "▼"} ${Math.round(Math.abs(level.z - level.anchorZ))} · ` : "";
    const pending = !level?.changes && useDuctToolStore.getState().levelMm !== null
      && Math.abs((useDuctToolStore.getState().levelMm ?? 0) - (level?.anchorZ ?? 0)) > 0.5 ? " · level change after this leg" : "";
    overlay.setDraft({
      ...draft,
      label: live ? { point: leg.point, text: `${rise}${leg.lengthMm} mm${section ? ` · ${section.widthMm}×${section.heightMm}` : ""} · bottom ${Math.round(level?.z ?? 0)}${pending}` } : undefined,
    });
  }, [buildToolDraft, constrained, ductOverlayRef, findTerminal, nextLevel, publishDraft3d, sectionsFor, terminalLabel, terminalPoints]);

  const reset = useCallback(() => {
    startRef.current = null;
    pointsRef.current = [];
    legSizesRef.current = [];
    lastCursorRef.current = null;
    runIdRef.current = newRunId();
    const tool = useDuctToolStore.getState();
    if (tool.anchorLevelMm !== null) tool.setAnchorLevel(null);
    if (tool.levelMm !== null) tool.setLevel(null);
    ductOverlayRef.current?.setDraft(null);
    ductOverlayRef.current?.setHoveredPort(null);
    ductOverlayRef.current?.setBranchTarget(null);
    onDraftElementsRef.current?.(null);
  }, [ductOverlayRef]);

  /** Finish the draft: as the panel's run end, or on `terminal`'s spigot. */
  const finish = useCallback((terminal?: DuctAirPort) => {
    const start = startRef.current;
    if (!start) return;
    const clicked = pointsRef.current;
    if (!terminal && clicked.length === 0) {
      setProcessingStatus("Add at least one leg before finishing the duct.", false);
      return;
    }
    let points: DuctDraftPoint[];
    if (terminal) {
      points = terminalPoints(terminal);
    } else {
      // A level change still pending at the end: the run ends in that riser or drop.
      const level = nextLevel();
      const last = clicked[clicked.length - 1]!;
      points = level?.changes ? [...clicked, { x: last.x, y: last.y, z: level.z }] : clicked;
    }
    const end = terminal ? terminalEndFor(terminal) : undefined;
    const draft = buildToolDraft(points, end);
    if (!draft) {
      setProcessingStatus("The run this draft starts from is gone; the draft was cancelled.", false);
      reset();
      return;
    }
    const tool = useDuctToolStore.getState();
    if (start.kind === "continue") {
      const run = continuedRun(start)!;
      commitDuctRunSpec(run.element, readDuctRunSpec(draft.element)!, terminal ? "Connect duct run to terminal" : "Extend duct run");
      setSelectedIds([run.element.id]);
      setProcessingStatus(terminal ? `Run connected to the terminal ${end?.flex ? "by a flexible runout" : "in rigid duct"}.` : `Run extended by ${points.length} leg(s).`, false);
      reset();
      return;
    }
    if (start.kind === "free" && !terminal) {
      // Finished on a run's side: the run becomes a take-off of it, drawn from that wall.
      const spec = readDuctRunSpec(draft.element)!;
      const reversed = ductRunElementWithSpec(draft.element, reverseDuctRunSpec(spec, tool.endKind === "open" ? "open" : "end-cap"));
      const target = findReattachTarget(reversed, sceneRef.current.hvacElements, sceneRef.current.ductSettings,
        { style: tapStyleFor(spec.legs[spec.legs.length - 1]), vcd: tool.vcd, reachMm: Math.max(300, 2 * thresholdMm) });
      if (target) {
        const branch = ductRunElementWithSpec(reversed, target.spec);
        const ids = commitHvacElementCommand("Draw duct branch", { add: [branch], selectedIds: [branch.id] });
        setSelectedIds(ids.length > 0 ? ids : [branch.id]);
        setProcessingStatus(`Branch committed as a take-off on ${target.parent.label || target.parent.id}: ${points.length} leg(s).`, false);
        reset();
        return;
      }
    }
    const action = start.kind === "port" ? "Draw duct run" : "Draw duct branch";
    const ids = commitHvacElementCommand(action, ductRunDraftCommand(draft));
    setSelectedIds(ids.length > 0 ? ids : [draft.element.id]);
    const service = readDuctRunSpec(draft.element)?.service === "return" ? "Return" : "Supply";
    const connection = end?.flex ? "by a flexible runout" : "in rigid duct";
    setProcessingStatus(
      terminal
        ? `${service} ${start.kind === "port" || start.kind === "free" ? "run" : "branch"} committed to the ${terminal.kind === "return" ? "grille" : "diffuser"} ${connection}.`
        : start.kind === "port"
          ? `${service} duct committed: ${points.length} leg(s).`
          : start.kind === "free"
            ? `Free ${service.toLowerCase()} run committed (open start): ${points.length} leg(s). Hover its start with the Duct tool to attach it to a run.`
            : `${service} branch committed (${start.kind === "tap" ? "take-off" : start.kind === "spigot" ? "plenum spigot" : "split outlet"}): ${points.length} leg(s).`,
      false,
    );
    reset();
  }, [buildToolDraft, commitHvacElementCommand, continuedRun, nextLevel, reset, setProcessingStatus, setSelectedIds, terminalPoints, thresholdMm]);

  const begin = useCallback((start: DuctToolStart, point: Point2D, message: string) => {
    startRef.current = start;
    pointsRef.current = [];
    legSizesRef.current = [];
    runIdRef.current = newRunId();
    if (start.kind === "continue") {
      const run = continuedRun(start);
      const path = run?.spec.path ?? [];
      const a = path[path.length - 2];
      const b = path[path.length - 1];
      if (a && b) {
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        directionRef.current = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
      }
    }
    ductOverlayRef.current?.setBranchTarget(null);
    useDuctToolStore.getState().setLevel(null);
    publishAnchorLevel();
    setProcessingStatus(`${message}: click to add bends, [ / ] or the Level field for a riser or drop, click a diffuser or grille spigot or double-click / Enter to finish, Backspace to undo a leg, Tab for 45°, Esc to cancel.`, false);
    renderPreview(point);
  }, [continuedRun, ductOverlayRef, publishAnchorLevel, renderPreview, setProcessingStatus]);

  /** A run's open end under the cursor (it can be continued). */
  const findOpenEnd = useCallback((point: Point2D): HvacElement | null => {
    for (const element of sceneRef.current.hvacElements) {
      if (!isDuctElement(element)) continue;
      const spec = readDuctRunSpec(element);
      const last = spec?.path[spec.path.length - 1];
      if (!spec || spec.legacy || spec.end.kind !== "open" || !last) continue;
      if (Math.hypot(point.x - last.x, point.y - last.y) <= thresholdMm * 1.5) return element;
    }
    return null;
  }, [thresholdMm]);

  const handleMouseMove = useCallback((point: Point2D) => {
    lastCursorRef.current = point;
    if (startRef.current) {
      renderPreview(point);
      return;
    }
    const overlay = ductOverlayRef.current;
    const port = findPort(point);
    overlay?.setHoveredPort(port ? portKey(port) : null);
    const orphan = port ? null : findOrphanStart(point);
    if (orphan) {
      overlay?.setBranchTarget({
        kind: "tap", marker: [orphan.start, orphan.target.wallPoint],
        label: `Re-attach to ${orphan.target.parent.label || orphan.target.parent.id}`,
      });
      return;
    }
    const openEnd = port ? null : findOpenEnd(point);
    if (openEnd) {
      const last = readDuctRunSpec(openEnd)!.path.at(-1)!;
      overlay?.setBranchTarget({ kind: "split", marker: [{ x: last.x, y: last.y }, { x: last.x, y: last.y }], label: "Continue this run" });
      return;
    }
    const target = port ? null : findBranchTarget(point, sceneRef.current.hvacElements, sceneRef.current.ductSettings, thresholdMm,
      { splits: useDuctToolStore.getState().branchShape !== "round" });
    overlay?.setBranchTarget(target ? { kind: target.kind, marker: target.marker, label: targetLabel(target) } : null);
  }, [ductOverlayRef, findOpenEnd, findOrphanStart, findPort, renderPreview, thresholdMm]);

  const handleMouseDown = useCallback((point: Point2D) => {
    const now = performance.now();
    const previous = lastPressRef.current;
    lastPressRef.current = { at: now, point };
    const repeatPress = previous !== null && now - previous.at < DOUBLE_CLICK_MS
      && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= DOUBLE_CLICK_SLOP_PX * pxToMm;
    if (repeatPress && (startRef.current || swallowRepeatRef.current)) {
      swallowRepeatRef.current = false;
      return;
    }
    swallowRepeatRef.current = false;
    if (!startRef.current) {
      const port = findPort(point);
      if (port) {
        const existing = occupiedRuns.get(portKey(port));
        const existingRun = existing ? sceneRef.current.hvacElements.find((element) => element.id === existing) : undefined;
        if (existingRun && readDuctRunSpec(existingRun)?.end.kind === "open") {
          begin({ kind: "continue", runId: existingRun.id }, point, `Continuing ${existingRun.label || "the run"} from its open end`);
          return;
        }
        if (existing) {
          setSelectedIds([existing]);
          setProcessingStatus(`This ${port.kind} collar already has a duct; it is selected.`, false);
          return;
        }
        ductOverlayRef.current?.setHoveredPort(portKey(port));
        begin({ kind: "port", port }, point, `Drawing ${port.kind} duct ${port.widthMm}×${port.heightMm}`);
        return;
      }
      const orphan = findOrphanStart(point);
      if (orphan) {
        const tool = useDuctToolStore.getState();
        ductOverlayRef.current?.setBranchTarget(null);
        if (reattachDuctRun(orphan.element, { style: tapStyleFor(readDuctRunSpec(orphan.element)?.legs[0]), vcd: tool.vcd })) setSelectedIds([orphan.element.id]);
        return;
      }
      const openEnd = findOpenEnd(point);
      if (openEnd) {
        begin({ kind: "continue", runId: openEnd.id }, point, `Continuing ${openEnd.label || "the run"} from its open end`);
        return;
      }
      const target = findBranchTarget(point, sceneRef.current.hvacElements, sceneRef.current.ductSettings, thresholdMm,
        { splits: useDuctToolStore.getState().branchShape !== "round" });
      if (!target) {
        const tool = useDuctToolStore.getState();
        begin({ kind: "free", point }, point,
          `Drawing a free ${tool.freeService} run ${tool.branchWidthMm}×${tool.branchHeightMm} (finish on a run's side to make it a take-off)`);
        return;
      }
      const start: DuctToolStart = target.kind === "tap"
        ? { kind: "tap", parentId: target.parent.id, legIndex: target.legIndex, stationMm: target.stationMm, side: target.side }
        : target.kind === "spigot"
          ? { kind: "spigot", parentId: target.parent.id, face: target.face, alongMm: target.alongMm, acrossMm: target.acrossMm }
          : { kind: "split", parentId: target.parent.id, side: target.side };
      const section = nextSection(start);
      begin(start, point, `Drawing ${target.spec.service} branch${section ? ` ${section.widthMm}×${section.heightMm}` : ""} (${targetLabel(target).toLowerCase()})`);
      return;
    }
    const terminal = findTerminal(point);
    if (terminal) {
      finish(terminal);
      swallowRepeatRef.current = true;
      return;
    }
    const start = startRef.current;
    const leg = constrained(point);
    const section = nextSection(start);
    const level = nextLevel();
    if (!leg || !section || !level || leg.lengthMm < MIN_LEG_MM) return;
    pointsRef.current = [...pointsRef.current, { ...leg.point, z: level.z }];
    legSizesRef.current = [...legSizesRef.current, section];
    directionRef.current = leg.direction;
    publishAnchorLevel();
    renderPreview(point);
  }, [begin, constrained, ductOverlayRef, findOpenEnd, findOrphanStart, findPort, findTerminal, finish, nextLevel, nextSection, occupiedRuns, publishAnchorLevel, pxToMm, renderPreview, setProcessingStatus, setSelectedIds, thresholdMm]);

  const handleDoubleClick = useCallback(() => {
    finish();
  }, [finish]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!startRef.current) return false;
    if (event.key === "Enter") {
      finish();
      return true;
    }
    if (event.key === "Backspace") {
      if (pointsRef.current.length === 0) return true;
      pointsRef.current = pointsRef.current.slice(0, -1);
      legSizesRef.current = legSizesRef.current.slice(0, pointsRef.current.length);
      const points = pointsRef.current;
      const start = startRef.current;
      const run = continuedRun(start);
      const current = anchorAndDirection();
      const runPath = run?.spec.path ?? [];
      const previous = points.length >= 1 ? points[points.length - 1]! : (run ? runPath[runPath.length - 1] ?? null : null);
      const before = points.length >= 2 ? points[points.length - 2]!
        : points.length === 1 ? (run ? runPath[runPath.length - 1] ?? null : current?.anchor ?? null)
          : (run ? runPath[runPath.length - 2] ?? null : null);
      if (previous && before) {
        const dx = previous.x - before.x;
        const dy = previous.y - before.y;
        const length = Math.hypot(dx, dy) || 1;
        directionRef.current = { x: dx / length, y: dy / length };
      }
      publishAnchorLevel();
      renderPreview(lastCursorRef.current);
      return true;
    }
    if (event.key === "[" || event.key === "]") {
      // Step the next leg's level; it rises or drops at the point it starts from.
      const current = anchorAndDirection();
      const tool = useDuctToolStore.getState();
      if (!current) return true;
      tool.setLevel((tool.levelMm ?? current.anchorZ) + (event.key === "]" ? LEVEL_STEP_MM : -LEVEL_STEP_MM));
      renderPreview(lastCursorRef.current);
      return true;
    }
    if (event.key === "Tab") {
      const store = useDuctToolStore.getState();
      store.setAngleMode(store.angleMode === "90" ? "45" : "90");
      renderPreview(lastCursorRef.current);
      return true;
    }
    return false;
  }, [anchorAndDirection, continuedRun, finish, publishAnchorLevel, renderPreview]);

  const handleKeyUp = useCallback((_event: KeyboardEvent) => {
    // No-op for parity with other tool hooks.
  }, []);

  const cancelDrawing = useCallback(() => {
    const active = startRef.current !== null;
    reset();
    return active;
  }, [reset]);

  // A size or option changed in the panel mid-draw: the next leg shows it at once.
  useEffect(() => useDuctToolStore.subscribe(() => {
    if (startRef.current) renderPreview(lastCursorRef.current);
  }), [renderPreview]);

  useEffect(() => {
    if (activeTool !== "duct") reset();
  }, [activeTool, reset]);

  useEffect(() => () => reset(), [reset]);

  return { handleMouseDown, handleMouseMove, handleDoubleClick, handleKeyDown, handleKeyUp, cancelDrawing };
}
