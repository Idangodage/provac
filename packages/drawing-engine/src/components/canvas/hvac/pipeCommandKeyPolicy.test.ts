import { describe, expect, it } from 'vitest';

import { resolvePipeCommandKeyAction } from './pipeCommandKeyPolicy';

describe('resolvePipeCommandKeyAction', () => {
  it('cancels rather than committing every active route on Escape', () => {
    expect(resolvePipeCommandKeyAction('Escape', 1)).toBe('cancel');
    expect(resolvePipeCommandKeyAction('Escape', 2)).toBe('cancel');
    expect(resolvePipeCommandKeyAction('Escape', 8)).toBe('cancel');
  });

  it('accepts on Enter and ignores Escape while idle', () => {
    expect(resolvePipeCommandKeyAction('Enter', 3)).toBe('commit');
    expect(resolvePipeCommandKeyAction('Escape', 0)).toBe('none');
    expect(resolvePipeCommandKeyAction('x', 3)).toBe('none');
  });
});
