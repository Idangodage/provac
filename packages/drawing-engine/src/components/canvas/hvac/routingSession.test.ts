import { afterEach, describe, expect, it } from 'vitest';

import {
  activeRoutingSession,
  inRoutingSession,
  inRoutingSessionSync,
  lastRoutingSessionReport,
  memoTable,
  setRoutingSessionChecks,
} from './routingSession';

const TABLE = memoTable<{ id: string; size: number }, number>('test areas');

afterEach(() => setRoutingSessionChecks(null));

describe('routing session', () => {
  it('keeps nothing outside a run', () => {
    expect(activeRoutingSession()).toBeNull();
  });

  it('reuses a value for the same element and variant, and works out a new one for another variant', () => {
    setRoutingSessionChecks(false);
    const element = { id: 'a', size: 3 };
    let computed = 0;
    inRoutingSessionSync(() => {
      const session = activeRoutingSession()!;
      const area = (variant: string) => session.memo(TABLE, element, variant, () => { computed += 1; return element.size ** 2; });
      expect(area('x')).toBe(9);
      expect(area('x')).toBe(9);
      expect(area('y')).toBe(9);
    });
    expect(computed).toBe(2);
    expect(lastRoutingSessionReport()).toEqual({ checked: false, tables: { 'test areas': { hits: 1, misses: 2 } } });
    expect(activeRoutingSession()).toBeNull();
  });

  it('runs a step of a run in that run’s session', async () => {
    setRoutingSessionChecks(false);
    await inRoutingSession(async () => {
      const outer = activeRoutingSession();
      await inRoutingSession(async () => { expect(activeRoutingSession()).toBe(outer); });
      expect(inRoutingSessionSync(() => activeRoutingSession())).toBe(outer);
    });
    expect(activeRoutingSession()).toBeNull();
  });

  it('checked: a kept value that a fresh one contradicts (a dependency left out of the variant) throws', () => {
    setRoutingSessionChecks(true);
    const element = { id: 'a', size: 3 };
    let hidden = 1;
    expect(() => inRoutingSessionSync(() => {
      const session = activeRoutingSession()!;
      session.memo(TABLE, element, '', () => element.size * hidden);
      hidden = 2;
      session.memo(TABLE, element, '', () => element.size * hidden);
    })).toThrow(/differs from a fresh one/);
    expect(activeRoutingSession()).toBeNull();
  });

  it('checked: an element or a kept value edited in place throws', () => {
    setRoutingSessionChecks(true);
    const element = { id: 'a', size: 3, nested: { level: 1 } };
    const VALUES = memoTable<typeof element, { area: number }>('test values');
    inRoutingSessionSync(() => {
      const session = activeRoutingSession()!;
      const value = session.memo(VALUES, element, '', () => ({ area: element.size ** 2 }));
      expect(() => { element.nested.level = 2; }).toThrow(TypeError);
      expect(() => { value.area = 0; }).toThrow(TypeError);
    });
    expect(lastRoutingSessionReport()?.checked).toBe(true);
  });
});
