/**
 * Versioned migration for the flat canvas-data envelope produced by
 * `exportToJSON` and consumed by `importFromJSON` (store/index.ts).
 *
 * The live save format (a flat object carrying `version: '1.0'`) historically
 * had no migrator: `importFromJSON` reads every field defensively with
 * per-field fallbacks. That keeps old drawings loadable but leaves nowhere to
 * evolve the HVAC geometry schema safely (e.g. the upcoming topology /
 * connection-graph fields in W3). This module adds that seam.
 *
 * Design rules:
 * - PURE & TOLERANT: never throws. On any problem it returns the input
 *   unchanged, so a load can never be blocked by a migration bug — the
 *   defensive per-field reads in `importFromJSON` still load the payload.
 * - ORDERED STEPS: each step upgrades exactly one version. New schema changes
 *   APPEND a step; they never edit an existing step.
 * - ADDITIVE: a missing `hvacSchemaVersion` is treated as v0 (legacy) and is
 *   structurally identical to v1 today. We deliberately do NOT invent values we
 *   cannot know (e.g. a per-pair `pipeGapMm` for a drawing made before per-pair
 *   spacing existed) — leaving them absent makes legacy drawings render exactly
 *   as before (the model falls back to the live document gap).
 */

/** Bump when an ordered migration step is appended below. */
export const CURRENT_HVAC_SCHEMA_VERSION = 1;

/** Key stamped onto the flat envelope recording the HVAC schema version. */
export const HVAC_SCHEMA_VERSION_KEY = 'hvacSchemaVersion';

type CanvasData = Record<string, unknown>;

/** One migration step: upgrades data from version `from` to `to` (= from + 1). */
interface MigrationStep {
  from: number;
  to: number;
  /** Human-readable description (logged on apply; useful for debugging). */
  describe: string;
  migrate: (data: CanvasData) => CanvasData;
}

/**
 * Ordered migration steps. v0 (legacy, no version stamp) -> v1 is a structural
 * no-op: it only records the version so future steps have a known baseline.
 * W3 (topology) will APPEND a v1 -> v2 step here.
 */
const MIGRATION_STEPS: MigrationStep[] = [
  {
    from: 0,
    to: 1,
    describe: 'Stamp hvacSchemaVersion on legacy (version:"1.0") drawings; no geometry change.',
    migrate: (data) => data,
  },
];

function isPlainObject(value: unknown): value is CanvasData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSchemaVersion(data: CanvasData): number {
  const raw = data[HVAC_SCHEMA_VERSION_KEY];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

export interface HvacMigrationResult {
  /** The migrated (or, on any failure, original) canvas-data object. */
  data: CanvasData;
  fromVersion: number;
  toVersion: number;
  /** True when the version advanced (i.e. at least one step applied). */
  changed: boolean;
}

/**
 * Migrates a parsed canvas-data object up to {@link CURRENT_HVAC_SCHEMA_VERSION}.
 *
 * Tolerant by design: non-object input and already-current data are returned
 * unchanged, and any step error stops migration (returning the best result so
 * far) rather than throwing.
 */
export function migrateCanvasData(input: unknown): HvacMigrationResult {
  if (!isPlainObject(input)) {
    return {
      data: isPlainObject(input) ? input : {},
      fromVersion: 0,
      toVersion: 0,
      changed: false,
    };
  }

  const fromVersion = readSchemaVersion(input);
  let current: CanvasData = input;
  let version = fromVersion;

  // Contiguous single-version steps; the guard bounds against a malformed table.
  let guard = 0;
  while (version < CURRENT_HVAC_SCHEMA_VERSION && guard < 100) {
    guard += 1;
    const step = MIGRATION_STEPS.find((candidate) => candidate.from === version);
    if (!step) break;
    try {
      current = { ...step.migrate(current), [HVAC_SCHEMA_VERSION_KEY]: step.to };
      version = step.to;
    } catch {
      // Tolerant: stop here and let importFromJSON's per-field reads cope.
      break;
    }
  }

  return {
    data: current,
    fromVersion,
    toVersion: version,
    changed: version !== fromVersion,
  };
}
