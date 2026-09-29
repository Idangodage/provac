/**
 * The duct auto layout and its optimiser off the main thread: the scene, the
 * request and the settings in, the verified designs out.
 */
import { generateAutoDuct } from '../ductAutoLayout';

import type { AutoDuctWorkerRequest, AutoDuctWorkerResponse } from './ductOptimizerClient';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AutoDuctWorkerRequest>) => void) | null;
  postMessage: (response: AutoDuctWorkerResponse) => void;
};

scope.onmessage = ({ data }) => {
  if (data?.type !== 'generate') return;
  try {
    scope.postMessage({ type: 'result', id: data.id, result: generateAutoDuct(data.scene, data.request, data.settings) });
  } catch (error) {
    scope.postMessage({ type: 'error', id: data.id, message: error instanceof Error ? error.message : 'The duct layout could not be calculated.' });
  }
};
