import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { disposeObject3DResources } from '../threeResourceLifecycle';

import { applyHybridPreviewMaterials, composeHybridPipePreviewScene } from './hybridPipePreviewScene';

describe('isolated hybrid pipe previews', () => {
  it('keeps steel and terminal previews solid without mutating shared committed materials', () => {
    const shared = new THREE.MeshStandardMaterial({ color: '#b9c3cc' });
    const disposeShared = vi.spyOn(shared, 'dispose');
    for (const type of ['duct', 'diffuser', 'return-grille'] as const) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
      applyHybridPreviewMaterials(mesh, { type });
      expect(mesh.material).not.toBe(shared);
      expect(mesh.material).toMatchObject({ transparent: false, opacity: 1, depthWrite: true });
      const disposePreview = vi.spyOn(mesh.material, 'dispose');
      disposeObject3DResources(mesh);
      expect(disposePreview).toHaveBeenCalledOnce();
    }
    expect(shared).toMatchObject({ transparent: false, opacity: 1, depthWrite: true });
    expect(disposeShared).not.toHaveBeenCalled();
    shared.dispose();
  });

  it('retains translucent interaction previews for refrigerant pipes', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const shared = mesh.material;
    applyHybridPreviewMaterials(mesh, { type: 'refrigerant-pipe' });
    expect(mesh.material).toMatchObject({ transparent: true, opacity: 0.72, depthWrite: false });
    disposeObject3DResources(mesh);
    shared.dispose();
  });

  it('keeps every unaffected element identical while a connected edit replaces its pipes', () => {
    const committed = Array.from({ length: 100 }, (_, index) => ({ id: `pipe-${index}`, x: index }));
    const edit = { ...committed[4]!, x: 1000 };
    const neighbor = { ...committed[5]!, x: 1100 };
    const scene = composeHybridPipePreviewScene(committed, null, [edit, neighbor]);
    expect(scene.previews).toEqual([edit, neighbor]);
    expect(scene.allElements[4]).toBe(edit);
    expect(scene.allElements[5]).toBe(neighbor);
    expect(scene.allElements.filter((element, index) => element === committed[index])).toHaveLength(98);
    expect(committed[4]!.x).toBe(4);
  });

  it('replaces extension draft IDs instead of rendering duplicate connection owners', () => {
    const host = { id: 'host', x: 10 };
    const extension = { id: 'host', x: 50 };
    const draft = { id: '__draft', x: 80 };
    const scene = composeHybridPipePreviewScene([host], [extension, draft], null);
    expect(scene.allElements).toEqual([extension, draft]);
    expect(scene.hiddenIds.has(host.id)).toBe(true);
    const cancelled = composeHybridPipePreviewScene([host], null, null);
    expect(cancelled.allElements[0]).toBe(host);
    expect(cancelled.hiddenIds.size).toBe(0);
    expect(cancelled.previews).toHaveLength(0);
  });
});
