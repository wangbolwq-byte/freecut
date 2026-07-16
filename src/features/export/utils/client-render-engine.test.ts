import { describe, expect, it } from 'vite-plus/test'
import type { TimelineItem } from '@/types/timeline'
import type { SubCompRenderData } from './canvas-item-renderer'
import {
  resolveRenderedFrameCacheMode,
  resolveVideoPreloadPlan,
  selectPreviewVideoSource,
  subCompositionRenderDataHasGpuEffects,
} from './client-render-engine'

describe('selectPreviewVideoSource', () => {
  it('selects the cached proxy when a compound item still carries its original source', () => {
    const proxyBitmap = {} as ImageBitmap
    expect(
      selectPreviewVideoSource({
        candidates: ['blob:stored-original', 'blob:scrub-proxy'],
        sourceTime: 42,
        toleranceSeconds: 0.01,
        getCachedPredecodedBitmap: (src) => (src === 'blob:scrub-proxy' ? proxyBitmap : null),
      }),
    ).toBe('blob:scrub-proxy')
  })

  it('preserves composition source order when no scrub bitmap is cached', () => {
    expect(
      selectPreviewVideoSource({
        candidates: ['blob:composition-source', 'blob:registered-source'],
      }),
    ).toBe('blob:composition-source')
  })

  it('selects the scheduled compound proxy before its first bitmap arrives', () => {
    expect(
      selectPreviewVideoSource({
        candidates: ['blob:stored-original', 'blob:scrub-proxy'],
        sourceTime: 42,
        toleranceSeconds: 0.01,
        isActivePreviewSourceTarget: (src) => src === 'blob:scrub-proxy',
      }),
    ).toBe('blob:scrub-proxy')
  })
})

describe('resolveVideoPreloadPlan', () => {
  it('defers every non-priority source in preview mode', () => {
    expect(
      resolveVideoPreloadPlan('preview', ['active', 'nearby', 'far', 'far'], ['active', 'nearby']),
    ).toEqual({
      priorityItemIds: ['active', 'nearby'],
      eagerItemIds: [],
      deferredItemIds: ['far'],
    })
  })

  it('keeps export eager after initializing its priority sources first', () => {
    expect(resolveVideoPreloadPlan('export', ['active', 'nearby', 'far'], ['nearby'])).toEqual({
      priorityItemIds: ['nearby'],
      eagerItemIds: ['active', 'far'],
      deferredItemIds: [],
    })
  })
})

describe('resolveRenderedFrameCacheMode', () => {
  it('seeds the cache, keeps nearby scrub frames, and skips isolated overview seeks', () => {
    expect(resolveRenderedFrameCacheMode({ previousFrame: null, frame: 9000, fps: 30 })).toBe(
      'full',
    )
    expect(resolveRenderedFrameCacheMode({ previousFrame: 9000, frame: 8992, fps: 30 })).toBe(
      'full',
    )
    expect(resolveRenderedFrameCacheMode({ previousFrame: 9000, frame: 12000, fps: 30 })).toBe(
      'skip',
    )
  })

  it('uses only the GPU tier for sequential forward frames', () => {
    expect(resolveRenderedFrameCacheMode({ previousFrame: 100, frame: 101, fps: 30 })).toBe(
      'gpu-only',
    )
  })
})

function makeSubCompData(items: TimelineItem[]): SubCompRenderData {
  return {
    fps: 30,
    durationInFrames: 90,
    sortedTracks: [{ order: 0, visible: true, items }],
    keyframesMap: new Map(),
    adjustmentLayers: [],
  }
}

describe('subCompositionRenderDataHasGpuEffects', () => {
  it('detects GPU effects inside nested compound clips', () => {
    const nestedWrapper = {
      id: 'nested-wrapper',
      type: 'composition',
      compositionId: 'inner-comp',
    } as TimelineItem
    const innerVideo = {
      id: 'inner-video',
      type: 'video',
      effects: [
        {
          id: 'dither',
          enabled: true,
          effect: { type: 'gpu-effect', gpuEffectType: 'gpu-dither', params: {} },
        },
      ],
    } as TimelineItem
    const subCompRenderData = new Map<string, SubCompRenderData>([
      ['outer-comp', makeSubCompData([nestedWrapper])],
      ['inner-comp', makeSubCompData([innerVideo])],
    ])

    expect(subCompositionRenderDataHasGpuEffects('outer-comp', subCompRenderData)).toBe(true)
  })

  it('uses preview effect overrides while checking nested compounds', () => {
    const nestedWrapper = {
      id: 'nested-wrapper',
      type: 'composition',
      compositionId: 'inner-comp',
    } as TimelineItem
    const innerVideo = {
      id: 'inner-video',
      type: 'video',
      effects: [],
    } as unknown as TimelineItem
    const subCompRenderData = new Map<string, SubCompRenderData>([
      ['outer-comp', makeSubCompData([nestedWrapper])],
      ['inner-comp', makeSubCompData([innerVideo])],
    ])

    expect(
      subCompositionRenderDataHasGpuEffects('outer-comp', subCompRenderData, {
        getPreviewEffectsOverride: (itemId) =>
          itemId === 'inner-video'
            ? [
                {
                  id: 'preview-dither',
                  enabled: true,
                  effect: { type: 'gpu-effect', gpuEffectType: 'gpu-dither', params: {} },
                },
              ]
            : undefined,
      }),
    ).toBe(true)
  })
})
