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
import { clampBranchSection, findBranchTarget, findReattachTarget, splitOrigin, tapOrigin, type DuctBranchTarget } from "../hvac/duct/ductBranchTargets";
import {
  buildDuctRunDraft,
  constrainDuctLeg,
  continueDuctRunSpec,
  ductRunDraftCommand,
  originDirection,
  originPoint,
  reverseDuctRunSpec,
  type DuctDraftInput,
  type DuctDraftOrigin,
  type DuctDraftPoint,
  type DuctRunDraft,
} from "../hvac/duct/ductDraft";
import { commitDuctRunSpec, reattachDuctRun } from "../hvac/duct/ductEditController";
import { ductRunElementWithSpec } from "../hvac/duct/ductFollow";
import type { DuctDesignSettings } from "../hvac/duct/ductSettings";
import { tapStyleFor, useDuctToolStore } from "../hvac/duct/ductToolStore";
import { ductParentRunId, isDuctElement, readDuctRunSpec, roundLeg, type DuctLeg, type DuctSide } from "../hvac/duct/ductTypes";
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

function portKey(port: Pick<DuctAirPort, "unitId" | "portId">): string {
  return `${port.unitId}:${port.portId}`;
}

function newRunId(): string {
  return `duct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function targetLabel(target: DuctBranchTarget): string {
  const tool = useDuctToolStore.getState();
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
    if (start.kind !== "tap" && start.kind !== "split") return null;
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

  const draftInput = useCallback((points: DuctDraftPoint[]): DuctDraftInput | null => {
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
    return { origin, points, legSizes, construction, insulationThicknessMm, end: useDuctToolStore.getState().endKind };
  }, [originFor, parentOf, sectionsFor]);

  /** The whole draft as it will be stored: a new run (plus a changed parent), or the extended run. */
  const buildToolDraft = useCallback((points: DuctDraftPoint[]): DuctRunDraft | null => {
    const start = startRef.current;
    if (!start) return null;
    if (start.kind === "continue") {
      const run = continuedRun(start);
      const legSizes = sectionsFor(start, points.length);
      if (!run || !legSizes || points.length === 0) return null;
      const spec = continueDuctRunSpec(run.spec, points, legSizes, useDuctToolStore.getState().endKind);
      return { element: ductRunElementWithSpec(run.element, spec), changed: [] };
    }
    const input = draftInput(points);
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

  const renderPreview = useCallback((cursor: Point2D | null) => {
    const overlay = ductOverlayRef.current;
    const start = startRef.current;
    if (!overlay || !start) return;
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
    // 3D: the draft, the runs it changes, and a take-off's parent (its joints move round the new opening).
    const parentId = ductParentRunId(readDuctRunSpec(draft.element)!);
    const parent = parentId && !draft.changed.some((element) => element.id === parentId)
      ? sceneRef.current.hvacElements.find((element) => element.id === parentId) : undefined;
    onDraftElementsRef.current?.([draft.element, ...draft.changed, ...(parent ? [parent] : [])]);
    const section = sectionsFor(start, points.length)?.[points.length - 1];
    const rise = level?.changes ? `${level.z > level.anchorZ ? "▲" : "▼"} ${Math.round(Math.abs(level.z - level.anchorZ))} · ` : "";
    const pending = !level?.changes && useDuctToolStore.getState().levelMm !== null
      && Math.abs((useDuctToolStore.getState().levelMm ?? 0) - (level?.anchorZ ?? 0)) > 0.5 ? " · level change after this leg" : "";
    overlay.setDraft({
      ...draft,
      label: live ? { point: leg.point, text: `${rise}${leg.lengthMm} mm${section ? ` · ${section.widthMm}×${section.heightMm}` : ""} · bottom ${Math.round(level?.z ?? 0)}${pending}` } : undefined,
    });
  }, [buildToolDraft, constrained, ductOverlayRef, nextLevel, sectionsFor]);

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

  const finish = useCallback(() => {
    const start = startRef.current;
    if (!start) return;
    const clicked = pointsRef.current;
    if (clicked.length === 0) {
      setProcessingStatus("Add at least one leg before finishing the duct.", false);
      return;
    }
    // A level change still pending at the end: the run ends in that riser or drop.
    const level = nextLevel();
    const last = clicked[clicked.length - 1]!;
    const points: DuctDraftPoint[] = level?.changes ? [...clicked, { x: last.x, y: last.y, z: level.z }] : clicked;
    const draft = buildToolDraft(points);
    if (!draft) {
      setProcessingStatus("The run this draft starts from is gone; the draft was cancelled.", false);
      reset();
      return;
    }
    const tool = useDuctToolStore.getState();
    if (start.kind === "continue") {
      const run = continuedRun(start)!;
      commitDuctRunSpec(run.element, readDuctRunSpec(draft.element)!, "Extend duct run");
      setSelectedIds([run.element.id]);
      setProcessingStatus(`Run extended by ${points.length} leg(s).`, false);
      reset();
      return;
    }
    if (start.kind === "free") {
      // Finished on a run's side: the run becomes a take-off of it, drawn from that wall.
      const spec = readDuctRunSpec(draft.element)!;
      const reversed = ductRunElementWithSpec(draft.element, reverseDuctRunSpec(spec, tool.endKind));
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
    setProcessingStatus(
      start.kind === "port"
        ? `${service} duct committed: ${points.length} leg(s).`
        : start.kind === "free"
          ? `Free ${service.toLowerCase()} run committed (open start): ${points.length} leg(s). Hover its start with the Duct tool to attach it to a run.`
          : `${service} branch committed (${start.kind === "tap" ? "take-off" : "split outlet"}): ${points.length} leg(s).`,
      false,
    );
    reset();
  }, [buildToolDraft, commitHvacElementCommand, continuedRun, nextLevel, reset, setProcessingStatus, setSelectedIds, thresholdMm]);

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
    setProcessingStatus(`${message}: click to add bends, [ / ] or the Level field for a riser or drop, double-click or Enter to finish, Backspace to undo a leg, Tab for 45°, Esc to cancel.`, false);
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
    if (repeatPress && startRef.current) return;
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
        : { kind: "split", parentId: target.parent.id, side: target.side };
      const section = nextSection(start);
      begin(start, point, `Drawing ${target.spec.service} branch${section ? ` ${section.widthMm}×${section.heightMm}` : ""} (${targetLabel(target).toLowerCase()})`);
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
  }, [begin, constrained, ductOverlayRef, findOpenEnd, findOrphanStart, findPort, nextLevel, nextSection, occupiedRuns, publishAnchorLevel, pxToMm, renderPreview, setProcessingStatus, setSelectedIds, thresholdMm]);

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
