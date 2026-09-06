# Smart drawing industrial interaction contract

This document turns established CAD/BIM interaction patterns into testable
ProvacX requirements. It is an engineering contract, not a visual mood board.

## 1. One model, many projections

Plan, Front, Side and Iso are cameras onto one model-space document. A renderer
may tessellate that document, but it may not invent or persist alternate route
geometry.

Professional references:

- [Revit selection is shared across views](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-GetStarted/files/GUID-71F54593-506C-4068-89BC-3385D5576F02.htm)
- [Revit constraints preserve relationships](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-Model/files/GUID-91CBCCF3-66D1-496B-80B3-D893065D1A50.htm)
- [Revit supports model editing in 3D](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-GetStarted/files/GUID-BFFC862B-EEF8-4330-B96F-DB52D814CB51.htm)

ProvacX requirements:

- Every object has one stable ID in every view.
- A refrigerant route has one authoritative ordered 3D centerline.
- Gas and liquid are constrained derivatives of the assembly centerline, not
  independently authored look-alike polylines.
- Bend primitives are `line | circular-arc`; renderers consume them without
  re-rounding.
- Editing from any view produces the same canonical document as an equivalent
  edit from any other view.
- Selection and validation state survive view changes.

## 2. Explicit workplane and axes

A screen coordinate is never a model coordinate. Every point operation resolves
through `client pixel -> camera ray -> named workplane/axis -> model point`.

Professional references:

- [Revit work planes](https://help.autodesk.com/cloudhelp/2025/ENU/Revit-Model/files/GUID-9607D9C8-537B-4E07-9715-08ECF053AE8F.htm)
- [SketchUp inference and axis locking](https://help.sketchup.com/en/sketchup/introducing-drawing-basics-and-concepts)

ProvacX requirements:

- Plan edits expose X/Y and lock Z.
- Front edits expose X/Z and lock Y.
- Side edits expose Y/Z and lock X.
- Iso starts on a named construction plane and offers explicit X/Y/Z locks.
- The active plane or axis is shown contextually during the gesture.
- If an accepted snap lies off the active plane, rebase that plane through the
  snap or require an explicit plane choice. Never create a silent diagonal.

## 3. Stable, explained and overridable snapping

Snapping is a semantic inference service. Render pixels are only used to measure
screen proximity; a committed snap stores the target entity/port identity and
its model-space pose.

Professional references:

- [AutoCAD object snap tracking](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-MAC-Core/files/GUID-665DC37F-8C3E-414A-9369-72A13C0BE07A.htm)
- [Onshape automatic inferencing](https://cad.onshape.com/help/Content/Sketch/automatic_inferencing.htm)

ProvacX requirements:

- Rank compatible equipment ports before endpoints, fittings, guides and grid.
- Use a screen-pixel acquisition radius and a wider break-away radius.
- Retain an acquired target until a materially better target wins or the pointer
  leaves the break-away radius.
- Show marker, source highlight and a short semantic label before click:
  `Gas port`, `Liquid port`, `Open endpoint`, `Same elevation`, or `+Z`.
- Alt temporarily suppresses snaps. Axis locks remain separately available.
- Tab cycles overlapping valid candidates deterministically.
- Esc clears acquired guides, plane lock and transient geometry.

## 4. Constraints capture design intent

Coordinates alone are insufficient for connected engineering systems.
Coincidence, pair spacing, slope, elevation, bend radius and fitting straight
zones are explicit relationships that must survive later edits.

Professional references:

- [AutoCAD geometric constraints](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-668B1B7D-9991-44CA-8607-83665A82FF7F.htm)
- [Onshape constraint states and diagnostics](https://cad.onshape.com/help/Content/Sketch/working_with_constraints.htm)

ProvacX requirements:

- Store equipment port IDs at connected endpoints.
- Resolve gas and liquid endpoint Z independently from their physical ports.
- Preserve required center spacing through straight runs and circular bends.
- Preserve connected endpoints when equipment moves.
- Expose `underconstrained | fully-constrained | conflict` for a selected route.
- Invalid edits preview the named conflict and cannot commit.
- A temporary constraint override is visible and applies only to the gesture.

## 5. Transactional preview and commit

Pointer movement is a preview transaction. It must not create store writes,
history entries, BOQ updates or regenerated drawings.

Professional references:

- [AutoCAD command preview](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DidYouKnow/files/GUID-2EBF913D-2FDC-4D66-A397-068899D492DC.htm)
- [Onshape preview, accept and cancel workflow](https://cad.onshape.com/help/Content/PartStudio/feature_basics.htm)

ProvacX requirements:

- Preview and committed geometry use the same builder and settings.
- Pointer-up or Enter creates one named undo command.
- Esc restores a bit-identical pre-command document.
- An invalid preview remains visible in red with its reason; commit is disabled.
- Drag rendering is frame-throttled, but the committed model uses the final
  unthrottled pointer solution.

## 6. Numeric feedback near the action

The user should not look away from the geometry to confirm accuracy.

Professional references:

- [AutoCAD dynamic distance/angle input](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Core/files/GUID-38EC86CF-D96A-455F-A5DE-2CDA23C28FC4.htm)
- [Revit temporary dimensions](https://help.autodesk.com/cloudhelp/2025/ENU/Revit-DocumentPresent/files/GUID-3BE4F02E-3861-4B6D-8929-97F9ABFBDB91.htm)

ProvacX requirements:

- During draw/drag show length, delta elevation, slope and active constraint in
  one quiet contextual HUD.
- Typing starts exact numeric entry without changing tools.
- Tab advances between length, angle/slope and elevation fields.
- Feedback disappears on commit/cancel and never becomes permanent annotation
  unless the user explicitly promotes it.

## 7. Issue-centric validation

Validation is an inspectable result set, not a collection of unexplained badges.

Professional references:

- [Revit interference checking](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-Collaborate/files/GUID-890A9FE0-EFF4-4CFB-9E81-B0DE1A132BEC.htm)
- [Onshape interference visualization](https://cad.onshape.com/help/Content/View/interference_detection.htm)
- [AutoCAD MEP collision and clearance](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-MEP/files/GUID-ADF10B78-648F-4B1A-A178-B9CDAA220094.htm)
- [Navisworks focus, isolate and dim-other review](https://help.autodesk.com/cloudhelp/2026/ENU/Navisworks-Clash-Detective/files/GUID-FCC9E5E1-2717-48D2-8DBE-2055CF2DC61E.htm)

ProvacX requirements:

- Every issue has a stable ID, severity, status, model location and involved
  element IDs.
- Distinguish hard clash, soft clearance, permitted penetration, open end and
  acknowledged exception.
- Selecting an issue selects/cross-highlights all involved elements.
- Offer Focus, Isolate, Section and Refresh actions.
- The validation summary remains available in every view. Spatial markers are
  only shown where their model projection is accurate.
- Fixed issues disappear after refresh; stale result sets are visibly marked.

## 8. Camera and context

Canonical views rotate the camera, never the model, and recover enough context
to prevent the active geometry from being cropped.

Professional references:

- [AutoCAD ViewCube and fit behavior](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-78043EE2-114B-4F08-BFD7-7E5E429708A9.htm)
- [Onshape fit all/window/selection](https://cad.onshape.com/help/Content/View/zoom_to_fit_window_and_selection.htm)

ProvacX requirements:

- Plan, Front, Side and Iso use exact, named poses.
- View switching preserves selection.
- Fit uses all eight projected bounds corners and at least 24 screen-pixel
  padding; true isometric orientation is not rounded to a principal axis.
- Provide Fit All and Fit Selection. Issue focus fits the involved geometry.
- Orthographic near/far planes are bracketed around content; depth precision
  must remain finer than the smallest visible layered surface.
- Controls stay reachable at all supported viewport sizes.

## 9. Progressive disclosure

Idle drawings stay quiet. Hover explains; selection reveals valid controls;
active commands show temporary dimensions and constraints; completion removes
them. Critical validation remains accessible.

Professional references:

- [Revit contextual tools](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-GetStarted/files/GUID-1CA04013-04CE-4F55-9B0C-68FD7E7FF80B.htm)
- [Revit control suppression for dense selections](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-GetStarted/files/GUID-7231A763-B95D-4F30-9EF4-D9C0B6301655.htm)

ProvacX requirements:

- No idle edit grips or temporary dimensions.
- Hover pre-highlights and names one candidate.
- Single selection shows only valid endpoints, bends and elevation handles.
- Multi-selection defaults to bounds/summary; detailed controls are opt-in.
- Validation starts as a compact count chip and expands on request.

## Release scenario

The release fixture contains:

- a multi-bend gas/liquid pair with different physical port elevations;
- a true vertical riser;
- a wall crossing with and without an approved penetration;
- a branch fitting on a sloped segment;
- two snap candidates inside one acquisition radius;
- an intentional open endpoint.

Run equivalent select, draw, drag, numeric-entry, cancel and commit operations in
Plan, Front and Iso. The gate requires:

- identical canonical JSON after equivalent commits;
- zero document change after cancel;
- exactly one undo record per gesture;
- endpoint error at physical ports no greater than 0.25 mm;
- 2D/3D centerline deviation no greater than 0.5 mm;
- constant pair spacing within 0.5 mm;
- stable issue IDs and cross-view selection;
- every fitted bounds corner inside a 24 px safe area;
- unclipped controls at 1024, 1280 and 1536 px widths.

