import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { MediaMetadata } from '@/types/storage'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { useClipboardStore } from '@/shared/state/clipboard'
import { useEditorStore } from '@/shared/state/editor'
import {
  makeTimelineTrack,
  resetTimelineCompositionTestState,
  setDefaultRootTimelineTracks,
} from '@/features/editor/deps/timeline-test-helpers-contract'
import {
  useCompositionNavigationStore,
  useCompositionsStore,
  useItemsStore,
  useKeyframesStore,
  useKeyframeSelectionStore,
  useTimelineCommandStore,
  openComposition,
} from '@/features/editor/deps/timeline-motion'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library-contract'
import type { ShapeItem, TimelineItem } from '@/types/timeline'
import { useComposeUiStore } from './compose-ui-store'
import { CompositingTimeline } from './compositing-timeline'

vi.mock('@/features/editor/deps/media-library-contract', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/editor/deps/media-library-contract')>()
  return { ...actual, resolveMediaUrl: vi.fn().mockResolvedValue('blob:motion-media') }
})

function makeDataTransfer(payload: unknown) {
  return {
    getData: (type: string) => (type === 'application/json' ? JSON.stringify(payload) : ''),
    types: ['application/json'],
    dropEffect: 'copy',
  }
}

const track = makeTimelineTrack({ id: 'layer-track', name: 'Rectangle', kind: 'video', order: 0 })
const shape: ShapeItem = {
  id: 'shape-1',
  type: 'shape',
  trackId: track.id,
  from: 0,
  durationInFrames: 120,
  label: 'Hero rectangle',
  shapeType: 'rectangle',
  fillColor: '#22d3ee',
  strokeWidth: 0,
  transform: { x: 100, y: 80, width: 400, height: 220, rotation: 0, opacity: 1 },
}

describe('CompositingTimeline', () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {}
    }
    resetTimelineCompositionTestState()
    useCompositionNavigationStore.getState().resetToRoot()
    setDefaultRootTimelineTracks()
    useItemsStore.getState().setItems([])
    useCompositionsStore.getState().addComposition({
      id: 'comp-1',
      name: 'Motion title',
      editorKind: 'composite-2d',
      tracks: [track],
      items: [shape],
      transitions: [],
      keyframes: [],
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 120,
    })
    useCompositionNavigationStore.getState().switchToSequence('comp-1')
    useMediaLibraryStore.setState({ mediaItems: [], mediaById: {} })
    useComposeUiStore.setState({
      expandedLayerIdsByComposition: {},
      lastOpenedCompositionId: null,
      motionReturnTabCaptured: false,
      motionReturnTabId: null,
    })
    useEditorStore.getState().setWorkspace('motion')
    useClipboardStore.setState({ itemsClipboard: null, transitionClipboard: null })
    useEditorStore.getState().setKeyframeEditorShortcutScopeActive(false)
    useKeyframeSelectionStore.getState().clearSelection()
  })

  afterEach(() => {
    cleanup()
    resetTimelineCompositionTestState()
  })

  it('keeps the Motion layer header and expands classic dope-sheet child rows', () => {
    render(<CompositingTimeline />)

    expect(screen.getByTestId('compositing-timeline')).toBeInTheDocument()
    expect(screen.getAllByText('Hero rectangle')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    expect(screen.getByText('X Position')).toBeInTheDocument()
    expect(screen.getByText('Opacity')).toBeInTheDocument()
    expect(
      screen.getByRole('spinbutton', { name: /x position value at playhead/i }),
    ).toBeInTheDocument()
  })

  it('uses a light border and readable text for the selected segment', () => {
    useSelectionStore.getState().selectItems([shape.id])
    render(<CompositingTimeline />)

    expect(screen.getByTestId(`motion-layer-span-${shape.id}`)).toHaveClass(
      'border-foreground/80',
      'text-foreground',
    )
  })

  it('shows generated motion on the parent span and its driven child properties', () => {
    useItemsStore.getState().setItems([
      {
        ...shape,
        from: 15,
        durationInFrames: 60,
        motionModifiers: [
          {
            id: 'drift-1',
            type: 'float-drift',
            enabled: true,
            amplitude: 1,
            frequency: 0.6,
            phaseFrames: 0,
            seed: 1,
          },
        ],
      },
    ])

    render(<CompositingTimeline />)

    expect(screen.getByTestId(`motion-procedural-badge-${shape.id}`)).toHaveTextContent('ƒx')
    expect(screen.queryByTestId(`motion-procedural-summary-${shape.id}`)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    expect(screen.getByTestId('procedural-band-x')).toHaveAttribute('data-from-frame', '15')
    expect(screen.getByTestId('procedural-band-x')).toHaveAttribute('data-to-frame', '74')
    expect(screen.getByTestId('procedural-band-y')).toBeInTheDocument()
    expect(screen.getByTestId('procedural-band-rotation')).toBeInTheDocument()
  })

  it('shows procedural text-motion slots on collapsed and expanded text layers', () => {
    useItemsStore.getState().setItems([
      {
        ...shape,
        type: 'text',
        text: 'New Motion Editor',
        color: '#ffffff',
        from: 18,
        durationInFrames: 69,
        textMotion: {
          in: {
            presetId: 'blur-in',
            durationFrames: 14,
            staggerFrames: 3,
            intensity: 1,
            order: 'forward',
            easing: 'ease-out',
            seed: 0,
            unit: 'word',
          },
          out: {
            presetId: 'sink',
            durationFrames: 14,
            staggerFrames: 4,
            intensity: 1,
            order: 'forward',
            easing: 'ease-in',
            seed: 0,
            unit: 'word',
          },
        },
      } as TimelineItem,
    ])

    render(<CompositingTimeline />)

    expect(screen.getByTestId(`motion-procedural-badge-${shape.id}`)).toHaveTextContent('ƒx')
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    expect(screen.getByTestId('motion-text-procedural-lanes')).toBeInTheDocument()
    expect(screen.getByTestId('motion-text-procedural-band-in')).toHaveAttribute(
      'data-from-frame',
      '18',
    )
    expect(screen.getByTestId('motion-text-procedural-band-out')).toHaveAttribute(
      'data-to-frame',
      '87',
    )

    const inBand = screen.getByTestId('motion-text-procedural-band-in')
    expect(inBand).toHaveClass('h-4')
    expect(inBand.parentElement?.parentElement).toHaveClass('h-7')
    useSelectionStore.getState().clearSelection()
    useEditorStore.getState().setRightSidebarOpen(false)
    useEditorStore.getState().setClipInspectorTab('video')
    fireEvent.click(inBand)
    expect(useSelectionStore.getState().selectedItemIds).toEqual([shape.id])
    expect(useEditorStore.getState().rightSidebarOpen).toBe(true)
    expect(useEditorStore.getState().clipInspectorTab).toBe('audio')

    vi.spyOn(inBand.parentElement!, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 24,
      width: 300,
      height: 24,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(inBand, { pointerId: 21, button: 0, clientX: 100 })
    fireEvent.pointerMove(inBand, { pointerId: 21, buttons: 1, clientX: 130 })
    fireEvent.pointerUp(inBand, { pointerId: 21, clientX: 130 })

    const updated = useItemsStore.getState().itemById[shape.id]
    expect(updated?.type === 'text' ? updated.textMotion?.in?.durationFrames : null).toBe(26)
  })

  it('uses one shared flag-and-line playhead and supports continuous ruler scrubbing', () => {
    render(<CompositingTimeline />)
    const playhead = screen.getByTestId('motion-playhead')
    expect(screen.getAllByTestId('motion-playhead')).toHaveLength(1)
    expect(playhead.querySelectorAll('span')).toHaveLength(2)
    expect(playhead.querySelector('[data-playhead-mark="handle"]')).not.toHaveClass('sticky')
    expect(playhead.parentElement).toHaveStyle({ left: '510px', right: '9px' })
    expect(playhead.parentElement).toHaveClass('overflow-visible')
    expect(playhead.parentElement).toHaveClass('inset-y-0')
    expect(playhead.parentElement).not.toHaveClass('h-[100vh]')
    expect(playhead.parentElement?.parentElement).toHaveClass('absolute', 'inset-0')
    expect(playhead.parentElement?.parentElement?.parentElement).toHaveClass(
      'relative',
      'min-h-0',
      'flex-1',
    )
    expect(screen.getByTestId(`motion-layer-span-${shape.id}`).parentElement).toHaveClass(
      'overflow-hidden',
    )

    const ruler = screen.getByText('0.0s').parentElement!.parentElement!
    vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 28,
      width: 300,
      height: 28,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(ruler, { pointerId: 1, button: 0, clientX: 0 })
    fireEvent.pointerMove(ruler, { pointerId: 1, buttons: 1, clientX: 150 })
    fireEvent.pointerUp(ruler, { pointerId: 1, clientX: 150 })

    expect(usePlaybackStore.getState().currentFrame).toBe(60)
  })

  it('batches ruler scrub movement to the latest pointer position per animation frame', () => {
    const frameCallbacks: FrameRequestCallback[] = []
    const animationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
    render(<CompositingTimeline />)
    const ruler = screen.getByText('0.0s').parentElement!.parentElement!
    vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 28,
      width: 300,
      height: 28,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(ruler, { pointerId: 2, button: 0, clientX: 0 })
    fireEvent.pointerMove(ruler, { pointerId: 2, buttons: 1, clientX: 75 })
    fireEvent.pointerMove(ruler, { pointerId: 2, buttons: 1, clientX: 150 })

    expect(frameCallbacks).toHaveLength(1)
    expect(usePlaybackStore.getState().currentFrame).toBe(0)
    act(() => frameCallbacks.shift()?.(performance.now()))
    expect(usePlaybackStore.getState().currentFrame).toBe(0)
    expect(usePlaybackStore.getState().previewFrame).toBe(60)

    fireEvent.pointerUp(ruler, { pointerId: 2, clientX: 150 })
    expect(usePlaybackStore.getState().currentFrame).toBe(60)
    expect(usePlaybackStore.getState().previewFrame).toBeNull()
    animationFrameSpy.mockRestore()
  })

  it('keeps expanded property editors render-idle until a scrub settles', () => {
    useKeyframesStore.getState()._addKeyframe(shape.id, 'x', 0, 100)
    useKeyframesStore.getState()._addKeyframe(shape.id, 'x', 60, 300)
    const frameCallbacks: FrameRequestCallback[] = []
    const animationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })

    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    const input = screen.getByRole('spinbutton', { name: 'X Position value at playhead' })
    const ruler = screen.getByText('0.0s').parentElement!.parentElement!
    vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 28,
      width: 300,
      height: 28,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(ruler, { pointerId: 3, button: 0, clientX: 0 })
    fireEvent.pointerMove(ruler, { pointerId: 3, buttons: 1, clientX: 150 })
    act(() => frameCallbacks.shift()?.(performance.now()))

    expect(usePlaybackStore.getState().previewFrame).toBe(60)
    expect(input).toHaveValue(100)

    fireEvent.pointerUp(ruler, { pointerId: 3, clientX: 150 })
    expect(input).toHaveValue(300)
    animationFrameSpy.mockRestore()
  })

  it('keeps ctrl-wheel zoom while leaving ordinary wheel input to vertical scrolling', () => {
    render(<CompositingTimeline />)
    const scrollArea = screen.getByTestId('motion-layer-scroll-area')
    vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    })

    expect(screen.getByTestId('motion-time-navigator')).toHaveAttribute('data-start-frame', '0')
    expect(screen.getByTestId('motion-time-navigator')).toHaveAttribute('data-end-frame', '120')
    expect(screen.getByText('0.0s')).toBeInTheDocument()
    expect(screen.getByText('4.0s')).toBeInTheDocument()

    fireEvent.wheel(scrollArea, { ctrlKey: true, clientX: 750, deltaY: -100 })

    expect(screen.getByText('0.4s')).toBeInTheDocument()
    expect(screen.getByText('3.6s')).toBeInTheDocument()
    expect(screen.queryByText('4.0s')).not.toBeInTheDocument()

    const panEvent = createEvent.wheel(scrollArea, {
      clientX: 750,
      deltaY: 100,
      cancelable: true,
    })
    fireEvent(scrollArea, panEvent)

    expect(panEvent.defaultPrevented).toBe(false)
    expect(screen.getByText('0.4s')).toBeInTheDocument()
    expect(screen.getByText('3.6s')).toBeInTheDocument()
    expect(scrollArea).toHaveClass('overflow-y-auto')
  })

  it('does not pan the time viewport for ordinary mixed-axis wheel input', () => {
    render(<CompositingTimeline />)
    const scrollArea = screen.getByTestId('motion-layer-scroll-area')
    vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    })
    const navigator = screen.getByTestId('motion-time-navigator')

    fireEvent.wheel(scrollArea, { ctrlKey: true, clientX: 750, deltaY: -100 })
    expect(navigator).toHaveAttribute('data-start-frame', '12')
    expect(navigator).toHaveAttribute('data-end-frame', '108')

    const wheelEvent = createEvent.wheel(scrollArea, {
      clientX: 750,
      deltaX: -1,
      deltaY: 25,
      cancelable: true,
    })
    fireEvent(scrollArea, wheelEvent)

    expect(wheelEvent.defaultPrevented).toBe(false)
    expect(navigator).toHaveAttribute('data-start-frame', '12')
    expect(navigator).toHaveAttribute('data-end-frame', '108')
  })

  it('accumulates shift-wheel horizontal panning without cross-axis reversal or frame jumps', () => {
    render(<CompositingTimeline />)
    const scrollArea = screen.getByTestId('motion-layer-scroll-area')
    vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    })
    const navigator = screen.getByTestId('motion-time-navigator')

    fireEvent.wheel(scrollArea, { ctrlKey: true, clientX: 750, deltaY: -100 })
    const firstPan = createEvent.wheel(scrollArea, {
      shiftKey: true,
      clientX: 750,
      deltaX: -1,
      deltaY: 1,
      cancelable: true,
    })
    fireEvent(scrollArea, firstPan)
    fireEvent.wheel(scrollArea, { shiftKey: true, clientX: 750, deltaX: -1, deltaY: 1 })

    expect(firstPan.defaultPrevented).toBe(true)
    expect(Number(navigator.dataset.startFrame)).toBeCloseTo(12.384)
    expect(Number(navigator.dataset.endFrame)).toBeCloseTo(108.384)

    fireEvent.wheel(scrollArea, { shiftKey: true, clientX: 750, deltaX: -100, deltaY: 10 })
    expect(Number(navigator.dataset.startFrame)).toBeCloseTo(14.304)
    expect(Number(navigator.dataset.endFrame)).toBeCloseTo(110.304)
  })

  it('accumulates rapid mouse-wheel zoom around the cursor without treating horizontal input as zoom', () => {
    render(<CompositingTimeline />)
    const scrollArea = screen.getByTestId('motion-layer-scroll-area')
    vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    })
    const navigator = screen.getByTestId('motion-time-navigator')

    act(() => {
      scrollArea.dispatchEvent(
        createEvent.wheel(scrollArea, {
          ctrlKey: true,
          clientX: 750,
          deltaY: -100,
          cancelable: true,
        }),
      )
      scrollArea.dispatchEvent(
        createEvent.wheel(scrollArea, {
          ctrlKey: true,
          clientX: 750,
          deltaY: -100,
          cancelable: true,
        }),
      )
    })

    expect(navigator).toHaveAttribute('data-start-frame', '22')
    expect(navigator).toHaveAttribute('data-end-frame', '99')

    const horizontalEvent = createEvent.wheel(scrollArea, {
      ctrlKey: true,
      clientX: 750,
      deltaX: 100,
      deltaY: 0,
      cancelable: true,
    })
    fireEvent(scrollArea, horizontalEvent)

    expect(horizontalEvent.defaultPrevented).toBe(true)
    expect(navigator).toHaveAttribute('data-start-frame', '22')
    expect(navigator).toHaveAttribute('data-end-frame', '99')
  })

  it('handles ctrl-wheel zoom after the app-level browser zoom guard prevents the event', () => {
    render(<CompositingTimeline />)
    const scrollArea = screen.getByTestId('motion-layer-scroll-area')
    vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    })
    const navigator = screen.getByTestId('motion-time-navigator')
    const guardedEvent = createEvent.wheel(scrollArea, {
      ctrlKey: true,
      clientX: 750,
      deltaY: -100,
      cancelable: true,
    })

    // App.tsx prevents native browser zoom during document capture before the
    // Motion timeline receives this same event.
    guardedEvent.preventDefault()
    fireEvent(scrollArea, guardedEvent)

    expect(guardedEvent.defaultPrevented).toBe(true)
    expect(navigator).toHaveAttribute('data-start-frame', '12')
    expect(navigator).toHaveAttribute('data-end-frame', '108')
  })

  it('uses middle-mouse drag to move the layer list vertically without changing selection', () => {
    render(<CompositingTimeline />)
    const scrollArea = screen.getByTestId('motion-layer-scroll-area')
    vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    })
    useSelectionStore.getState().clearSelection()
    scrollArea.scrollTop = 100

    const span = screen.getByTestId(`motion-layer-span-${shape.id}`)
    fireEvent.pointerDown(span, { button: 1, buttons: 4, pointerId: 7, clientX: 800, clientY: 200 })
    fireEvent.pointerMove(window, { buttons: 4, pointerId: 7, clientX: 700, clientY: 300 })

    expect(useSelectionStore.getState().selectedItemIds).toEqual([])
    expect(useKeyframeSelectionStore.getState().selectedKeyframes).toEqual([])
    expect(scrollArea.scrollTop).toBe(200)
    expect(screen.getByText('0.0s')).toBeInTheDocument()
    expect(screen.getByText('4.0s')).toBeInTheDocument()

    fireEvent.pointerUp(window, { button: 1, pointerId: 7, clientX: 700, clientY: 300 })
    expect(document.body.style.cursor).toBe('')
  })

  it('adds an undoable property keyframe at the shared playhead', () => {
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    fireEvent.click(screen.getByRole('button', { name: /toggle x position keyframe at playhead/i }))

    const itemKeyframes = useKeyframesStore.getState().keyframesByItemId[shape.id]
    expect(itemKeyframes?.properties[0]?.keyframes).toEqual([
      expect.objectContaining({ frame: 0, value: 100 }),
    ])

    useTimelineCommandStore.getState().undo()
    expect(useKeyframesStore.getState().keyframesByItemId[shape.id]).toBeUndefined()
  })

  it('does not create a keyframe when a property input is only focused and blurred', () => {
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))

    const input = screen.getByRole('spinbutton', { name: 'X Position value at playhead' })
    fireEvent.focus(input)
    fireEvent.blur(input)

    expect(useKeyframesStore.getState().keyframesByItemId[shape.id]).toBeUndefined()
  })

  it('keeps expanded property editors off the playback-frame render path', () => {
    useKeyframesStore.getState()._addKeyframe(shape.id, 'x', 0, 100)
    useKeyframesStore.getState()._addKeyframe(shape.id, 'x', 60, 300)
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))

    const input = screen.getByRole('spinbutton', { name: 'X Position value at playhead' })
    expect(input).toHaveValue(100)

    act(() => {
      usePlaybackStore.getState().play()
      usePlaybackStore.getState().setCurrentFrame(60)
    })
    expect(input).toHaveValue(100)

    act(() => usePlaybackStore.getState().pause())
    expect(input).toHaveValue(300)
  })

  it('edits a selected keyframe before creating one at the playhead', () => {
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    fireEvent.click(screen.getByRole('button', { name: /toggle x position keyframe at playhead/i }))

    const firstKeyframe =
      useKeyframesStore.getState().keyframesByItemId[shape.id]!.properties[0]!.keyframes[0]!
    useKeyframesStore.getState()._addKeyframe(shape.id, 'x', 60, 300)
    useKeyframeSelectionStore
      .getState()
      .selectKeyframes([{ itemId: shape.id, property: 'x', keyframeId: firstKeyframe.id }])
    act(() => usePlaybackStore.getState().setCurrentFrame(60))

    let input = screen.getByRole('spinbutton', { name: 'X Position value at playhead' })
    expect(input).toHaveValue(100)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '180' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    let keyframes =
      useKeyframesStore.getState().keyframesByItemId[shape.id]!.properties[0]!.keyframes
    expect(keyframes).toEqual([
      expect.objectContaining({ frame: 0, value: 180 }),
      expect.objectContaining({ frame: 60, value: 300 }),
    ])

    useKeyframeSelectionStore.getState().clearSelection()
    act(() => usePlaybackStore.getState().setCurrentFrame(90))
    input = screen.getByRole('spinbutton', { name: 'X Position value at playhead' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '220' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    keyframes = useKeyframesStore.getState().keyframesByItemId[shape.id]!.properties[0]!.keyframes
    expect(keyframes).toEqual([
      expect.objectContaining({ frame: 0, value: 180 }),
      expect.objectContaining({ frame: 60, value: 300 }),
      expect.objectContaining({ frame: 90, value: 220 }),
    ])
  })

  it('deletes selected diamonds without deleting the selected layer', async () => {
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    fireEvent.click(screen.getByRole('button', { name: /toggle x position keyframe at playhead/i }))

    const keyframe =
      useKeyframesStore.getState().keyframesByItemId[shape.id]!.properties[0]!.keyframes[0]!
    useKeyframeSelectionStore
      .getState()
      .selectKeyframes([{ itemId: shape.id, property: 'x', keyframeId: keyframe.id }])

    const marker = await screen.findByTestId(`row-keyframe-x-${keyframe.id}`)
    fireEvent.pointerEnter(marker)
    expect(useEditorStore.getState().keyframeEditorShortcutScopeActive).toBe(true)
    fireEvent.keyDown(marker, { key: 'Delete' })

    await waitFor(() => {
      expect(
        useKeyframesStore.getState().keyframesByItemId[shape.id]?.properties[0]?.keyframes,
      ).toHaveLength(0)
    })
    expect(useItemsStore.getState().itemById[shape.id]).toBeDefined()
  })

  it('switches the whole right timeline pane to the selected property graph', () => {
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    expect(screen.getByTestId(`motion-layer-span-${shape.id}`)).toBeInTheDocument()

    const rowBefore = screen.getByText('X Position').closest('.group')
    expect(rowBefore).not.toHaveClass('pl-6')
    expect(screen.getByTestId('motion-layer-scroll-area')).toHaveClass(
      'overflow-x-hidden',
      'overflow-y-auto',
    )
    expect(screen.getByRole('spinbutton', { name: /x position value at playhead/i })).toHaveClass(
      'w-[80px]',
    )

    const curveButton = screen.getByRole('button', { name: /show x position curve/i })
    expect(curveButton).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(curveButton)

    expect(screen.getByTestId('dopesheet-graph-pane')).toBeInTheDocument()
    expect(screen.getByTestId('motion-graph-pane')).toHaveStyle({
      left: '501px',
      top: '28px',
    })
    expect(screen.getByTestId('motion-graph-pane')).toHaveClass('bottom-0', 'right-0')
    expect(screen.queryByTestId(`motion-layer-span-${shape.id}`)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show x position curve/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByText('Motion curves')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /sheet/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /graph/i })).not.toBeInTheDocument()
    expect(screen.getByText('X Position').closest('.group')).not.toHaveClass('pl-6')

    fireEvent.click(screen.getByRole('button', { name: /show x position curve/i }))
    expect(screen.queryByTestId('dopesheet-graph-pane')).not.toBeInTheDocument()
    expect(screen.queryByTestId('motion-graph-pane')).not.toBeInTheDocument()
    expect(screen.getByTestId(`motion-layer-span-${shape.id}`)).toBeInTheDocument()
  })

  it('filters expanded rows to animated properties and exposes classic segment easing', async () => {
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    fireEvent.click(screen.getByRole('button', { name: /toggle x position keyframe at playhead/i }))
    act(() => usePlaybackStore.getState().setCurrentFrame(60))
    fireEvent.click(
      await screen.findByRole('button', { name: /toggle x position keyframe at playhead/i }),
    )

    const easingTrigger = await screen.findByRole('button', { name: 'Easing' })
    fireEvent.click(easingTrigger)
    expect(await screen.findByText('Cubic Easing')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('combobox', { name: 'Property filter' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Animated properties' }))
    expect(screen.getByText('X Position')).toBeInTheDocument()
    expect(screen.queryByText('Y Position')).not.toBeInTheDocument()
  }, 10_000)

  it('hides the expanded child area when no properties are animated', async () => {
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand layer properties' }))
    expect(screen.getByText('X Position')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('combobox', { name: 'Property filter' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Animated properties' }))

    expect(screen.queryByText('X Position')).not.toBeInTheDocument()
    expect(screen.queryByText('No parameters match the current view')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Collapse layer properties' }),
    ).not.toBeInTheDocument()
  })

  it('exposes layer actions in the context menu and renames inline', async () => {
    render(<CompositingTimeline />)
    const layerName = screen.getByRole('button', { name: /1hero rectangle/i })
    fireEvent.contextMenu(layerName)
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Paste' })).toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.doubleClick(layerName)

    const nameInput = screen.getByRole('textbox', { name: 'Layer name' })
    fireEvent.change(nameInput, { target: { value: 'Renamed rectangle' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(useItemsStore.getState().itemById[shape.id]?.label).toBe('Renamed rectangle')
  })

  it('preserves a multi-selection when grouping from a selected layer context menu', async () => {
    const secondTrack = makeTimelineTrack({
      id: 'layer-track-2',
      name: 'Circle',
      kind: 'video',
      order: 1,
    })
    const secondShape: ShapeItem = {
      ...shape,
      id: 'shape-2',
      trackId: secondTrack.id,
      label: 'Circle',
    }
    useItemsStore.getState().setTracks([track, secondTrack])
    useItemsStore.getState().setItems([shape, secondShape])
    useSelectionStore.getState().selectItems([shape.id, secondShape.id])
    render(<CompositingTimeline />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /2circle/i }))

    expect(useSelectionStore.getState().selectedItemIds).toEqual([shape.id, secondShape.id])
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Group selected layers' }))

    expect(useItemsStore.getState().tracks.filter((candidate) => candidate.isGroup)).toHaveLength(1)
  })

  it('creates a dedicated backing track when adding a generated layer', () => {
    render(<CompositingTimeline />)
    fireEvent.click(screen.getByTitle('Add text layer'))

    const state = useItemsStore.getState()
    const textLayer = state.items.find((item) => item.type === 'text')
    expect(textLayer).toBeDefined()
    expect(state.tracks.find((candidate) => candidate.id === textLayer?.trackId)?.name).toBe(
      textLayer?.label,
    )
  })

  it('uses Ctrl to toggle layers and Shift to add a visible layer range', () => {
    const secondTrack = makeTimelineTrack({
      id: 'layer-track-2',
      name: 'Circle',
      kind: 'video',
      order: 1,
    })
    const thirdTrack = makeTimelineTrack({
      id: 'layer-track-3',
      name: 'Triangle',
      kind: 'video',
      order: 2,
    })
    const secondShape: ShapeItem = {
      ...shape,
      id: 'shape-2',
      trackId: secondTrack.id,
      label: 'Circle',
    }
    const thirdShape: ShapeItem = {
      ...shape,
      id: 'shape-3',
      trackId: thirdTrack.id,
      label: 'Triangle',
    }
    useItemsStore.getState().setTracks([track, secondTrack, thirdTrack])
    useItemsStore.getState().setItems([shape, secondShape, thirdShape])
    render(<CompositingTimeline />)

    const first = screen.getByRole('button', { name: /1hero rectangle/i })
    const second = screen.getByRole('button', { name: /2circle/i })
    const third = screen.getByRole('button', { name: /3triangle/i })

    fireEvent.click(first)
    fireEvent.click(third, { ctrlKey: true })
    expect(useSelectionStore.getState().selectedItemIds).toEqual([shape.id, thirdShape.id])

    fireEvent.click(third, { ctrlKey: true })
    expect(useSelectionStore.getState().selectedItemIds).toEqual([shape.id])

    fireEvent.click(first)
    fireEvent.click(third, { shiftKey: true })
    expect(useSelectionStore.getState().selectedItemIds).toEqual([
      shape.id,
      secondShape.id,
      thirdShape.id,
    ])
    expect(second).toBeInTheDocument()
  })

  it('drags a layer span in time and commits one undoable move', () => {
    render(<CompositingTimeline />)
    usePlaybackStore.setState({ currentFrame: 40, previewFrame: null })
    const span = screen.getByTestId(`motion-layer-span-${shape.id}`)
    vi.spyOn(span.parentElement!, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 34,
      width: 300,
      height: 34,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(span, { pointerId: 1, button: 0, clientX: 0 })
    fireEvent.pointerMove(span, { pointerId: 1, buttons: 1, clientX: 30 })
    fireEvent.pointerUp(span, { pointerId: 1, clientX: 30 })

    expect(useItemsStore.getState().itemById[shape.id]?.from).toBe(12)
    expect(usePlaybackStore.getState().currentFrame).toBe(40)
    expect(usePlaybackStore.getState().previewFrame).toBeNull()
    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().itemById[shape.id]?.from).toBe(0)
  })

  it('trims a layer span from either edge and keeps each drag undoable', () => {
    useItemsStore.getState().setItems([{ ...shape, from: 10, durationInFrames: 60 }])
    render(<CompositingTimeline />)
    const startHandle = screen.getByTestId(`motion-trim-start-${shape.id}`)
    const endHandle = screen.getByTestId(`motion-trim-end-${shape.id}`)
    const lane = screen.getByTestId(`motion-layer-span-${shape.id}`).parentElement!
    vi.spyOn(lane, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 34,
      width: 300,
      height: 34,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(endHandle, { pointerId: 4, button: 0, clientX: 200 })
    fireEvent.pointerMove(endHandle, { pointerId: 4, clientX: 170 })
    fireEvent.pointerUp(endHandle, { pointerId: 4, clientX: 170 })

    expect(useItemsStore.getState().itemById[shape.id]).toMatchObject({
      from: 10,
      durationInFrames: 48,
    })

    fireEvent.pointerDown(startHandle, { pointerId: 5, button: 0, clientX: 25 })
    fireEvent.pointerMove(startHandle, { pointerId: 5, clientX: 40 })
    fireEvent.pointerUp(startHandle, { pointerId: 5, clientX: 40 })

    expect(useItemsStore.getState().itemById[shape.id]).toMatchObject({
      from: 16,
      durationInFrames: 42,
    })
    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().itemById[shape.id]).toMatchObject({
      from: 10,
      durationInFrames: 48,
    })
  })

  it('reorders layers from the three-dot handle in one undo step', () => {
    const secondTrack = makeTimelineTrack({
      id: 'layer-track-2',
      name: 'Circle',
      kind: 'video',
      order: 1,
    })
    const secondShape: ShapeItem = {
      ...shape,
      id: 'shape-2',
      trackId: secondTrack.id,
      label: 'Circle',
      shapeType: 'ellipse',
    }
    useItemsStore.getState().setTracks([track, secondTrack])
    useItemsStore.getState().setItems([shape, secondShape])

    const { container } = render(<CompositingTimeline />)
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-motion-row-track-id]'))
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: index * 34,
        left: 0,
        top: index * 34,
        right: 800,
        bottom: index * 34 + 34,
        width: 800,
        height: 34,
        toJSON: () => ({}),
      })
    })

    const handle = screen.getByTestId(`motion-reorder-handle-${secondTrack.id}`)
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientY: 51 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 0 })
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: 0 })

    expect(
      [...useItemsStore.getState().tracks]
        .sort((left, right) => left.order - right.order)
        .map((candidate) => candidate.id),
    ).toEqual([secondTrack.id, track.id])
    useTimelineCommandStore.getState().undo()
    expect(
      [...useItemsStore.getState().tracks]
        .sort((left, right) => left.order - right.order)
        .map((candidate) => candidate.id),
    ).toEqual([track.id, secondTrack.id])
  })

  it('reorders a group as one top-level row without moving its children out', () => {
    const groupTrack = makeTimelineTrack({
      id: 'group-track',
      name: 'Group 1',
      kind: 'video',
      order: 0,
      isGroup: true,
    })
    const childTrack = makeTimelineTrack({
      ...track,
      id: 'child-track',
      order: 0,
      parentTrackId: groupTrack.id,
    })
    const topTrack = makeTimelineTrack({
      id: 'top-track',
      name: 'Top layer',
      kind: 'video',
      order: 1,
    })
    useItemsStore.getState().setTracks([groupTrack, childTrack, topTrack])
    useItemsStore.getState().setItems([
      { ...shape, trackId: childTrack.id },
      { ...shape, id: 'shape-top', trackId: topTrack.id, label: 'Top layer' },
    ])

    const { container } = render(<CompositingTimeline />)
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-motion-row-track-id]'))
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: index * 34,
        left: 0,
        top: index * 34,
        right: 800,
        bottom: index * 34 + 34,
        width: 800,
        height: 34,
        toJSON: () => ({}),
      })
    })

    const handle = screen.getByTestId(`motion-reorder-handle-${topTrack.id}`)
    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientY: 85 })
    fireEvent.pointerMove(handle, { pointerId: 3, clientY: 0 })
    fireEvent.pointerUp(handle, { pointerId: 3, clientY: 0 })

    const reordered = useItemsStore.getState().tracks
    expect(reordered.find((candidate) => candidate.id === topTrack.id)?.order).toBe(0)
    expect(reordered.find((candidate) => candidate.id === groupTrack.id)?.order).toBe(1)
    expect(reordered.find((candidate) => candidate.id === childTrack.id)?.parentTrackId).toBe(
      groupTrack.id,
    )
  })

  it('groups selected layers into a collapsible parent track and can ungroup them', () => {
    const secondTrack = makeTimelineTrack({
      id: 'layer-track-2',
      name: 'Circle',
      kind: 'video',
      order: 1,
    })
    const secondShape: ShapeItem = {
      ...shape,
      id: 'shape-2',
      trackId: secondTrack.id,
      label: 'Circle',
      shapeType: 'ellipse',
    }
    useItemsStore.getState().setTracks([track, secondTrack])
    useItemsStore.getState().setItems([shape, secondShape])
    useSelectionStore.getState().selectItems([shape.id, secondShape.id])

    render(<CompositingTimeline />)
    fireEvent.click(screen.getByTitle('Group selected layers'))

    const groupedState = useItemsStore.getState()
    const groupTrack = groupedState.tracks.find((candidate) => candidate.isGroup)
    expect(groupTrack).toBeDefined()
    expect(
      groupedState.tracks
        .filter((candidate) => candidate.id === track.id || candidate.id === secondTrack.id)
        .every((candidate) => candidate.parentTrackId === groupTrack?.id),
    ).toBe(true)
    expect(screen.getByTestId(`motion-group-${groupTrack!.id}`)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }))
    expect(useItemsStore.getState().tracks.some((candidate) => candidate.isGroup)).toBe(false)
  })

  it('accepts text and shape templates dragged from the shared media sidebar', () => {
    render(<CompositingTimeline />)
    const timeline = screen.getByTestId('compositing-timeline')
    fireEvent.drop(timeline, {
      dataTransfer: makeDataTransfer({
        type: 'timeline-template',
        itemType: 'text',
        label: 'Library title',
      }),
    })

    expect(useItemsStore.getState().items).toContainEqual(
      expect.objectContaining({ type: 'text', label: 'Library title' }),
    )
  })

  it('accepts media assets dragged from the shared media library', async () => {
    const media = {
      id: 'media-image',
      fileName: 'texture.png',
      mimeType: 'image/png',
      duration: 0,
    } as MediaMetadata
    useMediaLibraryStore.setState({ mediaItems: [media], mediaById: { [media.id]: media } })
    render(<CompositingTimeline />)

    fireEvent.drop(screen.getByTestId('compositing-timeline'), {
      dataTransfer: makeDataTransfer({
        type: 'media-item',
        mediaId: media.id,
        mediaType: 'image',
        fileName: media.fileName,
        duration: media.duration,
      }),
    })

    await waitFor(() =>
      expect(useItemsStore.getState().items).toContainEqual(
        expect.objectContaining({ type: 'image', mediaId: media.id }),
      ),
    )
  })

  it('nests compositions from the media library and blocks reverse cycles', () => {
    useCompositionsStore.getState().addComposition({
      id: 'child-comp',
      name: 'Child',
      editorKind: 'composite-2d',
      tracks: [],
      items: [],
      transitions: [],
      keyframes: [],
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 120,
    })
    const { rerender } = render(<CompositingTimeline />)
    fireEvent.drop(screen.getByTestId('compositing-timeline'), {
      dataTransfer: makeDataTransfer({ type: 'composition', compositionId: 'child-comp' }),
    })
    expect(useItemsStore.getState().items).toContainEqual(
      expect.objectContaining({ type: 'composition', compositionId: 'child-comp' }),
    )

    openComposition('child-comp', 'Child')
    rerender(<CompositingTimeline />)
    fireEvent.drop(screen.getByTestId('compositing-timeline'), {
      dataTransfer: makeDataTransfer({ type: 'composition', compositionId: 'comp-1' }),
    })
    expect(useItemsStore.getState().items).toEqual([])
  })
})
