/**
 * The duct names for the shared segment-focus store (segments/segmentUiStore):
 * ducts were the first service with segment cards, and a focus without a
 * `domain` is a duct's.
 */
export {
  domainOf,
  sameFocus,
  useSegmentUiStore as useDuctSegmentUiStore,
  type SegmentFocus as DuctSegmentFocus,
  type SegmentPreview as DuctSegmentPreview,
} from '../segments/segmentUiStore';
