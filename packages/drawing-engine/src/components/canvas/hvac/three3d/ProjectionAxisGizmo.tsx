"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent,
} from "react";

export type ProjectionAxis = "x" | "y" | "z";

export type ProjectionAxisGizmoVector = {
  x: number;
  y: number;
  z: number;
};

export interface ProjectionAxisGizmoProps {
  className?: string;
  disabled?: boolean;
  value: ProjectionAxisGizmoVector;
  onChange: (nextValue: ProjectionAxisGizmoVector) => void;
  onReset?: () => void;
}

type Point = {
  x: number;
  y: number;
};

type AxisGeometry = {
  end: Point;
  color: string;
  darkColor: string;
  gradientId: string;
};

const VIEWBOX_SIZE = 156;
const ORIGIN: Point = { x: 78, y: 91 };
const TRACKBALL_RADIUS = 58;
const AXES: Record<ProjectionAxis, AxisGeometry> = {
  x: {
    end: { x: 136, y: 122 },
    color: "#dc2626",
    darkColor: "#7f1d1d",
    gradientId: "projection-axis-x",
  },
  y: {
    end: { x: 20, y: 122 },
    color: "#0284c7",
    darkColor: "#075985",
    gradientId: "projection-axis-y",
  },
  z: {
    end: { x: 78, y: 18 },
    color: "#22c55e",
    darkColor: "#15803d",
    gradientId: "projection-axis-z",
  },
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function clampUnit(value: number): number {
  return clamp(value, 0, 1);
}

function normalizeVector(value: ProjectionAxisGizmoVector): ProjectionAxisGizmoVector {
  return {
    x: clamp(value.x, -1, 1),
    y: clamp(value.y, -1, 1),
    z: clampUnit(value.z),
  };
}

function resolveTrackballVector(pointer: Point): ProjectionAxisGizmoVector {
  const rawX = (pointer.x - ORIGIN.x) / TRACKBALL_RADIUS;
  const rawY = (ORIGIN.y - pointer.y) / TRACKBALL_RADIUS;
  const length = Math.hypot(rawX, rawY);
  if (length <= 0.001) {
    return { x: 0, y: 0, z: 0 };
  }
  const scale = Math.min(1, length) / length;
  const x = rawX * scale;
  const y = rawY * scale;

  return {
    x,
    y,
    z: clampUnit(length),
  };
}

function vectorMagnitude(value: ProjectionAxisGizmoVector): number {
  return clampUnit(Math.max(Math.abs(value.x), Math.abs(value.y), value.z));
}

function vectorToScreenPoint(value: ProjectionAxisGizmoVector): Point {
  const normalized = normalizeVector(value);
  return {
    x: ORIGIN.x + normalized.x * TRACKBALL_RADIUS,
    y: ORIGIN.y - normalized.y * TRACKBALL_RADIUS,
  };
}

function buildConePoints(axis: ProjectionAxis): string {
  const axisGeometry = AXES[axis];
  const dx = axisGeometry.end.x - ORIGIN.x;
  const dy = axisGeometry.end.y - ORIGIN.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const coneLength = axis === "z" ? 31 : 26;
  const coneWidth = axis === "z" ? 25 : 21;
  const base = {
    x: axisGeometry.end.x - ux * coneLength,
    y: axisGeometry.end.y - uy * coneLength,
  };
  return [
    `${axisGeometry.end.x},${axisGeometry.end.y}`,
    `${base.x + px * coneWidth * 0.5},${base.y + py * coneWidth * 0.5}`,
    `${base.x - px * coneWidth * 0.5},${base.y - py * coneWidth * 0.5}`,
  ].join(" ");
}

function buildArcPath(radius: number): string {
  return [
    `M ${ORIGIN.x - radius} ${ORIGIN.y}`,
    `A ${radius} ${radius * 0.34} 0 0 0 ${ORIGIN.x + radius} ${ORIGIN.y}`,
  ].join(" ");
}

export function ProjectionAxisGizmo({
  className = "",
  disabled = false,
  value,
  onChange,
  onReset,
}: ProjectionAxisGizmoProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const resolvePointer = useCallback((event: PointerEvent<SVGElement>): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return ORIGIN;
    }
    return {
      x: ((event.clientX - rect.left) / rect.width) * VIEWBOX_SIZE,
      y: ((event.clientY - rect.top) / rect.height) * VIEWBOX_SIZE,
    };
  }, []);

  const updateFromPointer = useCallback(
    (event: PointerEvent<SVGElement>) => {
      onChange(resolveTrackballVector(resolvePointer(event)));
    },
    [onChange, resolvePointer],
  );

  const startDrag = useCallback(
    (event: PointerEvent<SVGElement>) => {
      if (disabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      activePointerIdRef.current = event.pointerId;
      svgRef.current?.setPointerCapture(event.pointerId);
      updateFromPointer(event);
    },
    [disabled, updateFromPointer],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (disabled || activePointerIdRef.current !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateFromPointer(event);
    },
    [disabled, updateFromPointer],
  );

  const finishDrag = useCallback((event: PointerEvent<SVGSVGElement>) => {
    if (activePointerIdRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (svgRef.current?.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }
    activePointerIdRef.current = null;
  }, []);

  const handleReset = useCallback(
    (event: PointerEvent<SVGElement>) => {
      if (disabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onReset?.();
      onChange({ x: 0, y: 0, z: 0 });
    },
    [disabled, onChange, onReset],
  );

  const normalizedValue = normalizeVector(value);
  const amount = vectorMagnitude(normalizedValue);
  const handlePoint = vectorToScreenPoint(normalizedValue);
  const sphereHighlight = {
    cx: ORIGIN.x - normalizedValue.x * 10,
    cy: ORIGIN.y + normalizedValue.y * 10 - 18,
  };

  const axisElements = useMemo(
    () =>
      (["y", "x", "z"] as ProjectionAxis[]).map((axis) => {
        const axisGeometry = AXES[axis];
        return (
          <g key={axis}>
            <line
              x1={ORIGIN.x}
              y1={ORIGIN.y}
              x2={axisGeometry.end.x}
              y2={axisGeometry.end.y}
              stroke={axisGeometry.darkColor}
              strokeWidth={3}
              strokeLinecap="round"
              opacity={disabled ? 0.3 : 0.88}
            />
            <line
              x1={ORIGIN.x}
              y1={ORIGIN.y}
              x2={axisGeometry.end.x}
              y2={axisGeometry.end.y}
              stroke={axisGeometry.color}
              strokeWidth={1.4}
              strokeLinecap="round"
              opacity={disabled ? 0.24 : 0.76}
            />
            <polygon
              points={buildConePoints(axis)}
              fill={`url(#${axisGeometry.gradientId})`}
              stroke={axisGeometry.darkColor}
              strokeWidth={1.2}
              opacity={disabled ? 0.34 : 1}
            />
          </g>
        );
      }),
    [disabled],
  );

  return (
    <div
      className={`rounded-lg border border-slate-200 bg-white/92 p-2 shadow-lg backdrop-blur ${className}`}
      style={{ opacity: disabled ? 0.54 : 1 }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <svg
        ref={svgRef}
        width={156}
        height={156}
        viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
        role="slider"
        aria-label="3D projection trackball control"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(amount * 100)}
        className={`block select-none touch-none ${
          disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
        }`}
        onPointerDown={startDrag}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <defs>
          <linearGradient id="projection-axis-x" x1="0" x2="1">
            <stop offset="0%" stopColor="#fca5a5" />
            <stop offset="100%" stopColor="#dc2626" />
          </linearGradient>
          <linearGradient id="projection-axis-y" x1="0" x2="1">
            <stop offset="0%" stopColor="#7dd3fc" />
            <stop offset="100%" stopColor="#0284c7" />
          </linearGradient>
          <linearGradient id="projection-axis-z" x1="0" x2="1" y1="1" y2="0">
            <stop offset="0%" stopColor="#86efac" />
            <stop offset="100%" stopColor="#22c55e" />
          </linearGradient>
          <radialGradient
            id="projection-trackball"
            cx={`${sphereHighlight.cx / VIEWBOX_SIZE}`}
            cy={`${sphereHighlight.cy / VIEWBOX_SIZE}`}
            r="0.72"
          >
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="48%" stopColor="#f8fafc" />
            <stop offset="100%" stopColor="#cbd5e1" />
          </radialGradient>
          <radialGradient id="projection-origin" cx="36%" cy="28%" r="68%">
            <stop offset="0%" stopColor="#f8fafc" />
            <stop offset="100%" stopColor="#334155" />
          </radialGradient>
        </defs>

        <circle
          cx={ORIGIN.x}
          cy={ORIGIN.y}
          r={TRACKBALL_RADIUS}
          fill="url(#projection-trackball)"
          stroke="#cbd5e1"
          strokeWidth={1.2}
          opacity={disabled ? 0.45 : 0.82}
        />
        <path d={buildArcPath(45)} fill="none" stroke="#e2e8f0" strokeWidth={1} />
        <path d={buildArcPath(29)} fill="none" stroke="#e2e8f0" strokeWidth={1} />
        <ellipse
          cx={ORIGIN.x}
          cy={ORIGIN.y}
          rx={TRACKBALL_RADIUS}
          ry={TRACKBALL_RADIUS * 0.34}
          fill="none"
          stroke="#94a3b8"
          strokeDasharray="4 5"
          opacity={0.52}
        />
        {axisElements}
        {amount > 0.01 && (
          <>
            <line
              x1={ORIGIN.x}
              y1={ORIGIN.y}
              x2={handlePoint.x}
              y2={handlePoint.y}
              stroke="#f59e0b"
              strokeWidth={3}
              strokeLinecap="round"
              opacity={0.92}
              pointerEvents="none"
            />
            <circle
              cx={handlePoint.x}
              cy={handlePoint.y}
              r={6}
              fill="#f59e0b"
              stroke="#92400e"
              strokeWidth={1.2}
              pointerEvents="none"
            />
          </>
        )}
        <circle
          cx={ORIGIN.x}
          cy={ORIGIN.y}
          r={7.5}
          fill="url(#projection-origin)"
          stroke="#0f172a"
          strokeWidth={1}
          className={disabled ? "cursor-not-allowed" : "cursor-pointer"}
          onPointerDown={handleReset}
        />
      </svg>
    </div>
  );
}
