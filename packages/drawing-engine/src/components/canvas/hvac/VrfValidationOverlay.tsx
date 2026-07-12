'use client';

import { useMemo } from 'react';

import type { HvacElement, Point2D } from '../../../types';
import type {
  ValidationLevel,
  VrfValidationIssue,
  VrfValidationReport,
} from '../../../vrf/rules/validation-engine';
import { MM_TO_PX } from '../scale';

import { readPipeRouteNodes3d } from './pipeRoute3d';
import { resolveVrfValidationIssueElement } from './vrfValidationFixes';

export interface VrfValidationOverlayProps {
  enabled: boolean;
  showMarkers?: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: HvacElement[];
  report: VrfValidationReport;
  onSelectElement?: (elementId: string) => void;
  onApplyFix?: (issue: VrfValidationIssue) => void;
}

const LEVEL_PRIORITY: Record<ValidationLevel, number> = {
  error: 0,
  warning: 1,
  advisory: 2,
  information: 3,
};

const LEVEL_STYLE: Record<ValidationLevel, { fill: string; ring: string; label: string }> = {
  error: { fill: '#dc2626', ring: 'rgba(220,38,38,.24)', label: 'Error' },
  warning: { fill: '#d97706', ring: 'rgba(217,119,6,.22)', label: 'Warning' },
  advisory: { fill: '#2563eb', ring: 'rgba(37,99,235,.2)', label: 'Advisory' },
  information: { fill: '#64748b', ring: 'rgba(100,116,139,.18)', label: 'Information' },
};

function midpoint(points: readonly Point2D[]): Point2D | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0]!;
  let total = 0;
  const lengths: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(
      points[index]!.x - points[index - 1]!.x,
      points[index]!.y - points[index - 1]!.y,
    );
    lengths.push(length);
    total += length;
  }
  if (total <= 1e-9) return points[0]!;
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining > length) {
      remaining -= length;
      continue;
    }
    const start = points[index]!;
    const end = points[index + 1]!;
    const t = length <= 1e-9 ? 0 : remaining / length;
    return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
  }
  return points[points.length - 1]!;
}

function readRoutePoints(element: HvacElement): Point2D[] {
  const route3d = readPipeRouteNodes3d(element);
  if (route3d.length > 0) return route3d.map(({ x, y }) => ({ x, y }));
  const value = element.properties.routePoints;
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const point = candidate as { x?: unknown; y?: unknown };
    return typeof point.x === 'number' && typeof point.y === 'number'
      ? [{ x: point.x, y: point.y }]
      : [];
  });
}

function elementAnchor(element: HvacElement): Point2D {
  return midpoint(readRoutePoints(element)) ?? {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
  };
}

function issueElement(issue: VrfValidationIssue, elements: HvacElement[]): HvacElement | null {
  return resolveVrfValidationIssueElement(issue, elements);
}

/** Lightweight marker layer; validation remains headless and renderer-agnostic. */
export function VrfValidationOverlay({
  enabled,
  showMarkers = true,
  width,
  height,
  viewportZoom,
  panOffset,
  hvacElements,
  report,
  onSelectElement,
  onApplyFix,
}: VrfValidationOverlayProps): JSX.Element | null {
  const visibleIssues = useMemo(
    () => report.issues
      .filter((issue) => issue.level !== 'information')
      .sort((left, right) => LEVEL_PRIORITY[left.level] - LEVEL_PRIORITY[right.level]),
    [report],
  );
  const markers = useMemo(() => {
    const byElement = new Map<string, { element: HvacElement; issues: VrfValidationIssue[] }>();
    for (const issue of report.issues) {
      if (issue.level === 'information') continue;
      const element = issueElement(issue, hvacElements);
      if (!element) continue;
      const existing = byElement.get(element.id);
      if (existing) existing.issues.push(issue);
      else byElement.set(element.id, { element, issues: [issue] });
    }
    return [...byElement.values()].map(({ element, issues }) => ({
      element,
      issues: [...issues].sort((left, right) => LEVEL_PRIORITY[left.level] - LEVEL_PRIORITY[right.level]),
      anchor: elementAnchor(element),
    }));
  }, [hvacElements, report]);

  if (!enabled || visibleIssues.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-[12] overflow-hidden"
      style={{ width, height }}
      aria-label={`${markers.length} VRF validation marker${markers.length === 1 ? '' : 's'}`}
    >
      {showMarkers && markers.map(({ element, issues, anchor }) => {
        const level = issues[0]!.level;
        const style = LEVEL_STYLE[level];
        const left = -panOffset.x * viewportZoom + anchor.x * MM_TO_PX * viewportZoom;
        const top = -panOffset.y * viewportZoom + anchor.y * MM_TO_PX * viewportZoom;
        const title = issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n');
        return (
          <button
            type="button"
            key={element.id}
            className="pointer-events-auto absolute flex h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white shadow"
            style={{ left, top, background: style.fill, boxShadow: `0 0 0 5px ${style.ring}` }}
            title={title}
            onClick={(event) => {
              event.stopPropagation();
              onSelectElement?.(element.id);
            }}
            aria-label={`${style.label} on ${element.label}: ${title}`}
          >
            {issues.length}
          </button>
        );
      })}
      <section
        className="pointer-events-auto absolute right-3 top-3 w-72 overflow-hidden rounded-lg border border-slate-200 bg-white/95 text-slate-700 shadow-lg backdrop-blur"
        aria-label="VRF validation issues"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">VRF checks</div>
            <div className="text-[11px] text-slate-500">
              {report.counts.error} errors · {report.counts.warning} warnings
            </div>
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              report.commitBlocked
                ? 'bg-rose-100 text-rose-700'
                : 'bg-amber-100 text-amber-700'
            }`}
          >
            {report.commitBlocked ? 'Action needed' : 'Review'}
          </span>
        </div>
        <div className="max-h-44 overflow-y-auto py-1">
          {visibleIssues.slice(0, 8).map((issue) => {
            const element = issueElement(issue, hvacElements);
            const style = LEVEL_STYLE[issue.level];
            return (
              <div
                key={issue.id}
                className="flex items-start gap-1 px-1 hover:bg-slate-50"
                title={issue.suggestedFix ?? issue.message}
              >
                <button
                  type="button"
                  disabled={!element}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (element) onSelectElement?.(element.id);
                  }}
                  className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left disabled:cursor-default"
                >
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: style.fill }}
                  />
                  <span className="min-w-0">
                    <span className="block text-[10px] font-semibold text-slate-500">{issue.code}</span>
                    <span className="block text-[11px] leading-4 text-slate-700">{issue.message}</span>
                  </span>
                </button>
                {issue.fix && onApplyFix && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onApplyFix(issue);
                    }}
                    className="mt-1.5 shrink-0 rounded bg-sky-50 px-2 py-1 text-[10px] font-semibold text-sky-700 hover:bg-sky-100"
                    title={issue.suggestedFix ?? 'Apply deterministic fix'}
                  >
                    Fix
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {visibleIssues.length > 8 && (
          <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-500">
            +{visibleIssues.length - 8} more issues
          </div>
        )}
      </section>
    </div>
  );
}
