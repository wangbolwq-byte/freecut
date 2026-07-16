import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { AnimateLayout } from './animate-layout'

vi.mock('@/features/editor/deps/timeline-keyframe-ui', () => ({
  KeyframeGraphPanel: ({
    isFocusMode,
    onFocusModeChange,
  }: {
    isFocusMode?: boolean
    onFocusModeChange?: (focused: boolean) => void
  }) => (
    <button type="button" onClick={() => onFocusModeChange?.(!isFocusMode)}>
      {isFocusMode ? 'Exit focus' : 'Enter focus'}
    </button>
  ),
}))

vi.mock('../preview-area', () => ({
  PreviewArea: () => <div>Preview surface</div>,
}))

vi.mock('./animate-timeline-strip', () => ({
  AnimateTimelineStrip: () => <div>Animate timeline</div>,
}))

vi.mock('./animation-preset-library', () => ({
  AnimationPresetLibrary: () => <div>Preset library</div>,
}))

describe('AnimateLayout focus mode', () => {
  it('expands the keyframe desk and restores context with Escape', () => {
    render(<AnimateLayout project={{ width: 1920, height: 1080, fps: 30 }} />)

    expect(screen.getByText('Preview surface')).toBeInTheDocument()
    expect(screen.getByText('Animate timeline')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Enter focus' }))

    expect(screen.queryByText('Preview surface')).not.toBeInTheDocument()
    expect(screen.queryByText('Animate timeline')).not.toBeInTheDocument()
    expect(screen.getByText('Preset library')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })

    expect(screen.getByText('Preview surface')).toBeInTheDocument()
    expect(screen.getByText('Animate timeline')).toBeInTheDocument()
  })
})
