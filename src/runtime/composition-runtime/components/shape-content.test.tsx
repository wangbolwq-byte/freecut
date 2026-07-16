import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { ShapeItem } from '@/types/timeline'
import { ItemVisualTransformProvider } from '../contexts/item-visual-transform-context'
import { ShapeContent } from './shape-content'

const shape: ShapeItem = {
  id: 'shape-1',
  type: 'shape',
  trackId: 'track-1',
  from: 0,
  durationInFrames: 120,
  label: 'Rectangle',
  shapeType: 'rectangle',
  fillColor: '#22d3ee',
  strokeWidth: 0,
  transform: { x: 0, y: 0, width: 200, height: 100 },
}

describe('ShapeContent', () => {
  afterEach(cleanup)

  it('draws with the evaluated visual dimensions instead of the static item transform', () => {
    const { container } = render(
      <ItemVisualTransformProvider
        value={{
          x: 0,
          y: 0,
          width: 480,
          height: 270,
          anchorX: 240,
          anchorY: 135,
          rotation: 0,
          opacity: 1,
          cornerRadius: 0,
        }}
      >
        <ShapeContent item={shape} />
      </ItemVisualTransformProvider>,
    )

    expect(container.querySelector('svg')).toHaveAttribute('width', '480')
    expect(container.querySelector('svg')).toHaveAttribute('height', '270')
  })
})
