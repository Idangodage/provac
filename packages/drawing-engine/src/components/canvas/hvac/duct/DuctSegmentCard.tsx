'use client';

/**
 * The duct segment card's content, as the duct SegmentProvider: what a
 * segment of a duct run is (its header), its air in one strip of figures,
 * how it is built, its options (ductSegmentOptions) with their pressure and
 * mass as chips, and its Edit tab —
 *
 *  - a straight's dimensions: its length (the run re-solved, its ends kept),
 *    and its size, round or rectangular, for the leg or every leg of its size;
 *  - an elbow's radius, a transition's taper, a take-off's or an accessory's
 *    position, an attenuator's length, an access door's size;
 *  - a runout's length, a terminal's neck and airflow.
 *
 * The shared card (segments/SegmentCardLayer) places it, previews and applies
 * its options, and keeps it on its segment after an edit (the same key, else
 * the leg it became).
 */
import { ArrowDownToLine, Coins, Flag, Gauge, Star, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { HvacElement } from '../../../../types';
import {
  ChipRow,
  EditBlock,
  ResultRow,
  STATUS_DOT,
  STATUS_TEXT,
  Stepper,
  ValueField as SegmentValueField,
  clamp,
  formatNumber as number,
  formatRange as range,
  formatSigned as signed,
} from '../segments/SegmentCardKit';
import type { SegmentBadge, SegmentCardModel, SegmentFieldHost, SegmentProvider } from '../segments/segmentProvider';
import { useSegmentUiStore, type SegmentFocus } from '../segments/segmentUiStore';

import { DuctSegmentGlyph } from './DuctSegmentGlyph';
import { getActiveDuctBuilding } from './ductBuilding';
import { commitDuctSegmentEdit } from './ductEditController';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { ductLegs } from './ductGeometry';
import { rectangularEquivalents, roundEquivalents, sameSectionSize } from './ductSectionEquivalents';
import { MIN_STRAIGHT_MM, transitionStretch } from './ductSegmentEdits';
import { ductSegmentFigures, type DuctSegmentFigures } from './ductSegmentFigures';
import {
  ductSegmentOptions,
  evaluateDuctSegmentOption,
  rankDuctOptions,
  scopeLegs,
  segmentOptionContext,
  type DuctOptionBadge,
  type DuctOptionEvaluation,
  type DuctOptionScope,
  type DuctSegmentOption,
  type DuctSegmentOptionContext,
} from './ductSegmentOptions';
import { ductSegmentOf, neighbourSegment, sectionLabel, segmentIssues, type DuctSegment } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import { equivalentDiameterMm } from './ductSizing';
import { readDuctTerminalSpec } from './ductTerminals';
import { isRoundLeg, roundLeg, type DuctLeg, type DuctRunSpec } from './ductTypes';

export type DuctSegmentProvider = SegmentProvider<DuctSegmentOption, DuctOptionEvaluation>;
type DuctCardModel = SegmentCardModel<DuctSegmentOption, DuctOptionEvaluation>;

const BADGES: Record<DuctOptionBadge, SegmentBadge> = {
  recommended: { icon: <Star size={12} aria-hidden="true" />, tone: 'text-emerald-600 fill-emerald-500/20', label: 'Recommended', title: 'Recommended: the lowest life-cycle cost (first cost + fan energy) of the options that break no rule' },
  'lowest-pressure': { icon: <Gauge size={12} aria-hidden="true" />, tone: 'text-sky-600', label: 'Lowest ΔP', title: 'Lowest pressure on the fan\'s index path' },
  'lowest-cost': { icon: <Coins size={12} aria-hidden="true" />, tone: 'text-amber-600', label: 'Lowest cost', title: 'Lowest first cost (placeholder rates until the supplier\'s are entered)' },
  'saves-height': { icon: <ArrowDownToLine size={12} aria-hidden="true" />, tone: 'text-indigo-600', label: 'Saves height', title: 'Needs 25 mm or more less of the ceiling void' },
};

function markRange(segment: DuctSegment): string {
  return segment.marks.length > 1 ? `${segment.marks[0]}…${segment.marks[segment.marks.length - 1]}` : segment.marks[0] ?? '';
}

// ---------------------------------------------------------------------------------------------------- small parts

/** The segment's air in one strip: airflow · velocity (against its limit) · pressure; the rest in tooltips. */
function FigureStrip({ figures }: { figures: DuctSegmentFigures | null }) {
  const flow = figures?.flow ?? null;
  if (!flow) {
    const why = !figures?.system ? 'This run is not on a unit\'s system.'
      : !figures.system.terminals ? 'The system reaches no air terminal yet.' : 'Give the unit or its terminals an airflow.';
    return <p className="px-3 pb-2 text-[11px] text-slate-400" data-testid="duct-segment-no-flow" title={why}>No airflow yet</p>;
  }
  const stat = (value: string, unit: string, title: string, dot?: string) => (
    <span className="inline-flex items-baseline gap-1" title={title}>
      {dot ? <span className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${dot}`} aria-hidden="true" /> : null}
      <span className="text-[13px] font-semibold tabular-nums text-slate-900">{value}</span>
      <span className="text-[10.5px] text-slate-400">{unit}</span>
    </span>
  );
  const system = figures?.system;
  return (
    <div className="flex items-center gap-x-3 px-3 pb-2" data-testid="duct-segment-figures">
      {stat(range(flow.airflowM3h, 0), 'm³/h', `Airflow ${range(flow.airflowM3h, 0)} m³/h (${flow.part}) · ${flow.terminals} terminal${flow.terminals === 1 ? '' : 's'}`)}
      {stat(range(flow.velocityMs, 1), 'm/s', `Velocity ${range(flow.velocityMs, 1)} m/s, ${STATUS_TEXT[flow.velocityStatus]} (${number(flow.limits.velocityMs, 1)} m/s for a ${flow.part})`, STATUS_DOT[flow.velocityStatus])}
      {stat(number(flow.totalPa, flow.totalPa < 10 ? 1 : 0), 'Pa', `Pressure ${number(flow.totalPa, 1)} Pa${flow.coefficient !== null ? ` · ζ ${number(flow.coefficient, 2)}` : ''} · friction ${number(flow.frictionPaPerM, 2)} Pa/m (${STATUS_TEXT[flow.frictionStatus]}, target ${number(flow.limits.frictionPaPerM, 2)})`)}
      {flow.onIndexPath ? (
        <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-amber-50 p-1 text-amber-600 ring-1 ring-inset ring-amber-200"
          title={`On the fan's index path${system?.indexPa ? ` (${number(system.indexPa)} Pa)` : ''}: the path the fan has to overcome runs through this segment`}>
          <Flag size={10} aria-hidden="true" /><span className="sr-only">On the index path</span>
        </span>
      ) : null}
    </div>
  );
}

/** How the segment is built: its sheet, joints and class; its pieces; its system. */
function BuildInfo({ figures }: { figures: DuctSegmentFigures | null }) {
  const construction = figures?.construction ?? null;
  return (
    <>
      {construction ? (
        <div>
          GI {construction.sheetMm !== null ? `${construction.sheetMm.toFixed(2)} mm (${construction.gauge})` : '—'} · {construction.joint} · {construction.seam}
          {construction.insulationMm > 0 ? ` · NBR ${Math.round(construction.insulationMm)}` : ''} · {construction.pressureClassPa} Pa class
        </div>
      ) : null}
      {figures ? (
        <div>
          {figures.fabrication.pieces} piece{figures.fabrication.pieces === 1 ? '' : 's'} · {(figures.fabrication.lengthMm / 1000).toFixed(2)} m
          {figures.fabrication.areaM2 > 0 ? ` · ${figures.fabrication.areaM2.toFixed(2)} m² · ${figures.fabrication.massKg.toFixed(1)} kg` : ''}
        </div>
      ) : null}
      {figures?.system ? <div>{figures.system.unitLabel ?? 'unit'} {figures.system.service}{figures.system.airflowM3h ? ` · ${number(figures.system.airflowM3h)} m³/h` : ''}</div> : null}
    </>
  );
}

/** What an option does, as chips: its change in pressure and mass, and any rule it would newly break. */
function DeltaChips({ evaluation }: { evaluation: DuctOptionEvaluation }) {
  const chips: ReactNode[] = [];
  const pressure = evaluation.deltaIndexPa ?? evaluation.deltaSegmentPa;
  if (pressure !== null && Math.abs(pressure) >= 0.05) {
    chips.push(<span key="dp" className={`rounded px-1 tabular-nums ${pressure < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
      title={evaluation.deltaIndexPa !== null ? 'Change on the fan\'s index path' : 'Change in this segment\'s loss'}>ΔP {signed(pressure, 1)}</span>);
  }
  if (Math.abs(evaluation.deltaMassKg) >= 0.05) {
    chips.push(<span key="kg" className="rounded bg-slate-100 px-1 tabular-nums text-slate-600" title="Change in galvanised sheet">{signed(evaluation.deltaMassKg, 1)} kg</span>);
  }
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error');
  if (errors.length) {
    chips.push(
      <span key="err" className="inline-flex items-center gap-0.5 rounded bg-red-50 px-1 font-medium text-red-700"
        title={errors.map((issue) => `${issue.code}: ${issue.message}`).join('\n')}>
        <TriangleAlert size={10} aria-hidden="true" />{errors.length}
        <span className="sr-only"> new error{errors.length === 1 ? '' : 's'}</span>
      </span>,
    );
  }
  if (chips.length === 0) return null;
  return <span className="flex shrink-0 items-center gap-1 text-[10.5px]">{chips}</span>;
}

/** An option's whole result on one line: velocity, pressure, mass, height, and the rules it would break. */
function ResultLine({ evaluation }: { evaluation: DuctOptionEvaluation }) {
  if (evaluation.refused) return <span className="text-red-700">{evaluation.refused}</span>;
  const parts: ReactNode[] = [];
  if (evaluation.velocityMs !== null) {
    const status = evaluation.velocityStatus ?? 'ok';
    parts.push(<span key="v" className={status === 'over' ? 'text-red-700' : status === 'near' ? 'text-amber-700' : ''}>{number(evaluation.velocityMs, 1)} m/s</span>);
  }
  const pressure = evaluation.deltaIndexPa ?? evaluation.deltaSegmentPa;
  if (pressure !== null && Math.abs(pressure) >= 0.05) parts.push(<span key="p" className={pressure < 0 ? 'text-emerald-700' : 'text-amber-700'}>ΔP {signed(pressure, 1)} Pa</span>);
  if (Math.abs(evaluation.deltaMassKg) >= 0.05) parts.push(<span key="m">{signed(evaluation.deltaMassKg, 1)} kg</span>);
  if (evaluation.deltaOuterHeightMm !== null && Math.abs(evaluation.deltaOuterHeightMm) >= 5) {
    parts.push(<span key="h" className={evaluation.deltaOuterHeightMm < 0 ? 'text-emerald-700' : 'text-amber-700'}>{signed(evaluation.deltaOuterHeightMm)} mm high</span>);
  }
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error').length;
  const warnings = evaluation.newIssues.length - errors;
  if (errors) parts.push(<span key="e" className="font-medium text-red-700">{errors} new error{errors === 1 ? '' : 's'}</span>);
  if (warnings) parts.push(<span key="w" className="text-amber-700">{warnings} new warning{warnings === 1 ? '' : 's'}</span>);
  return <span className="tabular-nums">{parts.map((part, index) => <span key={index}>{index ? ' · ' : ''}{part}</span>)}</span>;
}

const resultLine = (evaluation: DuctOptionEvaluation) => <ResultLine evaluation={evaluation} />;
/** A value field of a duct segment (its options keep their literal kinds). */
const ValueField = SegmentValueField<DuctSegmentOption, DuctOptionEvaluation>;

/** The card's field host, with the drawing the duct editors read. */
interface FieldHost extends SegmentFieldHost<DuctSegmentOption, DuctOptionEvaluation> {
  scene: readonly HvacElement[];
  settings: DuctDesignSettings;
  focus: SegmentFocus;
}

/** Equal-friction size of `section` in the other shape, at the void the duct has. */
function otherShape(section: DuctLeg, settings: DuctDesignSettings, voidHeightMm: number): DuctLeg {
  if (isRoundLeg(section)) {
    const rects = rectangularEquivalents(section.diameterMm!, { maxHeightMm: Math.min(voidHeightMm, section.diameterMm!), maxAspect: settings.aspectRatioAdvisory });
    return [...rects].sort((a, b) => Math.abs(a.widthMm / a.heightMm - 2) - Math.abs(b.widthMm / b.heightMm - 2))[0] ?? { widthMm: section.widthMm, heightMm: section.heightMm };
  }
  return roundEquivalents(section, settings.autoRoundSizesMm).atOrAbove ?? roundLeg(Math.round(equivalentDiameterMm(section)));
}

/** Type the size of a leg (or of every leg of its size), round or rectangular; see what it does, then apply. */
function SizeEditor({ host, segment, spec, voidHeightMm }: { host: FieldHost; segment: DuctSegment; spec: DuctRunSpec; voidHeightMm: number }) {
  const { scene, settings, focus } = host;
  const current = spec.legs[segment.legIndex]!;
  const [shape, setShape] = useState<'rect' | 'round'>(isRoundLeg(current) ? 'round' : 'rect');
  const [width, setWidth] = useState(String(Math.round(current.widthMm)));
  const [height, setHeight] = useState(String(Math.round(current.heightMm)));
  const [diameter, setDiameter] = useState(String(Math.round(current.diameterMm ?? equivalentDiameterMm(current))));
  const [scope, setScope] = useState<DuctOptionScope>('leg');
  const sameSize = scopeLegs(spec, segment.legIndex, 'size').length;
  const legs = scopeLegs(spec, segment.legIndex, scope);
  const section: DuctLeg | null = useMemo(() => {
    if (shape === 'round') {
      const d = Number.parseFloat(diameter);
      return Number.isFinite(d) && d >= 75 && d <= 2000 ? roundLeg(Math.round(d)) : null;
    }
    const w = Number.parseFloat(width);
    const h = Number.parseFloat(height);
    return Number.isFinite(w) && Number.isFinite(h) && w >= 50 && h >= 50 && w <= 4000 && h <= 2000 ? { widthMm: Math.round(w), heightMm: Math.round(h) } : null;
  }, [shape, width, height, diameter]);
  const option = useMemo<DuctSegmentOption | null>(() => (section && !sameSectionSize(section, current) && legs.length
    ? {
      id: `custom:${sectionLabel(section)}:${scope}`, group: 'size', glyph: isRoundLeg(section) ? 'round' : 'rect', title: sectionLabel(section), detail: 'as typed',
      edit: { kind: 'leg-section', runId: focus.runId, sections: legs.map((leg) => ({ leg, section })) },
    } : null), [section, current, legs, scope, focus.runId]);
  const evaluation = useMemo(() => (option ? evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, option) : null), [option, scene, settings, focus.runId, focus.key]);
  const switchShape = (next: 'rect' | 'round') => {
    if (next === shape) return;
    const base = section ?? current;
    const other = otherShape(base, settings, voidHeightMm);
    if (next === 'round') setDiameter(String(other.diameterMm ?? Math.round(equivalentDiameterMm(base))));
    else {
      setWidth(String(other.widthMm));
      setHeight(String(other.heightMm));
    }
    setShape(next);
  };
  const apply = () => {
    if (option && evaluation && !evaluation.refused) host.onApply(option);
  };
  // While the pointer is on it, the drawing follows the size as it changes (typed, stepped or scrubbed).
  const [inside, setInside] = useState(false);
  const hostRef = useRef(host);
  hostRef.current = host;
  const shown = option && !evaluation?.refused ? option : null;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (inside) hostRef.current.onPreview(shownRef.current);
  }, [inside, shown?.id]);
  return (
    <div className="rounded-lg px-1 py-1" data-testid="duct-segment-size"
      onPointerEnter={() => {
        setInside(true);
        if (option && !evaluation?.refused) host.onPreview(option);
        if (option) host.onHover({ option, evaluation: evaluation ?? undefined });
      }}
      onPointerLeave={() => {
        setInside(false);
        host.onPreview(null);
        host.onHover(null);
      }}>
      <div className="flex items-center gap-2">
        <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500" title="Width × depth (or diameter), clear inside">Section</span>
        <span className="inline-flex rounded-lg bg-slate-100 p-0.5" role="radiogroup" aria-label="Shape">
          {(['rect', 'round'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={shape === value}
              className={`rounded-md px-2 py-[1px] text-[11px] font-medium transition-colors ${shape === value ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              onClick={() => switchShape(value)}>{value === 'rect' ? '▭ Rect' : '◯ Round'}</button>
          ))}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 pl-[76px]">
        {shape === 'round' ? (
          <>
            <Stepper label="Diameter" value={diameter} onChange={setDiameter} onEnter={apply} step={50} fineStep={10} min={75} max={2000} scrubLabel="Ø" onScrubEnd={apply} />
          </>
        ) : (
          <>
            <Stepper label="Width" value={width} onChange={setWidth} onEnter={apply} step={50} fineStep={10} min={50} max={4000} width="w-12" scrubLabel="W" onScrubEnd={apply} />
            <span className="text-[11px] text-slate-400">×</span>
            <Stepper label="Depth" value={height} onChange={setHeight} onEnter={apply} step={50} fineStep={10} min={50} max={2000} width="w-12" scrubLabel="D" onScrubEnd={apply} />
          </>
        )}
        <span className="text-[10.5px] text-slate-400">mm</span>
      </div>
      {sameSize > 1 ? (
        <div className="mt-1 flex items-center gap-3 pl-[76px] text-[11px] text-slate-500" role="radiogroup" aria-label="Apply to">
          {(['leg', 'size'] as const).map((value) => (
            <label key={value} className="inline-flex cursor-pointer items-center gap-1">
              <input type="radio" name={`scope-${focus.runId}-${focus.key}`} checked={scope === value} onChange={() => setScope(value)} className="accent-violet-600" />
              {value === 'leg' ? 'This leg' : `All ${sameSize} of ${sectionLabel(current)}`}
            </label>
          ))}
        </div>
      ) : null}
      {evaluation ? <ResultRow evaluation={evaluation} result={host.result} onApply={apply} /> : null}
    </div>
  );
}

/** An elbow's inner radius: a slider of its ratio, and the ratio and the throat radius as numbers; release or Enter applies. */
function RadiusEditor({ host, plan, segment }: { host: FieldHost; plan: DuctFabricationPlan; segment: DuctSegment }) {
  const { scene, settings, focus } = host;
  const piece = plan.pieces[segment.pieceIndices[0]!]!;
  const elbow = piece.elbow;
  const node = segment.nodeIndex;
  const inPlane = elbow?.inPlaneMm ?? piece.widthMm;
  const now = elbow && inPlane > 0 ? Math.round((elbow.centrelineRadiusMm / inPlane) * 100) / 100 : 1;
  const [value, setValue] = useState(now);
  const [text, setText] = useState(now.toFixed(2));
  const [throatText, setThroatText] = useState(String(Math.max(0, Math.round(now * inPlane - inPlane / 2))));
  useEffect(() => {
    setValue(now);
    setText(now.toFixed(2));
    setThroatText(String(Math.max(0, Math.round(now * inPlane - inPlane / 2))));
  }, [now, inPlane]);
  if (!elbow || node === undefined || elbow.style === 'square-vaned') return null;
  const round = elbow.style === 'gored';
  const min = round ? 1 : 0.5;
  const ratioName = round ? 'R/D' : elbow.plane === 'vertical' ? 'R/H' : 'R/W';
  const override = plan.spec.nodeOverrides[String(node)] ?? {};
  const optionAt = (ratio: number): DuctSegmentOption => ({
    id: `tune:${ratio}`, group: 'tune', glyph: round ? 'elbow-gored' : 'elbow-radius', title: `${ratioName} ${ratio.toFixed(2)}`, detail: `inner radius: throat ${Math.max(0, Math.round(ratio * inPlane - inPlane / 2))} mm`,
    edit: { kind: 'node', runId: focus.runId, node, override: { ...override, ...(round ? {} : { elbowStyle: 'radius' as const }), centrelineRatio: ratio } },
  });
  const setRatio = (ratio: number, from: 'ratio' | 'throat' | 'slider') => {
    const next = Math.round(clamp(ratio, min, 3) * 100) / 100;
    setValue(next);
    if (from !== 'ratio') setText(next.toFixed(2));
    if (from !== 'throat') setThroatText(String(Math.max(0, Math.round(next * inPlane - inPlane / 2))));
  };
  const changed = Math.abs(value - now) > 0.001;
  const evaluation = changed ? evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, optionAt(value)) : null;
  const commit = () => {
    if (changed && evaluation && !evaluation.refused) host.onApply(optionAt(value));
  };
  const preview = (ratio: number) => {
    if (Math.abs(ratio - now) > 0.001) {
      host.onPreview(optionAt(ratio));
      host.onHover({ option: optionAt(ratio), evaluation: evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, optionAt(ratio)) });
    } else {
      host.onPreview(null);
      host.onHover(null);
    }
  };
  return (
    <div className="rounded-lg px-1 py-1" data-testid="duct-segment-tune" onPointerLeave={() => { host.onPreview(null); host.onHover(null); }}>
      <div className="flex items-center gap-2">
        <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500">Inner radius</span>
        <input
          type="range" min={min} max={2} step={0.05} value={Math.min(value, 2)} aria-label={`Elbow ${ratioName}`}
          aria-valuetext={`throat radius ${throatText} millimetres, ${ratioName} ${value.toFixed(2)}`}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-violet-600"
          onChange={(event) => {
            const next = Number.parseFloat(event.target.value);
            setRatio(next, 'slider');
            preview(next);
          }}
          onPointerUp={commit}
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' || event.key === 'PageUp' || event.key === 'PageDown') commit();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 pl-[76px]">
        <Stepper label={`${ratioName} ratio`} value={text} min={min} max={3} step={0.05}
          onChange={(next) => {
            setText(next);
            const ratio = Number.parseFloat(next);
            if (Number.isFinite(ratio) && ratio >= min && ratio <= 3) {
              setRatio(ratio, 'ratio');
              preview(Math.round(ratio * 100) / 100);
            }
          }} onEnter={commit} width="w-11" />
        <span className="text-[10.5px] text-slate-400">{ratioName}</span>
        <Stepper label="Throat radius" value={throatText} min={0} max={Math.round(3 * inPlane - inPlane / 2)} step={25} fineStep={5}
          onChange={(next) => {
            setThroatText(next);
            const throat = Number.parseFloat(next);
            if (Number.isFinite(throat) && inPlane > 0) {
              const ratio = (throat + inPlane / 2) / inPlane;
              if (ratio >= min && ratio <= 3) {
                setRatio(ratio, 'throat');
                preview(Math.round(ratio * 100) / 100);
              }
            }
          }} onEnter={commit} width="w-11" />
        <span className="text-[10.5px] text-slate-400">mm</span>
      </div>
      {evaluation ? <ResultRow evaluation={evaluation} result={host.result} onApply={commit} />
        : <div className="mt-0.5 pl-[76px] text-[10.5px] text-slate-400">{round ? 'R/D 1.5 is SMACNA Table 3-1' : 'R/W 1.5 is SMACNA RE1; under 1.0 only up to 5 m/s'}</div>}
    </div>
  );
}

/** The Edit tab: the segment's own values, by kind. */
function EditPanel({ host, plan, segment, context, options }: {
  host: FieldHost;
  plan: DuctFabricationPlan;
  segment: DuctSegment;
  context: DuctSegmentOptionContext;
  options: readonly DuctSegmentOption[];
}): ReactNode {
  const { scene, settings, focus, evaluations } = host;
  const spec = plan.spec;
  const editable = !spec.locked && !spec.legacy;
  if (!editable) return null;
  const runId = focus.runId;
  const blocks: ReactNode[] = [];
  const chips = (prefix: string) => options.filter((option) => option.id.startsWith(prefix));
  const chipRow = (prefix: string) => <ChipRow options={chips(prefix)} evaluations={evaluations} onHover={host.onHover} onApply={host.onApply} />;
  const kind = segment.kind;
  if (kind === 'straight' || kind === 'riser') {
    const geometry = ductLegs(spec)[segment.legIndex];
    const section = spec.legs[segment.legIndex] ?? { widthMm: 0, heightMm: 0 };
    const legIndex = segment.legIndex;
    blocks.push(
      <EditBlock key="dimensions" title="Dimensions">
        {geometry && !geometry.sloped ? (
          <ValueField key={`length|${Math.round(geometry.lengthMm)}`} host={host} label={kind === 'riser' ? 'Height' : 'Length'} unit="mm"
            current={Math.round(geometry.lengthMm)} min={MIN_STRAIGHT_MM} max={60000} step={100} fineStep={10} testId="duct-segment-leg-length" scrub
            hint={kind === 'riser' ? 'its rise; what follows moves with it, the ends stay' : 'centreline, corner to corner; it grows at its far end, the ends stay'}
            makeOption={(value) => ({
              id: `leg-length:${legIndex}:${value}`, group: 'tune', glyph: isRoundLeg(section) ? 'round' : 'rect',
              title: `${value.toLocaleString('en-GB')} mm`, detail: kind === 'riser' ? 'the riser at this height' : 'the straight at this length',
              edit: { kind: 'leg-length', runId, legIndex, lengthMm: value },
            })} />
        ) : null}
        <SizeEditor key={`size|${sectionLabel(section)}`} host={host} segment={segment} spec={spec} voidHeightMm={context.voidHeightMm} />
      </EditBlock>,
    );
  }
  if (kind === 'elbow') blocks.push(<RadiusEditor key="radius" host={host} plan={plan} segment={segment} />);
  if (kind === 'transition') {
    const node = segment.legIndex;
    const override = spec.nodeOverrides[String(node)] ?? {};
    const project = settings.transitionTaperDeg;
    const now = override.taperDeg ?? project;
    blocks.push(
      <EditBlock key="taper" title="Taper">
        <div className="px-1">{chipRow('taper:')}</div>
        <ValueField host={host} label="Custom" unit="° a side" current={now} min={5} max={45} step={1} testId="duct-segment-taper"
          hint="gentler is longer and loses less (SMACNA Fig. 2-7)"
          makeOption={(value) => ({
            id: `taper-custom:${value}`, group: 'tune', glyph: 'taper', title: `${value}° a side`, detail: 'a taper of your own',
            edit: { kind: 'node', runId, node, override: { ...override, taperDeg: value === project ? undefined : value } },
          })} />
      </EditBlock>,
    );
    // Its place along its straight (its slide grip drags it too), and its length (what its taper makes it).
    const stretch = transitionStretch(scene, spec, node);
    const piece = plan.pieces.find((candidate) => candidate.kind === 'transition' && candidate.legIndex === node);
    if (stretch) {
      blocks.push(
        <ValueField key="place" host={host} label="Position" unit="mm" current={Math.round(stretch.atMm)} min={stretch.boundedBelow ? MIN_STRAIGHT_MM : 0}
          max={Math.max(0, Math.round(stretch.spanMm - MIN_STRAIGHT_MM))} step={50} fineStep={10} testId="duct-segment-transition-place" scrub
          hint={`where it starts along its straight (0–${Math.round(stretch.spanMm)} mm)${piece ? ` · ${Math.round(piece.lengthMm)} mm long` : ''}`}
          makeOption={(value) => ({
            id: `transition-move:${node}:${value}`, group: 'tune', glyph: 'taper', title: `${value} mm along the straight`, detail: 'the transition moved; the take-offs and accessories stay',
            edit: { kind: 'transition-move', runId, node, alongMm: value },
          })} />,
      );
    }
  }
  if (kind === 'takeoff' && spec.start.kind === 'tap') {
    const start = spec.start;
    const parent = scene.find((element) => element.id === start.parentRunId);
    const parentSpec = parent ? getDuctRunPlan(parent, scene, settings)?.spec : null;
    const leg = parentSpec ? ductLegs(parentSpec)[start.legIndex] : undefined;
    if (leg) {
      blocks.push(
        <ValueField key="station" host={host} label="Position" unit="mm" current={start.stationMm} min={0} max={Math.round(leg.lengthMm)} step={50} fineStep={10}
          testId="duct-segment-station" hint={`along leg ${start.legIndex + 1} of the main (0–${Math.round(leg.lengthMm)} mm)`} scrub
          makeOption={(value) => ({
            id: `tap-station:${value}`, group: 'tune', glyph: 'tap-tee', title: `${value} mm along the main`, detail: 'the take-off moved; its branch keeps its end',
            edit: { kind: 'tap-station', runId, stationMm: value },
          })} />,
      );
    }
  }
  if (segment.key.startsWith('inline:')) {
    const id = segment.key.slice('inline:'.length);
    const item = spec.inline?.find((candidate) => candidate.id === id);
    const leg = item ? ductLegs(spec)[item.legIndex] : undefined;
    if (item && leg) {
      blocks.push(
        <ValueField key="position" host={host} label="Position" unit="mm" current={item.stationMm} min={0} max={Math.round(leg.lengthMm)} step={50} fineStep={10}
          testId="duct-segment-position" hint={`its centre along leg ${item.legIndex + 1} (0–${Math.round(leg.lengthMm)} mm)`} scrub
          makeOption={(value) => ({
            id: `inline-move:${id}:${value}`, group: 'tune', glyph: item.kind === 'damper' ? 'damper' : item.kind, title: `${value} mm along the leg`, detail: 'moved along its leg',
            edit: { kind: 'inline-move', runId, id, stationMm: value },
          })} />,
      );
      if (item.kind === 'attenuator') {
        blocks.push(
          <EditBlock key="length" title="Length">
            <div className="px-1">{chipRow('attenuator:')}</div>
            <ValueField host={host} label="Custom" unit="mm" current={item.lengthMm ?? 900} min={300} max={3000} step={50} fineStep={10} testId="duct-segment-length"
              hint="longer: more attenuation and loss"
              makeOption={(value) => ({
                id: `inline-length:${id}:${value}`, group: 'tune', glyph: 'attenuator', title: `${value} mm`, detail: 'an attenuator of your own length',
                edit: { kind: 'inline-length', runId, id, lengthMm: value },
              })} />
          </EditBlock>,
        );
      }
      if (item.kind === 'access-door') {
        const door = plan.pieces.find((piece) => piece.inlineId === id)?.accessDoor?.sizeMm ?? item.doorMm ?? 300;
        blocks.push(
          <ValueField key="door" host={host} label="Door" unit="mm □" current={door} min={100} max={600} step={50} fineStep={10} testId="duct-segment-door"
            makeOption={(value) => ({
              id: `inline-door:${id}:${value}`, group: 'tune', glyph: 'access-door', title: `${value}×${value} door`, detail: 'a door of your own size',
              edit: { kind: 'inline-door', runId, id, doorMm: value },
            })} />,
        );
      }
    }
  }
  if (kind === 'flex') {
    const flex = plan.pieces[segment.pieceIndices[0]!];
    if (flex && spec.path.length >= 3) {
      blocks.push(
        <ValueField key="flex" host={host} label="Length" unit="mm" current={Math.round(flex.lengthMm)} min={300} max={3000} step={50} fineStep={10}
          testId="duct-segment-flex" hint={`SMACNA S3.23: as short as practical (≤ ${Math.round(settings.flexMaxLengthMm)} mm here)`}
          makeOption={(value) => ({
            id: `runout-length:${value}`, group: 'tune', glyph: 'flex', title: `${value} mm runout`, detail: 'the rigid duct runs on or stops short',
            edit: { kind: 'runout-length', runId, flexMm: value },
          })} />,
      );
    }
  }
  // The terminal at the run's end: its neck (quick picks) and its design airflow.
  const end = spec.end;
  const onTerminalEnd = end.kind === 'terminal' && (kind === 'flex' || (!end.flex && segment.legIndex === spec.legs.length - 1 && (kind === 'straight' || kind === 'riser')));
  if (onTerminalEnd && end.kind === 'terminal') {
    const terminal = scene.find((element) => element.id === end.terminalId);
    const terminalSpec = terminal ? readDuctTerminalSpec(terminal) : null;
    if (terminal && terminalSpec) {
      const share = context.figures?.flow?.airflowM3h.min ?? 0;
      const designed = terminalSpec.designAirflowM3h ?? null;
      const terminalId = terminal.id;
      blocks.push(
        <EditBlock key="terminal" title={`Terminal ${terminal.label || ''}`.trim()}>
          <div className="flex items-center gap-2 px-1">
            <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500">Neck</span>
            {chipRow('neck:')}
          </div>
          <div className="flex items-center gap-2 px-1" title="Where the runout meets the terminal's plenum box">
            <span className="w-[68px] shrink-0 text-[11px] font-medium text-slate-500">Collar</span>
            {chipRow('collar:')}
          </div>
          <ValueField host={host} label="Airflow" unit="m³/h" current={Math.round(designed ?? share)} min={10} max={10000} step={10} fineStep={5} testId="duct-segment-airflow"
            hint={designed ? 'its design airflow' : 'an equal share of the system airflow'}
            extra={designed ? (
              <button type="button" className="rounded-md px-1.5 text-[10.5px] text-slate-500 hover:bg-slate-100 hover:text-slate-800" title="Back to an equal share of the system airflow"
                onClick={() => host.onApply({ id: 'airflow:share', group: 'tune', glyph: 'terminal', title: 'Shared airflow', detail: 'an equal share', edit: { kind: 'terminal', terminalId, airflowM3h: null } })}>
                Share
              </button>
            ) : null}
            makeOption={(value) => ({
              id: `airflow:${value}`, group: 'tune', glyph: 'terminal', title: `${value} m³/h`, detail: 'its design airflow',
              edit: { kind: 'terminal', terminalId, airflowM3h: value },
            })} />
        </EditBlock>,
      );
    }
  }
  if (blocks.length === 0) return null;
  return <div className="space-y-2">{blocks}</div>;
}

/** The picture in a card's header: the segment's kind. */
function segmentGlyph(segment: DuctSegment): Parameters<typeof DuctSegmentGlyph>[0]['glyph'] {
  switch (segment.kind) {
    case 'elbow': return segment.round ? 'elbow-gored' : 'elbow-radius';
    case 'transition': return 'taper';
    case 'takeoff': return 'tap-spin';
    case 'damper': return 'damper';
    case 'connector': return 'connector';
    case 'fire-damper': return 'fire-damper';
    case 'end-cap': return 'cap';
    case 'flex': return 'flex';
    case 'split': return 'split-y';
    case 'access-door': return 'access-door';
    case 'attenuator': return 'attenuator';
    case 'plenum': return 'rect';
    default: return segment.round ? 'round' : 'rect';
  }
}

// ---------------------------------------------------------------------------------------------------- the provider

/** Where the card goes after an edit when its segment's key is gone: the leg it was on. */
interface DuctRekeyToken {
  legIndex: number;
}

function buildDuctCardModel(scene: HvacElement[], settings: DuctDesignSettings, focus: SegmentFocus): DuctCardModel | null {
  const element = scene.find((candidate) => candidate.id === focus.runId);
  const plan = element ? getDuctRunPlan(element, scene, settings) : null;
  const segment = plan ? ductSegmentOf(plan, focus.key) : null;
  const context = segment ? segmentOptionContext(scene, settings, focus.runId, focus.key) : null;
  if (!plan || !segment || !context) return null;
  const figures = ductSegmentFigures(scene, settings, focus.runId, focus.key);
  const issues = segmentIssues(plan, focus.key).flatMap((issue) => (issue.severity === 'info' ? [] : [{ severity: issue.severity, code: issue.code, message: issue.message }]));
  const options = ductSegmentOptions(scene, settings, focus.runId, focus.key);
  const token: DuctRekeyToken = { legIndex: segment.legIndex };
  return {
    head: {
      title: segment.title,
      size: segment.size,
      detail: segment.detail,
      tag: markRange(segment),
      glyph: <DuctSegmentGlyph glyph={segmentGlyph(segment)} className="h-3.5 w-3.5" />,
      tone: plan.spec.service === 'return' ? 'bg-teal-50 text-teal-600' : 'bg-blue-50 text-blue-600',
      kind: segment.kind,
    },
    figures: <FigureStrip figures={figures} />,
    info: <BuildInfo figures={figures} />,
    issues,
    options,
    evaluate: (option) => evaluateDuctSegmentOption(scene, settings, focus.runId, focus.key, option),
    tabOf: (option) => (option.group === 'size' || option.group === 'swap' || option.id.startsWith('face:') ? 'swap' : option.group === 'accessory' ? 'add' : null),
    edit: (host) => EditPanel({ host: { ...host, scene, settings, focus }, plan, segment, context, options }),
    neighbour: (direction) => {
      const next = neighbourSegment(plan, focus.key, direction);
      return next ? { key: next.key, anchorMark: next.marks[0] ?? null } : null;
    },
    rekeyToken: token,
  };
}

/** A segment's card read once per drawing, settings and building (the card reads it on every render). */
const MODEL_CACHE = new WeakMap<readonly HvacElement[], Map<string, { settings: DuctDesignSettings; building: unknown; model: DuctCardModel | null }>>();

function ductCardModel(scene: HvacElement[], settings: DuctDesignSettings, focus: SegmentFocus): DuctCardModel | null {
  let byPiece = MODEL_CACHE.get(scene);
  if (!byPiece) {
    byPiece = new Map();
    MODEL_CACHE.set(scene, byPiece);
  }
  const id = `${focus.runId}|${focus.key}`;
  const building = getActiveDuctBuilding();
  const hit = byPiece.get(id);
  if (hit && hit.settings === settings && hit.building === building) return hit.model;
  const model = buildDuctCardModel(scene, settings, focus);
  byPiece.set(id, { settings, building, model });
  return model;
}

/** The duct runs' segment cards, read with the document's duct settings. */
export function createDuctSegmentProvider(settings: DuctDesignSettings): DuctSegmentProvider {
  return {
    domain: 'duct',
    testIdPrefix: 'duct-segment',
    model: (scene, focus) => ductCardModel(scene, settings, focus),
    rank: rankDuctOptions,
    badges: BADGES,
    recommendedBadge: 'recommended',
    optionGlyph: (option) => <DuctSegmentGlyph glyph={option.glyph} className="h-3.5 w-3.5" />,
    chips: (evaluation) => <DeltaChips evaluation={evaluation} />,
    result: resultLine,
    // A peek's quick swaps after the recommended one: by life-cycle cost.
    quickScore: (evaluation) => evaluation.deltaLifeCycleCost ?? 0,
    commit: (evaluation, option) => {
      commitDuctSegmentEdit(evaluation.updates, evaluation.action || option.title);
      // A transition moved off (or back onto) an elbow is numbered anew: the card follows it.
      const refocus = evaluation.refocus;
      const pinned = useSegmentUiStore.getState().pinned;
      if (refocus && pinned && pinned.runId === refocus.runId && pinned.key !== refocus.key) {
        useSegmentUiStore.getState().pin({ ...pinned, key: refocus.key, anchorMark: null });
      }
    },
    rekey: (scene, focus, token) => {
      const element = scene.find((candidate) => candidate.id === focus.runId);
      const plan = element ? getDuctRunPlan(element, scene, settings) : null;
      if (!plan || ductSegmentOf(plan, focus.key)) return focus;
      const fallback = ductSegmentOf(plan, `leg:${(token as DuctRekeyToken | null)?.legIndex ?? 0}`);
      return fallback ? { ...focus, key: fallback.key, anchorMark: fallback.marks[0] ?? null } : null;
    },
  };
}
