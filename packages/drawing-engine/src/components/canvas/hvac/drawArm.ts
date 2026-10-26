/**
 * Arming the drawing tools of ducts, refrigerant lines and drains:
 *  - "Draw like this" (the bar above the drawing): the tool set to draw
 *    exactly what is selected (its section and level, construction and
 *    insulation; its lines and copper; its fall), a drain drawn on from the
 *    selected drain's open end when it has one;
 *  - a toolbox tile (Ducts & pipes): the tool with its own spec, set to the
 *    tile's kind (its service, its lines), as the project's defaults have it.
 */
import { useSmartDrawingStore } from '../../../store';

import { condensateOpenEnds } from './condensate/condensateCut';
import { armDrainTool, startDrainDraw, useDrainDrawStore } from './condensate/drainDrawSession';
import { DRAW_KIND_TITLES, type DrawKind, type DrawSpec } from './drawSpec';
import { useDuctToolStore } from './duct/ductToolStore';
import { isRoundLeg } from './duct/ductTypes';

function status(message: string): void {
  useSmartDrawingStore.getState().setProcessingStatus(message, false);
}

/** Arms the tool that draws `spec` with exactly it. */
export function armDrawSpec(spec: DrawSpec): void {
  const store = useSmartDrawingStore.getState();
  const { arm } = spec;
  if (arm.tool === 'drain') {
    // On from its own open end when it has one, else the tool waits for a start.
    const open = condensateOpenEnds(store.hvacElements).find((end) => end.runId === spec.elementId && end.end === 'end');
    armDrainTool({ fallPercent: arm.fallPercent });
    if (open) startDrainDraw(open.gap.id);
    return;
  }
  store.setSelectedIds([]);
  if (arm.tool === 'duct') {
    const duct = useDuctToolStore.getState();
    const round = isRoundLeg(arm.section);
    duct.setBranchOptions({
      freeService: arm.service, freeBottomMm: arm.bottomMm, branchShape: round ? 'round' : 'rect',
      ...(round ? { branchDiameterMm: arm.section.diameterMm } : {}),
    });
    if (!round) duct.setBranchSize({ branchWidthMm: arm.section.widthMm, branchHeightMm: arm.section.heightMm });
    // From a collar or an open end too (a round run continues round from its own section).
    duct.setSize(round ? { sizeMode: 'collar' } : { sizeMode: 'custom', widthMm: arm.section.widthMm, heightMm: arm.section.heightMm });
    duct.setLike({ construction: arm.construction, insulationMm: arm.insulationMm });
    store.setTool('duct');
    status(`Duct tool: ${spec.title.toLowerCase()}, ${spec.chips.join(', ')}. Click a collar, an open end or the plan to start.`);
    return;
  }
  store.setRefrigerantPipeLineMode(arm.lineMode);
  store.setRefrigerantPipeDrawMode(arm.material);
  store.setTool('refrigerant-pipe');
  status(`Pipe tool: ${spec.title.toLowerCase()}, ${arm.material === 'hard' ? 'hard' : 'soft'} copper (sizes follow the port or line it starts from).`);
}

/** Arms the tool of a toolbox tile: its kind, the tool's own spec, the project's construction. */
export function armDrawKind(kind: DrawKind): void {
  const store = useSmartDrawingStore.getState();
  if (kind === 'drain') {
    armDrainTool();
    return;
  }
  store.setSelectedIds([]);
  if (kind === 'supply-duct' || kind === 'return-duct') {
    const duct = useDuctToolStore.getState();
    duct.setBranchOptions({ freeService: kind === 'return-duct' ? 'return' : 'supply' });
    duct.setLike(null);
    store.setTool('duct');
    status(`Duct tool: ${DRAW_KIND_TITLES[kind].toLowerCase()}. Click a collar, an open end or the plan to start.`);
    return;
  }
  store.setRefrigerantPipeLineMode(kind);
  store.setTool('refrigerant-pipe');
  status(`Pipe tool: ${DRAW_KIND_TITLES[kind].toLowerCase()}. Click a port or an open line end to start.`);
}

/** The kind the active tool draws, if one of these (its tile lit). */
export function activeDrawKind(
  state: { activeTool: string; refrigerantPipeLineMode: 'pair' | 'gas' | 'liquid' },
  duct: { freeService: 'supply' | 'return' },
  drainTool: { armed: boolean; session: unknown },
): DrawKind | null {
  if (drainTool.armed || drainTool.session) return 'drain';
  if (state.activeTool === 'duct') return duct.freeService === 'return' ? 'return-duct' : 'supply-duct';
  if (state.activeTool === 'refrigerant-pipe') return state.refrigerantPipeLineMode;
  return null;
}

export { useDrainDrawStore };
