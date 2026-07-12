# Plan: paper-bond + professional 2D↔3D transition

## Context

After the canonical-model-space fix (see plan-2d3d-canonical-model-space.md), the mm
model and the mirror view basis are correct — but the *feel* is still wrong because the
board is composited from several independent surfaces (three.js grid canvas, Fabric plan
canvas, SVG pipe overlay, optional Konva editor, DOM HUD) that update with different
latencies, and the 2D→3D handoff is a crossfade of a FLAT plan into a tilting 3D scene.

Audit findings (working tree, `packages/drawing-engine`):

1. **Layer lag** — pan/zoom mutates Fabric's viewportTransform immediately
   (`useMiddlePan.ts:127`, `useCanvasMouseHandlers.ts:339`, `useRendererSync.ts:322`),
   but `PipeStudioOverlay` re-renders its `<g transform>` from React props whose store
   commit is rAF-deferred (`scheduleViewTransformSync`) → pipes/branch kits trail walls
   by 1–2 frames while panning/zooming. The three.js grid already avoids this by reading
   the live Fabric matrix per frame (`getViewportMatrix`).
2. **Transition mismatch** — the DOM plan *stays flat* while it fades out over polar
   0→4° and the 3D content tilts underneath (`projectionPlaneStyle`: “No CSS tilt”).
   Even with the mirror fixed, during the fade the two images diverge by the tilt
   foreshortening → reads as objects moving.

Industry patterns (research):
- One viewport source of truth applied to every layer in the same frame
  (tldraw camera/viewport, Excalidraw render pipeline, Figma single engine).
- 2D↔3D as a camera-only tween in a single scene (Coohom/SketchUp-class planners),
  driven by `camera-controls` smooth transitions (already this repo's library).
- CSS3DRenderer cannot follow an orthographic camera (three.js #11534) — but under an
  ortho camera the z=0 plane→screen map is **exactly affine**, so a plain CSS
  `matrix(a,b,c,d,e,f)` computed from the camera per frame tilts the DOM sheet
  pixel-exactly. This is the “drawing bonded to the paper” model, literally.

## Design

### A. Same-frame viewport bond (2D)
Fabric is the frame master. Subscribe overlays to Fabric's `after:render` event and
imperatively write the live `canvas.viewportTransform` into their container transform
(SVG `<g>` `setAttribute`) in the same paint. No React state in the hot path.
- `DrawingCanvas` passes a tiny `liveViewport { get(), subscribe() }` handle
  (built from `fabricRef`) to `PipeStudioOverlay`.
- `PipeStudioOverlay` keeps its React-rendered matrix as the initial value and
  overwrites `gRef` imperatively on each publish (guarded by string compare).

### B. Paper-tilt transition (2D↔3D)
New pure module `canvas/hybrid/planSheetTransform.ts`:
`computePlanSheetCssMatrix(camera, fabricVpt, viewport)` returns the affine CSS matrix
`T = C ∘ D⁻¹` where `D` is the flat DOM mapping (`screen = pan + z·MM_TO_PX·model`) and
`C` is the ortho camera's projection of model plane z=0 (through the mirror basis).
While flat `T === identity` (guaranteed by the canonical-space fix).

`HybridProjectionLayer` render pump (per frame, imperative, no React):
- applies `T` to the plan-sheet container (`planSheetRef` prop from DrawingCanvas,
  `transform-origin: 0 0`), so the whole 2D surface — Fabric canvas, SVG pipes,
  selection — tilts as ONE sheet of paper, pixel-locked to the 3D scene;
- drives the sheet opacity with an eased curve (fade ~1.5°→12° polar) so the
  crossfade happens while the two images are identical → invisible swap;
- snaps `transform: ''` when flat (avoids subpixel text blur);
- `root.visible` keyed off polar directly.
DrawingCanvas stops managing opacity via React (`projectionPlaneStyle` keeps only
zIndex + transformOrigin + willChange).

### C. Explicit camera-led 3D toggle
`HybridViewportController.tiltTo(polar, animate)` using `rotatePolarTo` (SmoothDamp) +
a small 2D/3D toggle button in DrawingCanvas — SketchUp-style explicit transition in
addition to the RMB gesture. Double-click-back behaviour (`resetToPlan`) kept.

### Out of scope now (roadmap, documented for later milestones)
- Snapshot the page area of the Fabric canvas into a `CanvasTexture` on the 3D page
  plane so the crisp drawing stays “printed on the paper” at high tilt.
- Dimensions/labels/selection parity inside the 3D scene; editing while tilted
  (inverse-matrix pointer mapping).
- Konva pipe-editor layer subscription (feature-flagged path).
- Long term: single-engine consolidation (all plan content rendered by the three
  scene; Fabric reduced to input/tooling), following the tldraw one-store→one-renderer
  architecture.

## Phase 2 — Reference-app practice (Advance canvas board, SPEC §10 / LAW 1)

The user's reference implementation (`D:\myWorks\Advance canvas board`, docs/SPEC.md)
is a single-engine app: ONE camera owner (`ViewportController` wrapping
camera-controls) owns wheel-zoom-to-cursor, MMB truck, RMB orbit/tilt, Shift+RMB pan,
pinch; LMB belongs to tools; the scene, rulers, and overlays all DERIVE from the
camera. Applying the same practice here (in stages, keeping Fabric as the 2D content
renderer until in-scene parity lands):

- **P2a (this change) — camera owns navigation.** `HybridViewportController` adopts
  the reference mouse map + zoom clamps + Shift-precision wheel + trackpad pan.
  The per-frame direction INVERTS: instead of Fabric vpt → camera (`syncBoard`),
  the pump derives the flat-equivalent Fabric vpt from the camera each frame and
  applies it (fabric + refs + rAF store commit). Fabric's own wheel-zoom and
  MMB-pan handlers are disabled (events bubble to the camera host). A store→camera
  bridge keeps programmatic zoom/pan (toolbar buttons, fit) working with echo
  suppression. Navigation now also works while tilted.
- **P2a.1 (landed) — pure viewport math + property tests.** Port of the
  reference `engine/camera/viewportMath.ts` practice: all pose/projection math
  in `canvas/hybrid/hybridViewportMath.ts` (pure, no camera-controls/DOM),
  property-tested with fast-check (round-trips at polar×azimuth grid, the
  focal-offset derive regression, the azimuth-flatness sheet regression, zoom
  clamps, poseUp pole continuity). The controller only wires camera-controls +
  input; it delegates every conversion to the math module. Rule going forward:
  no inline pose math in the controller — math module + property test, always.
- **P2b (next) — in-scene content parity:** plan-style rendering of committed
  content by the one scene (walls as double-lines at low zoom via Line2, room
  fills, twin-line pipes, troika labels), then retire Fabric content rendering
  (keep it for input/preview only), then the sheet crossfade disappears entirely.
- **P2c — central ToolController** (reference §12): one listener set, tool FSMs,
  raycast-the-plane input, editing at any tilt angle.
- **P2d — command pipeline + document model** hardening per reference LAW 3/4.

## Files
- new `canvas/hybrid/planSheetTransform.ts` + `.test.ts`
- `canvas/hybrid/HybridProjectionLayer.tsx` (pump: sheet transform + fade; prop)
- `canvas/hybrid/hybridViewportController.ts` (`tiltTo`)
- `components/DrawingCanvas.tsx` (sheet ref + style, liveViewport handle, toggle button)
- `canvas/hvac/PipeStudioOverlay.tsx` (same-frame `<g>` sync)

## Verification
- Unit: sheet matrix == identity at polar 0; at 30° tilt, CSS-matrix-mapped DOM points
  == camera-projected model points (<0.01 px) across pans/zooms; existing 222 tests stay
  green; tsc + eslint clean.
- On-canvas: draw walls + pipes near the board edge → RMB tilt: the sheet visibly
  tilts with content glued, walls rise, no jump at any polar angle; pan/zoom in 2D:
  pipes track walls with zero lag; toggle button animates 2D↔3D↔2D repeatedly with
  zero drift.
