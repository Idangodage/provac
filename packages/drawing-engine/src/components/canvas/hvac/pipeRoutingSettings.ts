/**
 * Single source of truth for configurable VRF refrigerant pipe-routing
 * parameters (clearances, spacing, snap radius, bypass limits).
 *
 * Historically these values lived as scattered module constants across
 * {@link ./pipeRoutingRules}, {@link ./refrigerantPipeDimensions} and the
 * geometry model. This module collects them into one typed object so they can
 * be edited per-document (via the store) and threaded into the geometry/clash
 * engines without large signature churn.
 *
 * The geometry model (a ~5k line module) reads the *active* settings through a
 * small module-level singleton (`getActivePipeRoutingSettings`) rather than
 * passing settings through every function. The store keeps the singleton in
 * sync with the document via `setActivePipeRoutingSettings` so that a config
 * change recomputes the same way a property edit would.
 *
 * Defaults are seeded from the previous hard-coded constants, so an untouched
 * document renders identically to before this module existed.
 */

import { PX_TO_MM } from "../scale";

import {
  BYPASS_OFFSET_MARGIN_MM,
  CLASH_MERGE_WINDOW_MM,
  DEFAULT_BYPASS_FITTING_ANGLE_DEG,
  DEFAULT_CEILING_LIMIT_MM,
  DEFAULT_FLOOR_LIMIT_MM,
  MIN_INSULATED_CLEARANCE_MM,
} from "./pipeRoutingRules";
import { DEFAULT_REFRIGERANT_PIPE_GAP_MM } from "./refrigerantPipeDimensions";

/** Default centerline elevation (mm from floor) for a freshly routed pipe. */
export const DEFAULT_PIPE_ROUTING_ELEVATION_MM = 2600;

/**
 * Configurable parameters that drive refrigerant pipe routing, spacing and
 * clash avoidance. All distances are millimetres unless noted.
 *
 * Field names follow the project's engineering spec. Some fields
 * (`defaultWallClearanceMm`, `bendRadiusFactor`) are reserved for the upcoming
 * auto-routing workstream and are not yet consumed by the geometry engine —
 * they are persisted so the settings object is forward-compatible.
 *
 * `defaultUnitClearanceMm`, `defaultBranchKitClearanceMm` and
 * `minBranchKitSpacingMm` are consumed by the real-time branch-kit proposal
 * engine ({@link ./branchKitProposal}) to keep a proposed tee clear of unit
 * bodies, run ends and other kits.
 */
export interface PipeRoutingSettings {
  /** Clear gap between the *insulated* gas and liquid pipes of one bundle. */
  defaultPipeGapMm: number;
  /** Reserved (auto-route): min clear distance a route keeps from walls. */
  defaultWallClearanceMm: number;
  /** Min clear distance a proposed branch tee keeps from indoor-unit bodies. */
  defaultUnitClearanceMm: number;
  /** Straight run kept before/after a branch kit body on the tapped run. */
  defaultBranchKitClearanceMm: number;
  /** Minimum centre-to-centre spacing between two branch kits. */
  minBranchKitSpacingMm: number;
  /** Clear gap kept between insulated surfaces of two crossing pipe runs. */
  zOffsetClearanceMm: number;
  /** Straight run kept before the rise fitting begins, ahead of the obstacle. */
  zOffsetStartDistanceMm: number;
  /** Reserved (auto-route): bend radius as a multiple of pipe outer diameter. */
  bendRadiusFactor: number;
  /** Scene scale: millimetres represented by one canvas pixel. */
  scaleMmPerPx: number;
  /** Endpoint snap capture radius in *screen* pixels (zoom-adjusted at use). */
  snapRadiusPx: number;
  /** Fallback centerline elevation (mm from floor) for new routes. */
  defaultPipeElevationMm: number;
  /** Highest level (mm from floor) an "above" bypass may reach. */
  ceilingLimitMm: number;
  /** Lowest level (mm from floor) a "below" bypass may drop to. */
  floorLimitMm: number;
  /** Copper fitting angle used for a bypass rise/return. */
  bypassFittingAngleDeg: 45 | 90;
  /** Clashes nearer than this along the route merge into one bypass. */
  clashMergeWindowMm: number;
  /**
   * When true, a freshly drawn route auto-bakes Z-offset bypass hops at every
   * crossing on commit. When false (default), routes commit exactly as drawn and
   * the user applies a bypass deliberately from the clash overlay card.
   */
  autoBypassOnCommit: boolean;
  /**
   * When true, accepting a branch kit splits the tapped run into two
   * flow-connected edges at a real tee node (W3b). When false (default), the kit
   * is overlaid on the intact run (legacy behaviour).
   */
  enableRealTeeTopology: boolean;
}

/**
 * Defaults seeded from the historical constants so existing drawings are
 * pixel-identical until a value is explicitly changed.
 */
export const DEFAULT_PIPE_ROUTING_SETTINGS: PipeRoutingSettings = {
  defaultPipeGapMm: DEFAULT_REFRIGERANT_PIPE_GAP_MM, // 1" = 25.4 mm
  defaultWallClearanceMm: 50,
  defaultUnitClearanceMm: 100,
  defaultBranchKitClearanceMm: 80,
  minBranchKitSpacingMm: 300,
  zOffsetClearanceMm: MIN_INSULATED_CLEARANCE_MM, // 75 mm
  zOffsetStartDistanceMm: BYPASS_OFFSET_MARGIN_MM, // 60 mm
  bendRadiusFactor: 1,
  scaleMmPerPx: PX_TO_MM,
  snapRadiusPx: 15,
  defaultPipeElevationMm: DEFAULT_PIPE_ROUTING_ELEVATION_MM,
  ceilingLimitMm: DEFAULT_CEILING_LIMIT_MM, // 2900 mm
  floorLimitMm: DEFAULT_FLOOR_LIMIT_MM, // 150 mm
  bypassFittingAngleDeg: DEFAULT_BYPASS_FITTING_ANGLE_DEG, // 45°
  clashMergeWindowMm: CLASH_MERGE_WINDOW_MM, // 320 mm
  autoBypassOnCommit: false, // clean commits by default; bypass is opt-in via the card
  enableRealTeeTopology: false, // opt-in: split the run into a real tee on accept (W3b)
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Merges a partial override onto the defaults, ignoring non-finite numbers so a
 * malformed persisted value can never corrupt the engine.
 */
export function resolvePipeRoutingSettings(
  partial?: Partial<PipeRoutingSettings> | null,
): PipeRoutingSettings {
  if (!partial) {
    return { ...DEFAULT_PIPE_ROUTING_SETTINGS };
  }
  const merged: PipeRoutingSettings = { ...DEFAULT_PIPE_ROUTING_SETTINGS };
  (Object.keys(DEFAULT_PIPE_ROUTING_SETTINGS) as Array<keyof PipeRoutingSettings>).forEach(
    (key) => {
      const value = partial[key];
      if (key === "bypassFittingAngleDeg") {
        if (value === 45 || value === 90) {
          merged.bypassFittingAngleDeg = value;
        }
        return;
      }
      if (key === "autoBypassOnCommit") {
        if (typeof value === "boolean") {
          merged.autoBypassOnCommit = value;
        }
        return;
      }
      if (key === "enableRealTeeTopology") {
        if (typeof value === "boolean") {
          merged.enableRealTeeTopology = value;
        }
        return;
      }
      if (isFiniteNumber(value)) {
        // All remaining fields are numeric.
        (merged[key] as number) = value;
      }
    },
  );
  return merged;
}

// ---------------------------------------------------------------------------
// Active-settings singleton
//
// The geometry model reads these without threading settings through every
// call. The store mirrors the document's settings here on change so geometry
// recompute and clash planning use a consistent, up-to-date value.
// ---------------------------------------------------------------------------

let activeSettings: PipeRoutingSettings = { ...DEFAULT_PIPE_ROUTING_SETTINGS };

/** Returns the currently active routing settings (defaults until set). */
export function getActivePipeRoutingSettings(): PipeRoutingSettings {
  return activeSettings;
}

/**
 * Replaces the active settings (merged onto defaults). Called by the store when
 * the document's `pipeRoutingSettings` change so the geometry engine stays in
 * sync. Returns the resolved settings.
 */
export function setActivePipeRoutingSettings(
  partial?: Partial<PipeRoutingSettings> | null,
): PipeRoutingSettings {
  activeSettings = resolvePipeRoutingSettings(partial);
  return activeSettings;
}
