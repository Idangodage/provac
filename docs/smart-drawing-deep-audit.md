# Smart drawing deep audit

Date: 2026-07-28  
Scope: ProvacX drawing engine, with emphasis on refrigerant routing and the
shared Plan / Front / Side / Iso experience.

This report separates verified fixes from architectural work that still needs a
controlled migration. The acceptance contract is in
[`smart-drawing-industrial-contract.md`](./smart-drawing-industrial-contract.md).

## Executive finding

ProvacX already has strong domain pieces—model-space 3D nodes, physical port
identities, route validation, view-aware manipulation, and a hybrid camera—but
several renderers and tools still derive their own interpretation of the same
route. The central industrial-practice correction is:

> Store one semantic model and make every view a projection of it. Temporary
> inference may guide an edit; only explicit constraints and model primitives
> survive the edit.

The first stabilization pass is implemented and verified. The largest remaining
risk is the production centerline pipeline: some committed planar routes are
rounded and sampled before persistence, smoothed again for plan display, and
filleted a third time for the 3D sweep.

## Bug register

| ID | Severity | Finding | User impact | Current state |
| --- | --- | --- | --- | --- |
| SD-001 | Critical | A committed pair can be represented by an authored guide, sampled gas/liquid polylines, a plan-only smoothed path, and a separately filleted 3D path. | Plan and 3D bend shape, length and pair spacing can disagree. | **Open migration.** Exact circular primitives and adapters now exist, but the production cutover must preserve connection/takeoff geometry. |
| SD-002 | Critical | The legacy orthographic camera used a `1..1e9` depth range. | Insulated pipes showed copper/brown speckles and coplanar surfaces flickered. | **Fixed.** Near/far planes now bracket live content; explicit 3D routes no longer render a hidden full-length copper tube. |
| SD-003 | High | Live plan and live 3D routing used different snap arbitration. Neither held a target through small pointer tremor. | Wrong port acquisition, snap flicker, and view-dependent endpoint commits. | **Fixed for refrigerant routing.** Both paths now use semantic priority, pixel tolerance and break-away hysteresis. Wall tools still use a separate legacy manager. |
| SD-004 | High | A first point could snap off the inferred surface while the original plane remained locked. | The first point looked correct, but the next segment silently became diagonal or kinked. | **Fixed.** The accepted workplane is rebased through the committed point while retaining its normal and local axes. |
| SD-005 | High | Canonical view switching had no reliable content fit; standalone Fit classified arbitrary orbit as Iso. | Content cropped after Front/Side/Iso changes or while a camera tween was active. | **Fixed.** Fit projects all eight bounds corners in the requested or live endpoint pose. |
| SD-006 | High | A view command could run before the camera adopted restored board pan/zoom. | A fast first click was overwritten on the first render frame. | **Fixed.** Board adoption occurs before the controller is exposed. |
| SD-007 | High | Multiple GLB consumers could subscribe while only the first callback was retained. | Catalog equipment could remain a fallback box until another unrelated render. | **Fixed.** URL loads are deduplicated, all subscribers are notified, and settled loads rebuild scene content. |
| SD-008 | High | Plan-space validation markers could be displayed over a tilted 3D view. | Badges pointed at the wrong screen location and misled issue review. | **Fixed containment.** The summary remains cross-view; spatial markers are plan-only until true 3D issue locations exist. |
| SD-009 | Medium | The validation panel was permanently expanded over the drawing. | It obscured geometry during otherwise valid drafting. | **Fixed.** It starts as a compact severity/count chip and expands on demand. |
| SD-010 | Medium | View controls could run beyond narrow viewport bounds. | Front/Side/Iso or style controls became unreachable. | **Fixed.** The group has a viewport maximum, stable button sizing and horizontal overflow. |
| SD-011 | Medium | 3D route drawing lacked local numeric and inference feedback. | Users could not verify length, elevation change, slope, plane, axis lock or acquired target without looking elsewhere. | **Fixed for pointer feedback.** A transient near-pointer HUD now shows these values and truthful modifiers. Typed numeric entry remains open. |
| SD-012 | Medium | Equipment model bounds and preview bounds were not consistently copied to the fit controller. | Fit could ignore a live preview or use stale extents. | **Fixed for committed and preview rebuilds.** An already-completed Fit is not automatically repeated after a later GLB replacement. |
| SD-013 | Medium | Pair offset in explicit 3D routes uses averaged vertex normals and line-specific fillets. | Center spacing can drift through bends, especially when gas/liquid diameters differ. | **Open.** Planar pairs should derive both curves from one structured guide; non-planar pairs need a transported local frame. |
| SD-014 | Medium | Connection collars, stubs, insulation and copper are constructed by separate geometry paths. | Visible seam/overlap or a false secondary connection can appear at equipment ports. | **Open.** Replace overlapping capped pieces with one connection ownership rule and explicit socket/continuation topology. |
| SD-015 | Medium | Validation has a list and deterministic fixes but no complete issue-focus workflow. | A user cannot yet Focus, Isolate, Section, acknowledge or revisit a clash as a stable issue. | **Open.** Requires model-space issue locations and involved-element sets. |
| SD-016 | Medium | Wall/pipe penetrations are not classified as permitted penetration versus hard clash/clearance. | Real routing conflicts can be missed or over-reported. | **Open.** Add host-intersection rules and penetration objects. |
| SD-017 | Medium | Snap ambiguity is ranked deterministically but cannot be cycled by the user. | Two valid targets inside one radius can still be difficult to choose intentionally. | **Open.** Add Tab cycling without changing default ranking. |
| SD-018 | Medium | Exact length/angle/elevation cannot yet be typed into the transient HUD. | Precise construction still depends on pointer placement and separate property editing. | **Open.** Add command-local numeric fields with one preview transaction. |
| SD-019 | High | Escape committed any in-progress route that already had two points even though the UI said “Esc cancel.” | A user trying to cancel could accidentally write geometry and history. | **Fixed.** Enter is the accept action; Escape now restores the preview session without a commit. |
| SD-020 | High | Plan validation-marker buttons remained above the canvas while the pipe tool owned left-click. | A badge over the intended route could swallow a placement click and select equipment instead. | **Fixed.** Spatial validation markers are suppressed while refrigerant routing owns the pointer. |
| SD-021 | Low | Fit bounds include invisible descendants and are drawing extents rather than strictly visible extents. | Fit can leave more whitespace than expected in X-ray/Wire or during edit isolation. | **Open/low risk.** Decide stable drawing extents versus visibility-aware Fit and name the command accordingly. |
| SD-022 | Low | The repository has multiple snap managers for walls, legacy selection and VRF routing. | Future fixes can drift between tools. | **Open platform cleanup.** Move candidate generation into adapters and retain one arbitration service. |

## Implemented stabilization

### Projection and camera

- Added exact eight-corner orthographic fitting for Plan, Front, Side, Iso and
  arbitrary live orbit poses.
- Added an explicit **Fit** control without changing model orientation.
- Bracketed camera near/far planes around live world bounds.
- Excluded the multi-kilometre visual ground grid from content bounds.
- Kept content/preview bounds fresh and copied them into the controller.
- Seeded restored board navigation before publishing the controller.

### Rendering

- Replaced approximate quadratic elbow construction with an exact circular arc
  in an arbitrary 3D plane.
- Required 3D sweep callers to supply the document bend-radius policy.
- Added a canonical plan-centerline-to-Three curve adapter, including exact
  concentric offsets.
- Removed the hidden coaxial copper tube from explicit insulated routes; copper
  is shown only at genuinely open cross-sections.
- Deduplicated GLB loads and rebuilt the scene when a shared load settles.

Important limitation: the exact centerline adapter is foundation code until the
production planar route pipeline carries structured arc identity into both
renderers.

### Interaction

- Routed both plan and 3D refrigerant snapping through semantic arbitration:
  compatible equipment port, branch port, pipe endpoint, then lower-priority
  inference targets.
- Added acquisition/break-away hysteresis and deterministic tie-breaking.
- Kept Alt as a temporary free-placement override.
- Rebased the locked drawing plane through an accepted snap.
- Added contextual length, delta-Z, slope, active plane, axis lock and snap
  feedback next to the pointer.
- Made command semantics truthful and transactional: Enter accepts; Escape
  cancels and clears the preview without committing.
- Kept the HUD transient and absent while idle.

### Validation and UI density

- Kept the issue summary available in every view.
- Suppressed spatial markers outside Plan until model-space issue locations are
  available.
- Replaced the permanent validation panel with a compact count chip.
- Made camera controls reachable on narrow viewports.

## Production centerline migration

This is the next required engineering phase. A broad “render it smoother”
change is unsafe because the current sampled arrays also encode port takeoffs,
hard/flexible segment decisions and legacy projects.

### Phase 1 — stamp intent at commit

1. Persist the authored 3D guide as ordered `line | circular-arc` primitives.
2. Persist the resolved shared bend radius, pair center spacing and signed
   gas/liquid offsets.
3. Persist connection/takeoff primitives separately from the field route.
4. Migrate legacy polylines lazily and retain the original payload for rollback.

Exit condition: saving and reloading does not change primitive count, bend
radius, endpoints or length.

### Phase 2 — one derivation service

1. Derive gas and liquid planar centerlines from the shared guide with concentric
   offsets.
2. Generate SVG path data, hit-test samples, BOQ length and Three curves from
   those same primitives.
3. Remove Catmull-Rom and renderer-local filleting from production hard-pipe
   paths.
4. Keep the point-based 3D fallback only for genuinely non-planar legacy routes.

Exit condition: plan and 3D centerline samples differ by at most 0.5 mm and pair
spacing differs by at most 0.5 mm through every bend.

### Phase 3 — non-planar pair frame

1. Carry a rotation-minimising frame along the guide.
2. Resolve pair orientation at each equipment port and transport it through
   risers/slopes without sudden flips.
3. Build both lines from one guide/frame/radius policy.
4. Preserve vertical risers and arbitrary-plane bends.

Exit condition: no pair crossing or spacing flip and endpoint error at physical
ports is at most 0.25 mm.

## Interaction implementation plan

1. Add Tab candidate cycling to the central snap session and show the selected
   semantic target before click.
2. Turn the transient drafting readout into command-local numeric entry:
   length, angle/slope and elevation; Tab advances fields, Enter commits, Esc
   restores the exact pre-command document.
3. Persist explicit route constraints: coincidence, same elevation, axis,
   slope, pair spacing and minimum bend radius.
4. Surface `underconstrained`, `fully constrained` and `conflict` on selection.
5. Add Fit Selection and issue Focus/Isolate/Section using model-space bounds.
6. Move wall and general selection tools onto the same inference arbitration
   service.

## Validation implementation plan

1. Give every issue a stable ID, status, model location and involved element
   IDs.
2. Add hard-clash, soft-clearance, open-end, invalid bend, unsupported slope
   and permitted-penetration classifications.
3. Add cross-view focus and isolate; true model-space markers replace the
   current plan-only marker containment.
4. Add acknowledge/assign/refresh semantics and visibly mark stale result sets.
5. Block commit only for named hard constraints; warnings remain reviewable
   without interrupting drawing.

## Verification completed

- Drawing-engine unit suite: **58 files, 441 tests passed** after the final
  plan-snap and camera hardening.
- Workspace TypeScript gate: all 10 participating package tasks passed.
- Focused lint on all files changed by this stabilization pass passed.
- Focused geometry, snap, camera, clipping, GLB and drafting-feedback
  regressions passed.

The repository-wide lint command still reports a large pre-existing baseline in
unrelated files. That baseline was not auto-fixed because doing so would mix a
wide formatting/refactor change into this accuracy work.
