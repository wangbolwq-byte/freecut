/**
 * Self-positioning unified playhead for the dope sheet timeline.
 *
 * The flag and full-height line are rendered by one element. During playback
 * this component updates its position directly so the editor does not need to
 * re-render on every frame.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { usePlaybackStore } from '@/shared/state/playback'
import { PlayheadMarks } from '@/shared/ui/playhead-marks'

interface DopesheetPlayheadLineProps {
  /** Clip-relative playhead frame for paused seek and zoom updates. */
  relativeFrame: number
  /** Absolute timeline frame where the edited item starts. */
  itemFrom: number
  /** Item duration in frames. */
  totalFrames: number
  /** Convert a clip-relative frame to x within the timeline viewport. */
  frameToX: (frame: number) => number
  /** Upper clamp for the playhead's left position. */
  maxLeft: number
  className?: string
}

export function DopesheetPlayheadLine({
  relativeFrame,
  itemFrom,
  totalFrames,
  frameToX,
  maxLeft,
  className,
}: DopesheetPlayheadLineProps) {
  const ref = useRef<HTMLDivElement>(null)
  const posRef = useRef({ frameToX, maxLeft, itemFrom, totalFrames, relativeFrame })
  posRef.current = { frameToX, maxLeft, itemFrom, totalFrames, relativeFrame }

  const clampLeft = (frame: number): number => {
    const pos = posRef.current
    return Math.max(0, Math.min(pos.maxLeft, pos.frameToX(frame)))
  }

  const livePlaybackRelFrame = (): number | null => {
    const state = usePlaybackStore.getState()
    const isPreviewing = state.previewFrame !== null
    if (!state.isPlaying && !isPreviewing) return null
    const pos = posRef.current
    const lastFrame = Math.max(0, (pos.totalFrames || 1) - 1)
    const frame = state.previewFrame ?? state.currentFrame
    return Math.max(0, Math.min(lastFrame, frame - pos.itemFrom))
  }

  useLayoutEffect(() => {
    if (!ref.current) return
    const liveRelativeFrame = livePlaybackRelFrame()
    ref.current.style.left = `${clampLeft(liveRelativeFrame ?? posRef.current.relativeFrame)}px`
  })

  useEffect(() => {
    const update = () => {
      const liveRelativeFrame = livePlaybackRelFrame()
      if (liveRelativeFrame === null) return
      if (ref.current) ref.current.style.left = `${clampLeft(liveRelativeFrame)}px`
    }
    return usePlaybackStore.subscribe(update)
    // Positioning inputs are read from posRef so this subscription stays stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={ref} data-testid="dopesheet-playhead-line" className={className}>
      <PlayheadMarks handle="flag" />
    </div>
  )
}
