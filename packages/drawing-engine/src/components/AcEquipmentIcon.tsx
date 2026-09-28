import type { AcEquipmentDefinition } from "../data/ac-equipment-library";

export interface AcEquipmentIconProps {
  definition: AcEquipmentDefinition;
  className?: string;
}

function Fan({ cx, cy, radius }: { cx: number; cy: number; radius: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={radius} />
      <circle cx={cx} cy={cy} r={1.6} />
      <path
        d={`M ${cx} ${cy - 1.6} c -4 -5 2 -7 4 -5 M ${cx + 1.6} ${cy} c 5 -4 7 2 5 4 M ${cx} ${cy + 1.6} c 4 5 -2 7 -4 5 M ${cx - 1.6} ${cy} c -5 4 -7 -2 -5 -4`}
        strokeWidth={1.2}
      />
    </g>
  );
}

function EquipmentDrawing({
  definition,
}: {
  definition: AcEquipmentDefinition;
}) {
  switch (definition.type) {
    case "ceiling-cassette-ac":
      return (
        <>
          <rect x={7} y={7} width={34} height={34} rx={4} />
          <rect
            x={17}
            y={17}
            width={14}
            height={14}
            rx={2}
            fill="currentColor"
            fillOpacity={0.06}
          />
          <path d="M15 11h18M15 14h18M15 34h18M15 37h18M11 15v18M14 15v18M34 15v18M37 15v18" />
          <path d="M21 21h6M21 24h6M21 27h6" strokeWidth={1.1} opacity={0.65} />
        </>
      );
    case "ducted-ac":
      return (
        <>
          <path
            d="m8 16 6-6h26v20l-6 6H8z"
            fill="currentColor"
            fillOpacity={0.04}
          />
          <path d="M8 16h26v20M34 16l6-6M12 12V7M35 9V6M11 36v5M31 36v5" />
          <rect x={11} y={21} width={20} height={10} rx={1} />
          <path
            d="M15 21v10M19 21v10M23 21v10M27 21v10M40 18h4M40 23h4"
            strokeWidth={1.3}
          />
        </>
      );
    case "split-ac":
    case "wall-mounted-ac":
      return (
        <>
          <rect x={5} y={11} width={38} height={20} rx={4} />
          <path d="M5 23h38M11 27h26M14 35v5M24 35v7M34 35v5" />
          <path d="M34 17h3" strokeWidth={2.2} />
        </>
      );
    case "ceiling-suspended-ac":
      return (
        <>
          <path d="M8 6h32M12 6v7M36 6v7M7 13h34v18H7zM7 22h34M12 26h24" />
          <path d="M15 35v5M24 35v7M33 35v5" />
        </>
      );
    case "outdoor-unit": {
      const fanCount = Number(definition.defaultProperties?.fanCount);
      const doubleFan =
        Number.isFinite(fanCount) && fanCount > 0
          ? fanCount > 1
          : definition.heightMm >= 1200;
      return doubleFan ? (
        <>
          <rect x={10} y={4} width={28} height={37} rx={2.5} />
          <path d="M14 41v3M34 41v3M33 9h2M33 13h2M33 31h2M33 35h2" />
          <Fan cx={22} cy={14} radius={7.5} />
          <Fan cx={22} cy={31} radius={7.5} />
        </>
      ) : (
        <>
          <rect x={4} y={12} width={40} height={26} rx={3} />
          <Fan cx={18} cy={25} radius={9} />
          <path d="M32 17h7M32 21h7M32 25h7M32 29h7M32 33h7M10 38v4M38 38v4" />
        </>
      );
    }
    case "refrigerant-branch-kit":
      return (
        <>
          <path
            d="M20 41V28c0-3-1-5-3-7L7 11l6-6 10 10 10-10 6 6-10 10c-2 2-3 4-3 7v13z"
            fill="currentColor"
            fillOpacity={0.05}
          />
          <path d="m10 14 6-6m16 6-6-6M20 35h6" />
          <path d="M23 26v5" strokeWidth={1.1} opacity={0.6} />
        </>
      );
    case "condensate-gully":
      if (definition.subtype === "stack-connection") {
        return (
          <>
            <path d="M27 5v38M36 5v38M25 9h13M25 38h13M8 12v10c0 9 6 13 19 13M17 12v10c0 3 3 5 10 5" />
            <path d="M6 12h13M6 17h13M27 20h9" />
          </>
        );
      }
      if (definition.subtype === "external-discharge") {
        return (
          <>
            <path
              d="M18 5v13M18 26v17M26 5v13M26 26v17M18 10l8-5M18 16l8-5M18 36l8-5M18 42l8-5"
              opacity={0.65}
            />
            <path d="M5 18h29c5 0 7 3 7 8v4h-8v-4H5M5 16v12" />
            <path d="M37 34s-3 4-3 6a3 3 0 0 0 6 0c0-2-3-6-3-6Z" />
          </>
        );
      }
      return (
        <>
          <rect x={7} y={8} width={34} height={28} rx={3} />
          <rect x={12} y={13} width={24} height={18} rx={1.5} />
          <path d="M18 13v18M24 13v18M30 13v18M12 19h24M12 25h24M19 36v5h10v-5" />
        </>
      );
    case "filter":
      return (
        <>
          <rect x={8} y={6} width={32} height={36} rx={2} />
          <path
            d="M13 11h22v26H13zM13 19l8-8M13 27l16-16M13 35l22-22M19 37l16-16M27 37l8-8M13 13l22 22M13 21l16 16M13 29l8 8M19 11l16 16M27 11l8 8"
            strokeWidth={1.2}
          />
        </>
      );
    default:
      if (definition.category === "controls") {
        return (
          <>
            <rect x={10} y={5} width={28} height={38} rx={4} />
            <rect
              x={15}
              y={11}
              width={18}
              height={15}
              rx={1.5}
              fill="currentColor"
              fillOpacity={0.06}
            />
            <path d="M19 17h4v5h-4M27 17h2M18 33h4M26 33h4M28 31v4" />
          </>
        );
      }
      return (
        <>
          <rect x={7} y={10} width={34} height={28} rx={3} />
          <path d="M12 17h24M12 23h24M12 29h16M13 38v4M35 38v4" />
          <circle cx={35} cy={31} r={1.5} />
        </>
      );
  }
}

/** A compact equipment silhouette; the adjacent equipment name supplies its label. */
export function AcEquipmentIcon({
  definition,
  className,
}: AcEquipmentIconProps) {
  return (
    <svg
      className={className}
      width={48}
      height={48}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <EquipmentDrawing definition={definition} />
    </svg>
  );
}
