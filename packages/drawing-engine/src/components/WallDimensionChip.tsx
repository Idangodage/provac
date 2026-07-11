"use client";

/**
 * Temp-dimension chip for the selected wall — port of the reference app's
 * `panels/TempDims.tsx`: a DOM chip (not in-scene text) showing the wall's
 * length in mm, positioned at the projected wall midpoint. Click → inline
 * input; Enter commits `wallGraphSetLength`; Tab flips which end stays
 * anchored; Esc cancels. Works identically in 2D and 3D: the hybrid camera's
 * projection matches the flat board exactly (plan-sheet equivalence), so ONE
 * projection path serves both views.
 */
import { useEffect, useRef, useState, type RefObject } from "react";

import type { Wall } from "../types";

import type { HybridViewportController } from "./canvas/hybrid/hybridViewportController";
import { worldToScreen } from "./canvas/hybrid/hybridViewportMath";
import { modelPointToWorld } from "./canvas/modelSpace";

export interface WallDimensionChipProps {
  /** Exactly-one-selected wall, else null (chip hidden). */
  wall: Wall | null;
  controllerRef: RefObject<HybridViewportController | null>;
  viewportWidth: number;
  viewportHeight: number;
  onCommitLength: (edgeId: string, lengthMm: number, anchor: "a" | "b") => void;
}

export function WallDimensionChip({
  wall,
  controllerRef,
  viewportWidth,
  viewportHeight,
  onCommitLength,
}: WallDimensionChipProps) {
  const chipRef = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [anchor, setAnchor] = useState<"a" | "b">("a");
  const wallRef = useRef(wall);
  wallRef.current = wall;
  const sizeRef = useRef({ width: viewportWidth, height: viewportHeight });
  sizeRef.current = { width: viewportWidth, height: viewportHeight };

  const length = wall
    ? Math.round(
        Math.hypot(
          wall.endPoint.x - wall.startPoint.x,
          wall.endPoint.y - wall.startPoint.y,
        ),
      )
    : 0;

  // Imperative placement loop (reference practice: re-place on camera change,
  // never through React state). One projection serves 2D and 3D.
  useEffect(() => {
    if (!wall) return;
    let raf: number | null = null;
    const place = (): void => {
      raf = typeof window !== "undefined" ? window.requestAnimationFrame(place) : null;
      const el = chipRef.current;
      const current = wallRef.current;
      const controller = controllerRef.current;
      if (!el || !current || !controller) return;
      const mid = {
        x: (current.startPoint.x + current.endPoint.x) / 2,
        y: (current.startPoint.y + current.endPoint.y) / 2,
      };
      controller.camera.updateMatrixWorld();
      const s = worldToScreen(modelPointToWorld(mid), controller.camera, {
        width: Math.max(1, sizeRef.current.width),
        height: Math.max(1, sizeRef.current.height),
      });
      el.style.transform = `translate(${Math.round(s.x - el.offsetWidth / 2)}px, ${Math.round(s.y + 12)}px)`;
    };
    place();
    return () => {
      if (raf != null && typeof window !== "undefined") window.cancelAnimationFrame(raf);
    };
  }, [wall, controllerRef]);

  useEffect(() => {
    // Selection changed → leave edit mode, reset anchor.
    setEditing(false);
    setAnchor("a");
  }, [wall?.id]);

  if (!wall) return null;

  const commit = (): void => {
    const value = Number.parseFloat(draft);
    if (Number.isFinite(value) && value > 0) {
      onCommitLength(wall.id, value, anchor);
    }
    setEditing(false);
  };

  return (
    <div
      ref={chipRef}
      className="absolute left-0 top-0 z-[24] select-none"
      style={{ willChange: "transform" }}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            else if (event.key === "Escape") setEditing(false);
            else if (event.key === "Tab") {
              event.preventDefault();
              setAnchor((prev) => (prev === "a" ? "b" : "a"));
            }
          }}
          className="w-20 rounded border border-[#4f8cff] bg-white px-1.5 py-0.5 text-center text-[11px] tabular-nums shadow-sm outline-none"
          title={`Enter commits; Tab flips the fixed end (now: ${anchor === "a" ? "start" : "end"})`}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(String(length));
            setEditing(true);
          }}
          className="cursor-text rounded border border-slate-300 bg-white/95 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-700 shadow-sm hover:border-[#4f8cff]"
          title="Wall length (mm) — click to edit"
        >
          {length}
        </button>
      )}
    </div>
  );
}
