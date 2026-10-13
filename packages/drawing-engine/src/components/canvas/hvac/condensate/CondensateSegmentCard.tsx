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
 */
import type { ReactNode } from 'react';

import type { HvacElement } from '../../../../types';
import type { VrfValidationReport } from '../../../../vrf/rules/validation-engine';
import { STATUS_DOT, STATUS_TEXT, formatNumber as number, type FigureStatus } from '../segments/SegmentCardKit';
import type { SegmentCardModel, SegmentEvaluationLike, SegmentIssueLine, SegmentOptionLike, SegmentProvider } from '../segments/segmentProvider';
import type { SegmentFocus } from '../segments/segmentUiStore';

import type { CondensateEditContext } from './condensateEditing';
import { condensateNetworkBaseline, condensatePieceFigures, type CondensatePieceFigures } from './condensatePieceFigures';
import { condensatePieceOf, condensateRunOf, neighbourCondensatePiece, type CondensatePiece, type CondensatePieceKind, type CondensateRun } from './condensatePieces';
import { formatFallRatio } from './condensateSettings';
import { getCondensateOwnership, type CondensateSegmentRole, type CondensateTerminalTrap, type CondensateTerminationKind } from './condensateTypes';

/** Options arrive with the next phase; until then a drain's card is figures and checks. */
export type CondensateSegmentOption = SegmentOptionLike;
export type CondensateOptionEvaluation = SegmentEvaluationLike;
export type CondensateSegmentProvider = SegmentProvider<CondensateSegmentOption, CondensateOptionEvaluation>;
type CondensateCardModel = SegmentCardModel<CondensateSegmentOption, CondensateOptionEvaluation>;

export interface CondensateCardContext extends CondensateEditContext {
  report: VrfValidationReport;
}

const ROLE_WORD: Record<CondensateSegmentRole, string> = { 'unit-branch': 'Branch', main: 'Main', lift: 'Lift', drop: 'Drop', terminal: 'Outlet' };
const KIND_TAG: Record<CondensatePieceKind, string> = { connection: 'H', riser: 'R', leg: 'L', bend: 'B', end: 'J', termination: 'T', eye: 'E', vent: 'V', sleeve: 'S' };
const TRAP_WORD: Record<CondensateTerminalTrap, string> = { tundish: 'tundish', hepvo: 'waterless valve', 'p-trap': 'P-trap', none: 'open discharge' };
const TERMINATION_WORD: Record<CondensateTerminationKind, string> = { 'floor-gully': 'Floor gully', 'stack-connection': 'Stack connection', 'external-discharge': 'Wall outlet' };
const TONE = 'bg-cyan-50 text-cyan-700';

const metres = (mm: number, digits = 2) => `${number(mm / 1000, digits)} m`;
const percent = (value: number) => `${number(value, value < 10 ? 1 : 0)} %`;

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
function FigureStrip({ figures, piece }: { figures: CondensatePieceFigures; piece: CondensatePiece }) {
  const stats: ReactNode[] = [];
  const size = stat(`CD ${figures.nominalSize}`, '', `${figures.system.label} ${figures.nominalSize}: Ø${number(figures.outerDiameterMm, 1)} outside, ${number(figures.innerDiameterMm, 1)} mm bore`);
  const margin = figures.headMarginMm !== null && figures.headStatus
    ? stat(number(figures.headMarginMm), 'mm', `Head margin: ${number(figures.headMarginMm)} mm above the lowest profile that still meets the minimum fall — ${MARGIN_TEXT[figures.headStatus]}`, figures.headStatus, 'condensate-segment-margin')
    : null;
  if (figures.fall) {
    const fall = figures.fall;
    stats.push(<span key="s">{size}</span>);
    stats.push(<span key="l">{stat(number(figures.planLengthMm / 1000, 2), 'm', `${metres(figures.planLengthMm, 3)} in plan, ${metres(figures.lengthMm, 3)} along it`)}</span>);
    stats.push(<span key="f">{stat(fall.ratio, percent(fall.slopePercent), `Falls ${percent(fall.slopePercent)} (${fall.ratio}) — minimum ${percent(fall.minimumPercent)}, preferred ${percent(fall.preferredPercent)}: ${STATUS_TEXT[fall.status]}`, fall.status, 'condensate-segment-fall')}</span>);
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
    stats.push(<span key="q">{stat(number(figures.capacity.designLitresPerHour, 1), `of ${number(figures.capacity.capacityLitresPerHour)} L/h`, 'Design flow against what it carries at its fall', figures.capacity.status)}</span>);
  }
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2" data-testid="condensate-segment-figures">{stats}</div>;
}

/** How the piece is built and what it carries (behind ⓘ). */
function BuildInfo({ figures, piece }: { figures: CondensatePieceFigures; piece: CondensatePiece }) {
  const fittings = Object.entries(piece.fittings.reduce<Record<string, number>>((counts, fitting) => {
    counts[fitting.kind] = (counts[fitting.kind] ?? 0) + 1;
    return counts;
  }, {})).map(([kind, count]) => `${count}× ${kind.replace('-', ' ')}`);
  return (
    <>
      <div>
        {figures.system.label} {figures.nominalSize} · Ø{number(figures.outerDiameterMm, 1)} outside, {number(figures.innerDiameterMm, 1)} mm bore
        {figures.insulationMm > 0 ? ` · ${number(figures.insulationMm)} mm closed-cell insulation` : ' · uninsulated'}
        {figures.system.verified ? '' : ' (catalogue walls unverified)'}
      </div>
      <div>
        {ROLE_WORD[figures.role]} · carries {figures.unitsServed} unit{figures.unitsServed === 1 ? '' : 's'}, {number(figures.capacityKw, 1)} kW
        {figures.capacity ? ` · design flow ${number(figures.capacity.designLitresPerHour, 1)} L/h, ${number(figures.capacity.capacityLitresPerHour)} L/h at its fall ${number(figures.capacity.fillRatio * 100)} % full (Manning)` : ''}
      </div>
      {figures.fall ? (
        <div>
          Falls {percent(figures.fall.slopePercent)} ({formatFallRatio(Math.max(0, figures.fall.slopePercent))}) over {metres(figures.planLengthMm, 2)}
          {figures.fall.offsets.count ? ` · ${figures.fall.offsets.count === 1 ? 'a 45° offset drops' : `${figures.fall.offsets.count} 45° offsets drop`} it ${number(figures.fall.offsets.dropMm)} mm` : ''}
          {` · minimum ${percent(figures.fall.minimumPercent)}, preferred ${percent(figures.fall.preferredPercent)}`}
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

const NO_OPTIONS: CondensateSegmentOption[] = [];
const refuse = (option: CondensateSegmentOption): CondensateOptionEvaluation => ({
  optionId: option.id, refused: 'Not available yet.', updates: [], action: option.title, notes: [], newIssues: [],
});

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
  const token: RekeyToken = { kind: piece.kind, ordinal: piece.ordinal };
  return {
    head: {
      title,
      size: `CD ${figures.nominalSize} · ${ROLE_WORD[run.role].toLowerCase()}`,
      detail,
      tag: `CD-${KIND_TAG[piece.kind]}${piece.kind === 'leg' || piece.kind === 'bend' || piece.kind === 'eye' || piece.kind === 'vent' || piece.kind === 'sleeve' ? piece.ordinal : ''}`,
      glyph: <DrainSegmentGlyph kind={piece.kind} className="h-3.5 w-3.5" />,
      tone: TONE,
      kind: piece.kind,
    },
    figures: <FigureStrip figures={figures} piece={piece} />,
    info: <BuildInfo figures={figures} piece={piece} />,
    issues: condensatePieceIssues(context.report, element, run, piece, figures),
    options: NO_OPTIONS,
    evaluate: refuse,
    tabOf: () => null,
    edit: () => null,
    neighbour: (direction) => {
      const next = neighbourCondensatePiece(run, piece.key, direction);
      return next ? { key: next.key, anchorMark: null } : null;
    },
    rekeyToken: token,
  };
}

/** The condensate drains' segment cards, read with the project's condensate settings and the live design checks. */
export function createCondensateSegmentProvider(context: CondensateCardContext): CondensateSegmentProvider {
  const cache = new WeakMap<readonly HvacElement[], Map<string, CondensateCardModel | null>>();
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
    optionGlyph: () => null,
    chips: () => null,
    result: () => null,
    commit: () => undefined,
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
