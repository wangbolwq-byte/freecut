import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  EllipsisVertical,
  Eye,
  EyeOff,
  Group,
  Lock,
  Plus,
  Pencil,
  Spline,
  Square,
  Type,
  Trash2,
  Ungroup,
  Unlock,
} from 'lucide-react'
import { cn } from '@/shared/ui/cn'
import { PlayheadMarks } from '@/shared/ui/playhead-marks'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createLogger } from '@/shared/logging/logger'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { useClipboardStore } from '@/shared/state/clipboard'
import { useEditorStore } from '@/shared/state/editor'
import type { AnimatableProperty, Keyframe, KeyframeRef } from '@/types/keyframe'
import type { BlendMode } from '@/types/blend-modes'
import { BLEND_MODE_GROUPS, BLEND_MODE_LABELS } from '@/types/blend-modes'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import type { TextMotionEffect, TextMotionSlot } from '@/types/text-motion'
import { getTextMotionPreset, segmentTextUnits } from '@/shared/typography/text-motion'
import {
  addItemOnNewTrack,
  addItemsOnNewTracks,
  addKeyframe,
  beginTextMotionEdit,
  buildDroppedCompositionTimelineItems,
  buildDroppedMediaTimelineItems,
  captureSnapshot,
  CompactNavigator,
  commitTextMotionEdit,
  createTimelineTemplateItem,
  createDefaultShapeItem,
  createTextTemplateItem,
  DopesheetEditor,
  duplicateItemsWithTrackChanges,
  getAnimatablePropertiesForItem,
  getEffectPropertyBaseValue,
  getProceduralBands,
  getDroppedMediaDurationInFrames,
  isTimelineTemplateDragData,
  interpolatePropertyValue,
  KEYFRAME_EDGE_INSET,
  moveItems,
  openComposition,
  removeKeyframes,
  removeItems,
  resolveDroppedMediaEntriesFromPayload,
  setTracks,
  trimItemEnd,
  trimItemStart,
  updateItem,
  updateKeyframe,
  updateKeyframes,
  updateTextMotionLive,
  useCompositionNavigationStore,
  useCompositionsStore,
  useItemsStore,
  useKeyframesStore,
  useKeyframeSelectionStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  wouldCreateCompositionCycle,
} from '@/features/editor/deps/timeline-motion'
import {
  clearMediaDragData,
  getMediaDragData,
  resolveMediaUrl,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library-contract'
import { useComposeUiStore } from './compose-ui-store'
import { NewCompositionDialog } from './new-composition-dialog'

const LAYER_COLUMN_WIDTH = 500
const TIMELINE_CONTENT_LEFT = LAYER_COLUMN_WIDTH + 1
const RULER_HEIGHT = 28
const LAYER_ROW_HEIGHT = 34
const RULER_DIVISIONS = 10
const EMPTY_LAYER_IDS: string[] = []
const PROCEDURAL_HATCH =
  'repeating-linear-gradient(45deg, rgba(56,189,248,0.55) 0 2px, transparent 2px 5px)'
interface MotionTimeViewport {
  startFrame: number
  endFrame: number
}

interface TextMotionTimelineBand {
  slot: TextMotionSlot
  presetId: string
  fromFrame: number
  toFrame: number
  unitCount: number
  durationFrames: number
}

function getTextMotionUnitCount(
  item: Extract<TimelineItem, { type: 'text' }>,
  effect: TextMotionEffect,
) {
  const unit = effect.unit ?? getTextMotionPreset(effect.presetId).unit
  return Math.max(1, segmentTextUnits(item.text.split(/\r?\n/u), unit).unitCount)
}

function getTextMotionWindow(
  item: Extract<TimelineItem, { type: 'text' }>,
  effect: TextMotionEffect | undefined,
): { length: number; unitCount: number } {
  if (!effect) return { length: 0, unitCount: 0 }
  const unitCount = getTextMotionUnitCount(item, effect)
  const maxRank =
    effect.order === 'center' ? Math.floor((unitCount - 1) / 2) : Math.max(0, unitCount - 1)
  const requested = Math.max(0, effect.durationFrames) + Math.max(0, effect.staggerFrames) * maxRank
  return { length: Math.min(item.durationInFrames / 2, requested), unitCount }
}

function getTextMotionTimelineBands(item: TimelineItem): TextMotionTimelineBand[] {
  if (item.type !== 'text' || !item.textMotion) return []
  const { in: inEffect, loop: loopEffect, out: outEffect } = item.textMotion
  const inWindow = getTextMotionWindow(item, inEffect)
  const outWindow = getTextMotionWindow(item, outEffect)
  const clipEnd = item.from + item.durationInFrames
  const bands: TextMotionTimelineBand[] = []

  if (inEffect && inWindow.length > 0) {
    bands.push({
      slot: 'in',
      presetId: inEffect.presetId,
      fromFrame: item.from,
      toFrame: item.from + inWindow.length,
      unitCount: inWindow.unitCount,
      durationFrames: inEffect.durationFrames,
    })
  }
  if (loopEffect) {
    const loopFrom = item.from + inWindow.length
    const loopTo = clipEnd - outWindow.length
    if (loopTo > loopFrom) {
      bands.push({
        slot: 'loop',
        presetId: loopEffect.presetId,
        fromFrame: loopFrom,
        toFrame: loopTo,
        unitCount: getTextMotionUnitCount(item, loopEffect),
        durationFrames: loopEffect.durationFrames,
      })
    }
  }
  if (outEffect && outWindow.length > 0) {
    bands.push({
      slot: 'out',
      presetId: outEffect.presetId,
      fromFrame: clipEnd - outWindow.length,
      toFrame: clipEnd,
      unitCount: outWindow.unitCount,
      durationFrames: outEffect.durationFrames,
    })
  }
  return bands
}

const TextMotionTimelineLanes = memo(function TextMotionTimelineLanes({
  itemId,
  bands,
  timeViewport,
}: {
  itemId: string
  bands: TextMotionTimelineBand[]
  timeViewport: MotionTimeViewport
}) {
  const dragRef = useRef<{
    pointerId: number
    slot: TextMotionSlot
    startX: number
    startDurationFrames: number
    laneWidth: number
    before: ReturnType<typeof beginTextMotionEdit> | null
  } | null>(null)
  const suppressClickRef = useRef(false)
  const visibleFrameRange = Math.max(1, timeViewport.endFrame - timeViewport.startFrame)

  const beginDurationDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, band: TextMotionTimelineBand) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const laneWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
      if (laneWidth <= 0) return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      dragRef.current = {
        pointerId: event.pointerId,
        slot: band.slot,
        startX: event.clientX,
        startDurationFrames: band.durationFrames,
        laneWidth,
        before: null,
      }
    },
    [],
  )

  const moveDurationDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      const deltaFrames = ((event.clientX - drag.startX) / drag.laneWidth) * visibleFrameRange
      if (!drag.before) {
        if (Math.abs(event.clientX - drag.startX) < 3) return
        drag.before = beginTextMotionEdit()
      }
      const directedDelta = drag.slot === 'out' ? -deltaFrames : deltaFrames
      const durationFrames = Math.max(1, Math.round(drag.startDurationFrames + directedDelta))
      updateTextMotionLive([itemId], drag.slot, { durationFrames })
    },
    [itemId, visibleFrameRange],
  )

  const endDurationDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      dragRef.current = null
      suppressClickRef.current = drag.before !== null && event.type === 'pointerup'
      if (drag.before) {
        commitTextMotionEdit(drag.before, { slot: drag.slot, itemIds: [itemId] })
      }
    },
    [itemId],
  )

  const openAnimationInspector = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation()
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      useSelectionStore.getState().selectItems([itemId])
      const editor = useEditorStore.getState()
      editor.setRightSidebarOpen(true)
      editor.setClipInspectorTab('audio')
    },
    [itemId],
  )

  return (
    <div data-testid="motion-text-procedural-lanes">
      {bands.map((band) => {
        const left = ((band.fromFrame - timeViewport.startFrame) / visibleFrameRange) * 100
        const width = ((band.toFrame - band.fromFrame) / visibleFrameRange) * 100
        return (
          <div key={band.slot} className="flex h-7 border-t border-border/45 bg-background/25">
            <div
              className="flex shrink-0 items-center border-r border-border pl-14 pr-2 text-[9px] text-sky-300/90"
              style={{ width: LAYER_COLUMN_WIDTH }}
            >
              <span className="w-8 uppercase tracking-[0.08em]">{band.slot}</span>
              <span className="truncate text-muted-foreground">{band.presetId}</span>
              <span className="ml-auto pl-2 tabular-nums text-muted-foreground/70">
                {band.durationFrames}f · {band.unitCount}u
              </span>
            </div>
            <div className="relative min-w-0 flex-1 overflow-hidden">
              <div
                data-testid={`motion-text-procedural-band-${band.slot}`}
                data-from-frame={band.fromFrame}
                data-to-frame={band.toFrame}
                className="absolute top-1/2 h-4 -translate-y-1/2 touch-none cursor-ew-resize rounded-sm border border-sky-300/45 bg-sky-400/10 transition-[border-color,background-color] hover:border-sky-200/80 hover:bg-sky-400/20 active:border-sky-100"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(0.5, width)}%`,
                  backgroundImage: PROCEDURAL_HATCH,
                }}
                title={`${band.presetId} · drag to change duration · ${band.durationFrames}f · ${band.unitCount} units`}
                onPointerDown={(event) => beginDurationDrag(event, band)}
                onPointerMove={moveDurationDrag}
                onPointerUp={endDurationDrag}
                onPointerCancel={endDurationDrag}
                onClick={openAnimationInspector}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
})

interface MotionMiddlePanState {
  startClientY: number
  startScrollTop: number
}
const MOTION_INLINE_PROPERTY_GROUP_IDS = ['transform', 'crop', 'audio', 'effects', 'other'] as const
const logger = createLogger('MotionTimeline')

const ALL_BLEND_MODES = BLEND_MODE_GROUPS.flatMap((group) => group.modes)

interface LayerEntry {
  item: TimelineItem
  track: TimelineTrack | undefined
}

type MotionRow =
  | { kind: 'group'; track: TimelineTrack; items: TimelineItem[] }
  | { kind: 'layer'; item: TimelineItem; track: TimelineTrack | undefined; depth: number }

interface SpanDragState {
  pointerId: number
  startX: number
  laneWidth: number
  deltaFrames: number
  items: Array<{ id: string; from: number; durationInFrames: number }>
}

interface SpanTrimState {
  pointerId: number
  itemId: string
  handle: 'start' | 'end'
  startX: number
  laneWidth: number
  deltaFrames: number
  from: number
  durationInFrames: number
}

interface RowReorderDragState {
  pointerId: number
  sourceTrackId: string
  parentTrackId: string | null
  startY: number
  deltaY: number
  originIndex: number
  targetIndex: number
  siblingCenters: Array<{ trackId: string; centerY: number }>
}

interface InlineCurveState {
  compositionId: string
  itemId: string
  property: AnimatableProperty
}

interface RenameTarget {
  kind: 'layer' | 'group'
  id: string
}

const MotionPlayheadOverlay = memo(function MotionPlayheadOverlay({
  timeViewport,
}: {
  timeViewport: MotionTimeViewport
}) {
  const playheadRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef(timeViewport)
  viewportRef.current = timeViewport

  const updatePosition = useCallback(() => {
    const element = playheadRef.current
    if (!element) return
    const viewport = viewportRef.current
    const playback = usePlaybackStore.getState()
    const displayFrame = playback.previewFrame ?? playback.currentFrame
    if (displayFrame < viewport.startFrame || displayFrame > viewport.endFrame) {
      element.hidden = true
      return
    }
    element.hidden = false
    const width = element.parentElement?.clientWidth ?? 0
    const visibleFrameRange = Math.max(1, viewport.endFrame - viewport.startFrame)
    const x = ((displayFrame - viewport.startFrame) / visibleFrameRange) * width
    element.style.transform = `translate3d(${x}px, 0, 0)`
  }, [])

  useLayoutEffect(updatePosition, [timeViewport, updatePosition])
  useEffect(
    () =>
      usePlaybackStore.subscribe((state, previous) => {
        if (
          state.currentFrame !== previous.currentFrame ||
          state.previewFrame !== previous.previewFrame
        ) {
          updatePosition()
        }
      }),
    [updatePosition],
  )

  return (
    <div
      ref={playheadRef}
      data-testid="motion-playhead"
      className="pointer-events-none absolute inset-y-0 left-0 z-20 will-change-transform"
    >
      <PlayheadMarks handle="flag" bleedBottom />
    </div>
  )
})

/**
 * Property editors need the frame while paused/scrubbing, but feeding every
 * playback tick through React makes every expanded dopesheet rerender. During
 * playback the selector collapses to a stable sentinel; pausing publishes the
 * latest frame once so inputs and keyframe controls catch up immediately.
 */
function useSettledMotionFrame(): number {
  const [settledFrame, setSettledFrame] = useState(
    () => usePlaybackStore.getState().previewFrame ?? usePlaybackStore.getState().currentFrame,
  )
  const settledFrameRef = useRef(settledFrame)

  useEffect(
    () =>
      usePlaybackStore.subscribe((state) => {
        if (state.isPlaying || state.previewFrame !== null) return
        const nextFrame = state.currentFrame
        if (nextFrame === settledFrameRef.current) return
        settledFrameRef.current = nextFrame
        setSettledFrame(nextFrame)
      }),
    [],
  )

  return settledFrame
}

const MotionCompactNavigator = memo(function MotionCompactNavigator({
  viewport,
  contentFrameMax,
  minVisibleFrames,
  onViewportChange,
}: {
  viewport: MotionTimeViewport
  contentFrameMax: number
  minVisibleFrames: number
  onViewportChange: (viewport: MotionTimeViewport) => void
}) {
  const currentFrame = useSettledMotionFrame()
  return (
    <CompactNavigator
      viewport={viewport}
      currentFrame={currentFrame}
      contentFrameMax={contentFrameMax}
      minVisibleFrames={minVisibleFrames}
      onViewportChange={onViewportChange}
    />
  )
})

interface MotionRowContextMenuProps {
  children: ReactNode
  canGroup?: boolean
  canPaste: boolean
  onOpen: () => void
  onRename: () => void
  onGroup?: () => void
  onUngroup?: () => void
  onDuplicate: () => void
  onCopy: () => void
  onPaste: () => void
  onDelete: () => void
}

const MotionRowContextMenu = memo(function MotionRowContextMenu({
  children,
  canGroup = false,
  canPaste,
  onOpen,
  onRename,
  onGroup,
  onUngroup,
  onDuplicate,
  onCopy,
  onPaste,
  onDelete,
}: MotionRowContextMenuProps) {
  return (
    <ContextMenu onOpenChange={(open) => open && onOpen()}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-48 text-xs">
        <ContextMenuItem onClick={onRename}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </ContextMenuItem>
        {onGroup && (
          <ContextMenuItem onClick={onGroup} disabled={!canGroup}>
            <Group className="mr-2 h-3.5 w-3.5" />
            Group selected layers
          </ContextMenuItem>
        )}
        {onUngroup && (
          <ContextMenuItem onClick={onUngroup}>
            <Ungroup className="mr-2 h-3.5 w-3.5" />
            Ungroup
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDuplicate}>
          <CopyPlus className="mr-2 h-3.5 w-3.5" />
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onClick={onCopy}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          Copy
        </ContextMenuItem>
        <ContextMenuItem onClick={onPaste} disabled={!canPaste}>
          <ClipboardPaste className="mr-2 h-3.5 w-3.5" />
          Paste
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

interface MotionDopesheetLanesProps {
  item: TimelineItem
  properties: AnimatableProperty[]
  compositionDurationInFrames: number
  fps: number
  canvas: { width: number; height: number }
  propertyFilter: 'all' | 'keyframed'
  timeViewport: MotionTimeViewport
  inlineCurveProperty: AnimatableProperty | null
  paneMode?: 'lanes' | 'graph'
  onSelectItem: (itemId: string) => void
  onInlineCurveChange: (property: AnimatableProperty | null) => void
  onScrub: (frame: number) => void
  onTimeViewportChange: (viewport: MotionTimeViewport) => void
}

const MotionDopesheetLanes = memo(function MotionDopesheetLanes({
  item,
  properties,
  compositionDurationInFrames,
  fps,
  canvas,
  propertyFilter,
  timeViewport,
  inlineCurveProperty,
  paneMode = 'lanes',
  onSelectItem,
  onInlineCurveChange,
  onScrub,
  onTimeViewportChange,
}: MotionDopesheetLanesProps) {
  const currentFrame = useSettledMotionFrame()
  const rootRef = useRef<HTMLDivElement>(null)
  const dragSnapshotRef = useRef<ReturnType<typeof captureSnapshot> | null>(null)
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 })
  const itemKeyframes = useKeyframesStore(
    useCallback((state) => state.keyframesByItemId[item.id], [item.id]),
  )
  const _updateKeyframe = useKeyframesStore((state) => state._updateKeyframe)
  const selectedKeyframes = useKeyframeSelectionStore((state) => state.selectedKeyframes)
  const selectKeyframes = useKeyframeSelectionStore((state) => state.selectKeyframes)
  const clearKeyframeSelection = useKeyframeSelectionStore((state) => state.clearSelection)
  const setKeyframeEditorShortcutScopeActive = useEditorStore(
    (state) => state.setKeyframeEditorShortcutScopeActive,
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const updateSize = () => {
      const rect = root.getBoundingClientRect()
      setPaneSize({ width: rect.width || 820, height: rect.height })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(
    () => () => setKeyframeEditorShortcutScopeActive(false),
    [setKeyframeEditorShortcutScopeActive],
  )

  const originalKeyframesByProperty = useMemo(() => {
    const byProperty = new Map(
      (itemKeyframes?.properties ?? []).map((entry) => [entry.property, entry.keyframes] as const),
    )
    return Object.fromEntries(
      properties.map((property) => [property, byProperty.get(property) ?? []]),
    ) as Partial<Record<AnimatableProperty, Keyframe[]>>
  }, [itemKeyframes, properties])

  const keyframesByProperty = useMemo(
    () =>
      Object.fromEntries(
        properties.map((property) => [
          property,
          (originalKeyframesByProperty[property] ?? []).map((keyframe) => ({
            ...keyframe,
            frame: item.from + keyframe.frame,
          })),
        ]),
      ),
    [item.from, originalKeyframesByProperty, properties],
  )

  const relativeFrame = Math.max(0, Math.min(item.durationInFrames - 1, currentFrame - item.from))
  const selectedKeyframeValueByProperty = useMemo(() => {
    const values: Partial<Record<AnimatableProperty, number>> = {}
    for (let index = selectedKeyframes.length - 1; index >= 0; index -= 1) {
      const reference = selectedKeyframes[index]!
      if (reference.itemId !== item.id || values[reference.property] !== undefined) continue
      const keyframe = (originalKeyframesByProperty[reference.property] ?? []).find(
        (candidate) => candidate.id === reference.keyframeId,
      )
      if (keyframe) values[reference.property] = keyframe.value
    }
    return values
  }, [item.id, originalKeyframesByProperty, selectedKeyframes])
  const propertyValues = useMemo(
    () =>
      Object.fromEntries(
        properties.map((property) => {
          const baseValue = getBasePropertyValue(item, property, canvas)
          const selectedValue = selectedKeyframeValueByProperty[property]
          return [
            property,
            selectedValue ??
              interpolatePropertyValue(
                originalKeyframesByProperty[property] ?? [],
                relativeFrame,
                baseValue,
              ),
          ]
        }),
      ),
    [
      canvas,
      item,
      originalKeyframesByProperty,
      properties,
      relativeFrame,
      selectedKeyframeValueByProperty,
    ],
  )
  const selectedKeyframeIds = useMemo(
    () =>
      new Set(
        selectedKeyframes
          .filter((reference) => reference.itemId === item.id)
          .map((reference) => reference.keyframeId),
      ),
    [item.id, selectedKeyframes],
  )
  const proceduralPropertyIds = useMemo(
    () =>
      new Set(getProceduralBands(item.motionModifiers, item.durationInFrames, item.from).keys()),
    [item.durationInFrames, item.from, item.motionModifiers],
  )
  const visiblePropertyCount =
    propertyFilter === 'keyframed'
      ? properties.filter(
          (property) =>
            (originalKeyframesByProperty[property]?.length ?? 0) > 0 ||
            proceduralPropertyIds.has(property),
        ).length
      : properties.length

  const handleSelectionChange = useCallback(
    (keyframeIds: Set<string>) => {
      const references: KeyframeRef[] = []
      for (const property of properties) {
        for (const keyframe of originalKeyframesByProperty[property] ?? []) {
          if (keyframeIds.has(keyframe.id)) {
            references.push({ itemId: item.id, property, keyframeId: keyframe.id })
          }
        }
      }
      if (references.length === 0) clearKeyframeSelection()
      else selectKeyframes(references)
    },
    [clearKeyframeSelection, item.id, originalKeyframesByProperty, properties, selectKeyframes],
  )

  const handleDragStart = useCallback(() => {
    dragSnapshotRef.current = captureSnapshot()
  }, [])
  const handleDragEnd = useCallback(() => {
    const snapshot = dragSnapshotRef.current
    if (!snapshot) return
    useTimelineCommandStore
      .getState()
      .addUndoEntry({ type: 'MOVE_KEYFRAME_GRAPH', payload: {} }, snapshot)
    useTimelineSettingsStore.getState().markDirty()
    dragSnapshotRef.current = null
  }, [])

  const clampAbsoluteFrame = useCallback(
    (frame: number) =>
      Math.max(item.from, Math.min(item.from + item.durationInFrames - 1, Math.round(frame))),
    [item.durationInFrames, item.from],
  )

  // In Motion's embedded lane view, an animated-only filter with no keyed
  // properties should consume no vertical space beneath the layer header.
  // The full graph editor keeps its empty guidance because it owns the pane.
  if (paneMode === 'lanes' && propertyFilter === 'keyframed' && visiblePropertyCount === 0) {
    return null
  }

  return (
    <div
      ref={rootRef}
      className={cn('w-full bg-background/35', paneMode === 'graph' && 'h-full')}
      onPointerEnter={() => setKeyframeEditorShortcutScopeActive(true)}
      onPointerLeave={() => setKeyframeEditorShortcutScopeActive(false)}
      onFocusCapture={() => setKeyframeEditorShortcutScopeActive(true)}
      onBlurCapture={(event) => {
        const nextFocused = event.relatedTarget as Node | null
        if (!event.currentTarget.contains(nextFocused)) {
          setKeyframeEditorShortcutScopeActive(false)
        }
      }}
    >
      {paneSize.width > 0 ? (
        <DopesheetEditor
          itemId={item.id}
          keyframesByProperty={keyframesByProperty}
          propertyValues={propertyValues}
          selectedProperty={inlineCurveProperty}
          selectedKeyframeIds={selectedKeyframeIds}
          currentFrame={currentFrame}
          globalFrame={currentFrame}
          itemFrom={0}
          totalFrames={compositionDurationInFrames}
          fps={fps}
          width={paneSize.width}
          height={
            paneMode === 'graph'
              ? Math.max(120, paneSize.height)
              : Math.max(30, visiblePropertyCount * 30)
          }
          frameViewport={timeViewport}
          onFrameViewportChange={onTimeViewportChange}
          onSelectionChange={handleSelectionChange}
          onKeyframeMove={(reference, nextFrame, nextValue) => {
            _updateKeyframe(reference.itemId, reference.property, reference.keyframeId, {
              frame: clampAbsoluteFrame(nextFrame) - item.from,
              value: nextValue,
            })
          }}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onSegmentEasingChange={(references, updates, options) => {
            if (options?.commit === false) {
              for (const reference of references) {
                _updateKeyframe(reference.itemId, reference.property, reference.keyframeId, updates)
              }
              return
            }
            updateKeyframes(
              references.map((reference) => ({
                itemId: reference.itemId,
                property: reference.property,
                keyframeId: reference.keyframeId,
                updates,
              })),
            )
          }}
          onAddKeyframe={(property, frame) => {
            const absoluteFrame = clampAbsoluteFrame(frame)
            const keyframes = originalKeyframesByProperty[property] ?? []
            const propertyRelativeFrame = absoluteFrame - item.from
            addKeyframe(
              item.id,
              property,
              propertyRelativeFrame,
              interpolatePropertyValue(
                keyframes,
                propertyRelativeFrame,
                getBasePropertyValue(item, property, canvas),
              ),
            )
          }}
          onPropertyValueCommit={(property, value, options) => {
            const propertyKeyframes = originalKeyframesByProperty[property] ?? []
            const selectedPropertyKeyframes = propertyKeyframes.filter((keyframe) =>
              selectedKeyframeIds.has(keyframe.id),
            )
            if (selectedPropertyKeyframes.length > 0) {
              updateKeyframes(
                selectedPropertyKeyframes.map((keyframe) => ({
                  itemId: item.id,
                  property,
                  keyframeId: keyframe.id,
                  updates: { value },
                })),
              )
              return
            }

            const existing = propertyKeyframes.find((keyframe) => keyframe.frame === relativeFrame)
            if (existing) updateKeyframe(item.id, property, existing.id, { value })
            else if (options?.allowCreate !== false) {
              addKeyframe(item.id, property, relativeFrame, value)
            }
          }}
          onRemoveKeyframes={(references) => {
            removeKeyframes(references)
            clearKeyframeSelection()
          }}
          onNavigateToKeyframe={(frame) => onScrub(clampAbsoluteFrame(frame))}
          onScrub={(frame) =>
            onScrub(Math.max(0, Math.min(compositionDurationInFrames - 1, frame)))
          }
          onScrubStart={() => onSelectItem(item.id)}
          onActivePropertyChange={() => onSelectItem(item.id)}
          onPropertyChange={(property) => {
            if (!property) return
            onSelectItem(item.id)
            onInlineCurveChange(property)
          }}
          onCurveVisibilityChange={(property, visible) => {
            onSelectItem(item.id)
            onInlineCurveChange(visible ? property : null)
          }}
          visualizationMode={paneMode === 'graph' ? 'graph' : 'dopesheet'}
          presentation="lanes"
          propertyColumnWidth={paneMode === 'graph' ? 0 : LAYER_COLUMN_WIDTH}
          singleCurveMode
          selectedCurveVisibleExternally={paneMode === 'lanes' && inlineCurveProperty !== null}
          propertyFilter={propertyFilter}
          proceduralFrameOffset={item.from}
          proceduralDurationInFrames={item.durationInFrames}
          showPlayhead={false}
          inlinePropertyGroupIds={MOTION_INLINE_PROPERTY_GROUP_IDS}
          spacious
        />
      ) : null}
    </div>
  )
})

function getItemProperties(item: TimelineItem): AnimatableProperty[] {
  return getAnimatablePropertiesForItem(item)
}

function getBasePropertyValue(
  item: TimelineItem,
  property: AnimatableProperty,
  canvas: { width: number; height: number },
): number {
  if (property === 'volume') return item.volume ?? 0
  if (property.startsWith('effect:')) return getEffectPropertyBaseValue(item, property) ?? 0
  const transform = item.transform
  switch (property) {
    case 'x':
    case 'y':
    case 'anchorX':
    case 'anchorY':
    case 'rotation':
      return transform?.[property] ?? 0
    case 'width':
      return transform?.width ?? canvas.width
    case 'height':
      return transform?.height ?? canvas.height
    case 'opacity':
      return transform?.opacity ?? 1
    case 'cornerRadius':
      return transform?.cornerRadius ?? 0
    default:
      return 0
  }
}

function normalizeMotionTimeViewport(
  viewport: MotionTimeViewport,
  totalFrames: number,
  roundToFrames = true,
): MotionTimeViewport {
  const contentEnd = Math.max(1, Math.round(totalFrames))
  const requestedVisibleFrames = viewport.endFrame - viewport.startFrame
  const visibleFrames = Math.max(
    Math.min(1, contentEnd),
    Math.min(
      contentEnd,
      roundToFrames ? Math.round(requestedVisibleFrames) : requestedVisibleFrames,
    ),
  )
  const maxStart = Math.max(0, contentEnd - visibleFrames)
  const requestedStartFrame = roundToFrames ? Math.round(viewport.startFrame) : viewport.startFrame
  const startFrame = Math.max(0, Math.min(maxStart, requestedStartFrame))
  return { startFrame, endFrame: startFrame + visibleFrames }
}

function formatFrameTime(frame: number, fps: number): string {
  const seconds = frame / Math.max(1, fps)
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  return `${Math.round(seconds)}s`
}

interface CompositingTimelineProps {
  className?: string
  defaults?: { width: number; height: number; fps: number }
}

function createLayerTrack(params: {
  id: string
  name: string
  kind: 'video' | 'audio'
  order: number
}): TimelineTrack {
  return {
    id: params.id,
    name: params.name,
    kind: params.kind,
    height: LAYER_ROW_HEIGHT,
    locked: false,
    syncLock: true,
    visible: true,
    muted: false,
    solo: false,
    order: params.order,
    items: [],
  }
}

interface LayerFrameInputProps {
  label: string
  ariaLabel: string
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
}

const LayerFrameInput = memo(function LayerFrameInput({
  label,
  ariaLabel,
  value,
  min,
  max,
  onCommit,
}: LayerFrameInputProps) {
  return (
    <label className="flex items-center gap-0.5 text-[8px] text-muted-foreground" title={ariaLabel}>
      {label}
      <input
        key={value}
        type="number"
        defaultValue={value}
        min={min}
        max={max}
        onBlur={(event) => {
          const parsed = Number(event.currentTarget.value)
          if (!Number.isFinite(parsed)) return
          const next = Math.max(min, Math.min(max, Math.round(parsed)))
          event.currentTarget.value = String(next)
          if (next !== value) onCommit(next)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        className="h-5 w-14 rounded border border-input bg-background px-1.5 text-[9px] tabular-nums text-muted-foreground outline-none focus:border-primary/60"
        aria-label={ariaLabel}
      />
    </label>
  )
})

/**
 * Dedicated layer/property timeline for the Motion workspace.
 *
 * This surface intentionally does not render or import the classic Timeline.
 * It shares domain stores, playback, undoable actions, and the dope-sheet's
 * row and inline curve primitives with the rest of the application.
 */
export const CompositingTimeline = memo(function CompositingTimeline({
  className,
  defaults,
}: CompositingTimelineProps) {
  const { t } = useTranslation()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [propertyFilter, setPropertyFilter] = useState<'all' | 'keyframed'>('all')
  const [inlineCurve, setInlineCurve] = useState<InlineCurveState | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [spanDrag, setSpanDrag] = useState<SpanDragState | null>(null)
  const spanDragRef = useRef<SpanDragState | null>(null)
  const [spanTrim, setSpanTrim] = useState<SpanTrimState | null>(null)
  const spanTrimRef = useRef<SpanTrimState | null>(null)
  const selectionAnchorIdRef = useRef<string | null>(null)
  const motionScrollAreaRef = useRef<HTMLDivElement>(null)
  const [rowReorderDrag, setRowReorderDrag] = useState<RowReorderDragState | null>(null)
  const rowReorderDragRef = useRef<RowReorderDragState | null>(null)
  const [timeViewport, setTimeViewport] = useState<MotionTimeViewport>({
    startFrame: 0,
    endFrame: 1,
  })
  const middlePanRef = useRef<MotionMiddlePanState | null>(null)
  const pendingScrubFrameRef = useRef<number | null>(null)
  const latestScrubFrameRef = useRef<number | null>(null)
  const scrubAnimationFrameRef = useRef<number | null>(null)
  const playheadScrubPointerIdRef = useRef<number | null>(null)
  const viewportCompositionIdRef = useRef<string | null>(null)
  const activeCompositionId = useCompositionNavigationStore((state) => state.activeCompositionId)
  const compositions = useCompositionsStore((state) => state.compositions)
  const compositionById = useCompositionsStore((state) => state.compositionById)
  const composition = useCompositionsStore(
    useCallback(
      (state) =>
        activeCompositionId ? (state.compositionById[activeCompositionId] ?? null) : null,
      [activeCompositionId],
    ),
  )
  const { items, tracks } = useItemsStore(
    useShallow((state) => ({ items: state.items, tracks: state.tracks })),
  )
  const keyframesByItemId = useKeyframesStore((state) => state.keyframesByItemId)
  const setScrubFrame = usePlaybackStore((state) => state.setScrubFrame)
  const setPreviewFrame = usePlaybackStore((state) => state.setPreviewFrame)
  const pause = usePlaybackStore((state) => state.pause)
  const selectedItemIds = useSelectionStore((state) => state.selectedItemIds)
  const selectItems = useSelectionStore((state) => state.selectItems)
  const expandedLayerIds = useComposeUiStore(
    useCallback(
      (state) =>
        activeCompositionId
          ? (state.expandedLayerIdsByComposition[activeCompositionId] ?? EMPTY_LAYER_IDS)
          : EMPTY_LAYER_IDS,
      [activeCompositionId],
    ),
  )
  const toggleLayerExpanded = useComposeUiStore((state) => state.toggleLayerExpanded)
  const pruneCompositionLayers = useComposeUiStore((state) => state.pruneCompositionLayers)
  const mediaItems = useMediaLibraryStore((state) => state.mediaItems)
  const canPasteLayers = useClipboardStore((state) => (state.itemsClipboard?.items.length ?? 0) > 0)

  const isComposite = composition?.editorKind === 'composite-2d'
  const durationInFrames = Math.max(
    1,
    composition?.durationInFrames ?? 1,
    ...items.map((item) => item.from + item.durationInFrames),
  )
  const fps = composition?.fps ?? 30
  // Fit the entire composition before paint whenever Motion opens or switches
  // compositions. Subsequent duration changes only clamp the user's viewport,
  // so manual zoom/pan remains stable while editing.
  useLayoutEffect(() => {
    if (viewportCompositionIdRef.current !== activeCompositionId) {
      viewportCompositionIdRef.current = activeCompositionId
      setTimeViewport({ startFrame: 0, endFrame: durationInFrames })
      return
    }
    setTimeViewport((current) => normalizeMotionTimeViewport(current, durationInFrames))
  }, [activeCompositionId, durationInFrames])
  const updateTimeViewport = useCallback(
    (viewport: MotionTimeViewport) =>
      setTimeViewport(normalizeMotionTimeViewport(viewport, durationInFrames)),
    [durationInFrames],
  )
  const visibleFrameRange = Math.max(1, timeViewport.endFrame - timeViewport.startFrame)
  const frameToMotionPercent = useCallback(
    (frame: number) => ((frame - timeViewport.startFrame) / visibleFrameRange) * 100,
    [timeViewport.startFrame, visibleFrameRange],
  )
  const compositeCompositions = useMemo(
    () => compositions.filter((candidate) => candidate.editorKind === 'composite-2d'),
    [compositions],
  )
  const dialogDefaults = defaults ?? {
    width: composition?.width ?? 1920,
    height: composition?.height ?? 1080,
    fps,
  }
  const selectedItemIdSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds])
  const expandedLayerIdSet = useMemo(() => new Set(expandedLayerIds), [expandedLayerIds])
  const activeInlineCurve = inlineCurve?.compositionId === activeCompositionId ? inlineCurve : null
  const trackById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks])
  const layerEntries = useMemo<LayerEntry[]>(
    () =>
      items
        .filter((item) => item.type !== 'subtitle')
        .map((item) => ({ item, track: trackById.get(item.trackId) }))
        .sort(
          (a, b) =>
            (a.track?.order ?? Number.MAX_SAFE_INTEGER) -
              (b.track?.order ?? Number.MAX_SAFE_INTEGER) ||
            a.item.from - b.item.from ||
            a.item.id.localeCompare(b.item.id),
        ),
    [items, trackById],
  )
  const activeCurveItem = activeInlineCurve
    ? (items.find((item) => item.id === activeInlineCurve.itemId) ?? null)
    : null
  const activeCurveProperties = useMemo(
    () => (activeCurveItem ? getItemProperties(activeCurveItem) : []),
    [activeCurveItem],
  )
  const canGroupSelectedLayers = useMemo(
    () =>
      new Set(
        layerEntries
          .filter((entry) => selectedItemIdSet.has(entry.item.id))
          .map((entry) => entry.track?.id)
          .filter((trackId): trackId is string => Boolean(trackId)),
      ).size >= 2,
    [layerEntries, selectedItemIdSet],
  )
  const motionRows = useMemo<MotionRow[]>(() => {
    const rows: MotionRow[] = []
    const entriesByTrackId = new Map<string, LayerEntry[]>()
    for (const entry of layerEntries) {
      const entries = entriesByTrackId.get(entry.item.trackId) ?? []
      entries.push(entry)
      entriesByTrackId.set(entry.item.trackId, entries)
    }

    const sortedTracks = [...tracks].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const emittedItemIds = new Set<string>()
    for (const track of sortedTracks.filter((candidate) => !candidate.parentTrackId)) {
      if (track.isGroup) {
        const childTracks = sortedTracks.filter((candidate) => candidate.parentTrackId === track.id)
        const childItems = childTracks.flatMap((child) =>
          (entriesByTrackId.get(child.id) ?? []).map((entry) => entry.item),
        )
        rows.push({ kind: 'group', track, items: childItems })
        if (!track.isCollapsed) {
          for (const childTrack of childTracks) {
            for (const entry of entriesByTrackId.get(childTrack.id) ?? []) {
              emittedItemIds.add(entry.item.id)
              rows.push({ kind: 'layer', ...entry, depth: 1 })
            }
          }
        } else {
          childItems.forEach((item) => emittedItemIds.add(item.id))
        }
        continue
      }

      for (const entry of entriesByTrackId.get(track.id) ?? []) {
        emittedItemIds.add(entry.item.id)
        rows.push({ kind: 'layer', ...entry, depth: 0 })
      }
    }

    for (const entry of layerEntries) {
      if (!emittedItemIds.has(entry.item.id)) {
        rows.push({ kind: 'layer', ...entry, depth: entry.track?.parentTrackId ? 1 : 0 })
      }
    }
    return rows
  }, [layerEntries, tracks])
  const visibleLayerIds = useMemo(
    () => motionRows.flatMap((row) => (row.kind === 'layer' ? [row.item.id] : [])),
    [motionRows],
  )

  useEffect(() => {
    if (!activeCompositionId) return
    pruneCompositionLayers(
      activeCompositionId,
      layerEntries.map((entry) => entry.item.id),
    )
  }, [activeCompositionId, layerEntries, pruneCompositionLayers])

  useEffect(() => {
    if (!activeInlineCurve) return
    const itemStillExists = layerEntries.some((entry) => entry.item.id === activeInlineCurve.itemId)
    if (!itemStillExists || !expandedLayerIdSet.has(activeInlineCurve.itemId)) {
      setInlineCurve(null)
    }
  }, [activeInlineCurve, expandedLayerIdSet, layerEntries])

  const updateLayerTrack = useCallback(
    (trackId: string, updates: Partial<TimelineTrack>) => {
      setTracks(tracks.map((track) => (track.id === trackId ? { ...track, ...updates } : track)))
    },
    [tracks],
  )

  const selectLayer = useCallback(
    (itemId: string, modifiers: { toggle?: boolean; range?: boolean } = {}) => {
      if (modifiers.range) {
        const anchorId = selectionAnchorIdRef.current ?? selectedItemIds.at(-1) ?? null
        const anchorIndex = anchorId ? visibleLayerIds.indexOf(anchorId) : -1
        const itemIndex = visibleLayerIds.indexOf(itemId)
        if (anchorIndex >= 0 && itemIndex >= 0) {
          const rangeStart = Math.min(anchorIndex, itemIndex)
          const rangeEnd = Math.max(anchorIndex, itemIndex)
          selectItems(
            Array.from(
              new Set([...selectedItemIds, ...visibleLayerIds.slice(rangeStart, rangeEnd + 1)]),
            ),
          )
          return
        }
      }

      selectionAnchorIdRef.current = itemId
      if (!modifiers.toggle) {
        selectItems([itemId])
        return
      }
      selectItems(
        selectedItemIdSet.has(itemId)
          ? selectedItemIds.filter((id) => id !== itemId)
          : [...selectedItemIds, itemId],
      )
    },
    [selectItems, selectedItemIdSet, selectedItemIds, visibleLayerIds],
  )

  const prepareLayerContextMenu = useCallback(
    (itemId: string) => {
      if (selectedItemIdSet.has(itemId)) return
      selectionAnchorIdRef.current = itemId
      selectItems([itemId])
    },
    [selectItems, selectedItemIdSet],
  )

  const prepareGroupContextMenu = useCallback(
    (itemIds: string[]) => {
      if (itemIds.length > 0 && itemIds.every((itemId) => selectedItemIdSet.has(itemId))) return
      selectItems(itemIds)
    },
    [selectItems, selectedItemIdSet],
  )

  const createGroupFromSelection = useCallback(() => {
    const selectedTrackIds = Array.from(
      new Set(
        layerEntries
          .filter((entry) => selectedItemIdSet.has(entry.item.id))
          .map((entry) => entry.track?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    )
    if (selectedTrackIds.length < 2) return
    const selectedTracks = tracks.filter((track) => selectedTrackIds.includes(track.id))
    const groupId = crypto.randomUUID()
    const groupNumber = tracks.filter((track) => track.isGroup).length + 1
    const group: TimelineTrack = {
      id: groupId,
      name: t('editor.compose.groupName', { count: groupNumber }),
      kind: 'video',
      height: LAYER_ROW_HEIGHT,
      locked: false,
      syncLock: true,
      visible: true,
      muted: false,
      solo: false,
      order: Math.min(...selectedTracks.map((track) => track.order)),
      items: [],
      isGroup: true,
      isCollapsed: false,
    }
    setTracks([
      ...tracks.map((track) =>
        selectedTrackIds.includes(track.id) ? { ...track, parentTrackId: groupId } : track,
      ),
      group,
    ])
  }, [layerEntries, selectedItemIdSet, t, tracks])

  const ungroupTracks = useCallback(
    (groupId: string) => {
      setTracks(
        tracks
          .filter((track) => track.id !== groupId)
          .map((track) =>
            track.parentTrackId === groupId ? { ...track, parentTrackId: undefined } : track,
          ),
      )
    },
    [tracks],
  )

  const beginRename = useCallback((target: RenameTarget, name: string) => {
    setRenameTarget(target)
    setRenameDraft(name)
  }, [])

  const commitRename = useCallback(() => {
    if (!renameTarget) return
    const name = renameDraft.trim()
    if (name) {
      if (renameTarget.kind === 'layer') {
        updateItem(renameTarget.id, { label: name })
        const item = items.find((candidate) => candidate.id === renameTarget.id)
        if (item) updateLayerTrack(item.trackId, { name })
      } else {
        updateLayerTrack(renameTarget.id, { name })
      }
    }
    setRenameTarget(null)
    setRenameDraft('')
  }, [items, renameDraft, renameTarget, updateLayerTrack])

  const copyLayers = useCallback(
    (itemIds: string[]) => {
      const itemIdSet = new Set(itemIds)
      const copiedItems = items.filter((item) => itemIdSet.has(item.id))
      if (copiedItems.length === 0) return
      useClipboardStore
        .getState()
        .copyItems(copiedItems, usePlaybackStore.getState().currentFrame, 'copy')
      toast.success(
        copiedItems.length === 1 ? 'Copied layer' : `Copied ${copiedItems.length} layers`,
      )
    },
    [items],
  )

  const duplicateLayers = useCallback(
    (itemIds: string[], sourceGroup?: TimelineTrack) => {
      const sourceItems = itemIds
        .map((itemId) => items.find((item) => item.id === itemId))
        .filter((item): item is TimelineItem => Boolean(item))
      if (sourceItems.length === 0) return

      const maxOrder = Math.max(-1, ...tracks.map((track) => track.order))
      const duplicatedGroupId = sourceGroup ? crypto.randomUUID() : null
      const newTracks: TimelineTrack[] = []
      if (sourceGroup && duplicatedGroupId) {
        newTracks.push({
          ...sourceGroup,
          id: duplicatedGroupId,
          name: `${sourceGroup.name} copy`,
          order: maxOrder + 1,
          items: [],
          isCollapsed: false,
        })
      }

      const positions = sourceItems.map((item, index) => {
        const sourceTrack = trackById.get(item.trackId)
        const newTrackId = crypto.randomUUID()
        newTracks.push({
          ...(sourceTrack ?? {
            name: item.label || item.type,
            kind: item.type === 'audio' ? 'audio' : 'video',
            height: LAYER_ROW_HEIGHT,
            locked: false,
            syncLock: true,
            visible: true,
            muted: false,
            solo: false,
            items: [],
          }),
          id: newTrackId,
          name: `${item.label ?? sourceTrack?.name ?? item.type} copy`,
          order: maxOrder + newTracks.length + index + 1,
          parentTrackId: duplicatedGroupId ?? sourceTrack?.parentTrackId,
          isGroup: false,
          items: [],
        } as TimelineTrack)
        return { from: item.from, trackId: newTrackId }
      })

      const duplicatedItems = duplicateItemsWithTrackChanges(
        [...tracks, ...newTracks],
        sourceItems.map((item) => item.id),
        positions,
      )
      selectItems(duplicatedItems.map((item) => item.id))
    },
    [items, selectItems, trackById, tracks],
  )

  const pasteLayers = useCallback(
    (parentTrackId?: string) => {
      const clipboard = useClipboardStore.getState().itemsClipboard
      if (!clipboard || clipboard.items.length === 0) return

      const pasteFrame = usePlaybackStore.getState().currentFrame
      const maxOrder = Math.max(-1, ...tracks.map((track) => track.order))
      const newTracks: TimelineTrack[] = []
      const newItems: TimelineItem[] = []
      for (const [index, itemData] of clipboard.items.entries()) {
        if (
          activeCompositionId &&
          'compositionId' in itemData &&
          typeof itemData.compositionId === 'string' &&
          wouldCreateCompositionCycle({
            parentCompositionId: activeCompositionId,
            insertedCompositionId: itemData.compositionId,
            compositionById,
          })
        ) {
          continue
        }
        const sourceTrack = trackById.get(itemData.trackId)
        const trackId = crypto.randomUUID()
        const itemId = crypto.randomUUID()
        newTracks.push({
          ...(sourceTrack ?? {
            name: itemData.label || itemData.type,
            kind: itemData.type === 'audio' ? 'audio' : 'video',
            height: LAYER_ROW_HEIGHT,
            locked: false,
            syncLock: true,
            visible: true,
            muted: false,
            solo: false,
            items: [],
          }),
          id: trackId,
          name: `${sourceTrack?.name ?? itemData.label ?? itemData.type} copy`,
          order: maxOrder + index + 1,
          parentTrackId,
          isGroup: false,
          items: [],
        } as TimelineTrack)
        newItems.push({
          ...itemData,
          id: itemId,
          originId: itemId,
          trackId,
          from: Math.max(0, pasteFrame + itemData.from),
          linkedGroupId: undefined,
        } as TimelineItem)
      }
      if (newItems.length === 0) return
      addItemsOnNewTracks(newItems, [...tracks, ...newTracks])
      selectItems(newItems.map((item) => item.id))
      toast.success(newItems.length === 1 ? 'Pasted layer' : `Pasted ${newItems.length} layers`)
    },
    [activeCompositionId, compositionById, selectItems, trackById, tracks],
  )

  const deleteLayers = useCallback(
    (itemIds: string[], trackIds: string[]) => {
      removeItems(itemIds)
      const removedTrackIds = new Set(trackIds)
      setTracks(tracks.filter((track) => !removedTrackIds.has(track.id)))
      selectItems([])
    },
    [selectItems, tracks],
  )

  const beginSpanDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, itemIds: string[]) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const lane = event.currentTarget.parentElement
      const laneWidth = lane?.getBoundingClientRect().width ?? 0
      if (laneWidth <= 0) return
      const itemIdSet = new Set(itemIds)
      const dragItems = items
        .filter((item) => itemIdSet.has(item.id))
        .map((item) => ({
          id: item.id,
          from: item.from,
          durationInFrames: item.durationInFrames,
        }))
      if (dragItems.length === 0) return
      pause()
      if (itemIds.length === 1) {
        selectLayer(itemIds[0]!, {
          toggle: event.metaKey || event.ctrlKey,
          range: event.shiftKey,
        })
      } else {
        selectItems(itemIds)
      }
      const next: SpanDragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        laneWidth,
        deltaFrames: 0,
        items: dragItems,
      }
      spanDragRef.current = next
      setSpanDrag(next)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [items, pause, selectItems, selectLayer],
  )

  const moveSpanDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = spanDragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const rawDelta = Math.round(
        ((event.clientX - drag.startX) / drag.laneWidth) * visibleFrameRange,
      )
      const minDelta = -Math.min(...drag.items.map((item) => item.from))
      const maxDelta = Math.min(...drag.items.map((item) => durationInFrames - item.from - 1))
      const deltaFrames = Math.max(minDelta, Math.min(maxDelta, rawDelta))
      if (deltaFrames === drag.deltaFrames) return
      const next = { ...drag, deltaFrames }
      spanDragRef.current = next
      setSpanDrag(next)
    },
    [durationInFrames, visibleFrameRange],
  )

  const endSpanDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = spanDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    spanDragRef.current = null
    setSpanDrag(null)
    if (drag.deltaFrames !== 0) {
      moveItems(drag.items.map((item) => ({ id: item.id, from: item.from + drag.deltaFrames })))
    }
  }, [])

  const getPreviewFrom = useCallback(
    (item: TimelineItem) => {
      if (spanTrim?.itemId === item.id && spanTrim.handle === 'start') {
        return spanTrim.from + spanTrim.deltaFrames
      }
      if (!spanDrag) return item.from
      return spanDrag.items.some((candidate) => candidate.id === item.id)
        ? item.from + spanDrag.deltaFrames
        : item.from
    },
    [spanDrag, spanTrim],
  )

  const getPreviewDuration = useCallback(
    (item: TimelineItem) => {
      if (spanTrim?.itemId !== item.id) return item.durationInFrames
      return spanTrim.handle === 'start'
        ? spanTrim.durationInFrames - spanTrim.deltaFrames
        : spanTrim.durationInFrames + spanTrim.deltaFrames
    },
    [spanTrim],
  )

  const beginSpanTrim = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>, item: TimelineItem, handle: 'start' | 'end') => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const lane = event.currentTarget.closest<HTMLElement>('[data-motion-timeline-lane]')
      const laneWidth = lane?.getBoundingClientRect().width ?? 0
      if (laneWidth <= 0) return
      pause()
      selectItems([item.id])
      const next: SpanTrimState = {
        pointerId: event.pointerId,
        itemId: item.id,
        handle,
        startX: event.clientX,
        laneWidth,
        deltaFrames: 0,
        from: item.from,
        durationInFrames: item.durationInFrames,
      }
      spanTrimRef.current = next
      setSpanTrim(next)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [pause, selectItems],
  )

  const moveSpanTrim = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      const trim = spanTrimRef.current
      if (!trim || trim.pointerId !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      const rawDelta = Math.round(
        ((event.clientX - trim.startX) / trim.laneWidth) * visibleFrameRange,
      )
      const minDelta = trim.handle === 'start' ? -trim.from : -(trim.durationInFrames - 1)
      const maxDelta =
        trim.handle === 'start'
          ? trim.durationInFrames - 1
          : durationInFrames - (trim.from + trim.durationInFrames)
      const deltaFrames = Math.max(minDelta, Math.min(maxDelta, rawDelta))
      if (deltaFrames === trim.deltaFrames) return
      const next = { ...trim, deltaFrames }
      spanTrimRef.current = next
      setSpanTrim(next)
    },
    [durationInFrames, visibleFrameRange],
  )

  const endSpanTrim = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const trim = spanTrimRef.current
    if (!trim || trim.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    spanTrimRef.current = null
    setSpanTrim(null)
    if (trim.deltaFrames === 0) return
    if (trim.handle === 'start') {
      trimItemStart(trim.itemId, trim.deltaFrames)
    } else {
      trimItemEnd(trim.itemId, trim.deltaFrames)
    }
  }, [])

  const beginRowReorder = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, track: TimelineTrack) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const parentTrackId = track.parentTrackId ?? null
      const root = event.currentTarget.closest('[data-testid="compositing-timeline"]')
      const siblingRows = Array.from(
        root?.querySelectorAll<HTMLElement>('[data-motion-row-track-id]') ?? [],
      ).filter((row) => (row.dataset.motionParentTrackId || null) === parentTrackId)
      const siblingCenters = siblingRows.map((row) => {
        const rect = row.getBoundingClientRect()
        return {
          trackId: row.dataset.motionRowTrackId!,
          centerY: rect.top + rect.height / 2,
        }
      })
      const originIndex = siblingCenters.findIndex((candidate) => candidate.trackId === track.id)
      if (originIndex < 0) return
      const next: RowReorderDragState = {
        pointerId: event.pointerId,
        sourceTrackId: track.id,
        parentTrackId,
        startY: event.clientY,
        deltaY: 0,
        originIndex,
        targetIndex: originIndex,
        siblingCenters,
      }
      rowReorderDragRef.current = next
      setRowReorderDrag(next)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [],
  )

  const moveRowReorder = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = rowReorderDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const otherCenters = drag.siblingCenters.filter(
      (candidate) => candidate.trackId !== drag.sourceTrackId,
    )
    const targetIndex = otherCenters.reduce(
      (index, candidate) => index + (event.clientY > candidate.centerY ? 1 : 0),
      0,
    )
    const next = {
      ...drag,
      deltaY: event.clientY - drag.startY,
      targetIndex,
    }
    rowReorderDragRef.current = next
    setRowReorderDrag(next)
  }, [])

  const finishRowReorder = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = rowReorderDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    rowReorderDragRef.current = null
    setRowReorderDrag(null)
    if (drag.targetIndex === drag.originIndex) return

    const latestTracks = useItemsStore.getState().tracks
    const siblings = latestTracks
      .filter((track) => (track.parentTrackId ?? null) === drag.parentTrackId)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    const sourceIndex = siblings.findIndex((track) => track.id === drag.sourceTrackId)
    if (sourceIndex < 0) return
    const [source] = siblings.splice(sourceIndex, 1)
    if (!source) return
    siblings.splice(Math.max(0, Math.min(drag.targetIndex, siblings.length)), 0, source)
    const orderByTrackId = new Map(siblings.map((track, index) => [track.id, index]))
    setTracks(
      latestTracks.map((track) => {
        const order = orderByTrackId.get(track.id)
        return order === undefined ? track : { ...track, order }
      }),
    )
  }, [])

  const cancelRowReorder = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = rowReorderDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    rowReorderDragRef.current = null
    setRowReorderDrag(null)
  }, [])

  const reorderDropTargetTrackId = useMemo(() => {
    if (!rowReorderDrag) return null
    const remaining = rowReorderDrag.siblingCenters.filter(
      (candidate) => candidate.trackId !== rowReorderDrag.sourceTrackId,
    )
    return (
      remaining[rowReorderDrag.targetIndex]?.trackId ??
      remaining.at(-1)?.trackId ??
      rowReorderDrag.sourceTrackId
    )
  }, [rowReorderDrag])
  const reorderDropAfterTarget = useMemo(() => {
    if (!rowReorderDrag) return false
    const remainingCount = rowReorderDrag.siblingCenters.filter(
      (candidate) => candidate.trackId !== rowReorderDrag.sourceTrackId,
    ).length
    return rowReorderDrag.targetIndex >= remainingCount
  }, [rowReorderDrag])

  const isRowReordering = rowReorderDrag !== null
  useEffect(() => {
    if (!isRowReordering) return
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = 'grabbing'
    return () => {
      document.body.style.cursor = previousCursor
    }
  }, [isRowReordering])

  const addGeneratedLayer = useCallback(
    (kind: 'text' | 'shape') => {
      if (!composition || composition.editorKind !== 'composite-2d') return
      const trackId = crypto.randomUUID()
      const order = tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1
      const placement = {
        trackId,
        from: 0,
        durationInFrames,
        canvasWidth: composition.width,
        canvasHeight: composition.height,
        fps,
      }
      const item =
        kind === 'text'
          ? createTextTemplateItem({ placement, text: 'Text layer', label: 'Text layer' })
          : createDefaultShapeItem({ ...placement, shapeType: 'rectangle' })
      const track: TimelineTrack = {
        id: trackId,
        name: item.label || (kind === 'text' ? 'Text layer' : 'Rectangle'),
        kind: 'video',
        height: LAYER_ROW_HEIGHT,
        locked: false,
        syncLock: true,
        visible: true,
        muted: false,
        solo: false,
        order,
        items: [],
      }
      addItemOnNewTrack(item, [...tracks, track])
      selectItems([item.id])
    },
    [composition, durationInFrames, fps, selectItems, tracks],
  )

  const insertCompositionLayer = useCallback(
    (compositionId: string, from: number) => {
      if (!activeCompositionId || !composition || composition.editorKind !== 'composite-2d') {
        return false
      }
      const latestItems = useItemsStore.getState().items
      const latestTracks = useItemsStore.getState().tracks
      const child = compositionById[compositionId]
      if (!child || child.id === activeCompositionId) return false
      const effectiveCompositionById = {
        ...compositionById,
        [activeCompositionId]: { ...composition, items: latestItems, tracks: latestTracks },
      }
      if (
        wouldCreateCompositionCycle({
          parentCompositionId: activeCompositionId,
          insertedCompositionId: child.id,
          compositionById: effectiveCompositionById,
        })
      ) {
        toast.error(t('editor.compose.compositionCycle'))
        return false
      }

      const trackId = crypto.randomUUID()
      const order = latestTracks.reduce((max, track) => Math.max(max, track.order), -1) + 1
      const track = createLayerTrack({ id: trackId, name: child.name, kind: 'video', order })
      const [item] = buildDroppedCompositionTimelineItems({
        compositionId: child.id,
        composition: child,
        label: child.name,
        placements: [
          {
            trackId,
            from,
            durationInFrames: Math.max(
              1,
              Math.min(durationInFrames - from, child.durationInFrames),
            ),
            mediaType: 'video',
          },
        ],
      })
      if (!item || item.type !== 'composition') return false
      addItemOnNewTrack(item, [...latestTracks, track])
      selectItems([item.id])
      return true
    },
    [activeCompositionId, composition, compositionById, durationInFrames, selectItems, t],
  )

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      setDropActive(false)
      if (!composition || composition.editorKind !== 'composite-2d') return

      const raw = event.dataTransfer.getData('application/json')
      let payload: unknown = getMediaDragData()
      if (raw) {
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = null
        }
      }
      clearMediaDragData()
      if (!payload || typeof payload !== 'object') return

      const dropFrame = Math.max(
        0,
        Math.min(durationInFrames - 1, usePlaybackStore.getState().currentFrame),
      )
      const candidate = payload as { type?: unknown; compositionId?: unknown }
      if (candidate.type === 'composition' && typeof candidate.compositionId === 'string') {
        insertCompositionLayer(candidate.compositionId, dropFrame)
        return
      }

      const latestTracks = useItemsStore.getState().tracks
      const nextOrder = latestTracks.reduce((max, track) => Math.max(max, track.order), -1) + 1
      if (isTimelineTemplateDragData(payload)) {
        const trackId = crypto.randomUUID()
        const track = createLayerTrack({
          id: trackId,
          name: payload.label,
          kind: 'video',
          order: nextOrder,
        })
        const item = createTimelineTemplateItem({
          template: payload,
          placement: {
            trackId,
            from: dropFrame,
            durationInFrames: Math.max(1, durationInFrames - dropFrame),
            canvasWidth: composition.width,
            canvasHeight: composition.height,
            fps,
          },
        })
        addItemOnNewTrack(item, [...latestTracks, track])
        selectItems([item.id])
        return
      }

      const entries = resolveDroppedMediaEntriesFromPayload(payload, mediaItems, logger)
      if (entries.length === 0) {
        toast.error(t('editor.compose.unsupportedDrop'))
        return
      }

      const resolved = await Promise.all(
        entries.map(async (entry, index) => {
          const blobUrl = await resolveMediaUrl(entry.mediaId)
          if (!blobUrl) return null
          const trackId = crypto.randomUUID()
          const track = createLayerTrack({
            id: trackId,
            name: entry.label,
            kind: entry.mediaType === 'audio' ? 'audio' : 'video',
            order: nextOrder + index,
          })
          const sourceDuration = getDroppedMediaDurationInFrames(entry.media, entry.mediaType, fps)
          const [item] = buildDroppedMediaTimelineItems({
            media: entry.media,
            mediaId: entry.mediaId,
            mediaType: entry.mediaType,
            label: entry.label,
            timelineFps: fps,
            blobUrl,
            thumbnailUrl: null,
            canvasWidth: composition.width,
            canvasHeight: composition.height,
            placement: {
              primary: {
                trackId,
                from: dropFrame,
                durationInFrames: Math.max(
                  1,
                  Math.min(durationInFrames - dropFrame, sourceDuration),
                ),
              },
            },
            linkVideoAudio: false,
          })
          return item ? { item, track } : null
        }),
      )
      const layers = resolved.filter(
        (entry): entry is { item: TimelineItem; track: TimelineTrack } => entry !== null,
      )
      if (layers.length === 0) {
        toast.error(t('editor.compose.mediaDropFailed'))
        return
      }

      addItemsOnNewTracks(
        layers.map((entry) => entry.item),
        [...latestTracks, ...layers.map((entry) => entry.track)],
      )
      selectItems(layers.map((entry) => entry.item.id))
    },
    [composition, durationInFrames, fps, insertCompositionLayer, mediaItems, selectItems, t],
  )

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    const hasLayerPayload =
      getMediaDragData() !== null ||
      Array.from(event.dataTransfer.types).includes('application/json')
    if (!hasLayerPayload) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return
    }
    setDropActive(false)
  }, [])

  const frameFromPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      if (rect.width <= 0) return null
      return Math.max(
        0,
        Math.min(
          durationInFrames - 1,
          Math.round(
            timeViewport.startFrame +
              ((event.clientX - rect.left) / rect.width) * visibleFrameRange,
          ),
        ),
      )
    },
    [durationInFrames, timeViewport.startFrame, visibleFrameRange],
  )

  const handleMotionTimelineWheel = useCallback(
    (event: WheelEvent) => {
      // Ordinary wheel input belongs to the native vertical layer/property
      // scroller. Ctrl/Cmd zoom and Shift-pan are owned by the time viewport.
      const isZoomGesture = event.ctrlKey || event.metaKey
      const isHorizontalPanGesture = event.shiftKey && !isZoomGesture
      if (!isZoomGesture && !isHorizontalPanGesture) return
      const scrollArea = motionScrollAreaRef.current
      if (!scrollArea) return
      const rect = scrollArea.getBoundingClientRect()
      const timelineLeft = rect.left + LAYER_COLUMN_WIDTH
      if (event.clientX < timelineLeft) return
      // The right pane owns wheel navigation. Consume it during capture so the
      // vertically scrollable row container and nested dope sheets cannot also
      // react to the same gesture.
      event.preventDefault()
      event.stopPropagation()
      const timelineWidth = Math.max(1, rect.right - timelineLeft)

      if (isHorizontalPanGesture) {
        // Shift+wheel conventionally supplies its motion through deltaY. Only
        // fall back to deltaX for devices/browsers that remap it themselves;
        // this prevents small cross-axis noise from reversing the gesture.
        const panDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX
        if (panDelta === 0) return
        setTimeViewport((current) => {
          const currentRange = Math.max(1, current.endFrame - current.startFrame)
          const deltaFrames = (panDelta / timelineWidth) * currentRange
          return normalizeMotionTimeViewport(
            {
              startFrame: current.startFrame + deltaFrames,
              endFrame: current.endFrame + deltaFrames,
            },
            durationInFrames,
            false,
          )
        })
        return
      }

      if (event.deltaY === 0) return
      const pivotRatio = Math.max(0, Math.min(1, (event.clientX - timelineLeft) / timelineWidth))
      setTimeViewport((current) => {
        const currentRange = Math.max(1, current.endFrame - current.startFrame)
        const pivotFrame = current.startFrame + pivotRatio * currentRange
        const nextRange = Math.max(
          1,
          Math.min(durationInFrames, Math.round(currentRange * (event.deltaY > 0 ? 1.25 : 0.8))),
        )
        return normalizeMotionTimeViewport(
          {
            startFrame: pivotFrame - pivotRatio * nextRange,
            endFrame: pivotFrame + (1 - pivotRatio) * nextRange,
          },
          durationInFrames,
        )
      })
    },
    [durationInFrames],
  )

  useEffect(() => {
    const scrollArea = motionScrollAreaRef.current
    if (!scrollArea) return
    scrollArea.addEventListener('wheel', handleMotionTimelineWheel, {
      capture: true,
      passive: false,
    })
    return () => {
      scrollArea.removeEventListener('wheel', handleMotionTimelineWheel, { capture: true })
    }
  }, [handleMotionTimelineWheel])

  useEffect(() => {
    const scrollArea = motionScrollAreaRef.current
    if (!scrollArea) return

    const finishMiddlePan = () => {
      if (!middlePanRef.current) return
      middlePanRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    const beginMiddlePan = (event: MouseEvent | PointerEvent) => {
      if (event.button !== 1) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (middlePanRef.current) return
      middlePanRef.current = {
        startClientY: event.clientY,
        startScrollTop: scrollArea.scrollTop,
      }
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
    }

    const moveMiddlePan = (event: MouseEvent | PointerEvent) => {
      const pan = middlePanRef.current
      if (!pan) return
      event.preventDefault()
      event.stopPropagation()
      scrollArea.scrollTop = pan.startScrollTop + (event.clientY - pan.startClientY)
    }

    const preventMiddleAuxClick = (event: MouseEvent) => {
      if (event.button !== 1) return
      event.preventDefault()
      event.stopPropagation()
    }

    scrollArea.addEventListener('pointerdown', beginMiddlePan, { capture: true })
    scrollArea.addEventListener('mousedown', beginMiddlePan, { capture: true })
    scrollArea.addEventListener('auxclick', preventMiddleAuxClick, { capture: true })
    window.addEventListener('pointermove', moveMiddlePan, { capture: true })
    window.addEventListener('mousemove', moveMiddlePan, { capture: true })
    window.addEventListener('pointerup', finishMiddlePan, { capture: true })
    window.addEventListener('pointercancel', finishMiddlePan, { capture: true })
    window.addEventListener('mouseup', finishMiddlePan, { capture: true })
    return () => {
      finishMiddlePan()
      scrollArea.removeEventListener('pointerdown', beginMiddlePan, { capture: true })
      scrollArea.removeEventListener('mousedown', beginMiddlePan, { capture: true })
      scrollArea.removeEventListener('auxclick', preventMiddleAuxClick, { capture: true })
      window.removeEventListener('pointermove', moveMiddlePan, { capture: true })
      window.removeEventListener('mousemove', moveMiddlePan, { capture: true })
      window.removeEventListener('pointerup', finishMiddlePan, { capture: true })
      window.removeEventListener('pointercancel', finishMiddlePan, { capture: true })
      window.removeEventListener('mouseup', finishMiddlePan, { capture: true })
    }
  }, [])

  const beginPlayheadScrub = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      playheadScrubPointerIdRef.current = event.pointerId
      event.currentTarget.setPointerCapture?.(event.pointerId)
      pause()
      const frame = frameFromPointer(event)
      if (frame !== null) {
        latestScrubFrameRef.current = frame
        setPreviewFrame(frame)
      }
    },
    [frameFromPointer, pause, setPreviewFrame],
  )

  const movePlayheadScrub = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (playheadScrubPointerIdRef.current !== event.pointerId) return
      const frame = frameFromPointer(event)
      if (frame === null) return
      latestScrubFrameRef.current = frame
      pendingScrubFrameRef.current = frame
      if (scrubAnimationFrameRef.current !== null) return
      scrubAnimationFrameRef.current = requestAnimationFrame(() => {
        scrubAnimationFrameRef.current = null
        const pendingFrame = pendingScrubFrameRef.current
        pendingScrubFrameRef.current = null
        if (pendingFrame !== null) setPreviewFrame(pendingFrame)
      })
    },
    [frameFromPointer, setPreviewFrame],
  )

  const endPlayheadScrub = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (playheadScrubPointerIdRef.current !== event.pointerId) return
      playheadScrubPointerIdRef.current = null
      if (scrubAnimationFrameRef.current !== null) {
        cancelAnimationFrame(scrubAnimationFrameRef.current)
        scrubAnimationFrameRef.current = null
      }
      const finalFrame = latestScrubFrameRef.current
      pendingScrubFrameRef.current = null
      latestScrubFrameRef.current = null
      if (finalFrame !== null) setScrubFrame(finalFrame)
      setPreviewFrame(null)
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }
    },
    [setPreviewFrame, setScrubFrame],
  )

  useEffect(
    () => () => {
      if (scrubAnimationFrameRef.current !== null) {
        cancelAnimationFrame(scrubAnimationFrameRef.current)
      }
      setPreviewFrame(null)
    },
    [setPreviewFrame],
  )

  if (!isComposite || !composition || !activeCompositionId) {
    return (
      <>
        <section
          className={cn(
            'flex min-h-0 flex-1 flex-col border-t border-border bg-timeline-bg transition-shadow',
            dropActive && 'ring-1 ring-inset ring-primary/60',
            className,
          )}
          data-testid="compositing-timeline-empty"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel-header px-3 text-xs font-semibold text-muted-foreground">
            <Spline className="h-3.5 w-3.5 text-primary" />
            <span className="min-w-0 flex-1">{t('editor.compose.layerTimeline')}</span>
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="flex h-6 items-center gap-1 rounded bg-primary/10 px-2 text-[10px] text-primary hover:bg-primary/20"
            >
              <Plus className="h-3 w-3" />
              {t('editor.compose.newComposition')}
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:10%_100%]">
            <div className="max-w-sm text-center">
              <p className="text-xs font-medium text-foreground">
                {t('editor.compose.chooseTitle')}
              </p>
              <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                {t('editor.compose.chooseDescription')}
              </p>
            </div>
          </div>
        </section>
        <NewCompositionDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          defaults={dialogDefaults}
        />
      </>
    )
  }

  const renderGroupRow = (row: Extract<MotionRow, { kind: 'group' }>) => {
    const groupSelected =
      row.items.length > 0 && row.items.every((item) => selectedItemIdSet.has(item.id))
    const groupFrom = row.items.length
      ? Math.min(...row.items.map((item) => getPreviewFrom(item)))
      : 0
    const groupEnd = row.items.length
      ? Math.max(...row.items.map((item) => getPreviewFrom(item) + item.durationInFrames))
      : 0
    const groupItemIds = row.items.map((item) => item.id)
    const isDragging = rowReorderDrag?.sourceTrackId === row.track.id
    const isDropTarget = reorderDropTargetTrackId === row.track.id && !isDragging

    return (
      <div
        key={row.track.id}
        data-motion-row-track-id={row.track.id}
        data-motion-parent-track-id=""
        className={cn(
          'relative border-b border-border/70',
          isDragging && 'z-30 opacity-85 shadow-lg',
          isDropTarget &&
            'before:absolute before:inset-x-0 before:z-40 before:h-0.5 before:bg-primary',
          isDropTarget && (reorderDropAfterTarget ? 'before:bottom-0' : 'before:top-0'),
        )}
        style={
          isDragging
            ? { transform: `translate3d(0, ${rowReorderDrag?.deltaY ?? 0}px, 0)` }
            : undefined
        }
      >
        <MotionRowContextMenu
          canPaste={canPasteLayers}
          onOpen={() => prepareGroupContextMenu(groupItemIds)}
          onRename={() => beginRename({ kind: 'group', id: row.track.id }, row.track.name)}
          onUngroup={() => ungroupTracks(row.track.id)}
          onDuplicate={() => duplicateLayers(groupItemIds, row.track)}
          onCopy={() => copyLayers(groupItemIds)}
          onPaste={() => pasteLayers(row.track.id)}
          onDelete={() =>
            deleteLayers(groupItemIds, [row.track.id, ...row.items.map((item) => item.trackId)])
          }
        >
          <div
            className={cn(
              'flex bg-panel-header/65 transition-colors',
              groupSelected && 'bg-accent/70',
            )}
            style={{ height: LAYER_ROW_HEIGHT }}
            data-testid={`motion-group-${row.track.id}`}
          >
            <div
              className="flex shrink-0 items-center gap-1 border-r border-border px-1.5"
              style={{ width: LAYER_COLUMN_WIDTH }}
            >
              <button
                type="button"
                data-testid={`motion-reorder-handle-${row.track.id}`}
                onPointerDown={(event) => beginRowReorder(event, row.track)}
                onPointerMove={moveRowReorder}
                onPointerUp={finishRowReorder}
                onPointerCancel={cancelRowReorder}
                className="flex h-6 w-3.5 shrink-0 touch-none items-center justify-center rounded-sm text-muted-foreground/65 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary active:text-primary"
                title={t('editor.compose.reorderGroup')}
                aria-label={t('editor.compose.reorderGroup')}
              >
                <EllipsisVertical className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() =>
                  updateLayerTrack(row.track.id, { isCollapsed: !row.track.isCollapsed })
                }
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={
                  row.track.isCollapsed
                    ? t('editor.compose.expandGroup')
                    : t('editor.compose.collapseGroup')
                }
              >
                {row.track.isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => updateLayerTrack(row.track.id, { visible: !row.track.visible })}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={
                  row.track.visible === false
                    ? t('editor.compose.showGroup')
                    : t('editor.compose.hideGroup')
                }
              >
                {row.track.visible === false ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => updateLayerTrack(row.track.id, { locked: !row.track.locked })}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={
                  row.track.locked ? t('editor.compose.unlockGroup') : t('editor.compose.lockGroup')
                }
              >
                {row.track.locked ? (
                  <Lock className="h-3.5 w-3.5" />
                ) : (
                  <Unlock className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => updateLayerTrack(row.track.id, { solo: !row.track.solo })}
                className={cn(
                  'h-5 w-5 rounded text-[9px] font-bold',
                  row.track.solo
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
                aria-label={
                  row.track.solo ? t('editor.compose.disableSolo') : t('editor.compose.soloGroup')
                }
              >
                S
              </button>
              {renameTarget?.kind === 'group' && renameTarget.id === row.track.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') setRenameTarget(null)
                  }}
                  aria-label="Group name"
                  className="h-5 min-w-24 flex-1 rounded border border-primary/50 bg-background px-1.5 text-[11px] font-semibold outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => selectItems(groupItemIds)}
                  onDoubleClick={() =>
                    beginRename({ kind: 'group', id: row.track.id }, row.track.name)
                  }
                  className="min-w-0 flex-1 truncate px-1 text-left text-[11px] font-semibold text-foreground"
                  title={row.track.name}
                >
                  {row.track.name}
                  <span className="ml-1.5 text-[9px] font-normal text-muted-foreground">
                    {t('editor.compose.groupLayerCount', { count: row.items.length })}
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => ungroupTracks(row.track.id)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t('editor.compose.ungroup')}
                aria-label={t('editor.compose.ungroup')}
              >
                <Ungroup className="h-3.5 w-3.5" />
              </button>
            </div>
            <div
              className="relative min-w-0 flex-1 touch-none overflow-hidden"
              onPointerDown={beginPlayheadScrub}
              onPointerMove={movePlayheadScrub}
              onPointerUp={endPlayheadScrub}
              onPointerCancel={endPlayheadScrub}
            >
              {Array.from({ length: RULER_DIVISIONS + 1 }, (_, tick) => (
                <div
                  key={tick}
                  className="pointer-events-none absolute inset-y-0 border-l border-border/45"
                  style={{ left: `${(tick / RULER_DIVISIONS) * 100}%` }}
                />
              ))}
              {!activeInlineCurve && row.items.length > 0 && (
                <button
                  type="button"
                  data-testid={`motion-group-span-${row.track.id}`}
                  onPointerDown={(event) => !row.track.locked && beginSpanDrag(event, groupItemIds)}
                  onPointerMove={moveSpanDrag}
                  onPointerUp={endSpanDrag}
                  onPointerCancel={endSpanDrag}
                  className={cn(
                    'absolute top-1/2 h-4 -translate-y-1/2 touch-none rounded-sm border border-timeline-motion-segment/80 bg-timeline-motion-segment/70 px-1 text-left text-[9px] text-foreground',
                    row.track.locked
                      ? 'cursor-not-allowed opacity-55'
                      : 'cursor-grab active:cursor-grabbing',
                  )}
                  style={{
                    left: `${frameToMotionPercent(groupFrom)}%`,
                    width: `${Math.max(0.6, ((groupEnd - groupFrom) / visibleFrameRange) * 100)}%`,
                  }}
                >
                  <span className="block truncate">{row.track.name}</span>
                </button>
              )}
            </div>
          </div>
        </MotionRowContextMenu>
      </div>
    )
  }

  const layerSheet = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-timeline-bg">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-panel-header px-2">
        <Select
          value={composition.id}
          onValueChange={(value) => {
            const next = compositionById[value]
            if (next) openComposition(next.id, next.name)
          }}
        >
          <SelectTrigger
            aria-label={t('editor.compose.compositionPicker')}
            className="h-6 min-w-0 max-w-52 gap-1.5 bg-background px-2 text-[10px] font-semibold text-foreground"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {compositeCompositions.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id} className="text-[10px]">
                {candidate.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-primary"
          title={t('editor.compose.newComposition')}
          aria-label={t('editor.compose.newComposition')}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70">
          {t('editor.compose.dropAssetsHint')}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {durationInFrames}f · {fps}fps
        </span>
        <button
          type="button"
          onClick={createGroupFromSelection}
          disabled={!canGroupSelectedLayers}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          title={t('editor.compose.groupSelected')}
        >
          <Group className="h-3 w-3" />
          {t('editor.compose.group')}
        </button>
        <button
          type="button"
          onClick={() => addGeneratedLayer('text')}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t('editor.compose.addTextLayer')}
        >
          <Type className="h-3 w-3" />
          {t('editor.compose.textLayer')}
        </button>
        <button
          type="button"
          onClick={() => addGeneratedLayer('shape')}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t('editor.compose.addShapeLayer')}
        >
          <Square className="h-3 w-3" />
          {t('editor.compose.shapeLayer')}
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          className="pointer-events-none absolute inset-0 z-30 overflow-visible"
          data-testid="motion-playhead-overlay"
        >
          <div
            className="absolute inset-y-0 right-0 overflow-visible"
            style={{
              left: TIMELINE_CONTENT_LEFT + KEYFRAME_EDGE_INSET,
              right: KEYFRAME_EDGE_INSET,
            }}
          >
            <MotionPlayheadOverlay timeViewport={timeViewport} />
          </div>
        </div>
        <div
          ref={motionScrollAreaRef}
          data-testid="motion-layer-scroll-area"
          className="h-full overflow-x-hidden overflow-y-auto [content-visibility:auto]"
        >
          <div className="relative min-h-full w-full min-w-0">
            <div className="sticky top-0 z-20 flex border-b border-border bg-panel-header">
              <div
                className="flex shrink-0 items-center justify-between gap-3 border-r border-border px-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
                style={{
                  width: LAYER_COLUMN_WIDTH,
                  height: RULER_HEIGHT,
                }}
              >
                <span>{t('editor.compose.layers')}</span>
                <Select
                  value={propertyFilter}
                  onValueChange={(value) => setPropertyFilter(value as 'all' | 'keyframed')}
                >
                  <SelectTrigger
                    aria-label="Property filter"
                    className="h-5 w-32 gap-1 bg-background px-2 text-[9px] font-normal normal-case tracking-normal text-muted-foreground"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-[10px]">
                      All properties
                    </SelectItem>
                    <SelectItem value="keyframed" className="text-[10px]">
                      Animated properties
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div
                className="relative min-w-0 flex-1 touch-none cursor-ew-resize"
                style={{ height: RULER_HEIGHT }}
                onPointerDown={beginPlayheadScrub}
                onPointerMove={movePlayheadScrub}
                onPointerUp={endPlayheadScrub}
                onPointerCancel={endPlayheadScrub}
              >
                {Array.from({ length: RULER_DIVISIONS + 1 }, (_, index) => {
                  const frame = Math.round(
                    timeViewport.startFrame + (index / RULER_DIVISIONS) * visibleFrameRange,
                  )
                  return (
                    <div
                      key={index}
                      className="absolute inset-y-0 border-l border-border/70"
                      style={{ left: `${(index / RULER_DIVISIONS) * 100}%` }}
                    >
                      <span className="ml-1 text-[9px] tabular-nums text-muted-foreground">
                        {formatFrameTime(frame, fps)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {motionRows.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
                <Plus className="mr-2 h-3.5 w-3.5" />
                {t('editor.compose.emptyLayers')}
              </div>
            ) : (
              motionRows.map((row, index) => {
                if (row.kind === 'group') return renderGroupRow(row)
                const { item, track, depth } = row
                const expanded = expandedLayerIdSet.has(item.id)
                const selected = selectedItemIdSet.has(item.id)
                const properties = getItemProperties(item)
                const proceduralBands = getProceduralBands(
                  item.motionModifiers,
                  item.durationInFrames,
                  item.from,
                )
                const textMotionBands = getTextMotionTimelineBands(item)
                const hasProceduralMotion = proceduralBands.size > 0 || textMotionBands.length > 0
                const hasVisibleChildProperties =
                  propertyFilter === 'all' ||
                  textMotionBands.length > 0 ||
                  properties.some(
                    (property) =>
                      keyframesByItemId[item.id]?.properties.some(
                        (entry) => entry.property === property && entry.keyframes.length > 0,
                      ) || proceduralBands.has(property),
                  )
                const isDragging = rowReorderDrag?.sourceTrackId === track?.id
                const isDropTarget = reorderDropTargetTrackId === track?.id && !isDragging
                return (
                  <div
                    key={item.id}
                    data-motion-row-track-id={track?.id}
                    data-motion-parent-track-id={track?.parentTrackId ?? ''}
                    className={cn(
                      'relative border-b border-border/70',
                      isDragging && 'z-30 opacity-85 shadow-lg',
                      isDropTarget &&
                        'before:absolute before:inset-x-0 before:z-40 before:h-0.5 before:bg-primary',
                      isDropTarget && (reorderDropAfterTarget ? 'before:bottom-0' : 'before:top-0'),
                    )}
                    style={
                      isDragging
                        ? { transform: `translate3d(0, ${rowReorderDrag?.deltaY ?? 0}px, 0)` }
                        : undefined
                    }
                  >
                    <MotionRowContextMenu
                      canGroup={canGroupSelectedLayers}
                      canPaste={canPasteLayers}
                      onOpen={() => prepareLayerContextMenu(item.id)}
                      onRename={() =>
                        beginRename({ kind: 'layer', id: item.id }, item.label || item.type)
                      }
                      onGroup={createGroupFromSelection}
                      onDuplicate={() => duplicateLayers([item.id])}
                      onCopy={() => copyLayers([item.id])}
                      onPaste={() => pasteLayers(track?.parentTrackId)}
                      onDelete={() => deleteLayers([item.id], track ? [track.id] : [])}
                    >
                      <div
                        className={cn(
                          'flex transition-colors',
                          selected ? 'bg-accent/70' : 'hover:bg-accent/35',
                        )}
                        style={{ height: LAYER_ROW_HEIGHT }}
                      >
                        <div
                          className="flex shrink-0 items-center gap-1 border-r border-border px-1.5"
                          style={{ width: LAYER_COLUMN_WIDTH, paddingLeft: 6 + depth * 16 }}
                        >
                          {track && (
                            <button
                              type="button"
                              data-testid={`motion-reorder-handle-${track.id}`}
                              onPointerDown={(event) => beginRowReorder(event, track)}
                              onPointerMove={moveRowReorder}
                              onPointerUp={finishRowReorder}
                              onPointerCancel={cancelRowReorder}
                              className="flex h-6 w-3.5 shrink-0 touch-none items-center justify-center rounded-sm text-muted-foreground/65 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary active:text-primary"
                              title={t('editor.compose.reorderLayer')}
                              aria-label={t('editor.compose.reorderLayer')}
                            >
                              <EllipsisVertical className="h-4 w-4" />
                            </button>
                          )}
                          {hasVisibleChildProperties ? (
                            <button
                              type="button"
                              onClick={() => toggleLayerExpanded(activeCompositionId, item.id)}
                              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                              aria-label={
                                expanded
                                  ? t('editor.compose.collapseLayerProperties')
                                  : t('editor.compose.expandLayerProperties')
                              }
                            >
                              {expanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </button>
                          ) : (
                            <span className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              track && updateLayerTrack(track.id, { visible: !track.visible })
                            }
                            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={
                              track?.visible === false
                                ? t('editor.compose.showLayer')
                                : t('editor.compose.hideLayer')
                            }
                          >
                            {track?.visible === false ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              track && updateLayerTrack(track.id, { locked: !track.locked })
                            }
                            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={
                              track?.locked
                                ? t('editor.compose.unlockLayer')
                                : t('editor.compose.lockLayer')
                            }
                          >
                            {track?.locked ? (
                              <Lock className="h-3.5 w-3.5" />
                            ) : (
                              <Unlock className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              track && updateLayerTrack(track.id, { solo: !track.solo })
                            }
                            className={cn(
                              'h-5 w-5 rounded text-[9px] font-bold',
                              track?.solo
                                ? 'bg-primary/15 text-primary'
                                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                            )}
                            aria-label={
                              track?.solo
                                ? t('editor.compose.disableSolo')
                                : t('editor.compose.soloLayer')
                            }
                          >
                            S
                          </button>
                          {renameTarget?.kind === 'layer' && renameTarget.id === item.id ? (
                            <input
                              autoFocus
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onFocus={(event) => event.currentTarget.select()}
                              onBlur={commitRename}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur()
                                if (event.key === 'Escape') setRenameTarget(null)
                              }}
                              aria-label="Layer name"
                              className="h-5 min-w-24 flex-1 rounded border border-primary/50 bg-background px-1.5 text-[11px] font-medium outline-none"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={(event) =>
                                selectLayer(item.id, {
                                  toggle: event.metaKey || event.ctrlKey,
                                  range: event.shiftKey,
                                })
                              }
                              onDoubleClick={() =>
                                beginRename({ kind: 'layer', id: item.id }, item.label || item.type)
                              }
                              className="min-w-0 flex-1 truncate px-1 text-left text-[11px] font-medium text-foreground"
                              title={item.label || item.type}
                            >
                              <span className="mr-1.5 text-[9px] tabular-nums text-muted-foreground/70">
                                {index + 1}
                              </span>
                              {item.label || item.type}
                            </button>
                          )}
                          <LayerFrameInput
                            label="I"
                            ariaLabel={t('editor.compose.inFrame')}
                            value={item.from}
                            min={0}
                            max={Math.max(0, item.from + item.durationInFrames - 1)}
                            onCommit={(nextFrom) =>
                              updateItem(item.id, {
                                from: nextFrom,
                                durationInFrames: Math.max(
                                  1,
                                  item.from + item.durationInFrames - nextFrom,
                                ),
                              })
                            }
                          />
                          <LayerFrameInput
                            label="O"
                            ariaLabel={t('editor.compose.outFrame')}
                            value={item.from + item.durationInFrames}
                            min={item.from + 1}
                            max={durationInFrames}
                            onCommit={(nextOut) =>
                              updateItem(item.id, {
                                durationInFrames: Math.max(1, nextOut - item.from),
                              })
                            }
                          />
                          <Select
                            value={item.blendMode ?? 'normal'}
                            onValueChange={(value) =>
                              updateItem(item.id, { blendMode: value as BlendMode })
                            }
                          >
                            <SelectTrigger
                              className="h-5 w-24 gap-1 bg-background px-2 text-[9px] text-muted-foreground"
                              aria-label={t('editor.compose.blendMode')}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-72">
                              {ALL_BLEND_MODES.map((mode) => (
                                <SelectItem key={mode} value={mode} className="text-[10px]">
                                  {BLEND_MODE_LABELS[mode]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div
                          data-motion-timeline-lane
                          className="relative min-w-0 flex-1 cursor-default overflow-hidden"
                          onPointerDown={beginPlayheadScrub}
                          onPointerMove={movePlayheadScrub}
                          onPointerUp={endPlayheadScrub}
                          onPointerCancel={endPlayheadScrub}
                        >
                          {Array.from({ length: RULER_DIVISIONS + 1 }, (_, tick) => (
                            <div
                              key={tick}
                              className="pointer-events-none absolute inset-y-0 border-l border-border/45"
                              style={{ left: `${(tick / RULER_DIVISIONS) * 100}%` }}
                            />
                          ))}
                          {!activeInlineCurve ? (
                            <button
                              type="button"
                              data-testid={`motion-layer-span-${item.id}`}
                              onPointerDown={(event) =>
                                !track?.locked &&
                                beginSpanDrag(
                                  event,
                                  selected && !(event.metaKey || event.ctrlKey || event.shiftKey)
                                    ? selectedItemIds
                                    : [item.id],
                                )
                              }
                              onPointerMove={moveSpanDrag}
                              onPointerUp={endSpanDrag}
                              onPointerCancel={endSpanDrag}
                              onClick={(event) => {
                                event.stopPropagation()
                              }}
                              className={cn(
                                'absolute top-1/2 h-5 -translate-y-1/2 touch-none rounded-sm border px-1 text-left text-[9px] shadow-sm transition-colors',
                                track?.locked
                                  ? 'cursor-not-allowed opacity-55'
                                  : 'cursor-grab active:cursor-grabbing',
                                selected
                                  ? 'border-foreground/80 bg-timeline-motion-segment/90 text-foreground'
                                  : 'border-timeline-motion-segment/80 bg-timeline-motion-segment/70 text-foreground hover:bg-timeline-motion-segment/85',
                              )}
                              style={{
                                left: `${frameToMotionPercent(getPreviewFrom(item))}%`,
                                width: `${Math.max(0.6, (getPreviewDuration(item) / visibleFrameRange) * 100)}%`,
                              }}
                              title={`${item.from}–${item.from + item.durationInFrames - 1}`}
                            >
                              {!track?.locked ? (
                                <>
                                  <span
                                    role="slider"
                                    aria-label={`Trim ${item.label || item.type} start`}
                                    aria-valuemin={0}
                                    aria-valuemax={item.from + item.durationInFrames - 1}
                                    aria-valuenow={getPreviewFrom(item)}
                                    tabIndex={-1}
                                    data-testid={`motion-trim-start-${item.id}`}
                                    onPointerDown={(event) => beginSpanTrim(event, item, 'start')}
                                    onPointerMove={moveSpanTrim}
                                    onPointerUp={endSpanTrim}
                                    onPointerCancel={endSpanTrim}
                                    className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize touch-none bg-foreground/10 opacity-70 hover:bg-foreground/25 hover:opacity-100"
                                  />
                                  <span
                                    role="slider"
                                    aria-label={`Trim ${item.label || item.type} end`}
                                    aria-valuemin={item.from + 1}
                                    aria-valuemax={durationInFrames}
                                    aria-valuenow={getPreviewFrom(item) + getPreviewDuration(item)}
                                    tabIndex={-1}
                                    data-testid={`motion-trim-end-${item.id}`}
                                    onPointerDown={(event) => beginSpanTrim(event, item, 'end')}
                                    onPointerMove={moveSpanTrim}
                                    onPointerUp={endSpanTrim}
                                    onPointerCancel={endSpanTrim}
                                    className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize touch-none bg-foreground/10 opacity-70 hover:bg-foreground/25 hover:opacity-100"
                                  />
                                </>
                              ) : null}
                              <span className="pointer-events-none block truncate px-1.5">
                                {item.label || item.type}
                              </span>
                              {hasProceduralMotion ? (
                                <span
                                  data-testid={`motion-procedural-badge-${item.id}`}
                                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border border-sky-300/45 bg-sky-950/75 px-1 font-mono text-[8px] font-semibold text-sky-200"
                                  title={t('timeline.clipIndicators.hasMotion')}
                                >
                                  ƒx
                                </span>
                              ) : null}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </MotionRowContextMenu>

                    {expanded ? (
                      <>
                        {textMotionBands.length > 0 ? (
                          <TextMotionTimelineLanes
                            itemId={item.id}
                            bands={textMotionBands}
                            timeViewport={timeViewport}
                          />
                        ) : null}
                        <MotionDopesheetLanes
                          item={item}
                          properties={properties}
                          compositionDurationInFrames={durationInFrames}
                          fps={fps}
                          canvas={composition}
                          propertyFilter={propertyFilter}
                          timeViewport={timeViewport}
                          inlineCurveProperty={
                            activeInlineCurve?.itemId === item.id
                              ? activeInlineCurve.property
                              : null
                          }
                          onSelectItem={(itemId) => selectItems([itemId])}
                          onInlineCurveChange={(property) => {
                            setInlineCurve(
                              property
                                ? {
                                    compositionId: activeCompositionId,
                                    itemId: item.id,
                                    property,
                                  }
                                : null,
                            )
                          }}
                          onScrub={(frame) => {
                            pause()
                            setScrubFrame(frame)
                          }}
                          onTimeViewportChange={updateTimeViewport}
                        />
                      </>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
        </div>
        {activeInlineCurve && activeCurveItem ? (
          <div
            data-testid="motion-graph-pane"
            className="absolute bottom-0 right-0 z-25 overflow-hidden border-l border-border bg-background"
            style={{ left: TIMELINE_CONTENT_LEFT, top: RULER_HEIGHT }}
          >
            <MotionDopesheetLanes
              item={activeCurveItem}
              properties={activeCurveProperties}
              compositionDurationInFrames={durationInFrames}
              fps={fps}
              canvas={composition}
              propertyFilter={propertyFilter}
              timeViewport={timeViewport}
              inlineCurveProperty={activeInlineCurve.property}
              paneMode="graph"
              onSelectItem={(itemId) => selectItems([itemId])}
              onInlineCurveChange={(property) => {
                setInlineCurve(
                  property
                    ? {
                        compositionId: activeCompositionId,
                        itemId: activeCurveItem.id,
                        property,
                      }
                    : null,
                )
              }}
              onScrub={(frame) => {
                pause()
                setScrubFrame(frame)
              }}
              onTimeViewportChange={updateTimeViewport}
            />
          </div>
        ) : null}
      </div>
      <div className="flex h-5 shrink-0 bg-background/80">
        <div
          className="shrink-0 border-r border-t border-border"
          style={{ width: LAYER_COLUMN_WIDTH }}
        />
        <div
          className="min-w-0 flex-1"
          data-testid="motion-time-navigator"
          data-start-frame={timeViewport.startFrame}
          data-end-frame={timeViewport.endFrame}
        >
          <MotionCompactNavigator
            viewport={timeViewport}
            contentFrameMax={durationInFrames}
            minVisibleFrames={Math.min(10, durationInFrames)}
            onViewportChange={updateTimeViewport}
          />
        </div>
      </div>
    </div>
  )

  return (
    <>
      <section
        className={cn(
          'flex min-h-0 flex-1 overflow-hidden border-t border-border transition-shadow',
          dropActive && 'ring-1 ring-inset ring-primary/60',
          className,
        )}
        data-testid="compositing-timeline"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {layerSheet}
      </section>
      <NewCompositionDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        defaults={dialogDefaults}
      />
    </>
  )
})
