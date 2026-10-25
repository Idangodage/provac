'use client';

/** SI | IP for the air side's figures: the document's choice (it travels with it), switched in one click. */
import { useHvacUnits } from './useHvacUnits';

const TITLES = {
  si: 'SI: m³/h, m/s, Pa/m, Pa, mm, kW',
  ip: 'IP: CFM, fpm, in. wg/100 ft, in. wg, in, kBtu/h',
} as const;

export function UnitSystemSwitch({ className = '' }: { className?: string }) {
  const units = useHvacUnits();
  return (
    <div role="radiogroup" aria-label="Units" data-testid="hvac-unit-system" className={`inline-grid grid-cols-2 rounded-[7px] bg-slate-100 p-0.5 ${className}`}>
      {(['si', 'ip'] as const).map((system) => {
        const on = units.system === system;
        return (
          <button key={system} type="button" role="radio" aria-checked={on} title={TITLES[system]} onClick={() => units.setSystem(system)}
            className={`rounded-[5px] px-1.5 py-px text-[9.5px] font-bold tracking-[0.04em] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${on ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800'}`}>
            {system.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
