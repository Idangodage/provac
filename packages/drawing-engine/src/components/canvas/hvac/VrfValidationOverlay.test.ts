import { describe, expect, it } from 'vitest';

import { selectionAfterMarkerClick } from './VrfValidationOverlay';

describe('a click on a design-check marker', () => {
  it('selects its element alone', () => {
    expect(selectionAfterMarkerClick(['unit', 'sd1'], 'rag1', false)).toEqual(['rag1']);
  });

  it('with Shift, Ctrl or ⌘ adds its element to the selection, or takes it out (never blocks multi-select)', () => {
    expect(selectionAfterMarkerClick(['unit', 'sd1'], 'rag1', true)).toEqual(['unit', 'sd1', 'rag1']);
    expect(selectionAfterMarkerClick(['unit', 'sd1', 'rag1'], 'sd1', true)).toEqual(['unit', 'rag1']);
    expect(selectionAfterMarkerClick([], 'rag1', true)).toEqual(['rag1']);
  });
});
