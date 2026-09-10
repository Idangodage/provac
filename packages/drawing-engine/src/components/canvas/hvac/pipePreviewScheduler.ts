/** Only the newest pointer sample matters for a visual frame. Release flushes
 * that sample synchronously; cancellation can never publish a queued preview. */
export function createPipePreviewScheduler<T>(consume: (value: T) => void,
  request: (callback: () => void) => number = callback => requestAnimationFrame(callback),
  cancel: (id: number) => void = id => cancelAnimationFrame(id)) {
  let frame: number | null = null;
  let queued: { value: T } | null = null;
  const flush = () => {
    if (frame !== null) cancel(frame);
    frame = null;
    const next = queued; queued = null;
    if (next) consume(next.value);
  };
  return {
    schedule(value: T) { queued = { value }; if (frame === null) frame = request(flush); },
    flush,
    cancel() { if (frame !== null) cancel(frame); frame = null; queued = null; },
  };
}
