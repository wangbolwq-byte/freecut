/**
 * Headless render harness.
 *
 * This is a dedicated Vite entry (loaded by `headless.html`) that exposes a
 * small `window.autocut` API so a Node/Playwright or Electron driver can render projects to
 * video inside a real (headless) Chrome — reusing the exact same render engine
 * the editor uses, with no React UI, router, or workspace gate mounted.
 *
 * Browser APIs the render path depends on (WebCodecs, WebGPU, OffscreenCanvas,
 * OfflineAudioContext) all work in headless Chrome on a secure-context origin
 * (localhost), so fidelity matches the in-app export.
 *
 * Media is provided as fetchable URLs (served same-origin by the driver) and
 * seeded into `blobUrlManager`, so the real `resolveMediaUrls()` and the
 * engine's sub-composition media lookup resolve without the workspace/storage
 * layer being present.
 */
import type { Project } from '@/types/project'
import type { TimelineTrack, TimelineItem } from '@/types/timeline'
import type { Transition } from '@/types/transition'
import type { ItemKeyframes } from '@/types/keyframe'
import type { AudioEqSettings } from '@/types/audio'
import type { CompositionInputProps } from '@/types/export'
import type { MediaMetadata } from '@/types/storage'
import type { ItemEffect } from '@/types/effects'

import { createLogger } from '@/shared/logging/logger'
import { CURRENT_SCHEMA_VERSION, migrateProject } from '@/shared/projects/migrations'
import {
  DEFAULT_PROJECT_FPS,
  DEFAULT_PROJECT_HEIGHT,
  DEFAULT_PROJECT_WIDTH,
} from '@/shared/projects/defaults'
import { validateProject } from '@/features/project-bundle/schemas/project-schema'
import { mediaProcessorService } from '@/features/media-library/services/media-processor-service'
import { getMimeType, validateMediaFileContent } from '@/features/media-library/utils/validation'
import { convertTimelineToComposition } from '@/features/export/utils/timeline-to-composition'
import {
  renderComposition,
  renderAudioOnly,
} from '@/features/export/utils/canvas-render-orchestrator'
import { getAudioContentInfo } from '@/features/export/utils/canvas-audio'
import type {
  ClientExportSettings,
  ClientRenderResult,
  RenderProgress,
} from '@/features/export/utils/client-renderer'
import {
  getSupportedCodecs,
  selectFallbackVideoCodec,
  getPreferredContainerForCodec,
  getDefaultAudioCodec,
} from '@/features/export/utils/client-renderer'
import type { ClientVideoContainer } from '@/features/export/utils/client-renderer'
import { resolveMediaUrls } from '@/features/media-library/utils/media-resolver'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import {
  useCompositionsStore,
  type SubComposition,
} from '@/features/export/deps/timeline-compositions'
import { editProject } from './edit'
import { seedMediaLibrary } from './seed-media'

const log = createLogger('Headless')

interface HeadlessMediaSource {
  mediaId: string
  /** Same-origin (or CORS+CORP) URL the harness can fetch the full media bytes from. */
  url: string
  /** File size + modification-time identity supplied by the Node driver. */
  fingerprint?: string
  /**
   * The media's MediaMetadata (from the workspace `media/<id>/metadata.json`).
   * Seeded into the media-library store so codec lookups work — notably so
   * AC-3/E-AC-3 audio triggers the @mediabunny/ac3 decoder during export.
   */
  metadata?: MediaMetadata
}

/** Render from already-extracted timeline data (no Project schema required). */
interface HeadlessTimelineInput {
  tracks: TimelineTrack[]
  items: TimelineItem[]
  transitions?: Transition[]
  fps: number
  width: number
  height: number
  inPoint?: number | null
  outPoint?: number | null
  keyframes?: ItemKeyframes[]
  backgroundColor?: string
  busAudioEq?: AudioEqSettings
  masterBusDb?: number
  compositions?: SubComposition[]
  media?: HeadlessMediaSource[]
  mediaSessionId?: string
  settings: ClientExportSettings
  outputFileName?: string
}

/** Render a full Project object (runs migrations, then extracts the timeline). */
interface HeadlessProjectInput {
  project: Project
  settings: ClientExportSettings
  media?: HeadlessMediaSource[]
  mediaSessionId?: string
  /** When true (default), ignore the project's in/out points and render everything. */
  renderWholeProject?: boolean
  /**
   * Explicit render range in project frames. When provided, overrides both the
   * project's stored in/out points and renderWholeProject. Useful for rendering
   * a slice of a long project from the CLI.
   */
  inPoint?: number | null
  outPoint?: number | null
  outputFileName?: string
}

interface HeadlessRenderSummary {
  ok: true
  mimeType: string
  fileSize: number
  durationSeconds: number
  fileName: string
  /** Settings actually used after browser capability adaptation. */
  effectiveSettings: ClientExportSettings
  /** Non-fatal, machine-readable render degradations. */
  warnings: HeadlessRenderWarning[]
  audio: {
    expected: boolean
    segmentsTotal: number
    segmentsProcessed: number
    failedSegments: number
    outputTrackPresent: boolean
  }
  output: {
    videoTracks: number
    audioTracks: number
    videoCodec: string | null
    audioCodec: string | null
    durationSeconds: number
  }
  timings: {
    mediaRegistrationMs: number
    preparationMs: number
    audioProcessingMs: number
    videoRenderMs: number
    videoEncodeBackpressureMs: number
    muxMs: number
    outputValidationMs: number
    totalMs: number
    downloadMs?: number
  }
  encoder: {
    preset?: 'draft' | 'balanced' | 'final'
    hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software'
    latencyMode: 'quality' | 'realtime'
    maxQueueDepth: number
    peakQueueDepth: number
  }
}

interface HeadlessRenderWarning {
  code: 'CODEC_FALLBACK' | 'WEBGPU_TRANSITION_FALLBACK' | 'HARDWARE_ACCELERATION_FALLBACK'
  message: string
  details?: Record<string, unknown>
}

class HeadlessRenderError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`)
    this.name = 'HeadlessRenderError'
    this.code = code
    this.details = details
  }
}

function normalizeHeadlessRenderError(error: unknown): Error {
  if (error instanceof HeadlessRenderError) return error
  const normalized = error instanceof Error ? error : new Error(String(error))
  const code = Reflect.get(Object(error), 'code') as unknown
  if (typeof code !== 'string') return normalized
  return new HeadlessRenderError(code, normalized.message, errorDetails(error))
}

function errorDetails(error: unknown): Record<string, unknown> {
  const details = Reflect.get(Object(error), 'details') as unknown
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}
}

async function inspectRenderedOutput(blob: Blob): Promise<HeadlessRenderSummary['output']> {
  const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny')
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    if (!(await input.canRead())) {
      throw new HeadlessRenderError('OUTPUT_VALIDATION_FAILED', 'Rendered media is unreadable')
    }
    const [videoTracks, audioTracks, durationSeconds] = await Promise.all([
      input.getVideoTracks(),
      input.getAudioTracks(),
      input.computeDuration(),
    ])
    const [videoCodec, audioCodec] = await Promise.all([
      videoTracks[0]?.getCodec() ?? Promise.resolve(null),
      audioTracks[0]?.getCodec() ?? Promise.resolve(null),
    ])
    return {
      videoTracks: videoTracks.length,
      audioTracks: audioTracks.length,
      videoCodec,
      audioCodec,
      durationSeconds,
    }
  } finally {
    input.dispose()
  }
}

type ProgressSink = (progress: RenderProgress) => void

function reportProgress(progress: RenderProgress): void {
  const sink = (globalThis as unknown as { __freecutProgress?: ProgressSink }).__freecutProgress
  if (!sink) return
  try {
    sink(progress)
  } catch {
    // The driver-side binding may be torn down mid-render; ignore.
  }
}

/**
 * Register media URLs so resolveMediaUrls() + the engine's sub-comp media
 * lookup (blobUrlManager.get) resolve to them. We register the URL WITHOUT
 * downloading the bytes: mediabunny then reads via UrlSource (HTTP Range),
 * so large clips stream instead of being held fully in memory.
 */
interface RegisteredMediaSession {
  id: string
  entries: Array<{ mediaId: string; url: string }>
}

function registerMediaUrls(
  media: HeadlessMediaSource[] | undefined,
  requestedSessionId?: string,
): RegisteredMediaSession {
  const session: RegisteredMediaSession = {
    id: requestedSessionId || crypto.randomUUID(),
    entries: [],
  }
  for (const { mediaId, url, fingerprint } of media ?? []) {
    blobUrlManager.replaceUrl(mediaId, url, { fingerprint })
    session.entries.push({ mediaId, url })
  }
  return session
}

function releaseMediaUrls(session: RegisteredMediaSession): void {
  for (const { mediaId, url } of session.entries) {
    if (blobUrlManager.get(mediaId) === url) blobUrlManager.invalidate(mediaId)
  }
  log.debug('Released headless media session', {
    mediaSessionId: session.id,
    mediaCount: session.entries.length,
  })
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Defer revoke so the browser/Playwright has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 120_000)
}

function defaultFileName(settings: ClientExportSettings): string {
  return `freecut-export.${settings.container}`
}

function effectiveFileName(requested: string | undefined, settings: ClientExportSettings): string {
  if (!requested) return defaultFileName(settings)
  return `${requested.replace(/\.[^./\\]+$/, '')}.${settings.container}`
}

async function detectWebGpu(): Promise<boolean> {
  try {
    if (!('gpu' in navigator) || !navigator.gpu) return false
    const adapter = await navigator.gpu.requestAdapter()
    return Boolean(adapter)
  } catch {
    return false
  }
}

const hasEnabledEffects = (items: Array<{ effects?: ItemEffect[] }>): boolean =>
  items.some((item) => item.effects?.some((effect) => effect.enabled))

/** Whether the render needs WebGPU: GPU effects have no Canvas2D fallback. */
function compositionUsesGpuEffects(
  composition: CompositionInputProps,
  compositions: SubComposition[],
): boolean {
  const topLevel = (composition.tracks ?? []).flatMap((track) => track.items ?? [])
  if (hasEnabledEffects(topLevel)) return true
  return compositions.some((comp) => hasEnabledEffects(comp.items ?? []))
}

/**
 * Verify WebGPU is available when the project needs it. GPU effects can't fall
 * back to Canvas2D, so rendering them without WebGPU would silently drop them —
 * fail loudly instead. Transitions DO have a Canvas2D fallback, so a missing
 * GPU there is only a warning.
 */
async function assertGpuForComposition(
  composition: CompositionInputProps,
  compositions: SubComposition[],
): Promise<HeadlessRenderWarning[]> {
  const needsGpuEffects = compositionUsesGpuEffects(composition, compositions)
  const hasTransitions = (composition.transitions?.length ?? 0) > 0
  if (!needsGpuEffects && !hasTransitions) return []

  const gpuAvailable = await detectWebGpu()
  if (gpuAvailable) return []

  if (needsGpuEffects) {
    throw new Error(
      'This project uses GPU effects but WebGPU is unavailable in this environment, ' +
        'so effects cannot render. Launch Chrome with --enable-unsafe-webgpu on a machine ' +
        'with a GPU (or SwiftShader/Vulkan in headless/Docker).',
    )
  }
  const warning: HeadlessRenderWarning = {
    code: 'WEBGPU_TRANSITION_FALLBACK',
    message: 'WebGPU unavailable; transitions will use the Canvas2D fallback',
  }
  log.warn(warning.message)
  return [warning]
}

/**
 * Ensure the requested video codec is actually encodable in this browser;
 * otherwise fall back the same way the in-app export does.
 */
async function adaptVideoSettings(
  requestedSettings: ClientExportSettings,
): Promise<{ settings: ClientExportSettings; warnings: HeadlessRenderWarning[] }> {
  const settings = structuredClone(requestedSettings)
  if (settings.mode === 'audio') return { settings, warnings: [] }
  const warnings: HeadlessRenderWarning[] = []
  const testOverride = (
    globalThis as unknown as {
      __freecutSupportedCodecsOverride?: Awaited<ReturnType<typeof getSupportedCodecs>>
    }
  ).__freecutSupportedCodecsOverride
  const supported =
    testOverride ??
    (await getSupportedCodecs({
      width: settings.resolution.width,
      height: settings.resolution.height,
      bitrate: settings.videoBitrate,
    }))
  if (supported.includes(settings.codec)) {
    settings.audioCodec = getDefaultAudioCodec(settings.container)
  } else {
    const container = settings.container as ClientVideoContainer
    const fallback =
      selectFallbackVideoCodec(supported, container) ?? selectFallbackVideoCodec(supported)
    if (!fallback) {
      throw new Error(
        `No supported video codec available (requested ${settings.codec}; browser supports: ${supported.join(', ') || 'none'})`,
      )
    }
    const requested = settings.codec
    const effectiveContainer = getPreferredContainerForCodec(fallback)
    const warning: HeadlessRenderWarning = {
      code: 'CODEC_FALLBACK',
      message: `Requested video codec ${requested} is unsupported; using ${fallback}/${effectiveContainer}`,
      details: { requestedCodec: requested, effectiveCodec: fallback, effectiveContainer },
    }
    log.warn(warning.message, {
      requested,
      fallback,
      container: effectiveContainer,
    })
    settings.codec = fallback
    settings.container = effectiveContainer
    settings.audioCodec = getDefaultAudioCodec(effectiveContainer)
    warnings.push(warning)
  }

  if (settings.hardwareAcceleration === 'prefer-hardware') {
    let hardwareSupported = false
    try {
      const { canEncodeVideo } = await import('mediabunny')
      hardwareSupported = await canEncodeVideo(settings.codec, {
        width: settings.resolution.width,
        height: settings.resolution.height,
        bitrate: settings.videoBitrate,
        latencyMode: settings.latencyMode ?? 'quality',
        hardwareAcceleration: 'prefer-hardware',
      })
    } catch (error) {
      log.warn('Hardware encoder capability probe failed', { error })
    }
    if (!hardwareSupported) {
      settings.hardwareAcceleration = 'no-preference'
      warnings.push({
        code: 'HARDWARE_ACCELERATION_FALLBACK',
        message: 'Preferred hardware video encoding is unavailable; using the browser default',
        details: { requested: 'prefer-hardware', effective: 'no-preference' },
      })
    }
  }

  return { settings, warnings }
}

type AudioContentInfo = Awaited<ReturnType<typeof getAudioContentInfo>>

async function renderCompositionForSettings(
  settings: ClientExportSettings,
  composition: CompositionInputProps,
): Promise<ClientRenderResult> {
  return settings.mode === 'audio'
    ? await renderAudioOnly({ settings, composition, onProgress: reportProgress })
    : await renderComposition({ settings, composition, onProgress: reportProgress })
}

function validateRenderedTracks(
  settings: ClientExportSettings,
  audioContent: AudioContentInfo,
  output: HeadlessRenderSummary['output'],
): void {
  validateRenderedVideoTrack(settings, output)
  validateRenderedAudioTrack(audioContent, output)
}

function validateRenderedVideoTrack(
  settings: ClientExportSettings,
  output: HeadlessRenderSummary['output'],
): void {
  if (settings.mode !== 'video') return
  if (output.videoTracks > 0) return
  throw new HeadlessRenderError(
    'OUTPUT_VIDEO_TRACK_MISSING',
    'Rendered video does not contain a video track',
  )
}

function validateRenderedAudioTrack(
  audioContent: AudioContentInfo,
  output: HeadlessRenderSummary['output'],
): void {
  if (!audioContent.expected) return
  if (output.audioTracks > 0) return
  throw new HeadlessRenderError(
    'OUTPUT_AUDIO_TRACK_MISSING',
    'Active audio exists but the rendered output does not contain an audio track',
    { segmentsTotal: audioContent.segmentsTotal },
  )
}

function optionalPreset(
  preset: ClientExportSettings['preset'],
): Pick<HeadlessRenderSummary['encoder'], 'preset'> | Record<never, never> {
  return preset ? { preset } : {}
}

function defaultEncoderDiagnostics(
  settings: ClientExportSettings,
): HeadlessRenderSummary['encoder'] {
  const queueDepth = defaultQueueDepth(settings)
  return {
    ...optionalPreset(settings.preset),
    hardwareAcceleration: settings.hardwareAcceleration ?? 'no-preference',
    latencyMode: settings.latencyMode ?? 'quality',
    maxQueueDepth: queueDepth,
    peakQueueDepth: queueDepth === 0 ? 0 : 1,
  }
}

function defaultQueueDepth(settings: ClientExportSettings): number {
  if (settings.mode === 'audio') return 0
  return settings.maxEncoderQueue ?? 1
}

function createHeadlessRenderSummary(input: {
  result: ClientRenderResult
  settings: ClientExportSettings
  warnings: HeadlessRenderWarning[]
  audioContent: AudioContentInfo
  output: HeadlessRenderSummary['output']
  fileName: string
  mediaRegistrationMs: number
  outputValidationMs: number
  renderStartedAt: number
}): HeadlessRenderSummary {
  const diagnostics = input.result.diagnostics
  const timings = diagnostics ? diagnostics.timings : EMPTY_RENDER_TIMINGS
  const encoder = diagnostics ? diagnostics.encoder : defaultEncoderDiagnostics(input.settings)
  return {
    ok: true,
    mimeType: input.result.mimeType,
    fileSize: input.result.fileSize,
    durationSeconds: input.result.duration,
    fileName: input.fileName,
    effectiveSettings: input.settings,
    warnings: input.warnings,
    audio: {
      expected: input.audioContent.expected,
      segmentsTotal: input.audioContent.segmentsTotal,
      segmentsProcessed: input.audioContent.segmentsTotal,
      failedSegments: 0,
      outputTrackPresent: input.output.audioTracks > 0,
    },
    output: input.output,
    timings: {
      mediaRegistrationMs: input.mediaRegistrationMs,
      preparationMs: timings.preparationMs,
      audioProcessingMs: timings.audioProcessingMs,
      videoRenderMs: timings.videoRenderMs,
      videoEncodeBackpressureMs: timings.videoEncodeBackpressureMs,
      muxMs: timings.muxMs,
      outputValidationMs: input.outputValidationMs,
      totalMs: performance.now() - input.renderStartedAt,
    },
    encoder,
  }
}

const EMPTY_RENDER_TIMINGS = {
  preparationMs: 0,
  audioProcessingMs: 0,
  videoRenderMs: 0,
  videoEncodeBackpressureMs: 0,
  muxMs: 0,
  totalMs: 0,
} as const

function mediaSourceCount(media: HeadlessMediaSource[] | undefined): number {
  return media ? media.length : 0
}

async function renderTimeline(input: HeadlessTimelineInput): Promise<HeadlessRenderSummary> {
  const renderStartedAt = performance.now()
  const {
    tracks,
    items,
    transitions = [],
    fps,
    width,
    height,
    inPoint = null,
    outPoint = null,
    keyframes = [],
    backgroundColor,
    busAudioEq,
    masterBusDb,
    compositions = [],
    media,
    mediaSessionId,
    settings: requestedSettings,
  } = input

  log.info('Headless render starting', {
    mode: requestedSettings.mode,
    codec: requestedSettings.codec,
    container: requestedSettings.container,
    resolution: `${requestedSettings.resolution.width}x${requestedSettings.resolution.height}`,
    fps,
    tracks: tracks.length,
    items: items.length,
    compositions: compositions.length,
    media: mediaSourceCount(media),
  })

  const mediaRegistrationStartedAt = performance.now()
  const registeredMedia = registerMediaUrls(media, mediaSessionId)
  const mediaRegistrationMs = performance.now() - mediaRegistrationStartedAt
  try {
    // Seed sub-compositions so the engine can resolve compound clips.
    useCompositionsStore.getState().setCompositions(compositions)

    // Seed media metadata so codec lookups resolve (enables AC-3/E-AC-3 audio).
    seedMediaLibrary(media)

    const { settings, warnings } = await adaptVideoSettings(requestedSettings)

    const composition: CompositionInputProps = convertTimelineToComposition(
      tracks,
      items,
      transitions,
      fps,
      width,
      height,
      inPoint,
      outPoint,
      keyframes,
      backgroundColor,
      busAudioEq,
      masterBusDb,
    )

    // Fail loudly if the project needs WebGPU (effects) but it isn't available.
    warnings.push(...(await assertGpuForComposition(composition, compositions)))

    // Resolve top-level media (mediaId -> seeded blob URL). Export never uses proxies.
    composition.tracks = await resolveMediaUrls(composition.tracks, { useProxy: false })

    const audioContent = await getAudioContentInfo(composition)
    const result = await renderCompositionForSettings(settings, composition)

    const outputValidationStartedAt = performance.now()
    const output = await inspectRenderedOutput(result.blob)
    const outputValidationMs = performance.now() - outputValidationStartedAt
    validateRenderedTracks(settings, audioContent, output)

    const fileName = effectiveFileName(input.outputFileName, settings)
    triggerDownload(result.blob, fileName)

    log.info('Headless render complete', {
      mimeType: result.mimeType,
      fileSize: result.fileSize,
      durationSeconds: result.duration,
      fileName,
      mediaSessionId: registeredMedia.id,
    })

    return createHeadlessRenderSummary({
      result,
      settings,
      warnings,
      audioContent,
      output,
      fileName,
      mediaRegistrationMs,
      outputValidationMs,
      renderStartedAt,
    })
  } catch (error) {
    throw normalizeHeadlessRenderError(error)
  } finally {
    releaseMediaUrls(registeredMedia)
  }
}

async function renderProject(input: HeadlessProjectInput): Promise<HeadlessRenderSummary> {
  const {
    project: rawProject,
    settings,
    media,
    mediaSessionId,
    renderWholeProject = true,
    outputFileName,
  } = input
  const { project } = migrateProject(rawProject)
  const timeline = project.timeline
  if (!timeline) {
    throw new Error('Project has no timeline to render')
  }

  const meta = project.metadata
  const hasExplicitRange = input.inPoint != null || input.outPoint != null
  const inPoint = hasExplicitRange
    ? (input.inPoint ?? null)
    : renderWholeProject
      ? null
      : (timeline.inPoint ?? null)
  const outPoint = hasExplicitRange
    ? (input.outPoint ?? null)
    : renderWholeProject
      ? null
      : (timeline.outPoint ?? null)

  return renderTimeline({
    tracks: (timeline.tracks ?? []) as unknown as TimelineTrack[],
    items: (timeline.items ?? []) as unknown as TimelineItem[],
    transitions: (timeline.transitions ?? []) as Transition[],
    fps: meta?.fps ?? 30,
    width: meta?.width ?? 1920,
    height: meta?.height ?? 1080,
    inPoint,
    outPoint,
    keyframes: (timeline.keyframes ?? []) as unknown as ItemKeyframes[],
    backgroundColor: meta?.backgroundColor,
    busAudioEq: timeline.busAudioEq,
    masterBusDb: timeline.masterBusDb,
    compositions: (timeline.compositions ?? []) as unknown as SubComposition[],
    media,
    mediaSessionId,
    settings,
    outputFileName,
  })
}

interface FreecutHeadlessApi {
  ready: true
  renderTimeline: typeof renderTimeline
  renderProject: typeof renderProject
  editProject: typeof editProject
  normalizeProject: typeof normalizeProjectForHeadless
  probeMedia: typeof probeMedia
  createProject: typeof createProjectForHeadless
}

function createProjectForHeadless(input: {
  id?: string
  name: string
  description?: string
  width?: number
  height?: number
  fps?: number
  backgroundColor?: string
}): Project {
  const now = Date.now()
  const raw: Project = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name,
    description: input.description ?? '',
    createdAt: now,
    updatedAt: now,
    duration: 0,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    metadata: {
      width: input.width ?? DEFAULT_PROJECT_WIDTH,
      height: input.height ?? DEFAULT_PROJECT_HEIGHT,
      fps: input.fps ?? DEFAULT_PROJECT_FPS,
      ...(input.backgroundColor ? { backgroundColor: input.backgroundColor } : {}),
    },
  }
  const validated = validateProject(raw)
  if (!validated.success || !validated.data) throw new Error('Created project failed validation')
  return validated.data as Project
}

async function normalizeProjectForHeadless(raw: unknown): Promise<Project> {
  const validated = validateProject(raw)
  if (!validated.success || !validated.data) {
    throw new Error(
      `Project validation failed: ${validated.errors?.issues[0]?.message ?? 'invalid project'}`,
    )
  }
  const migrated = migrateProject(validated.data as Project).project
  const current = validateProject(migrated)
  if (!current.success || !current.data) throw new Error('Migrated project failed validation')
  return current.data as Project
}

async function probeMedia(input: { url: string; fileName: string; mimeType?: string }) {
  const response = await fetch(input.url)
  if (!response.ok) throw new Error(`Media fetch failed: HTTP ${response.status}`)
  if (!response.body || typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error('Streaming media probe requires OPFS and a readable response body')
  }
  const root = await navigator.storage.getDirectory()
  const safeName = input.fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-160) || 'source.bin'
  const tempName = `.freecut-probe-${crypto.randomUUID()}-${safeName}`
  try {
    const handle = await root.getFileHandle(tempName, { create: true })
    const writable = await handle.createWritable()
    await response.body.pipeTo(writable)
    const file = await handle.getFile()
    const validation = await validateMediaFileContent(file)
    if (!validation.valid) throw new Error(validation.error ?? 'Media validation failed')
    const mimeType = input.mimeType || getMimeType(file)
    const { metadata } = await mediaProcessorService.processMedia(file, mimeType, {
      generateThumbnail: false,
      fastMetadata: true,
    })
    return { mimeType, metadata }
  } finally {
    await root.removeEntry(tempName).catch(() => {})
  }
}

declare global {
  interface Window {
    autocut: FreecutHeadlessApi
    freecut: FreecutHeadlessApi
  }
}

const autocutApi: FreecutHeadlessApi = {
  ready: true,
  renderTimeline,
  renderProject,
  editProject,
  normalizeProject: normalizeProjectForHeadless,
  probeMedia,
  createProject: createProjectForHeadless,
}
window.autocut = autocutApi
window.freecut = autocutApi
log.info('Headless harness ready')
