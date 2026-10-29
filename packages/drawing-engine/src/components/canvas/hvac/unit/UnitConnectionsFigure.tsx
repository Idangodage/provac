'use client';

/**
 * A unit's connection end as the installer meets it (27 October 2026): the
 * end face to scale, seen from outside, with its gas, liquid and drain where
 * the maker puts them, and the drain the field pipe joins — the pump's outlet
 * or the gravity outlet. Under it, one line per connection: size, joint and
 * how high it is above the underside.
 */
import type { HvacElement } from '../../../../types';
import { drainConnectionOf, MAKER_DRAIN_FIELD_OUTER_DIAMETER_MM, unitConnectionOf, unitConnectionsFor, type UnitConnection } from '../unitConnections';
import { unitHasDrainPump } from '../unitDrainPump';
import { inchFractionText, type HvacUnitSystem } from '../units/hvacUnits';
import { useHvacUnits } from '../units/useHvacUnits';

import { Chip } from './unitPanelKit';

const W = 290;
const H = 112;
const PAD_X = 24;
const PAD_TOP = 10;
const PAD_BOTTOM = 16;
const MARK_MIN_RADIUS = 7.5;

export const CONNECTION_COLOURS = { gas: '#4088b3', liquid: '#bc863f', drain: '#0f8a6a' } as const;

export type ConnectionService = keyof typeof CONNECTION_COLOURS;

const JOINT_TEXT: Record<UnitConnection['joint'], string> = {
  flare: 'flare', brazed: 'brazed', hose: 'hose end', socket: 'socket',
};

export interface ConnectionFaceLayout {
  /** The end face (casing where the maker data has one), in figure coordinates. */
  face: { x: number; y: number; width: number; height: number };
  /** The underside line. */
  baseY: number;
  marks: Array<{ service: ConnectionService; letter: string; cx: number; cy: number; r: number }>;
  rows: Array<{ service: ConnectionService; text: string; pumpOutlet: boolean }>;
  source: string;
}

/**
 * The connection end of a unit with maker data, laid out for the figure, or
 * null. Seen from outside: across the face runs −y on a +x end, +y on a −x end.
 */
export function connectionFaceLayout(
  unit: HvacElement,
  display: { system: HvacUnitSystem; height: (mm: number) => string },
): ConnectionFaceLayout | null {
  const set = unitConnectionsFor(unit);
  if (!set) return null;
  const pumped = unitHasDrainPump(unit);
  const shown = ([
    ['gas', 'G', unitConnectionOf(set, 'gas')],
    ['liquid', 'L', unitConnectionOf(set, 'liquid')],
    ['drain', 'D', drainConnectionOf(set, pumped)],
  ] as const).flatMap(([service, letter, connection]) => (connection ? [{ service, letter, connection }] : []));
  if (!shown.length) return null;
  const axis = shown[0]!.connection.axis;
  const across = (y: number) => -axis * y;
  const faceDepth = set.casing?.depth ?? unit.depth;
  const faceCentre = across(set.casing?.centre.y ?? 0);
  const scale = Math.min((W - 2 * PAD_X) / faceDepth, (H - PAD_TOP - PAD_BOTTOM) / unit.height);
  const baseY = H - PAD_BOTTOM;
  const sx = (h: number) => W / 2 + (h - faceCentre) * scale;
  const sy = (z: number) => baseY - z * scale;
  const diameter = (service: ConnectionService, connection: UnitConnection) =>
    (service === 'drain' ? MAKER_DRAIN_FIELD_OUTER_DIAMETER_MM : connection.outerDiameterMm);
  const size = (service: ConnectionService, connection: UnitConnection) => {
    if (service === 'drain') return 'VP25';
    const mm = connection.outerDiameterMm;
    return display.system === 'ip' ? `${inchFractionText(mm)} in` : `Ø${Math.round(mm * 100) / 100}`;
  };
  return {
    face: { x: sx(faceCentre - faceDepth / 2), y: sy(unit.height), width: faceDepth * scale, height: unit.height * scale },
    baseY,
    marks: shown.map(({ service, letter, connection }) => ({
      service, letter, cx: sx(across(connection.y)), cy: sy(connection.z),
      // Big enough to carry its letter; the true size where that is larger.
      r: Math.max(MARK_MIN_RADIUS, (diameter(service, connection) / 2) * scale),
    })),
    rows: shown.map(({ service, connection }) => ({
      service,
      text: `${size(service, connection)} · ${JOINT_TEXT[connection.joint]} · ${display.height(connection.z)}`,
      pumpOutlet: service === 'drain' && pumped && connection.kind === 'drain',
    })),
    source: `${set.source === 'maker-3d' ? "From the maker's 3D model" : 'From the maker drawing'} · ${set.reference}`,
  };
}

export function UnitConnectionsFigure({ unit }: { unit: HvacElement }) {
  const units = useHvacUnits();
  const layout = connectionFaceLayout(unit, { system: units.system, height: (mm) => `${units.fmt('size', mm)} up` });
  if (!layout) return null;
  const { face, baseY, marks, rows, source } = layout;
  return (
    <div data-testid="unit-connections-figure" className="mb-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img"
        aria-label={`Connection end, seen from outside: ${rows.map((row) => `${row.service} ${row.text}`).join('; ')}`}>
        <rect x={face.x} y={face.y} width={face.width} height={face.height} rx={4} fill="#f1f5f9" stroke="#94a3b8" strokeWidth={1} />
        <line x1={PAD_X / 2} x2={W - PAD_X / 2} y1={baseY} y2={baseY} stroke="#cbd5e1" strokeDasharray="3 3" />
        <text x={W - PAD_X / 2} y={baseY + 11} textAnchor="end" className="fill-slate-400" fontSize={8}>underside</text>
        {marks.map((mark) => (
          <g key={mark.service}>
            <line x1={mark.cx} x2={mark.cx} y1={mark.cy + mark.r} y2={baseY} stroke={CONNECTION_COLOURS[mark.service]} strokeOpacity={0.35} strokeDasharray="2 2" />
            <circle cx={mark.cx} cy={mark.cy} r={mark.r} fill={CONNECTION_COLOURS[mark.service]} fillOpacity={0.9} stroke="#fff" strokeWidth={1} />
            <text x={mark.cx} y={mark.cy + 3.2} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff">{mark.letter}</text>
          </g>
        ))}
      </svg>
      <ul className="mt-1 space-y-0.5 text-[10.5px] text-slate-600">
        {rows.map((row) => (
          <li key={row.service} className="flex items-center gap-1.5" data-testid={`unit-connection-${row.service}`}>
            <i className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: CONNECTION_COLOURS[row.service] }} />
            <span className="w-9 capitalize text-slate-500">{row.service}</span>
            <span className="tabular-nums">{row.text}</span>
            {row.pumpOutlet ? <Chip tone="sky">pump outlet</Chip> : null}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-slate-400">{source}</p>
    </div>
  );
}
