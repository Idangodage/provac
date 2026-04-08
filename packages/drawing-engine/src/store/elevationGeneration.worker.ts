import type {
  ElevationSettings,
  ElevationView,
  HvacElement,
  SectionLine,
  Wall,
} from '../types';
import type { FurnitureProjectionInput } from '../components/canvas/elevation/elevationGenerator';
import { regenerateElevationViews } from '../components/canvas/elevation/elevationGenerator';

export interface RegenerateElevationsWorkerRequest {
  type: 'regenerate-elevations';
  requestId: number;
  signature: string;
  walls: Wall[];
  sectionLines: SectionLine[];
  existingViews: ElevationView[];
  elevationSettings: ElevationSettings;
  hvacElements: HvacElement[];
  furnitureInputs: FurnitureProjectionInput[];
}

export interface RegenerateElevationsWorkerResponse {
  type: 'regenerate-elevations-result';
  requestId: number;
  signature: string;
  elevationViews: ElevationView[];
}

const workerScope = self as unknown as {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<RegenerateElevationsWorkerRequest>) => void
  ) => void;
  postMessage: (message: RegenerateElevationsWorkerResponse) => void;
};

workerScope.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'regenerate-elevations') {
    return;
  }

  workerScope.postMessage({
    type: 'regenerate-elevations-result',
    requestId: message.requestId,
    signature: message.signature,
    elevationViews: regenerateElevationViews(
      message.walls,
      message.sectionLines,
      message.existingViews,
      message.elevationSettings,
      message.hvacElements,
      message.furnitureInputs
    ),
  });
});

export {};
