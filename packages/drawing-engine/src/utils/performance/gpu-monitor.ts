/**
 * GPU Resource Monitor
 * 
 * Tracks WebGL resource usage and prevents GPU context exhaustion.
 * Monitors geometry count, texture memory, draw calls, and provides
 * proactive warnings before hardware acceleration crashes occur.
 */

import * as THREE from 'three';

export interface GPUResourceStats {
  geometries: number;
  textures: number;
  programs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  estimatedMemoryMB: number;
  contextHealthy: boolean;
}

export interface GPUResourceLimits {
  maxGeometries: number;
  maxTextures: number;
  maxTriangles: number;
  maxEstimatedMemoryMB: number;
  warningThreshold: number; // 0-1 ratio before limits
}

const DEFAULT_LIMITS: GPUResourceLimits = {
  maxGeometries: 2000,
  maxTextures: 256,
  maxTriangles: 500_000,
  maxEstimatedMemoryMB: 512,
  warningThreshold: 0.75,
};

type ResourceCallback = (stats: GPUResourceStats, warning: string | null) => void;

export class GPUResourceMonitor {
  private renderer: THREE.WebGLRenderer | null = null;
  private limits: GPUResourceLimits;
  private listeners: Set<ResourceCallback> = new Set();
  private lastStats: GPUResourceStats | null = null;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private contextLost = false;

  /** Estimated bytes per triangle (vertex data + index) */
  private static readonly BYTES_PER_TRIANGLE = 144;
  /** Estimated bytes per texture pixel (RGBA) */
  private static readonly BYTES_PER_TEXEL = 4;

  constructor(limits?: Partial<GPUResourceLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  attach(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
    this.contextLost = false;

    const canvas = renderer.domElement;
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  detach(): void {
    if (this.renderer) {
      const canvas = this.renderer.domElement;
      canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    }
    this.renderer = null;
    this.stopPolling();
  }

  startPolling(intervalMs = 2000): void {
    this.stopPolling();
    this.pollIntervalId = setInterval(() => {
      this.check();
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }

  onUpdate(callback: ResourceCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  check(): GPUResourceStats {
    const stats = this.getStats();
    this.lastStats = stats;

    const warning = this.evaluateHealth(stats);
    this.listeners.forEach((cb) => cb(stats, warning));

    return stats;
  }

  getStats(): GPUResourceStats {
    if (!this.renderer) {
      return {
        geometries: 0,
        textures: 0,
        programs: 0,
        drawCalls: 0,
        triangles: 0,
        points: 0,
        lines: 0,
        estimatedMemoryMB: 0,
        contextHealthy: !this.contextLost,
      };
    }

    const info = this.renderer.info;
    const mem = info.memory;
    const render = info.render;

    const triangleBytes = render.triangles * GPUResourceMonitor.BYTES_PER_TRIANGLE;
    const textureBytes = mem.textures * 512 * 512 * GPUResourceMonitor.BYTES_PER_TEXEL; // conservative estimate
    const estimatedMemoryMB = (triangleBytes + textureBytes) / (1024 * 1024);

    return {
      geometries: mem.geometries,
      textures: mem.textures,
      programs: info.programs?.length ?? 0,
      drawCalls: render.calls,
      triangles: render.triangles,
      points: render.points,
      lines: render.lines,
      estimatedMemoryMB,
      contextHealthy: !this.contextLost,
    };
  }

  getLastStats(): GPUResourceStats | null {
    return this.lastStats;
  }

  isContextHealthy(): boolean {
    return !this.contextLost;
  }

  /**
   * Check if adding the specified resources would exceed safe limits.
   * Use before creating large geometry batches.
   */
  canAccommodate(additionalTriangles: number, additionalGeometries = 1): boolean {
    const stats = this.lastStats ?? this.getStats();
    return (
      stats.triangles + additionalTriangles < this.limits.maxTriangles * this.limits.warningThreshold &&
      stats.geometries + additionalGeometries < this.limits.maxGeometries * this.limits.warningThreshold
    );
  }

  /**
   * Get a quality scale factor (0-1) based on current GPU load.
   * Use this to dynamically adjust LOD, segment counts, etc.
   */
  getQualityScale(): number {
    const stats = this.lastStats ?? this.getStats();
    if (!stats.contextHealthy) return 0.25;

    const triRatio = stats.triangles / this.limits.maxTriangles;
    const geoRatio = stats.geometries / this.limits.maxGeometries;
    const memRatio = stats.estimatedMemoryMB / this.limits.maxEstimatedMemoryMB;

    const maxRatio = Math.max(triRatio, geoRatio, memRatio);

    if (maxRatio < 0.3) return 1.0;
    if (maxRatio < 0.5) return 0.85;
    if (maxRatio < 0.7) return 0.6;
    if (maxRatio < 0.85) return 0.4;
    return 0.25;
  }

  private evaluateHealth(stats: GPUResourceStats): string | null {
    if (!stats.contextHealthy) {
      return 'WebGL context lost. GPU resources exhausted.';
    }

    const warnings: string[] = [];
    const threshold = this.limits.warningThreshold;

    if (stats.geometries > this.limits.maxGeometries * threshold) {
      warnings.push(`High geometry count: ${stats.geometries}/${this.limits.maxGeometries}`);
    }
    if (stats.triangles > this.limits.maxTriangles * threshold) {
      warnings.push(`High triangle count: ${stats.triangles}/${this.limits.maxTriangles}`);
    }
    if (stats.estimatedMemoryMB > this.limits.maxEstimatedMemoryMB * threshold) {
      warnings.push(`High GPU memory: ~${stats.estimatedMemoryMB.toFixed(0)}MB/${this.limits.maxEstimatedMemoryMB}MB`);
    }

    return warnings.length > 0 ? warnings.join('; ') : null;
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    console.warn('[GPUResourceMonitor] WebGL context lost');
    this.check();
  };

  private handleContextRestored = (): void => {
    this.contextLost = false;
    console.info('[GPUResourceMonitor] WebGL context restored');
    this.check();
  };

  dispose(): void {
    this.detach();
    this.listeners.clear();
    this.lastStats = null;
  }
}
