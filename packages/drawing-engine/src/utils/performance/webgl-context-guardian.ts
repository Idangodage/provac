/**
 * WebGL Context Guardian
 * 
 * A self-contained module that monitors WebGL context health and proactively
 * prevents GPU crashes by:
 * 
 * 1. Tracking frame render times for jank detection
 * 2. Monitoring draw call counts and triangle budgets
 * 3. Auto-downgrading rendering quality when load is high
 * 4. Providing graceful recovery from context loss
 * 5. Preventing the "hardware acceleration" crash notification
 * 
 * Usage:
 *   const guardian = new WebGLContextGuardian(renderer);
 *   guardian.onQualityChange((level) => { ... });
 *   guardian.beginFrame();
 *   // ...render...
 *   guardian.endFrame();
 */

import * as THREE from 'three';

export type QualityLevel = 'full' | 'reduced' | 'minimal' | 'emergency';

export interface FrameMetrics {
  renderTimeMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

interface GuardianConfig {
  /** Target frame time in ms (default: 16.67 = 60fps) */
  targetFrameTimeMs: number;
  /** Number of consecutive slow frames before downgrade (default: 5) */
  slowFrameThreshold: number;
  /** Number of consecutive fast frames before upgrade (default: 30) */
  fastFrameThreshold: number;
  /** Max triangle count before forced downgrade (default: 400_000) */
  maxTriangles: number;
  /** Max draw calls before forced downgrade (default: 500) */
  maxDrawCalls: number;
}

const DEFAULT_CONFIG: GuardianConfig = {
  targetFrameTimeMs: 16.67,
  slowFrameThreshold: 5,
  fastFrameThreshold: 30,
  maxTriangles: 400_000,
  maxDrawCalls: 500,
};

type QualityCallback = (level: QualityLevel, reason: string) => void;
type ContextLostCallback = () => void;

export class WebGLContextGuardian {
  private renderer: THREE.WebGLRenderer;
  private config: GuardianConfig;
  private currentQuality: QualityLevel = 'full';
  private qualityCallbacks: Set<QualityCallback> = new Set();
  private contextLostCallbacks: Set<ContextLostCallback> = new Set();

  // Frame timing
  private frameStartTime = 0;
  private consecutiveSlowFrames = 0;
  private consecutiveFastFrames = 0;
  private recentFrameTimes: number[] = [];
  private maxSamples = 60;

  // Context state
  private contextLost = false;
  private recoveryAttempts = 0;
  private maxRecoveryAttempts = 3;

  // Bound handlers
  private handleContextLostBound: (e: Event) => void;
  private handleContextRestoredBound: () => void;

  constructor(renderer: THREE.WebGLRenderer, config?: Partial<GuardianConfig>) {
    this.renderer = renderer;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.handleContextLostBound = this.handleContextLost.bind(this);
    this.handleContextRestoredBound = this.handleContextRestored.bind(this);

    const canvas = renderer.domElement;
    canvas.addEventListener('webglcontextlost', this.handleContextLostBound, false);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestoredBound, false);
  }

  /** Call before rendering a frame */
  beginFrame(): void {
    this.frameStartTime = performance.now();
    this.renderer.info.reset();
  }

  /** Call after rendering a frame. Returns frame metrics. */
  endFrame(): FrameMetrics {
    const renderTime = performance.now() - this.frameStartTime;

    const info = this.renderer.info;
    const metrics: FrameMetrics = {
      renderTimeMs: renderTime,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };

    this.recentFrameTimes.push(renderTime);
    if (this.recentFrameTimes.length > this.maxSamples) {
      this.recentFrameTimes.shift();
    }

    this.evaluatePerformance(metrics);
    return metrics;
  }

  /** Register a quality change callback */
  onQualityChange(callback: QualityCallback): () => void {
    this.qualityCallbacks.add(callback);
    return () => this.qualityCallbacks.delete(callback);
  }

  /** Register a context lost callback */
  onContextLost(callback: ContextLostCallback): () => void {
    this.contextLostCallbacks.add(callback);
    return () => this.contextLostCallbacks.delete(callback);
  }

  /** Get current quality level */
  getQuality(): QualityLevel {
    return this.currentQuality;
  }

  /** Is the WebGL context currently healthy? */
  isContextHealthy(): boolean {
    return !this.contextLost;
  }

  /** Get average frame time */
  getAverageFrameTimeMs(): number {
    if (this.recentFrameTimes.length === 0) return 0;
    return this.recentFrameTimes.reduce((a, b) => a + b, 0) / this.recentFrameTimes.length;
  }

  /** Get effective FPS */
  getFPS(): number {
    const avg = this.getAverageFrameTimeMs();
    return avg > 0 ? Math.min(1000 / avg, 120) : 60;
  }

  /**
   * Get recommended pixel ratio based on current quality.
   */
  getRecommendedPixelRatio(): number {
    const base = Math.min(window.devicePixelRatio || 1, 1.5);
    switch (this.currentQuality) {
      case 'full': return base;
      case 'reduced': return Math.min(base, 1.25);
      case 'minimal': return 1;
      case 'emergency': return 0.75;
    }
  }

  /**
   * Get recommended settings for the current quality level.
   */
  getQualitySettings(): {
    antialias: boolean;
    shadows: boolean;
    maxLights: number;
    toneMapping: boolean;
    pixelRatio: number;
  } {
    const pixelRatio = this.getRecommendedPixelRatio();
    switch (this.currentQuality) {
      case 'full':
        return { antialias: true, shadows: true, maxLights: 4, toneMapping: true, pixelRatio };
      case 'reduced':
        return { antialias: false, shadows: false, maxLights: 3, toneMapping: true, pixelRatio };
      case 'minimal':
        return { antialias: false, shadows: false, maxLights: 2, toneMapping: false, pixelRatio };
      case 'emergency':
        return { antialias: false, shadows: false, maxLights: 1, toneMapping: false, pixelRatio };
    }
  }

  /** Force a quality level (e.g. from user settings) */
  forceQuality(level: QualityLevel): void {
    if (this.currentQuality !== level) {
      this.currentQuality = level;
      this.notifyQualityChange('user-requested');
    }
  }

  private evaluatePerformance(metrics: FrameMetrics): void {
    const isSlow = metrics.renderTimeMs > this.config.targetFrameTimeMs * 1.8;
    const isFast = metrics.renderTimeMs < this.config.targetFrameTimeMs * 0.6;
    const isOverBudget =
      metrics.triangles > this.config.maxTriangles ||
      metrics.drawCalls > this.config.maxDrawCalls;

    if (isOverBudget) {
      // Immediately downgrade if over budget
      this.consecutiveSlowFrames = this.config.slowFrameThreshold;
      this.consecutiveFastFrames = 0;
    } else if (isSlow) {
      this.consecutiveSlowFrames++;
      this.consecutiveFastFrames = 0;
    } else if (isFast) {
      this.consecutiveFastFrames++;
      this.consecutiveSlowFrames = 0;
    } else {
      // Neutral frame
      this.consecutiveSlowFrames = Math.max(0, this.consecutiveSlowFrames - 1);
      this.consecutiveFastFrames = 0;
    }

    // Downgrade quality
    if (this.consecutiveSlowFrames >= this.config.slowFrameThreshold) {
      const nextLevel = this.downgradeQuality();
      if (nextLevel) {
        this.currentQuality = nextLevel;
        this.consecutiveSlowFrames = 0;
        this.notifyQualityChange(
          isOverBudget
            ? `Over budget: ${metrics.triangles} tris, ${metrics.drawCalls} draw calls`
            : `Slow frames: avg ${this.getAverageFrameTimeMs().toFixed(1)}ms`
        );
      }
    }

    // Upgrade quality (more conservative)
    if (this.consecutiveFastFrames >= this.config.fastFrameThreshold) {
      const nextLevel = this.upgradeQuality();
      if (nextLevel) {
        this.currentQuality = nextLevel;
        this.consecutiveFastFrames = 0;
        this.notifyQualityChange('Performance headroom available');
      }
    }
  }

  private downgradeQuality(): QualityLevel | null {
    switch (this.currentQuality) {
      case 'full': return 'reduced';
      case 'reduced': return 'minimal';
      case 'minimal': return 'emergency';
      case 'emergency': return null; // Can't go lower
    }
  }

  private upgradeQuality(): QualityLevel | null {
    switch (this.currentQuality) {
      case 'emergency': return 'minimal';
      case 'minimal': return 'reduced';
      case 'reduced': return 'full';
      case 'full': return null; // Already max
    }
  }

  private notifyQualityChange(reason: string): void {
    console.info(`[WebGLGuardian] Quality → ${this.currentQuality}: ${reason}`);
    this.qualityCallbacks.forEach((cb) => cb(this.currentQuality, reason));
  }

  private handleContextLost(event: Event): void {
    event.preventDefault();
    this.contextLost = true;
    this.recoveryAttempts = 0;
    console.warn('[WebGLGuardian] WebGL context lost!');
    this.contextLostCallbacks.forEach((cb) => cb());
  }

  private handleContextRestored(): void {
    this.contextLost = false;
    this.recoveryAttempts++;
    console.info(`[WebGLGuardian] WebGL context restored (attempt ${this.recoveryAttempts})`);

    // After recovery, downgrade to prevent immediate re-crash
    if (this.currentQuality === 'full') {
      this.currentQuality = 'reduced';
      this.notifyQualityChange('Post-recovery safety downgrade');
    } else if (this.currentQuality === 'reduced') {
      this.currentQuality = 'minimal';
      this.notifyQualityChange('Post-recovery safety downgrade');
    }
  }

  dispose(): void {
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.handleContextLostBound, false);
    canvas.removeEventListener('webglcontextrestored', this.handleContextRestoredBound, false);
    this.qualityCallbacks.clear();
    this.contextLostCallbacks.clear();
    this.recentFrameTimes = [];
  }
}
