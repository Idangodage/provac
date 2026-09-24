'use client';

/**
 * Inspector rows for condensate drainage: a unit's drain data, a gully /
 * termination, and a generated condensate pipe. Each edit is one store
 * update (one history entry).
 */
import type React from 'react';

import type { HvacElement } from '../../../../types';

import { getCondensatePipeSystem } from './condensatePipeCatalog';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { formatFallRatio, type CondensateDesignSettings } from './condensateSettings';
import {
  defaultInletElevationMm,
  defaultTerminalTrap,
  getCondensateOwnership,
  readCondensateGullySpec,
  readCondensatePipeSpec,
  type CondensateTerminalTrap,
  type CondensateTerminationKind,
} from './condensateTypes';

const INPUT = 'w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400';
const SELECT = 'w-40 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400';

function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-2 border-b border-amber-100/70 last:border-0" title={title}>
      <span className="text-sm text-slate-600">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <p className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-sky-800">{children}</p>;
}

function NumberInput({ value, onCommit, step = 1, min, unit, ariaLabel }: {
  value: number | null;
  onCommit: (value: number | null) => void;
  step?: number;
  min?: number;
  unit?: string;
  ariaLabel: string;
}) {
  return (
    <>
      <input
        type="number"
        step={step}
        min={min}
        aria-label={ariaLabel}
        value={value === null || !Number.isFinite(value) ? '' : Math.round(value * 100) / 100}
        onChange={(event) => {
          if (event.target.value.trim() === '') { onCommit(null); return; }
          const parsed = Number.parseFloat(event.target.value);
          if (Number.isFinite(parsed)) onCommit(min === undefined ? parsed : Math.max(min, parsed));
        }}
        className={INPUT}
      />
      {unit ? <span className="text-xs text-slate-500">{unit}</span> : null}
    </>
  );
}

type UpdateProperties = (properties: Record<string, unknown>) => void;

/** Drain rows appended to an indoor unit's inspector. */
export function UnitDrainageRows({ element, settings, onUpdateProperties }: {
  element: HvacElement;
  settings: CondensateDesignSettings;
  onUpdateProperties: UpdateProperties;
}) {
  const port = getIndoorUnitDrainPort(element, settings);
  if (!port) return null;
  const pumpSetting = element.properties.hasDrainPump;
  const negativeSetting = element.properties.drainNegativePressure;
  return (
    <>
      <Heading>Condensate drain</Heading>
      <Row label="Drain outlet" title={port.synthesized ? 'This unit type has no drawn drain port; a typical manufacturer position is assumed.' : undefined}>
        <span className="text-sm text-slate-700">
          Ø {port.outletOuterDiameterMm.toFixed(0)} mm @ {Math.round(port.z)} mm{port.synthesized ? ' (typical)' : ''}
        </span>
      </Row>
      <Row label="Drain pump">
        <select
          aria-label="Drain pump"
          value={typeof pumpSetting === 'boolean' ? (pumpSetting ? 'yes' : 'no') : 'auto'}
          onChange={(event) => onUpdateProperties({
            hasDrainPump: event.target.value === 'auto' ? undefined : event.target.value === 'yes',
          })}
          className={SELECT}
        >
          <option value="auto">Type default ({element.type === 'ceiling-cassette-ac' ? 'pump' : 'gravity'})</option>
          <option value="yes">Built-in pump</option>
          <option value="no">Gravity only</option>
        </select>
      </Row>
      {port.hasDrainPump ? (
        <Row label="Max pump lift" title="Maximum drain-raising height from the unit manual (Daikin FXDQ 600 mm, FXFQ 675 mm).">
          <NumberInput
            ariaLabel="Maximum drain pump lift"
            value={typeof element.properties.drainPumpMaxLiftMm === 'number' ? element.properties.drainPumpMaxLiftMm : null}
            min={0}
            step={25}
            unit={`mm (default ${settings.defaultPumpMaxLiftMm})`}
            onCommit={(value) => onUpdateProperties({ drainPumpMaxLiftMm: value ?? undefined })}
          />
        </Row>
      ) : null}
      <Row label="Drain pan pressure" title="Draw-through fans hold the drain pan below atmospheric pressure; a gravity drain then needs a P-trap.">
        <select
          aria-label="Drain pan pressure"
          value={typeof negativeSetting === 'boolean' ? (negativeSetting ? 'negative' : 'positive') : 'auto'}
          onChange={(event) => onUpdateProperties({
            drainNegativePressure: event.target.value === 'auto' ? undefined : event.target.value === 'negative',
          })}
          className={SELECT}
        >
          <option value="auto">Auto ({port.negativePressure ? 'negative' : 'neutral'})</option>
          <option value="negative">Negative (trap)</option>
          <option value="positive">Neutral / positive</option>
        </select>
      </Row>
    </>
  );
}

const TERMINATION_LABELS: Record<CondensateTerminationKind, string> = {
  'floor-gully': 'Floor gully / drain',
  'stack-connection': 'Waste stack connection',
  'external-discharge': 'External wall discharge',
};

const TRAP_LABELS: Record<CondensateTerminalTrap, string> = {
  tundish: 'Tundish (air break)',
  hepvo: 'Waterless valve (HepVO)',
  'p-trap': 'P-trap',
  none: 'None (open discharge)',
};

export function CondensateGullyInspector({ element, onUpdate }: {
  element: HvacElement;
  onUpdate: (updates: Partial<HvacElement>) => void;
}) {
  const spec = readCondensateGullySpec(element);
  const updateProperties = (properties: Record<string, unknown>) => onUpdate({ properties });
  return (
    <>
      <Heading>Condensate termination</Heading>
      <Row label="Kind">
        <select
          aria-label="Termination kind"
          value={spec.terminationKind}
          onChange={(event) => {
            const kind = event.target.value as CondensateTerminationKind;
            updateProperties({
              terminationKind: kind,
              inletElevationMm: defaultInletElevationMm(kind),
              terminalTrap: defaultTerminalTrap(kind),
            });
          }}
          className={SELECT}
        >
          {(Object.keys(TERMINATION_LABELS) as CondensateTerminationKind[]).map((kind) => (
            <option key={kind} value={kind}>{TERMINATION_LABELS[kind]}</option>
          ))}
        </select>
      </Row>
      <Row
        label={spec.terminationKind === 'floor-gully' ? 'Gully rim level' : spec.terminationKind === 'stack-connection' ? 'Stack branch level' : 'Penetration level'}
        title="Centreline / rim level above finished floor."
      >
        <NumberInput ariaLabel="Termination level" value={spec.inletElevationMm} min={0} step={10} unit="mm"
          onCommit={(value) => updateProperties({ inletElevationMm: value ?? defaultInletElevationMm(spec.terminationKind) })} />
      </Row>
      <Row label="Discharge fitting">
        <select
          aria-label="Discharge fitting"
          value={spec.terminalTrap}
          onChange={(event) => updateProperties({ terminalTrap: event.target.value })}
          className={SELECT}
        >
          {(Object.keys(TRAP_LABELS) as CondensateTerminalTrap[]).map((trap) => (
            <option key={trap} value={trap}>{TRAP_LABELS[trap]}</option>
          ))}
        </select>
      </Row>
      {spec.terminationKind === 'floor-gully' ? (
        <Row label="Air break" title="Visible air gap between the drop and the receptor flood rim (indirect discharge).">
          <NumberInput ariaLabel="Air break" value={spec.airBreakMm} min={0} step={5} unit="mm"
            onCommit={(value) => updateProperties({ airBreakMm: value ?? 25 })} />
        </Row>
      ) : null}
      <Row label="Capacity limit" title="Optional: the generator will not connect more cooling capacity than this.">
        <NumberInput ariaLabel="Connected capacity limit" value={spec.maxConnectedCapacityKw} min={0} step={1} unit="kW"
          onCommit={(value) => updateProperties({ maxConnectedCapacityKw: value && value > 0 ? value : undefined })} />
      </Row>
    </>
  );
}

export function CondensatePipeInspector({ element, onUpdate }: {
  element: HvacElement;
  onUpdate: (updates: Partial<HvacElement>) => void;
}) {
  const spec = readCondensatePipeSpec(element);
  const nodes = spec.routeNodes3d;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  let horizontal = 0;
  let minSlope = Number.POSITIVE_INFINITY;
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const run = Math.hypot(b.x - a.x, b.y - a.y);
    horizontal += run;
    if (run > 50) minSlope = Math.min(minSlope, ((a.z - b.z) / run) * 100);
  }
  const fall = first && last ? first.z - last.z : 0;
  const system = getCondensatePipeSystem(spec.pipeSystem);
  const owner = getCondensateOwnership(element);
  const invert = (z: number) => Math.round(z - spec.innerDiameterMm / 2);
  return (
    <div className="space-y-1">
      <Heading>Condensate pipe</Heading>
      <Row label="Role">
        <span className="text-sm text-slate-700">{spec.segmentRole.replace('-', ' ')}</span>
      </Row>
      <Row label="Pipe">
        <span className="text-sm text-slate-700">{system.label} {spec.nominalSize} (Ø{spec.outerDiameterMm} / {spec.innerDiameterMm} mm)</span>
      </Row>
      <Row label="Insulation">
        <span className="text-sm text-slate-700">{spec.insulationThicknessMm > 0 ? `${spec.insulationThicknessMm} mm closed-cell` : 'None'}</span>
      </Row>
      <Row label="Design fall">
        <span className="text-sm text-slate-700">
          {spec.designSlopePercent.toFixed(2)} % ({formatFallRatio(spec.designSlopePercent)})
          {Number.isFinite(minSlope) ? ` · min ${minSlope.toFixed(2)} %` : ''}
        </span>
      </Row>
      <Row label="Run / fall">
        <span className="text-sm text-slate-700">{(horizontal / 1000).toFixed(2)} m / {Math.round(fall)} mm</span>
      </Row>
      {first && last ? (
        <Row label="Invert level" title="Invert = pipe bottom inside (centreline − ID/2), mm above FFL.">
          <span className="text-sm text-slate-700">IL {invert(first.z)} → {invert(last.z)} mm</span>
        </Row>
      ) : null}
      <Row label="Serves">
        <span className="text-sm text-slate-700">{spec.upstreamUnitIds.length} unit{spec.upstreamUnitIds.length === 1 ? '' : 's'} · {spec.upstreamCapacityKw.toFixed(1)} kW</span>
      </Row>
      {spec.fittings.length ? (
        <Row label="Fittings">
          <span className="max-w-[12rem] text-right text-xs text-slate-600">
            {Object.entries(spec.fittings.reduce<Record<string, number>>((counts, fitting) => {
              counts[fitting.kind] = (counts[fitting.kind] ?? 0) + 1;
              return counts;
            }, {})).map(([kind, count]) => `${count}× ${kind}`).join(', ')}
          </span>
        </Row>
      ) : null}
      <Row label="Regeneration" title="Locked or hand-edited generated pipes are kept when the network is regenerated.">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={spec.locked}
            onChange={(event) => onUpdate({ properties: { locked: event.target.checked } })}
          />
          Lock this pipe
        </label>
      </Row>
      {owner ? (
        <p className="pt-1 text-[11px] leading-4 text-slate-400">Generated network {owner.networkId.slice(0, 8)} · {owner.unitIds.length} units{owner.editPolicy === 'retain' ? ' · edited (kept on regenerate)' : ''}</p>
      ) : null}
    </div>
  );
}
