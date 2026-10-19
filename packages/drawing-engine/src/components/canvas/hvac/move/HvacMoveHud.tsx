'use client';

/**
 * The readout of a drag, at the cursor: what moves, how far (Δx, Δy and the
 * distance; a turn's angle), a distance or angle being typed, why the
 * selection stops short (red) and what the move leaves for the designer
 * (amber); plus the alignment guides, and a turn's pivot and swept angle.
 * Painted imperatively once per frame (a drag never re-renders React), in
 * nodes of its own on the page body, so the 2D stack's transform cannot shift
 * them.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import type { Point2D } from '../../../../types';

export interface HvacMoveHudView {
  /** Where the pointer is (client pixels). */
  client: Point2D;
  title: string;
  /** "Δx +500  Δy −250  ·  559 mm", or the distance being typed. */
  readout: string;
  /** The readout is a typed distance (Enter moves it). */
  typing: boolean;
  limitedBy: string | null;
  notes: readonly string[];
  /** What the move or turn did, needing nothing from the designer (shown plainly). */
  infos?: readonly string[];
  /** Alignment guides (client pixels). */
  guides: ReadonlyArray<{ x1: number; y1: number; x2: number; y2: number }>;
  /** Where the moved units and terminals were (client pixels): a faint outline each. */
  ghosts?: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>;
  /** A turn on the plan: its pivot, the pointer's start angle and the angle swept (client pixels, degrees clockwise). */
  turn?: { pivot: { x: number; y: number }; startDeg: number; sweepDeg: number; radius: number };
}

export interface HvacMoveHudHandle {
  show: (view: HvacMoveHudView) => void;
  hide: () => void;
}

const OFFSET_PX = 18;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A signed angle in degrees (clockwise +), with a true minus sign: "+90°", "−22.5°". */
export function formatTurnDeg(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '0°';
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded).toLocaleString('en-GB')}°`;
}

/** A signed length in millimetres, with a true minus sign. */
export function formatMoveMm(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded).toLocaleString('en-GB')}`;
}

export const HvacMoveHud = forwardRef<HvacMoveHudHandle>(function HvacMoveHud(_props, ref) {
  const nodesRef = useRef<{ box: HTMLDivElement; svg: SVGSVGElement } | null>(null);

  useEffect(() => {
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.dataset.testid = 'hvac-move-hud';
    box.className = 'pointer-events-none fixed left-0 top-0 z-[61] rounded-lg bg-slate-900/90 px-2.5 py-1.5 shadow-lg ring-1 ring-white/10 backdrop-blur';
    box.style.display = 'none';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'pointer-events-none fixed left-0 top-0 z-[60] h-screen w-screen');
    document.body.append(svg, box);
    nodesRef.current = { box, svg };
    return () => {
      box.remove();
      svg.remove();
      nodesRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    show(view) {
      const nodes = nodesRef.current;
      if (!nodes) return;
      const { box, svg } = nodes;
      box.replaceChildren();
      const line = (text: string, className: string) => {
        const node = document.createElement('div');
        node.className = className;
        node.textContent = text;
        box.appendChild(node);
      };
      line(view.title, 'text-[10px] font-medium uppercase tracking-wide text-slate-400');
      line(view.readout, `font-mono text-[12px] font-semibold tabular-nums ${view.typing ? 'text-sky-300' : 'text-white'}`);
      if (view.typing) line(view.turn || view.readout.endsWith('°') ? 'Enter turns it · − anticlockwise · Esc cancels' : 'Enter moves it · Esc cancels', 'text-[10px] text-slate-400');
      if (view.limitedBy) line(view.limitedBy, 'max-w-[280px] text-[11px] leading-4 text-rose-300');
      view.notes.slice(0, 2).forEach((note) => line(note, 'max-w-[280px] text-[11px] leading-4 text-amber-300'));
      (view.infos ?? []).slice(0, Math.max(0, 2 - view.notes.length)).forEach((info) => line(info, 'max-w-[280px] text-[11px] leading-4 text-slate-300'));
      box.style.display = 'block';
      // Beside the cursor, kept on screen.
      const width = box.offsetWidth;
      const height = box.offsetHeight;
      const left = view.client.x + OFFSET_PX + width > window.innerWidth - 8 ? view.client.x - OFFSET_PX - width : view.client.x + OFFSET_PX;
      const top = view.client.y + OFFSET_PX + height > window.innerHeight - 8 ? view.client.y - OFFSET_PX - height : view.client.y + OFFSET_PX;
      box.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
      const ghosts = (view.ghosts ?? []).map((corners) => {
        const outline = document.createElementNS(SVG_NS, 'polygon');
        outline.setAttribute('points', corners.map((corner) => `${corner.x.toFixed(1)},${corner.y.toFixed(1)}`).join(' '));
        outline.setAttribute('fill', 'rgba(100,116,139,0.06)');
        outline.setAttribute('stroke', '#94a3b8');
        outline.setAttribute('stroke-width', '1');
        outline.setAttribute('stroke-dasharray', '3 3');
        return outline;
      });
      const turn: SVGElement[] = [];
      if (view.turn) {
        const { pivot, startDeg, sweepDeg, radius } = view.turn;
        const at = (deg: number) => ({ x: pivot.x + radius * Math.cos((deg * Math.PI) / 180), y: pivot.y + radius * Math.sin((deg * Math.PI) / 180) });
        const from = at(startDeg);
        const to = at(startDeg + sweepDeg);
        if (Math.abs(sweepDeg) > 0.05) {
          const wedge = document.createElementNS(SVG_NS, 'path');
          wedge.setAttribute('d', `M${pivot.x},${pivot.y} L${from.x},${from.y} A${radius},${radius} 0 ${Math.abs(sweepDeg) > 180 ? 1 : 0} ${sweepDeg > 0 ? 1 : 0} ${to.x},${to.y} Z`);
          wedge.setAttribute('fill', 'rgba(13,148,136,0.12)');
          wedge.setAttribute('stroke', '#0d9488');
          wedge.setAttribute('stroke-width', '1.5');
          turn.push(wedge);
        }
        const spoke = document.createElementNS(SVG_NS, 'line');
        spoke.setAttribute('x1', String(pivot.x));
        spoke.setAttribute('y1', String(pivot.y));
        spoke.setAttribute('x2', String(view.client.x));
        spoke.setAttribute('y2', String(view.client.y));
        spoke.setAttribute('stroke', '#0f766e');
        spoke.setAttribute('stroke-width', '1');
        spoke.setAttribute('stroke-dasharray', '4 3');
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', String(pivot.x));
        dot.setAttribute('cy', String(pivot.y));
        dot.setAttribute('r', '3.5');
        dot.setAttribute('fill', '#0f766e');
        dot.setAttribute('stroke', '#fff');
        dot.setAttribute('stroke-width', '1.5');
        turn.push(spoke, dot);
      }
      svg.replaceChildren(...ghosts, ...turn, ...view.guides.map((guide) => {
        const path = document.createElementNS(SVG_NS, 'line');
        path.setAttribute('x1', String(guide.x1));
        path.setAttribute('y1', String(guide.y1));
        path.setAttribute('x2', String(guide.x2));
        path.setAttribute('y2', String(guide.y2));
        path.setAttribute('stroke', '#d946ef');
        path.setAttribute('stroke-width', '1');
        path.setAttribute('stroke-dasharray', '4 3');
        return path;
      }));
    },
    hide() {
      const nodes = nodesRef.current;
      if (!nodes) return;
      nodes.box.style.display = 'none';
      nodes.box.replaceChildren();
      nodes.svg.replaceChildren();
    },
  }), []);

  return null;
});
