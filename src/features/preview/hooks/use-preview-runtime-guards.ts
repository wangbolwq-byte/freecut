import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { PreviewQuality } from '@/shared/state/playback'
import { usePlaybackStore } from '@/shared/state/playback'
import { ADAPTIVE_PREVIEW_QUALITY_ENABLED } from '../utils/preview-constants'
import { createAdaptivePreviewQualityState } from '../utils/adaptive-preview-quality'

interface UsePreviewRuntimeGuardsParams {
  isGizmoInteracting: boolean
  isGizmoInteractingRef: MutableRefObject<boolean>
  setAdaptiveQualityCap: Dispatch<SetStateAction<PreviewQuality>>
  adaptiveQualityStateRef: MutableRefObject<ReturnType<typeof createAdaptivePreviewQualityState>>
  adaptiveFrameSampleRef: MutableRefObject<{ frame: number; tsMs: number } | null>
}

function clearPreviewFramePreservingViewedFrame() {
  const playback = usePlaybackStore.getState()
  if (playback.previewFrame === null) return

  if (playback.currentFrame !== playback.previewFrame) {
    playback.setCurrentFrame(playback.previewFrame)
  }
  playback.setPreviewFrame(null)
}

export function usePreviewRuntimeGuards({
  isGizmoInteracting,
  isGizmoInteractingRef,
  setAdaptiveQualityCap,
  adaptiveQualityStateRef,
  adaptiveFrameSampleRef,
}: UsePreviewRuntimeGuardsParams) {
  isGizmoInteractingRef.current = isGizmoInteracting

  useEffect(() => {
    clearPreviewFramePreservingViewedFrame()
  }, [])

  useEffect(() => {
    if (!isGizmoInteracting) return

    // During active transform drags, clear stale hover-scrub state without
    // changing the viewed frame. This avoids a one-frame render source/frame jump.
    clearPreviewFramePreservingViewedFrame()
  }, [isGizmoInteracting])

  useEffect(() => {
    if (!ADAPTIVE_PREVIEW_QUALITY_ENABLED) {
      adaptiveFrameSampleRef.current = null
      adaptiveQualityStateRef.current = createAdaptivePreviewQualityState(1)
      setAdaptiveQualityCap((quality) => (quality === 1 ? quality : 1))
      return
    }

    const applyPlaybackState = (isPlaying: boolean) => {
      adaptiveFrameSampleRef.current = null
      if (isPlaying) return

      adaptiveQualityStateRef.current = createAdaptivePreviewQualityState(1)
      setAdaptiveQualityCap((quality) => (quality === 1 ? quality : 1))
    }

    applyPlaybackState(usePlaybackStore.getState().isPlaying)
    return usePlaybackStore.subscribe((state, previousState) => {
      if (state.isPlaying !== previousState.isPlaying) {
        applyPlaybackState(state.isPlaying)
      }
    })
  }, [adaptiveFrameSampleRef, adaptiveQualityStateRef, setAdaptiveQualityCap])
}
