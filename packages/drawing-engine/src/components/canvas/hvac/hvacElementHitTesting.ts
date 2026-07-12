import type { HvacElement, Point2D } from '../../../types';

import { isRefrigerantBranchKitElement } from './refrigerantBranchKitModel';
import { isRefrigerantPipeElementType } from './refrigerantPipePairModel';

function rotatePoint(point: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function elementCenter(element: Pick<HvacElement, 'position' | 'width' | 'depth'>): Point2D {
  return {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
  };
}

/**
 * Model-space rectangle hit-test for HVAC elements that may not have a Fabric
 * body. The rectangle is the element's world-mm bounds, rotated around center.
 */
export function containsPointInHvacElementBounds(
  pointMm: Point2D,
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'rotation'>,
  paddingMm = 0,
): boolean {
  const center = elementCenter(element);
  const local = rotatePoint(
    { x: pointMm.x - center.x, y: pointMm.y - center.y },
    -(element.rotation ?? 0),
  );
  return (
    Math.abs(local.x) <= element.width / 2 + paddingMm &&
    Math.abs(local.y) <= element.depth / 2 + paddingMm
  );
}

/**
 * Fallback model hit-testing for HVAC entities whose visible interaction target
 * is not represented by a Fabric object. Pipes are handled by their centerline
 * picker; ordinary equipment usually has Fabric groups, so this currently
 * targets branch kits.
 */
export function hitTestModelBackedHvacElement(
  pointMm: Point2D,
  elements: HvacElement[],
  options: { paddingMm?: number } = {},
): string | null {
  const paddingMm = options.paddingMm ?? 0;
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index]!;
    if (isRefrigerantPipeElementType(element.type)) {
      continue;
    }
    if (!isRefrigerantBranchKitElement(element)) {
      continue;
    }
    if (containsPointInHvacElementBounds(pointMm, element, paddingMm)) {
      return element.id;
    }
  }
  return null;
}
