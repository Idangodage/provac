const DRAG_PERF_STORAGE_KEY = 'drawing.dragPerf';
const DRAG_PERF_REPORT_INTERVAL_MS = 1200;

type DragPerfDetails = Record<string, number | undefined>;

type DragPerfBucket = {
  count: number;
  totalMs: number;
  maxMs: number;
  detailTotals: Record<string, number>;
};

type DragPerfState = {
  samples: number;
  lastReportAt: number;
  buckets: Map<string, DragPerfBucket>;
};

type DragPerfWindow = Window & {
  __DRAWING_DRAG_PERF__?: boolean;
  __DRAWING_DRAG_PERF_STATE__?: DragPerfState;
};

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function getPerfWindow(): DragPerfWindow | null {
  if (typeof window === 'undefined') return null;
  return window as DragPerfWindow;
}

function getState(win: DragPerfWindow): DragPerfState {
  if (!win.__DRAWING_DRAG_PERF_STATE__) {
    win.__DRAWING_DRAG_PERF_STATE__ = {
      samples: 0,
      lastReportAt: nowMs(),
      buckets: new Map<string, DragPerfBucket>(),
    };
  }
  return win.__DRAWING_DRAG_PERF_STATE__;
}

export function isDragPerfEnabled(): boolean {
  const win = getPerfWindow();
  if (!win) return false;

  if (typeof win.__DRAWING_DRAG_PERF__ === 'boolean') {
    return win.__DRAWING_DRAG_PERF__;
  }

  try {
    return window.localStorage.getItem(DRAG_PERF_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function startDragPerfTimer(): number {
  if (!isDragPerfEnabled()) return 0;
  return nowMs();
}

function flushDragPerf(state: DragPerfState): void {
  const rows = Array.from(state.buckets.entries())
    .sort((left, right) => right[1].totalMs - left[1].totalMs)
    .map(([phase, bucket]) => {
      const row: Record<string, number | string> = {
        phase,
        count: bucket.count,
        totalMs: Number(bucket.totalMs.toFixed(2)),
        avgMs: Number((bucket.totalMs / bucket.count).toFixed(3)),
        maxMs: Number(bucket.maxMs.toFixed(3)),
      };
      Object.keys(bucket.detailTotals).forEach((key) => {
        row[`avg:${key}`] = Number((bucket.detailTotals[key] / bucket.count).toFixed(2));
      });
      return row;
    });

  if (rows.length === 0) return;

  const intervalMs = Math.max(1, nowMs() - state.lastReportAt);
  const samplesPerSecond = Number(((state.samples * 1000) / intervalMs).toFixed(1));
  console.groupCollapsed(
    `[drag-perf] ${state.samples} samples | ${samplesPerSecond} samples/s`
  );
  console.table(rows);
  console.groupEnd();

  state.samples = 0;
  state.lastReportAt = nowMs();
  state.buckets.clear();
}

export function endDragPerfTimer(
  phase: string,
  startedAt: number,
  details?: DragPerfDetails
): void {
  if (startedAt <= 0) return;
  const win = getPerfWindow();
  if (!win) return;
  const state = getState(win);

  const durationMs = Math.max(0, nowMs() - startedAt);
  const bucket = state.buckets.get(phase) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    detailTotals: {},
  };

  bucket.count += 1;
  bucket.totalMs += durationMs;
  bucket.maxMs = Math.max(bucket.maxMs, durationMs);

  if (details) {
    Object.entries(details).forEach(([key, value]) => {
      if (!Number.isFinite(value)) return;
      bucket.detailTotals[key] = (bucket.detailTotals[key] ?? 0) + (value as number);
    });
  }

  state.samples += 1;
  state.buckets.set(phase, bucket);

  if (nowMs() - state.lastReportAt >= DRAG_PERF_REPORT_INTERVAL_MS) {
    flushDragPerf(state);
  }
}

