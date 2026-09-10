# Professional pipe workflow and performance review

Date: 2026-09-10. Applies to the existing HVAC DrawingCanvas used for manual and generated refrigerant pipework.

## Delivered workflow

The canvas now has one contextual command bar. Routine dimensions, material, service, direction and level are available without opening a properties form. Advanced coordinate systems, connection policies and bend operations remain in Details.

| Work | Interaction |
| --- | --- |
| Start a route | Choose service, copper material, direction and level; place the first point. The active service stays fixed for that route or continuation. |
| Draw a measured leg | Point in the desired direction, type a length, and press Enter. Enter in the length field adds the leg and returns focus to the canvas. |
| Change level | Enter the new level. An active route gains a vertical riser and continues on the new horizontal plane. A tilted workplane keeps level editing disabled. |
| Correct a draft | Undo step / Backspace restores the preceding point and level. Finish / Enter commits the route; Escape cancels. |
| Adjust a completed route | Drag a straight segment or a free route point. Both manual and generated pipes use the same validated model operations. |
| Change a measured length | Select the segment and edit its temporary dimension beside the pipe, or its Length field in the bar. Keep start / Keep end chooses the stationary endpoint. Compatible adjoining legs adjust automatically. |
| Refine the route | Split inserts a midpoint. Remove point operates on an intermediate point. Move/Rotate expose the corresponding spatial handles. |
| Respect a fixed connection | Connected endpoints have distinct, stationary markers. Adjust adjoining segments; a conflicting edit is rejected with a local explanation. |

Dimensions commit once on Enter or blur. Escape restores the model value. Pointer previews commit on release, flush the final pointer sample, and cancel on Escape, lost capture or committed-model changes. No new confirmation dialogs are involved.

[Editing with a temporary dimension](pipe-professional-edit.png) · [Unified drawing controls](pipe-professional-draw.png)

## Performance findings and changes

The primary problem was repeated geometry construction, not a missing drawing library:

- Every pipe preview previously replaced the main scene input and rebuilt unrelated architecture and equipment. Transient edits now have separate ownership, with only affected meshes rebuilt.
- Committed updates also reconcile individual HVAC meshes. Unchanged architecture, lighting, equipment and pipe meshes survive a local edit. Dependencies include connector sources, caps and joined chains; a changed continuation correctly updates its unchanged render head.
- Pipe endpoint/chain context, plan tubes, fittings and SVG paths reuse immutable source geometry. Routing settings and changed source elements invalidate the required entries.
- Validation previously built each unrelated legacy pipe's visual before checking whether it referenced the edited pipe. Reference checking now happens first. Full port, fitting, lock and degeneracy checks remain enabled.
- Drafts reuse snap targets and unchanged snapped previews. Twenty identical snapped pointer events produce one geometry build; material, rule and source changes invalidate that result.
- Pointer bursts produce at most one scheduled geometry preview per animation frame. Release flushes it; cancellation discards it. Hidden rotation rings and unchanged gizmo projections no longer recompute continuously.

The controlled geometry benchmark used the same generated route edit with **500 unrelated legacy pipes**, 20 measured iterations and three warmups. The measured edit cost fell from **131.63 ms to approximately 3–5 ms** across follow-up runs. The checked-in `pipeEditModel.bench.ts` includes geometric and port assertions alongside timings; this is geometry-operation timing, not whole-application frame rate.

A final headless Chrome development-mode trace used 100 pipes and 45 pointer moves, confirmed that the model changed, and recorded one edit after the fixture baseline. It recorded a **16.7 ms median frame interval**, **50.4 ms 95th percentile**, and six long tasks totaling 407 ms. Automation took about four seconds including command dispatch and settling. These results show remaining frame-time variability; they are not a production frame-rate guarantee. Raw final measurements: [100-pipe trace](pipe-performance-after.json).

## Design references

The interaction choices follow established drafting patterns without copying an entire CAD interface:

- Autodesk documents temporary pipe length/elevation controls that accept precise values directly at selected geometry. This informed the on-canvas dimension and explicit level workflow. [Work with Pipe Controls](https://help.autodesk.com/cloudhelp/2016/ENU/Revit-Model/files/GUID-54B16217-68F4-4F0C-928C-505690B44EFB.htm)
- Autodesk's dynamic input places command and dimension entry close to the current drawing operation. This informed typing a length while the cursor remains on the drawing. [About Using Dynamic Input Tooltips](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Core/files/GUID-3EBD4C17-F0A5-49FA-B131-4AABE2E727DB.htm)
- Revit supports vertical pipe creation from plan by changing the placement offset. Here, a deliberate level change appends an actual riser rather than changing the height of previously drawn geometry. [Draw Vertical Pipes](https://help.autodesk.com/cloudhelp/2022/ENU/Revit-MEPEng/files/GUID-5AAC229E-7FB7-45B4-A408-08B5877E5A0E.htm)

No runtime dependencies were added. Existing React, Zustand, Three.js and HVAC geometry facilities are retained.

## Verification and limits

The final focused regression run passed **284 tests across 28 files**. The drawing-engine TypeScript check and ESLint checks for the affected implementation files also passed.

Browser checks use the real DrawingCanvas in a temporary local fixture, without accessing an authenticated project. They cover direct segment movement, a single undo boundary, exact undo/redo, cancelled queued previews, temporary dimension entry/cancellation, Front/Side/Iso manipulation, direct keyboard length entry, level changes, riser undo, continued drawing at the new elevation and absence of runtime errors.

Focused tests also cover actual automatically generated gas/liquid geometry, connection/fitting constraints, legacy geometry extraction, dimension pivots, reactive draft state, snap/preview invalidation, mesh reuse, dependent render heads, cancellation and exactly-once resource disposal. Renderer tests verify that changing one member of a 100-pipe scene rebuilds one member when no other member depends on it.

This review does not certify launch readiness for every project size or device. Production-build profiling, representative customer projects, touch/browser diversity, complete quantities/export round trips and full manufacturer/clearance validation remain separate release checks. Existing validation/reporting still governs system clearances and manufacturer rules; there is no new general-purpose network constraint solver.
