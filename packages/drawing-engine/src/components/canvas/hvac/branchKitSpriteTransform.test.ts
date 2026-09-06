import { describe, expect, it } from 'vitest';

import { branchKitSpriteTransform, BRANCH_SPRITE_SOCKETS } from './branchKitSpriteTransform';

describe('branch fitting image registration', () => {
  for (const line of ['gas', 'liquid'] as const) {
    it(`pins every ${line} socket to its physical port after rotation and translation`, () => {
      const ports = { inlet: { x: 1300, y: 100 }, run: { x: 1200, y: 540 }, branch: { x: 1050, y: 480 } };
      const matrix = branchKitSpriteTransform(line, 0.3, ports);
      for (const role of ['inlet', 'run', 'branch'] as const) {
        const source = BRANCH_SPRITE_SOCKETS[line][role];
        const x = source.x * 1000;
        const y = source.y * 300;
        expect(matrix[0] * x + matrix[2] * y + matrix[4]).toBeCloseTo(ports[role].x, 6);
        expect(matrix[1] * x + matrix[3] * y + matrix[5]).toBeCloseTo(ports[role].y, 6);
      }
    });
  }
});
