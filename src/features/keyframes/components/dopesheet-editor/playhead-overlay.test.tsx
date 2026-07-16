import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { DopesheetEditor } from './index'

describe('DopesheetEditor playhead overlay', () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  })

  it('clamps the playhead to the left edge when the current frame is before the viewport', () => {
    render(
      <DopesheetEditor
        itemId="item-1"
        keyframesByProperty={{ x: [] }}
        currentFrame={0}
        frameViewport={{ startFrame: 100, endFrame: 200 }}
        width={640}
        height={240}
      />,
    )

    const clip = screen.getByTestId('dopesheet-playhead-clip')
    const line = screen.getByTestId('dopesheet-playhead-line')

    // columnWidth (248) + 1px for the timeline cells' border-l.
    expect(clip).toHaveStyle({ left: '249px' })
    expect(clip).toHaveClass('overflow-hidden')
    // Playhead should be clamped to 0 (left edge), not negative
    expect(line).toHaveStyle({ left: '0px' })
    expect(screen.getAllByTestId('dopesheet-playhead-line')).toHaveLength(1)
    expect(line.querySelectorAll('span')).toHaveLength(2)
  })

  it('shows the shared ruler in graph mode and defers the playhead to the graph', () => {
    render(
      <DopesheetEditor
        itemId="item-1"
        keyframesByProperty={{ x: [] }}
        currentFrame={0}
        frameViewport={{ startFrame: 100, endFrame: 200 }}
        width={640}
        height={240}
        visualizationMode="graph"
      />,
    )

    expect(screen.getByTestId('dopesheet-ruler')).toHaveClass('cursor-ew-resize')
    // In graph mode the dopesheet overlay playhead is not rendered — the graph
    // draws its own playhead (GraphPlayhead) in the graph's coordinate space.
    expect(screen.queryByTestId('dopesheet-playhead-line')).not.toBeInTheDocument()
  })

  it('keeps the navigator in the right viewport column', () => {
    render(
      <DopesheetEditor
        itemId="item-1"
        keyframesByProperty={{ x: [] }}
        currentFrame={0}
        width={640}
        height={240}
      />,
    )

    expect(screen.getByTestId('keyframe-navigator-property-column')).toBeInTheDocument()
    expect(screen.getByTestId('keyframe-navigator-viewport-column')).toContainElement(
      screen.getByTestId('keyframe-navigator-thumb'),
    )
  })
})
