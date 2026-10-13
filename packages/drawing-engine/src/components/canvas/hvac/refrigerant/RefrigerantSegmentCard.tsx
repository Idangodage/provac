'use client';

/**
 * The refrigerant pipes' segment cards, as the refrigerant SegmentProvider: a
 * line's port stubs, straights, risers and bends (refrigerantPieces), each with
 * its figures (refrigerantPieceFigures) — the line's tube and insulation, the
 * piece's length, level and slope, a bend's angle, radius, construction and
 * plane, a port's straight approach, and the circuit it is on (the longest
 * path through it, the height difference, the indoor units it serves, the
 * profile's size recommendation or that no sizing table is loaded) — and the
 * design checks that name it. A coordinated gas + liquid pair is one card with
 * a Gas | Liquid switch.
 *
 * Its options (refrigerantSegmentOptions) are edits through the pipe engine:
 * Swap — the line's size, its bends' construction and radius, a 90° made two
 * 45°s, a bend turned into another plane, a leg's copper; Edit — a straight's
 * level, sideways offset and length, the line's insulation; Add — a route
 * point, a bend taken out. A branch kit's card slides it along its run (a
 * pair's gas and liquid kits together) and lists turning it over and other
 * models with why they cannot be made. Each shows on the drawing before it is
 * applied, with its change in length and charge and the checks it would newly
 * fail.
 */
import { Star, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { PROJECT_FALLBACK_RULE_PROFILE, type ManufacturerRuleProfile, type RuleValue } from '../../../../vrf/rules/rule-profile';
import type { VrfValidationReport } from '../../../../vrf/rules/validation-engine';
import {
  ChipRow,
  EditBlock,
  STATUS_DOT,
  STATUS_TEXT,
  ValueField as SegmentValueField,
  formatNumber as number,
  formatSigned as signed,
} from '../segments/SegmentCardKit';
import type { SegmentPieceRow } from '../segments/SegmentPieceList';
import type { SegmentBadge, SegmentCardModel, SegmentFieldHost, SegmentIssueLine, SegmentProvider } from '../segments/segmentProvider';
import { useSegmentUiStore, type SegmentFocus } from '../segments/segmentUiStore';

import { KIT_KEY, refrigerantKitOf, type RefrigerantKit } from './refrigerantKits';
import { refrigerantCircuitFigures, refrigerantPieceFigures, type RefrigerantCircuitFigures, type RefrigerantPieceFigures } from './refrigerantPieceFigures';
import { distanceToPath, neighbourPiece, pieceMidpoint, refrigerantLineOf, refrigerantPieceOf, type RefrigerantLine, type RefrigerantPiece } from './refrigerantPieces';
import {
  evaluateRefrigerantOption,
  kitRunAxis,
  refrigerantKitOptions,
  refrigerantKitSlideOption,
  refrigerantPieceOptions,
  refrigerantValueOption,
  screenWay,
  type RefrigerantOptionEvaluation,
  type RefrigerantOptionGlyph,
  type RefrigerantPartner,
  type RefrigerantSegmentOption,
} from './refrigerantSegmentOptions';

export type { RefrigerantOptionEvaluation, RefrigerantSegmentOption } from './refrigerantSegmentOptions';
export type RefrigerantSegmentProvider = SegmentProvider<RefrigerantSegmentOption, RefrigerantOptionEvaluation>;
type RefrigerantCardModel = SegmentCardModel<RefrigerantSegmentOption, RefrigerantOptionEvaluation>;

export interface RefrigerantCardContext {
  profile?: ManufacturerRuleProfile;
  report: VrfValidationReport;
}

const KIND_TITLES: Record<RefrigerantPiece['kind'], string> = { port: 'Port stub', straight: 'Straight', riser: 'Riser', bend: 'Bend' };
const KIND_TAGS: Record<RefrigerantPiece['kind'], string> = { port: 'P', straight: 'S', riser: 'R', bend: 'B' };
const LINE_TONE: Record<RefrigerantLine['lineKind'], string> = {
  gas: 'bg-orange-50 text-orange-600',
  liquid: 'bg-blue-50 text-blue-600',
  pair: 'bg-amber-50 text-amber-700',
};
const LINE_NAME: Record<RefrigerantLine['lineKind'], string> = { gas: 'Gas', liquid: 'Liquid', pair: 'Pair' };

const metres = (mm: number, digits = 2) => `${number(mm / 1000, digits)} m`;
const signedMm = (mm: number) => `${mm > 0 ? '+' : mm < 0 ? '−' : '±'}${number(Math.abs(mm))}`;
const provenance = (value: RuleValue<number>) => (value.verified ? value.source.replace('manufacturer-', 'manufacturer ') : `${value.source.replace('-', ' ')}, unverified`);

/** A piece's picture: a straight tube, a riser, an elbow, a port stub. */
export function PipeSegmentGlyph({ kind, className }: { kind: RefrigerantPiece['kind'] | 'kit'; className?: string }) {
  const paths: Record<typeof kind, ReactNode> = {
    straight: <><path d="M2 5.5h12M2 10.5h12" /><path d="M2 5.5v5M14 5.5v5" opacity={0.55} /></>,
    riser: <><path d="M5.5 2v12M10.5 2v12" /><path d="M5.5 2h5M5.5 14h5" opacity={0.55} /></>,
    bend: <><path d="M2 4.5h3.5a7 7 0 0 1 7 7V14" /><path d="M2 9.5h3.5a2 2 0 0 1 2 2V14" /></>,
    port: <><path d="M3 3v10" strokeWidth={2.4} /><path d="M4.5 5.5h9.5M4.5 10.5h9.5" /></>,
    kit: <><path d="M1.5 8h5" /><path d="M6.5 8l7-4.5M6.5 8l7 4.5" /></>,
  };
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

/** The pair's other line, when the line is one of a coordinated gas + liquid pair. */
export function partnerOf(element: HvacElement, scene: readonly HvacElement[]): HvacElement | null {
  const bundleId = typeof element.properties.bundleId === 'string' ? element.properties.bundleId : null;
  const kind = element.properties.lineKind;
  if (!bundleId || element.type !== 'refrigerant-pipe') return null;
  return scene.find((candidate) => candidate.id !== element.id && candidate.type === 'refrigerant-pipe'
    && candidate.properties.bundleId === bundleId && candidate.properties.lineKind !== kind) ?? null;
}

/**
 * The partner's piece alongside this one: of its kind, the one whose centreline passes nearest this piece's middle
 * (the two lines of a pair run side by side; their pieces need not be numbered alike — one may have a short straight
 * the other has not), else the nearest piece of any kind.
 */
export function matchingPiece(line: RefrigerantLine, piece: RefrigerantPiece): RefrigerantPiece | null {
  const middle = pieceMidpoint(piece);
  let best: { candidate: RefrigerantPiece; distance: number } | null = null;
  for (const sameKind of [true, false]) {
    for (const candidate of line.pieces) {
      if (sameKind && candidate.kind !== piece.kind) continue;
      const distance = distanceToPath(middle, candidate.path);
      if (!best || distance < best.distance) best = { candidate, distance };
    }
    if (best) return best.candidate;
  }
  return null;
}

function stat(value: string, unit: string, title: string, status?: keyof typeof STATUS_DOT | null) {
  return (
    <span className="inline-flex items-baseline gap-1" title={title}>
      {status ? <span className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" /> : null}
      <span className="text-[13px] font-semibold tabular-nums text-slate-900">{value}</span>
      {unit ? <span className="text-[10.5px] text-slate-400">{unit}</span> : null}
    </span>
  );
}

/** The Gas | Liquid switch of a coordinated pair: the other line's matching piece. */
function LineSwitch({ focus, lineKind, partner }: { focus: SegmentFocus; lineKind: 'gas' | 'liquid'; partner: { id: string; key: string } }) {
  const pin = useSegmentUiStore((state) => state.pin);
  const options = (['gas', 'liquid'] as const);
  return (
    <span className="inline-flex rounded-lg bg-slate-100 p-0.5" role="radiogroup" aria-label="Line" data-testid="refrigerant-segment-line">
      {options.map((value) => {
        const active = value === lineKind;
        return (
          <button key={value} type="button" role="radio" aria-checked={active}
            className={`rounded-md px-2 py-[1px] text-[11px] font-medium transition-colors ${active
              ? `bg-white shadow-sm ${value === 'gas' ? 'text-orange-700' : 'text-blue-700'}` : 'text-slate-500 hover:text-slate-800'}`}
            onClick={() => (active ? undefined : pin({ ...focus, runId: partner.id, key: partner.key, anchorMark: null }))}>
            <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${value === 'gas' ? 'bg-orange-500' : 'bg-blue-500'}`} aria-hidden="true" />
            {value === 'gas' ? 'Gas' : 'Liquid'}
          </button>
        );
      })}
    </span>
  );
}

/** The piece in one strip: its size, length (or a bend's angle and radius), level, and the path through it. */
function FigureStrip({ figures, piece, focus, partner }: {
  figures: RefrigerantPieceFigures;
  piece: RefrigerantPiece;
  focus: SegmentFocus;
  partner: { id: string; key: string } | null;
}) {
  const size = `Ø${number(figures.tubeOdMm, 2)}`;
  const circuit = figures.circuit;
  const stats: ReactNode[] = [];
  if (figures.bend) {
    const bend = figures.bend;
    stats.push(<span key="a">{stat(`${number(bend.angleDeg)}°`, '', `Turns ${number(bend.angleDeg, 1)}°`)}</span>);
    stats.push(<span key="r">{stat(`R ${number(bend.radiusMm)}`, 'mm', bend.minimumRadius
      ? `Centreline radius ${number(bend.radiusMm)} mm, ${bend.radiusStatus ? STATUS_TEXT[bend.radiusStatus] : ''} (minimum ${number(bend.minimumRadius.value)} mm: ${provenance(bend.minimumRadius)})`
      : `Centreline radius ${number(bend.radiusMm)} mm (the elbow's own)`, bend.radiusStatus)}</span>);
    stats.push(<span key="p">{stat(bend.plane === 'horizontal' ? 'Level' : bend.plane === 'vertical' ? 'Vertical' : 'Inclined', '', `Turns in a ${bend.plane} plane`)}</span>);
  } else if (figures.port) {
    const port = figures.port;
    stats.push(<span key="s">{stat(size, figures.inch ?? '', `Copper Ø${number(figures.tubeOdMm, 2)} mm${figures.inch ? ` (${figures.inch})` : ''}`)}</span>);
    stats.push(<span key="st">{stat(number(port.availableMm), 'mm', `Straight ${number(port.availableMm)} mm before the first fitting; the port reserves ${number(port.required.value)} mm (${provenance(port.required)}) — ${STATUS_TEXT[port.status]}`, port.status)}</span>);
  } else {
    stats.push(<span key="s">{stat(size, figures.inch ?? '', `Copper Ø${number(figures.tubeOdMm, 2)} mm${figures.inch ? ` (${figures.inch})` : ''} · ${number(figures.insulationMm)} mm insulation, Ø${number(figures.outsideDiameterMm)} outside`)}</span>);
    stats.push(<span key="l">{stat(number(figures.lengthMm / 1000, 2), 'm', `Length ${metres(figures.lengthMm, 3)} along its centreline`)}</span>);
    stats.push(piece.kind === 'riser'
      ? <span key="z">{stat(`${figures.riseMm >= 0 ? '↑' : '↓'} ${number(Math.abs(figures.riseMm))}`, 'mm', `Rises ${signedMm(figures.riseMm)} mm`)}</span>
      : <span key="z">{stat(`@ ${number(figures.levelMm / 1000, 2)}`, 'm', `Centreline at ${number(figures.levelMm)} mm${figures.slopePercent !== null ? ` · falls ${number(Math.abs(figures.slopePercent), 1)} %` : ''}`)}</span>);
  }
  if (circuit?.longestPathMm !== null && circuit?.longestPathMm !== undefined && !figures.bend) {
    stats.push(
      <span key="path" className="ml-auto">
        {stat(number(circuit.longestPathMm / 1000, 1), 'm path', `Longest path through it ${metres(circuit.longestPathMm, 1)}${circuit.pathLimit ? ` of ${metres(circuit.pathLimit.value, 0)} (${provenance(circuit.pathLimit)})` : ''}${circuit.equivalentPathMm === null ? ' · equivalent length unknown: bend allowances are not in the profile' : ` · equivalent ${metres(circuit.equivalentPathMm, 1)}`}`, circuit.pathStatus)}
      </span>,
    );
  }
  return (
    <div className="space-y-1.5 px-3 pb-2" data-testid="refrigerant-segment-figures">
      {partner && figures.lineKind !== 'pair' ? <LineSwitch focus={focus} lineKind={figures.lineKind} partner={partner} /> : null}
      <div className="flex items-center gap-x-3">{stats}</div>
    </div>
  );
}

/** How the piece is built and what it serves (behind ⓘ). */
function BuildInfo({ figures, piece, line }: { figures: RefrigerantPieceFigures; piece: RefrigerantPiece; line: RefrigerantLine }) {
  const circuit = figures.circuit;
  const recommendation = circuit?.recommendation ?? null;
  return (
    <>
      <div>
        Copper Ø{number(figures.tubeOdMm, 2)}{figures.inch ? ` (${figures.inch})` : ''}
        {figures.material ? ` · ${figures.material === 'hard' ? 'hard (straight lengths)' : 'flexible (annealed coil)'}` : ''}
        {` · ${number(figures.insulationMm)} mm insulation, Ø${number(figures.outsideDiameterMm)} outside`}
      </div>
      {figures.bend ? (
        <div>
          {figures.bend.construction === 'socket-elbow' ? `Socket elbow${figures.bend.catalogueModel ? ` ${figures.bend.catalogueModel}` : ''}` : 'Formed bend'}
          {` · ${number(figures.bend.angleDeg, 1)}° · R ${number(figures.bend.radiusMm)} mm · ${figures.bend.plane} plane`}
          {figures.bend.minimumRadius ? ` · minimum R ${number(figures.bend.minimumRadius.value)} mm (${provenance(figures.bend.minimumRadius)})` : ''}
        </div>
      ) : null}
      {figures.port ? (
        <div>{figures.port.label} ({figures.port.kind}) · straight {number(figures.port.availableMm)} of {number(figures.port.required.value)} mm reserved ({provenance(figures.port.required)})</div>
      ) : null}
      {!figures.bend && !figures.port ? (
        <div>
          {metres(figures.lengthMm, 3)} straight
          {piece.legIndex !== null && line.design.legs[piece.legIndex] ? ` (${metres(line.design.legs[piece.legIndex]!.lengthMm, 3)} corner to corner)` : ''}
          {` · centreline ${number(figures.levelMm)} mm`}{piece.kind === 'riser' ? ` · rises ${signedMm(figures.riseMm)} mm` : ''}{figures.slopePercent !== null ? ` · falls ${number(Math.abs(figures.slopePercent), 1)} %` : ''}
        </div>
      ) : null}
      {circuit ? (
        <div>
          On {circuit.outdoorLabel}&apos;s circuit · {circuit.indoorUnitIds.length} indoor unit{circuit.indoorUnitIds.length === 1 ? '' : 's'} downstream
          {circuit.downstreamCapacityIndex !== null ? ` · capacity index ${number(circuit.downstreamCapacityIndex)}` : ''}
          {circuit.heightDifferenceMm !== null ? ` · height difference ${metres(circuit.heightDifferenceMm, 1)}${circuit.heightLimit ? ` of ${metres(circuit.heightLimit.value, 0)}` : ''}` : ''}
        </div>
      ) : <div>Not on an outdoor unit&apos;s circuit yet.</div>}
      {circuit ? (
        <div data-testid="refrigerant-segment-sizing">
          {!circuit.sizingTable ? 'No sizing table loaded: the size is not checked against a manufacturer table.'
            : recommendation?.recommendedDiameterMm !== undefined
              ? (recommendation.status === 'matches' ? `Matches the profile size (Ø${number(recommendation.recommendedDiameterMm, 2)}).` : `The profile recommends Ø${number(recommendation.recommendedDiameterMm, 2)}.`)
              : recommendation?.note ?? 'The profile has no size for it.'}
          {` (${circuit.profileVerified ? 'verified profile' : 'unverified profile'})`}
        </div>
      ) : null}
      {figures.charge ? (
        <div>Additional charge ≈ {number(figures.charge.kgPerM, 3)} kg/m · {number(figures.charge.pieceKg, 2)} kg here, {number(figures.charge.lineKg, 2)} kg on the line (practice table, unverified: the outdoor unit&apos;s table governs)</div>
      ) : null}
      {line.design.unresolved.length ? <div className="text-amber-700">{line.design.unresolved.join(' ')}</div> : null}
    </>
  );
}

/** The design checks that name the line, those about one place on it kept to that piece. */
export function pieceIssues(report: VrfValidationReport, element: HvacElement, line: RefrigerantLine, piece: RefrigerantPiece): SegmentIssueLine[] {
  const ids = new Set([element.id, `${element.id}:gas`, `${element.id}:liquid`]);
  const lowest = line.pieces.filter((candidate) => candidate.kind === 'straight')
    .reduce<RefrigerantPiece | null>((low, candidate) => (!low || Math.min(...candidate.path.map((p) => p.z)) < Math.min(...low.path.map((p) => p.z)) ? candidate : low), null);
  const hasPorts = line.pieces.some((candidate) => candidate.kind === 'port');
  return report.issues.flatMap((issue) => {
    if (!issue.entityId || !ids.has(issue.entityId) || (issue.level !== 'error' && issue.level !== 'warning')) return [];
    const here = issue.code === 'PORT_STUB' ? (hasPorts ? piece.kind === 'port' : piece === line.pieces[0] || piece === line.pieces[line.pieces.length - 1])
      : issue.code === 'NO_SAG_TRAP' || issue.code === 'ELEVATION_LOW_POCKET' ? piece === lowest
        : true;
    return here ? [{ severity: issue.level, code: issue.code, message: issue.message }] : [];
  });
}

interface RekeyToken {
  kind: RefrigerantPiece['kind'];
  ordinal: number;
}

// ---------------------------------------------------------------------------------------------------- options on the card

const SWAP_GROUPS = new Set<RefrigerantSegmentOption['group']>(['size', 'construction', 'radius', 'split-bend', 'plane', 'material', 'kit-flip', 'kit-model']);
const ADD_GROUPS = new Set<RefrigerantSegmentOption['group']>(['add-point', 'remove-bend']);

const BADGES: Record<string, SegmentBadge> = {
  recommended: {
    icon: <Star size={12} aria-hidden="true" />, tone: 'text-emerald-600 fill-emerald-500/20', label: 'Recommended',
    title: 'The size the profile (or the unit\'s port) asks for',
  },
};

/** An option's picture. */
function OptionGlyph({ glyph, className }: { glyph: RefrigerantOptionGlyph; className?: string }) {
  const paths: Record<RefrigerantOptionGlyph, ReactNode> = {
    size: <circle cx="8" cy="8" r="4.5" />,
    'size-down': <><circle cx="6.5" cy="9.5" r="3.5" /><path d="M13 3v6M11 7l2 2 2-2" /></>,
    'size-up': <><circle cx="6.5" cy="9.5" r="3.5" /><path d="M13 9V3M11 5l2-2 2 2" /></>,
    socket: <><path d="M2 5h4a6 6 0 0 1 6 6v3" /><path d="M5 3v4M10 11h4" strokeWidth={2} /></>,
    formed: <path d="M2 5h3a7 7 0 0 1 7 7v2" />,
    radius: <><path d="M3 4a9 9 0 0 1 9 9" /><path d="M3 13l6-6" strokeDasharray="2 2" /></>,
    split: <path d="M2 4h5l5 5v5" />,
    roll: <><path d="M12.5 6.5A5 5 0 1 0 13 10" /><path d="M13 3v3.5H9.5" /></>,
    level: <><path d="M8 2v12" /><path d="M5 5l3-3 3 3M5 11l3 3 3-3" /></>,
    offset: <><path d="M2 8h12" /><path d="M5 5L2 8l3 3M11 5l3 3-3 3" /></>,
    length: <><path d="M2 8h12" /><path d="M2 5v6M14 5v6" /></>,
    insulation: <><circle cx="8" cy="8" r="2" /><circle cx="8" cy="8" r="5.5" strokeDasharray="2 1.5" /></>,
    hard: <path d="M2 6h12M2 10h12" />,
    flexible: <path d="M2 8c2-3 4 3 6 0s4-3 6 0" />,
    'add-point': <><path d="M2 8h12" /><path d="M8 5v6" strokeWidth={2} /></>,
    'remove-bend': <><path d="M2 5h4a5 5 0 0 1 5 5v4" /><path d="M10 3h4" strokeWidth={2} /></>,
    slide: <><path d="M5 8h9M11 5l3 3-3 3" /><path d="M2 5v6" strokeWidth={2} /></>,
    flip: <><path d="M2 8h12" strokeDasharray="1.5 1.5" /><path d="M4 6.5l4-3.5 4 3.5M4 9.5l4 3.5 4-3.5" /></>,
    kit: <><path d="M1.5 8h5" /><path d="M6.5 8l7-4.5M6.5 8l7 4.5" /></>,
  };
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[glyph]}
    </svg>
  );
}

/** What an option does, as chips: its change in length and charge, and the checks it would newly fail. */
function DeltaChips({ evaluation }: { evaluation: RefrigerantOptionEvaluation }) {
  const chips: ReactNode[] = [];
  if (Math.abs(evaluation.deltaLengthMm) >= 5) {
    chips.push(<span key="m" className={`rounded px-1 tabular-nums ${evaluation.deltaLengthMm < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
      title="Change in tube length">{signed(evaluation.deltaLengthMm / 1000, 2)} m</span>);
  }
  if (evaluation.deltaChargeKg !== null && Math.abs(evaluation.deltaChargeKg) >= 0.005) {
    chips.push(<span key="kg" className="rounded bg-slate-100 px-1 tabular-nums text-slate-600"
      title="Change in the additional refrigerant charge (practice table, unverified)">{signed(evaluation.deltaChargeKg, 2)} kg</span>);
  }
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error');
  if (errors.length) {
    chips.push(
      <span key="err" className="inline-flex items-center gap-0.5 rounded bg-red-50 px-1 font-medium text-red-700" title={errors.map((issue) => `${issue.code}: ${issue.message}`).join('\n')}>
        <TriangleAlert size={10} aria-hidden="true" />{errors.length}<span className="sr-only"> new error{errors.length === 1 ? '' : 's'}</span>
      </span>,
    );
  }
  return chips.length ? <span className="flex shrink-0 items-center gap-1 text-[10.5px]">{chips}</span> : null;
}

/** An option's whole result on one line. */
function ResultLine({ evaluation }: { evaluation: RefrigerantOptionEvaluation }) {
  if (evaluation.refused) return <span className="text-red-700">{evaluation.refused}</span>;
  const parts: ReactNode[] = [];
  if (Math.abs(evaluation.deltaLengthMm) >= 1) parts.push(<span key="m" className={evaluation.deltaLengthMm < 0 ? 'text-emerald-700' : 'text-amber-700'}>{signed(evaluation.deltaLengthMm / 1000, 2)} m</span>);
  if (evaluation.deltaChargeKg !== null && Math.abs(evaluation.deltaChargeKg) >= 0.005) parts.push(<span key="kg">{signed(evaluation.deltaChargeKg, 2)} kg charge</span>);
  const errors = evaluation.newIssues.filter((issue) => issue.severity === 'error').length;
  const warnings = evaluation.newIssues.length - errors;
  if (errors) parts.push(<span key="e" className="font-medium text-red-700">{errors} new error{errors === 1 ? '' : 's'}</span>);
  if (warnings) parts.push(<span key="w" className="text-amber-700">{warnings} new warning{warnings === 1 ? '' : 's'}</span>);
  if (!parts.length) parts.push(<span key="ok" className="text-emerald-700">no new issues</span>);
  return <span className="tabular-nums">{parts.map((part, index) => <span key={index}>{index ? ' · ' : ''}{part}</span>)}</span>;
}

const resultLine = (evaluation: RefrigerantOptionEvaluation) => <ResultLine evaluation={evaluation} />;
const ValueField = SegmentValueField<RefrigerantSegmentOption, RefrigerantOptionEvaluation>;
type FieldHost = SegmentFieldHost<RefrigerantSegmentOption, RefrigerantOptionEvaluation>;

/** A straight's length, its start or its end held. */
function LengthField({ host, element, piece, partner }: { host: FieldHost; element: HvacElement; piece: RefrigerantPiece; partner: RefrigerantPartner | null }) {
  const [keep, setKeep] = useState<'start' | 'end'>('start');
  const current = Math.round(piece.lengthMm);
  return (
    <ValueField host={host} label="Length" unit="mm" current={current} min={20} max={100000} step={50} fineStep={10} testId="refrigerant-segment-length"
      hint={`its ${keep} held; the bends either side follow${partner ? ' · both lines of the pair' : ''}`}
      extra={(
        <span className="ml-auto inline-flex rounded-md bg-slate-100 p-0.5" role="radiogroup" aria-label="Held end">
          {(['start', 'end'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={keep === value} title={`Keep its ${value} where it is`}
              className={`rounded px-1.5 text-[10.5px] font-medium ${keep === value ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              onClick={() => setKeep(value)}>{value === 'start' ? 'Start' : 'End'}</button>
          ))}
        </span>
      )}
      makeOption={(value) => refrigerantValueOption(element, piece, partner, { kind: 'length', deltaMm: value - current, keep })} />
  );
}

/** The Edit tab: a straight's level, sideways offset and length; the line's insulation. */
function EditPanel({ host, element, piece, partner, options }: {
  host: FieldHost;
  element: HvacElement;
  piece: RefrigerantPiece;
  partner: RefrigerantPartner | null;
  options: readonly RefrigerantSegmentOption[];
}): ReactNode {
  const chipRow = (group: RefrigerantSegmentOption['group']) => (
    <ChipRow options={options.filter((option) => option.group === group)} evaluations={host.evaluations} onHover={host.onHover} onApply={host.onApply} />
  );
  const both = partner ? ' · both lines of the pair move' : '';
  const blocks: ReactNode[] = [];
  if (piece.kind === 'straight' && piece.legId) {
    const level = Math.round(piece.path.reduce((sum, point) => sum + point.z, 0) / piece.path.length);
    blocks.push(
      <EditBlock key="level" title="Level">
        <div className="px-1">{chipRow('level')}</div>
        <ValueField host={host} label="Centreline" unit="mm" current={level} min={0} max={30000} step={50} fineStep={10} testId="refrigerant-segment-level"
          hint={`risers and offsets are re-made at its ends${both}`}
          makeOption={(value) => refrigerantValueOption(element, piece, partner, { kind: 'level', deltaMm: value - level })} />
      </EditBlock>,
    );
    const from = piece.path[0]!;
    const to = piece.path[piece.path.length - 1]!;
    const run = Math.hypot(to.x - from.x, to.y - from.y);
    if (run > 1) {
      const across = { x: -(to.y - from.y) / run, y: (to.x - from.x) / run, z: 0 };
      const plus = screenWay(across);
      blocks.push(
        <EditBlock key="offset" title="Sideways">
          <div className="px-1">{chipRow('offset')}</div>
          <ValueField host={host} label="Shift" unit="mm" current={0} min={-10000} max={10000} step={50} fineStep={10} signed testId="refrigerant-segment-offset"
            hint={`+ moves it ${plus.words}${both}`}
            makeOption={(value) => (value === 0 ? null : refrigerantValueOption(element, piece, partner, {
              kind: 'offset', offset: { x: across.x * value, y: across.y * value, z: 0 },
              label: `${screenWay({ x: across.x * Math.sign(value), y: across.y * Math.sign(value) }).arrow} ${Math.abs(value)}`,
            }))} />
        </EditBlock>,
      );
    }
  }
  if ((piece.kind === 'straight' || piece.kind === 'riser') && piece.legId) {
    blocks.push(<EditBlock key="length" title="Length"><LengthField host={host} element={element} piece={piece} partner={partner} /></EditBlock>);
  }
  blocks.push(
    <EditBlock key="insulation" title="Insulation">
      <div className="px-1">{chipRow('insulation')}</div>
    </EditBlock>,
  );
  return <div className="space-y-2" data-testid="refrigerant-segment-edit-panel">{blocks}</div>;
}

/** The kit's Edit tab: slid along its run (a pair's two kits together), by a chip or a distance of your own. */
function KitEditPanel({ host, element, options }: { host: FieldHost; element: HvacElement; options: readonly RefrigerantSegmentOption[] }): ReactNode {
  const slides = options.filter((option) => option.group === 'kit-slide');
  const axis = kitRunAxis(element);
  if (!axis || !slides.length) return null;
  const first = slides[0]!;
  const kitIds = first.edit.kind === 'kit-slide' ? first.edit.kitIds : [element.id];
  const plus = screenWay(axis);
  return (
    <div className="space-y-2" data-testid="refrigerant-segment-edit-panel">
      <EditBlock title="Along its run">
        <div className="px-1"><ChipRow options={slides} evaluations={host.evaluations} onHover={host.onHover} onApply={host.onApply} /></div>
        <ValueField host={host} label="Slide" unit="mm" current={0} min={-5000} max={5000} step={50} fineStep={10} signed testId="refrigerant-segment-kit-slide"
          hint={`+ moves it ${plus.words}, towards its outlets; its pipes follow${kitIds.length > 1 ? ' · both kits of the pair' : ''}`}
          makeOption={(value) => (value === 0 ? null : refrigerantKitSlideOption(kitIds, axis, value, true))} />
      </EditBlock>
    </div>
  );
}

/** How a kit sits: level, turned over (its branch the other way), or rolled. */
const rollText = (rollDeg: number) => {
  const roll = ((rollDeg % 360) + 360) % 360;
  return roll < 0.5 || roll > 359.5 ? 'level split' : Math.abs(roll - 180) < 0.5 ? 'branch turned over' : `rolled ${number(roll)}°`;
};

/** A kit in one strip: the capacity it carries on, the indoor units it serves, and the profile's word on its model. */
function KitFigures({ circuit }: { circuit: RefrigerantCircuitFigures | null }) {
  if (!circuit) return <p className="px-3 pb-2 text-[11px] text-slate-400" data-testid="refrigerant-segment-figures">Not on an outdoor unit&apos;s circuit yet</p>;
  const recommendation = circuit.recommendation;
  const status = recommendation?.status === 'matches' ? 'ok' : recommendation?.status === 'change-recommended' ? 'near' : null;
  return (
    <div className="flex items-center gap-x-3 px-3 pb-2" data-testid="refrigerant-segment-figures">
      {circuit.downstreamCapacityIndex !== null
        ? stat(number(circuit.downstreamCapacityIndex), 'CI', 'Capacity index of the indoor units downstream')
        : stat('—', 'CI', 'The indoor units downstream have no capacity index')}
      {stat(String(circuit.indoorUnitIds.length), circuit.indoorUnitIds.length === 1 ? 'unit' : 'units', 'Indoor units it serves')}
      <span className="ml-auto">
        {stat(recommendation?.recommendedModel ?? (recommendation?.status === 'matches' ? 'matches' : 'no kit table'), '',
          recommendation?.note ?? 'The profile has no branch-kit table for it', status)}
      </span>
    </div>
  );
}

function KitInfo({ kit, circuit }: { kit: RefrigerantKit; circuit: RefrigerantCircuitFigures | null }) {
  return (
    <>
      <div>{kit.model} · splits the {kit.lines.length > 1 ? 'gas and the liquid lines' : `${kit.lines[0]} line`} · {rollText(kit.rollDeg)} · centre at {number(kit.levelMm)} mm</div>
      {circuit ? (
        <div>On {circuit.outdoorLabel}&apos;s circuit · {circuit.indoorUnitIds.length} indoor unit{circuit.indoorUnitIds.length === 1 ? '' : 's'} downstream{circuit.downstreamCapacityIndex !== null ? ` · capacity index ${number(circuit.downstreamCapacityIndex)}` : ''}</div>
      ) : <div>Not on an outdoor unit&apos;s circuit yet.</div>}
      {circuit?.recommendation ? <div>{circuit.recommendation.note}{circuit.recommendation.recommendedModel ? ` (profile: ${circuit.recommendation.recommendedModel})` : ''} ({circuit.profileVerified ? 'verified profile' : 'unverified profile'})</div> : null}
    </>
  );
}

/** A branch kit's card: what it is and splits, the circuit it is on, the checks that name it. */
function buildKitModel(scene: HvacElement[], element: HvacElement, context: RefrigerantCardContext): RefrigerantCardModel | null {
  const kit = refrigerantKitOf(element);
  if (!kit) return null;
  const profile = context.profile ?? PROJECT_FALLBACK_RULE_PROFILE;
  const circuit = kit.lines.map((line) => refrigerantCircuitFigures(scene, element, line, profile)).find((figures) => figures) ?? null;
  const options = refrigerantKitOptions(scene, element, profile);
  const issues: SegmentIssueLine[] = context.report.issues.flatMap((issue) => (
    issue.entityId && (issue.entityId === element.id || issue.entityId.startsWith(`${element.id}:`)) && (issue.level === 'error' || issue.level === 'warning')
      ? [{ severity: issue.level, code: issue.code, message: issue.message }] : []));
  // A short tag: the kit's number among the kits on its line, in drawing order (G-Y1, L-Y2, Y1 for a pair kit).
  const line = kit.lines.length > 1 ? null : kit.lines[0]!;
  const sameLine = scene.filter((candidate) => {
    const other = candidate.type === 'refrigerant-branch-kit' ? refrigerantKitOf(candidate) : null;
    return other && (line ? other.lines.length === 1 && other.lines[0] === line : other.lines.length > 1);
  });
  const ordinal = sameLine.findIndex((candidate) => candidate.id === element.id) + 1;
  return {
    head: {
      // The model without the line it was named for (the size line says it).
      title: `Branch kit · ${kit.model.replace(/\s+(gas|liquid)$/i, '')}`,
      size: kit.lines.length > 1 ? 'Gas + liquid' : kit.lines[0] === 'gas' ? 'Gas line' : 'Liquid line',
      detail: rollText(kit.rollDeg),
      tag: `${line === 'gas' ? 'G-' : line === 'liquid' ? 'L-' : ''}Y${Math.max(1, ordinal)}`,
      glyph: <PipeSegmentGlyph kind="kit" className="h-3.5 w-3.5" />,
      tone: 'bg-amber-50 text-amber-700',
      kind: 'kit',
    },
    figures: <KitFigures circuit={circuit} />,
    info: <KitInfo kit={kit} circuit={circuit} />,
    issues,
    options,
    evaluate: (option) => evaluateRefrigerantOption(scene, option, profile),
    tabOf: (option) => (SWAP_GROUPS.has(option.group) ? 'swap' : null),
    edit: (host) => KitEditPanel({ host, element, options }),
    neighbour: () => null,
    rekeyToken: null,
  };
}

function buildModel(scene: HvacElement[], focus: SegmentFocus, context: RefrigerantCardContext): RefrigerantCardModel | null {
  const element = scene.find((candidate) => candidate.id === focus.runId);
  if (element && focus.key === KIT_KEY) return buildKitModel(scene, element, context);
  const line = element ? refrigerantLineOf(element, scene) : null;
  const piece = line ? refrigerantPieceOf(line, focus.key) : null;
  if (!element || !line || !piece) return null;
  const figures = refrigerantPieceFigures(scene, element, line, piece, context.profile ?? PROJECT_FALLBACK_RULE_PROFILE);
  const partnerElement = partnerOf(element, scene);
  const partnerLine = partnerElement ? refrigerantLineOf(partnerElement, scene) : null;
  const partnerPiece = partnerLine ? matchingPiece(partnerLine, piece) : null;
  const partner = partnerElement && partnerPiece ? { id: partnerElement.id, key: partnerPiece.key } : null;
  const pairPiece: RefrigerantPartner | null = partnerElement && partnerLine && partnerPiece ? { element: partnerElement, line: partnerLine, piece: partnerPiece } : null;
  const profile = context.profile ?? PROJECT_FALLBACK_RULE_PROFILE;
  const options = refrigerantPieceOptions(scene, element, line, piece, pairPiece, profile);
  const titleBits = piece.kind === 'port' ? `${KIND_TITLES.port}` : `${KIND_TITLES[piece.kind]} ${piece.ordinal}`;
  const detail = figures.bend
    ? `${number(figures.bend.angleDeg)}° ${figures.bend.construction === 'socket-elbow' ? `socket elbow${figures.bend.catalogueModel ? ` ${figures.bend.catalogueModel}` : ''}` : 'formed bend'}`
    : figures.port ? figures.port.label
      : piece.kind === 'riser' ? `${figures.riseMm >= 0 ? 'up' : 'down'} ${number(Math.abs(figures.riseMm))} mm` : metres(figures.lengthMm);
  const token: RekeyToken = { kind: piece.kind, ordinal: piece.ordinal };
  return {
    head: {
      title: `${LINE_NAME[line.lineKind]} · ${titleBits}`,
      size: `Ø${number(line.tubeOdMm, 2)}${figures.inch ? ` (${figures.inch})` : ''}`,
      detail,
      tag: `${line.lineKind === 'liquid' ? 'L' : 'G'}-${KIND_TAGS[piece.kind]}${piece.kind === 'port' ? (piece.endpoint === 'start' ? '1' : '2') : piece.ordinal}`,
      glyph: <PipeSegmentGlyph kind={piece.kind} className="h-3.5 w-3.5" />,
      tone: LINE_TONE[line.lineKind],
      kind: piece.kind,
    },
    figures: <FigureStrip figures={figures} piece={piece} focus={focus} partner={partner} />,
    info: <BuildInfo figures={figures} piece={piece} line={line} />,
    issues: pieceIssues(context.report, element, line, piece),
    options,
    evaluate: (option) => evaluateRefrigerantOption(scene, option, profile),
    tabOf: (option) => (SWAP_GROUPS.has(option.group) ? 'swap' : ADD_GROUPS.has(option.group) ? 'add' : null),
    edit: (host) => EditPanel({ host, element, piece, partner: pairPiece, options }),
    neighbour: (direction) => {
      const next = neighbourPiece(line, piece.key, direction);
      return next ? { key: next.key, anchorMark: null } : null;
    },
    rekeyToken: token,
  };
}

/** A line's pieces as its inspector lists them: the card's own tags and names, a length or an angle. */
export function refrigerantPieceRows(element: HvacElement, scene: readonly HvacElement[]): SegmentPieceRow[] {
  const line = refrigerantLineOf(element, scene);
  if (!line) return [];
  const prefix = line.lineKind === 'liquid' ? 'L' : line.lineKind === 'pair' ? 'P' : 'G';
  return line.pieces.map((piece) => ({
    key: piece.key,
    tag: `${prefix}-${KIND_TAGS[piece.kind]}${piece.kind === 'port' ? (piece.endpoint === 'start' ? '1' : '2') : piece.ordinal}`,
    title: piece.kind === 'port' ? `${KIND_TITLES.port} · ${piece.endpoint === 'start' ? 'start' : 'end'}` : `${KIND_TITLES[piece.kind]} ${piece.ordinal}`,
    detail: piece.kind === 'bend' && piece.angleDeg !== null ? `${number(piece.angleDeg)}°` : metres(piece.lengthMm),
  }));
}

/** The refrigerant lines' segment cards, read with the active rule profile and the live design checks. */
export function createRefrigerantSegmentProvider(context: RefrigerantCardContext): RefrigerantSegmentProvider {
  const cache = new WeakMap<readonly HvacElement[], Map<string, RefrigerantCardModel | null>>();
  return {
    domain: 'refrigerant',
    testIdPrefix: 'refrigerant-segment',
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
    // The size the profile (or the unit's port) asks for is the recommended one.
    rank: (options) => new Map(options.flatMap((option) => (option.group === 'size' && !option.current && /profile's size|port size/.test(option.detail)
      ? [[option.id, ['recommended']] as [string, string[]]] : []))),
    badges: BADGES,
    recommendedBadge: 'recommended',
    optionGlyph: (option) => <OptionGlyph glyph={option.glyph} className="h-3.5 w-3.5" />,
    chips: (evaluation) => <DeltaChips evaluation={evaluation} />,
    result: resultLine,
    // A peek's quick picks after the recommended one: the least tube first.
    quickScore: (evaluation) => evaluation.deltaLengthMm,
    commit: (evaluation, option) => {
      if (!evaluation.updates.length) return;
      useSmartDrawingStore.getState().commitHvacElementCommand(evaluation.action || option.title, {
        updates: evaluation.updates.map((element) => ({
          id: element.id,
          updates: {
            position: element.position, rotation: element.rotation, width: element.width, depth: element.depth,
            height: element.height, elevation: element.elevation, properties: element.properties,
          },
        })),
      });
    },
    rekey: (scene, focus, token) => {
      const element = scene.find((candidate) => candidate.id === focus.runId);
      if (focus.key === KIT_KEY) return element && refrigerantKitOf(element) ? focus : null;
      const line = element ? refrigerantLineOf(element, scene) : null;
      if (!line) return null;
      if (refrigerantPieceOf(line, focus.key)) return focus;
      const wanted = token as RekeyToken | null;
      const same = wanted ? line.pieces.find((piece) => piece.kind === wanted.kind && piece.ordinal === wanted.ordinal) : null;
      return same ? { ...focus, key: same.key, anchorMark: null } : null;
    },
  };
}
