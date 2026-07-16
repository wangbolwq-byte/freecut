import { fireEvent, render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { DopesheetEditor } from './index'

describe('DopesheetEditor shortcuts', () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  })

  it('toggles a keyframe through the active property handler', () => {
    const onAddKeyframe = vi.fn()

    render(
      <DopesheetEditor
        itemId="item-1"
        keyframesByProperty={{ x: [] }}
        selectedProperty="x"
        currentFrame={24}
        width={640}
        height={240}
        onAddKeyframe={onAddKeyframe}
        shortcutsEnabled
        shortcuts={{
          toggleKeyframe: 'k',
          previousKeyframe: 'alt+bracketleft',
          nextKeyframe: 'alt+bracketright',
          toggleAutoKey: 'a',
          fitKeyframes: 'f',
        }}
      />,
    )

    fireEvent.keyDown(document, { key: 'k', code: 'KeyK' })

    expect(onAddKeyframe).toHaveBeenCalledWith('x', 24)
  })

  it('does not fire editor shortcuts while they are out of scope', () => {
    const onAddKeyframe = vi.fn()

    render(
      <DopesheetEditor
        itemId="item-1"
        keyframesByProperty={{ x: [] }}
        selectedProperty="x"
        currentFrame={24}
        width={640}
        height={240}
        onAddKeyframe={onAddKeyframe}
        shortcutsEnabled={false}
        shortcuts={{
          toggleKeyframe: 'k',
          previousKeyframe: 'alt+bracketleft',
          nextKeyframe: 'alt+bracketright',
          toggleAutoKey: 'a',
          fitKeyframes: 'f',
        }}
      />,
    )

    fireEvent.keyDown(document, { key: 'k', code: 'KeyK' })

    expect(onAddKeyframe).not.toHaveBeenCalled()
  })
})
