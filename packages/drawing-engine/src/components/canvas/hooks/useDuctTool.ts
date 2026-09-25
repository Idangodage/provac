/**
 * Duct tool: draw a supply or return run from a ducted unit's real collar.
 *
 *  - Hover shows the units' collars; click a free one to start. The first leg
 *    leaves along the collar's outward normal.
 *  - Each click adds a leg end; legs go straight on or turn 90° (Tab toggles
 *    45° mode). Lengths snap to 10 mm.
 *  - Double-click or Enter finishes (end cap by default); Backspace removes the
 *    last leg; Esc cancels the draft (a second Esc leaves the tool).
 *
 * The live preview is built by the same draft builder as the commit and pushed
 * to the duct overlay imperatively — no store writes and no React renders per
 * pointer move. The commit is ONE `commitHvacElementCommand`, so one undo.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { HvacElementCommand } from "../../../store";
import type { HvacElement, Point2D } from "../../../types";
import type { DuctOverlayHandle } from "../hvac/duct/DuctOverlay";
import { listAirPorts, type DuctAirPort } from "../hvac/duct/ductAirPorts";
import { buildDuctRunDraftElement, constrainDuctLeg, type DuctDraftInput } from "../hvac/duct/ductDraft";
import { useDuctToolStore } from "../hvac/duct/ductToolStore";
import { isDuctElement, readDuctRunSpec } from "../hvac/duct/ductTypes";
import { MM_TO_PX } from "../scale";

export interface UseDuctToolOptions {
  activeTool: string;
  hvacElements: HvacElement[];
  zoom: number;
  ductOverlayRef: React.RefObject<DuctOverlayHandle | null>;
  commitHvacElementCommand: (action: string, command: HvacElementCommand) => string[];
  setSelectedIds: (ids: string[]) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
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

/** Legs shorter than this are ignored (the second click of a double-click). */
const MIN_LEG_MM = 50;

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

export function useDuctTool(options: UseDuctToolOptions): UseDuctToolResult {
  const { activeTool, hvacElements, zoom, ductOverlayRef, commitHvacElementCommand, setSelectedIds, setProcessingStatus } = options;

  const portRef = useRef<DuctAirPort | null>(null);
  const pointsRef = useRef<Point2D[]>([]);
  const directionRef = useRef<Point2D>({ x: 0, y: -1 });
  const runIdRef = useRef<string>(newRunId());
  const lastCursorRef = useRef<Point2D | null>(null);

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

  const thresholdMm = Math.max(40, 14 / Math.max(zoom * MM_TO_PX, 1e-3));

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

  const draftInput = useCallback((points: Point2D[]): DuctDraftInput | null => {
    const port = portRef.current;
    if (!port) return null;
    const tool = useDuctToolStore.getState();
    return {
      port,
      points,
      ...(tool.sizeMode === "custom" ? { widthMm: tool.widthMm, heightMm: tool.heightMm } : {}),
      end: tool.endKind,
    };
  }, []);

  const constrained = useCallback((cursor: Point2D) => {
    const port = portRef.current!;
    const points = pointsRef.current;
    const anchor = points[points.length - 1] ?? { x: port.lip.x, y: port.lip.y };
    return constrainDuctLeg(anchor, cursor, directionRef.current, {
      first: points.length === 0,
      mode: useDuctToolStore.getState().angleMode,
    });
  }, []);

  const renderPreview = useCallback((cursor: Point2D | null) => {
    const overlay = ductOverlayRef.current;
    if (!overlay || !portRef.current) return;
    const committedPoints = pointsRef.current;
    const leg = cursor ? constrained(cursor) : null;
    const points = leg && leg.lengthMm >= MIN_LEG_MM ? [...committedPoints, leg.point] : committedPoints;
    if (points.length === 0) {
      overlay.setDraft(null);
      return;
    }
    const input = draftInput(points);
    if (!input) return;
    overlay.setDraft({
      element: buildDuctRunDraftElement(input, runIdRef.current),
      label: leg && leg.lengthMm >= MIN_LEG_MM ? { point: leg.point, text: `${leg.lengthMm} mm` } : undefined,
    });
  }, [constrained, draftInput, ductOverlayRef]);

  const reset = useCallback(() => {
    portRef.current = null;
    pointsRef.current = [];
    lastCursorRef.current = null;
    runIdRef.current = newRunId();
    ductOverlayRef.current?.setDraft(null);
    ductOverlayRef.current?.setHoveredPort(null);
  }, [ductOverlayRef]);

  const finish = useCallback(() => {
    const port = portRef.current;
    if (!port) return;
    const points = pointsRef.current;
    if (points.length === 0) {
      setProcessingStatus("Add at least one leg before finishing the duct.", false);
      return;
    }
    const input = draftInput(points);
    if (!input) return;
    const element = buildDuctRunDraftElement(input, runIdRef.current);
    const ids = commitHvacElementCommand("Draw duct run", { add: [element], selectedIds: [element.id] });
    setSelectedIds(ids.length > 0 ? ids : [element.id]);
    setProcessingStatus(`${port.kind === "supply" ? "Supply" : "Return"} duct committed: ${points.length} leg(s).`, false);
    reset();
  }, [commitHvacElementCommand, draftInput, reset, setProcessingStatus, setSelectedIds]);

  const handleMouseMove = useCallback((point: Point2D) => {
    lastCursorRef.current = point;
    if (portRef.current) {
      renderPreview(point);
      return;
    }
    const port = findPort(point);
    ductOverlayRef.current?.setHoveredPort(port ? portKey(port) : null);
  }, [ductOverlayRef, findPort, renderPreview]);

  const handleMouseDown = useCallback((point: Point2D) => {
    if (!portRef.current) {
      const port = findPort(point);
      if (!port) {
        setProcessingStatus("Click a ducted unit's supply or return collar to start a duct.", false);
        return;
      }
      const existing = occupiedRuns.get(portKey(port));
      if (existing) {
        setSelectedIds([existing]);
        setProcessingStatus(`This ${port.kind} collar already has a duct; it is selected.`, false);
        return;
      }
      portRef.current = port;
      pointsRef.current = [];
      directionRef.current = port.normal;
      runIdRef.current = newRunId();
      ductOverlayRef.current?.setHoveredPort(portKey(port));
      setProcessingStatus(
        `Drawing ${port.kind} duct ${port.widthMm}×${port.heightMm}: click to add bends, double-click or Enter to finish, Backspace to undo a leg, Tab for 45°, Esc to cancel.`,
        false,
      );
      renderPreview(point);
      return;
    }
    const leg = constrained(point);
    if (leg.lengthMm < MIN_LEG_MM) return;
    pointsRef.current = [...pointsRef.current, leg.point];
    directionRef.current = leg.direction;
    renderPreview(point);
  }, [constrained, ductOverlayRef, findPort, occupiedRuns, renderPreview, setProcessingStatus, setSelectedIds]);

  const handleDoubleClick = useCallback(() => {
    finish();
  }, [finish]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!portRef.current) return false;
    if (event.key === "Enter") {
      finish();
      return true;
    }
    if (event.key === "Backspace") {
      if (pointsRef.current.length === 0) return true;
      pointsRef.current = pointsRef.current.slice(0, -1);
      const port = portRef.current;
      const points = pointsRef.current;
      const previous = points.length >= 1 ? points[points.length - 1]! : null;
      const before = points.length >= 2 ? points[points.length - 2]! : { x: port.lip.x, y: port.lip.y };
      if (previous) {
        const dx = previous.x - before.x;
        const dy = previous.y - before.y;
        const length = Math.hypot(dx, dy) || 1;
        directionRef.current = { x: dx / length, y: dy / length };
      } else {
        directionRef.current = port.normal;
      }
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
  }, [finish, renderPreview]);

  const handleKeyUp = useCallback((_event: KeyboardEvent) => {
    // No-op for parity with other tool hooks.
  }, []);

  const cancelDrawing = useCallback(() => {
    const active = portRef.current !== null;
    reset();
    return active;
  }, [reset]);

  useEffect(() => {
    if (activeTool !== "duct") reset();
  }, [activeTool, reset]);

  useEffect(() => () => reset(), [reset]);

  return { handleMouseDown, handleMouseMove, handleDoubleClick, handleKeyDown, handleKeyUp, cancelDrawing };
}
