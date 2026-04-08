/**
 * Performance utilities index.
 * 
 * Centralized exports for GPU monitoring, material pooling,
 * geometry optimization, and render scheduling.
 */

export { GPUResourceMonitor } from './gpu-monitor';
export { MaterialPool } from './material-pool';
export { GeometryOptimizer } from './geometry-optimizer';
export { RenderScheduler } from './render-scheduler';
export { ObjectPoolManager } from './object-pool';
export { WebGLContextGuardian } from './webgl-context-guardian';
export type { QualityLevel, FrameMetrics } from './webgl-context-guardian';
