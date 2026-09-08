import type { ImageItem, TimelineItem, VideoItem } from '@/types/timeline'
import type { ItemKeyframes } from '@/types/keyframe'
import type { ItemEffect } from '@/types/effects'
import { hasMediaCrop } from '@/shared/utils/media-crop'
import { getAnimatedCrop, getAnimatedTransform } from './canvas-keyframes'
import { resolveAnimatedColorEffects } from '@/features/export/deps/keyframes'
import { getAdjustmentLayerEffects, type AdjustmentLayerWithTrackOrder } from './canvas-effects'
import type { CanvasSettings } from './canvas-item-renderer'

export interface FrameOcclusionContext {
  frame: number
  canvasWidth: number
  canvasHeight: number
  canvasSettings: CanvasSettings
  renderMode: 'export' | 'preview'
  /** Clip ids participating in a transition this frame (blended, never fully occluding). */
  transitionClipIds: ReadonlySet<string>
  adjustmentLayers: AdjustmentLayerWithTrackOrder[]
  getCurrentItem: <TItem extends TimelineItem>(item: TItem) => TItem
  getCurrentKeyframes: (itemId: string) => ItemKeyframes | undefined
  getPreviewEffectsOverride?: (itemId: string) => ItemEffect[] | undefined
  getLiveItemSnapshot?: (itemId: string) => TimelineItem | undefined
  /** True only after the decoder proves that a video's source cannot carry alpha. */
  isVideoSourceKnownOpaque?: (item: VideoItem) => boolean
  /** True only when imported image metadata proves that the source cannot carry alpha. */
  isImageSourceKnownOpaque?: (item: ImageItem) => boolean
}

function isKnownOpaqueMedia(
  item: TimelineItem,
  ctx: Pick<FrameOcclusionContext, 'isVideoSourceKnownOpaque' | 'isImageSourceKnownOpaque'>,
): item is VideoItem | ImageItem {
  if (item.type === 'video') return ctx.isVideoSourceKnownOpaque?.(item) === true
  if (item.type === 'image') return ctx.isImageSourceKnownOpaque?.(item) === true
  return false
}

function hasCompatibleLayerInteraction(
  item: VideoItem | ImageItem,
  transitionClipIds: ReadonlySet<string>,
): boolean {
  const blendModeIsNormal = !item.blendMode || item.blendMode === 'normal'
  return !transitionClipIds.has(item.id) && blendModeIsNormal && !item.cornerPin
}

function hasCompatibleTransform(
  item: VideoItem | ImageItem,
  ctx: Pick<
    FrameOcclusionContext,
    'frame' | 'canvasWidth' | 'canvasHeight' | 'canvasSettings' | 'getCurrentKeyframes'
  >,
): boolean {
  const itemKeyframes = ctx.getCurrentKeyframes(item.id)
  const animatedCrop = getAnimatedCrop(item, itemKeyframes, ctx.frame, ctx.canvasSettings)
  if (hasMediaCrop(animatedCrop)) return false
  const transform = getAnimatedTransform(item, itemKeyframes, ctx.frame, ctx.canvasSettings)
  if (transform.opacity < 1 || transform.cornerRadius > 0) return false
  if (!isFullCoverageRotation(transform.rotation)) return false
  return coversCanvas(transform, ctx.canvasWidth, ctx.canvasHeight)
}

function isFullCoverageRotation(rotation: number): boolean {
  const normalized = rotation % 360
  return normalized === 0 || Math.abs(normalized) === 180
}

function coversCanvas(
  transform: ReturnType<typeof getAnimatedTransform>,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  const itemLeft = canvasWidth / 2 + transform.x - transform.width / 2
  const itemTop = canvasHeight / 2 + transform.y - transform.height / 2
  const itemRight = itemLeft + transform.width
  const itemBottom = itemTop + transform.height
  const tolerance = 1
  return (
    Math.max(itemLeft, itemTop) <= tolerance &&
    Math.min(itemRight - canvasWidth, itemBottom - canvasHeight) >= -tolerance
  )
}

function effectPreservesOpacity(effectWrapper: ItemEffect): boolean {
  if (!effectWrapper.enabled) return true
  const effect = effectWrapper.effect
  if (!('opacity' in effect) || typeof effect.opacity !== 'number') return true
  return effect.opacity >= 1
}

/**
 * Whether `baseItem` fully and opaquely covers the canvas this frame, so every
 * track below it (higher order) can be skipped during occlusion culling.
 *
 * An item fully occludes only when it is opaque video/image content that covers
 * the whole canvas after transform/keyframes with: opacity 1, rotation 0/180,
 * no corner radius, no crop, no corner pin, normal blend mode, not in a
 * transition, and no transparency-adding effects (item or adjustment-layer).
 *
 * Pure predicate extracted verbatim from `createCompositionRenderer`'s
 * per-frame render path — no side effects.
 */
export function isItemFullyOccluding(
  baseItem: TimelineItem,
  trackOrder: number,
  ctx: FrameOcclusionContext,
): boolean {
  const item = ctx.getCurrentItem(baseItem)
  if (!isKnownOpaqueMedia(item, ctx)) return false
  if (!hasCompatibleLayerInteraction(item, ctx.transitionClipIds)) return false
  if (!hasCompatibleTransform(item, ctx)) return false

  // Check for effects that might add transparency
  const itemEffects =
    resolveAnimatedColorEffects(
      item.effects ?? [],
      ctx.getCurrentKeyframes(item.id),
      ctx.frame - item.from,
    ) ?? []
  const adjEffects = getAdjustmentLayerEffects(
    trackOrder,
    ctx.adjustmentLayers,
    ctx.frame,
    ctx.renderMode === 'preview' ? ctx.getPreviewEffectsOverride : undefined,
    ctx.renderMode === 'preview' ? ctx.getLiveItemSnapshot : undefined,
    ctx.getCurrentKeyframes,
  )
  const allEffects = [...itemEffects, ...adjEffects]

  return allEffects.every(effectPreservesOpacity)
}
