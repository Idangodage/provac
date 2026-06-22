"use client";

export type ProjectionVisualState = {
  blend: number;
  sceneBlend: number;
  pageTiltXDeg: number;
  pageTiltZDeg: number;
  pageScale: number;
  pageShiftX: number;
  pageShiftY: number;
  pageShadowOpacity: number;
  planOpacity: number;
  gridOpacity: number;
  dimensionOpacity: number;
  hvacOpacity: number;
  hvacPlanOpacity: number;
  labelOpacity: number;
  shadowOpacity: number;
  editingLocked: boolean;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) {
    return value >= edge1 ? 1 : 0;
  }
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function getPlanProjectionVisualState(blend: number): ProjectionVisualState {
  const normalizedBlend = clamp01(Number.isFinite(blend) ? blend : 0);
  const sceneBlend = smoothstep(0.15, 0.45, normalizedBlend);
  const hvacReveal = smoothstep(0.015, 0.12, normalizedBlend);
  const hvacPlanFade = smoothstep(0.015, 0.18, normalizedBlend);
  const planFade = smoothstep(0.05, 1, normalizedBlend);
  const pageTilt = smoothstep(0, 1, normalizedBlend);

  return {
    blend: normalizedBlend,
    sceneBlend,
    pageTiltXDeg: lerp(0, 54, pageTilt),
    pageTiltZDeg: lerp(0, -35, pageTilt),
    pageScale: lerp(1, 0.78, pageTilt),
    pageShiftX: lerp(0, 42, pageTilt),
    pageShiftY: lerp(0, -48, pageTilt),
    pageShadowOpacity: lerp(0.12, 0.3, pageTilt),
    planOpacity: lerp(1, 0.18, planFade),
    gridOpacity: lerp(1, 0.045, planFade),
    dimensionOpacity: lerp(1, 0.1, planFade),
    hvacOpacity: hvacReveal,
    hvacPlanOpacity: lerp(1, 0.1, hvacPlanFade),
    labelOpacity: sceneBlend * 0.88,
    shadowOpacity: lerp(0.08, 0.36, sceneBlend),
    editingLocked: normalizedBlend > 0.05,
  };
}
