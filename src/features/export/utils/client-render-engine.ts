/**
 * Client Render Engine
 *
 * Contains the `createCompositionRenderer` factory that builds the per-frame
 * renderer with full support for effects, masks, transitions, and keyframe
 * animations.
 *
 * The top-level render orchestration functions (`renderComposition`,
 * `renderAudioOnly`, `renderSingleFrame`) live in
 * `canvas-render-orchestrator.ts`.
 *
 * Per-item rendering helpers (video, image, text, shape, transitions) live
 * in `canvas-item-renderer.ts`.
 */

import type { CompositionInputProps } from '@/types/export'
import type {
  TimelineItem,
  VideoItem,
  ImageItem,
  LottieItem,
  ShapeItem,
  CompositionItem,
} from '@/types/timeline'
import {
  LottieExportProvider,
  isRenderableLottieSrc,
} from '@/infrastructure/lottie/lottie-frame-provider'
import { resolveLottieRenderSpec } from '@/infrastructure/lottie/lottie-text'
import type { ItemKeyframes } from '@/types/keyframe'
import type { ItemEffect } from '@/types/effects'
import type { ResolvedTransform } from '@/types/transform'
import { createLogger } from '@/shared/logging/logger'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import {
  getMediaMetadataById,
  resolveMediaUrl,
  resolveProxyUrl,
} from '@/features/export/deps/media-library'
import { VideoSourcePool } from '@/features/export/deps/player-contract'
import { recordPreviewCompositionRender } from '@/shared/logging/preview-scrub-performance'
import { recordPreviewCanvasPool } from '@/shared/logging/preview-scrub-performance'

// Import subsystems
import { buildKeyframesMap } from './canvas-keyframes'
import { type AdjustmentLayerWithTrackOrder } from './canvas-effects'
import { GpuPipelineManager } from './gpu-pipeline-manager'
import { isItemFullyOccluding, type FrameOcclusionContext } from './frame-occlusion'
import {
  renderMasksToGpuTexture as renderMasksToGpuTexturePure,
  applyTrackScopedMasks as applyTrackScopedMasksPure,
  type RenderedTaskResult,
} from './frame-mask-helpers'
import {
  renderTransitionFallbackCanvas as renderTransitionFallbackCanvasPure,
  renderItemWithEffects as renderItemWithEffectsPure,
  type FrameItemRenderDeps,
} from './frame-render-tasks'
import { compositeFrameResults } from './frame-compositing'
import {
  buildMaskFrameIndex,
  getActiveMasksForFrame,
  type MaskCanvasSettings,
  type PreparedMask,
} from './canvas-masks'
import { type ActiveTransition } from './canvas-transitions'
import { type CachedGifFrames, gifFrameCache } from '@/features/export/deps/timeline-gif-cache'
import { CanvasPool, TextMeasurementCache } from './canvas-pool'
import {
  acquireSharedPreviewVideoExtractorPool,
  SharedVideoExtractorPool,
  type VideoFrameSource,
} from './shared-video-extractor'
import { getCompositeOperation } from '@/types/blend-mode-css'
import {
  useCompositionsStore,
  type SubComposition,
} from '@/features/export/deps/timeline-compositions'
import { doesMaskAffectTrack } from '@/shared/utils/mask-scope'
import type { FrameInvalidationRequest } from '@/shared/utils/frame-invalidation'
import {
  collectReachableCompositionIdsFromItems,
  collectReachableCompositionIdsFromTracks,
} from '@/features/export/deps/timeline-compositions'

// Item renderer
import {
  createFrameCompositionSceneCache,
  hasCornerPin,
  type PreviewPathVerticesOverride,
  resolveCompositionRenderPlan,
  resolveLiveTransitionRenderPlan,
  collectFrameVideoCandidates,
  getVideoTargetTimeSeconds,
  resolveFrameRenderScene,
} from '@/features/export/deps/composition-runtime'
import {
  renderItem,
  renderTransitionToGpuTexture,
  type CanvasSettings,
  type WorkerLoadedImage,
  type ItemRenderContext,
  type SubCompRenderData,
} from './canvas-item-renderer'
import { ScrubbingCache } from '@/features/export/deps/preview'
import {
  resolveFrameRenderOptimization,
  shouldUseScrubbingFrameCache,
} from './render-path-optimizer'
import { ReverseVideoFrameCache } from './reverse-video-frame-cache'
import { resolveReverseConformedVideoItem } from '@/shared/utils/reverse-conform-item'
import {
  itemHasEnabledGpuEffect,
  isAnimatedImage,
  isGifFormat,
  subCompositionRenderDataHasGpuEffects,
} from './render-engine-predicates'

function getLog() {
  return createLogger('ClientRenderEngine')
}

function getPrewarmVideoSourceTimeSeconds(item: VideoItem, frame: number, fps: number): number {
  const localFrame = frame - item.from
  const sourceStart = item.sourceStart ?? item.trimStart ?? 0
  const sourceFps = item.sourceFps ?? fps
  const speed = item.speed ?? 1
  const sourceFramesNeeded = (item.durationInFrames * speed * sourceFps) / fps
  const reverseSourceEnd = item.sourceEnd ?? sourceStart + sourceFramesNeeded
  return getVideoTargetTimeSeconds(
    sourceStart,
    sourceFps,
    localFrame,
    speed,
    fps,
    0,
    item.isReversed === true,
    reverseSourceEnd,
  )
}

export function selectPreviewVideoSource(options: {
  candidates: Array<string | null | undefined>
  sourceTime?: number
  toleranceSeconds?: number
  getCachedPredecodedBitmap?: ItemRenderContext['getCachedPredecodedBitmap']
  getCachedActivePreviewFallbackBitmap?: ItemRenderContext['getCachedActivePreviewFallbackBitmap']
  isActivePreviewSourceTarget?: ItemRenderContext['isActivePreviewSourceTarget']
}): string | null {
  const candidates = [...new Set(options.candidates.filter((src): src is string => !!src))]
  if (options.sourceTime !== undefined) {
    for (const src of candidates) {
      if (
        options.getCachedPredecodedBitmap?.(src, options.sourceTime, options.toleranceSeconds) ||
        options.getCachedActivePreviewFallbackBitmap?.(
          src,
          options.sourceTime,
          options.toleranceSeconds,
        )
      ) {
        return src
      }
    }
  }
  if (options.sourceTime !== undefined) {
    const activeTarget = candidates.find((src) =>
      options.isActivePreviewSourceTarget?.(src, options.sourceTime!, options.toleranceSeconds),
    )
    if (activeTarget) return activeTarget
  }
  return candidates[0] ?? null
}

// Predicate helpers (GPU-effect / animated-image classifiers) live in
// `render-engine-predicates.ts`. `subCompositionRenderDataHasGpuEffects` is
// re-exported so existing import sites (and its test) keep working.
export { subCompositionRenderDataHasGpuEffects }

export type RenderedFrameCacheMode = 'full' | 'gpu-only' | 'skip'

export interface VideoPreloadPlan {
  priorityItemIds: string[]
  eagerItemIds: string[]
  deferredItemIds: string[]
}

/** Export opens every source up front; preview opens only the bounded priority window. */
export function resolveVideoPreloadPlan(
  renderMode: 'export' | 'preview',
  allItemIds: Iterable<string>,
  priorityItemIds: Iterable<string>,
): VideoPreloadPlan {
  const all = [...new Set(allItemIds)]
  const available = new Set(all)
  const priority = [...new Set(priorityItemIds)].filter((itemId) => available.has(itemId))
  const prioritySet = new Set(priority)
  const remaining = all.filter((itemId) => !prioritySet.has(itemId))
  return {
    priorityItemIds: priority,
    eagerItemIds: renderMode === 'export' ? remaining : [],
    deferredItemIds: renderMode === 'preview' ? remaining : [],
  }
}

/**
 * Avoid retaining isolated frames from large random seeks. They have almost no
 * reuse value (especially on an overview timeline), while each full-resolution
 * cache entry creates both a GPU texture and a deep ImageBitmap copy.
 */
export function resolveRenderedFrameCacheMode({
  previousFrame,
  frame,
  fps,
}: {
  previousFrame: number | null
  frame: number
  fps: number
}): RenderedFrameCacheMode {
  if (previousFrame === null) return 'full'
  const delta = frame - previousFrame
  if (delta > 0 && delta <= 3) return 'gpu-only'
  const wideSeekThreshold = Math.max(12, Math.round(Math.max(1, fps)))
  if (Math.abs(delta) > wideSeekThreshold) return 'skip'
  return 'full'
}

// WebP frame extraction is handled by gifFrameCache.getWebpFrames() —
// the cache service uses the ImageDecoder API and provides the same
// CachedGifFrames structure used for GIF.

// ---------------------------------------------------------------------------
// Scrub perf instrumentation (DEV diagnostics, opt-in)
// ---------------------------------------------------------------------------
//
// Gated on `window.__SCRUB_PERF__ = true` (off by default → zero overhead).
// When on, every `renderFrame` call records its wall-time + which path it took
// (cache-hit / direct / full) into `window.__scrubPerf` and emits a
// `scrub.renderFrame.<path>` User Timing measure so it shows up on the
// Performance panel's Timings track. Read with:
//   window.__scrubPerf            // raw ring buffer
//   — or record a Performance profile and look for `scrub.renderFrame.*`.
interface ScrubPerfSample {
  f: number
  path: 'cache-hit' | 'direct' | 'full' | 'aborted'
  ms: number
  planMs?: number
  taskMs?: number
  gpuWaitMs?: number
  compositeMs?: number
  finalizeMs?: number
  taskCount?: number
  transitionCount?: number
  slowTasks?: Array<{ id: string; kind: string; ms: number }>
}
type ScrubPerfGlobal = {
  __SCRUB_PERF__?: boolean
  __scrubPerf?: ScrubPerfSample[]
}

function scrubPerfStart(): number {
  return (globalThis as ScrubPerfGlobal).__SCRUB_PERF__ ||
    import.meta.env.DEV ||
    import.meta.env.MODE === 'perf'
    ? performance.now()
    : -1
}

function recordScrubPerf(
  frame: number,
  path: ScrubPerfSample['path'],
  startMs: number,
  details: Omit<ScrubPerfSample, 'f' | 'path' | 'ms'> = {},
): void {
  if (startMs < 0) return
  const w = globalThis as ScrubPerfGlobal
  const ms = Number((performance.now() - startMs).toFixed(2))
  recordPreviewCompositionRender({ frame, path, ms, ...details })
  const buffer = (w.__scrubPerf ??= [])
  buffer.push({ f: frame, path, ms, ...details })
  if (buffer.length > 3000) buffer.shift()
  try {
    performance.measure(`scrub.renderFrame.${path}`, { start: startMs })
  } catch {
    /* User Timing unavailable — ignore */
  }
}

/**
 * Identity of a Lottie item's animation/theme selection + text/color overrides.
 * When this changes the preloaded dotlottie renderer must be rebuilt with a
 * fresh render spec (see the preview freshness sync in `renderFrame`).
 */
function lottieOverrideSignature(item: {
  animationId?: string
  themeId?: string
  textOverrides?: Record<string, string>
  colorOverrides?: Record<string, string>
  slotOverrides?: Record<string, number | [number, number]>
}): string {
  return JSON.stringify({
    a: item.animationId ?? null,
    m: item.themeId ?? null,
    t: item.textOverrides ?? null,
    c: item.colorOverrides ?? null,
    s: item.slotOverrides ?? null,
  })
}

// ---------------------------------------------------------------------------
// createCompositionRenderer
// ---------------------------------------------------------------------------

/**
 * Creates a composition renderer that can render frames to a canvas
 * with full support for effects, masks, transitions, and keyframe animations.
 */
export async function createCompositionRenderer(
  composition: CompositionInputProps,
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  options: {
    mode?: 'export' | 'preview'
    getPreviewTransformOverride?: (itemId: string) => Partial<ResolvedTransform> | undefined
    getPreviewEffectsOverride?: (itemId: string) => ItemEffect[] | undefined
    getPreviewCornerPinOverride?: (itemId: string) => TimelineItem['cornerPin'] | undefined
    getPreviewPathVerticesOverride?: PreviewPathVerticesOverride
    getLiveItemSnapshot?: (itemId: string) => TimelineItem | undefined
    getLiveKeyframes?: (itemId: string) => ItemKeyframes | undefined
    domVideoElementProvider?: (itemId: string) => HTMLVideoElement | null
    useProxyMedia?: boolean
  } = {},
) {
  const { fps, transitions = [], backgroundColor = '#000000', keyframes = [] } = composition
  const renderMode = options.mode ?? 'export'
  const tracks =
    composition.tracks?.map((track) => ({
      ...track,
      items: (track.items ?? []).map((item) =>
        item.type === 'video'
          ? resolveReverseConformedVideoItem(item, fps, {
              mode: renderMode,
              useProxy: options.useProxyMedia,
            })
          : item,
      ),
    })) ?? []
  const getPreviewTransformOverride = options.getPreviewTransformOverride
  const getPreviewEffectsOverride = options.getPreviewEffectsOverride
  const getPreviewCornerPinOverride = options.getPreviewCornerPinOverride
  const getPreviewPathVerticesOverride = options.getPreviewPathVerticesOverride
  const getLiveItemSnapshot = options.getLiveItemSnapshot
  const getLiveKeyframes = options.getLiveKeyframes
  const domVideoElementProvider = options.domVideoElementProvider
  const hasDom = typeof document !== 'undefined'
  const previewStrictDecode = renderMode === 'preview'

  const canvasSettings: CanvasSettings = {
    width: canvas.width,
    height: canvas.height,
    fps,
  }
  const frameSceneCache = createFrameCompositionSceneCache()
  let frameSceneRevision = 0

  const renderPlan = resolveCompositionRenderPlan({ tracks, transitions })
  const { trackRenderState } = renderPlan
  const {
    visibleTrackIds,
    visibleTracksByOrderDesc: sortedTracks,
    visibleTracksByOrderAsc: tracksTopToBottom,
    trackOrderMap,
  } = trackRenderState

  // === PERFORMANCE OPTIMIZATION: Canvas Pool ===
  // Pre-allocate reusable canvases instead of creating new ones per frame
  // Initial size: 10 (1 content + ~5 items + 2 effects + 2 transitions).
  // Complex stacked preview frames reached 22 concurrent surfaces in the real
  // project, so retain a small bounded headroom instead of reallocating two
  // throwaway full-resolution canvases on every such frame.
  const canvasPool = new CanvasPool(
    canvas.width,
    canvas.height,
    10,
    24,
    renderMode === 'preview' ? recordPreviewCanvasPool : undefined,
  )

  // === PERFORMANCE OPTIMIZATION: Text Measurement Cache ===
  const textMeasureCache = new TextMeasurementCache()

  // === 3-TIER SCRUBBING CACHE (preview only) ===
  // Tier 1: GPU textures in VRAM for instant scrub (~0.1ms blit)
  // Tier 2: Per-video last-frame for instant clip boundary display
  // Tier 3: Deep RAM ImageBitmap buffer (~900 frames) with GPU promotion
  // When all tiers are warm, scrubbing doesn't decode at all.
  const FRAME_CACHE_ENABLED = renderMode === 'preview'
  const scrubbingCache = FRAME_CACHE_ENABLED ? new ScrubbingCache() : null
  let lastRenderedFrame: number | null = null
  let lastRenderAborted = false
  let activePreviewFramePending = false
  let activePreviewFallbackUsed = false
  let liveDomVideoPlaybackActive = Boolean(domVideoElementProvider)
  let scrubbingFrameCacheActive = shouldUseScrubbingFrameCache(
    Boolean(scrubbingCache),
    liveDomVideoPlaybackActive,
  )
  const cacheRenderedFrame = (frame: number) => {
    // Sequential playback already has the decoder's live frame available and
    // should not copy every full-resolution output into the scrub cache. Those
    // GPU copies compete with the next frame's effects/composite work and retain
    // textures that playback is unlikely to revisit immediately. Paused seeks
    // still populate all cache tiers as before.
    if (!scrubbingCache || !scrubbingFrameCacheActive) {
      return
    }

    const cacheMode = resolveRenderedFrameCacheMode({
      previousFrame: lastRenderedFrame,
      frame,
      fps,
    })
    lastRenderedFrame = frame
    // Overview timelines can move tens of thousands of frames per pointer
    // pixel. Caching those isolated frames only creates GPU textures and deep
    // ImageBitmaps that are almost never revisited, adding allocation/GC churn
    // to the latency-sensitive render path.
    if (cacheMode === 'skip') return
    if (gpu.effects) {
      scrubbingCache.setGpuDevice(gpu.effects.getDevice(), canvas.width, canvas.height)
    }
    scrubbingCache.cacheFrame(frame, canvas, cacheMode === 'gpu-only')
  }

  // === GPU pipeline cluster ===
  // All WebGPU pipelines, the compositor/texture-pool/mask-manager, the
  // composite output target, and the glyph/bitmap-mask texture caches are
  // owned by the manager. Lazily initialized on first use; the effects
  // pipeline owns the device that every other pipeline derives from.
  const gpu = new GpuPipelineManager()

  // Build lookup maps
  const keyframesMap = buildKeyframesMap(keyframes)
  const getCurrentKeyframes = (itemId: string): ItemKeyframes | undefined =>
    getLiveKeyframes?.(itemId) ?? keyframesMap.get(itemId)
  const getCurrentItem = <TItem extends TimelineItem>(item: TItem): TItem => {
    const liveItem = getLiveItemSnapshot?.(item.id)
    const current = liveItem && liveItem.type === item.type ? (liveItem as TItem) : item
    if (current.type !== 'video') {
      return current
    }

    const resolvedVideoItem = resolveReverseConformedVideoItem(current, fps, {
      mode: renderMode,
      useProxy: options.useProxyMedia,
    })
    syncVideoItemRegistration(resolvedVideoItem)
    return resolvedVideoItem as TItem
  }
  let liveTransitionRenderPlanRevision = -1
  let liveTransitionRenderPlan = renderPlan
  const getCurrentRenderPlan = () => {
    if (!getLiveItemSnapshot || liveTransitionRenderPlanRevision === frameSceneRevision) {
      return liveTransitionRenderPlan
    }

    liveTransitionRenderPlan = resolveLiveTransitionRenderPlan({
      renderPlan,
      transitions,
      getCurrentItem,
    })
    liveTransitionRenderPlanRevision = frameSceneRevision
    return liveTransitionRenderPlan
  }
  const getLiveMaskItem = getLiveItemSnapshot
    ? (itemId: string) => {
        const live = getLiveItemSnapshot(itemId)
        return live && live.type === 'shape' ? (live as ShapeItem) : undefined
      }
    : undefined

  // === PERFORMANCE OPTIMIZATION: Use mediabunny for video decoding ===
  // VideoFrameExtractor provides precise frame access without seek delays
  const sharedPreviewExtractorLease =
    renderMode === 'preview' ? acquireSharedPreviewVideoExtractorPool() : null
  const sharedVideoExtractors =
    sharedPreviewExtractorLease?.pool ??
    new SharedVideoExtractorPool({
      // Same-source transitions and overlaps can require multiple concurrent decode
      // timelines. Keep a small fixed lane cap to prevent per-clip duplication.
      maxLanesPerSource: 4,
      logFrameFailuresAsDebug: false,
    })
  const videoExtractors = new Map<string, VideoFrameSource>()
  const videoSourceByItemId = new Map<string, string>()
  const videoItemIdsBySource = new Map<string, Set<string>>()
  const videoItemsById = new Map<string, VideoItem>()
  // Keep video elements as fallback if mediabunny fails
  const videoElements = new Map<string, HTMLVideoElement>()
  const fallbackVideoPool = hasDom && !previewStrictDecode ? new VideoSourcePool() : null
  const fallbackVideoBySrc = new Set<string>()
  const fallbackVideoClipIdByItem = new Map<string, string>()
  let fallbackVideoClipCounter = 0

  const registerVideoItem = (itemId: string, src: string): void => {
    if (!src) return
    const prevSrc = videoSourceByItemId.get(itemId)
    if (prevSrc && prevSrc !== src) {
      const prevSet = videoItemIdsBySource.get(prevSrc)
      prevSet?.delete(itemId)
      if (prevSet && prevSet.size === 0) {
        videoItemIdsBySource.delete(prevSrc)
      }
      sharedVideoExtractors.releaseItem(itemId, prevSrc)
    }
    videoSourceByItemId.set(itemId, src)
    let ids = videoItemIdsBySource.get(src)
    if (!ids) {
      ids = new Set<string>()
      videoItemIdsBySource.set(src, ids)
    }
    ids.add(itemId)
    videoExtractors.set(itemId, sharedVideoExtractors.getOrCreateItemExtractor(itemId, src))
  }

  const bindFallbackVideoElement = (itemId: string, src: string): void => {
    if (!fallbackVideoPool) return

    let clipId = fallbackVideoClipIdByItem.get(itemId)
    if (!clipId) {
      clipId = `export-fallback-${++fallbackVideoClipCounter}-${itemId}`
      fallbackVideoClipIdByItem.set(itemId, clipId)
    }

    const element = fallbackVideoPool.acquireForClip(clipId, src)
    if (!element) return

    // Configure element immediately after acquire, then warm shared source preload.
    element.crossOrigin = 'anonymous'
    element.muted = true
    element.preload = 'auto'

    if (!fallbackVideoBySrc.has(src)) {
      fallbackVideoBySrc.add(src)
      fallbackVideoPool.preloadSource(src).catch(() => {})
    }

    videoElements.set(itemId, element)
  }

  for (const track of tracks) {
    for (const item of track.items ?? []) {
      if (item.type === 'video') {
        const videoItem = item as VideoItem
        videoItemsById.set(item.id, videoItem)
        if (videoItem.src) {
          getLog().debug('Registering shared video extractor', {
            itemId: item.id,
            src: videoItem.src.substring(0, 80),
          })

          // Create item-bound wrapper backed by a shared per-source extractor pool.
          registerVideoItem(item.id, videoItem.src)

          // Also create fallback video element in case mediabunny fails (main thread only).
          if (hasDom && !previewStrictDecode) {
            bindFallbackVideoElement(item.id, videoItem.src)
          }
        }
      }
    }
  }

  // Pre-load image elements
  const imageElements = new Map<string, WorkerLoadedImage>()
  const imageLoadPromises: Promise<void>[] = []

  // Track animated image items for frame extraction (GIF + animated WebP)
  const gifItems: ImageItem[] = []
  const webpItems: ImageItem[] = []
  const gifFramesMap = new Map<string, CachedGifFrames>()

  // Lottie animations: rendered on demand via dotlottie-web (no frame pre-extraction).
  const lottieItems: LottieItem[] = []
  const lottieProvider = new LottieExportProvider()

  // Preview only: a persistent renderer outlives edits, so when a top-level
  // Lottie's text/color overrides change we must rebuild its dotlottie renderer
  // with freshly patched data (the frame mapping already reads live timing).
  // Cheap when nothing changed (a signature compare); export never calls this
  // (it preloads final overrides once). Sub-comp Lotties are out of scope.
  const liveLottieItem = (baseItem: LottieItem): LottieItem => {
    const live = getLiveItemSnapshot?.(baseItem.id)
    return live && live.type === 'lottie' ? live : baseItem
  }
  const lottieOverridesAreStale = (): boolean =>
    lottieItems.some(
      (baseItem) =>
        lottieProvider.getSignature(baseItem.id) !==
        lottieOverrideSignature(liveLottieItem(baseItem)),
    )
  const ensureLottieOverridesFresh = async (): Promise<void> => {
    await Promise.all(
      lottieItems.map(async (baseItem) => {
        const item = liveLottieItem(baseItem)
        if (!isRenderableLottieSrc(item.src)) return
        const signature = lottieOverrideSignature(item)
        if (lottieProvider.getSignature(baseItem.id) === signature) return
        const w = item.sourceWidth && item.sourceWidth > 0 ? item.sourceWidth : 512
        const h = item.sourceHeight && item.sourceHeight > 0 ? item.sourceHeight : 512
        const spec = await resolveLottieRenderSpec(item.src, item)
        await lottieProvider.rebuild(
          baseItem.id,
          item.src,
          w,
          h,
          spec.data ?? undefined,
          signature,
          spec.themeData ?? undefined,
          spec.slots ?? undefined,
        )
      }),
    )
  }

  for (const track of tracks) {
    for (const item of track.items ?? []) {
      if (item.type === 'lottie' && isRenderableLottieSrc((item as LottieItem).src)) {
        lottieItems.push(item as LottieItem)
      }
      if (item.type === 'image' && (item as ImageItem).src) {
        const imageItem = item as ImageItem

        // Check if this is a potentially animated image
        if (isAnimatedImage(imageItem)) {
          if (isGifFormat(imageItem)) {
            gifItems.push(imageItem)
          } else {
            webpItems.push(imageItem)
          }
          // Still load as regular image for fallback
        }

        if (hasDom && typeof Image !== 'undefined') {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          const loadPromise = new Promise<void>((resolve, reject) => {
            img.onload = () => {
              imageElements.set(item.id, {
                source: img,
                width: img.naturalWidth,
                height: img.naturalHeight,
              })
              resolve()
            }
            img.onerror = () => reject(new Error(`Failed to load image: ${imageItem.src}`))
          })
          img.src = imageItem.src
          imageLoadPromises.push(loadPromise)
        } else {
          const loadPromise = (async () => {
            if (typeof createImageBitmap !== 'function') {
              throw new Error('WORKER_REQUIRES_MAIN_THREAD:imagebitmap')
            }
            const response = await fetch(imageItem.src)
            if (!response.ok) {
              throw new Error(`Failed to load image: ${imageItem.src}`)
            }
            const blob = await response.blob()
            const bitmap = await createImageBitmap(blob)
            imageElements.set(item.id, {
              source: bitmap,
              width: bitmap.width,
              height: bitmap.height,
            })
          })()
          imageLoadPromises.push(loadPromise)
        }
      }
    }
  }

  // Collect adjustment layers
  const adjustmentLayers = renderPlan.visibleAdjustmentLayers as AdjustmentLayerWithTrackOrder[]

  const transitionTrackOrderById = new Map<string, number>()
  for (const window of renderPlan.transitionWindows) {
    const transitionTrackId = window.transition.trackId
    const trackOrder = transitionTrackId ? (trackOrderMap.get(transitionTrackId) ?? 0) : 0
    transitionTrackOrderById.set(window.transition.id, trackOrder)
  }

  const maskSettings: MaskCanvasSettings = canvasSettings
  const maskFrameIndex = buildMaskFrameIndex(tracks, maskSettings)

  // Track which videos successfully use mediabunny (for render decisions)
  const useMediabunny = new Set<string>()
  // Track persistent mediabunny failures and disable extractor after repeated errors.
  const mediabunnyFailureCountByItem = new Map<string, number>()
  const mediabunnyInitFailureCountByItem = new Map<string, number>()
  const mediabunnyDisabledItems = new Set<string>()
  const MEDIABUNNY_DISABLE_THRESHOLD = 4
  const PREWARM_FAILURE_DISABLE_THRESHOLD = 3
  const inFlightInitByItem = new Map<string, Promise<boolean>>()
  let isDisposed = false

  function syncVideoItemRegistration(videoItem: VideoItem): void {
    if (!videoItem.src) return

    const prevSrc = videoSourceByItemId.get(videoItem.id)
    if (prevSrc !== videoItem.src) {
      useMediabunny.delete(videoItem.id)
      mediabunnyDisabledItems.delete(videoItem.id)
      mediabunnyFailureCountByItem.delete(videoItem.id)
      mediabunnyInitFailureCountByItem.delete(videoItem.id)
      inFlightInitByItem.delete(videoItem.id)
      registerVideoItem(videoItem.id, videoItem.src)
      if (hasDom && !previewStrictDecode) {
        bindFallbackVideoElement(videoItem.id, videoItem.src)
      }
    }

    videoItemsById.set(videoItem.id, videoItem)
  }

  // Pre-computed sub-composition render data. Populated synchronously at
  // renderer creation (so the first renderFrame sees compound-clip structure
  // even before preload finishes) and refreshed during preload.
  const subCompRenderData = new Map<string, SubCompRenderData>()

  const buildSubCompRenderDataEntry = (subComp: SubComposition): SubCompRenderData => {
    const sorted = [...subComp.tracks].sort((a, b) => (b.order ?? 0) - (a.order ?? 0))
    const sortedWithItems = sorted.map((t) => ({
      order: t.order ?? 0,
      visible: t.visible !== false,
      items: subComp.items.filter(
        (i) => i.trackId === t.id && i.type !== 'audio' && i.type !== 'adjustment',
      ),
    }))
    const subKfMap = new Map<string, ItemKeyframes>()
    for (const kf of subComp.keyframes ?? []) {
      subKfMap.set(kf.itemId, kf)
    }
    const subAdjustmentLayers: AdjustmentLayerWithTrackOrder[] = []
    for (const t of subComp.tracks) {
      if (t.visible === false) continue
      const trackOrder = t.order ?? 0
      for (const i of subComp.items) {
        if (i.trackId === t.id && i.type === 'adjustment') {
          subAdjustmentLayers.push({ layer: i, trackOrder })
        }
      }
    }
    return {
      fps: subComp.fps,
      durationInFrames: subComp.durationInFrames,
      sortedTracks: sortedWithItems,
      keyframesMap: subKfMap,
      adjustmentLayers: subAdjustmentLayers,
    }
  }
  const PREWARM_DECODE_MAX_ITEMS = 6
  const ISOLATED_SEEK_WORKER_WAIT_MS = 900
  let prewarmCanvas: OffscreenCanvas | HTMLCanvasElement | null = null
  let prewarmCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null
  let prewarmAttempted = false
  const reverseVideoFrameCache = renderMode === 'export' ? new ReverseVideoFrameCache() : undefined

  // Build the shared ItemRenderContext used by canvas-item-renderer functions
  const itemRenderContext: ItemRenderContext = {
    fps,
    canvasSettings,
    canvasPool,
    textMeasureCache,
    renderMode,
    renderItem,
    scrubbingCache,
    getCurrentItemSnapshot: getCurrentItem,
    getLiveItemSnapshotById: getLiveItemSnapshot,
    getCurrentKeyframes,
    getPreviewTransformOverride,
    getPreviewCornerPinOverride,
    isVideoSourceKnownOpaque: (item) => {
      return (
        videoExtractors.get(item.id)?.isSourceKnownOpaque?.() === true ||
        getMediaMetadataById(item.mediaId)?.transparency === 'opaque'
      )
    },
    isImageSourceKnownOpaque: (item) =>
      getMediaMetadataById(item.mediaId)?.transparency === 'opaque',
    videoExtractors,
    videoElements,
    useMediabunny,
    mediabunnyDisabledItems,
    mediabunnyFailureCountByItem,
    getResolvedVideoSource: (item, sourceTime, toleranceSeconds) =>
      renderMode === 'preview'
        ? selectPreviewVideoSource({
            candidates: [
              item.src,
              item.mediaId ? resolveProxyUrl(item.mediaId) : null,
              videoSourceByItemId.get(item.id),
              item.mediaId ? blobUrlManager.get(item.mediaId) : null,
            ],
            sourceTime,
            toleranceSeconds,
            getCachedPredecodedBitmap: itemRenderContext.getCachedPredecodedBitmap,
            getCachedActivePreviewFallbackBitmap:
              itemRenderContext.getCachedActivePreviewFallbackBitmap,
            isActivePreviewSourceTarget: itemRenderContext.isActivePreviewSourceTarget,
          })
        : ((item.mediaId ? blobUrlManager.get(item.mediaId) : null) ??
          videoSourceByItemId.get(item.id) ??
          item.src ??
          null),
    reverseVideoFrameCache,
    imageElements,
    gifFramesMap,
    lottieProvider,
    keyframesMap,
    adjustmentLayers,
    getPreviewEffectsOverride,
    getPreviewPathVerticesOverride,
    subCompRenderData,
    gpuPipeline: null,
    gpuTransitionPipeline: null,
    gpuMediaPipeline: null,
    gpuMediaBlendPipeline: null,
    gpuShapePipeline: null,
    gpuTextPipeline: null,
    gpuMaskCombinePipeline: null,
    gpuTextTextureCache: gpu.textTextureCache,
    gpuBitmapMaskTextureCache: gpu.bitmapMaskTextureCache,
    // Cross-frame text raster cache (preview scrub). Only populated in preview
    // mode; export renders each frame once so caching there only wastes RAM.
    textRasterCache: renderMode === 'preview' ? new Map() : undefined,
    // Cross-frame corner-pin warp cache for text (preview scrub only).
    cornerPinWarpCache: renderMode === 'preview' ? new Map() : undefined,
    gpuScratchTexturePool: {
      acquire: (width, height, format) =>
        gpu.texturePool?.acquire(width, height, format) ??
        gpu.ensureTexturePool().acquire(width, height, format),
      release: (texture) => {
        gpu.texturePool?.release(texture)
      },
    },
    domVideoElementProvider,
  }
  itemRenderContext.markActivePreviewFramePending = () => {
    activePreviewFramePending = true
  }
  itemRenderContext.markActivePreviewFallbackUsed = () => {
    activePreviewFallbackUsed = true
  }

  // Track the SubComposition identity we last built each entry from so we only
  // rebuild when the Zustand store produced a new reference (effects added,
  // items changed, etc.). Using reference equality keeps the per-frame cost
  // near-zero when nothing edited the sub-comp.
  const subCompRenderDataSource = new Map<string, SubComposition>()

  const refreshSubCompRenderData = (compositionById: Record<string, SubComposition>) => {
    const reachableIds = collectReachableCompositionIdsFromTracks(tracks, compositionById)
    for (const compositionId of reachableIds) {
      const subComp = compositionById[compositionId]
      if (!subComp) continue
      if (subCompRenderDataSource.get(compositionId) === subComp) continue
      subCompRenderData.set(compositionId, buildSubCompRenderDataEntry(subComp))
      subCompRenderDataSource.set(compositionId, subComp)
    }
  }

  // Synchronously populate sub-comp render data from the current compositions
  // store. Without this, the first renderFrame after creation would fall into
  // the `if (!subData) return;` path in renderCompositionItem and skip all
  // compound clips — producing a black frame until preload() finishes.
  refreshSubCompRenderData(useCompositionsStore.getState().compositionById)

  const getPrewarmContext = ():
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null => {
    if (prewarmAttempted) return prewarmCtx
    prewarmAttempted = true

    if (typeof OffscreenCanvas !== 'undefined') {
      prewarmCanvas = new OffscreenCanvas(1, 1)
      prewarmCtx = prewarmCanvas.getContext('2d')
      return prewarmCtx
    }

    if (typeof document !== 'undefined') {
      const canvasEl = document.createElement('canvas')
      canvasEl.width = 1
      canvasEl.height = 1
      prewarmCanvas = canvasEl
      prewarmCtx = canvasEl.getContext('2d')
      return prewarmCtx
    }

    return null
  }

  const collectPrewarmVideoCandidatesForFrame = (frame: number): VideoItem[] =>
    collectFrameVideoCandidates({
      tracksByOrderAsc: tracksTopToBottom,
      visibleTrackIds,
      minFrame: frame - 1,
      maxFrame: frame + 1,
      maxItems: PREWARM_DECODE_MAX_ITEMS,
    }).map((item) => getCurrentItem(item))

  const initializeMediabunnyForItems = async (itemIds: string[]): Promise<Map<string, boolean>> => {
    const itemResult = new Map<string, boolean>()
    if (itemIds.length === 0) return itemResult

    const bySource = new Map<string, string[]>()
    for (const itemId of itemIds) {
      const src = videoSourceByItemId.get(itemId)
      if (!src) {
        itemResult.set(itemId, false)
        continue
      }
      let ids = bySource.get(src)
      if (!ids) {
        ids = []
        bySource.set(src, ids)
      }
      ids.push(itemId)
    }

    await Promise.all(
      [...bySource.entries()].map(async ([src, ids]) => {
        const success = await sharedVideoExtractors.initSource(src)
        if (isDisposed) return
        // Intentional side effect: decode readiness is tracked per shared source,
        // while itemResult only reports back for the explicitly requested ids.
        const allItemsForSource = videoItemIdsBySource.get(src) ?? new Set(ids)
        for (const itemId of allItemsForSource) {
          if (success) {
            useMediabunny.add(itemId)
          } else {
            useMediabunny.delete(itemId)
          }
        }
        for (const itemId of ids) {
          itemResult.set(itemId, success)
        }
      }),
    )

    return itemResult
  }

  const collectPriorityVideoItemIds = (targetFrame: number, windowFrames: number): string[] => {
    const minFrame = targetFrame - windowFrames
    const maxFrame = targetFrame + windowFrames
    const ids: string[] = []

    for (const track of tracks) {
      if (!visibleTrackIds.has(track.id)) continue
      for (const item of track.items ?? []) {
        if (item.type !== 'video') continue
        const start = item.from
        const end = item.from + item.durationInFrames
        if (end < minFrame || start > maxFrame) continue
        const currentItem = getCurrentItem(item)
        if (videoExtractors.has(currentItem.id)) {
          ids.push(currentItem.id)
        }
      }
    }

    return ids
  }

  const ensureVideoItemReady = async (itemId: string): Promise<boolean> => {
    if (useMediabunny.has(itemId)) return true
    if (mediabunnyDisabledItems.has(itemId)) return false
    if (!videoExtractors.has(itemId)) return false

    const existing = inFlightInitByItem.get(itemId)
    if (existing) return existing

    const promise = initializeMediabunnyForItems([itemId])
      .then((result) => {
        if (isDisposed) return false
        const ok = result.get(itemId) === true
        if (ok) {
          mediabunnyInitFailureCountByItem.delete(itemId)
          return true
        }

        const failures = (mediabunnyInitFailureCountByItem.get(itemId) ?? 0) + 1
        mediabunnyInitFailureCountByItem.set(itemId, failures)
        if (failures >= MEDIABUNNY_DISABLE_THRESHOLD) {
          mediabunnyDisabledItems.add(itemId)
        }
        return false
      })
      .finally(() => {
        inFlightInitByItem.delete(itemId)
      })

    inFlightInitByItem.set(itemId, promise)
    return promise
  }
  itemRenderContext.ensureVideoItemReady = ensureVideoItemReady

  // Wire up pre-decoded bitmap cache from the decoder prewarm worker.
  // Resolve the adapter before returning the preview renderer. The first held
  // scrub may call renderFrame immediately; a fire-and-forget import lets that
  // first frame enter blocking MediaBunny before cancellation is wired.
  if (renderMode === 'preview') {
    try {
      const {
        getCachedPredecodedBitmap,
        getCachedActivePreviewFallbackBitmap,
        isActivePreviewFrameCurrent,
        isActivePreviewFrameDecodeReady,
        isActivePreviewSourceTarget,
        isActivePreviewFrameSuperseded,
        isActivePreviewTargetSuperseded,
        waitForInflightPredecodedBitmap,
      } = await import('@/features/export/deps/preview-contract')
      itemRenderContext.getCachedPredecodedBitmap = getCachedPredecodedBitmap
      itemRenderContext.getCachedActivePreviewFallbackBitmap = getCachedActivePreviewFallbackBitmap
      itemRenderContext.isActivePreviewFrameCurrent = isActivePreviewFrameCurrent
      itemRenderContext.isActivePreviewFrameDecodeReady = isActivePreviewFrameDecodeReady
      itemRenderContext.isActivePreviewSourceTarget = isActivePreviewSourceTarget
      itemRenderContext.isActivePreviewFrameSuperseded = isActivePreviewFrameSuperseded
      itemRenderContext.waitForInflightPredecodedBitmap = waitForInflightPredecodedBitmap
      itemRenderContext.isActivePreviewTargetSuperseded = isActivePreviewTargetSuperseded
    } catch {
      // Preview can still fall back to its ordinary media path if the optional
      // worker adapter is unavailable in a constrained runtime.
    }
  }

  const reportPreviewDecodeCoverage = (expectedReadyItemIds: Iterable<string>) => {
    if (previewStrictDecode) {
      const failedItemIds = [...expectedReadyItemIds].filter((id) => !useMediabunny.has(id))
      if (failedItemIds.length === 0) return
      getLog().debug('Preview Mediabunny coverage incomplete; fallback paths remain available', {
        failedCount: failedItemIds.length,
        failedItemIds,
      })
    }
  }

  return {
    async preload(
      options: {
        priorityFrame?: number
        priorityWindowFrames?: number
        onPriorityMediaReady?: () => void
      } = {},
    ) {
      // Composition items require the compositions store which only exists on main thread.
      // Workers get a fresh, empty Zustand store, so sub-comp data can never be resolved.
      // Bail early to trigger the main-thread fallback path. Use reachability rather than a
      // narrow `type === 'composition'` scan so sub-comps referenced only through a linked-audio
      // wrapper item are caught too — otherwise nested Lottie/GIF/WebP (invisible to the
      // top-level media lists) would slip past into the sub-comp preload and export blank.
      const hasCompositionItems =
        collectReachableCompositionIdsFromTracks(
          tracks,
          useCompositionsStore.getState().compositionById,
        ).length > 0
      if (!hasDom && hasCompositionItems) {
        throw new Error('WORKER_REQUIRES_MAIN_THREAD:composition')
      }

      const priorityFrame = Number.isFinite(options.priorityFrame)
        ? Math.round(options.priorityFrame!)
        : null
      const priorityWindowFrames = Math.max(4, Math.round(options.priorityWindowFrames ?? fps * 4))
      const prioritizedMainVideoIds =
        priorityFrame === null
          ? []
          : collectPriorityVideoItemIds(priorityFrame, priorityWindowFrames)

      getLog().debug('Preloading media', {
        videoCount: videoExtractors.size,
        videoSourceCount: new Set(videoSourceByItemId.values()).size,
        imageCount: imageElements.size,
      })

      // Wait for images
      await Promise.all(imageLoadPromises)

      if (!hasDom && (gifItems.length > 0 || webpItems.length > 0)) {
        throw new Error('WORKER_REQUIRES_MAIN_THREAD:animated-image')
      }

      if (!hasDom && lottieItems.length > 0) {
        throw new Error('WORKER_REQUIRES_MAIN_THREAD:lottie')
      }

      // === Initialize mediabunny video extractors (primary method) ===
      if (prioritizedMainVideoIds.length > 0) {
        await initializeMediabunnyForItems(prioritizedMainVideoIds)
      }
      const mainVideoPreloadPlan = resolveVideoPreloadPlan(
        renderMode,
        videoExtractors.keys(),
        prioritizedMainVideoIds,
      )
      // Export needs every source ready before frame 0. Preview renders initialize
      // a missed source on demand, so opening all remaining project media here only
      // creates decoder/GC churn for clips the user may never visit.
      if (mainVideoPreloadPlan.eagerItemIds.length > 0) {
        await initializeMediabunnyForItems(mainVideoPreloadPlan.eagerItemIds)
      }

      getLog().info('Video initialization complete', {
        mediabunny: useMediabunny.size,
        deferred: mainVideoPreloadPlan.deferredItemIds.length,
        fallback: renderMode === 'export' ? videoExtractors.size - useMediabunny.size : undefined,
        uniqueSources: new Set(videoSourceByItemId.values()).size,
      })

      reportPreviewDecodeCoverage(prioritizedMainVideoIds)

      // === Preload ALL fallback video elements ===
      // Load every video element (not just those that failed mediabunny init)
      // so the HTML5 fallback is ready if mediabunny fails mid-export.
      // This is critical for transitions where the outgoing clip's extractor
      // may fail past the source duration boundary.
      const allVideoIds = Array.from(videoElements.keys())

      if (!hasDom && allVideoIds.some((id) => !useMediabunny.has(id))) {
        throw new Error('WORKER_REQUIRES_MAIN_THREAD:video-fallback')
      }

      if (hasDom && !previewStrictDecode && allVideoIds.length > 0) {
        const uniqueVideoEntries = new Map<HTMLVideoElement, string>()
        for (const [itemId, video] of videoElements.entries()) {
          if (!uniqueVideoEntries.has(video)) {
            uniqueVideoEntries.set(video, itemId)
          }
        }

        const videoLoadPromises = Array.from(uniqueVideoEntries.entries()).map(
          ([video, itemId]) =>
            new Promise<void>((resolve) => {
              const timeout = setTimeout(() => {
                getLog().warn('Video load timeout', { itemId, src: video.currentSrc || video.src })
                resolve()
              }, 10000)

              if (video.readyState >= 2) {
                clearTimeout(timeout)
                resolve()
              } else {
                video.addEventListener(
                  'loadeddata',
                  () => {
                    clearTimeout(timeout)
                    resolve()
                  },
                  { once: true },
                )
                video.addEventListener(
                  'error',
                  () => {
                    clearTimeout(timeout)
                    // Non-fatal: this is only the HTML5 fallback <video> preload.
                    // Rendering goes through mediabunny; the fallback is a backup
                    // for clips whose extractor fails mid-export. A revoked/empty
                    // blob here (e.g. a blob-URL lifecycle race) doesn't affect the
                    // exported frames, so warn rather than error.
                    getLog().warn('Fallback video preload failed (non-fatal)', {
                      itemId,
                      mediaErrorCode: video.error?.code,
                      mediaErrorMessage: video.error?.message,
                    })
                    resolve()
                  },
                  { once: true },
                )
                video.load()
              }
            }),
        )

        await Promise.all(videoLoadPromises)
      }

      // Load GIF frames for animated GIFs (main thread only)
      if (hasDom && gifItems.length > 0) {
        getLog().debug('Preloading GIF frames', { gifCount: gifItems.length })

        const gifLoadPromises = gifItems.map(async (gifItem) => {
          try {
            // Use mediaId if available, otherwise use item id
            const mediaId = gifItem.mediaId ?? gifItem.id
            const cachedFrames = await gifFrameCache.getGifFrames(mediaId, gifItem.src)
            gifFramesMap.set(gifItem.id, cachedFrames)
            getLog().debug('GIF frames loaded', {
              itemId: gifItem.id.substring(0, 8),
              frameCount: cachedFrames.frames.length,
              totalDuration: cachedFrames.totalDuration,
            })
          } catch (err) {
            getLog().error('Failed to load GIF frames', { itemId: gifItem.id, error: err })
            // GIF will fallback to static image rendering
          }
        })

        await Promise.all(gifLoadPromises)
        getLog().debug('All GIF frames loaded', { loadedCount: gifFramesMap.size })
      }

      // Preload Lottie renderers (main thread only). Each renders into its own
      // OffscreenCanvas at native animation resolution; frames are drawn on demand.
      if (hasDom && lottieItems.length > 0) {
        getLog().debug('Preloading Lottie animations', { lottieCount: lottieItems.length })
        await Promise.all(
          lottieItems.map(async (lottieItem) => {
            try {
              const w =
                lottieItem.sourceWidth && lottieItem.sourceWidth > 0 ? lottieItem.sourceWidth : 512
              const h =
                lottieItem.sourceHeight && lottieItem.sourceHeight > 0
                  ? lottieItem.sourceHeight
                  : 512
              // Resolve animation/theme + text/color edits before warming so
              // exports reflect them.
              const spec = await resolveLottieRenderSpec(lottieItem.src, lottieItem)
              if (isDisposed) return
              await lottieProvider.preload(
                lottieItem.id,
                lottieItem.src,
                w,
                h,
                spec.data ?? undefined,
                lottieOverrideSignature(lottieItem),
                spec.themeData ?? undefined,
                spec.slots ?? undefined,
              )
              // Bail if the engine was disposed mid-load so we don't register a
              // renderer into a torn-down provider (dispose() → destroy()).
              if (isDisposed) return
            } catch (err) {
              getLog().error('Failed to preload Lottie', { itemId: lottieItem.id, error: err })
            }
          }),
        )
        getLog().debug('All Lottie animations loaded')
      }

      // Load animated WebP frames via cache service (main thread only)
      if (hasDom && webpItems.length > 0) {
        getLog().debug('Preloading animated WebP frames', { webpCount: webpItems.length })

        const webpLoadPromises = webpItems.map(async (webpItem) => {
          try {
            const mediaId = webpItem.mediaId ?? webpItem.id
            const cachedFrames = await gifFrameCache.getWebpFrames(mediaId, webpItem.src)
            gifFramesMap.set(webpItem.id, cachedFrames)
            getLog().debug('Animated WebP frames loaded', {
              itemId: webpItem.id.substring(0, 8),
              frameCount: cachedFrames.frames.length,
              totalDuration: cachedFrames.totalDuration,
            })
          } catch (err) {
            getLog().error('Failed to load WebP frames', { itemId: webpItem.id, error: err })
            // WebP will fallback to static image rendering
          }
        })

        await Promise.all(webpLoadPromises)
      }

      // === PRELOAD SUB-COMPOSITION MEDIA & BUILD RENDER DATA ===
      // CompositionItem references sub-compositions with their own media items.
      // We preload media AND build pre-computed render data to avoid per-frame
      // sorting, filtering, and linear searches in renderCompositionItem.
      const subCompMediaItems: Array<{ subItem: TimelineItem; src: string }> = []
      const pendingResolutions: Array<{ subItem: TimelineItem; mediaId: string }> = []
      const prioritySubCompVideoItemIds = new Set<string>()
      const compositionById = useCompositionsStore.getState().compositionById
      // Collect priority video item IDs from all depths of nested compositions
      // whose root-level wrapper falls within the priority scrub window.
      for (const track of tracks) {
        for (const item of track.items ?? []) {
          if (item.type !== 'composition') continue
          const compItem = item as CompositionItem
          const subComp = compositionById[compItem.compositionId]
          if (!subComp) continue
          const subCompIsPriority =
            priorityFrame !== null &&
            compItem.from <= priorityFrame + priorityWindowFrames &&
            compItem.from + compItem.durationInFrames >= priorityFrame - priorityWindowFrames
          if (!subCompIsPriority) continue
          const nestedCompIds = collectReachableCompositionIdsFromItems(
            subComp.items,
            compositionById,
          )
          const allComps = [
            subComp,
            ...nestedCompIds.flatMap((id) => (compositionById[id] ? [compositionById[id]] : [])),
          ]
          for (const comp of allComps) {
            for (const subItem of comp.items) {
              if (subItem.type === 'video') {
                prioritySubCompVideoItemIds.add(subItem.id)
              }
            }
          }
        }
      }

      const reachableCompositionIds = collectReachableCompositionIdsFromTracks(
        tracks,
        compositionById,
      )
      for (const compositionId of reachableCompositionIds) {
        const subComp = compositionById[compositionId]
        if (!subComp) {
          getLog().warn('Sub-composition not found in store!', {
            compositionId,
            storeCompositionCount: useCompositionsStore.getState().compositions.length,
            storeCompositionIds: useCompositionsStore
              .getState()
              .compositions.map((c) => c.id.substring(0, 8)),
          })
          continue
        }

        if (subCompRenderDataSource.get(compositionId) !== subComp) {
          subCompRenderData.set(compositionId, buildSubCompRenderDataEntry(subComp))
          subCompRenderDataSource.set(compositionId, subComp)
        }

        for (const subItem of subComp.items) {
          if (subItem.type !== 'video' && subItem.type !== 'image' && subItem.type !== 'lottie')
            continue
          if (subItem.mediaId) {
            const src =
              (renderMode === 'preview' ? resolveProxyUrl(subItem.mediaId) : null) ??
              blobUrlManager.get(subItem.mediaId)
            if (src) {
              subCompMediaItems.push({ subItem, src })
            } else {
              pendingResolutions.push({ subItem, mediaId: subItem.mediaId })
            }
          } else {
            const src = (subItem as VideoItem | ImageItem | LottieItem).src ?? ''
            if (src) subCompMediaItems.push({ subItem, src })
          }
        }
      }

      // Resolve pending sub-comp URLs from OPFS in parallel
      if (pendingResolutions.length > 0) {
        getLog().debug('Resolving sub-comp media URLs from OPFS', {
          count: pendingResolutions.length,
        })
        const resolved = await Promise.all(
          pendingResolutions.map(async ({ subItem, mediaId }) => {
            const src = await resolveMediaUrl(mediaId)
            return { subItem, src }
          }),
        )
        for (const { subItem, src } of resolved) {
          if (src) subCompMediaItems.push({ subItem, src })
        }
      }

      if (subCompMediaItems.length > 0) {
        getLog().debug('Preloading sub-composition media', { count: subCompMediaItems.length })

        // Preload sub-comp video extractors
        const subVideoItemIds: string[] = []
        for (const { subItem, src } of subCompMediaItems) {
          if (subItem.type === 'video' && !videoExtractors.has(subItem.id)) {
            registerVideoItem(subItem.id, src)
            subVideoItemIds.push(subItem.id)
            if (hasDom && !previewStrictDecode) {
              bindFallbackVideoElement(subItem.id, src)
            }
          }
        }
        const prioritizedSubVideoItemIds = subVideoItemIds.filter((itemId) =>
          prioritySubCompVideoItemIds.has(itemId),
        )
        if (prioritizedSubVideoItemIds.length > 0) {
          await initializeMediabunnyForItems(prioritizedSubVideoItemIds)
        }

        // Signal that priority media for the current frame is ready. The
        // preview controller uses this to trigger a re-render before the
        // rest of preload (remaining videos, sub images, GIF/WebP frames)
        // finishes — so the user sees the correct frame faster after
        // exiting a sub-composition.
        try {
          options.onPriorityMediaReady?.()
        } catch (err) {
          getLog().warn('onPriorityMediaReady callback threw', { error: err })
        }

        const subVideoPreloadPlan = resolveVideoPreloadPlan(
          renderMode,
          subVideoItemIds,
          prioritizedSubVideoItemIds,
        )
        if (subVideoPreloadPlan.eagerItemIds.length > 0) {
          await initializeMediabunnyForItems(subVideoPreloadPlan.eagerItemIds)
        }

        reportPreviewDecodeCoverage(prioritizedSubVideoItemIds)

        // Load fallback video elements for sub-comp items that failed mediabunny init
        if (hasDom && !previewStrictDecode) {
          const subFallbackVideoIds = subCompMediaItems
            .filter(({ subItem }) => subItem.type === 'video' && !useMediabunny.has(subItem.id))
            .map(({ subItem }) => subItem.id)

          if (subFallbackVideoIds.length > 0) {
            const uniqueSubVideos = new Map<HTMLVideoElement, string>()
            for (const itemId of subFallbackVideoIds) {
              const video = videoElements.get(itemId)
              if (video && !uniqueSubVideos.has(video)) {
                uniqueSubVideos.set(video, itemId)
              }
            }

            const subVideoLoadPromises = Array.from(uniqueSubVideos.entries()).map(
              ([video, itemId]) =>
                new Promise<void>((resolve) => {
                  const timeout = setTimeout(() => {
                    getLog().warn('Sub-comp video load timeout', { itemId })
                    resolve()
                  }, 10000)

                  if (video.readyState >= 2) {
                    clearTimeout(timeout)
                    resolve()
                  } else {
                    video.addEventListener(
                      'loadeddata',
                      () => {
                        clearTimeout(timeout)
                        resolve()
                      },
                      { once: true },
                    )
                    video.addEventListener(
                      'error',
                      () => {
                        clearTimeout(timeout)
                        getLog().error('Sub-comp video load error', { itemId })
                        resolve()
                      },
                      { once: true },
                    )
                    video.load()
                  }
                }),
            )
            await Promise.all(subVideoLoadPromises)
          }
        }

        // Preload sub-comp images
        const subImagePromises: Promise<void>[] = []
        const subGifItems: ImageItem[] = []
        const subWebpItems: ImageItem[] = []
        const subLottieItems: Array<{
          id: string
          src: string
          w: number
          h: number
          animationId?: string
          themeId?: string
          textOverrides?: Record<string, string>
          colorOverrides?: Record<string, string>
          slotOverrides?: Record<string, number | [number, number]>
        }> = []

        for (const { subItem, src } of subCompMediaItems) {
          if (subItem.type === 'lottie' && !lottieProvider.get(subItem.id)) {
            const lottieItem = subItem as LottieItem
            subLottieItems.push({
              id: lottieItem.id,
              src,
              w:
                lottieItem.sourceWidth && lottieItem.sourceWidth > 0 ? lottieItem.sourceWidth : 512,
              h:
                lottieItem.sourceHeight && lottieItem.sourceHeight > 0
                  ? lottieItem.sourceHeight
                  : 512,
              animationId: lottieItem.animationId,
              themeId: lottieItem.themeId,
              textOverrides: lottieItem.textOverrides,
              colorOverrides: lottieItem.colorOverrides,
              slotOverrides: lottieItem.slotOverrides,
            })
          }
          if (subItem.type === 'image' && !imageElements.has(subItem.id)) {
            const imageItem = subItem as ImageItem
            const itemWithSrc = { ...imageItem, src } as ImageItem
            // Check for animated image (GIF or WebP)
            if (isAnimatedImage(itemWithSrc)) {
              if (isGifFormat(itemWithSrc)) {
                subGifItems.push(itemWithSrc)
              } else {
                subWebpItems.push(itemWithSrc)
              }
            }

            if (hasDom && typeof Image !== 'undefined') {
              const img = new Image()
              img.crossOrigin = 'anonymous'
              subImagePromises.push(
                new Promise<void>((resolve) => {
                  img.onload = () => {
                    imageElements.set(subItem.id, {
                      source: img,
                      width: img.naturalWidth,
                      height: img.naturalHeight,
                    })
                    resolve()
                  }
                  img.onerror = () => {
                    getLog().error('Failed to load sub-comp image', { itemId: subItem.id })
                    resolve()
                  }
                }),
              )
              img.src = src
            } else {
              subImagePromises.push(
                (async () => {
                  if (typeof createImageBitmap !== 'function') {
                    throw new Error('WORKER_REQUIRES_MAIN_THREAD:imagebitmap')
                  }
                  const response = await fetch(src)
                  if (!response.ok) {
                    getLog().error('Failed to fetch sub-comp image', { itemId: subItem.id })
                    return
                  }
                  const blob = await response.blob()
                  const bitmap = await createImageBitmap(blob)
                  imageElements.set(subItem.id, {
                    source: bitmap,
                    width: bitmap.width,
                    height: bitmap.height,
                  })
                })(),
              )
            }
          }
        }
        await Promise.all(subImagePromises)

        // Load sub-comp GIF frames
        if (hasDom && subGifItems.length > 0) {
          const subGifPromises = subGifItems.map(async (gifItem) => {
            try {
              const mediaId = gifItem.mediaId ?? gifItem.id
              const cachedFrames = await gifFrameCache.getGifFrames(mediaId, gifItem.src)
              gifFramesMap.set(gifItem.id, cachedFrames)
              getLog().debug('Sub-comp GIF frames loaded', {
                itemId: gifItem.id.substring(0, 8),
                frameCount: cachedFrames.frames.length,
              })
            } catch (err) {
              getLog().error('Failed to load sub-comp GIF frames', {
                itemId: gifItem.id,
                error: err,
              })
            }
          })
          await Promise.all(subGifPromises)
        }

        // Load sub-comp animated WebP frames via cache service
        if (hasDom && subWebpItems.length > 0) {
          const subWebpPromises = subWebpItems.map(async (webpItem) => {
            try {
              const mediaId = webpItem.mediaId ?? webpItem.id
              const cachedFrames = await gifFrameCache.getWebpFrames(mediaId, webpItem.src)
              gifFramesMap.set(webpItem.id, cachedFrames)
              getLog().debug('Sub-comp animated WebP frames loaded', {
                itemId: webpItem.id.substring(0, 8),
                frameCount: cachedFrames.frames.length,
              })
            } catch (err) {
              getLog().error('Failed to load sub-comp WebP frames', {
                itemId: webpItem.id,
                error: err,
              })
            }
          })
          await Promise.all(subWebpPromises)
        }

        // Preload sub-comp Lottie renderers, applying animation/theme + text/
        // color edits so compound-clip Lotties reflect them on export (parity
        // with preview).
        if (hasDom && subLottieItems.length > 0) {
          await Promise.all(
            subLottieItems.map(async (it) => {
              try {
                if (!isRenderableLottieSrc(it.src)) return
                const spec = await resolveLottieRenderSpec(it.src, it)
                if (isDisposed) return
                await lottieProvider.preload(
                  it.id,
                  it.src,
                  it.w,
                  it.h,
                  spec.data ?? undefined,
                  lottieOverrideSignature(it),
                  spec.themeData ?? undefined,
                  spec.slots ?? undefined,
                )
              } catch (err) {
                getLog().error('Failed to preload sub-comp Lottie', { itemId: it.id, error: err })
              }
            }),
          )
        }

        getLog().debug('Sub-composition media loaded', {
          videos: subCompMediaItems.filter((s) => s.subItem.type === 'video').length,
          images: subCompMediaItems.filter((s) => s.subItem.type === 'image').length,
          gifs: subGifItems.length,
          webps: subWebpItems.length,
          lotties: subLottieItems.length,
        })
      }

      getLog().debug('All media loaded')
    },

    async renderFrame(frame: number) {
      const scrubPerfStartMs = scrubPerfStart()
      lastRenderAborted = false
      activePreviewFramePending = false
      activePreviewFallbackUsed = false
      itemRenderContext.previewRootTimelineFrame = frame
      const isSupersededActivePreviewFrame = () =>
        renderMode === 'preview' &&
        itemRenderContext.isActivePreviewFrameSuperseded?.(frame) === true
      const abortActivePreviewRender = () => {
        if (!lastRenderAborted) {
          recordScrubPerf(frame, 'aborted', scrubPerfStartMs)
        }
        lastRenderAborted = true
      }
      if (isSupersededActivePreviewFrame()) {
        abortActivePreviewRender()
        return
      }
      if (
        itemRenderContext.isActivePreviewFrameCurrent?.(frame) &&
        itemRenderContext.isActivePreviewFrameDecodeReady?.(frame) === false
      ) {
        abortActivePreviewRender()
        return
      }
      // 3-tier cache lookup (preview only)
      // Tier 1 (GPU texture) → Tier 3 (RAM ImageBitmap) → miss → full render
      if (scrubbingCache && scrubbingFrameCacheActive) {
        const cached = scrubbingCache.getFrame(frame)
        if (cached) {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(cached, 0, 0)
          recordScrubPerf(frame, 'cache-hit', scrubPerfStartMs)
          return
        }
      }

      const renderedFrameCacheMode = resolveRenderedFrameCacheMode({
        previousFrame: lastRenderedFrame,
        frame,
        fps,
      })
      itemRenderContext.captureDecodedVideoFrames =
        Boolean(scrubbingCache && scrubbingFrameCacheActive) && renderedFrameCacheMode !== 'skip'
      itemRenderContext.workerPredecodeWaitMs =
        renderedFrameCacheMode === 'skip' ? ISOLATED_SEEK_WORKER_WAIT_MS : undefined

      // Refresh sub-comp render data so edits inside compound clips (effects,
      // items, keyframes) show up during playback. Reference-equality keeps
      // unchanged compositions at ~zero cost; only mutated entries rebuild.
      // This matters for nested compounds where `renderCompositionItem` reads
      // sub-item effects directly from the cached snapshot — without this
      // refresh, effects added after renderer creation stay invisible.
      if (renderMode === 'preview') {
        refreshSubCompRenderData(useCompositionsStore.getState().compositionById)
      }

      // Rebuild any Lottie whose text/color overrides changed since preload, so
      // live recolor/text edits show up. The sync guard keeps this ~free on the
      // hot path — the await only runs the frame after an override edit.
      if (renderMode === 'preview' && lottieItems.length > 0 && lottieOverridesAreStale()) {
        await ensureLottieOverridesFresh()
        if (isSupersededActivePreviewFrame()) {
          abortActivePreviewRender()
          return
        }
      }

      // Clear canvas
      ctx.fillStyle = backgroundColor
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Prepare masks for this frame
      const activeMasks = getActiveMasksForFrame(
        maskFrameIndex,
        frame,
        maskSettings,
        getCurrentKeyframes,
        renderMode === 'preview' ? getPreviewTransformOverride : undefined,
        renderMode === 'preview' ? getPreviewPathVerticesOverride : undefined,
        renderMode === 'preview' ? getLiveMaskItem : undefined,
      )

      const frameScene = frameSceneCache.resolve(
        {
          renderPlan: getCurrentRenderPlan(),
          frame,
          canvas: canvasSettings,
          getKeyframes: getCurrentKeyframes,
          getPreviewTransform: renderMode === 'preview' ? getPreviewTransformOverride : undefined,
          getPreviewPathVertices:
            renderMode === 'preview' ? getPreviewPathVerticesOverride : undefined,
        },
        frameSceneRevision,
      )
      const { activeTransitions, transitionClipIds } = frameScene.transitionFrameState

      // Debug: Log transition state at key frames (only in development)
      if (
        import.meta.env.DEV &&
        activeTransitions.length > 0 &&
        (frame === activeTransitions[0]?.transitionStart || frame % 30 === 0)
      ) {
        getLog().info(
          `TRANSITION STATE: frame=${frame} activeTransitions=${activeTransitions.length} skippedClipIds=${Array.from(
            transitionClipIds,
          )
            .map((id) => id.substring(0, 8))
            .join(',')}`,
        )
      }

      // Log periodically (only in development)
      if (import.meta.env.DEV && frame % 30 === 0) {
        getLog().debug('Rendering frame', {
          frame,
          tracksCount: sortedTracks.length,
          activeMasks: activeMasks.length,
          activeTransitions: activeTransitions.length,
        })
      }

      let hasAnyGpuEffects = false
      for (const track of sortedTracks) {
        if (!visibleTrackIds.has(track.id)) continue
        for (const baseItem of track.items ?? []) {
          const item = getCurrentItem(baseItem)
          if (frame < item.from || frame >= item.from + item.durationInFrames) continue
          if (
            itemHasEnabledGpuEffect(
              item,
              renderMode === 'preview' ? getPreviewEffectsOverride : undefined,
            )
          ) {
            hasAnyGpuEffects = true
            break
          }
          // Compound clips: also check GPU effects on sub-comp items and
          // adjustment layers so the pipeline is initialized before
          // renderCompositionItem needs it.
          if (item.type === 'composition') {
            if (
              subCompositionRenderDataHasGpuEffects(item.compositionId, subCompRenderData, {
                getCurrentItem,
                getPreviewEffectsOverride:
                  renderMode === 'preview' ? getPreviewEffectsOverride : undefined,
              })
            ) {
              hasAnyGpuEffects = true
              break
            }
          }
        }
        if (hasAnyGpuEffects) break
      }
      if (hasAnyGpuEffects || activeTransitions.length > 0) {
        if (!itemRenderContext.gpuPipeline) {
          itemRenderContext.gpuPipeline = await gpu.ensureEffects()
        }
        if (itemRenderContext.gpuPipeline) {
          // Initialize GPU transition pipeline (shares device with effects pipeline)
          if (hasAnyGpuEffects) {
            if (!itemRenderContext.gpuMediaPipeline) gpu.ensureMedia()
            itemRenderContext.gpuMediaPipeline = gpu.media
          }
          if (activeTransitions.length > 0) {
            if (!itemRenderContext.gpuTransitionPipeline) gpu.ensureTransition()
            if (!itemRenderContext.gpuMediaPipeline) gpu.ensureMedia()
            if (!itemRenderContext.gpuMediaBlendPipeline) gpu.ensureMediaBlend()
            if (!itemRenderContext.gpuShapePipeline) gpu.ensureShape()
            if (!itemRenderContext.gpuTextPipeline) gpu.ensureText()
            if (!itemRenderContext.gpuMaskCombinePipeline) gpu.ensureMaskCombine()
            itemRenderContext.gpuTransitionPipeline = gpu.transition
            itemRenderContext.gpuMediaPipeline = gpu.media
            itemRenderContext.gpuMediaBlendPipeline = gpu.mediaBlend
            itemRenderContext.gpuShapePipeline = gpu.shape
            itemRenderContext.gpuTextPipeline = gpu.text
            itemRenderContext.gpuMaskCombinePipeline = gpu.maskCombine
          }
        }
      }
      if (isSupersededActivePreviewFrame()) {
        abortActivePreviewRender()
        return
      }

      /**
       * Render a single item with effects. Returns the canvas to composite
       * (and canvases to release) for deferred compositing, or composites
       * immediately in export mode.
       */
      const itemRenderDeps: FrameItemRenderDeps = {
        frame,
        canvasSettings,
        maskSettings,
        renderMode,
        activeMasks,
        adjustmentLayers,
        gpu,
        itemRenderContext,
        canvasPool,
        getCurrentItem,
        getCurrentKeyframes,
        getPreviewTransformOverride,
        getPreviewCornerPinOverride,
        getPreviewEffectsOverride,
        getLiveItemSnapshot,
      }
      const renderItemWithEffects = (
        baseItem: TimelineItem,
        trackOrder: number,
        deferred: boolean,
        targetCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
        bakeMasks = true,
        preferGpuTextureOutput = false,
        allowDirectGpu = true,
      ): Promise<RenderedTaskResult | null> =>
        renderItemWithEffectsPure(
          baseItem,
          trackOrder,
          deferred,
          targetCtx,
          itemRenderDeps,
          bakeMasks,
          preferGpuTextureOutput,
          allowDirectGpu,
        )

      const getEffectiveBlendMode = (item: TimelineItem): TimelineItem['blendMode'] => {
        const blendMode = item.blendMode
        if (!blendMode || blendMode === 'normal') return blendMode
        return blendMode
      }

      // Helper to check if item should be rendered
      const shouldRenderItem = (baseItem: TimelineItem): boolean => {
        const item = getCurrentItem(baseItem)
        // Skip items not visible at this frame
        if (frame < item.from || frame >= item.from + item.durationInFrames) {
          return false
        }
        // Skip items being handled by transitions
        if (transitionClipIds.has(item.id)) {
          return false
        }
        // Skip audio items (handled separately)
        if (item.type === 'audio') return false
        // Skip adjustment items (they apply effects, not render content)
        if (item.type === 'adjustment') return false
        // Skip mask shapes (handled by mask system)
        if (item.type === 'shape' && (item as ShapeItem).isMask) return false
        return true
      }
      // === OCCLUSION CULLING OPTIMIZATION ===
      // Find the topmost (lowest order) track with a fully occluding item.
      // Skip rendering all tracks below it (higher order) since they'll be fully covered.
      //
      // An item is fully occluding if:
      // - Covers entire canvas (after transform/keyframes)
      // - Opacity = 1 (after keyframe animation)
      // - No rotation (or 0/180 that still covers)
      // - No corner radius
      // - Is video/image (opaque content)
      // - Not in a transition
      // - No transparency effects
      // - No active masks (masks could reveal content below)

      const occlusionContext: FrameOcclusionContext = {
        frame,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        canvasSettings,
        renderMode,
        transitionClipIds,
        adjustmentLayers,
        getCurrentItem,
        getCurrentKeyframes,
        getPreviewEffectsOverride,
        getLiveItemSnapshot,
        isVideoSourceKnownOpaque: itemRenderContext.isVideoSourceKnownOpaque,
        isImageSourceKnownOpaque: itemRenderContext.isImageSourceKnownOpaque,
      }
      const isFullyOccluding = (baseItem: TimelineItem, trackOrder: number): boolean =>
        isItemFullyOccluding(baseItem, trackOrder, occlusionContext)

      // Find occlusion cutoff – the lowest track order with a fully occluding item
      // If masks are active, disable occlusion culling (masks could reveal content)
      const { occlusionCutoffOrder, renderTasks } = resolveFrameRenderScene<ActiveTransition>({
        tracksByOrderDesc: sortedTracks,
        tracksByOrderAsc: tracksTopToBottom,
        visibleTrackIds,
        activeTransitions,
        getTransitionTrackOrder: (activeTransition) =>
          transitionTrackOrderById.get(activeTransition.transition.id) ?? 0,
        disableOcclusion: activeMasks.length > 0,
        shouldRenderItem,
        isFullyOccluding,
      })

      if (occlusionCutoffOrder !== null && import.meta.env.DEV && frame % 30 === 0) {
        const occludingTask = sortedTracks
          .filter(
            (track) => visibleTrackIds.has(track.id) && (track.order ?? 0) === occlusionCutoffOrder,
          )
          .flatMap((track) => track.items ?? [])
          .find((item) => shouldRenderItem(item) && isFullyOccluding(item, occlusionCutoffOrder))
        if (occludingTask) {
          getLog().debug(
            `Occlusion culling: item ${occludingTask.id.substring(0, 8)} on track order ${occlusionCutoffOrder} fully occludes canvas`,
          )
        }
      }

      const { shouldDirectRenderSingleTask, shouldUseDeferredGpuBatch } =
        resolveFrameRenderOptimization({
          activeMaskCount: activeMasks.length,
          activeTransitionCount: activeTransitions.length,
          hasGpuEffects: hasAnyGpuEffects,
          renderTaskCount: renderTasks.length,
        })
      const hasNonNormalBlend = renderTasks.some(
        (t) =>
          t.type === 'item' &&
          (() => {
            const item = getCurrentItem(t.item)
            const blendMode = getEffectiveBlendMode(item)
            return Boolean(blendMode && blendMode !== 'normal')
          })(),
      )
      if (hasNonNormalBlend && !itemRenderContext.gpuPipeline) {
        itemRenderContext.gpuPipeline = await gpu.ensureEffects()
        if (!itemRenderContext.gpuPipeline) {
          getLog().warn('GPU pipeline init failed - blend modes will use Canvas2D fallback')
        }
      }
      const useGpuCompositor = Boolean(
        hasNonNormalBlend && itemRenderContext.gpuPipeline && gpu.effects && gpu.ensureCompositor(),
      )
      const gpuCompositeOutput = useGpuCompositor
        ? gpu.ensureCompositeOutput(canvasSettings.width, canvasSettings.height)
        : null
      if (shouldUseDeferredGpuBatch && itemRenderContext.gpuPipeline) {
        itemRenderContext.gpuPipeline.beginBatch()
      }

      if (shouldDirectRenderSingleTask) {
        if (isSupersededActivePreviewFrame()) {
          abortActivePreviewRender()
          return
        }
        const directTask = renderTasks[0]
        if (directTask?.type === 'item') {
          const blendMode = getEffectiveBlendMode(getCurrentItem(directTask.item))
          try {
            if (blendMode && blendMode !== 'normal') {
              ctx.globalCompositeOperation = getCompositeOperation(blendMode)
            }

            await renderItemWithEffects(directTask.item, directTask.trackOrder, false, ctx)
          } finally {
            if (blendMode && blendMode !== 'normal') {
              ctx.globalCompositeOperation = 'source-over'
            }
          }
        }

        if (isSupersededActivePreviewFrame() || activePreviewFramePending) {
          abortActivePreviewRender()
          return
        }

        cacheRenderedFrame(frame)
        recordScrubPerf(frame, 'direct', scrubPerfStartMs)
        return
      }

      // === PERFORMANCE: Use pooled canvas instead of creating new one each frame ===
      const { canvas: contentCanvas, ctx: contentCtx } = canvasPool.acquire()
      const scrubPerfTaskStartMs = scrubPerfStartMs >= 0 ? performance.now() : -1
      let scrubPerfTaskEndMs = scrubPerfTaskStartMs
      let scrubPerfGpuWaitEndMs = scrubPerfTaskStartMs
      let scrubPerfCompositeEndMs = scrubPerfTaskStartMs

      // Render tracks in order (bottom to top), with transitions at their track position
      // Track order: higher values render first (behind), lower values render last (on top)
      let skippedTracks = 0
      let finalCompositeSource: OffscreenCanvas = contentCanvas

      // Parallelize item rendering (video decode is the bottleneck).
      // Collect all renderable items in z-order, fire all renders concurrently,
      // then composite results in z-order.
      const scrubSlowTasks: Array<{ id: string; kind: string; ms: number }> = []
      {
        if (occlusionCutoffOrder !== null) {
          skippedTracks = sortedTracks.filter(
            (track) => visibleTrackIds.has(track.id) && (track.order ?? 0) > occlusionCutoffOrder,
          ).length
        }

        const renderMasksToGpuTexture = (masks: PreparedMask[]) =>
          renderMasksToGpuTexturePure(masks, { gpu, canvasSettings, maskSettings })

        const renderTransitionFallbackCanvas = (
          task: Extract<(typeof renderTasks)[number], { type: 'transition' }>,
        ): Promise<RenderedTaskResult> =>
          renderTransitionFallbackCanvasPure(task, {
            frame,
            activeMasks,
            itemRenderContext,
            canvasPool,
          })

        const applyTrackScopedMasks = (
          result: RenderedTaskResult | null,
          trackOrder: number,
          skipMasks: boolean,
        ): RenderedTaskResult | null =>
          applyTrackScopedMasksPure(result, trackOrder, skipMasks, {
            activeMasks,
            canvasPool,
            maskSettings,
          })

        const renderTask = async (
          task: (typeof renderTasks)[number],
        ): Promise<RenderedTaskResult | null> => {
          const taskStartMs = scrubPerfStartMs >= 0 ? performance.now() : -1
          try {
            if (isSupersededActivePreviewFrame()) return null
            if (task.type === 'item') {
              const item = getCurrentItem(task.item)
              const canSeparateMasks =
                useGpuCompositor && gpu.texturePool && !hasCornerPin(item.cornerPin)
              return renderItemWithEffects(
                task.item,
                task.trackOrder,
                true,
                contentCtx,
                !canSeparateMasks,
                false,
              )
            }
            const transitionMasks = activeMasks.filter((mask) =>
              doesMaskAffectTrack(mask.trackOrder, task.trackOrder),
            )
            if (
              useGpuCompositor &&
              gpu.texturePool &&
              transitionMasks.length === 0 &&
              itemRenderContext.gpuTransitionPipeline
            ) {
              const transitionTexture = gpu.texturePool.acquire(
                canvasSettings.width,
                canvasSettings.height,
              )
              const renderedToTexture = await renderTransitionToGpuTexture(
                transitionTexture,
                task.transition,
                frame,
                itemRenderContext,
                task.trackOrder,
                gpu.texturePool,
              )
              if (renderedToTexture) {
                return {
                  gpuTexture: transitionTexture,
                  poolCanvases: [],
                } satisfies RenderedTaskResult
              }
              gpu.texturePool.release(transitionTexture)
            }
            // Transitions: render to a dedicated canvas
            return renderTransitionFallbackCanvas(task)
          } finally {
            if (taskStartMs >= 0) {
              const taskMs = performance.now() - taskStartMs
              if (taskMs >= 8) {
                const currentItem = task.type === 'item' ? getCurrentItem(task.item) : null
                scrubSlowTasks.push({
                  id:
                    currentItem?.id ??
                    (task.type === 'transition' ? task.transition.transition.id : 'unknown'),
                  kind: currentItem?.type ?? task.type,
                  ms: Number(taskMs.toFixed(2)),
                })
              }
            }
          }
        }

        const renderTasksWithInteractionLimit = async () => {
          const results: Array<RenderedTaskResult | null> = Array(renderTasks.length).fill(null)
          const concurrency =
            renderMode === 'preview' ? Math.min(1, renderTasks.length) : renderTasks.length
          let nextTaskIndex = 0
          const worker = async () => {
            while (nextTaskIndex < renderTasks.length) {
              if (isSupersededActivePreviewFrame()) return
              const taskIndex = nextTaskIndex++
              results[taskIndex] = await renderTask(renderTasks[taskIndex]!)
            }
          }
          await Promise.all(Array.from({ length: concurrency }, () => worker()))
          return results
        }

        let results: Array<RenderedTaskResult | null>
        try {
          // Ordinary playback/export retains full parallelism. Active scrubs
          // cap item-level concurrency so a complex frame cannot exhaust the
          // canvas pool while its exact worker bitmaps are still arriving.
          results = await renderTasksWithInteractionLimit()
          scrubPerfTaskEndMs = scrubPerfStartMs >= 0 ? performance.now() : -1
        } finally {
          // End GPU pool mode before compositing, even if one task fails.
          if (shouldUseDeferredGpuBatch && itemRenderContext.gpuPipeline) {
            itemRenderContext.gpuPipeline.endBatch()
          }
        }

        if (isSupersededActivePreviewFrame() || activePreviewFramePending) {
          for (const result of results) {
            if (!result) continue
            for (const pooledCanvas of result.poolCanvases) {
              canvasPool.release(pooledCanvas)
            }
            if (result.gpuTexture) {
              gpu.texturePool?.release(result.gpuTexture)
            }
          }
          canvasPool.release(contentCanvas)
          abortActivePreviewRender()
          return
        }

        // Consume pooled WebGPU canvases synchronously below. Awaiting the queue
        // here crosses a task boundary, allowing the browser to present and
        // discard a GPUCanvasContext texture before Canvas2D reads it. The first
        // drawImage performs the required GPU stall and preserves heavy effect
        // stacks without intermittent black frames.
        scrubPerfGpuWaitEndMs = scrubPerfStartMs >= 0 ? performance.now() : -1

        finalCompositeSource = await compositeFrameResults({
          useGpuCompositor,
          gpu,
          gpuCompositeOutput,
          canvasSettings,
          maskSettings,
          renderTasks,
          results,
          activeMasks,
          contentCanvas,
          contentCtx,
          itemRenderContext,
          canvasPool,
          getCurrentItem,
          getEffectiveBlendMode,
          applyTrackScopedMasks,
          renderMasksToGpuTexture,
          renderTransitionFallbackCanvas,
          renderItemWithEffects,
        })
        scrubPerfCompositeEndMs = scrubPerfStartMs >= 0 ? performance.now() : -1
      }

      // Log occlusion culling stats periodically (only in development)
      if (import.meta.env.DEV && skippedTracks > 0 && frame % 30 === 0) {
        getLog().debug(`Occlusion culling: skipped ${skippedTracks} tracks at frame ${frame}`)
      }

      ctx.drawImage(finalCompositeSource, 0, 0)

      // Release content canvas back to pool
      canvasPool.release(contentCanvas)
      cacheRenderedFrame(frame)
      if (scrubPerfStartMs >= 0) {
        const scrubPerfEndMs = performance.now()
        recordScrubPerf(frame, 'full', scrubPerfStartMs, {
          planMs: Number((scrubPerfTaskStartMs - scrubPerfStartMs).toFixed(2)),
          taskMs: Number((scrubPerfTaskEndMs - scrubPerfTaskStartMs).toFixed(2)),
          gpuWaitMs: Number((scrubPerfGpuWaitEndMs - scrubPerfTaskEndMs).toFixed(2)),
          compositeMs: Number((scrubPerfCompositeEndMs - scrubPerfGpuWaitEndMs).toFixed(2)),
          finalizeMs: Number((scrubPerfEndMs - scrubPerfCompositeEndMs).toFixed(2)),
          taskCount: renderTasks.length,
          transitionCount: activeTransitions.length,
          slowTasks: scrubSlowTasks.length > 0 ? scrubSlowTasks : undefined,
        })
      }
    },

    wasLastRenderAborted() {
      return lastRenderAborted
    },

    wasLastRenderFallback() {
      return activePreviewFallbackUsed
    },

    async prewarmFrame(frame: number) {
      // Lightweight decoder warm-up path for scrubbing:
      // decode only nearby video items into a 1x1 target without running full composition.
      const ctx2d = getPrewarmContext()
      if (!ctx2d) return

      const candidates = collectPrewarmVideoCandidatesForFrame(frame)

      const missingCandidateItemIds = candidates
        .map((item) => item.id)
        .filter((itemId) => !useMediabunny.has(itemId) && !mediabunnyDisabledItems.has(itemId))
      if (missingCandidateItemIds.length > 0) {
        await initializeMediabunnyForItems(missingCandidateItemIds)
      }

      for (const item of candidates) {
        if (!useMediabunny.has(item.id) || mediabunnyDisabledItems.has(item.id)) continue
        const extractor = videoExtractors.get(item.id)
        if (!extractor) continue

        const sourceTime = getPrewarmVideoSourceTimeSeconds(item, frame, fps)
        const clampedTime = Math.max(0, Math.min(sourceTime, extractor.getDuration() - 0.01))

        try {
          const success = await extractor.drawFrame(ctx2d, clampedTime, 0, 0, 1, 1)
          if (success) {
            mediabunnyFailureCountByItem.set(item.id, 0)
          } else {
            // Skip transient "no-sample" misses (same guard as renderVideoItem).
            const failureKind = extractor.getLastFailureKind()
            if (failureKind !== 'no-sample') {
              const failures = (mediabunnyFailureCountByItem.get(item.id) ?? 0) + 1
              mediabunnyFailureCountByItem.set(item.id, failures)
              if (failures >= PREWARM_FAILURE_DISABLE_THRESHOLD) {
                mediabunnyDisabledItems.add(item.id)
                useMediabunny.delete(item.id)
              }
            }
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') continue
          const failures = (mediabunnyFailureCountByItem.get(item.id) ?? 0) + 1
          mediabunnyFailureCountByItem.set(item.id, failures)
          getLog().warn('Prewarm decode failed', { itemId: item.id, frame, failures, error })
          if (failures >= PREWARM_FAILURE_DISABLE_THRESHOLD) {
            mediabunnyDisabledItems.add(item.id)
            useMediabunny.delete(item.id)
          }
        }
      }
    },

    /**
     * Batch-prewarm multiple frames using mediabunny's samplesAtTimestamps()
     * pipeline. Groups source timestamps by extractor and decodes each packet
     * at most once across the batch.
     *
     * Falls back to sequential prewarmFrame() for extractors where batch mode
     * has been disabled (e.g. due to "key frame required after flush" errors).
     *
     * @returns Number of frames that used batch path (vs fallback).
     */
    async prewarmFrames(frames: number[]) {
      if (frames.length === 0) return
      const ctx2d = getPrewarmContext()
      if (!ctx2d) return

      // Expand frames → candidate items → source timestamps grouped by extractor
      const batchByExtractor = new Map<
        string,
        { extractor: ReturnType<typeof videoExtractors.get>; timestamps: number[] }
      >()
      const fallbackFrames: number[] = []

      for (const frame of frames) {
        const candidates = collectPrewarmVideoCandidatesForFrame(frame)

        for (const item of candidates) {
          if (!useMediabunny.has(item.id) || mediabunnyDisabledItems.has(item.id)) continue
          const extractor = videoExtractors.get(item.id)
          if (!extractor) continue

          // Check if batch mode is available for this extractor
          if (!extractor.isBatchPrewarmAvailable()) {
            if (!fallbackFrames.includes(frame)) fallbackFrames.push(frame)
            continue
          }

          const sourceTime = getPrewarmVideoSourceTimeSeconds(item, frame, fps)
          const clampedTime = Math.max(0, Math.min(sourceTime, extractor.getDuration() - 0.01))

          const existing = batchByExtractor.get(item.id)
          if (existing) {
            existing.timestamps.push(clampedTime)
          } else {
            batchByExtractor.set(item.id, { extractor, timestamps: [clampedTime] })
          }
        }
      }

      // Initialize any missing extractors
      const missingIds = [...batchByExtractor.keys()].filter(
        (id) => !useMediabunny.has(id) && !mediabunnyDisabledItems.has(id),
      )
      if (missingIds.length > 0) {
        await initializeMediabunnyForItems(missingIds)
      }

      // Batch decode per extractor — sorted timestamps for optimal pipeline
      await Promise.all(
        [...batchByExtractor.entries()].map(async ([itemId, { extractor, timestamps }]) => {
          if (isDisposed || !extractor) return
          timestamps.sort((a, b) => a - b)
          const result = await extractor.prewarmBatch(ctx2d, timestamps, 0, 0, 1, 1)
          if (result >= 0) {
            mediabunnyFailureCountByItem.set(itemId, 0)
          }
          // result === -1 means batch disabled or failed — fallback frames
          // are handled below
        }),
      )

      // Sequential fallback for extractors where batch is disabled
      for (const frame of fallbackFrames) {
        if (isDisposed) break
        const candidates = collectPrewarmVideoCandidatesForFrame(frame)
        for (const item of candidates) {
          if (!useMediabunny.has(item.id) || mediabunnyDisabledItems.has(item.id)) continue
          const extractor = videoExtractors.get(item.id)
          if (!extractor) continue
          const sourceTime = getPrewarmVideoSourceTimeSeconds(item, frame, fps)
          const clampedTime = Math.max(0, Math.min(sourceTime, extractor.getDuration() - 0.01))
          try {
            await extractor.drawFrame(ctx2d, clampedTime, 0, 0, 1, 1)
          } catch {
            /* best-effort fallback */
          }
        }
      }
    },

    setDomVideoElementProvider(
      provider: ((itemId: string) => HTMLVideoElement | null) | undefined,
    ) {
      itemRenderContext.domVideoElementProvider = provider
      liveDomVideoPlaybackActive = Boolean(provider)
      scrubbingFrameCacheActive = shouldUseScrubbingFrameCache(
        Boolean(scrubbingCache),
        liveDomVideoPlaybackActive,
      )
    },

    /**
     * Pre-initialize mediabunny decoders for specific item IDs and optionally
     * seek them to a target frame. This warms up the WASM decoder and positions
     * the decode cursor so the first real render is fast (~1ms instead of 300-500ms).
     *
     * For variable-speed clips, also advances the decoder up to ~2.5s ahead of
     * the target frame in sequential 0.5s steps. This ensures the decoder cursor
     * is within the 3s forward-jump threshold of any frame that might be rendered
     * in the near future — preventing 400-500ms keyframe seeks when occluded clips
     * become visible mid-playback.
     */
    async prewarmItems(itemIds: string[], targetFrame?: number) {
      const unready = itemIds.filter(
        (id) =>
          videoExtractors.has(id) && !useMediabunny.has(id) && !mediabunnyDisabledItems.has(id),
      )
      if (unready.length > 0) {
        await initializeMediabunnyForItems(unready)
      }
      // Seek decoders to the target frame position using a 1x1 draw.
      // Run all clips in parallel — each has its own decoder lane.
      // NOTE: localFrame may be negative for incoming transition clips whose
      // timeline `from` is after targetFrame — the transition renderer will
      // still render them. We allow negative localFrame and clamp sourceTime
      // to zero so the decoder is positioned at the clip's start.
      if (targetFrame !== undefined) {
        const ctx2d = getPrewarmContext()
        if (!ctx2d) return
        await Promise.all(
          itemIds.map(async (itemId) => {
            if (isDisposed) return
            const extractor = videoExtractors.get(itemId)
            if (!extractor || !useMediabunny.has(itemId)) return
            const item = videoItemsById.get(itemId)
            if (!item || item.type !== 'video') return
            const localFrame = targetFrame - item.from
            if (localFrame >= item.durationInFrames) return
            const baseSourceTime = getPrewarmVideoSourceTimeSeconds(item, targetFrame, fps)
            try {
              await extractor.drawFrame(ctx2d, Math.max(0, baseSourceTime), 0, 0, 1, 1)
            } catch {
              // Best-effort prewarm — ignore failures.
            }
          }),
        )
      }
    },

    /** Evict cached render frames or cached frame ranges after visual edits. */
    invalidateFrameCache(request?: FrameInvalidationRequest) {
      frameSceneRevision += 1
      frameSceneCache.invalidate(request)
      scrubbingCache?.invalidate(request)
    },

    /** Get the scrubbing cache instance for stats/GPU wiring. */
    getScrubbingCache(): ScrubbingCache | null {
      return scrubbingCache
    },

    /** Get the offscreen canvas this renderer draws into. */
    getCanvas(): OffscreenCanvas {
      return canvas
    },

    /**
     * Eagerly initialize the GPU effects + transition pipelines so the first
     * transition frame doesn't pay the ~100-150ms WebGPU device + shader
     * compilation cost. Safe to call multiple times — no-ops if already warm.
     */
    async warmGpuPipeline(): Promise<void> {
      const pipeline = await gpu.ensureEffects()
      if (pipeline) {
        gpu.ensureTransition()
        gpu.ensureMedia()
        gpu.ensureMediaBlend()
        gpu.ensureShape()
        gpu.ensureText()
        gpu.ensureMaskCombine()
        itemRenderContext.gpuPipeline = pipeline
        itemRenderContext.gpuTransitionPipeline = gpu.transition
        itemRenderContext.gpuMediaPipeline = gpu.media
        itemRenderContext.gpuMediaBlendPipeline = gpu.mediaBlend
        itemRenderContext.gpuShapePipeline = gpu.shape
        itemRenderContext.gpuTextPipeline = gpu.text
        itemRenderContext.gpuMaskCombinePipeline = gpu.maskCombine
      }
    },

    dispose() {
      isDisposed = true
      inFlightInitByItem.clear()

      // Clean up mediabunny video extractors
      for (const [itemId, src] of videoSourceByItemId) {
        sharedVideoExtractors.releaseItem(itemId, src)
      }
      if (sharedPreviewExtractorLease) {
        sharedPreviewExtractorLease.release()
      } else {
        sharedVideoExtractors.dispose()
      }
      videoExtractors.clear()
      videoSourceByItemId.clear()
      videoItemIdsBySource.clear()
      videoItemsById.clear()
      useMediabunny.clear()
      mediabunnyFailureCountByItem.clear()
      mediabunnyInitFailureCountByItem.clear()
      mediabunnyDisabledItems.clear()

      // Clean up fallback video pool and references.
      // In this renderer, fallback video elements are only bound when a DOM is
      // available, which is also when fallbackVideoPool exists.
      if (fallbackVideoPool) {
        for (const clipId of fallbackVideoClipIdByItem.values()) {
          fallbackVideoPool.releaseClip(clipId)
        }
        fallbackVideoPool.dispose()
      }
      fallbackVideoBySrc.clear()
      fallbackVideoClipIdByItem.clear()
      videoElements.clear()
      for (const image of imageElements.values()) {
        if ('close' in image.source && typeof image.source.close === 'function') {
          image.source.close()
        }
      }
      imageElements.clear()
      gifFramesMap.clear() // Clear GIF frame references (actual frames are managed by gifFrameCache)
      lottieProvider.destroy() // Tear down dotlottie WASM instances
      subCompRenderData.clear() // Release sub-composition render data references
      subCompRenderDataSource.clear()
      prewarmCtx = null
      prewarmCanvas = null
      prewarmAttempted = false

      // === PERFORMANCE: Clean up optimization resources ===
      scrubbingCache?.dispose()
      reverseVideoFrameCache?.dispose()
      // Preview-only cross-frame caches hold canvas backing stores (hundreds of
      // MB for text rasters / corner-pin warps); drop them now instead of at GC.
      itemRenderContext.textRasterCache?.clear()
      itemRenderContext.cornerPinWarpCache?.clear()

      gpu.dispose()
      frameSceneCache.invalidate()
      canvasPool.dispose()
      textMeasureCache.clear()

      // Log pool stats in development
      if (import.meta.env.DEV) {
        getLog().debug('Canvas pool disposed', canvasPool.getStats())
      }
    },
  }
}
