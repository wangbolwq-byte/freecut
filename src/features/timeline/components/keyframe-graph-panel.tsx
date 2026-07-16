/**
 * Keyframe Graph Panel Component
 *
 * Panel that shows the value graph editor for selected items.
 * Integrates with the timeline to provide visual keyframe editing.
 */

import { memo, useState, useCallback, useMemo, useRef, useEffect, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useHotkeys } from 'react-hotkeys-hook'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/shared/ui/cn'
import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/app/error-boundary'
import {
  getCropPropertyValue,
  getTransitionBlockedRanges,
  interpolatePropertyValue,
  getTextAnimatableBaseValue,
  isTextAnimatableProperty,
  buildEasingConfig,
} from '@/features/timeline/deps/keyframes'
import {
  DopesheetEditor,
  getAnimatablePropertiesForItem,
  getEffectPropertyBaseValue,
  buildBakeMotionPlan,
  type ProceduralPreviewInput,
} from '@/features/timeline/deps/keyframe-editors'
import { bakeMotionToKeyframes } from '../stores/actions/motion-modifier-actions'
import { resolveTransform, getSourceDimensions } from '@/features/timeline/deps/composition-runtime'
import { useProjectStore } from '@/features/timeline/deps/projects'
import {
  DEFAULT_PROJECT_FPS,
  DEFAULT_PROJECT_HEIGHT,
  DEFAULT_PROJECT_WIDTH,
} from '@/shared/projects/defaults'
import { useSelectionStore } from '@/shared/state/selection'
import { useItemsStore } from '../stores/items-store'
import { useKeyframesStore } from '../stores/keyframes-store'
import { useTransitionsStore } from '../stores/transitions-store'
import { useKeyframeSelectionStore } from '../stores/keyframe-selection-store'
import { useTimelineCommandStore } from '../stores/timeline-command-store'
import { captureSnapshot } from '../stores/commands/snapshot'
import type { TimelineSnapshot } from '../stores/commands/types'
import { usePlaybackStore } from '@/shared/state/playback'
import { useEditorStore } from '@/shared/state/editor'
import { useTimelineSettingsStore } from '../stores/timeline-settings-store'
import type {
  AnimatableProperty,
  BezierControlPoints,
  EasingConfig,
  EasingType,
  Keyframe,
  KeyframeRef,
} from '@/types/keyframe'
import type { CanvasSettings } from '@/types/transform'
import type { TimelineItem } from '@/types/timeline'
import * as timelineActions from '../stores/timeline-actions'
import { HOTKEY_OPTIONS } from '@/config/hotkeys'
import { useResolvedHotkeys } from '@/features/timeline/deps/settings'
import { isEffectAnimatableProperty } from '@/types/keyframe'
import { buildEffectPropertyResetPlan } from '@/features/timeline/utils/effect-property-reset'

/** Height of the panel header bar in pixels */
const GRAPH_PANEL_HEADER_HEIGHT = 32

/** Height of the resize handle in pixels */
const RESIZE_HANDLE_HEIGHT = 6

/** Default ratio of parent height for the graph content area */
const DEFAULT_PARENT_RATIO = 0.6

/** Minimum content height */
const MIN_CONTENT_HEIGHT = 100

/** Fallback maximum content height when parent size is unknown */
const MAX_CONTENT_HEIGHT_FALLBACK = 500

/** Maximum ratio the panel can occupy of its parent container */
const MAX_PARENT_RATIO = 0.8

interface KeyframeGraphPanelProps {
  /** Whether the panel is open */
  isOpen: boolean
  /** Deprecated: panel no longer collapses from the header */
  onToggle?: () => void
  /** Callback to close the panel */
  onClose: () => void
  /** Where the panel is docked in the layout */
  placement?: 'bottom' | 'top' | 'side'
  /** Side-lane docks stay persistent and should not expose a close affordance. */
  showCloseButton?: boolean
  /**
   * Animate-workspace context: keeps the panel persistent/spacious and unlocks
   * the third "split" view-mode option (sheet + graph stacked) in the toggle.
   * The user still chooses sheet / graph / split; split is no longer forced.
   */
  splitView?: boolean
  /** Whether the Animate workspace has hidden preview chrome for focused editing. */
  isFocusMode?: boolean
  /** Toggle the Animate workspace's focused keyframe layout. */
  onFocusModeChange?: (isFocusMode: boolean) => void
  /** Motion workspace context: a dedicated selected-layer value-curve editor. */
  surface?: 'default' | 'motion'
  /** Initial parameter groups shown by this workspace; users can change them from Parameters. */
  initialVisibleGroupIds?: readonly string[]
  /** Optional property-column width for workspace-specific layouts. */
  propertyColumnWidth?: number
}

type KeyframeEditorMode = 'graph' | 'dopesheet' | 'split'
const KEYFRAME_EDITOR_MODE_STORAGE_KEY = 'timeline:keyframeEditorMode'
const MOTION_INLINE_PROPERTY_GROUP_IDS = ['transform'] as const
const EASING_OPTIONS: Array<{
  value: EasingType
  labelKey: string
  defaultLabel: string
}> = [
  {
    value: 'hold',
    labelKey: 'timeline.keyframeEditor.easing.hold',
    defaultLabel: 'Hold',
  },
  {
    value: 'linear',
    labelKey: 'timeline.keyframeEditor.easing.linear',
    defaultLabel: 'Linear',
  },
  {
    value: 'ease-in',
    labelKey: 'timeline.keyframeEditor.easing.easeIn',
    defaultLabel: 'Ease In',
  },
  {
    value: 'ease-in-out',
    labelKey: 'timeline.keyframeEditor.easing.easeInOut',
    defaultLabel: 'Ease In/Out',
  },
  {
    value: 'ease-out',
    labelKey: 'timeline.keyframeEditor.easing.easeOut',
    defaultLabel: 'Ease Out',
  },
]
function clampFrameToBlockedRanges(
  frame: number,
  initialFrame: number,
  blockedRanges: ReturnType<typeof getTransitionBlockedRanges>,
): number {
  for (const range of blockedRanges) {
    if (frame >= range.start && frame < range.end) {
      if (initialFrame < range.start) return range.start - 1
      if (initialFrame >= range.end) return range.end
      const distToStart = frame - range.start
      const distToEnd = range.end - frame
      return distToStart < distToEnd ? range.start - 1 : range.end
    }
  }
  return frame
}

function getBaseKeyframeValue(
  item: TimelineItem,
  property: AnimatableProperty,
  canvas: CanvasSettings,
): number {
  if (isEffectAnimatableProperty(property)) {
    return getEffectPropertyBaseValue(item, property) ?? 0
  }

  if (property === 'volume') {
    return item.volume ?? 0
  }

  if (item.type === 'text' && isTextAnimatableProperty(property)) {
    return getTextAnimatableBaseValue(item, property)
  }

  if (
    property === 'cropLeft' ||
    property === 'cropRight' ||
    property === 'cropTop' ||
    property === 'cropBottom' ||
    property === 'cropSoftness'
  ) {
    const sourceDimensions = getSourceDimensions(item)
    return getCropPropertyValue(item.crop, property, {
      width: Math.max(1, sourceDimensions?.width ?? item.transform?.width ?? canvas.width),
      height: Math.max(1, sourceDimensions?.height ?? item.transform?.height ?? canvas.height),
    })
  }

  const resolved = resolveTransform(item, canvas, getSourceDimensions(item))
  return property in resolved ? resolved[property as keyof typeof resolved] : 0
}

function useKeyframeEditorPlaybackFrame(
  selectedItemId: string | null,
  editorScrubbingRef: RefObject<boolean>,
): number {
  const [frame, setFrame] = useState(() => usePlaybackStore.getState().currentFrame)
  const frameRef = useRef(frame)

  useEffect(() => {
    const nextFrame = usePlaybackStore.getState().currentFrame
    frameRef.current = nextFrame
    setFrame(nextFrame)
  }, [selectedItemId])

  useEffect(() => {
    let wasPlaying = usePlaybackStore.getState().isPlaying
    let rafId: number | null = null
    let pendingFrame: number | null = null

    // Coalesce rapid scrub updates to one commit per animation frame. Pointer
    // moves can fire several store updates per frame; without this the keyframe
    // editor (dopesheet/graph) re-renders multiple times per displayed frame.
    const flush = () => {
      rafId = null
      if (pendingFrame === null) return
      const nextFrame = pendingFrame
      pendingFrame = null
      if (frameRef.current === nextFrame) return
      frameRef.current = nextFrame
      setFrame(nextFrame)
    }

    const commitFrame = (nextFrame: number) => {
      pendingFrame = nextFrame
      if (rafId === null) {
        rafId = requestAnimationFrame(flush)
      }
    }

    const unsubscribe = usePlaybackStore.subscribe((state) => {
      const nextFrame = state.currentFrame

      if (state.isPlaying) {
        // Keep the (relatively expensive) full editor re-render out of the
        // playback hot path. The playhead line still tracks playback via a
        // self-subscribing overlay (see DopesheetPlayheadLine / GraphPlayhead),
        // which moves it by direct DOM without re-rendering the editor.
        wasPlaying = true
        return
      }

      if (wasPlaying) {
        wasPlaying = false
        commitFrame(nextFrame)
        return
      }

      const isSettledSeek = state.previewFrame === null
      if (isSettledSeek && !editorScrubbingRef.current) {
        commitFrame(nextFrame)
      }
    })

    return () => {
      unsubscribe()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
  }, [editorScrubbingRef, selectedItemId])

  return frame
}

function loadKeyframeEditorMode(): KeyframeEditorMode {
  try {
    const value = localStorage.getItem(KEYFRAME_EDITOR_MODE_STORAGE_KEY)
    if (value === 'graph' || value === 'dopesheet' || value === 'split') {
      return value
    }
  } catch {
    // ignore localStorage read errors
  }
  // Default to the stacked split (dopesheet on top, value graph on bottom) for
  // split-capable surfaces; non-split placements fall back to dopesheet via
  // `effectiveEditorMode`.
  return 'split'
}

/**
 * Panel showing the keyframe value graph editor.
 * Displays graph for the first selected item that has keyframes.
 * Automatically uses full width of container.
 */
export const KeyframeGraphPanel = memo(function KeyframeGraphPanel({
  isOpen,
  onClose,
  placement = 'bottom',
  showCloseButton = true,
  splitView = false,
  isFocusMode = false,
  onFocusModeChange,
  surface = 'default',
  initialVisibleGroupIds,
  propertyColumnWidth,
}: KeyframeGraphPanelProps) {
  const { t } = useTranslation()
  const easingOptions = useMemo(
    () =>
      EASING_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey, { defaultValue: option.defaultLabel }),
      })),
    [t],
  )
  const hotkeys = useResolvedHotkeys()
  // Ref to measure container width
  const containerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [parentHeight, setParentHeight] = useState(0)
  const hasInitialSized = useRef(false)

  // Track content height (user can resize)
  const [contentHeight, setContentHeight] = useState(MIN_CONTENT_HEIGHT)

  // Dynamic max: 80% of parent minus the header and handle chrome
  const chrome = GRAPH_PANEL_HEADER_HEIGHT + RESIZE_HANDLE_HEIGHT
  const maxContentHeight =
    parentHeight > 0
      ? Math.max(MIN_CONTENT_HEIGHT, Math.floor(parentHeight * MAX_PARENT_RATIO) - chrome)
      : MAX_CONTENT_HEIGHT_FALLBACK

  // Set default height to 60% of parent on first measurement
  useEffect(() => {
    if (parentHeight > 0 && !hasInitialSized.current) {
      hasInitialSized.current = true
      const defaultHeight = Math.floor(parentHeight * DEFAULT_PARENT_RATIO) - chrome
      setContentHeight(Math.max(MIN_CONTENT_HEIGHT, Math.min(maxContentHeight, defaultHeight)))
    }
  }, [parentHeight, chrome, maxContentHeight])

  // Resize state
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartY = useRef(0)
  const resizeStartHeight = useRef(0)

  // Measure container width on mount and resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateWidth = () => {
      setContainerWidth(container.clientWidth)
    }

    // Initial measurement
    updateWidth()

    // Use ResizeObserver to track size changes
    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [isOpen]) // Re-measure when panel opens

  // Measure parent height so the panel can cap at MAX_PARENT_RATIO
  useEffect(() => {
    const panel = panelRef.current
    const parent = panel?.parentElement
    if (!parent) return

    const update = () => setParentHeight(parent.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [isOpen])

  // Handle resize drag
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsResizing(true)
      resizeStartY.current = e.clientY
      resizeStartHeight.current = contentHeight
    },
    [contentHeight],
  )

  // Handle resize move and end via document events
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY =
        placement === 'top' ? e.clientY - resizeStartY.current : resizeStartY.current - e.clientY
      const newHeight = Math.min(
        maxContentHeight,
        Math.max(MIN_CONTENT_HEIGHT, resizeStartHeight.current + deltaY),
      )
      setContentHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      // Note: We intentionally do NOT call onHeightChange during resize
      // The timeline panel should only resize when the graph panel is opened/closed,
      // not when the user drags the resize handle within the existing space
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, placement, maxContentHeight])

  // Selected items
  const selectedItemIds = useSelectionStore((s) => s.selectedItemIds)

  const selectedItemForEditor = useItemsStore(
    useCallback(
      (s) => {
        for (const itemId of selectedItemIds) {
          const item = s.itemById[itemId]
          if (item) {
            return item
          }
        }

        return null
      },
      [selectedItemIds],
    ),
  )
  const selectedItemKeyframes = useKeyframesStore(
    useCallback(
      (s) =>
        selectedItemForEditor ? (s.keyframesByItemId[selectedItemForEditor.id] ?? null) : null,
      [selectedItemForEditor],
    ),
  )
  const selectedItemTransitions = useTransitionsStore(
    useShallow(
      useCallback(
        (s) => {
          if (!selectedItemForEditor) return []

          return s.transitions.filter(
            (transition) =>
              transition.leftClipId === selectedItemForEditor.id ||
              transition.rightClipId === selectedItemForEditor.id,
          )
        },
        [selectedItemForEditor],
      ),
    ),
  )

  // Use _updateKeyframe directly (no undo per call) for dragging
  const _updateKeyframe = useKeyframesStore((s) => s._updateKeyframe)
  const _addKeyframe = useKeyframesStore((s) => s._addKeyframe)
  const _removeKeyframesForProperty = useKeyframesStore((s) => s._removeKeyframesForProperty)
  const currentProject = useProjectStore((s) => s.currentProject)
  const setKeyframeEditorShortcutScopeActive = useEditorStore(
    (s) => s.setKeyframeEditorShortcutScopeActive,
  )

  // Ref to store snapshot captured on drag start for undo batching
  const dragSnapshotRef = useRef<TimelineSnapshot | null>(null)
  const valueScrubCreatedKeyframesRef = useRef(new Map<AnimatableProperty, string>())
  const [isPointerWithinEditor, setIsPointerWithinEditor] = useState(false)
  const [isFocusWithinEditor, setIsFocusWithinEditor] = useState(false)

  // Keyframe selection
  const selectedKeyframes = useKeyframeSelectionStore((s) => s.selectedKeyframes)
  const selectKeyframe = useKeyframeSelectionStore((s) => s.selectKeyframe)
  const selectKeyframes = useKeyframeSelectionStore((s) => s.selectKeyframes)
  const clearKeyframeSelection = useKeyframeSelectionStore((s) => s.clearSelection)
  const keyframeClipboard = useKeyframeSelectionStore((s) => s.clipboard)
  const isKeyframeClipboardCut = useKeyframeSelectionStore((s) => s.isCut)
  const copySelectedKeyframes = useKeyframeSelectionStore((s) => s.copySelectedKeyframes)
  const cutSelectedKeyframes = useKeyframeSelectionStore((s) => s.cutSelectedKeyframes)
  const clearKeyframeClipboard = useKeyframeSelectionStore((s) => s.clearClipboard)

  const keyframeEditorScrubbingRef = useRef(false)
  const currentFrame = useKeyframeEditorPlaybackFrame(
    selectedItemForEditor?.id ?? null,
    keyframeEditorScrubbingRef,
  )

  // Track selected property for graph editor
  const [selectedProperty, setSelectedProperty] = useState<AnimatableProperty | null>(null)
  const [editorMode, setEditorMode] = useState<KeyframeEditorMode>(() => loadKeyframeEditorMode())

  useEffect(() => {
    try {
      localStorage.setItem(KEYFRAME_EDITOR_MODE_STORAGE_KEY, editorMode)
    } catch {
      // ignore localStorage write errors
    }
  }, [editorMode])

  // "split" is only offered in the Animate workspace (`splitView`); the docked
  // panel is too short to stack both panes, so a persisted "split" falls back
  // to the dopesheet there.
  const effectiveEditorMode: KeyframeEditorMode =
    surface === 'motion' ? 'graph' : !splitView && editorMode === 'split' ? 'dopesheet' : editorMode

  useEffect(() => {
    if (!isOpen) {
      setIsPointerWithinEditor(false)
      setIsFocusWithinEditor(false)
      setKeyframeEditorShortcutScopeActive(false)
      return
    }

    setKeyframeEditorShortcutScopeActive(isPointerWithinEditor || isFocusWithinEditor)
  }, [isFocusWithinEditor, isOpen, isPointerWithinEditor, setKeyframeEditorShortcutScopeActive])

  useEffect(
    () => () => {
      setKeyframeEditorShortcutScopeActive(false)
    },
    [setKeyframeEditorShortcutScopeActive],
  )

  const canvas = useMemo<CanvasSettings>(
    () => ({
      width: currentProject?.metadata.width ?? DEFAULT_PROJECT_WIDTH,
      height: currentProject?.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
      fps: currentProject?.metadata.fps ?? DEFAULT_PROJECT_FPS,
    }),
    [currentProject],
  )

  const availableProperties = useMemo(
    () => (selectedItemForEditor ? getAnimatablePropertiesForItem(selectedItemForEditor) : []),
    [selectedItemForEditor],
  )

  // Inputs for the dopesheet/graph to draw procedural generators (dashed ghost
  // curves) before they're baked — base transform + active modifiers + canvas.
  const proceduralPreview = useMemo<ProceduralPreviewInput | undefined>(() => {
    if (!selectedItemForEditor) return undefined
    const modifiers =
      selectedItemForEditor.motionModifiers?.filter(
        (modifier) => modifier.enabled && modifier.amplitude > 0,
      ) ?? []
    if (modifiers.length === 0) return undefined
    return {
      base: resolveTransform(
        selectedItemForEditor,
        canvas,
        getSourceDimensions(selectedItemForEditor),
      ),
      modifiers,
      frameWidth: canvas.width,
      frameHeight: canvas.height,
    }
  }, [selectedItemForEditor, canvas])

  // The edited clip can be baked when it carries any procedural motion.
  const canBakeProceduralMotion =
    !!selectedItemForEditor &&
    ((selectedItemForEditor.motionModifiers?.some((modifier) => modifier.enabled) ?? false) ||
      (selectedItemForEditor.effects?.some((effect) => effect.audioPulse?.enabled) ?? false))

  const handleBakeProceduralMotion = useCallback(() => {
    if (!selectedItemForEditor) return
    const plan = buildBakeMotionPlan({
      items: [selectedItemForEditor],
      keyframesByItemId: useKeyframesStore.getState().keyframesByItemId,
      fps: canvas.fps,
      frameWidth: canvas.width,
      frameHeight: canvas.height,
      resolveBase: (item) => resolveTransform(item, canvas, getSourceDimensions(item)),
    })
    if (plan.length === 0) return
    const baked = bakeMotionToKeyframes(plan)
    toast.success(t('timeline.keyframeEditor.motionBaked', { count: baked }))
  }, [selectedItemForEditor, canvas, t])
  const effectiveSelectedProperty = useMemo(
    () =>
      selectedProperty && availableProperties.includes(selectedProperty) ? selectedProperty : null,
    [availableProperties, selectedProperty],
  )

  // Build keyframes by property for the graph editor
  const keyframesByProperty = useMemo(() => {
    if (!selectedItemForEditor) return {}

    const keyframesByPropertyMap = new Map<AnimatableProperty, Keyframe[]>(
      (selectedItemKeyframes?.properties ?? []).map((property) => [
        property.property,
        property.keyframes,
      ]),
    )
    const result: Partial<Record<AnimatableProperty, Keyframe[]>> = {}

    for (const property of availableProperties) {
      result[property] = keyframesByPropertyMap.get(property) ?? []
    }

    return result
  }, [availableProperties, selectedItemForEditor, selectedItemKeyframes])

  // Selected keyframe IDs for the current item
  const selectedKeyframeIds = useMemo(() => {
    if (!selectedItemForEditor) return new Set<string>()

    const ids = new Set<string>()
    for (const ref of selectedKeyframes) {
      if (ref.itemId === selectedItemForEditor.id) {
        ids.add(ref.keyframeId)
      }
    }
    return ids
  }, [selectedKeyframes, selectedItemForEditor])

  const selectedEditorKeyframes = useMemo(() => {
    if (!selectedItemForEditor || !selectedItemKeyframes) return []

    const entries: Array<{ ref: KeyframeRef; keyframe: Keyframe }> = []
    for (const ref of selectedKeyframes) {
      if (ref.itemId !== selectedItemForEditor.id) continue

      const keyframe = selectedItemKeyframes.properties
        .find((property) => property.property === ref.property)
        ?.keyframes.find((candidate) => candidate.id === ref.keyframeId)

      if (keyframe) {
        entries.push({ ref, keyframe })
      }
    }

    return entries
  }, [selectedItemForEditor, selectedItemKeyframes, selectedKeyframes])

  const selectedEditorEasing = useMemo(() => {
    if (selectedEditorKeyframes.length === 0) return undefined

    const firstEasing = selectedEditorKeyframes[0]?.keyframe.easing
    if (!firstEasing) return undefined

    return selectedEditorKeyframes.every(({ keyframe }) => keyframe.easing === firstEasing)
      ? firstEasing
      : undefined
  }, [selectedEditorKeyframes])

  // Calculate relative frame for the current item
  const relativeFrame = useMemo(() => {
    if (!selectedItemForEditor) return 0
    return Math.max(0, currentFrame - selectedItemForEditor.from)
  }, [currentFrame, selectedItemForEditor])

  // Calculate transition-blocked frame ranges for the selected item
  const transitionBlockedRanges = useMemo(() => {
    if (!selectedItemForEditor) return []
    return getTransitionBlockedRanges(
      selectedItemForEditor.id,
      selectedItemForEditor,
      selectedItemTransitions,
    )
  }, [selectedItemForEditor, selectedItemTransitions])

  // Handle drag start - capture snapshot for undo batching
  const handleDragStart = useCallback(() => {
    valueScrubCreatedKeyframesRef.current.clear()
    dragSnapshotRef.current = captureSnapshot()
  }, [])

  // Handle drag end - commit undo entry with pre-captured snapshot
  const handleDragEnd = useCallback(() => {
    const beforeSnapshot = dragSnapshotRef.current
    if (beforeSnapshot) {
      useTimelineCommandStore
        .getState()
        .addUndoEntry({ type: 'MOVE_KEYFRAME_GRAPH', payload: {} }, beforeSnapshot)
      useTimelineSettingsStore.getState().markDirty()
      dragSnapshotRef.current = null
      valueScrubCreatedKeyframesRef.current.clear()
    }
  }, [])

  // Handle keyframe move in graph editor (no undo per call - batched via drag start/end)
  const handleKeyframeMove = useCallback(
    (ref: KeyframeRef, newFrame: number, newValue: number) => {
      const existingKeyframe = selectedItemKeyframes?.properties
        .find((property) => property.property === ref.property)
        ?.keyframes.find((keyframe) => keyframe.id === ref.keyframeId)
      const initialFrame = existingKeyframe?.frame ?? newFrame
      const clampedFrame = clampFrameToBlockedRanges(
        Math.max(0, Math.round(newFrame)),
        initialFrame,
        transitionBlockedRanges,
      )

      _updateKeyframe(ref.itemId, ref.property, ref.keyframeId, {
        frame: clampedFrame,
        value: newValue,
      })
    },
    [_updateKeyframe, selectedItemKeyframes, transitionBlockedRanges],
  )

  const handleBezierHandleMove = useCallback(
    (ref: KeyframeRef, bezier: BezierControlPoints) => {
      const existingKeyframe = selectedItemKeyframes?.properties
        .find((property) => property.property === ref.property)
        ?.keyframes.find((keyframe) => keyframe.id === ref.keyframeId)
      const nextEasing = existingKeyframe?.easing

      _updateKeyframe(ref.itemId, ref.property, ref.keyframeId, {
        easing:
          nextEasing === 'ease-in' ||
          nextEasing === 'ease-out' ||
          nextEasing === 'ease-in-out' ||
          nextEasing === 'linear'
            ? nextEasing
            : 'cubic-bezier',
        easingConfig: {
          type: 'cubic-bezier',
          bezier,
        },
      })
    },
    [_updateKeyframe, selectedItemKeyframes],
  )

  // Apply an easing change from the dopesheet's per-segment popover to explicit
  // keyframe refs. Live drag frames (`commit: false`) go through the no-undo
  // path and are bracketed by handleDragStart/handleDragEnd; everything else
  // commits its own undo entry.
  const handleSegmentEasingChange = useCallback(
    (
      refs: KeyframeRef[],
      updates: { easing: EasingType; easingConfig?: EasingConfig },
      options?: { commit?: boolean },
    ) => {
      if (refs.length === 0) return

      if (options?.commit === false) {
        for (const ref of refs) {
          _updateKeyframe(ref.itemId, ref.property, ref.keyframeId, updates)
        }
        return
      }

      timelineActions.updateKeyframes(
        refs.map((ref) => ({
          itemId: ref.itemId,
          property: ref.property,
          keyframeId: ref.keyframeId,
          updates,
        })),
      )
    },
    // `timelineActions` is an `import * as` module namespace — a stable, immutable
    // reference, so it's intentionally not a dependency (consistent with the
    // other keyframe handlers in this file).
    [_updateKeyframe],
  )

  // Handle selection change in graph editor
  const handleSelectionChange = useCallback(
    (keyframeIds: Set<string>) => {
      if (!selectedItemForEditor) return

      const refs: KeyframeRef[] = []
      for (const id of keyframeIds) {
        // Find which property this keyframe belongs to
        for (const prop of selectedItemKeyframes?.properties ?? []) {
          const kf = prop.keyframes.find((k) => k.id === id)
          if (kf) {
            refs.push({
              itemId: selectedItemForEditor.id,
              property: prop.property,
              keyframeId: id,
            })
            break
          }
        }
      }

      if (refs.length === 0) {
        clearKeyframeSelection()
      } else if (refs.length === 1 && refs[0]) {
        selectKeyframe(refs[0])
      } else if (refs.length > 1) {
        selectKeyframes(refs)
      }
    },
    [
      selectedItemForEditor,
      selectedItemKeyframes,
      clearKeyframeSelection,
      selectKeyframe,
      selectKeyframes,
    ],
  )

  // Handle property change in graph editor
  const handlePropertyChange = useCallback((property: AnimatableProperty | null) => {
    setSelectedProperty(property)
  }, [])

  const handleCopyKeyframes = useCallback(() => {
    if (selectedEditorKeyframes.length === 0) return
    copySelectedKeyframes()
  }, [copySelectedKeyframes, selectedEditorKeyframes.length])

  const handleCutKeyframes = useCallback(() => {
    if (selectedEditorKeyframes.length === 0) return
    cutSelectedKeyframes()
  }, [cutSelectedKeyframes, selectedEditorKeyframes.length])

  const handleSelectedKeyframeEasingChange = useCallback(
    (value: string, easingConfig?: EasingConfig) => {
      if (selectedEditorKeyframes.length === 0) return

      const easing = value as EasingType
      timelineActions.updateKeyframes(
        selectedEditorKeyframes.map(({ ref, keyframe }) => ({
          itemId: ref.itemId,
          property: ref.property,
          keyframeId: ref.keyframeId,
          updates: {
            easing,
            easingConfig: easingConfig ?? buildEasingConfig(easing, keyframe.easingConfig),
          },
        })),
      )
    },
    [selectedEditorKeyframes],
  )

  const handlePasteKeyframes = useCallback(() => {
    if (!selectedItemForEditor || !keyframeClipboard || keyframeClipboard.keyframes.length === 0) {
      return
    }

    const isBlockedFrame = (frame: number) =>
      transitionBlockedRanges.some((range) => frame >= range.start && frame < range.end)

    const anchorFrame = Math.max(
      0,
      Math.min(selectedItemForEditor.durationInFrames - 1, relativeFrame),
    )
    const payloads: Array<{
      itemId: string
      property: AnimatableProperty
      frame: number
      value: number
      easing: EasingType
      easingConfig?: EasingConfig
    }> = []
    let skippedUnsupported = 0
    let skippedBlocked = 0

    keyframeClipboard.keyframes.forEach((keyframe) => {
      if (!availableProperties.includes(keyframe.property)) {
        skippedUnsupported += 1
        return
      }

      const frame = Math.max(
        0,
        Math.min(selectedItemForEditor.durationInFrames - 1, anchorFrame + keyframe.frame),
      )

      if (isBlockedFrame(frame)) {
        skippedBlocked += 1
        return
      }

      payloads.push({
        itemId: selectedItemForEditor.id,
        property: keyframe.property,
        frame,
        value: keyframe.value,
        easing: keyframe.easing,
        easingConfig: keyframe.easingConfig,
      })
    })

    const buildSkipReasons = (): string[] => {
      const reasons: string[] = []
      if (skippedUnsupported > 0) {
        reasons.push(
          t('timeline.keyframeEditor.reasonUnsupported', {
            count: skippedUnsupported,
          }),
        )
      }
      if (skippedBlocked > 0) {
        reasons.push(t('timeline.keyframeEditor.reasonBlocked', { count: skippedBlocked }))
      }
      return reasons
    }

    if (isKeyframeClipboardCut && (skippedUnsupported > 0 || skippedBlocked > 0)) {
      toast.warning(t('timeline.keyframeEditor.unableToPasteCut'), {
        description: t('timeline.keyframeEditor.unableToPasteCutDescription', {
          reasons: buildSkipReasons().join('. '),
        }),
      })
      return
    }

    if (payloads.length === 0) {
      toast.warning(t('timeline.keyframeEditor.noKeyframesPasted'), {
        description: buildSkipReasons().join('. '),
      })
      return
    }

    const insertedIds = timelineActions.addKeyframes(payloads)
    const insertedRefs = insertedIds.map((keyframeId, index) => ({
      itemId: selectedItemForEditor.id,
      property: payloads[index]!.property,
      keyframeId,
    }))

    if (insertedRefs.length > 0) {
      selectKeyframes(insertedRefs)
    } else {
      clearKeyframeSelection()
    }

    if (isKeyframeClipboardCut) {
      clearKeyframeClipboard()
    }

    const pastedCount = insertedRefs.length
    const skippedCount = skippedUnsupported + skippedBlocked
    const summaryText = isKeyframeClipboardCut
      ? t('timeline.keyframeEditor.movedKeyframes', { count: pastedCount })
      : t('timeline.keyframeEditor.pastedKeyframes', { count: pastedCount })

    if (skippedCount > 0) {
      toast.warning(summaryText, {
        description: t('timeline.keyframeEditor.skippedDescription', {
          count: skippedCount,
          reasons: buildSkipReasons().join('. '),
        }),
      })
      return
    }

    toast.success(summaryText)
  }, [
    availableProperties,
    clearKeyframeClipboard,
    clearKeyframeSelection,
    isKeyframeClipboardCut,
    keyframeClipboard,
    relativeFrame,
    selectKeyframes,
    selectedItemForEditor,
    transitionBlockedRanges,
    t,
  ])

  // The view-mode toggle is always visible now, so the hotkeys map to it in
  // every context (including the Animate workspace's split-capable toggle).
  useHotkeys(
    hotkeys.KEYFRAME_EDITOR_GRAPH,
    (event) => {
      event.preventDefault()
      setEditorMode('graph')
    },
    {
      ...HOTKEY_OPTIONS,
      enabled: isOpen && (isPointerWithinEditor || isFocusWithinEditor),
    },
    [isFocusWithinEditor, isOpen, isPointerWithinEditor],
  )

  useHotkeys(
    hotkeys.KEYFRAME_EDITOR_DOPESHEET,
    (event) => {
      event.preventDefault()
      setEditorMode('dopesheet')
    },
    {
      ...HOTKEY_OPTIONS,
      enabled: isOpen && (isPointerWithinEditor || isFocusWithinEditor),
    },
    [isFocusWithinEditor, isOpen, isPointerWithinEditor],
  )

  useHotkeys(
    hotkeys.KEYFRAME_EDITOR_SPLIT,
    (event) => {
      event.preventDefault()
      setEditorMode('split')
    },
    {
      ...HOTKEY_OPTIONS,
      enabled: isOpen && splitView && (isPointerWithinEditor || isFocusWithinEditor),
    },
    [isFocusWithinEditor, isOpen, isPointerWithinEditor, splitView],
  )

  useHotkeys(
    hotkeys.COPY,
    (event) => {
      event.preventDefault()
      handleCopyKeyframes()
    },
    {
      ...HOTKEY_OPTIONS,
      enabled: isOpen && selectedEditorKeyframes.length > 0,
    },
    [handleCopyKeyframes, isOpen, selectedEditorKeyframes.length],
  )

  useHotkeys(
    hotkeys.CUT,
    (event) => {
      event.preventDefault()
      handleCutKeyframes()
    },
    {
      ...HOTKEY_OPTIONS,
      enabled: isOpen && selectedEditorKeyframes.length > 0,
    },
    [handleCutKeyframes, isOpen, selectedEditorKeyframes.length],
  )

  useHotkeys(
    hotkeys.PASTE,
    (event) => {
      event.preventDefault()
      handlePasteKeyframes()
    },
    {
      ...HOTKEY_OPTIONS,
      enabled: isOpen && !!selectedItemForEditor && !!keyframeClipboard,
    },
    [handlePasteKeyframes, isOpen, keyframeClipboard, selectedItemForEditor],
  )

  // Handle scrubbing in graph editor - convert clip-relative frame to absolute frame
  const handleScrub = useCallback(
    (clipRelativeFrame: number) => {
      if (!selectedItemForEditor) return

      // Convert clip-relative frame to absolute frame
      const absoluteFrame = selectedItemForEditor.from + clipRelativeFrame

      // Route editor scrubbing through the preview scrub path so the preview
      // can stay on its fast-scrub presentation instead of doing full seeks.
      usePlaybackStore.getState().setScrubFrame(absoluteFrame, selectedItemForEditor.id)
    },
    [selectedItemForEditor],
  )
  const handleScrubStart = useCallback(() => {
    keyframeEditorScrubbingRef.current = true
    usePlaybackStore.getState().pause()
  }, [])

  const handleScrubEnd = useCallback(() => {
    keyframeEditorScrubbingRef.current = false
    usePlaybackStore.getState().setPreviewFrame(null)
  }, [])

  // Handle adding a keyframe at the current frame
  const handleAddKeyframe = useCallback(
    (property: AnimatableProperty, frame: number) => {
      if (!selectedItemForEditor) return

      const propKeyframes = keyframesByProperty[property] ?? []
      const baseValue = getBaseKeyframeValue(selectedItemForEditor, property, canvas)
      const value = interpolatePropertyValue(propKeyframes, frame, baseValue)

      timelineActions.addKeyframe(selectedItemForEditor.id, property, frame, value)
    },
    [canvas, keyframesByProperty, selectedItemForEditor],
  )
  const handleAddKeyframes = useCallback(
    (entries: Array<{ property: AnimatableProperty; frame: number }>) => {
      if (!selectedItemForEditor || entries.length === 0) return

      const payloads = entries.map(({ property, frame }) => {
        const propKeyframes = keyframesByProperty[property] ?? []
        const baseValue = getBaseKeyframeValue(selectedItemForEditor, property, canvas)
        const value = interpolatePropertyValue(propKeyframes, frame, baseValue)

        return {
          itemId: selectedItemForEditor.id,
          property,
          frame,
          value,
        }
      })

      timelineActions.addKeyframes(payloads)
    },
    [canvas, keyframesByProperty, selectedItemForEditor],
  )
  const handleDuplicateKeyframes = useCallback(
    (entries: Array<{ ref: KeyframeRef; frame: number; value: number }>) => {
      if (!selectedItemForEditor || entries.length === 0) return

      const payloads = entries.flatMap(({ ref, frame, value }) => {
        const sourceKeyframe = keyframesByProperty[ref.property]?.find(
          (keyframe) => keyframe.id === ref.keyframeId,
        )
        if (!sourceKeyframe) {
          return []
        }

        return [
          {
            itemId: selectedItemForEditor.id,
            property: ref.property,
            frame,
            value,
            easing: sourceKeyframe.easing,
            easingConfig: sourceKeyframe.easingConfig,
          },
        ]
      })

      if (payloads.length === 0) return

      const insertedIds = timelineActions.addKeyframes(payloads)
      const insertedRefs = insertedIds.map((keyframeId, index) => ({
        itemId: selectedItemForEditor.id,
        property: payloads[index]!.property,
        keyframeId,
      }))

      if (insertedRefs.length > 0) {
        selectKeyframes(insertedRefs)
      }
    },
    [keyframesByProperty, selectKeyframes, selectedItemForEditor],
  )

  const propertyValues = useMemo(() => {
    if (!selectedItemForEditor) return {}

    const values: Partial<Record<AnimatableProperty, number>> = {}
    for (const property of availableProperties) {
      const propKeyframes = keyframesByProperty[property] ?? []
      let selectedValue: number | undefined
      for (let index = selectedEditorKeyframes.length - 1; index >= 0; index -= 1) {
        const selected = selectedEditorKeyframes[index]!
        if (selected.ref.property === property) {
          selectedValue = selected.keyframe.value
          break
        }
      }
      const baseValue = getBaseKeyframeValue(selectedItemForEditor, property, canvas)
      values[property] =
        selectedValue ?? interpolatePropertyValue(propKeyframes, relativeFrame, baseValue)
    }
    return values
  }, [
    availableProperties,
    canvas,
    keyframesByProperty,
    relativeFrame,
    selectedEditorKeyframes,
    selectedItemForEditor,
  ])

  const handlePropertyValueCommit = useCallback(
    (property: AnimatableProperty, value: number, options?: { allowCreate?: boolean }) => {
      if (!selectedItemForEditor) return

      const selectedPropertyKeyframes = selectedEditorKeyframes.filter(
        ({ ref }) => ref.property === property,
      )
      if (selectedPropertyKeyframes.length > 0) {
        timelineActions.updateKeyframes(
          selectedPropertyKeyframes.map(({ ref }) => ({
            itemId: ref.itemId,
            property: ref.property,
            keyframeId: ref.keyframeId,
            updates: { value },
          })),
        )
        return
      }

      const existingKeyframe = keyframesByProperty[property]?.find(
        (keyframe) => keyframe.frame === relativeFrame,
      )

      if (existingKeyframe) {
        timelineActions.updateKeyframe(selectedItemForEditor.id, property, existingKeyframe.id, {
          value,
        })
        selectKeyframe({
          itemId: selectedItemForEditor.id,
          property,
          keyframeId: existingKeyframe.id,
        })
        return
      }

      if (options?.allowCreate === false) {
        return
      }

      const keyframeId = timelineActions.addKeyframe(
        selectedItemForEditor.id,
        property,
        relativeFrame,
        value,
      )

      if (keyframeId) {
        selectKeyframe({
          itemId: selectedItemForEditor.id,
          property,
          keyframeId,
        })
      }
    },
    [
      keyframesByProperty,
      relativeFrame,
      selectKeyframe,
      selectedEditorKeyframes,
      selectedItemForEditor,
    ],
  )

  const handlePropertyValuePreview = useCallback(
    (property: AnimatableProperty, value: number) => {
      if (!selectedItemForEditor) return

      const selectedRefs = selectedEditorKeyframes
        .filter(({ ref }) => ref.property === property)
        .map(({ ref }) => ref)
      if (selectedRefs.length > 0) {
        for (const ref of selectedRefs) {
          _updateKeyframe(ref.itemId, ref.property, ref.keyframeId, { value })
        }
        return
      }

      const existing = keyframesByProperty[property]?.find(
        (keyframe) => keyframe.frame === relativeFrame,
      )
      let keyframeId = existing?.id ?? valueScrubCreatedKeyframesRef.current.get(property)
      if (!keyframeId) {
        keyframeId = _addKeyframe(selectedItemForEditor.id, property, relativeFrame, value)
        valueScrubCreatedKeyframesRef.current.set(property, keyframeId)
        selectKeyframe({ itemId: selectedItemForEditor.id, property, keyframeId })
      } else {
        _updateKeyframe(selectedItemForEditor.id, property, keyframeId, { value })
      }
    },
    [
      _addKeyframe,
      _updateKeyframe,
      keyframesByProperty,
      relativeFrame,
      selectKeyframe,
      selectedEditorKeyframes,
      selectedItemForEditor,
    ],
  )

  const handleResetPropertiesToDefault = useCallback(
    (properties: AnimatableProperty[]) => {
      if (!selectedItemForEditor || properties.length === 0) return
      const effects = useItemsStore.getState().itemById[selectedItemForEditor.id]?.effects ?? []
      const resetPlan = buildEffectPropertyResetPlan(effects, properties)
      if (resetPlan.resettableProperties.length === 0) return
      const propertySet = new Set(resetPlan.resettableProperties)

      const keyframeState = useKeyframesStore.getState().keyframesByItemId[selectedItemForEditor.id]
      const hasKeyframes = properties.some(
        (property) =>
          (keyframeState?.properties.find((entry) => entry.property === property)?.keyframes
            .length ?? 0) > 0,
      )
      const hasValueChanges = resetPlan.effectUpdates.length > 0
      if (!hasKeyframes && !hasValueChanges) return

      const beforeSnapshot = captureSnapshot()
      for (const property of resetPlan.resettableProperties) {
        _removeKeyframesForProperty(selectedItemForEditor.id, property)
      }
      for (const update of resetPlan.effectUpdates) {
        useItemsStore.getState()._updateEffect(selectedItemForEditor.id, update.effectId, {
          effect: update.effect,
        })
      }
      selectKeyframes(selectedKeyframes.filter((ref) => !propertySet.has(ref.property)))
      useTimelineCommandStore.getState().addUndoEntry(
        {
          type: 'RESET_EFFECT_PROPERTIES',
          payload: { count: resetPlan.resettableProperties.length },
        },
        beforeSnapshot,
      )
      useTimelineSettingsStore.getState().markDirty()
    },
    [_removeKeyframesForProperty, selectKeyframes, selectedItemForEditor, selectedKeyframes],
  )

  // Handle removing keyframes
  const handleRemoveKeyframes = useCallback((refs: KeyframeRef[]) => {
    if (refs.length === 0) return
    timelineActions.removeKeyframes(refs)
  }, [])

  // Handle navigation to a keyframe - convert clip-relative frame to absolute
  const handleNavigateToKeyframe = useCallback(
    (clipRelativeFrame: number) => {
      if (!selectedItemForEditor) return
      const absoluteFrame = selectedItemForEditor.from + clipRelativeFrame
      usePlaybackStore.getState().setCurrentFrame(absoluteFrame)
    },
    [selectedItemForEditor],
  )

  const isSidePlacement = placement === 'side'

  // Clamp content height when max shrinks (e.g. parent resized smaller)
  const clampedContentHeight = Math.min(contentHeight, maxContentHeight)
  const sideContentHeight = Math.max(
    MIN_CONTENT_HEIGHT,
    parentHeight > 0 ? parentHeight - GRAPH_PANEL_HEADER_HEIGHT : MIN_CONTENT_HEIGHT,
  )
  const resolvedContentHeight = isSidePlacement ? sideContentHeight : clampedContentHeight

  // Calculate total panel height for proper flex sizing
  // When closed, show just the header; when open, show header + resize handle + content
  const panelHeight = isOpen
    ? GRAPH_PANEL_HEADER_HEIGHT + RESIZE_HANDLE_HEIGHT + clampedContentHeight
    : GRAPH_PANEL_HEADER_HEIGHT

  const editorWidth = Math.max(0, containerWidth - 16)
  const editorHeight = Math.max(0, resolvedContentHeight - 16)
  // Only render the docked editor when explicitly opened from the toolbar/hotkey.
  // Selecting a clip should not surface the docked panel by itself.
  if (!isOpen) {
    return null
  }

  const resizeHandle = (
    <div
      data-resize-handle
      className={cn(
        'h-1.5 cursor-ns-resize flex items-center justify-center',
        'bg-secondary/30 hover:bg-primary/30 transition-colors',
        isResizing && 'bg-primary/50',
      )}
      onMouseDown={handleResizeStart}
    >
      <div className="w-8 h-0.5 rounded-full bg-muted-foreground/30" />
    </div>
  )

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onPointerEnter={(event) => {
        setIsPointerWithinEditor(true)
        const target = event.currentTarget
        if (!target.contains(document.activeElement)) {
          target.focus({ preventScroll: true })
        }
      }}
      onPointerLeave={() => setIsPointerWithinEditor(false)}
      onFocusCapture={() => setIsFocusWithinEditor(true)}
      onBlurCapture={(event) => {
        const nextFocused = event.relatedTarget as Node | null
        if (event.currentTarget.contains(nextFocused)) {
          return
        }
        setIsFocusWithinEditor(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          if (selectedEditorKeyframes.length > 0) {
            event.preventDefault()
            event.stopPropagation()
            handleRemoveKeyframes(selectedEditorKeyframes.map(({ ref }) => ref))
          }
        }
      }}
      className={cn(
        'flex-shrink-0 bg-background overflow-hidden outline-none',
        isSidePlacement
          ? 'flex h-full min-h-0 flex-col border-0'
          : placement === 'top'
            ? 'border-b border-border'
            : 'border-t border-border',
        isOpen ? 'opacity-100' : 'opacity-90',
        !isSidePlacement && !isResizing && 'transition-all duration-200',
      )}
      style={isSidePlacement ? undefined : { height: panelHeight }}
    >
      {placement === 'bottom' && resizeHandle}

      {/* Header bar - always visible */}
      <div className="h-8 flex items-center justify-between px-3 bg-secondary/30 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {surface === 'motion'
              ? t('editor.compose.motionCurves')
              : t('timeline.keyframeEditor.title')}
            {selectedItemForEditor && (
              <span className="ml-2 text-foreground">
                - {selectedItemForEditor.label || selectedItemForEditor.type}
                <span className="ml-1 text-muted-foreground">
                  ({selectedItemForEditor.id.slice(0, 8)})
                </span>
              </span>
            )}
          </span>
        </div>

        <div
          className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background/50 p-0.5"
          role={surface === 'motion' ? undefined : 'tablist'}
          aria-label={
            surface === 'motion'
              ? t('editor.compose.motionCurves')
              : t('timeline.keyframeEditor.title')
          }
        >
          {surface !== 'motion' && (
            <>
              <Button
                variant={effectiveEditorMode === 'dopesheet' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-[11px]"
                role="tab"
                aria-selected={effectiveEditorMode === 'dopesheet'}
                title={t('timeline.keyframeEditor.legend.sheetMode')}
                aria-label={t('timeline.keyframeEditor.legend.sheetMode')}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditorMode('dopesheet')
                }}
              >
                {t('timeline.keyframeEditor.sheet')}
              </Button>
              <Button
                variant={effectiveEditorMode === 'graph' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-[11px]"
                role="tab"
                aria-selected={effectiveEditorMode === 'graph'}
                title={t('timeline.keyframeEditor.legend.graphMode')}
                aria-label={t('timeline.keyframeEditor.legend.graphMode')}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditorMode('graph')
                }}
              >
                {t('timeline.keyframeEditor.graph')}
              </Button>
              {splitView && (
                <Button
                  variant={effectiveEditorMode === 'split' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  role="tab"
                  aria-selected={effectiveEditorMode === 'split'}
                  title={t('timeline.keyframeEditor.split')}
                  aria-label={t('timeline.keyframeEditor.split')}
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditorMode('split')
                  }}
                >
                  {t('timeline.keyframeEditor.split')}
                </Button>
              )}
            </>
          )}
          {onFocusModeChange && (
            <Button
              variant={isFocusMode ? 'secondary' : 'ghost'}
              size="icon"
              className="ml-0.5 h-6 w-6 p-0"
              title={t(
                isFocusMode
                  ? 'timeline.keyframeEditor.exitFocusMode'
                  : 'timeline.keyframeEditor.enterFocusMode',
              )}
              aria-label={t(
                isFocusMode
                  ? 'timeline.keyframeEditor.exitFocusMode'
                  : 'timeline.keyframeEditor.enterFocusMode',
              )}
              aria-pressed={isFocusMode}
              onClick={(event) => {
                event.stopPropagation()
                onFocusModeChange(!isFocusMode)
              }}
            >
              {isFocusMode ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            </Button>
          )}
          {showCloseButton && (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 p-0"
              aria-label={t('common.close')}
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Keyframe editor content */}
      {isOpen && (
        <div
          ref={containerRef}
          className={cn('min-h-0 p-2', isSidePlacement && 'flex-1')}
          style={isSidePlacement ? undefined : { height: clampedContentHeight }}
        >
          {selectedItemForEditor && containerWidth > 0 ? (
            <>
              <ErrorBoundary level="component">
                <DopesheetEditor
                  itemId={selectedItemForEditor.id}
                  keyframesByProperty={keyframesByProperty}
                  propertyValues={propertyValues}
                  selectedProperty={effectiveSelectedProperty}
                  selectedKeyframeIds={selectedKeyframeIds}
                  currentFrame={relativeFrame}
                  globalFrame={currentFrame}
                  itemFrom={selectedItemForEditor.from}
                  totalFrames={selectedItemForEditor.durationInFrames}
                  fps={canvas.fps}
                  width={editorWidth}
                  height={editorHeight}
                  onKeyframeMove={handleKeyframeMove}
                  onBezierHandleMove={handleBezierHandleMove}
                  onSegmentEasingChange={handleSegmentEasingChange}
                  onSelectionChange={handleSelectionChange}
                  onPropertyChange={handlePropertyChange}
                  onActivePropertyChange={setSelectedProperty}
                  onScrub={handleScrub}
                  onScrubStart={handleScrubStart}
                  onScrubEnd={handleScrubEnd}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onAddKeyframe={handleAddKeyframe}
                  onAddKeyframes={handleAddKeyframes}
                  onDuplicateKeyframes={handleDuplicateKeyframes}
                  onPropertyValueCommit={handlePropertyValueCommit}
                  onPropertyValuePreview={handlePropertyValuePreview}
                  onResetPropertiesToDefault={handleResetPropertiesToDefault}
                  onRemoveKeyframes={handleRemoveKeyframes}
                  onCopyKeyframes={handleCopyKeyframes}
                  onCutKeyframes={handleCutKeyframes}
                  onPasteKeyframes={handlePasteKeyframes}
                  hasKeyframeClipboard={Boolean(keyframeClipboard?.keyframes.length)}
                  isKeyframeClipboardCut={isKeyframeClipboardCut}
                  selectedInterpolation={selectedEditorEasing}
                  interpolationOptions={easingOptions}
                  onInterpolationChange={handleSelectedKeyframeEasingChange}
                  interpolationDisabled={selectedEditorKeyframes.length === 0}
                  onNavigateToKeyframe={handleNavigateToKeyframe}
                  transitionBlockedRanges={transitionBlockedRanges}
                  proceduralPreview={proceduralPreview}
                  canBakeMotion={canBakeProceduralMotion}
                  onBakeMotion={handleBakeProceduralMotion}
                  visualizationMode={effectiveEditorMode}
                  spacious={splitView || surface === 'motion'}
                  inlinePropertyGroupIds={
                    surface === 'motion' ? MOTION_INLINE_PROPERTY_GROUP_IDS : undefined
                  }
                  initialVisibleGroupIds={initialVisibleGroupIds}
                  propertyColumnWidth={propertyColumnWidth}
                  shortcutsEnabled={isPointerWithinEditor || isFocusWithinEditor}
                  shortcuts={{
                    toggleKeyframe: hotkeys.KEYFRAME_TOGGLE,
                    previousKeyframe: hotkeys.KEYFRAME_PREVIOUS,
                    nextKeyframe: hotkeys.KEYFRAME_NEXT,
                    toggleAutoKey: hotkeys.KEYFRAME_TOGGLE_AUTO,
                    fitKeyframes: hotkeys.KEYFRAME_FIT,
                  }}
                />
              </ErrorBoundary>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {selectedItemForEditor
                ? t('common.loading')
                : t('timeline.keyframeEditor.selectItem')}
            </div>
          )}
        </div>
      )}

      {placement === 'top' && resizeHandle}
    </div>
  )
})
