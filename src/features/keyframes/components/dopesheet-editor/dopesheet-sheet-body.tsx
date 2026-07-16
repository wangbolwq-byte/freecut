import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { KeyframeMarqueeOverlay, type KeyframeMarqueeRect } from '../keyframe-marquee'
import { PROPERTY_COLUMN_WIDTH, RULER_HEIGHT } from './dopesheet-constants'
import { DopesheetEmptyState } from './dopesheet-empty-state'

interface DopesheetSheetBodyProps {
  scrollAreaRef: React.RefObject<HTMLDivElement | null>
  hasRows: boolean
  emptyStateMessage: string
  showEmptyGuidance: boolean
  proceduralHint?: string
  rowElements: ReactNode
  marqueeRect: KeyframeMarqueeRect | null
  marqueeJustEnded: boolean
  propertyColumnWidth?: number
  subtractRulerHeight?: boolean
  onTimelineBackgroundPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function DopesheetSheetBody({
  scrollAreaRef,
  hasRows,
  emptyStateMessage,
  showEmptyGuidance,
  proceduralHint,
  rowElements,
  marqueeRect,
  marqueeJustEnded,
  propertyColumnWidth = PROPERTY_COLUMN_WIDTH,
  subtractRulerHeight = true,
  onTimelineBackgroundPointerDown,
}: DopesheetSheetBodyProps) {
  return (
    <div
      ref={scrollAreaRef}
      className={subtractRulerHeight ? 'overflow-auto' : 'overflow-hidden'}
      style={{ height: subtractRulerHeight ? `calc(100% - ${RULER_HEIGHT}px)` : '100%' }}
    >
      {!hasRows ? (
        <DopesheetEmptyState
          showGuidance={showEmptyGuidance}
          fallbackMessage={emptyStateMessage}
          proceduralHint={proceduralHint}
        />
      ) : (
        <div className="relative min-h-full">
          <div
            data-testid="dopesheet-selection-surface"
            className="absolute inset-y-0 right-0 z-0"
            style={{ left: propertyColumnWidth }}
            onPointerDown={onTimelineBackgroundPointerDown}
          />
          <div className="relative z-10">{rowElements}</div>
          {marqueeRect && !marqueeJustEnded && (
            <KeyframeMarqueeOverlay
              rect={{
                ...marqueeRect,
                x: propertyColumnWidth + marqueeRect.x,
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
