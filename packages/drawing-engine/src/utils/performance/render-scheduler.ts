/**
 * Render Scheduler
 * 
 * Intelligent render loop that prevents unnecessary GPU work:
 * - Skips rendering when nothing has changed
 * - Throttles render calls during rapid state changes
 * - Supports priority-based render requests (interaction > data update > idle)
 * - Provides frame budget monitoring
 */

const TARGET_FPS = 60;
const FRAME_BUDGET_MS = 1000 / TARGET_FPS;
const IDLE_TIMEOUT_MS = 3000;
const INTERACTION_THROTTLE_MS = 16; // ~60fps
const DATA_UPDATE_THROTTLE_MS = 50; // ~20fps for data changes

export type RenderPriority = 'interaction' | 'data-update' | 'idle';

type RenderCallback = (deltaMs: number, priority: RenderPriority) => void;

export class RenderScheduler {
  private animationFrameId = 0;
  private running = false;
  private renderCallback: RenderCallback | null = null;
  private lastRenderTime = 0;
  private lastInteractionTime = 0;
  private pendingPriority: RenderPriority | null = null;
  private dirty = false;
  private idleCallbackId: ReturnType<typeof setTimeout> | null = null;

  /** Performance metrics */
  private frameTimes: number[] = [];
  private maxFrameTimeSamples = 60;

  /**
   * Start the render loop with the given callback.
   */
  start(callback: RenderCallback): void {
    this.renderCallback = callback;
    this.running = true;
    this.dirty = true;
    this.lastRenderTime = performance.now();
    this.tick();
  }

  /**
   * Stop the render loop.
   */
  stop(): void {
    this.running = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
    if (this.idleCallbackId) {
      clearTimeout(this.idleCallbackId);
      this.idleCallbackId = null;
    }
  }

  /**
   * Request a render at the specified priority.
   * Higher priority requests override lower ones within the same frame.
   */
  requestRender(priority: RenderPriority = 'data-update'): void {
    this.dirty = true;
    if (priority === 'interaction') {
      this.lastInteractionTime = performance.now();
    }
    if (!this.pendingPriority || priorityRank(priority) > priorityRank(this.pendingPriority)) {
      this.pendingPriority = priority;
    }
  }

  /**
   * Mark interaction start (e.g. orbit controls start dragging).
   * Keeps the render loop at interaction priority until endInteraction().
   */
  beginInteraction(): void {
    this.lastInteractionTime = performance.now();
    this.requestRender('interaction');
  }

  /**
   * Mark interaction end. Renders will downgrade to idle after timeout.
   */
  endInteraction(): void {
    this.requestRender('data-update');
  }

  /**
   * Get average frame time over last N frames.
   */
  getAverageFrameTimeMs(): number {
    if (this.frameTimes.length === 0) return 0;
    const sum = this.frameTimes.reduce((a, b) => a + b, 0);
    return sum / this.frameTimes.length;
  }

  /**
   * Get current effective FPS.
   */
  getCurrentFPS(): number {
    const avg = this.getAverageFrameTimeMs();
    return avg > 0 ? 1000 / avg : 0;
  }

  /**
   * Check if the render loop is currently GPU-bound (frames taking too long).
   */
  isGPUBound(): boolean {
    return this.getAverageFrameTimeMs() > FRAME_BUDGET_MS * 1.5;
  }

  private tick = (): void => {
    if (!this.running) return;

    this.animationFrameId = requestAnimationFrame(this.tick);

    const now = performance.now();
    const delta = now - this.lastRenderTime;

    // Determine effective priority
    const isInteracting = now - this.lastInteractionTime < 200;
    const priority = isInteracting
      ? 'interaction'
      : this.pendingPriority ?? 'idle';

    // Throttle based on priority
    const throttle = priority === 'interaction'
      ? INTERACTION_THROTTLE_MS
      : priority === 'data-update'
        ? DATA_UPDATE_THROTTLE_MS
        : IDLE_TIMEOUT_MS;

    if (!this.dirty && delta < throttle) {
      return;
    }

    // Execute render
    if (this.renderCallback && this.dirty) {
      const renderStart = performance.now();
      this.renderCallback(delta, priority);
      const renderDuration = performance.now() - renderStart;

      // Track frame times
      this.frameTimes.push(renderDuration);
      if (this.frameTimes.length > this.maxFrameTimeSamples) {
        this.frameTimes.shift();
      }

      this.dirty = false;
      this.pendingPriority = null;
      this.lastRenderTime = now;
    }
  };

  dispose(): void {
    this.stop();
    this.renderCallback = null;
    this.frameTimes = [];
  }
}

function priorityRank(priority: RenderPriority): number {
  switch (priority) {
    case 'interaction': return 3;
    case 'data-update': return 2;
    case 'idle': return 1;
  }
}
