import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';

import { airTerminalMarkup } from './ductOverlayMarkup';
import {
  findTerminalPort,
  listTerminalPorts,
  readDuctTerminalSpec,
  terminalCeilingPlane,
  terminalEnvelope,
  terminalSpigotPort,
  typicalTerminalSpec,
} from './ductTerminals';

function terminal(overrides: Partial<HvacElement> = {}, spec = typicalTerminalSpec('square-4way', 200)): HvacElement {
  const envelope = terminalEnvelope(spec);
  return {
    id: 'sd1', type: spec.service === 'return' ? 'return-grille' : 'diffuser', position: { x: 1000, y: 2000 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: 'SD-1', supplyZoneRatio: 0.5, properties: { terminal: spec }, ...overrides,
  };
}

describe('air terminals (typical sizes, practice)', () => {
  it('a 595 lay-in square diffuser sits on a 530 box one neck + 100 mm tall', () => {
    const spec = typicalTerminalSpec('square-4way', 250);
    expect(spec).toMatchObject({ faceWidthMm: 595, faceDepthMm: 595, plenumWidthMm: 530, plenumHeightMm: 350, neckDiameterMm: 250, service: 'supply', spigotLengthMm: 60 });
    expect(typicalTerminalSpec('return-egg-crate', 250).service).toBe('return');
    expect(typicalTerminalSpec('linear-slot', 150, { slots: 3, lengthMm: 1500 })).toMatchObject({ faceWidthMm: 1500, faceDepthMm: 110, plenumDepthMm: 250, slots: 3 });
    expect(terminalEnvelope(spec)).toEqual({ widthMm: 595, depthMm: 595, heightMm: 385 });
  });

  it('reads old terminals without a spec as the typical one of their type', () => {
    const bare = { type: 'diffuser' as const, properties: {} };
    expect(readDuctTerminalSpec(bare)).toMatchObject({ kind: 'square-4way', neckDiameterMm: 200 });
    expect(readDuctTerminalSpec({ type: 'return-grille', properties: {} })).toMatchObject({ kind: 'return-egg-crate', neckDiameterMm: 250, service: 'return' });
    expect(readDuctTerminalSpec({ type: 'ducted-ac', properties: {} })).toBeNull();
  });

  it('puts the spigot on the plenum side, half way up the box, and turns it with the terminal', () => {
    const port = terminalSpigotPort(terminal())!;
    // Centre (1297.5, 2297.5); back = −Y: 265 box half + 60 spigot.
    expect(port.lip.x).toBeCloseTo(1297.5, 6);
    expect(port.lip.y).toBeCloseTo(2297.5 - 325, 6);
    expect(port.lip.z).toBeCloseTo(2400 + 35 + 150, 6);
    expect(port.normal).toEqual({ x: 0, y: -1 });
    expect(port).toMatchObject({ widthMm: 200, heightMm: 200, diameterMm: 200, kind: 'supply', portId: 'spigot', unitId: 'sd1' });
    const turned = terminalSpigotPort(terminal({ rotation: 90 }))!;
    expect(turned.normal.x).toBeCloseTo(1, 9);
    expect(turned.lip.x).toBeCloseTo(1297.5 + 325, 6);
    expect(listTerminalPorts([terminal(), { ...terminal(), id: 'unit', type: 'ducted-ac' }])).toHaveLength(1);
    expect(findTerminalPort([terminal()], 'sd1')?.lip).toEqual(port.lip);
  });

  it('sits in the ceiling plane the ceiling units use', () => {
    expect(terminalCeilingPlane([])).toBe(2400);
    expect(terminalCeilingPlane([terminal({ id: 'du', type: 'ducted-ac', elevation: 2600 })])).toBe(2600);
    const cassettes = [2500, 2700, 2550].map((elevation, index) => terminal({ id: `c${index}`, type: 'ceiling-cassette-ac', elevation }));
    expect(terminalCeilingPlane(cassettes)).toBe(2550);
  });

  it('draws the plan symbol over the 3D top view: face, pattern, dashed spigot and tag', () => {
    const spec = readDuctTerminalSpec(terminal())!;
    const markup = airTerminalMarkup(terminal(), spec, 0.5, true);
    expect(markup).toContain('data-duct-terminal="sd1"');
    expect(markup).toContain('>SD 595 · Ø200</text>');
    expect(markup).toContain('stroke-dasharray="4 3"');
    // Face, two frames and four diagonals for the 4-way throw.
    expect((markup.match(/<path /g) ?? []).length).toBe(1 + 2 + 4 + 1);
    const grille = typicalTerminalSpec('return-egg-crate', 250);
    const returnMarkup = airTerminalMarkup(terminal({ id: 'rg1', type: 'return-grille' }, grille), grille, 0.5, true);
    expect(returnMarkup).toContain('>RG 595 · Ø250</text>');
    expect(returnMarkup).toContain('#0f766e');
    expect(airTerminalMarkup(terminal(), spec, 0.5, false)).not.toContain('<text');
  });

  it('builds the face, the plenum box and the spigot in 3D where the port is', () => {
    const element = terminal();
    const group = buildHvacElementMesh(element, { allElements: [element] } as never)!;
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const port = terminalSpigotPort(element)!;
    expect(box.min.z).toBeLessThanOrEqual(2400 + 1);
    expect(box.max.z).toBeCloseTo(2400 + 35 + 300, 0);
    // The spigot reaches the port lip on the back side.
    expect(Math.min(box.min.y, box.max.y)).toBeCloseTo(Math.min(port.lip.y, 2000), 0);
  });

  it.each(['back', 'front', 'left', 'right'] as const)('keeps the %s spigot and its bead open into the plenum after rotation', (spigotSide) => {
    const spec = { ...typicalTerminalSpec('square-4way', 200), spigotSide };
    const element = terminal({ rotation: 37 }, spec);
    const port = terminalSpigotPort(element)!;
    const group = buildHvacElementMesh(element, { allElements: [element] })!;
    group.updateMatrixWorld(true);
    const normal = new THREE.Vector3(port.normal.x, port.normal.y, 0);
    const lip = new THREE.Vector3(port.lip.x, port.lip.y, port.lip.z);
    // This traverses the collar, its retention bead and the plenum side sheet.
    const ray = new THREE.Raycaster(lip.clone().addScaledVector(normal, 10), normal.clone().negate(), 0, spec.spigotLengthMm + 20);
    expect(ray.intersectObject(group, true)).toHaveLength(0);
    // The surrounding metal still closes the plenum: test above the neck.
    ray.ray.origin.z += spec.neckDiameterMm / 2 + 20;
    expect(ray.intersectObject(group, true).length).toBeGreaterThan(0);
    const roof = group.getObjectByName('terminal-plenum-roof')!;
    expect(new THREE.Box3().setFromObject(roof).max.z).toBeCloseTo(element.elevation + spec.faceHeightMm + spec.plenumHeightMm, 6);
  });
});
