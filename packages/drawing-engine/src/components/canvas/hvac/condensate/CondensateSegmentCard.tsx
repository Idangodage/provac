'use client';

/**
 * The condensate drains' segment cards, as the condensate SegmentProvider: a
 * run's unit connection (hose or stub, with its trap), its pump riser, its
 * legs and bends, how it ends, its rodding eyes, air vents and wall sleeves,
 * and a drop's termination (condensatePieces) — each with its figures
 * (condensatePieceFigures): the pipe and what it carries, the fall against the
 * minimum, the capacity at that fall, the invert levels, the head margin above
 * the minimum-fall profile, a riser's lift against its pump head, the
 * crossings and the supports — and the design checks about it, kept to the
 * piece where each happens.
 *
 * Its options (condensateSegmentOptions) are edits of the drain's network,
 * solved again along its routes as the drain handles are: Swap — a run's size,
 * a termination's kind and trap; Edit — the network's fall, a level the run
 * keeps under, a leg moved sideways, a riser's height, a wye slid along its
 * main, a termination's level; Add — a bend, a rodding eye, an air vent, or one
 * taken out. Each shows on the drawing before it is applied, with the engine's
 * verdict, the change in head margin and the checks it would newly fail.
 */
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import type { VrfValidationReport } from '../../../../vrf/rules/validation-engine';
import {
  ChipRow,
  EditBlock,
  STATUS_DOT,
  STATUS_TEXT,
  ValueField as SegmentValueField,
  formatNumber as number,
  formatSigned as signed,
  type FigureStatus,
} from '../segments/SegmentCardKit';
import type { SegmentPieceRow } from '../segments/SegmentPieceList';
import type { SegmentCardModel, SegmentFieldHost, SegmentIssueLine, SegmentProvider } from '../segments/segmentProvider';
import type { SegmentFocus } from '../segments/segmentUiStore';
import {
  formatQuantity, fromDisplay, inchFractionText, slopeFigureText, slopeText, toDisplay, toDisplayText, unitLabel, type HvacUnitSystem,
} from '../units/hvacUnits';

import type { CondensateEditContext } from './condensateEditing';
import { condensateNetworkBaseline, condensatePieceFigures, condensateSessionFor, type CondensatePieceFigures } from './condensatePieceFigures';
import { condensatePieceOf, condensateRunOf, neighbourCondensatePiece, type CondensatePiece, type CondensatePieceKind, type CondensateRun } from './condensatePieces';
import type { PlanRoute } from './condensateRouteOps';
import {
  condensateOffsetOption,
  condensatePieceOptions,
  condensateValueOption,
  evaluateCondensateOption,
  type CondensateOptionEvaluation,
  type CondensateOptionGlyph,
  type CondensateSegmentOption,
} from './condensateSegmentOptions';
import { formatFallRatio } from './condensateSettings';
import { getCondensateOwnership, readCondensateGullySpec, type CondensateSegmentRole, type CondensateTerminalTrap, type CondensateTerminationKind } from './condensateTypes';

export type { CondensateOptionEvaluation, CondensateSegmentOption } from './condensateSegmentOptions';
export type CondensateSegmentProvider = SegmentProvider<CondensateSegmentOption, CondensateOptionEvaluation>;
type CondensateCardModel = SegmentCardModel<CondensateSegmentOption, CondensateOptionEvaluation>;

export interface CondensateCardContext extends CondensateEditContext {
  report: VrfValidationReport;
  /** The document's unit system: in IP a pipe's outside and bore and its insulation in inches, falls in in/ft, flows in gph, messages with IP figures. */
  unitSystem?: HvacUnitSystem;
}

const ROLE_WORD: Record<CondensateSegmentRole, string> = { 'unit-branch': 'Branch', main: 'Main', lift: 'Lift', drop: 'Drop', terminal: 'Outlet' };
const KIND_TAG: Record<CondensatePieceKind, string> = { connection: 'H', riser: 'R', leg: 'L', bend: 'B', end: 'J', termination: 'T', eye: 'E', vent: 'V', sleeve: 'S' };
const TRAP_WORD: Record<CondensateTerminalTrap, string> = { tundish: 'tundish', hepvo: 'waterless valve', 'p-trap': 'P-trap', none: 'open discharge' };
const TERMINATION_WORD: Record<CondensateTerminationKind, string> = { 'floor-gully': 'Floor gully', 'stack-connection': 'Stack connection', 'external-discharge': 'Wall outlet' };
const TONE = 'bg-cyan-50 text-cyan-700';

const metres = (mm: number, digits = 2) => `${number(mm / 1000, digits)} m`;
const NUMBERED = new Set<CondensatePieceKind>(['leg', 'bend', 'eye', 'vent', 'sleeve']);
/** A piece's short tag, on the card's header, its chip and the inspector's list ("CD-L2", "CD-R"). */
const pieceTag = (piece: CondensatePiece) => `CD-${KIND_TAG[piece.kind]}${NUMBERED.has(piece.kind) ? piece.ordinal : ''}`;
const KIND_WORD: Record<CondensatePieceKind, string> = {
  connection: 'Unit connection', riser: 'Riser', leg: 'Leg', bend: 'Elbow', end: 'Joint', termination: 'Termination',
  eye: 'Rodding eye', vent: 'Air vent', sleeve: 'Wall sleeve',
};
const percent = (value: number) => `${number(value, value < 10 ? 1 : 0)} %`;

// The engineering figures in the document's unit system (lengths, levels, lifts and margins stay in mm and m).
const fallText = (value: number, system: HvacUnitSystem) => (system === 'ip' ? slopeText(value) : percent(value));
/** A pipe's outside and bore: "Ø32.0 outside, 28.4 mm bore" / "Ø1.26 in outside, 1.12 in bore". */
const pipeText = (outerMm: number, innerMm: number, system: HvacUnitSystem) => (system === 'ip'
  ? `Ø${(outerMm / 25.4).toFixed(2)} in outside, ${(innerMm / 25.4).toFixed(2)} in bore`
  : `Ø${number(outerMm, 1)} outside, ${number(innerMm, 1)} mm bore`);
const insulationText = (mm: number, system: HvacUnitSystem) => (system === 'ip' ? `${inchFractionText(mm)} in` : `${number(mm)} mm`);
/** A flow's figure: L/h (to `siDigits`), or gph to the hundredth under 10, the tenth under 100, whole above. */
const flowNumber = (litresPerHour: number, system: HvacUnitSystem, siDigits: number) => {
  if (system === 'si') return number(litresPerHour, siDigits);
  const gph = toDisplay('flow', litresPerHour, 'ip');
  return number(gph, gph < 10 ? 2 : gph < 100 ? 1 : 0);
};

/** A piece's picture. */
export function DrainSegmentGlyph({ kind, className }: { kind: CondensatePieceKind; className?: string }) {
  const paths: Record<CondensatePieceKind, ReactNode> = {
    connection: <path d="M2 6c1.5-2 3 2 4.5 0s3 2 4.5 0 2 1 3 0M2 10c1.5-2 3 2 4.5 0s3 2 4.5 0 2 1 3 0" />,
    riser: <><path d="M5.5 14V3M10.5 14V3" /><path d="M8 1.5v4M6.5 3L8 1.5 9.5 3" opacity={0.6} /></>,
    leg: <><path d="M2 5l12 2.5M2 9.5l12 2.5" /><path d="M11 3.5l2 .5" opacity={0.55} /></>,
    bend: <><path d="M2 4.5h3.5a7 7 0 0 1 7 7V14" /><path d="M2 9.5h3.5a2 2 0 0 1 2 2V14" /></>,
    end: <><path d="M1.5 11.5h13" /><path d="M4 4l4.5 7.5" /></>,
    termination: <><path d="M8 1.5v8" /><path d="M5 9.5h6l-1 3.5H6z" /><path d="M3.5 14.5h9" opacity={0.6} /></>,
    eye: <><circle cx="8" cy="8" r="5" /><path d="M8 5.5v5M5.5 8h5" /></>,
    vent: <><path d="M8 14V4" /><path d="M5 6.5L8 3.5l3 3" /><path d="M5 14h6" opacity={0.6} /></>,
    sleeve: <><rect x="5.5" y="2" width="5" height="12" rx="1" /><path d="M1.5 8h13" /></>,
  };
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

function stat(value: string, unit: string, title: string, status?: FigureStatus | null, testId?: string) {
  return (
    <span className="inline-flex items-baseline gap-1" title={title} data-testid={testId}>
      {status ? <span className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" /> : null}
      <span className="text-[13px] font-semibold tabular-nums text-slate-900">{value}</span>
      {unit ? <span className="text-[10.5px] text-slate-400">{unit}</span> : null}
    </span>
  );
}

const MARGIN_TEXT: Record<FigureStatus, string> = { ok: '100 mm or more to spare', near: 'under 100 mm to spare', over: 'under 40 mm to spare' };

/** The piece in one strip: what matters for its kind first. */
function FigureStrip({ figures, piece, system }: { figures: CondensatePieceFigures; piece: CondensatePiece; system: HvacUnitSystem }) {
  const stats: ReactNode[] = [];
  const size = stat(`CD ${figures.nominalSize}`, '', `${figures.system.label} ${figures.nominalSize}: ${pipeText(figures.outerDiameterMm, figures.innerDiameterMm, system)}`);
  const margin = figures.headMarginMm !== null && figures.headStatus
    ? stat(number(figures.headMarginMm), 'mm', `Head margin: ${number(figures.headMarginMm)} mm above the lowest profile that still meets the minimum fall — ${MARGIN_TEXT[figures.headStatus]}`, figures.headStatus, 'condensate-segment-margin')
    : null;
  if (figures.fall) {
    const fall = figures.fall;
    const title = `Falls ${fallText(fall.slopePercent, system)} (${fall.ratio}) — minimum ${fallText(fall.minimumPercent, system)}, preferred ${fallText(fall.preferredPercent, system)}: ${STATUS_TEXT[fall.status]}`;
    stats.push(<span key="s">{size}</span>);
    stats.push(<span key="l">{stat(number(figures.planLengthMm / 1000, 2), 'm', `${metres(figures.planLengthMm, 3)} in plan, ${metres(figures.lengthMm, 3)} along it`)}</span>);
    // The ratio reads alike in both systems; in IP the fall is named in inches per foot first.
    stats.push(<span key="f">{system === 'ip'
      ? stat(slopeFigureText(fall.slopePercent), `in/ft · ${fall.ratio}`, title, fall.status, 'condensate-segment-fall')
      : stat(fall.ratio, percent(fall.slopePercent), title, fall.status, 'condensate-segment-fall')}</span>);
    if (margin) stats.push(<span key="m" className="ml-auto">{margin}</span>);
  } else if (figures.lift) {
    const lift = figures.lift;
    stats.push(<span key="lift">{stat(`↑ ${number(lift.liftMm)}`, `of ${number(lift.pumpHeadMm)} mm`, `Lifts ${number(lift.liftMm)} mm; ${lift.unitLabel}'s pump raises ${number(lift.pumpHeadMm)} mm — ${STATUS_TEXT[lift.status]}`, lift.status, 'condensate-segment-lift')}</span>);
    stats.push(<span key="s">{size}</span>);
    if (margin) stats.push(<span key="m" className="ml-auto">{margin}</span>);
  } else if (figures.connection) {
    const connection = figures.connection;
    stats.push(<span key="h">{stat(number(piece.lengthMm / 1000, 2), 'm', connection.pumped ? `${metres(connection.hoseMm, 2)} of flexible hose from ${connection.unitLabel}'s pump outlet` : `Outlet stub from ${connection.unitLabel}`)}</span>);
    stats.push(<span key="p">{stat(connection.pumped ? 'Pumped' : 'Gravity', '', connection.pumped ? 'The unit pumps its condensate up the riser' : 'The unit drains by gravity')}</span>);
    if (connection.trapDepthMm !== null) stats.push(<span key="t">{stat(`Trap ${number(connection.trapDepthMm)}`, 'mm', 'A P-trap at the outlet: the fan holds the drain pan below atmospheric pressure')}</span>);
  } else if (figures.bend) {
    stats.push(<span key="a">{stat(`${number(figures.bend.angleDeg)}°`, '', `Turns ${number(figures.bend.angleDeg, 1)}° in plan`)}</span>);
    stats.push(<span key="s">{size}</span>);
    if (margin) stats.push(<span key="m" className="ml-auto">{margin}</span>);
  } else if (figures.end) {
    const end = figures.end;
    stats.push(<span key="k">{stat(end.kind === 'wye' ? 'Wye' : end.kind === 'drop' ? 'Drop' : 'Joint', '', end.kind === 'wye' ? `Joins ${end.into} from the top (45°), so water cannot back up into it` : end.kind === 'drop' ? `Turns down into the drop to ${end.into}` : `Continues as ${end.into}`)}</span>);
    stats.push(<span key="s">{size}</span>);
    if (margin) stats.push(<span key="m" className="ml-auto">{margin}</span>);
  } else if (figures.termination) {
    const termination = figures.termination;
    stats.push(<span key="d">{stat(`↓ ${number(termination.dropMm / 1000, 2)}`, 'm', `Drops ${metres(termination.dropMm, 2)} to ${termination.gullyLabel}`)}</span>);
    stats.push(<span key="t">{stat(TRAP_WORD[termination.trap], '', `Discharges through a ${TRAP_WORD[termination.trap]}`)}</span>);
    if (termination.kind === 'floor-gully') stats.push(<span key="a">{stat(number(termination.airBreakMm), 'mm air', `An air break of ${number(termination.airBreakMm)} mm above the receptor (indirect discharge)`)}</span>);
    stats.push(<span key="s">{size}</span>);
  } else if (figures.fitting) {
    stats.push(<span key="f">{stat(figures.fitting.label, '', figures.fitting.note ?? figures.fitting.label)}</span>);
    stats.push(<span key="s">{size}</span>);
  }
  if (figures.capacity && figures.capacity.status !== 'ok') {
    stats.push(<span key="q">{stat(flowNumber(figures.capacity.designLitresPerHour, system, 1),
      `of ${flowNumber(figures.capacity.capacityLitresPerHour, system, 0)} ${unitLabel('flow', system)}`, 'Design flow against what it carries at its fall', figures.capacity.status)}</span>);
  }
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2" data-testid="condensate-segment-figures">{stats}</div>;
}

/** How the piece is built and what it carries (behind ⓘ). */
function BuildInfo({ figures, piece, system }: { figures: CondensatePieceFigures; piece: CondensatePiece; system: HvacUnitSystem }) {
  const fittings = Object.entries(piece.fittings.reduce<Record<string, number>>((counts, fitting) => {
    counts[fitting.kind] = (counts[fitting.kind] ?? 0) + 1;
    return counts;
  }, {})).map(([kind, count]) => `${count}× ${kind.replace('-', ' ')}`);
  const flowUnit = unitLabel('flow', system);
  return (
    <>
      <div>
        {figures.system.label} {figures.nominalSize} · {pipeText(figures.outerDiameterMm, figures.innerDiameterMm, system)}
        {figures.insulationMm > 0 ? ` · ${insulationText(figures.insulationMm, system)} closed-cell insulation` : ' · uninsulated'}
        {figures.system.verified ? '' : ' (catalogue walls unverified)'}
      </div>
      <div>
        {ROLE_WORD[figures.role]} · carries {figures.unitsServed} unit{figures.unitsServed === 1 ? '' : 's'}, {formatQuantity('capacity', figures.capacityKw, system)}
        {figures.capacity ? ` · design flow ${flowNumber(figures.capacity.designLitresPerHour, system, 1)} ${flowUnit}, ${flowNumber(figures.capacity.capacityLitresPerHour, system, 0)} ${flowUnit} at its fall ${number(figures.capacity.fillRatio * 100)} % full (Manning)` : ''}
      </div>
      {figures.fall ? (
        <div>
          Falls {fallText(figures.fall.slopePercent, system)} ({formatFallRatio(Math.max(0, figures.fall.slopePercent))}) over {metres(figures.planLengthMm, 2)}
          {figures.fall.offsets.count ? ` · ${figures.fall.offsets.count === 1 ? 'a 45° offset drops' : `${figures.fall.offsets.count} 45° offsets drop`} it ${number(figures.fall.offsets.dropMm)} mm` : ''}
          {` · minimum ${fallText(figures.fall.minimumPercent, system)}, preferred ${fallText(figures.fall.preferredPercent, system)}`}
        </div>
      ) : null}
      {figures.invert ? <div>Invert level {number(figures.invert.fromMm)} → {number(figures.invert.toMm)} mm (pipe bottom inside, above the floor)</div> : null}
      {figures.headMarginMm !== null ? <div>Head margin {number(figures.headMarginMm)} mm: how far it could drop and still meet the minimum fall to its termination</div> : null}
      {figures.lift ? <div>{figures.lift.unitLabel}&apos;s pump lifts {number(figures.lift.liftMm)} of {number(figures.lift.pumpHeadMm)} mm (from the unit&apos;s data, else the project default)</div> : null}
      {figures.termination ? (
        <div>
          {TERMINATION_WORD[figures.termination.kind]} {figures.termination.gullyLabel} · inlet at {number(figures.termination.inletLevelMm)} mm · {TRAP_WORD[figures.termination.trap]}
          {figures.termination.kind === 'floor-gully' ? ` · ${number(figures.termination.airBreakMm)} mm air break` : ''}
        </div>
      ) : null}
      {figures.crossings.length ? (
        <div>
          Crosses refrigerant {figures.crossings.map((crossing) => (crossing.relation === 'hop' ? 'under a hop' : crossing.relation === 'unresolved' ? 'without clearance' : `${crossing.relation === 'below' ? 'below' : 'above'} (${number(Math.max(0, crossing.gapMm))} mm)`)).join(', ')}
        </div>
      ) : null}
      {figures.supports ? <div>{figures.supports} hanger{figures.supports === 1 ? '' : 's'} on it</div> : null}
      {fittings.length ? <div>Fittings: {fittings.join(', ')}</div> : null}
    </>
  );
}

/** The checks about the run, each kept to the piece it is about. */
export function condensatePieceIssues(report: VrfValidationReport, element: HvacElement, run: CondensateRun, piece: CondensatePiece,
  figures: CondensatePieceFigures): SegmentIssueLine[] {
  const unitId = run.spec.drainStart?.kind === 'unit-drain' ? run.spec.drainStart.unitId : undefined;
  const ids = new Set([element.id, ...(unitId ? [unitId] : [])]);
  const legs = run.pieces.filter((candidate) => candidate.kind === 'leg');
  const lowest = legs.reduce<CondensatePiece | null>((low, leg) => (!low || Math.min(leg.from.z, leg.to.z) < Math.min(low.from.z, low.to.z) ? leg : low), null);
  const highest = run.pieces.reduce<CondensatePiece | null>((high, candidate) => (!high || Math.max(candidate.from.z, candidate.to.z) > Math.max(high.from.z, high.to.z) ? candidate : high), null);
  return report.issues.flatMap((issue) => {
    if (!issue.entityId || !ids.has(issue.entityId) || (issue.level !== 'error' && issue.level !== 'warning')) return [];
    let here: boolean;
    switch (issue.code) {
      case 'CD_FALL_MIN':
      case 'CD_ADVERSE_FALL':
        // The leg that falls too little (or not at all); any leg when none is found by itself.
        here = piece.kind === 'leg' && (figures.fall?.status === 'over' || !legs.length);
        break;
      case 'CD_ENVELOPE':
        here = /below the ceiling/.test(issue.message) ? piece === lowest : piece === highest;
        break;
      case 'CD_PUMP_LIFT':
        here = piece.kind === 'riser';
        break;
      case 'CD_TRAP':
        here = piece.kind === 'connection';
        break;
      case 'CD_JOIN_FROM_TOP':
      case 'CD_OPEN_END':
        here = piece.kind === 'end';
        break;
      case 'CD_AIR_BREAK':
        here = piece.kind === 'termination';
        break;
      case 'CD_AIR_VENT':
        here = piece.kind === 'vent' || piece.kind === 'eye' || (piece.kind === 'leg' && piece.ordinal === 1);
        break;
      case 'CD_CLASH':
        here = piece.kind === 'leg' && (figures.crossings.some((crossing) => crossing.relation === 'unresolved') || !run.pieces.some((candidate) => candidate.kind === 'leg'));
        break;
      default:
        // About the run as a whole (its size, a stale network): every stretch of it.
        here = piece.kind === 'leg' || piece.kind === 'termination';
    }
    return here ? [{ severity: issue.level, code: issue.code, message: issue.message }] : [];
  });
}

interface RekeyToken {
  kind: CondensatePieceKind;
  ordinal: number;
}

// ---------------------------------------------------------------------------------------------------- options on the card

const SWAP_GROUPS = new Set<CondensateSegmentOption['group']>(['size', 'termination', 'trap']);
const ADD_GROUPS = new Set<CondensateSegmentOption['group']>(['add-bend', 'remove-bend', 'eye', 'vent']);

/** An option's picture. */
function OptionGlyph({ glyph, className }: { glyph: CondensateOptionGlyph; className?: string }) {
  const paths: Record<CondensateOptionGlyph, ReactNode> = {
    size: <circle cx="8" cy="8" r="4.5" />,
    'size-up': <><circle cx="6.5" cy="9.5" r="3.5" /><path d="M13 9V3M11 5l2-2 2 2" /></>,
    fall: <><path d="M2 4l10 5" /><path d="M9 11.5l3-2.5-1-3.5" /></>,
    level: <><path d="M2 12h12" /><path d="M8 2.5v6.5M5.5 6.5L8 9l2.5-2.5" /></>,
    lift: <><path d="M8 14V3" /><path d="M5 6l3-3 3 3" /><path d="M5 14h6" opacity={0.6} /></>,
    offset: <><path d="M2 8h12" /><path d="M5 5L2 8l3 3M11 5l3 3-3 3" /></>,
    wye: <><path d="M1.5 11.5h13" /><path d="M5 4l3.5 7.5" /><path d="M9.5 3.5h4" opacity={0.6} /></>,
    'add-bend': <><path d="M2 12h6V5" /><path d="M11.5 2.5v5M9 5h5" strokeWidth={1.8} /></>,
    'remove-bend': <><path d="M2 5h4a5 5 0 0 1 5 5v4" /><path d="M10 3h4" strokeWidth={2} /></>,
    eye: <><circle cx="8" cy="8" r="5" /><path d="M8 5.5v5M5.5 8h5" /></>,
    vent: <><path d="M8 14V4" /><path d="M5 6.5L8 3.5l3 3" /></>,
    gully: <><path d="M8 1.5v8" /><path d="M5 9.5h6l-1 3.5H6z" /></>,
    trap: <path d="M2 4h3.5v5a2.5 2.5 0 0 0 5 0V4H14" />,
    auto: <><path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" /><path d="M3 2.5v3h3" /></>,
  };
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[glyph]}
    </svg>
  );
}

/** What an option does, as chips: the change in the network's head margin and the checks it would newly fail. */
function DeltaChips({ evaluation, system }: { evaluation: CondensateOptionEvaluation; system: HvacUnitSystem }) {
  const chips: ReactNode[] = [];
  if (evaluation.deltaMarginMm !== null && Math.abs(evaluation.deltaMarginMm) >= 5) {
    chips.push(<span key="m" className={`rounded px-1 tabular-nums ${evaluation.deltaMarginMm > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
      title="Change in the network's least head margin (how far its runs could still drop)">{signed(evaluation.deltaMarginMm)} mm</span>);
  }
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error');
  if (errors.length) {
    chips.push(
      <span key="err" className="inline-flex items-center gap-0.5 rounded bg-red-50 px-1 font-medium text-red-700" title={errors.map((issue) => `${issue.code}: ${toDisplayText(issue.message, system)}`).join('\n')}>
        <TriangleAlert size={10} aria-hidden="true" />{errors.length}<span className="sr-only"> new error{errors.length === 1 ? '' : 's'}</span>
      </span>,
    );
  }
  return chips.length ? <span className="flex shrink-0 items-center gap-1 text-[10.5px]">{chips}</span> : null;
}

/** An option's whole result on one line: the engine's verdict, the margin it gains or loses, the new checks. */
function ResultLine({ evaluation, system }: { evaluation: CondensateOptionEvaluation; system: HvacUnitSystem }) {
  if (evaluation.refused) return <span className="text-red-700">{toDisplayText(evaluation.refused, system)}</span>;
  const parts: ReactNode[] = [<span key="v">{toDisplayText(evaluation.verdict, system)}</span>];
  if (evaluation.deltaMarginMm !== null && Math.abs(evaluation.deltaMarginMm) >= 1) {
    parts.push(<span key="m" className={evaluation.deltaMarginMm > 0 ? 'text-emerald-700' : 'text-amber-700'}>{signed(evaluation.deltaMarginMm)} mm margin</span>);
  }
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error').length;
  const warnings = evaluation.newIssues.length - errors;
  if (errors) parts.push(<span key="e" className="font-medium text-red-700">{errors} new error{errors === 1 ? '' : 's'}</span>);
  if (warnings) parts.push(<span key="w" className="text-amber-700">{warnings} new warning{warnings === 1 ? '' : 's'}</span>);
  if (!errors && !warnings) parts.push(<span key="ok" className="text-emerald-700">no new issues</span>);
  return <span className="tabular-nums">{parts.map((part, index) => <span key={index}>{index ? ' · ' : ''}{part}</span>)}</span>;
}

const ValueField = SegmentValueField<CondensateSegmentOption, CondensateOptionEvaluation>;
type FieldHost = SegmentFieldHost<CondensateSegmentOption, CondensateOptionEvaluation>;

/** The Edit tab: the network's fall, a level the run keeps under, a leg sideways, a riser's height, a wye, a termination's level. */
function EditPanel({ host, scene, element, run, piece, figures, route, options, system }: {
  host: FieldHost;
  scene: readonly HvacElement[];
  element: HvacElement;
  run: CondensateRun;
  piece: CondensatePiece;
  figures: CondensatePieceFigures;
  route: PlanRoute | undefined;
  options: readonly CondensateSegmentOption[];
  system: HvacUnitSystem;
}): ReactNode {
  const chipRow = (group: CondensateSegmentOption['group']) => (
    <ChipRow options={options.filter((option) => option.group === group)} evaluations={host.evaluations} onHover={host.onHover} onApply={host.onApply} />
  );
  const has = (group: CondensateSegmentOption['group']) => options.some((option) => option.group === group);
  const blocks: ReactNode[] = [];
  if (piece.kind === 'leg') {
    const fallNow = Math.round((figures.fall?.slopePercent ?? 1) * 100) / 100;
    // In IP the fall is typed in inches per foot, to the thousandth (1/8 is 0.125); the network keeps it in %.
    const ip = system === 'ip';
    const shownNow = ip ? Number(toDisplay('slope', fallNow, 'ip').toFixed(3)) : fallNow;
    blocks.push(
      <EditBlock key="fall" title="Fall · the whole network">
        <div className="px-1">{chipRow('fall')}</div>
        <ValueField host={host} label="Fall" unit={unitLabel('slope', system)} current={shownNow} min={ip ? 0.06 : 0.5} max={ip ? 1.2 : 10}
          step={ip ? 0.01 : 0.25} fineStep={ip ? 0.005 : 0.05} decimals={ip ? 3 : 2} testId="condensate-segment-fall-field"
          hint="the least fall on every run; steeper where the head allows"
          makeOption={(value) => {
            const fall = ip ? Math.round(fromDisplay('slope', value, 'ip') * 1e4) / 1e4 : value;
            return Math.abs(fall - fallNow) < 1e-3 ? null : condensateValueOption(element, run, piece, { kind: 'fall', percent: fall });
          }} />
      </EditBlock>,
    );
    const top = Math.round(Math.max(...run.nodes.map((node) => node.z)));
    blocks.push(
      <EditBlock key="level" title="Keep the run lower">
        <div className="px-1">{chipRow('level-cap')}</div>
        <ValueField host={host} label="At or below" unit="mm" current={top} min={0} max={30000} step={50} fineStep={10} testId="condensate-segment-level-cap"
          hint="its highest point, its fall kept"
          makeOption={(value) => (value >= top ? null : condensateValueOption(element, run, piece, { kind: 'level-cap', levelMm: value }))} />
      </EditBlock>,
    );
    if (has('offset') && route) {
      const segmentAcross = options.find((option) => option.id === 'offset:100');
      blocks.push(
        <EditBlock key="offset" title="Sideways">
          <div className="px-1">{chipRow('offset')}</div>
          <ValueField host={host} label="Shift" unit="mm" current={0} min={-5000} max={5000} step={50} fineStep={10} signed testId="condensate-segment-offset"
            hint={segmentAcross ? `+ moves it ${segmentAcross.detail.replace(/^\d+ mm /, '')}` : undefined}
            makeOption={(value) => condensateOffsetOption(element, run, piece, route, value)} />
        </EditBlock>,
      );
    }
  }
  if (piece.kind === 'riser' && has('lift')) {
    const head = figures.lift?.pumpHeadMm ?? 600;
    blocks.push(
      <EditBlock key="lift" title="Riser height">
        <div className="px-1">{chipRow('lift')}</div>
        <ValueField host={host} label="Height" unit="mm" current={Math.round(piece.lengthMm)} min={0} max={Math.round(head)} step={50} fineStep={10} testId="condensate-segment-lift-field"
          hint={`at most; the pump raises ${number(head)} mm`}
          makeOption={(value) => condensateValueOption(element, run, piece, { kind: 'lift', liftMm: value })} />
      </EditBlock>,
    );
  }
  if (piece.kind === 'end' && has('wye')) {
    blocks.push(<EditBlock key="wye" title="Slide the wye along its main"><div className="px-1">{chipRow('wye')}</div></EditBlock>);
  }
  if (piece.kind === 'termination' && run.spec.drainEnd?.gullyId) {
    const gully = scene.find((candidate) => candidate.id === run.spec.drainEnd!.gullyId);
    if (gully) {
      const inlet = Math.round(readCondensateGullySpec(gully).inletElevationMm);
      blocks.push(
        <EditBlock key="inlet" title="Termination level">
          <ValueField host={host} label="Inlet" unit="mm" current={inlet} min={0} max={6000} step={50} fineStep={10} testId="condensate-segment-inlet"
            hint="rim, stack branch or wall outlet; the network solved again round it"
            makeOption={(value) => condensateValueOption(element, run, piece, { kind: 'inlet', levelMm: value })} />
        </EditBlock>,
      );
    }
  }
  return blocks.length ? <div className="space-y-2" data-testid="condensate-segment-edit-panel">{blocks}</div> : null;
}

/** A size option's detail: "Ø32 · bore 28.4 mm · …". */
const SIZE_DETAIL = /^Ø(\d+(?:\.\d+)?) · bore (\d+(?:\.\d+)?) mm/;

/** The options in the unit system: in IP a fall named in in/ft, a size's outside and bore in inches, the details' figures with their IP values. */
function optionsIn(options: CondensateSegmentOption[], system: HvacUnitSystem): CondensateSegmentOption[] {
  if (system === 'si') return options;
  return options.map((option) => {
    const fall = option.group === 'fall' ? /^fall(?:-custom)?:(\d+(?:\.\d+)?)$/.exec(option.id) : null;
    return {
      ...option,
      title: fall ? slopeText(Number(fall[1])) : option.title,
      detail: option.group === 'size'
        ? option.detail.replace(SIZE_DETAIL, (_match, outer: string, bore: string) => `Ø${(Number(outer) / 25.4).toFixed(2)} in · bore ${(Number(bore) / 25.4).toFixed(2)} in`)
        : toDisplayText(option.detail, system),
    };
  });
}

function titleOf(piece: CondensatePiece, figures: CondensatePieceFigures, run: CondensateRun): { title: string; detail: string } {
  const role = ROLE_WORD[run.role];
  switch (piece.kind) {
    case 'connection':
      return {
        title: `${figures.connection?.pumped ? 'Pumped hose' : 'Outlet stub'} · ${figures.connection?.unitLabel ?? ''}`,
        detail: `${metres(piece.lengthMm)}${figures.connection?.trapDepthMm !== null && figures.connection?.trapDepthMm !== undefined ? ' · P-trap' : ''}`,
      };
    case 'riser':
      return { title: `Riser · ${figures.lift?.unitLabel ?? ''}`, detail: figures.lift ? `${number(figures.lift.liftMm)} of ${number(figures.lift.pumpHeadMm)} mm pump head` : `${number(piece.lengthMm)} mm` };
    case 'leg':
      return { title: `${role} · leg ${piece.ordinal}`, detail: `${figures.fall ? `fall ${figures.fall.ratio} · ` : ''}${metres(piece.planLengthMm)}` };
    case 'bend':
      return { title: `Elbow ${number(piece.angleDeg ?? 0)}°`, detail: `${role.toLowerCase()} · in plan` };
    case 'end':
      return figures.end?.kind === 'wye' ? { title: `Wye into ${figures.end.into}`, detail: 'joins from the top' }
        : figures.end?.kind === 'drop' ? { title: `Into the drop to ${figures.end.into}`, detail: `@ ${metres(piece.from.z)}` }
          : { title: `Joins ${figures.end?.into ?? 'the main'}`, detail: `@ ${metres(piece.from.z)}` };
    case 'termination':
      return figures.termination
        ? { title: `${TERMINATION_WORD[figures.termination.kind]} · ${figures.termination.gullyLabel}`,
          detail: `${TRAP_WORD[figures.termination.trap]}${figures.termination.kind === 'floor-gully' ? ` · air break ${number(figures.termination.airBreakMm)} mm` : ''}` }
        : { title: 'Termination', detail: '' };
    default:
      return { title: figures.fitting?.label ?? 'Fitting', detail: figures.fitting?.note ?? '' };
  }
}

function buildModel(scene: HvacElement[], focus: SegmentFocus, context: CondensateCardContext): CondensateCardModel | null {
  const element = scene.find((candidate) => candidate.id === focus.runId);
  const run = element ? condensateRunOf(element) : null;
  const piece = run ? condensatePieceOf(run, focus.key) : null;
  if (!element || !run || !piece) return null;
  const networkId = getCondensateOwnership(element)?.networkId ?? null;
  const baseline = networkId ? condensateNetworkBaseline(scene, networkId, context) : null;
  const figures = condensatePieceFigures(scene, element, run, piece, context.settings, baseline);
  const { title, detail } = titleOf(piece, figures, run);
  const system = context.unitSystem ?? 'si';
  const options = optionsIn(condensatePieceOptions(scene, element, run, piece, context), system);
  const route = networkId ? condensateSessionFor(scene, networkId, context)?.model.routes.get(element.id) : undefined;
  const token: RekeyToken = { kind: piece.kind, ordinal: piece.ordinal };
  const issues = condensatePieceIssues(context.report, element, run, piece, figures);
  return {
    head: {
      title,
      size: `CD ${figures.nominalSize} · ${ROLE_WORD[run.role].toLowerCase()}`,
      detail,
      tag: pieceTag(piece),
      glyph: <DrainSegmentGlyph kind={piece.kind} className="h-3.5 w-3.5" />,
      tone: TONE,
      kind: piece.kind,
    },
    figures: <FigureStrip figures={figures} piece={piece} system={system} />,
    info: <BuildInfo figures={figures} piece={piece} system={system} />,
    issues: system === 'si' ? issues : issues.map((issue) => ({ ...issue, message: toDisplayText(issue.message, system) })),
    options,
    evaluate: (option) => evaluateCondensateOption(scene, option, context),
    tabOf: (option) => (SWAP_GROUPS.has(option.group) ? 'swap' : ADD_GROUPS.has(option.group) ? 'add' : null),
    edit: (host) => EditPanel({ host, scene, element, run, piece, figures, route, options, system }),
    neighbour: (direction) => {
      const next = neighbourCondensatePiece(run, piece.key, direction);
      return next ? { key: next.key, anchorMark: null } : null;
    },
    rekeyToken: token,
  };
}

/** A drain run's pieces as its inspector lists them: the card's own tags, a name, a length, a rise or an angle. */
export function condensatePieceRows(element: HvacElement): SegmentPieceRow[] {
  const run = condensateRunOf(element);
  if (!run) return [];
  return run.pieces.map((piece) => ({
    key: piece.key,
    tag: pieceTag(piece),
    title: piece.kind === 'connection' ? (run.spec.pumped ? 'Pumped hose' : 'Outlet stub')
      : piece.kind === 'end' ? (piece.fittings.some((fitting) => fitting.kind === 'wye') ? 'Wye into its main' : 'Joint')
        : `${KIND_WORD[piece.kind]}${NUMBERED.has(piece.kind) && piece.kind !== 'bend' ? ` ${piece.ordinal}` : ''}`,
    detail: piece.kind === 'bend' ? `${number(piece.angleDeg ?? 0)}°`
      : piece.kind === 'riser' ? `↑ ${number(piece.lengthMm)} mm`
        : piece.kind === 'termination' ? `↓ ${metres(piece.fallMm)}`
          : piece.planLengthMm > 0 ? metres(piece.planLengthMm) : '',
  }));
}

/** The condensate drains' segment cards, read with the project's condensate settings and the live design checks. */
export function createCondensateSegmentProvider(context: CondensateCardContext): CondensateSegmentProvider {
  const cache = new WeakMap<readonly HvacElement[], Map<string, CondensateCardModel | null>>();
  const system = context.unitSystem ?? 'si';
  return {
    domain: 'condensate',
    testIdPrefix: 'condensate-segment',
    model: (scene, focus) => {
      let byPiece = cache.get(scene);
      if (!byPiece) {
        byPiece = new Map();
        cache.set(scene, byPiece);
      }
      const id = `${focus.runId}|${focus.key}`;
      if (!byPiece.has(id)) byPiece.set(id, buildModel(scene, focus, context));
      return byPiece.get(id) ?? null;
    },
    optionGlyph: (option) => <OptionGlyph glyph={option.glyph} className="h-3.5 w-3.5" />,
    chips: (evaluation) => <DeltaChips evaluation={evaluation} system={system} />,
    result: (evaluation) => <ResultLine evaluation={evaluation} system={system} />,
    // A peek's quick picks: the most head margin gained first.
    quickScore: (evaluation) => -(evaluation.deltaMarginMm ?? 0),
    // One undo step, as a drain handle's edit is (ids kept; a re-solve may add or take out runs).
    commit: (evaluation, option) => {
      const add = evaluation.add ?? [];
      const removeIds = evaluation.removeIds ?? [];
      if (!evaluation.updates.length && !add.length && !removeIds.length) return;
      useSmartDrawingStore.getState().commitHvacElementCommand(evaluation.action || option.title, {
        add, removeIds, updates: evaluation.updates.map((element) => ({ id: element.id, updates: element })),
      });
    },
    rekey: (scene, focus, token) => {
      const element = scene.find((candidate) => candidate.id === focus.runId);
      const run = element ? condensateRunOf(element) : null;
      if (!run) return null;
      if (condensatePieceOf(run, focus.key)) return focus;
      const wanted = token as RekeyToken | null;
      const same = wanted ? run.pieces.find((piece) => piece.kind === wanted.kind && piece.ordinal === wanted.ordinal) : null;
      return same ? { ...focus, key: same.key, anchorMark: null } : null;
    },
  };
}
