/**
 * Adapter exports for timeline store dependencies.
 * Editor modules should import timeline store types/selectors from here.
 */

export type { TimelineState, TimelineActions, MotionPresetClear } from './timeline-contract'
export {
  importFilmstripCache,
  importWaveformCache,
  buildTimelineFromStores,
  rateStretchItemWithoutHistory,
  setInOutPointsWithoutHistory,
  useTimelineStore,
  useTimelineSettingsStore,
  useZoomStore,
  hydrateTimelineStoresFromProject,
  useItemsStore,
  useKeyframesStore,
  useCompositionsStore,
  useMarkersStore,
  useTransitionsStore,
  useCompositionNavigationStore,
  useTimelineCommandStore,
  executeTimelineCommand,
  captureSnapshot,
  applyAnimationPreset,
  applyMotionPresetKeyframes,
  applyMotionModifierToItems,
  updateMotionModifiersLive,
  beginMotionModifierEdit,
  commitMotionModifierEdit,
  removeMotionModifierFromItems,
  applyTextMotionEffect,
  updateTextMotionLive,
  beginTextMotionEdit,
  commitTextMotionEdit,
  removeTextMotionEffect,
  setEffectAudioPulse,
  bakeMotionToKeyframes,
  captureAnimationFromItem,
  getPresetCompatibility,
} from './timeline-contract'
