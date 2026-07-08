"use client";

import { useCallback, useRef } from "react";

export type BlendChangePhase = "start" | "move" | "end";

export interface View3DBlendSliderProps {
  /** Current blend, 0 (pure 2D) … 1 (full 3D). */
  value: number;
  /** Fired continuously while dragging and once on release (`phase === "end"`). */
  onChange: (value: number, phase: BlendChangePhase) => void;
  disabled?: boolean;
  className?: string;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/**
 * Vertical right-edge control that morphs the plan from 2D (bottom) to 3D (top).
 * Owns the `blend` value only — the camera/scene react to it in DrawingCanvas.
 */
export function View3DBlendSlider({
  value,
  onChange,
  disabled = false,
  className = "",
}: View3DBlendSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const valueFromClientY = useCallback(
    (clientY: number): number => {
      const track = trackRef.current;
      if (!track) {
        return value;
      }
      const rect = track.getBoundingClientRect();
      // Bottom of the track = 0 (2D), top = 1 (3D).
      return clamp01(1 - (clientY - rect.top) / Math.max(1, rect.height));
    },
    [value],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (disabled || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      draggingRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onChange(valueFromClientY(event.clientY), "start");
    },
    [disabled, onChange, valueFromClientY],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!draggingRef.current) {
        return;
      }
      event.preventDefault();
      onChange(valueFromClientY(event.clientY), "move");
    },
    [onChange, valueFromClientY],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      if (!draggingRef.current) {
        return;
      }
      draggingRef.current = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      onChange(valueFromClientY(event.clientY), "end");
    },
    [onChange, valueFromClientY],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (disabled) {
        return;
      }
      const step = event.shiftKey ? 0.2 : 0.05;
      if (event.key === "ArrowUp" || event.key === "ArrowRight") {
        onChange(clamp01(value + step), "end");
        event.preventDefault();
      } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
        onChange(clamp01(value - step), "end");
        event.preventDefault();
      } else if (event.key === "Home") {
        onChange(0, "end");
        event.preventDefault();
      } else if (event.key === "End") {
        onChange(1, "end");
        event.preventDefault();
      }
    },
    [disabled, onChange, value],
  );

  const pct = Math.round(clamp01(value) * 100);
  const fillPct = `${clamp01(value) * 100}%`;

  return (
    <div
      className={`pointer-events-auto absolute right-3 top-1/2 z-[24] flex -translate-y-1/2 select-none flex-col items-center gap-2 ${className}`}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span
        className={`text-[10px] font-semibold tracking-wide ${
          pct >= 55 ? "text-sky-600" : "text-slate-400"
        }`}
      >
        3D
      </span>

      <div
        ref={trackRef}
        role="slider"
        aria-label="2D to 3D view blend"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className={`relative h-56 w-9 rounded-full border border-slate-200/80 bg-white/70 shadow-lg backdrop-blur-md transition-opacity ${
          disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer opacity-100"
        }`}
        style={{ touchAction: "none" }}
      >
        {/* Filled portion (grows upward from 2D toward 3D). */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 rounded-full bg-gradient-to-t from-sky-400/70 to-sky-500/80"
          style={{ height: fillPct }}
        />
        {/* Thumb. */}
        <div
          className="pointer-events-none absolute left-1/2 flex h-7 w-7 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full border border-sky-500/80 bg-white text-[9px] font-bold text-sky-600 shadow-md"
          style={{ bottom: fillPct }}
        >
          {pct}
        </div>
      </div>

      <span
        className={`text-[10px] font-semibold tracking-wide ${
          pct <= 45 ? "text-slate-600" : "text-slate-400"
        }`}
      >
        2D
      </span>
    </div>
  );
}

export default View3DBlendSlider;
