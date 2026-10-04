/** Keep expensive picking/drafting work at display cadence, regardless of mouse polling rate. */
export function createHybridPointerMoveQueue<T>(
  consume: (value: T) => void,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
): { push: (value: T) => void; cancel: () => void; finish: (value: T) => void } {
  let frame: number | null = null;
  let pending: { value: T } | null = null;
  const cancel = (): void => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    pending = null;
  };
  return {
    push(value) {
      pending = { value };
      if (frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        const next = pending;
        pending = null;
        if (next) consume(next.value);
      });
    },
    cancel,
    finish(value) {
      // Pointerup can precede the next frame: commit its actual coordinate,
      // never the last painted preview or a queued hover from another gesture.
      cancel();
      consume(value);
    },
  };
}
