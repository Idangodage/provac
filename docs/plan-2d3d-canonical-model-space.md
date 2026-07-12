# Plan: 2D→3D object jumping / plane binding fix

## Canonical convention (already established in `modelSpace.ts`, kept)

- Units: millimetres everywhere in model state.
- Model plane: X right on the board, Y **down** on the board (matches the 2D screen), Z = elevation up.
- Model roots (`HybridProjectionLayer` content root, iso roots) must stay **identity** — camera/view code never moves them.

## Confirmed root causes

1. **Handedness (Y-mirror) mismatch in the live hybrid 2D→3D path** — the board's basis
   (X right, Y down, Z up) is *left-handed*; three.js world is right-handed. The ortho
   camera (`camera.up = (0,0,1)`, above the plane) renders model +Y **upward** on screen
   while the Fabric plan renders +Y **downward**. Derived from `camera-controls` source
   (`position.setFromSpherical(...).applyQuaternion(yAxisUpSpaceInverse)`, then `lookAt`):
   at azimuth 0 screen-up = world +Y. Consequences: 3D content fades in vertically
   mirrored about the viewport centre (objects "move to another position"); vertical 2D
   pan moves the 3D ground grid the opposite way to DOM objects. No camera rotation can
   fix a chirality difference — a mirror is mathematically required, applied ONCE at a
   stable view basis (this is the "conversion at the shared parent level" the spec allows).
   The old `IsometricViewCanvas` compensated with `scale(-1,1,1)` at a *content-bounds*
   pivot — objects slid whenever bounds changed (the archetypal bug; removal already in
   working diff).
2. **Page plane / bounds built with page-px as mm** (0.26×) — startup misplacement of the
   3D page vs the plan. Already fixed by the in-progress working diff (kept).
3. **HVAC 3D group centre clamps size to ≥60 mm** (`buildHvacElementMesh.ts`): every 2D
   consumer uses the unclamped centre `position + size/2`, so any element with
   width/depth < 60 mm sits offset in 3D vs 2D; standalone refrigerant pipes translate by
   the clamp delta (local tube frame is `visual.bounds.center`).
4. **Latent hydration hazard**: `parseCanvasData` runs unmemoized in page render bodies;
   a string `canvasData` would re-run `loadData` on every render, snapping objects back
   to saved positions. Persistence itself round-trips mm verbatim (audited clean).

## Fix design

- `modelSpace.ts`: add the single **model→world view basis** — `scale(1,−1,1)`, plus
  `modelPointToWorld` / `worldPointToModel` / `applyModelToWorldBasis` /
  `assertModelToWorldBasis`. Snapshot keys switch to `uuid` (names may collide).
- `HybridProjectionLayer.tsx`: wrap content root **and** ground grid in one permanent
  `viewBasis` group with that basis; convert the board-centre camera target to world
  (`y → −y`) in the per-frame sync; per-frame O(1) dev assertion that the basis and the
  content root never change; delete dead slider-era `updateCamera` and unused constants.
  Object builders remain untouched: they keep writing canonical model coordinates.
- `buildHvacElementMesh.ts`: clamp sizes for *geometry* only; `renderCenter` uses the
  unclamped element centre (procedural + GLB paths); standalone refrigerant pipes anchor
  the group at `visual.bounds.center` (local frame origin by construction).
- `IsometricViewCanvas.tsx`: dev-gate the matrix snapshot/compare (unmounted legacy, but
  keep it honest and free in prod).
- `apps/web` smart-drawing + drawing pages: memoize `parseCanvasData` on the raw
  `canvasData` reference so hydration can never re-import per render.

## What view switching may and may not change (invariant)

Camera position/rotation/projection, helper visibility, opacities — yes.
Object transforms, geometry vertices, stored mm coordinates, parents, the view basis,
model origin/scale — never. Dev assertions enforce this per frame and per rebuild.

## Regression tests

- Screen-mapping equivalence: for random pan/zoom/points, DOM plan mapping == 3D ortho
  projection through the mirrored basis (and ≠ without the mirror, documenting the bug).
- Basis round-trip + determinant, identity-root assertions.
- 200 tilt cycles (2D→3D→2D camera poses) leave every world matrix bit-identical.
- HVAC: sub-60 mm elements' 3D group origin == unclamped 2D centre; standalone pipe
  anchored at its local-frame origin.
- Full existing suite + type-check + lint must pass.
