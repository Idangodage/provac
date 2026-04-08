cd # Smart Canvas Board Architecture Analysis

## 1. Current implementation snapshot

### Rendering engine usage
- Primary engine is `Fabric.js` (`DrawingCanvas`, `WallRenderer`, `RoomRenderer`, `DimensionRenderer`, `ObjectRenderer`, `SectionLineRenderer`).
- A legacy Konva room-layer path existed previously, but the active editor runtime is now Fabric-only.
- Rendering follows a layered service pattern on top of one Fabric canvas:
  - grid + rulers + page overlay (`Grid`, `Rulers`, `PageLayout`)
  - geometry renderers (walls, rooms, dimensions, objects, section lines)
  - interaction overlays (selection/edit handles and context menus)

### State management
- Single large Zustand store in `src/store/index.ts`.
- Store includes geometry data, tools, selection, view state, dimensions, wall/room/elevation data, HVAC properties, and serialization.
- Undo/redo exists and snapshots full slices of data.
- Debounced room detection and elevation regeneration are already present.

### Existing feature baseline
- Wall drawing with chain mode, endpoint/midpoint/grid snapping, and orthogonal lock (Shift).
- Wall editing in select mode includes endpoint movement, thickness adjustment, center movement, and drag feedback.
- Section/elevation line workflow and elevation generation are integrated.
- Room auto-detection from wall loops is implemented.
- Dimensioning tools and style settings are implemented.

### Geometry calculations
- Manual geometry was spread across multiple files (`store/index.ts`, `store/roomDetection.ts`, wall geometry helpers, dimension helpers).
- A Turf-based `GeometryEngine` exists (`src/utils/geometry-engine.ts`) but was not wired broadly before this update.

## 2. Strengths
- Feature breadth is already high (walls, rooms, dimensions, section/elevation, object placement, HVAC attributes).
- Data model is rich and future-oriented (3D/HVAC attributes, material metadata, elevation settings).
- Core CAD interaction primitives are in place (snap, constraints, context actions).
- Backward compatibility is considered in store aliases and export structure.

## 3. Weaknesses and technical debt
- Store file is oversized and mixes domain logic, geometry, command handling, and persistence.
- Geometry logic was duplicated across modules, increasing regression risk.
- The package still has some legacy room-pipeline types and docs from the earlier Konva path, though the runtime no longer depends on it.
- Snapshot-based history can become memory-heavy for large drawings.
- No visible automated test setup for geometry/edit operations in this package yet.

## 4. Turf.js integration opportunities

High-value immediate:
- Unify all topology/intersection/containment operations through `GeometryEngine`.
- Replace scattered point-in-polygon/intersection checks with `GeometryEngine` wrappers.

Next phase:
- Wall intersection and trimming:
  - `lineIntersect`, `nearestPointOnLine`, `lineOverlap`.
- Room loop post-processing:
  - polygon validation (`kinks`), overlap checks, and cleaning.
- Advanced snapping:
  - nearest feature search and constrained projection with Turf primitives.

Important unit note:
- Project coordinates are CAD planar mm units, not geodesic coordinates.
- Keep metric area/length in deterministic planar math; use Turf mainly for topology/boolean operations.

## 5. Refactor priorities (recommended order)

1. Geometry consolidation
- Route all geometry-heavy modules through `GeometryEngine`.
- Keep legacy helper exports for backward compatibility until migration is complete.

2. Store decomposition
- Split `store/index.ts` into domain slices:
  - `walls`, `rooms`, `dimensions`, `elevations`, `selection`, `history`, `view`.

3. Command-based history
- Migrate from full-snapshot undo/redo to command entries for high-frequency operations (drag/edit).

4. Rendering performance
- Add viewport culling for walls/rooms/objects.
- Reduce Fabric object churn during drag by pooling transient overlays.
- Batch updates and minimize full-canvas invalidation.

5. Test harness
- Add unit tests for geometry and edit constraints first.
- Add integration tests for workflows: draw wall -> detect room -> edit wall -> update dimensions.

## 6. Success metrics
- Stable 60 FPS during drag interactions in medium plans.
- <100ms response for common edit operations.
- Deterministic geometry outputs across save/load and undo/redo.
- >80% test coverage in geometry/edit-operation modules.
