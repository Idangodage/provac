# Pipe selection controls

## Cause

The selection artifacts came from three independent sources:

1. The plan overlay drew vertex bullseyes and insertion buttons while the shared pipe editor also drew point and segment grips.
2. The Three.js selection layer built a white marker for almost every stored pipe vertex. Generated routes store many vertices to approximate smooth bends, so these markers merged into white patches around fittings.
3. The shared editor's old bend filter depended on short chords. It missed larger bends, tangent boundaries, and the meeting point between opposing curves. Projected controls also had no spacing policy, so elevation changes could stack markers in plan or side views.

The pipe body itself was not the source of the white patches.

## Changes

- The shared editor owns projected endpoints and straight-segment controls. The plan overlay retains adaptive bend editing, with one compact control per design corner, revealed on hover, focus, or drag.
- The canvas disables legacy Three.js pipe markers. Wall controls remain available, and the standalone legacy pipe layer uses the semantic control filter.
- The bend filter recognizes circular runs in model space, including tangent boundaries, while preserving real joints, material transitions, and explicitly authored points. It does not modify pipe coordinates or fitting validation.
- Screen-space spacing suppresses overlapping controls and gives the selected control priority. Straight-segment grips appear on hover or selection; their invisible hit areas remain available.
- Extension buttons appear only at open connections. Split selects the newly inserted point and keeps its grip visible in plan.

## Verification

The focused regression run passed 163 tests across 11 suites, covering sampled bends at different radii and orientations, actual generated-network edits, projected overlap, authored points, adaptive editing, dimensions, and edit retention. The drawing-engine TypeScript check and targeted ESLint checks passed.

Browser verification passed all 35 checks using the actual DrawingCanvas with generated gas/liquid routes and an independent manual route. It covers plan, isometric, front, side, zoom, legacy 3D marker ownership, segment and corner editing, undo/redo, and split-point visibility. The generated 54-point routes expose only two to four projected point grips across the tested views, with zero legacy pipe markers and no overlapping visible grips. No browser JavaScript errors were recorded.

[Plan selection](pipe-selection-plan.png) · [3D selection](pipe-selection-3d.png) · [Browser results](pipe-selection-browser-checks.json)

These are local fixture checks; they do not inspect or modify a saved customer project. The screenshots show the final implementation; interim captures are not presented as an original before/after comparison.
