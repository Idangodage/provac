> Self-contained engineering brief for the provacx repo, branch `feat/hvac-2d3d-precision`. You are the senior engineer (or coding agent) executing **T9 — Schema migration & persistence hardening**. This prompt closes a gap the architecture review found falling *between* the feature prompts: T2 changes the **stored shape** of a pipe, and several findings flag that pipe **resolution mutates geometry on every read**. No feature prompt owns the versioned migration or the idempotency fix. **This work ships together with T2.** All paths are absolute from the repo root `D:/myWorks/ProvacX/provacx/provacx`.

## 1. Objective

Make the persisted refrigerant-pipe representation forward-compatible and the in-memory resolution **pure**. Concretely:
(a) introduce a **versioned save-schema migration** (`v1 → v2`) that promotes `routePoints` (and the per-corner bend /
per-segment material data) out of the untyped `properties: Record<string, unknown>` bag into a **typed, identity-stable**
field, so old saved drawings load correctly into the new model T2 introduces; (b) **separate pure read from scene
reconciliation** — `resolveRefrigerantPipeSpec` / `resolveRefrigerantPipePairSpec` must stop healing, translating, and
repairing geometry on every render, so a load→render→save round-trip is the identity; (c) **validate on import** instead
of spreading unknown raw elements; and (d) prove all of the above with round-trip and migration tests. End state: opening
a drawing saved before this change reproduces the exact same pipes, editing is the only thing that mutates geometry, and
`save(load(x)) === x`.

## 2. Current State & Why It Hurts

- **The migration pipeline is a no-op.** `packages/drawing-engine/src/store/canvasDataMigration.ts` carries a
  `v0 → v1` step that does effectively nothing, and `importFromJSON` spreads `...rawElement` **unvalidated** into the
  store. There is no place to evolve the stored pipe shape safely.
- **Pipe geometry lives in an untyped bag.** `routePoints` and connection metadata are stored inside
  `properties: Record<string, unknown>` on the HVAC element rather than as typed fields. `store/types.ts` does not even
  declare `hvacElements` on `DrawingState`. There is no schema to migrate *to* and no type safety on load.
- **Reads mutate geometry (the big one).** `resolveRefrigerantPipeSpec` / `resolveRefrigerantPipePairSpec` (in
  `refrigerantPipePairModel.ts`) **heal on every read**: they translate the whole route by a "heal delta" (observed
  0.5–600 mm), run `repairDegenerateBundlePoints`, and `healStartBundleConnectionFromScene`. Because rendering calls
  resolve, **rendering moves the pipe**, so:
  - the output is **non-idempotent** (render twice → two different geometries), a direct source of symptom *(b) connection
    distortion* and *(d) jumpy editing*;
  - a load → render → save round-trip is **not** identity — saved drawings silently drift over time;
  - it fights the T1/T2 single-source-of-truth model: the "truth" is edited by the act of drawing it.
- **Positional segment materials.** `segmentMaterials` is a **positional array** indexed by segment number. Inserting or
  deleting a vertex (T7) silently reassigns every downstream segment's material, because identity is "array position",
  not a stable id. T2 wants identity-bound segments/corner-nodes; without a migration, existing saves can't move to it.

> Net: the persisted model can't safely evolve, and resolution is impure. T2's "canonical centerline" and T7's
> insert/delete-vertex are both unsafe until this is fixed.

## 3. Root Causes to Fix

- No real, versioned migration framework — `canvasDataMigration.ts` is a stub and import is unvalidated.
- Pipe geometry is untyped (`properties` bag) and partly undeclared in `DrawingState`.
- Resolution conflates **two responsibilities**: deriving render geometry (must be pure) and reconciling a route against
  the scene after an edit (must happen only on explicit edit/commit).
- Segment material identity is positional, not stable.

## 4. Target Design

### 4.1 Versioned migration framework
Turn `canvasDataMigration.ts` into an ordered list of pure `(doc) → doc` steps keyed by a `schemaVersion` integer stored
on the document. Each step is small, tested, and idempotent. Add the **`v1 → v2`** step:
- Read legacy `properties.routePoints` (+ any `properties.segmentMaterials`, bend data, connection refs).
- Emit the **typed v2 pipe shape** (§7): `route: RoutePoint[]` with stable per-corner ids, `segments: PipeSegment[]`
  with stable ids carrying material, and explicit `connections`.
- Drop the migrated keys from `properties`. Bump `schemaVersion` to 2.
- Unknown/extra keys are preserved under a `legacy` escape hatch, never silently dropped.

### 4.2 Pure resolve + explicit reconcile (the idempotency fix)
Split `resolveRefrigerantPipe(Pair)Spec` into two functions:
- **`resolvePipeGeometry(pipe, view): PipeRenderSpec`** — **pure**. No translation, no healing, no scene reads. Given the
  stored typed route, it derives the centerline (via T2's `pipeCenterline`) and the render spec. Calling it N times yields
  byte-identical output. This is what render calls.
- **`reconcilePipeToScene(pipe, scene): { pipe, changed }`** — the *only* place healing/`repairDegenerateBundlePoints`/
  `healStartBundleConnectionFromScene` may run. It is invoked **explicitly** on an edit/commit (a `PipeCommand` from T1),
  never on render. It returns a new typed pipe + a `changed` flag; if `changed`, the caller commits it through the store
  with a single history entry.
- A one-time **`reconcileAllOnLoad`** pass MAY run once immediately after import (so legacy drifted saves are healed once,
  deterministically, and re-saved clean) — but it is an explicit load-time step, not part of render.

### 4.3 Validated import
Replace the `...rawElement` spread in `importFromJSON` with a validator that (a) runs the migration chain to the current
`schemaVersion`, then (b) parses each element against the typed shape, quarantining anything malformed into a reported
list rather than spreading unknown data into the live store.

## 5. Libraries & Dependencies

- **KEEP `zustand ^4.5`** — add `hvacElements` to the declared `DrawingState` (`store/types.ts`); promote pipe geometry to
  typed fields. No new dep for the store.
- **NO new runtime dependency required.** The migration + validator are plain TS. *Optional:* if you want runtime schema
  validation, a tiny validator (hand-written type guards) is preferred over adding `zod` for one shape — do **not** pull a
  validation framework just for this. (If the wider app already uses `zod`, reuse it; otherwise hand-rolled guards.)
- Consumes **T2**'s `pipeCenterline` for the pure-resolve geometry; do not duplicate bend math here.

## 6. Implementation Steps

1. **Add `schemaVersion`** to the saved document (default existing docs to 1 on read). Define `CURRENT_SCHEMA_VERSION = 2`.
2. **Refactor `canvasDataMigration.ts`** into an ordered `migrations: Array<(doc) => doc>` runner that applies steps from
   the doc's version up to current, bumping the version each step. Keep the existing v0→v1 as step 0.
3. **Author the `v1 → v2` migration** (§4.1): legacy `properties.routePoints` / `segmentMaterials` → typed `route` /
   `segments` / `connections`; assign stable ids; preserve unknowns under `legacy`.
4. **Add typed fields** to the HVAC element model (§7) and **add `hvacElements` to `DrawingState`** in `store/types.ts`.
5. **Split resolve** in `refrigerantPipePairModel.ts` into pure `resolvePipeGeometry` + explicit `reconcilePipeToScene`
   (§4.2). Move ALL healing/translate/repair calls into `reconcilePipeToScene`. Make render call only the pure path.
6. **Add `reconcileAllOnLoad`** invoked once after `importFromJSON` (deterministic, then re-save-clean opportunity).
7. **Validate import**: replace the `...rawElement` spread with migration + per-element validation + quarantine list.
8. **Wire T1's `commitPipeCommand`** so that any edit that needs reconciliation calls `reconcilePipeToScene` and commits
   the result with one history entry.
9. **Tests** (§10) — migration fixtures, round-trip identity, idempotent resolve.
10. **Typecheck + full vitest**; verify legacy fixture drawings open identically.

## 7. Data Model / Type Changes

```ts
// HVAC element (v2 typed pipe shape) — promoted out of properties:Record<string,unknown>
export interface RoutePoint { id: string; x: number; y: number; bendRadiusMm?: number } // mm world
export interface PipeSegment { id: string; fromPointId: string; toPointId: string; material: PipeMaterial }
export interface PipeConnectionRef {
  end: 'start' | 'end';
  kind: 'unit-port' | 'branch-kit' | 'pipe-tap' | 'free';
  targetId?: string;        // unit / branch-kit / pipe element id
  portId?: string;          // typed port on the target
}
export interface RefrigerantPipeV2 {
  schemaVersion: 2;
  route: RoutePoint[];
  segments: PipeSegment[];           // stable-id, NOT positional
  connections: PipeConnectionRef[];
  legacy?: Record<string, unknown>;  // preserved unknowns
}

// resolution split
export function resolvePipeGeometry(pipe: RefrigerantPipeV2, view: ViewContext): PipeRenderSpec; // PURE
export function reconcilePipeToScene(pipe: RefrigerantPipeV2, scene: SceneQuery): { pipe: RefrigerantPipeV2; changed: boolean }; // edit-time only

// migration
export interface VersionedDoc { schemaVersion: number; /* ... */ }
export const migrations: Array<(doc: VersionedDoc) => VersionedDoc>;
export function migrateToCurrent(doc: VersionedDoc): VersionedDoc;
```

## 8. UX & Interaction Requirements

- **Invisible to the user, except that things stop drifting.** Opening an old drawing must reproduce the same pipes; a
  drawing that is opened and re-saved without edits must be byte-stable (modulo the one deterministic `reconcileAllOnLoad`
  clean-up, which must converge — running it twice changes nothing).
- No "pipe jumped on load/zoom" — because render no longer heals.
- If import quarantines a malformed element, surface a non-blocking notice (count + ids), do not silently drop.

## 9. Acceptance Criteria

- [ ] `schemaVersion` is persisted; `migrateToCurrent` runs on import; a legacy (`v1`) fixture loads into the typed `v2`
      shape with stable segment/corner ids and identical geometry.
- [ ] `resolvePipeGeometry` is **pure**: called twice on the same input it returns deep-equal output (no translation, no
      healing). Grep shows render paths call only `resolvePipeGeometry`, never `reconcilePipeToScene`.
- [ ] All healing/`repairDegenerateBundlePoints`/`healStartBundleConnectionFromScene`/translate-route logic lives **only**
      inside `reconcilePipeToScene` (or the one-shot `reconcileAllOnLoad`).
- [ ] `save(load(doc)) ` is identity for an already-clean v2 doc; `reconcileAllOnLoad` is idempotent (twice = once).
- [ ] `importFromJSON` validates instead of spreading `...rawElement`; malformed elements are quarantined + reported.
- [ ] `hvacElements` is declared on `DrawingState`; `routePoints`/segments/connections are typed fields, not `properties`.
- [ ] Full vitest suite green.

## 10. Test Plan

**Unit (vitest):**
- `canvasDataMigration.test.ts` (extend the existing one): a real legacy `v1` document fixture → migrate → assert typed
  `v2` shape, stable ids, geometry equality, and `legacy` preservation. Running `migrateToCurrent` on an already-`v2`
  doc is a no-op.
- `resolvePipeGeometry.test.ts`: idempotency (`resolve(resolve-input) deep-equals resolve(resolve-input)`); purity (no
  store/scene access — inject a throwing scene and assert it is never called).
- Round-trip identity: `serialize(import(serialize(doc)))` equals `serialize(doc)` for a clean v2 doc.
- `reconcileAllOnLoad` convergence: apply twice, assert second pass reports `changed: false` for every pipe.
- Regression: a drifted legacy fixture (route with a known heal delta) loads, is reconciled once, re-saved, and then is
  stable on the next load.

**Manual:** open a pre-change saved drawing in the app (`/run`), confirm pipes are in the same place; zoom/pan and confirm
no drift; edit a vertex and confirm reconciliation only happens on commit (use **Claude Preview** `preview_eval` to read
the stored route before/after a no-op zoom and assert equality).

## 11. Edge Cases & Pitfalls

**Edge cases:** documents with no `schemaVersion` (assume 1); pipes whose legacy route is *already* degenerate (reconcile
once, deterministically); pipe-pairs where gas/liquid arrays have different lengths in legacy data; partially-connected
endpoints (`kind:'free'`); very old docs that predate `segmentMaterials` (default material).

**Do NOT:**
- Do NOT heal/translate/repair geometry inside any function called by render. Reads are pure; reconciliation is explicit.
- Do NOT spread `...rawElement` into the store. Validate first.
- Do NOT keep `segmentMaterials` positional — migrate to stable-id segments so T7's insert/delete-vertex is safe.
- Do NOT ship a stored-shape change without this migration; old saved drawings would break.
- Do NOT pull in a heavy validation framework for one shape; hand-rolled guards (or an existing app `zod`) suffice.

## 12. Dependencies on Other Tasks

- **Ships with T2** — T2 defines the canonical centerline and the typed segment/corner model; T9 provides the migration to
  that shape and the pure/explicit resolve split that makes T2's "single source of truth" actually hold.
- **Unblocks T7** — stable segment ids make insert/delete-vertex safe.
- **Feeds T10** — the idempotency + round-trip tests here are part of the T10 verification gate.
- **Coordinates with T5/T6** — `PipeConnectionRef` is the typed connection record those tasks read/write.
