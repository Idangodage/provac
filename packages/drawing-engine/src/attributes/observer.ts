/**
 * Observer hub for wall/room attribute updates.
 */

import type { Room3D, Wall3D } from '../types';

export type AttributeChangeEntity = 'wall' | 'room';

export interface AttributeChangeEvent {
  entity: AttributeChangeEntity;
  entityId: string;
  previousValue: Wall3D | Room3D | null;
  nextValue: Wall3D | Room3D;
  source: 'binding' | 'ui' | 'import' | 'drag';
  timestamp: number;
}

type AttributeListener = (event: AttributeChangeEvent) => void;

class AttributeChangeObserver {
  private listeners: Set<AttributeListener> = new Set();

  subscribe(listener: AttributeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(event: AttributeChangeEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error('Attribute listener failed', error);
      }
    });
  }
}

export const attributeChangeObserver = new AttributeChangeObserver();
