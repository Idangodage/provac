import { beforeEach, describe, expect, it } from 'vitest';

import { domainOf, focusId, sameFocus, useSegmentUiStore, type SegmentFocus } from './segmentUiStore';

const duct: SegmentFocus = { runId: 'r1', key: 'leg:0', anchorMark: 'S-001', view: '2d' };
const pipe: SegmentFocus = { domain: 'refrigerant', runId: 'r1', key: 'leg:0', anchorMark: 'S-001', view: '2d' };

describe('segment focus', () => {
  it('reads a focus without a domain as a duct (the first service with cards)', () => {
    expect(domainOf(duct)).toBe('duct');
    expect(domainOf({ domain: 'duct' })).toBe('duct');
    expect(domainOf(pipe)).toBe('refrigerant');
    expect(domainOf(null)).toBe('duct');
  });

  it('tells pieces of different services apart, even with the same run id and key', () => {
    expect(focusId(duct)).not.toBe(focusId(pipe));
    expect(focusId({ ...duct, domain: 'duct' })).toBe(focusId(duct));
    expect(focusId(null)).toBe('');
    expect(sameFocus(duct, pipe)).toBe(false);
    expect(sameFocus(duct, { ...duct, domain: 'duct' })).toBe(true);
    // The part pointed at and the view still count, as before.
    expect(sameFocus(duct, { ...duct, anchorMark: 'S-002' })).toBe(false);
    expect(sameFocus(duct, { ...duct, view: '3d' })).toBe(false);
  });
});

describe('segment UI store', () => {
  beforeEach(() => useSegmentUiStore.setState({ hovered: null, pinned: null, preview: null }));

  it('keeps one pinned card whatever its service, and pinning drops a preview', () => {
    const store = useSegmentUiStore.getState();
    store.pin(duct);
    store.setPreview({ optionId: 'a', updates: [] });
    store.pin(pipe);
    expect(useSegmentUiStore.getState().pinned).toBe(pipe);
    expect(useSegmentUiStore.getState().preview).toBeNull();
  });

  it('changes nothing for the same preview, and does for another service or what it adds or removes', () => {
    const updates: never[] = [];
    const add: never[] = [];
    const store = useSegmentUiStore.getState();
    store.setPreview({ optionId: 'a', updates });
    const first = useSegmentUiStore.getState().preview;
    store.setPreview({ optionId: 'a', updates });
    expect(useSegmentUiStore.getState().preview).toBe(first);
    store.setPreview({ domain: 'duct', optionId: 'a', updates });
    expect(useSegmentUiStore.getState().preview).toBe(first);
    store.setPreview({ domain: 'condensate', optionId: 'a', updates });
    expect(useSegmentUiStore.getState().preview).not.toBe(first);
    const condensate = useSegmentUiStore.getState().preview;
    store.setPreview({ domain: 'condensate', optionId: 'a', updates, add });
    expect(useSegmentUiStore.getState().preview).not.toBe(condensate);
    store.setPreview({ domain: 'condensate', optionId: 'a', updates, add, removeIds: ['x'] });
    expect(useSegmentUiStore.getState().preview?.removeIds).toEqual(['x']);
  });
});
