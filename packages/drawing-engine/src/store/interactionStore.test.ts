import { beforeEach, describe, expect, it } from 'vitest';

import { useDrawingInteractionStore } from './interactionStore';

describe('drawing interaction viewport firewall', () => {
  beforeEach(() => {
    useDrawingInteractionStore.getState().resetInteractionState();
  });

  it('keeps the last known-good viewport when a non-finite frame arrives', () => {
    useDrawingInteractionStore.getState().setViewTransform(2, { x: 40, y: -12 });
    useDrawingInteractionStore.getState().setViewTransform(Number.NaN, {
      x: Number.POSITIVE_INFINITY,
      y: 5,
    });

    expect(useDrawingInteractionStore.getState().zoom).toBe(2);
    expect(useDrawingInteractionStore.getState().panOffset).toEqual({ x: 40, y: -12 });
  });
});
