import { describe, expect, it, vi } from "vitest";

import { createHybridPointerMoveQueue } from "./hybridPointerMoveQueue";

function fixture(consume = vi.fn<(point: number) => void>()) {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  const cancel = vi.fn((id: number) => { frames.delete(id); });
  const queue = createHybridPointerMoveQueue(consume, request, cancel);
  const paint = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  };
  return { queue, consume, frames, request, paint };
}

describe("hybrid pointer move scheduling", () => {
  it("picks and rebuilds once for a high-frequency input burst, using the latest position", () => {
    const f = fixture();
    for (let x = 0; x < 1000; x++) f.queue.push(x);
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.paint();
    expect(f.consume.mock.calls).toEqual([[999]]);
  });

  it("uses the release position even if no frame ran, without replaying stale work", () => {
    const f = fixture();
    f.queue.push(10);
    f.queue.finish(25);
    f.paint();
    expect(f.consume.mock.calls).toEqual([[25]]);
    expect(f.frames.size).toBe(0);
  });

  it("drops cancelled work and accepts a fresh gesture", () => {
    const f = fixture();
    f.queue.push(10);
    f.queue.cancel();
    f.paint();
    expect(f.consume).not.toHaveBeenCalled();
    f.queue.push(40);
    f.paint();
    expect(f.consume.mock.calls).toEqual([[40]]);
  });

  it("keeps a new input scheduled during consumption for the following frame", () => {
    const f = fixture();
    f.consume.mockImplementationOnce(() => { f.queue.push(20); });
    f.queue.push(10);
    f.paint();
    expect(f.consume.mock.calls).toEqual([[10]]);
    f.paint();
    expect(f.consume.mock.calls).toEqual([[10], [20]]);
  });
});
