# Pipe drawing and editing audit

Date: 2026-09-09. Scope: the existing `DrawingCanvas` HVAC editor and its Fabric, SVG/Konva and Three.js paths. The separate `/vrf-board` and `/pipe-studio` demonstration editors were not replaced.

## Result

The existing architecture supported much of the requested foundation. This change integrates validated spatial editing and closes specific safety and consistency gaps. It does **not** certify the application as a complete industrial CAD/BIM constraint solver.

Drag a straight pipe segment directly, or select a pipe and drag its segment or point handles. Handle drags commit on release as one undo entry; Escape cancels. The contextual toolbar now includes routine length editing, with a matching temporary dimension on the pipe. **Details** retains advanced spatial input, selection scopes, workplanes and regeneration controls. Drawing has service, material, direction, level and exact length in one bar, direct keyboard length entry, **Undo step** / Backspace, **Finish** / Enter and cancellation. See the [professional workflow and performance follow-up](pipe-professional-workflow-review.md) for the latest implementation and measurements.

[Browser-verified bend editing view](pipe-editing-bend.png)

### Direct-edit regression follow-up — 2026-09-10

The initial implementation missed normal direct manipulation and real generated-route geometry. The follow-up reproduced and corrected these defects:

- Projected point markers intercepted existing draggable handles but only selected a point. Both point and segment grips now start actual drags, with synchronous release commits and exact cancellation. A model/history change cancels the frozen gesture.
- The initial gizmo left every drag as a preview requiring Apply. Drag release now creates one undo entry; explicit numerical previews still use Apply.
- Generated terminal bends contain short sampled arc chords. Those points were wrongly validated as individual hard-pipe fittings, rejecting valid generated routes. Preserved curves are recognized, while distorted curves, collapsed segments and shortened equipment approaches remain rejected. Arc tessellation is excluded from ordinary edit controls.
- Moving a segment previously displaced only its two endpoints. The adapter now adjusts adjoining straights and risers while retaining connected terminal positions and directions, including rotated installations and 45-degree adjoining legs. Fully constrained directions return an explanation without saving a no-op edit.
- An active workplane disabled plan selection/editing. Select mode now keeps plan hit testing active; explicit-plane drawing continues through the spatial projection path. Hybrid previews and commits share the same canonical route extraction.
- The main canvas's first drag on an unselected pipe now uses canonical segment editing, avoiding the legacy reconstruction of generated terminal curves. Duplicate point/midpoint handles are hidden. Advanced controls remain collapsed until requested.

[Browser-verified compact toolbar and generated-pipe controls](pipe-editing-direct.png)

## Architecture inspected

| Area | Existing implementation | Audit finding and applied change |
| --- | --- | --- |
| Persisted geometry | `HvacElement.properties.routePoints`, `routeNodes3d`, connection records, materials and generated ownership | Manual and generated routes already share the editable model. New operations preserve IDs, service, diameter and other metadata; synchronize canonical XY/XYZ, bounds, height and elevation. |
| Generation | `autoRouteNetwork.ts`, `autoRouteCommand.ts` | Fingerprints and locks existed, but explicit rebuilding could bypass manual-edit protection. Both planning and command acceptance now enforce retention. |
| Geometry | `pipeCenterline`, `fieldPipeBends`, socket-elbow catalogues, `pipeRoute3d` | Existing constant-radius bend and fitting policy reused. New intrinsic 3D checks cover finite coordinates, segment collapse/reversal, fitting takeoffs, equipment approaches and hard-pipe turn angles. |
| Rendering | Fabric host, `PipeStudioOverlay`, optional Konva editing layer, `HybridProjectionLayer` | New previews remain outside document state, feed the existing renderers, and have an additional projected guide. Legacy plan commits now pass the final geometry/port/lock guard. |
| Coordinates | Millimetre model with X right, Y down, Z up; immutable Y reflection into Three.js | Added World, Local and Workplane transformations. The reflected U/V/N basis is carried explicitly so numeric workplane V agrees with the guide. Camera changes do not redefine model axes. |
| Pointer projection | Shared ray/axis/plane service and frozen drag sessions | Near-parallel intersections could amplify movement and a fallback could leave the intended plane. The solver now rejects unstable intersections or uses a fixed, constrained fallback. Parented cameras are frozen with their world transform. |
| Selection | Element selection, authored vertex handles, field/junction protections | Added explicit run, selected-run group, connected pipe, point, segment, section and bend scopes. Connected traversal uses stored element relationships, not proximity alone. Equipment and branch kits remain fixed boundaries. |
| History | `commitHvacElementCommand` already supported atomic updates | Reused it for geometric edits, neighboring-pipe updates and retention changes. Empty commands no longer create history entries. |
| Properties | Numeric XY/Z/material and route-point controls | These previously bypassed some validation and could silently clamp requested positions. They now use the same geometry adapter and report rejection. |
| Drafting | Live built-pipe previews, line/material modes, snapping, endpoint continuation and branch proposals | Added exact 3D segment-length steps and local draft undo; synchronized the committed anchor with the spatial pointer solver. Explicit workplanes also own flat-view input without duplicate Fabric placement. |

## Added editing behavior

- **Move:** direct segment/point dragging, axis arrows, plane handles, explicit camera-facing free drag, and numerical offsets. A run transforms rigidly; a slid segment adjusts adjoining straight sections and risers while preserving fitting directions. Move an endpoint to change a segment's length. Whole selected runs share a transform so coordinated gas/liquid spacing remains unchanged.
- **Coordinates:** absolute point coordinates in the chosen frame. Linear input follows the drawing unit; changing units converts pending input without changing geometry. Local X follows the selected segment; Workplane U/V/N use the explicit plane origin and basis.
- **Rotate:** projected rings and numerical degrees with either endpoint as pivot. Shift on the ring snaps to 15 degrees. Selected rigid sections retain internal distances and angles. Incompatible exterior segment directions produce a conflict.
- **Bend roll:** select **Bend + adjoining route** and an inlet or outlet connection. The pivot is the actual socket face for catalogue elbows, or the tangent point for formed tube. Rotation is around that port axis and carries the route on the moving side. Fixed and moving ports have different markers. The fitting's angle, radius and diameter do not change. A fixed far terminal blocks a conflicting roll.
- **Route points:** precise point movement, insertion at the true 3D midpoint, and intermediate-point removal. Material boundaries cannot be silently removed. Insertion/removal preserve segment material ownership, including vertical risers.
- **Connections:** fixed terminals check both position and direction. One-sided legacy pipe references protect the referenced endpoint. Connected rigid transforms update internal connection positions, directions and gas/liquid elevations. Unsupported tilted port metadata is rejected explicitly.
- **Locks and regeneration:** generated manual edits are retained automatically. **Allow auto rerouting** releases the exact current generated circuit; a later edit protects it again. Geometry/review locks remain separate. Retention is circuit-wide because the current planner replaces complete circuits.
- **Cancellation:** numeric and gizmo previews do not write model state. Escape, pointer cancellation, lost capture and window blur cancel spatial gestures. Legacy plan gestures also discard previews on cancellation.
- **New drawing:** an arbitrary translated/rotated workplane can be set in Plan, Front, Side or Iso. Ray-derived XYZ remains authoritative even in a flat camera view. The plane, U/V/N directions and unavailable projection feedback are shown. Exact length uses the current preview direction; draft undo also updates the solver's anchor.

## Research and dependency decisions

The implementation follows these documented interaction patterns; it does not claim Autodesk compatibility or manufacturer certification:

1. Autodesk [Tools for Placing Fabrication Parts in Revit](https://help.autodesk.com/cloudhelp/2017/ENU/Revit-Model/files/GUID-44A0E561-2668-4CC4-AC91-82A21CCB2DE9.htm): connector-based rotation, switching the active connector, explicit part editing and visible connector snapping. Applied to the physical bend-pivot mode and its inlet/outlet selector.
2. Autodesk [3D Work Planes](https://help.autodesk.com/cloudhelp/2014/ENU/Revit/files/GUID-B60A3821-C82F-4145-AA00-CFB7AEB1260A.htm): distinguish drawing on a selected face from drawing on an explicitly selected plane. Applied to persistent plane origin/basis and camera-independent drawing coordinates.
3. Three.js [TransformControls](https://threejs.org/docs/pages/TransformControls.html): object transforms are distinct from camera controls; world/local modes, translation/rotation handles, snapping and reset are explicit concepts. Applied to the existing coordinate service and the contextual gizmo.

**No runtime dependencies added.** The solution uses the existing React, Zustand and Three.js stack and existing fitting/routing algorithms. Custom projected SVG handles use the same geometry adapter as numerical controls; installing another scene/controller framework would create competing ownership of the hybrid camera and model. Three.js is already a project dependency under the [MIT licence](https://github.com/mrdoob/three.js/blob/dev/LICENSE). Existing dependency versions and licences are unchanged. Playwright was fetched only into the external npm cache for local browser verification; it was not added to the application.

## Validation

Validated in this workspace:

- Drawing-engine TypeScript check (`tsc --noEmit`).
- ESLint on changed TypeScript/TSX files, using `packages/config-eslint` for plugin resolution.
- **250 tests passed across 22 targeted Vitest suites**, covering the transformation kernel/model, property edits, retention, atomic history, pointer projection, snapping, drawing workflow, extension, topology, and rendered 3D route contracts. The kernel includes 144 frame/axis/angle/pivot combinations checking every pairwise distance, plus position/orientation conflicts. New regressions use the actual network generator for both gas and liquid segment edits and protect sampled bend dimensions and equipment approaches.
- **3 additional automatic-planner regressions passed** during the initial audit, checking preservation with both values of `rebuildExisting` and explicit reconsideration; 11 unrelated tests were skipped by that targeted planner filter.
- Headless Chrome exercised the **real DrawingCanvas**, using an isolated fixture in a temporary local route: preview without document writes, cancellation, numerical XYZ translation, one-step undo/redo, Plan/Front/Side/Iso camera invariance, X-axis rigid rotation, opposite-pivot selection, arbitrary workplane offsets, Escape, axis dragging, and the physical bend socket-pivot ring.
- A second Chrome workflow drew on a translated/tilted workplane from Plan view, verified every saved point against the plane equation, checked a 1000 mm 3D segment, undid/replaced the draft step, and verified a single committed pipe. Enter finishing was checked separately. This found and fixed a toolbar-focus bug in the spatial drawing path.
- The direct-edit follow-up ran Chrome against the real canvas and actual generated pipes: compact toolbar height, direct manual segment and endpoint dragging, connected segment sliding, one-command history, exact undo/redo and Escape cancellation, generated-route retention, active-workplane editing, first body drag on an unselected generated pipe, release commits from Front/Side/Iso axis handles, precise input through Details, and cancellation when the committed model changes during a drag. No browser runtime errors were reported.

The temporary browser fixture route was removed after verification. It did not use a project, database or authenticated user drawing.

The full package suite was attempted with default workers and again with one worker. Both attempts terminated with a Node/V8 out-of-memory error; the full-suite result is therefore **unverified**, not a pass. Focused suites passed. The browser checks used Chrome and the application's existing camera presets; perspective-camera ray geometry is covered by unit tests, not a new perspective-view UI.

## Remaining limitations

1. General arbitrary-axis rotation of standalone branch kits and arbitrary rigid fitting families is not implemented. The new physical port-pivot operation covers bends represented by the existing single-pipe route/fitting model and moves their adjoining route. A rigid-section edit is not a claim that every embedded fitting is an independently persisted selectable component.
2. There is no general constraint solver that reroutes any neighboring locked network. Operations preserve connections when the geometry permits it, or reject the change with an explanation. There is no new automatic disconnection command.
3. Port direction records are still principally 2D with explicit elevation. A connected transform requiring a tilted port direction is rejected; a full 3D port-frame schema and migration remain future work.
4. Retention/reconsideration protects or releases complete generated circuits. Selective regeneration around individual retained fragments is not implemented.
5. Full clearance/manufacturer/system validation continues through the existing validation report. The new interactive adapter enforces the stated local geometry and connection checks; it does not add a full arbitrary-workplane collision or manufacturer-compliance solver. Service spacing for a jointly transformed selection is retained, but clearance to unrelated systems still needs the report.
6. Workplanes and pending edits are transient canvas interaction state, not saved named construction planes. The existing application presets remain orthographic; perspective projection was tested at the geometry service level.
7. Touch/browser diversity, a full production build, all large automatic-route optimization scenarios and complete quantities/export round trips have not been verified in this audit. Bounds/elevation/canonical route synchronization and the existing model/history path were tested; this is not end-to-end certification of every report.
