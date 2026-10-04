"use client";

import {
  ArrowUpRight,
  LayoutGrid,
  MousePointer2,
  Network,
  type LucideIcon,
} from "lucide-react";
import React, { useRef } from "react";

export type InspectorTab = "inspect" | "systems" | "drawing";

const TABS: Array<{ id: InspectorTab; label: string; icon: LucideIcon }> = [
  { id: "inspect", label: "Inspect", icon: MousePointer2 },
  { id: "systems", label: "Systems", icon: Network },
  { id: "drawing", label: "Drawing", icon: LayoutGrid },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";

/** Manual activation keeps expensive inspectors idle while navigating the tabs. */
export function InspectorTabs({
  value,
  onChange,
  idPrefix,
}: {
  value: InspectorTab;
  onChange: (value: InspectorTab) => void;
  idPrefix: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number;
    switch (event.key) {
      case "ArrowRight":
        target = (index + 1) % TABS.length;
        break;
      case "ArrowLeft":
        target = (index - 1 + TABS.length) % TABS.length;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons.current[target]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Properties sections"
      aria-orientation="horizontal"
      className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1"
    >
      {TABS.map(({ id, label, icon: Icon }, index) => (
        <button
          key={id}
          ref={(button) => { buttons.current[index] = button; }}
          type="button"
          role="tab"
          id={`${idPrefix}-${id}-tab`}
          aria-controls={`${idPrefix}-${id}-panel`}
          aria-selected={value === id}
          tabIndex={value === id ? 0 : -1}
          onKeyDown={(event) => focusTab(event, index)}
          onClick={() => onChange(id)}
          className={`flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 py-2 text-[11px] font-semibold transition-colors ${FOCUS_RING} ${
            value === id
              ? "bg-white text-teal-800 shadow-sm"
              : "text-slate-500 hover:bg-white/60 hover:text-slate-800"
          }`}
        >
          <Icon size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

export function InspectorTiles({
  items,
  value,
  onChange,
  label,
}: {
  items: Array<{
    id: string;
    label: string;
    icon: LucideIcon;
    description?: string;
    count?: number;
  }>;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-2">
      {items.map(({ id, label: itemLabel, icon: Icon, description, count }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            aria-label={count === undefined ? itemLabel : `${itemLabel}, ${count}`}
            title={description}
            onClick={() => onChange(id)}
            className={`relative flex min-h-[76px] min-w-0 flex-col items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${FOCUS_RING} ${
              active
                ? "border-teal-500 bg-teal-50 text-teal-900"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${active ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-500"}`}>
              <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
            </span>
            {count !== undefined && (
              <span aria-hidden="true" className={`absolute right-2.5 top-2.5 min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums ${active ? "bg-teal-100 text-teal-800" : "bg-slate-100 text-slate-500"}`}>
                {count}
              </span>
            )}
            <span className="text-xs font-medium leading-4">{itemLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

export function InspectorEmptyState({
  counts,
  onNavigate,
}: {
  counts: { walls: number; rooms: number; equipment: number };
  onNavigate: (tab: InspectorTab) => void;
}) {
  return (
    <div className="space-y-5 py-3">
      <div className="flex flex-col items-center gap-3 text-center">
        <svg
          viewBox="0 0 176 112"
          width="176"
          height="112"
          aria-hidden="true"
          focusable="false"
          className="max-w-full"
        >
          <rect x="8" y="5" width="152" height="94" rx="12" fill="#f8fafc" />
          <path d="M28 15v74M48 15v74M68 15v74M88 15v74M108 15v74M128 15v74M148 15v74M18 25h132M18 45h132M18 65h132M18 85h132" stroke="#e2e8f0" strokeWidth=".7" />
          <path d="M35 29h94v48H99m-20 0H35V29m54 0v28m0 20V67" fill="none" stroke="#94a3b8" strokeWidth="3" strokeLinejoin="round" />
          <path d="M79 77V58a19 19 0 0 1 19 19" fill="none" stroke="#cbd5e1" strokeWidth="1.2" />
          <rect x="47" y="40" width="28" height="22" rx="3" fill="#ccfbf1" stroke="#0d9488" strokeWidth="1.4" />
          <path d="M54 47h14m-14 7h14" stroke="#5eead4" strokeWidth="1.5" />
          <rect x="44" y="37" width="34" height="28" rx="4" fill="none" stroke="#0d9488" strokeDasharray="2 3" strokeWidth=".8" />
          <path d="m123 64 4 32 8-9 8 15 7-4-8-14 12-1-31-19Z" fill="#0f766e" stroke="white" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        <div>
          <p className="text-sm font-semibold text-slate-700">Ready to inspect</p>
          <p className="mt-1 text-xs text-slate-500">Select an element to edit its properties.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-xl border border-slate-200 bg-white py-3">
        {[
          { label: "Walls", count: counts.walls },
          { label: "Rooms", count: counts.rooms },
          { label: "HVAC", count: counts.equipment },
        ].map(({ label, count }) => (
          <div key={label} className="min-w-0 text-center">
            <p className="text-lg font-semibold leading-6 tabular-nums text-slate-700">{count}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">{label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {TABS.filter(({ id }) => id !== "inspect").map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onNavigate(id)}
            className={`flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 transition-colors hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 ${FOCUS_RING}`}
          >
            <Icon size={15} aria-hidden="true" className="shrink-0" />
            <span>{label}</span>
            <ArrowUpRight size={13} aria-hidden="true" className="ml-auto shrink-0 text-slate-400" />
          </button>
        ))}
      </div>
    </div>
  );
}
