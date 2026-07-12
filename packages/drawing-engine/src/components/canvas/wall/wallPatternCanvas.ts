import type {
  WallPatternKind,
  WallSurfaceVisual,
  WallVisualStyle,
} from '../../../attributes';

export type WallPatternUsage = 'plan-cut' | 'model-surface';

function drawDiagonal(
  context: CanvasRenderingContext2D,
  size: number,
  reverse = false
): void {
  const step = size / 2;
  for (let offset = -size; offset <= size * 2; offset += step) {
    context.beginPath();
    if (reverse) {
      context.moveTo(offset, 0);
      context.lineTo(offset - size, size);
    } else {
      context.moveTo(offset, size);
      context.lineTo(offset + size, 0);
    }
    context.stroke();
  }
}

function drawRunningBond(context: CanvasRenderingContext2D, size: number): void {
  const course = size / 2;
  context.beginPath();
  context.moveTo(0, 0.5);
  context.lineTo(size, 0.5);
  context.moveTo(0, course);
  context.lineTo(size, course);
  context.moveTo(0, size - 0.5);
  context.lineTo(size, size - 0.5);
  context.moveTo(size / 2, 0);
  context.lineTo(size / 2, course);
  context.moveTo(0.5, course);
  context.lineTo(0.5, size);
  context.moveTo(size - 0.5, course);
  context.lineTo(size - 0.5, size);
  context.stroke();
}

function drawAggregate(context: CanvasRenderingContext2D, size: number): void {
  const points = [
    [0.14, 0.2, 0.026],
    [0.43, 0.12, 0.018],
    [0.76, 0.28, 0.032],
    [0.28, 0.53, 0.022],
    [0.61, 0.63, 0.018],
    [0.88, 0.78, 0.025],
    [0.12, 0.86, 0.016],
    [0.48, 0.91, 0.028],
  ] as const;
  points.forEach(([x, y, radius], index) => {
    context.beginPath();
    context.arc(x * size, y * size, Math.max(0.8, radius * size), 0, Math.PI * 2);
    if (index % 3 === 0) context.fill();
    else context.stroke();
  });
}

function drawWoodGrain(context: CanvasRenderingContext2D, size: number): void {
  [0.22, 0.5, 0.78].forEach((row, index) => {
    const y = row * size;
    const amplitude = size * (index === 1 ? 0.09 : 0.055);
    context.beginPath();
    context.moveTo(0, y);
    context.bezierCurveTo(size * 0.2, y - amplitude, size * 0.35, y + amplitude, size * 0.52, y);
    context.bezierCurveTo(size * 0.7, y - amplitude, size * 0.84, y + amplitude, size, y);
    context.stroke();
  });
}

function drawInsulation(context: CanvasRenderingContext2D, size: number): void {
  const amplitude = size * 0.16;
  const center = size / 2;
  context.beginPath();
  context.moveTo(0, center);
  for (let step = 1; step <= 24; step += 1) {
    const x = (step / 24) * size;
    const y = center + Math.sin((step / 24) * Math.PI * 4) * amplitude;
    context.lineTo(x, y);
  }
  context.stroke();
}

function paintPattern(
  context: CanvasRenderingContext2D,
  size: number,
  pattern: WallPatternKind
): void {
  switch (pattern) {
    case 'running-bond':
      drawRunningBond(context, size);
      return;
    case 'aggregate':
      drawAggregate(context, size);
      return;
    case 'wood-grain':
      drawWoodGrain(context, size);
      return;
    case 'crosshatch':
      drawDiagonal(context, size);
      drawDiagonal(context, size, true);
      return;
    case 'insulation':
      drawInsulation(context, size);
      return;
    case 'diagonal':
    default:
      drawDiagonal(context, size);
  }
}

/**
 * Builds the same restrained procedural motif for plan and 3D. The plan tile
 * receives drafting colors; the model tile is neutral and is multiplied by
 * the canonical surface color in the Three.js material.
 */
export function createWallPatternCanvas(
  style: WallVisualStyle,
  usage: WallPatternUsage
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;

  const size = usage === 'plan-cut' ? style.plan.patternTilePx : 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.fillStyle = usage === 'plan-cut' ? style.plan.fillColor : '#ffffff';
  context.fillRect(0, 0, size, size);
  context.lineWidth = usage === 'plan-cut' ? 1 : 1.15;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = usage === 'plan-cut'
    ? style.plan.patternColor
    : `rgba(24, 32, 42, ${style.surface.patternOpacity})`;
  context.fillStyle = context.strokeStyle;

  paintPattern(
    context,
    size,
    usage === 'plan-cut' ? style.plan.pattern : style.surface.pattern
  );
  return canvas;
}

export function createWallSurfacePatternCanvas(
  surface: WallSurfaceVisual
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;

  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  context.lineWidth = 1.15;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = `rgba(24, 32, 42, ${surface.patternOpacity})`;
  context.fillStyle = context.strokeStyle;
  paintPattern(context, size, surface.pattern);
  return canvas;
}
