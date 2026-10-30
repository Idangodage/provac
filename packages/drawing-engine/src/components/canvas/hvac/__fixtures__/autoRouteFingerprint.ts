/**
 * A comparable fingerprint of an Auto route result, for the golden master.
 *
 * The golden-master run freezes the clock (`FROZEN_NOW`) and fixes
 * `Math.random`, so a run is reproducible: the search itself never reads
 * either. Ids made from the clock (`<prefix>-<time in base 36>-<counter>`, and
 * a drawing's `<time>-<random>`) still carry module-level counters that depend
 * on what ran before in the process; every token containing the frozen time is
 * renamed by its first appearance (`#1`, `#2`, …), consistently across the whole
 * result, so a reference between elements still has to match. Nothing else is normalised:
 * every number is compared exactly (as JSON prints it: the shortest exact
 * decimal), every array in order, every object with its keys sorted.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./nodeBuiltins.d.ts" />
import { createHash } from 'node:crypto';

import type { UnifiedAutoRouteResult } from '../unifiedAutoRoute';

/** The frozen clock of the golden-master runs (any fixed instant; its base-36 form marks clock-made ids). */
export const FROZEN_NOW = 1_790_000_000_000;
const FROZEN_TOKENS = [FROZEN_NOW.toString(36), String(FROZEN_NOW)];
const isClockMade = (text: string) => FROZEN_TOKENS.some((token) => text.includes(token));
/** A token: a run of id characters. */
const TOKEN = /[A-Za-z0-9_.:-]+/g;

/** Fields that measure the run, not its answer. */
const VOLATILE_KEYS = new Set(['timings']);

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

/** A plain, sorted-key copy: Maps and Sets as tagged arrays, non-finite numbers as text, functions dropped. */
function toPlain(value: unknown, renames: Map<string, string>): Plain {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : `#number:${String(value)}`;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return renameTokens(value, renames);
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return null;
  if (Array.isArray(value)) return value.map((entry) => toPlain(entry, renames));
  if (value instanceof Map) return { '#map': [...value].map(([key, entry]) => [toPlain(key, renames), toPlain(entry, renames)]) };
  if (value instanceof Set) return { '#set': [...value].map((entry) => toPlain(entry, renames)) };
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, (entry) => toPlain(entry, renames));
  const out: { [key: string]: Plain } = {};
  for (const key of Object.keys(value as object).sort()) {
    if (VOLATILE_KEYS.has(key)) continue;
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined || typeof entry === 'function') continue;
    out[key] = toPlain(entry, renames);
  }
  return out;
}

function renameTokens(text: string, renames: Map<string, string>): string {
  if (!isClockMade(text)) return text;
  return text.replace(TOKEN, (token) => {
    if (!isClockMade(token)) return token;
    let name = renames.get(token);
    if (!name) {
      name = `#${renames.size + 1}`;
      renames.set(token, name);
    }
    return name;
  });
}

/**
 * Fields derived from what is compared anyway: a generated element's
 * ownership signature hashes the element, clock-made ids included, so it
 * changes with them; everything it covers is compared directly.
 */
function normaliseDerived(value: Plain): Plain {
  if (Array.isArray(value)) return value.map(normaliseDerived);
  if (!value || typeof value !== 'object') return value;
  const out: { [key: string]: Plain } = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = key === 'autoRouteNetwork' && entry && typeof entry === 'object' && !Array.isArray(entry) && 'signature' in entry
      ? { ...(normaliseDerived(entry) as { [key: string]: Plain }), signature: '#signature' }
      : normaliseDerived(entry);
  }
  return out;
}

/** The result in its normalised form (see the module comment). */
export function canonicalAutoRouteResult(result: UnifiedAutoRouteResult): Plain {
  return normaliseDerived(toPlain(result, new Map()));
}

const digestOf = (value: Plain) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

export interface AutoRouteFingerprint {
  /** Of the whole normalised result. */
  digest: string;
  /** Per top-level part, to see where a difference is. */
  sections: Record<string, string>;
  /** Per proposed element (and per duct unit), to see which one differs. */
  elements: Record<string, string[]>;
  /** What the run produced, readable. */
  summary: Record<string, unknown>;
}

export function autoRouteFingerprint(result: UnifiedAutoRouteResult): { fingerprint: AutoRouteFingerprint; canonical: Plain } {
  const canonical = canonicalAutoRouteResult(result);
  return { fingerprint: fingerprintOfCanonical(canonical, summaryOf(result)), canonical };
}

/**
 * The fingerprint of a normalised result (as saved by a recording run; one
 * saved before a normalisation rule was added is brought up to date first).
 */
export function fingerprintOfCanonical(saved: Plain, summary: Record<string, unknown>): AutoRouteFingerprint {
  const canonical = normaliseDerived(saved) as { [key: string]: Plain };
  const sections: Record<string, string> = {};
  for (const key of Object.keys(canonical)) sections[key] = digestOf(canonical[key]!);
  const list = (path: string[]): Plain[] => {
    let value: Plain | undefined = canonical;
    for (const key of path) value = value && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined;
    return Array.isArray(value) ? value : [];
  };
  const elements: Record<string, string[]> = {
    ducts: list(['ducts', 'elementsToAdd']).map(digestOf),
    ductUnits: list(['ducts', 'units']).map(digestOf),
    terminalUpdates: list(['ducts', 'terminalUpdates']).map(digestOf),
    refrigerant: list(['refrigerant', 'elementsToAdd']).map(digestOf),
    refrigerantUpdates: list(['refrigerant', 'updates']).map(digestOf),
    condensate: list(['condensate', 'elementsToAdd']).map(digestOf),
  };
  return { digest: digestOf(canonical), sections, elements, summary };
}

/** What a run produced, readable (shown with a difference). */
function summaryOf(result: UnifiedAutoRouteResult): Record<string, unknown> {
  return {
    ducts: result.ducts?.units.map((unit) => `${unit.tag ?? unit.unitLabel}:${unit.status}:${unit.lifeCycleCost === null ? '-' : unit.lifeCycleCost.toFixed(2)}`) ?? null,
    ductRuns: result.ducts?.elementsToAdd.length ?? null,
    refrigerantElements: result.refrigerant?.elementsToAdd.length ?? null,
    refrigerantConnected: result.refrigerant ? `${result.refrigerant.connectedIndoorIds.length}/${result.refrigerant.connectedIndoorIds.length + result.refrigerant.unconnectedIndoorIds.length}` : null,
    refrigerantScores: result.refrigerant?.evaluations.map((evaluation) => evaluation.score) ?? null,
    refrigerantCandidates: result.refrigerant?.evaluatedCandidates ?? null,
    drains: result.condensate ? `${result.condensate.metrics.unitsConnected}/${result.condensate.metrics.unitsTotal}` : null,
    drainElements: result.condensate?.elementsToAdd.length ?? null,
    clashes: result.clashes.length,
    blocking: result.blockingIssues?.length ?? 0,
    coordination: result.coordination?.strategy ?? null,
  };
}

/** Where two fingerprints differ: the sections, and the first differing element of each list. */
export function fingerprintDifferences(expected: AutoRouteFingerprint, actual: AutoRouteFingerprint): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(expected.sections), ...Object.keys(actual.sections)])) {
    if (expected.sections[key] !== actual.sections[key]) out.push(`section ${key}`);
  }
  for (const key of new Set([...Object.keys(expected.elements), ...Object.keys(actual.elements)])) {
    const a = expected.elements[key] ?? [];
    const b = actual.elements[key] ?? [];
    if (a.length !== b.length) { out.push(`${key}: ${a.length} → ${b.length} items`); continue; }
    const first = a.findIndex((digest, index) => digest !== b[index]);
    if (first >= 0) out.push(`${key}: item ${first} differs (${a.filter((digest, index) => digest !== b[index]).length} in all)`);
  }
  if (JSON.stringify(expected.summary) !== JSON.stringify(actual.summary)) {
    out.push(`summary ${JSON.stringify(expected.summary)} → ${JSON.stringify(actual.summary)}`);
  }
  return out;
}
