import { describe, expect, it } from 'vitest';

import {
  CURRENT_HVAC_SCHEMA_VERSION,
  HVAC_SCHEMA_VERSION_KEY,
  migrateCanvasData,
} from './canvasDataMigration';

describe('migrateCanvasData', () => {
  it('stamps a legacy (version:"1.0") drawing up to the current version, intact', () => {
    const legacy = { version: '1.0', hvacElements: [{ id: 'a' }], walls: [] };
    const r = migrateCanvasData(legacy);
    expect(r.fromVersion).toBe(0);
    expect(r.toVersion).toBe(CURRENT_HVAC_SCHEMA_VERSION);
    expect(r.changed).toBe(true);
    expect((r.data as Record<string, unknown>)[HVAC_SCHEMA_VERSION_KEY]).toBe(
      CURRENT_HVAC_SCHEMA_VERSION,
    );
    expect((r.data as { hvacElements: unknown }).hvacElements).toEqual(legacy.hvacElements);
    expect((r.data as { version: string }).version).toBe('1.0');
  });

  it('does not invent geometry it cannot know (no pipeGapMm backfill)', () => {
    const legacy = { version: '1.0', hvacElements: [{ id: 'a' }] };
    const r = migrateCanvasData(legacy);
    const firstElement = (r.data as { hvacElements: Array<Record<string, unknown>> })
      .hvacElements[0]!;
    expect('pipeGapMm' in firstElement).toBe(false);
  });

  it('is a no-op on already-current data', () => {
    const current = { [HVAC_SCHEMA_VERSION_KEY]: CURRENT_HVAC_SCHEMA_VERSION, hvacElements: [] };
    expect(migrateCanvasData(current).changed).toBe(false);
  });

  it('leaves a future version untouched (never downgrades)', () => {
    const r = migrateCanvasData({ [HVAC_SCHEMA_VERSION_KEY]: 999, hvacElements: [] });
    expect(r.toVersion).toBe(999);
    expect(r.changed).toBe(false);
  });

  it.each([null, undefined, 42, 'str', [], [1, 2]])(
    'is tolerant of garbage input: %p',
    (garbage) => {
      expect(() => migrateCanvasData(garbage as unknown)).not.toThrow();
      expect(migrateCanvasData(garbage as unknown).changed).toBe(false);
    },
  );
});
