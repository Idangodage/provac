'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useSmartDrawingStore } from '../../../store';
import type { HvacElement } from '../../../types';
import type { HybridViewportController } from '../hybrid/hybridViewportController';
import { modelPointToWorld } from '../modelSpace';
import { fromMillimeters, getUnitLabel, toMillimeters, type LinearUnit } from '../scale';

import { PipeDimensionInput } from './PipeDimensionInput';
import { PipeEditGizmo } from './PipeEditGizmo';
import { PipeDrawingControls } from './PipeRoutingToolbar';
import { resolvePipeBendEdit } from './pipeBendEdit';
import {
  getPipeEditSelectionIndices, pipeEditPointFromWorld, resolvePipeEditFrame,
  type PipeEditCoordinateMode, type PipeEditSelection, type PipeEditWorkplane, type PipeRouteEditOperation,
} from './pipeEditGeometry';
import { buildPipeModelEdit, connectedPipeIds, editablePipeNodes, isEditablePipe, pipeEditControlIndices } from './pipeEditModel';
import { isPipeRouteLocked, pipeRegenerationPolicy } from './pipeEditRetention';
import { createDrawingPlane, type PipeDrawingPlane } from './pipePointerProjection';
import { createPipePreviewScheduler } from './pipePreviewScheduler';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { buildPipeSegmentLengthEdit } from './pipeSegmentDimensions';

interface Props {
  elements: HvacElement[];
  selectedIds: string[];
  enabled: boolean;
  drawing: boolean;
  drawingStarted: boolean;
  drawingService: 'pair' | 'gas' | 'liquid';
  drawingElevationMm: number | null;
  onSetDrawingElevation: (elevationMm: number) => boolean;
  onPlaceBranchKit: () => void;
  unit: LinearUnit;
  controllerRef: RefObject<HybridViewportController | null>;
  width: number;
  height: number;
  onPreviewChange: (elements: HvacElement[] | null) => void;
  onWorkplaneChange: (plane: PipeDrawingPlane | null) => void;
  onUndoDrawingStep: () => void;
  onAppendDrawingLength: (lengthMm: number) => boolean;
  onFinishDrawing: () => void;
  onCancelDrawing: () => void;
}

const inputClass = 'min-w-0 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-teal-600 focus:outline-none';
const buttonClass = 'rounded border border-slate-200 px-2 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed';

function NumberVector({ label, value, onChange, labels = ['X', 'Y', 'Z'] }: {
  label: string; value: string[]; onChange: (value: string[]) => void; labels?: readonly string[];
}) {
  return <fieldset className="space-y-1"><legend className="text-xs text-slate-500">{label}</legend>
    <div className="grid grid-cols-3 gap-2">{labels.map((axis, index) => <label key={axis} className="min-w-0 text-[11px] text-slate-500">
      {axis}<input aria-label={`${label} ${axis}`} type="number" step="any" className={inputClass} value={value[index] ?? ''}
        onChange={event => onChange(value.map((number, i) => i === index ? event.target.value : number))} />
    </label>)}</div></fieldset>;
}

const parseVector = (values: string[]): PipeRouteNode3D | null => {
  const numbers = values.map(value => value.trim() ? Number(value) : NaN);
  return numbers.length === 3 && numbers.every(Number.isFinite) ? { x: numbers[0]!, y: numbers[1]!, z: numbers[2]! } : null;
};

/** Drag previews commit on release; numerical previews commit with Apply. Both use one history command. */
export function PipeEditingTools(props: Props) {
  const commit = useSmartDrawingStore(state => state.commitHvacElementCommand);
  const setPolicy = useSmartDrawingStore(state => state.setPipeRegenerationPolicy);
  const documentId = useSmartDrawingStore(state => state.importedDrawing?.id);
  const defaultDrawingLevel = useSmartDrawingStore(state => state.pipeRoutingSettings.defaultPipeElevationMm);
  const [preferredId, setPreferredId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showTransform, setShowTransform] = useState(false);
  const selectedPipes = useMemo(() => { const ids = new Set(props.selectedIds); return props.elements.filter(element => ids.has(element.id) && isEditablePipe(element)); }, [props.elements, props.selectedIds]);
  const selected = selectedPipes.find(element => element.id === preferredId) ?? selectedPipes[0];
  const selectionKey = props.selectedIds.join('|');
  const [selection, setSelection] = useState<PipeEditSelection>({ kind: 'run' });
  const [bendIndex, setBendIndex] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [coordinateMode, setCoordinateMode] = useState<PipeEditCoordinateMode>('world');
  const [operationMode, setOperationMode] = useState<'translate' | 'rotate' | 'set-node'>('translate');
  const [pivot, setPivot] = useState<'start' | 'end'>('start');
  const [rotationAxis, setRotationAxis] = useState<'x' | 'y' | 'z'>('z');
  const [values, setValues] = useState(['0', '0', '0']);
  const [angle, setAngle] = useState('0');
  const [segmentLength, setSegmentLength] = useState(String(fromMillimeters(1000, props.unit)));
  const lengthInputRef = useRef<HTMLInputElement>(null);
  const lengthBeforeTyping = useRef(segmentLength);
  const keyboardLengthEntry = useRef(false);
  const [workplane, setWorkplane] = useState<PipeEditWorkplane | null>(null);
  const [showPlane, setShowPlane] = useState(false);
  const [planeOrigin, setPlaneOrigin] = useState(['0', '0', String(fromMillimeters(2400, props.unit))]);
  const [planeNormal, setPlaneNormal] = useState(['0', '0', '1']);
  const [planeXAxis, setPlaneXAxis] = useState(['1', '0', '0']);
  const [preview, setPreview] = useState<HvacElement[] | null>(null);
  const [feedback, setFeedback] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [baseline, setBaseline] = useState<HvacElement[] | null>(null);
  const pendingEdit = useRef<{ elements: HvacElement[]; baseline: HvacElement[] } | null>(null);
  const previewConsumer = useRef<(value: { operation: PipeRouteEditOperation; selection?: PipeEditSelection }) => void>(() => {});
  const previewScheduler = useMemo(() => createPipePreviewScheduler<{ operation: PipeRouteEditOperation; selection?: PipeEditSelection }>(value => previewConsumer.current(value)), []);
  const previousUnit = useRef(props.unit);
  const nodes = useMemo(() => selected ? editablePipeNodes(selected) : [], [selected]);
  const controlIndices = useMemo(() => selected ? pipeEditControlIndices(selected) : { nodes: [], segments: [] }, [selected]);
  const bendIndices = useMemo(() => expanded && selected ? controlIndices.nodes.flatMap(index =>
    index > 0 && index < nodes.length - 1 && resolvePipeBendEdit(selected, index, pivot) ? [index] : []) : [], [expanded, selected, nodes, controlIndices, pivot]);
  const bend = useMemo(() => selected && bendIndex !== null ? resolvePipeBendEdit(selected, bendIndex, pivot) : null, [selected, bendIndex, pivot]);
  const effectiveSelection = bend?.selection ?? selection;
  const frame = useMemo(() => bend?.frame ?? resolvePipeEditFrame({ mode: coordinateMode, nodes, selection, workplane }), [bend, coordinateMode, nodes, selection, workplane]);
  const indices = getPipeEditSelectionIndices(nodes, effectiveSelection);
  const firstPoint = nodes[indices[0]!]; const lastPoint = nodes[indices.at(-1)!];
  const pivotPoint = bend?.pivotPoint ?? (operationMode === 'translate' && firstPoint && lastPoint
    ? { x: (firstPoint.x + lastPoint.x) / 2, y: (firstPoint.y + lastPoint.y) / 2, z: (firstPoint.z + lastPoint.z) / 2 }
    : nodes[pivot === 'start' ? indices[0]! : indices.at(-1)!]) ?? nodes[0];
  const active = props.enabled && !!selected && nodes.length >= 2;

  const cancel = useCallback(() => {
    previewScheduler.cancel();
    pendingEdit.current = null;
    setPreview(null); setBaseline(null); setFeedback(''); setInvalid(false);
    props.onPreviewChange(null);
  }, [props.onPreviewChange, previewScheduler]);
  useEffect(() => { previewScheduler.cancel(); }, [props.elements, previewScheduler]);
  useEffect(() => {
    const before = previousUnit.current;
    if (before === props.unit) return;
    previousUnit.current = props.unit;
    const convert = (numbers: string[]) => numbers.map(value => value.trim() && Number.isFinite(Number(value))
      ? String(fromMillimeters(toMillimeters(Number(value), before), props.unit)) : value);
    cancel(); setValues(convert); setPlaneOrigin(convert); setSegmentLength(value => convert([value])[0]!);
  }, [props.unit, cancel]);
  useEffect(() => { cancel(); setSelection({ kind: 'run' }); setBendIndex(null); setConnected(false); setShowTransform(false); setValues(['0', '0', '0']); setAngle('0'); }, [selected?.id, selectionKey, props.enabled, cancel]);
  useEffect(() => {
    if (baseline && baseline !== props.elements) {
      cancel();
    }
  }, [baseline, props.elements, cancel]);
  useEffect(() => { setWorkplane(null); props.onWorkplaneChange(null); cancel(); }, [documentId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && preview) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [preview, cancel]);
  useEffect(() => () => { previewScheduler.cancel(); props.onPreviewChange(null); }, [props.onPreviewChange, previewScheduler]);
  useEffect(() => {
    const onLengthKey = (event: KeyboardEvent) => {
      if (!props.drawing || !props.drawingStarted || event.ctrlKey || event.metaKey || event.altKey
        || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) || !/^\d$/.test(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (!keyboardLengthEntry.current) { lengthBeforeTyping.current = segmentLength; setSegmentLength(event.key); keyboardLengthEntry.current = true; }
      else setSegmentLength(value => value + event.key);
      lengthInputRef.current?.focus();
    };
    window.addEventListener('keydown', onLengthKey, true);
    return () => window.removeEventListener('keydown', onLengthKey, true);
  }, [props.drawing, props.drawingStarted, segmentLength]);

  const makePreview = useCallback((operation: PipeRouteEditOperation, directSelection?: PipeEditSelection) => {
    const editFrame = directSelection ? resolvePipeEditFrame({ mode: coordinateMode, nodes, selection: directSelection, workplane }) : frame;
    if (!selected || !editFrame) return;
    if (!directSelection && bendIndex !== null && !bend) { pendingEdit.current = null; setInvalid(true); setFeedback('Select a bend with sufficient straight length for its fittings.'); return; }
    const appliedOperation = !directSelection && bend && operation.kind === 'rotate' ? { ...operation, axis: 'x' as const, pivot: bend.pivotPoint } : operation;
    const result = buildPipeModelEdit({ elementId: selected.id, elements: props.elements, selection: directSelection ?? effectiveSelection, operation: appliedOperation, frame: editFrame, connected: !directSelection && connected,
      selectedIds: !directSelection && !connected && !bend && selection.kind === 'run' ? selectedPipes.map(element => element.id) : undefined });
    setBaseline(props.elements);
    if (!result.ok) {
      pendingEdit.current = null; setInvalid(true); setFeedback(result.message); setPreview(null); props.onPreviewChange(null); return;
    }
    pendingEdit.current = { elements: result.elements, baseline: props.elements };
    setInvalid(false); setPreview(result.elements); props.onPreviewChange(result.elements);
    setFeedback(operation.kind === 'rotate'
      ? `${operation.angleDegrees.toFixed(2)}° around ${editFrame.labels[['x', 'y', 'z'].indexOf(operation.axis)]} · fixed ${pivot} endpoint`
      : `${result.elements.length} pipe${result.elements.length === 1 ? '' : 's'} · preview ready`);
  }, [selected, frame, props.elements, props.onPreviewChange, effectiveSelection, connected, pivot, bend, bendIndex, selectedPipes, selection.kind, coordinateMode, nodes, workplane]);
  previewConsumer.current = ({ operation, selection: directSelection }) => makePreview(operation, directSelection);

  const previewNumbers = () => {
    if (operationMode === 'rotate') {
      const degrees = angle.trim() ? Number(angle) : NaN;
      if (!Number.isFinite(degrees)) { setFeedback('Enter a finite angle.'); setInvalid(true); return; }
      makePreview({ kind: 'rotate', angleDegrees: degrees, axis: rotationAxis, pivot });
    } else {
      const input = parseVector(values);
      if (!input) { setFeedback('Enter three finite coordinates or offsets.'); setInvalid(true); return; }
      const vector = { x: toMillimeters(input.x, props.unit), y: toMillimeters(input.y, props.unit), z: toMillimeters(input.z, props.unit) };
      makePreview(operationMode === 'set-node' ? { kind: 'set-node', position: vector } : { kind: 'translate', offset: vector });
    }
  };
  const apply = () => {
    previewScheduler.flush();
    const pending = pendingEdit.current;
    if (!pending || pending.baseline !== props.elements) return;
    pendingEdit.current = null;
    commit('Edit refrigerant pipe geometry', { updates: pending.elements.map(element => ({ id: element.id, updates: element })) });
    cancel(); setValues(['0', '0', '0']); setAngle('0');
  };
  const commitLength = (lengthMm: number): boolean => {
    if (!selected || selection.kind !== 'segment') return false;
    cancel();
    const result = buildPipeSegmentLengthEdit({ elements: props.elements, elementId: selected.id, segmentIndex: selection.index, lengthMm, pivot });
    if (!result.ok) { setInvalid(true); setFeedback(result.message); return false; }
    commit('Change pipe segment length', { updates: result.elements.filter(element => element !== props.elements.find(before => before.id === element.id))
      .map(element => ({ id: element.id, updates: element })) });
    return true;
  };
  const appendLength = () => {
    const value = segmentLength.trim() ? Number(segmentLength) : NaN;
    if (!Number.isFinite(value) || !props.onAppendDrawingLength(toMillimeters(value, props.unit))) {
      setInvalid(true); setFeedback('Place a start point, point in a direction, then enter a positive length.');
    } else { setInvalid(false); setFeedback(''); }
  };
  const changeSelection = (next: PipeEditSelection, nextConnected = false) => {
    cancel(); setBendIndex(null); setSelection(next); setConnected(nextConnected);
    if (next.kind !== 'node' && operationMode === 'set-node') setOperationMode('translate');
  };
  const setHorizontalLevel = useCallback((elevationMm: number) => {
    const origin = { x: workplane?.origin.x ?? 0, y: workplane?.origin.y ?? 0, z: elevationMm };
    const candidate: PipeEditWorkplane = { origin, normal: workplane?.normal ?? { x: 0, y: 0, z: 1 }, xAxis: workplane?.xAxis ?? { x: 1, y: 0, z: 0 } };
    const basis = resolvePipeEditFrame({ mode: 'workplane', nodes: [], selection: { kind: 'run' }, workplane: candidate });
    if (!basis) return;
    const drawingPlane = createDrawingPlane('pipe-level-plane', 'work-plane', modelPointToWorld(origin, elevationMm),
      modelPointToWorld(basis.zAxis, basis.zAxis.z), modelPointToWorld(basis.xAxis, basis.xAxis.z));
    drawingPlane.yAxis.copy(modelPointToWorld(basis.yAxis, basis.yAxis.z));
    drawingPlane.localToWorld.makeBasis(drawingPlane.xAxis, drawingPlane.yAxis, drawingPlane.normal).setPosition(drawingPlane.origin);
    drawingPlane.worldToLocal.copy(drawingPlane.localToWorld).invert();
    setWorkplane(candidate);
    setPlaneOrigin([origin.x, origin.y, origin.z].map(value => String(fromMillimeters(value, props.unit))));
    setPlaneNormal([basis.zAxis.x, basis.zAxis.y, basis.zAxis.z].map(String)); setPlaneXAxis([basis.xAxis.x, basis.xAxis.y, basis.xAxis.z].map(String));
    props.onWorkplaneChange(drawingPlane);
  }, [props.unit, props.onWorkplaneChange, workplane]);
  const horizontalPlane = !workplane || Math.hypot(workplane.normal.x, workplane.normal.y) < 1e-8;
  useEffect(() => {
    if (props.drawing && horizontalPlane && workplane && props.drawingElevationMm !== null
      && Math.abs(workplane.origin.z - props.drawingElevationMm) > 0.001) setHorizontalLevel(props.drawingElevationMm);
  }, [props.drawing, props.drawingElevationMm, horizontalPlane, workplane, setHorizontalLevel]);
  const usePlane = () => {
    const origin = parseVector(planeOrigin); const normal = parseVector(planeNormal); const xAxis = parseVector(planeXAxis);
    if (!origin || !normal || !xAxis) { setInvalid(true); setFeedback('The workplane needs a finite origin and nonzero normal.'); return; }
    const candidate = { origin: { x: toMillimeters(origin.x, props.unit), y: toMillimeters(origin.y, props.unit), z: toMillimeters(origin.z, props.unit) }, normal, xAxis };
    const planeFrame = resolvePipeEditFrame({ mode: 'workplane', nodes, selection, workplane: candidate });
    if (!planeFrame) { setInvalid(true); setFeedback('The workplane normal must have a nonzero direction.'); return; }
    cancel(); setWorkplane(candidate); setCoordinateMode('workplane');
    setPlaneNormal([planeFrame.zAxis.x, planeFrame.zAxis.y, planeFrame.zAxis.z].map(String));
    setPlaneXAxis([planeFrame.xAxis.x, planeFrame.xAxis.y, planeFrame.xAxis.z].map(String));
    const drawingPlane = createDrawingPlane('pipe-editor-workplane', 'work-plane', modelPointToWorld(candidate.origin, candidate.origin.z),
      modelPointToWorld(planeFrame.zAxis, planeFrame.zAxis.z), modelPointToWorld(planeFrame.xAxis, planeFrame.xAxis.z));
    // The render world mirrors model Y. Mirror V explicitly as well so its
    // label and numerical direction agree across the handedness change.
    drawingPlane.yAxis.copy(modelPointToWorld(planeFrame.yAxis, planeFrame.yAxis.z));
    drawingPlane.localToWorld.makeBasis(drawingPlane.xAxis, drawingPlane.yAxis, drawingPlane.normal).setPosition(drawingPlane.origin);
    drawingPlane.worldToLocal.copy(drawingPlane.localToWorld).invert();
    props.onWorkplaneChange(drawingPlane);
  };

  if (!active && !props.drawing) return null;
  const count = expanded && selected ? connectedPipeIds(selected.id, props.elements).length : 0;
  const lock = !!selected && ['routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed'].some(key => selected.properties[key] === true);
  const lengthMm = selection.kind === 'segment' && nodes[selection.index] && nodes[selection.index + 1]
    ? Math.hypot(nodes[selection.index + 1]!.x - nodes[selection.index]!.x, nodes[selection.index + 1]!.y - nodes[selection.index]!.y, nodes[selection.index + 1]!.z - nodes[selection.index]!.z) : null;
  return <>
    {active && frame && pivotPoint && <PipeEditGizmo key={selected.id} controllerRef={props.controllerRef} width={props.width} height={props.height}
      nodes={nodes} controlIndices={controlIndices} coordinateMode={coordinateMode} previewNodes={preview?.find(element => element.id === selected.id) ? editablePipeNodes(preview.find(element => element.id === selected.id)!) : null}
      frame={frame} pivot={pivotPoint} pivotEnd={pivot} mode={operationMode === 'rotate' ? 'rotate' : 'translate'}
      movingPort={bendIndex !== null && bend ? resolvePipeBendEdit(preview?.find(element => element.id === selected.id) ?? selected, bendIndex, pivot)?.movingPort : undefined}
      disabled={lock || (bendIndex !== null && !bend)} invalid={invalid} onPreview={(operation, directSelection) => previewScheduler.schedule({ operation, selection: directSelection })} onCommit={apply} onCancel={cancel} rotationAxisOnly={bend ? 'x' : undefined}
      selection={effectiveSelection} showTransform={showTransform} onSelect={next => { changeSelection(next); setShowTransform(false); setOperationMode('translate'); }} workplane={workplane}
      lengthMm={lengthMm} unit={props.unit} onCommitLength={commitLength}
      fixedEndpoints={{ start: !!(selected.properties.startConnection || selected.properties.startBundleConnection), end: !!(selected.properties.endConnection || selected.properties.endBundleConnection) }} />}
    <div className="pointer-events-none absolute left-3 right-3 top-12 z-[25] text-slate-700"
      data-testid="pipe-editing-tools" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <div role="toolbar" aria-label={props.drawing ? 'Draw refrigerant pipe' : 'Edit refrigerant pipe'} className="pointer-events-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/95 p-2 shadow-sm backdrop-blur">
        <span className="max-w-36 truncate px-1 text-xs font-semibold" title={selected?.label}>{props.drawing ? 'Draw pipe' : selected?.label || 'Pipe'}{lock ? ' · Locked' : ''}</span>
        {active && <><select aria-label="Edit scope" className={`${inputClass} !w-auto`} value={bendIndex !== null || connected || selection.kind === 'section' ? 'advanced' : selection.kind}
          onChange={event => { if (event.target.value === 'advanced') { setExpanded(true); return; }
            changeSelection(event.target.value === 'segment' ? { kind: 'segment', index: controlIndices.segments[0] ?? 0 }
              : event.target.value === 'node' ? { kind: 'node', index: 0 } : { kind: 'run' }); }}>
          <option value="run">{selectedPipes.length > 1 ? `${selectedPipes.length} runs` : 'Whole run'}</option><option value="segment">{selection.kind === 'segment' ? `Segment ${selection.index + 1}` : 'Segment'}</option>
          <option value="node">{selection.kind === 'node' ? `Point ${selection.index + 1}` : 'Point'}</option><option value="advanced">More scopes…</option></select>
          {lengthMm !== null && <><span className="text-xs text-slate-500">Length</span><PipeDimensionInput valueMm={lengthMm} unit={props.unit} onCommit={commitLength} disabled={lock} />
            <select aria-label="Length fixed endpoint" className={`${inputClass} !w-auto`} value={pivot} onChange={event => { cancel(); setPivot(event.target.value as typeof pivot); }}>
              <option value="start">Keep start</option><option value="end">Keep end</option></select></>}
          <span className="h-5 border-l border-slate-200" aria-hidden="true" />
          <button type="button" className={`${buttonClass} ${showTransform && operationMode === 'translate' ? 'bg-teal-50 text-teal-800' : ''}`} aria-label="Move pipe selection" aria-pressed={showTransform && operationMode === 'translate'} disabled={lock}
          onClick={() => { cancel(); setOperationMode('translate'); setShowTransform(operationMode !== 'translate' || !showTransform); }}>Move</button>
          <button type="button" className={`${buttonClass} ${showTransform && operationMode === 'rotate' ? 'bg-teal-50 text-teal-800' : ''}`} aria-label="Rotate pipe selection" aria-pressed={showTransform && operationMode === 'rotate'} disabled={lock || selection.kind === 'node'}
            onClick={() => { cancel(); setOperationMode('rotate'); setShowTransform(operationMode !== 'rotate' || !showTransform); }}>Rotate</button>
          {selection.kind === 'segment' && <button type="button" className={buttonClass} disabled={lock} title="Add a route point at this segment's midpoint" onClick={() => { makePreview({ kind: 'insert' }); apply(); }}>Split</button>}
          {selection.kind === 'node' && selection.index > 0 && selection.index < nodes.length - 1 && <button type="button" className={buttonClass} disabled={lock} onClick={() => { makePreview({ kind: 'remove' }); apply(); }}>Remove point</button>}
          <button type="button" className={buttonClass} onClick={props.onPlaceBranchKit}>Branch kit</button></>}
        {props.drawing && <><PipeDrawingControls unit={props.unit} serviceLocked={props.drawingStarted} serviceMode={props.drawingService}
          elevationMm={props.drawingElevationMm ?? workplane?.origin.z ?? defaultDrawingLevel} elevationDisabled={!horizontalPlane}
          onElevationChange={value => { if (props.onSetDrawingElevation(value)) { cancel(); setHorizontalLevel(value); } }} />
          <label className="flex items-center gap-1.5 text-xs text-slate-500">Length
            <input ref={lengthInputRef} type="number" min="0" step="any" aria-label="Next segment length" title="Point in a direction and type a length. Enter adds the segment." className={`${inputClass} !w-20`} value={segmentLength} onChange={event => setSegmentLength(event.target.value)}
              onBlur={() => { keyboardLengthEntry.current = false; }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); appendLength(); event.currentTarget.blur(); }
                if (event.key === 'Escape') { event.preventDefault(); setSegmentLength(lengthBeforeTyping.current); event.currentTarget.blur(); }
              }} />
            <span className="text-[10px]">{getUnitLabel(props.unit)}</span></label>
          <button type="button" className={buttonClass} disabled={!props.drawingStarted} onClick={appendLength}>Add length</button>
          <span className="h-5 border-l border-slate-200" aria-hidden="true" />
          <button type="button" className={buttonClass} title="Backspace" disabled={!props.drawingStarted} onClick={props.onUndoDrawingStep}>Undo step</button>
          <button type="button" className={`${buttonClass} bg-teal-700 text-white hover:bg-teal-800`} title="Enter" disabled={!props.drawingStarted} onClick={props.onFinishDrawing}>Finish</button>
          <button type="button" className={buttonClass} title="Escape" onClick={props.onCancelDrawing}>Cancel</button></>}
        <button type="button" className={buttonClass} aria-expanded={expanded} aria-label="Pipe edit details" onClick={() => setExpanded(!expanded)}>{expanded ? 'Close details' : 'Details'}</button></div>
      {expanded && <div className="pointer-events-auto mt-2 w-80 max-w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 shadow-lg" style={{ maxHeight: Math.max(160, props.height - 140) }} data-testid="pipe-details-panel">
      {expanded && active && selected && <div className="mt-3 space-y-3">
        <p className="truncate text-xs text-slate-500" title={selected.label}>{selected.label || 'Refrigerant pipe'}</p>
        {selectedPipes.length > 1 && <label className="block text-xs">Reference pipe<select className={inputClass} value={selected.id} aria-label="Reference pipe"
          onChange={event => { cancel(); setPreferredId(event.target.value); }}>{selectedPipes.map(element => <option key={element.id} value={element.id}>{element.label || element.id}</option>)}</select></label>}
        <label className="block text-xs">Selection<select aria-label="Pipe edit selection" className={inputClass}
          value={bendIndex !== null ? 'bend' : connected ? 'connected' : selection.kind} onChange={event => {
            const kind = event.target.value;
            if (kind === 'bend') { cancel(); setBendIndex(bendIndices[0] ?? null); setConnected(false); setSelection({ kind: 'run' }); setOperationMode('rotate'); setShowTransform(true); setRotationAxis('x'); return; }
            changeSelection(kind === 'node' ? { kind: 'node', index: 0 } : kind === 'segment' ? { kind: 'segment', index: 0 }
              : kind === 'section' ? { kind: 'section', startIndex: 0, endIndex: nodes.length - 1 } : { kind: 'run' }, kind === 'connected');
          }}><option value="run">{selectedPipes.length > 1 ? `Complete selected runs (${selectedPipes.length})` : 'Complete pipe run'}</option><option value="connected">Connected pipes ({count})</option>
          <option value="node">Endpoint / route point</option><option value="segment">Straight segment</option><option value="section">Rigid route section</option><option value="bend" disabled={bendIndices.length === 0 || selected.type !== 'refrigerant-pipe'}>Bend + adjoining route</option></select></label>
        {bendIndex !== null && <label className="block text-xs">Bend at point<select className={inputClass} aria-label="Selected bend" value={bendIndex}
          onChange={event => { cancel(); setBendIndex(Number(event.target.value)); }}>{bendIndices.map(index => <option key={index} value={index}>Point {index + 1}</option>)}</select></label>}
        {(selection.kind === 'node' || selection.kind === 'segment') && <label className="block text-xs">{selection.kind === 'node' ? 'Point' : 'Segment'}
          <select className={inputClass} aria-label="Selected route index" value={selection.index} onChange={event => changeSelection({ ...selection, index: Number(event.target.value) })}>
            {(selection.kind === 'node' ? controlIndices.nodes : controlIndices.segments).map(index => <option key={index} value={index}>{index + 1}{index === 0 ? ' · Start' : selection.kind === 'node' && index === nodes.length - 1 ? ' · End' : ''}</option>)}
          </select></label>}
        {selection.kind === 'section' && <div className="grid grid-cols-2 gap-2">{(['startIndex', 'endIndex'] as const).map(key => <label className="text-xs" key={key}>
          {key === 'startIndex' ? 'First point' : 'Last point'}<input type="number" min={1} max={nodes.length} value={selection[key] + 1} className={inputClass}
            onChange={event => changeSelection({ ...selection, [key]: Number(event.target.value) - 1 })} /></label>)}</div>}
        <label className="block text-xs">Coordinates<select className={inputClass} aria-label="Pipe coordinate mode" value={bend ? 'local' : coordinateMode} disabled={bendIndex !== null}
          onChange={event => { cancel(); setCoordinateMode(event.target.value as PipeEditCoordinateMode); }}>
          <option value="world">World · X Y Z</option><option value="local">Local · selected segment</option><option value="workplane" disabled={!workplane}>Workplane · U V N</option>
        </select></label>
        <div role="toolbar" aria-label="Pipe operation" className="flex gap-1">{((bendIndex !== null ? ['rotate'] : ['translate', 'rotate', ...(selection.kind === 'node' ? ['set-node'] : [])]) as Array<typeof operationMode>).map(mode =>
          <button key={mode} type="button" className={`${buttonClass} ${operationMode === mode ? 'bg-teal-50 text-teal-800' : ''}`} aria-pressed={operationMode === mode}
            onClick={() => { cancel(); setOperationMode(mode); setShowTransform(true); if (mode === 'set-node' && frame && selection.kind === 'node') {
              const point = pipeEditPointFromWorld(nodes[selection.index]!, frame);
              setValues([point.x, point.y, point.z].map(number => String(Number(fromMillimeters(number, props.unit).toFixed(4)))));
            } }}>{mode === 'translate' ? 'Move' : mode === 'rotate' ? 'Rotate' : 'Coordinates'}</button>)}</div>
        {operationMode === 'rotate' ? <>
          <div className="grid grid-cols-2 gap-2"><label className="text-xs">Fixed pivot<select aria-label="Fixed pipe pivot" value={pivot} className={inputClass} onChange={event => { cancel(); setPivot(event.target.value as typeof pivot); }}>
            <option value="start">{bendIndex !== null ? 'Inlet connection' : 'First endpoint'}</option><option value="end">{bendIndex !== null ? 'Outlet connection' : 'Opposite endpoint'}</option></select></label>
          <label className="text-xs">Axis<select aria-label="Rotation axis" className={inputClass} value={rotationAxis} onChange={event => { cancel(); setRotationAxis(event.target.value as typeof rotationAxis); }}>
            {(bendIndex !== null ? ['x'] : ['x', 'y', 'z']).map((axis, index) => <option key={axis} value={axis}>{frame?.labels[index] ?? axis.toUpperCase()}</option>)}</select></label></div>
          <label className="block text-xs">Angle (degrees)<input aria-label="Pipe rotation angle" type="number" step="any" value={angle} className={inputClass}
            onChange={event => { cancel(); setAngle(event.target.value); }} /></label>
          <p className="text-[11px] leading-4 text-slate-500">{bend ? `Rolls the ${bend.angleDegrees.toFixed(0)}° bend and its adjoining route around the fixed connection. Radius ${bend.radiusMm.toFixed(2)} mm stays unchanged.` : 'The selected section stays rigid. Its fixed endpoint and connected port directions are checked.'}</p>
        </> : <NumberVector label={`${operationMode === 'set-node' ? 'Coordinates' : 'Offset'} (${getUnitLabel(props.unit)})`} value={values} labels={frame?.labels}
          onChange={value => { cancel(); setValues(value); }} />}
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={lock || !frame} onClick={previewNumbers}>Preview</button>
          <button type="button" className={`${buttonClass} bg-teal-700 text-white hover:bg-teal-800`} disabled={!preview || invalid} onClick={apply}>Apply</button>
          <button type="button" className={buttonClass} onClick={cancel}>Cancel</button>
          {selection.kind === 'segment' && <button type="button" className={buttonClass} disabled={lock} onClick={() => makePreview({ kind: 'insert' })}>Insert midpoint</button>}
          {selection.kind === 'node' && <button type="button" className={buttonClass} disabled={lock || selection.index === 0 || selection.index === nodes.length - 1}
            onClick={() => makePreview({ kind: 'remove' })}>Remove point</button>}</div>
        <details className="text-xs"><summary className="cursor-pointer text-slate-500">Connections and regeneration</summary><div className="mt-2 space-y-2">
          <p>Equipment and branch kits stay fixed. Conflicting moves are rejected. Select connected pipes to move attached pipe sections together.</p>
          <label className="flex gap-2"><input type="checkbox" checked={selected.properties.routeLocked === true} onChange={event => { cancel(); commit('Change pipe geometry lock', {
            updates: [{ id: selected.id, updates: { properties: { routeLocked: event.target.checked } } }],
          }); }} />Lock pipe geometry</label>
          {!!selected.properties.autoRouteNetwork && <><p>Generated circuit: {pipeRegenerationPolicy(selected) === 'retain' ? 'manual edits retained' : pipeRegenerationPolicy(selected) === 'reconsider' ? 'released for auto rerouting' : 'generated layout'}.</p>
            <div className="flex gap-2"><button type="button" className={buttonClass} onClick={() => { cancel(); setPolicy([selected.id], 'retain'); }}>Retain edits</button>
              <button type="button" className={buttonClass} disabled={isPipeRouteLocked(selected)} onClick={() => { cancel(); setPolicy([selected.id], 'reconsider'); }}>Allow auto rerouting</button></div>
            {isPipeRouteLocked(selected) && <p>Clear geometry, level, review and bypass locks before releasing this circuit.</p>}</>}
        </div></details>
      </div>}
      {expanded && <div className="mt-3 border-t border-slate-100 pt-2"><button type="button" className="text-xs text-teal-700" aria-expanded={showPlane} onClick={() => setShowPlane(!showPlane)}>
        {workplane ? 'Edit active workplane · U V N' : 'Set a workplane'}</button>
        {showPlane && <div className="mt-2 space-y-2"><NumberVector label={`Plane origin (${getUnitLabel(props.unit)})`} value={planeOrigin} onChange={setPlaneOrigin} />
          <NumberVector label="Plane normal" value={planeNormal} onChange={setPlaneNormal} />
          <NumberVector label="U direction" value={planeXAxis} onChange={setPlaneXAxis} />
          <div className="flex gap-2"><button type="button" className={buttonClass} onClick={usePlane}>Use workplane</button>
            <button type="button" className={buttonClass} onClick={() => { cancel(); setWorkplane(null); setCoordinateMode('world'); props.onWorkplaneChange(null); }}>Clear</button></div>
          <p className="text-[11px] leading-4 text-slate-500">The origin and normal stay fixed when the camera moves. Edge-on drawing pauses until a stable view is available.</p>
        </div>}
      </div>}
      {expanded && active && <p className="mt-2 text-[11px] text-slate-500">Drag to edit · Release to apply · Escape to cancel</p>}
      </div>}
      {feedback && (invalid || expanded) && <p role={invalid ? 'alert' : 'status'} className={`pointer-events-auto mt-2 w-fit max-w-sm rounded-md border bg-white px-3 py-2 text-xs leading-5 shadow-sm ${invalid ? 'border-amber-200 text-amber-900' : 'border-slate-200 text-teal-800'}`}>{feedback}</p>}
    </div>
  </>;
}
