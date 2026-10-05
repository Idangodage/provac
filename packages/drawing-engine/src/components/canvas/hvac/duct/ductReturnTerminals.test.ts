/**
 * Supply and return terminals as separate families: any face in either
 * service (the element type carries it), return filters with their drop on the
 * return path, short instance tags, and their plan / 3D / BOM presentation.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { buildDuctRunDraftElement } from './ductDraft';
import { priceDuctPlans } from './ductEconomics';
import { planDuctRun } from './ductFabricationPlanner';
import { airTerminalMarkup } from './ductOverlayMarkup';
import { systemPressure } from './ductPressure';
import { resolveDuctSettings } from './ductSettings';
import {
  filterPanelsServed,
  nextTerminalTag,
  readDuctTerminalSpec,
  terminalDropLookup,
  terminalEnvelope,
  terminalFilterDropPa,
  terminalLabel,
  terminalPressureDropPa,
  terminalSpigotPort,
  terminalTypeTag,
  typicalTerminalSpec,
  type DuctTerminalSpec,
} from './ductTerminals';
import { roundLeg } from './ductTypes';

const settings = resolveDuctSettings({ soffitMm: 3200 });

function element(id: string, spec: DuctTerminalSpec, overrides: Partial<HvacElement> = {}): HvacElement {
  const envelope = terminalEnvelope(spec);
  return {
    id, type: spec.service === 'return' ? 'return-grille' : 'diffuser', position: { x: 0, y: 0 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id, supplyZoneRatio: 0.5, properties: { terminal: spec }, ...overrides,
  };
}

describe('supply and return terminal families', () => {
  it('lets any face be supply or return: the element type carries the service', () => {
    const square = typicalTerminalSpec('square-4way', 250, { service: 'return' });
    expect(square.service).toBe('return');
    const read = readDuctTerminalSpec(element('rad1', square))!;
    expect(read).toMatchObject({ kind: 'square-4way', service: 'return', faceWidthMm: 595, neckDiameterMm: 250 });
    // The same stored face on a diffuser element is a supply diffuser.
    expect(readDuctTerminalSpec({ type: 'diffuser', properties: { terminal: square } })!.service).toBe('supply');
    // New faces default to return; louvred blades stand a little deeper than an egg-crate.
    expect(typicalTerminalSpec('louvred', 250)).toMatchObject({ service: 'return', faceWidthMm: 595, faceHeightMm: 35, plenumWidthMm: 530 });
    expect(typicalTerminalSpec('perforated', 250)).toMatchObject({ service: 'return', faceWidthMm: 595, faceHeightMm: 30, plenumWidthMm: 530 });
  });

  it('reads drawings made before return diffusers exactly as before', () => {
    const old = { ...typicalTerminalSpec('return-egg-crate', 250) } as Record<string, unknown>;
    delete old.filter;
    const read = readDuctTerminalSpec({ type: 'return-grille', properties: { terminal: old } })!;
    expect(read).toEqual({ ...typicalTerminalSpec('return-egg-crate', 250), designAirflowM3h: null });
    expect(read).not.toHaveProperty('filter');
    expect(readDuctTerminalSpec({ type: 'diffuser', properties: {} })).toMatchObject({ kind: 'square-4way', service: 'supply', neckDiameterMm: 200 });
    // An unknown filter value is no filter.
    expect(readDuctTerminalSpec({ type: 'return-grille', properties: { terminal: { ...old, filter: 'HEPA' } } })).not.toHaveProperty('filter');
  });

  it('names and tags terminals by service and face', () => {
    const cases: Array<[DuctTerminalSpec, string, string]> = [
      [typicalTerminalSpec('square-4way', 200), 'Square 4-way ceiling diffuser', 'SAD'],
      [typicalTerminalSpec('linear-slot', 150), 'Linear slot diffuser', 'LSD'],
      [typicalTerminalSpec('square-4way', 250, { service: 'return' }), 'Square return diffuser', 'RAD'],
      [typicalTerminalSpec('perforated', 250), 'Perforated return diffuser', 'RAD'],
      [typicalTerminalSpec('louvred', 250), 'Louvred return grille', 'RAG'],
      [typicalTerminalSpec('return-egg-crate', 250, { filter: 'G4' }), 'Egg-crate return grille with G4 filter', 'RAG'],
      [typicalTerminalSpec('linear-slot', 200, { service: 'return' }), 'Linear slot return', 'LRG'],
    ];
    for (const [spec, label, tag] of cases) {
      expect(terminalLabel(spec)).toBe(label);
      expect(terminalTypeTag(spec)).toBe(tag);
    }
  });

  it('numbers new terminals one past the highest tag of their type, never reusing a gap', () => {
    const rag = typicalTerminalSpec('louvred', 250);
    expect(nextTerminalTag([], rag)).toBe('RAG-1');
    const scene = [{ label: 'RAG-1' }, { label: 'RAG-4' }, { label: 'SAD-9' }, { label: 'Egg-crate Return Grille 595 — Ø250' }];
    expect(nextTerminalTag(scene, rag)).toBe('RAG-5');
    expect(nextTerminalTag(scene, typicalTerminalSpec('square-4way', 200))).toBe('SAD-10');
    expect(nextTerminalTag(scene, typicalTerminalSpec('perforated', 250))).toBe('RAD-1');
  });
});

describe('return filters', () => {
  it('adds the filter media drop to the return grille, scaled by its face velocity (practice)', () => {
    const plain = typicalTerminalSpec('return-egg-crate', 250);
    const g4 = { ...plain, filter: 'G4' as const };
    const m5 = { ...plain, filter: 'M5' as const };
    expect(terminalFilterDropPa(plain, 600, settings)).toBe(0);
    expect(terminalPressureDropPa(plain, 600, settings)).toBe(settings.autoGrilleDropPa);
    // 600 m³/h through a 595 × 595 face: 0.471 m/s; 40 Pa at 2.5 m/s × 1.5 mid-life.
    const face = 600 / 3600 / (0.595 * 0.595);
    expect(terminalFilterDropPa(g4, 600, settings)).toBeCloseTo(40 * (face / 2.5) * 1.5, 9);
    expect(terminalFilterDropPa(g4, 1200, settings)).toBeCloseTo(2 * terminalFilterDropPa(g4, 600, settings), 9);
    expect(terminalFilterDropPa(m5, 600, settings)).toBeGreaterThan(terminalFilterDropPa(g4, 600, settings));
    expect(terminalPressureDropPa(g4, 600, settings)).toBeCloseTo(settings.autoGrilleDropPa + terminalFilterDropPa(g4, 600, settings), 9);
    // A supply diffuser keeps the diffuser placeholder.
    expect(terminalPressureDropPa(typicalTerminalSpec('square-4way', 200), 300, settings)).toBe(settings.autoDiffuserDropPa);
  });

  it('puts the filter on the return path, its panel in the BOM and its symbol on the plan and in 3D', () => {
    const unit: HvacElement = {
      id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
      elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
      properties: { modelCode: 'FDUM22KXE6F-W' },
    };
    const collar = resolveUnitAirPorts(unit).find((port) => port.kind === 'return')!;
    // A filter grille 2.4 m in front of the return collar, its spigot facing back at it.
    const spec: DuctTerminalSpec = { ...typicalTerminalSpec('return-egg-crate', 250, { filter: 'G4' }), spigotSide: 'back' };
    const envelope = terminalEnvelope(spec);
    const centre = { x: collar.lip.x, y: collar.lip.y + 2400 };
    const grille = element('RAG-1', spec, { id: 'rag1', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 } });
    const spigot = terminalSpigotPort(grille)!;
    expect(spigot.kind).toBe('return');
    const run = buildDuctRunDraftElement({
      port: collar,
      points: [{ x: collar.lip.x, y: collar.lip.y + 900 }, { x: spigot.lip.x, y: spigot.lip.y, z: spigot.lip.z - 125 }],
      legSizes: [{ widthMm: collar.widthMm, heightMm: collar.heightMm }, roundLeg(250)],
      end: { kind: 'terminal', terminalId: 'rag1', portId: 'spigot', flex: true },
    }, 'return-run');
    const scene = [unit, grille, run];
    const plan = planDuctRun(run, { settings, scene })!;
    const airflow = new Map([['rag1', 600]]);
    const plain = systemPressure([plan], airflow, settings, 'return');
    const filtered = systemPressure([plan], airflow, settings, 'return', terminalDropLookup(scene, settings));
    expect(plain.terminals[0]!.terminalPa).toBe(settings.autoGrilleDropPa);
    expect(filtered.terminals[0]!.terminalPa).toBeCloseTo(settings.autoGrilleDropPa + terminalFilterDropPa(spec, 600, settings), 9);
    expect(filtered.indexPa - plain.indexPa).toBeCloseTo(terminalFilterDropPa(spec, 600, settings), 9);

    const rows = buildDuctBom([plan], [], [grille]).filter((row) => row.category === 'Air terminals');
    expect(rows.map((row) => row.description)).toEqual([
      'Egg-crate return grille with G4 filter 595×595, lay-in, with plenum box 530×530×350',
      'Filter panel G4 coarse (≈ ISO Coarse 60 % · ≈ MERV 7), behind a hinged face',
    ]);
    expect(rows[1]).toMatchObject({ size: '595×595×25', quantity: 1, unit: 'no.' });

    // Its panel is priced with the runs that serve it (one per filter grille; none for a plain grille).
    expect(filterPanelsServed([plan], scene)).toBe(1);
    const plainGrille = { ...grille, properties: { ...grille.properties, terminal: { ...spec, filter: null } } };
    expect(filterPanelsServed([plan], [unit, plainGrille, run])).toBe(0);
    const cost = priceDuctPlans([plan], settings, 0, 0, filterPanelsServed([plan], scene));
    expect(cost.filters).toBe(settings.econFilterEach);
    expect(cost.total - priceDuctPlans([plan], settings).total).toBeCloseTo(settings.econFilterEach, 9);

    const markup = airTerminalMarkup(grille, readDuctTerminalSpec(grille)!, 0.5, true);
    expect(markup).toContain('data-terminal-filter="G4"');
    expect(markup).toContain('>RAG-1 · 595 · Ø250 · G4</text>');

    const group = buildHvacElementMesh(grille, { allElements: [grille] } as never)!;
    group.updateMatrixWorld(true);
    const filter = group.getObjectByName('terminal-filter')!;
    const box = new THREE.Box3().setFromObject(filter);
    // The panel sits just above the face, inside the plenum box.
    expect(box.min.z).toBeGreaterThan(2400 + spec.faceHeightMm);
    expect(box.max.z).toBeLessThan(2400 + spec.faceHeightMm + spec.plenumHeightMm);
  });
});

describe('return faces on the plan and in 3D', () => {
  it('draws louvre blades and a perforated dot grid in the return colour', () => {
    const louvred = element('RAG-2', typicalTerminalSpec('louvred', 250));
    const louvredMarkup = airTerminalMarkup(louvred, readDuctTerminalSpec(louvred)!, 0.5, true);
    // Face, blade border, seven blades, spigot.
    expect((louvredMarkup.match(/<path /g) ?? []).length).toBe(1 + 1 + 7 + 1);
    expect(louvredMarkup).toContain('#0f766e');
    const perforated = element('RAD-1', typicalTerminalSpec('perforated', 250));
    const perforatedMarkup = airTerminalMarkup(perforated, readDuctTerminalSpec(perforated)!, 0.5, true);
    expect((perforatedMarkup.match(/<circle /g) ?? []).length).toBe(25);
    expect(perforatedMarkup).toContain('>RAD-1 · 595 · Ø250</text>');
  });

  it('builds louvre blades in 3D below the plenum box', () => {
    const louvred = element('RAG-2', typicalTerminalSpec('louvred', 250));
    const group = buildHvacElementMesh(louvred, { allElements: [louvred] } as never)!;
    const blades: THREE.Object3D[] = [];
    group.traverse((object) => { if (object.name === 'terminal-louvre-blade') blades.push(object); });
    expect(blades).toHaveLength(9);
  });
});
