// Shared headless render core used by the render CLI (render.mjs) and the
// render service (serve.mjs): settings, range, media resolution, the
// harness/media servers, and the per-page render call.
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadProject,
  collectMediaIds,
  resolveMediaFiles,
  resolveMediaFile,
  readMediaMetadata,
} from './workspace.mjs'
import { createMediaServer } from '../media-server.mjs'
import { createHarnessServer } from '../server.mjs'
import { normalizeRenderInput, renderRequestSchema, validate } from './contract.mjs'
import { HttpError } from './http-security.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CODEC_MAP = {
  h264: 'avc',
  avc: 'avc',
  h265: 'hevc',
  hevc: 'hevc',
  vp9: 'vp9',
  vp8: 'vp8',
  av1: 'av1',
}
const DEFAULT_CONTAINER = { avc: 'mp4', hevc: 'mp4', vp9: 'webm', vp8: 'webm', av1: 'webm' }
const VIDEO_BITRATE_BY_QUALITY = {
  low: 2_500_000,
  medium: 5_000_000,
  high: 10_000_000,
  ultra: 20_000_000,
}

const RENDER_PRESETS = {
  draft: {
    quality: 'medium',
    videoBitrate: 4_000_000,
    maxFps: 30,
    maxWidth: 1280,
    maxHeight: 1280,
    maxEncoderQueue: 3,
  },
  balanced: {
    quality: 'medium',
    videoBitrate: 5_000_000,
    maxFps: 30,
    maxWidth: 1920,
    maxHeight: 1080,
    maxEncoderQueue: 3,
  },
  final: {
    quality: 'high',
    videoBitrate: 10_000_000,
    maxFps: Number.POSITIVE_INFINITY,
    maxWidth: Number.POSITIVE_INFINITY,
    maxHeight: Number.POSITIVE_INFINITY,
    maxEncoderQueue: 2,
  },
}

function even(value) {
  return Math.max(16, Math.round(value / 2) * 2)
}

function fitResolution(width, height, preset) {
  const scale = Math.min(1, preset.maxWidth / width, preset.maxHeight / height)
  return { width: even(width * scale), height: even(height * scale) }
}

/** Build ClientExportSettings from a job's options (same keys as the CLI flags). */
export function buildSettings(project, opts) {
  const meta = project.metadata ?? {}
  const presetName = opts.preset ?? 'final'
  const preset = RENDER_PRESETS[presetName]
  if (!preset) throw new Error(`Unknown render preset "${presetName}"`)
  const projectFps = meta.fps ?? 30
  const fps = opts.fps ? Number(opts.fps) : Math.min(projectFps, preset.maxFps)
  const projectWidth = meta.width ?? 1920
  const projectHeight = meta.height ?? 1080
  let { width, height } = fitResolution(projectWidth, projectHeight, preset)
  if (opts.resolution) {
    const m = /^(\d+)x(\d+)$/.exec(opts.resolution)
    if (!m)
      throw new Error(`Invalid resolution "${opts.resolution}" (expected WxH, e.g. 1920x1080)`)
    width = Number(m[1])
    height = Number(m[2])
  }
  if (!Number.isFinite(fps) || fps < 1 || fps > 240)
    throw new Error('Effective fps must be between 1 and 240')
  if (![width, height].every((value) => Number.isInteger(value) && value >= 16 && value <= 16384)) {
    throw new Error('Effective resolution dimensions must be integers between 16 and 16384')
  }
  const quality = opts.quality ?? preset.quality

  if (opts.audioOnly) {
    const container = opts.container ?? 'mp3'
    return {
      mode: 'audio',
      codec: 'avc',
      audioCodec: container === 'mp3' ? 'mp3' : container === 'wav' ? 'pcm-s16' : 'aac',
      container,
      quality,
      resolution: { width, height },
      fps,
      audioBitrate: 192_000,
      preset: presetName,
    }
  }

  const codecInput = (opts.codec ?? 'h264').toLowerCase()
  const codec = CODEC_MAP[codecInput]
  if (!codec) throw new Error(`Unknown codec "${opts.codec}" (use h264|h265|vp9|vp8|av1)`)
  const container = opts.container ?? DEFAULT_CONTAINER[codec]
  return {
    mode: 'video',
    codec,
    audioCodec: container === 'webm' ? 'opus' : 'aac',
    container,
    quality,
    resolution: { width, height },
    fps,
    videoBitrate: opts.quality
      ? (VIDEO_BITRATE_BY_QUALITY[quality] ?? preset.videoBitrate)
      : preset.videoBitrate,
    audioBitrate: 192_000,
    preset: presetName,
    latencyMode: 'quality',
    hardwareAcceleration: 'prefer-hardware',
    maxEncoderQueue: preset.maxEncoderQueue,
  }
}

/** Compute the render range (frames) from a job's in/out-sec/duration (seconds). */
function computeRange(opts, fps) {
  const inV = opts.inSec
  const outV = opts.outSec
  const hasRange = inV !== undefined || outV !== undefined || opts.duration !== undefined
  if (!hasRange) return { hasRange: false, inPoint: null, outPoint: null }
  const inSec = inV !== undefined ? Number(inV) : 0
  const outSec =
    outV !== undefined
      ? Number(outV)
      : opts.duration !== undefined
        ? inSec + Number(opts.duration)
        : undefined
  return {
    hasRange: true,
    inPoint: Math.round(inSec * fps),
    outPoint: outSec !== undefined ? Math.round(outSec * fps) : null,
  }
}

async function ensureHarnessReachable(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (res.ok) return
  } catch {
    // fall through
  }
  throw new Error(`Dev harness not reachable at ${url}. Start it with: npm run dev`)
}

/**
 * Start the harness + media servers (media resolved dynamically from the
 * workspace). Default: standalone server over built dist/. devUrl: drive a
 * running Vite dev server + cross-origin media server. Omit `workspace` for the
 * edit path (no rendering): no media server is started and `mediaUrlOf` is a
 * no-op.
 */
export async function startHarness({ workspace, devUrl, build }) {
  const resolveMedia = workspace ? (mediaId) => resolveMediaFile(workspace, mediaId) : undefined
  if (devUrl) {
    await ensureHarnessReachable(devUrl)
    if (!resolveMedia)
      return { harnessUrl: devUrl, mediaUrlOf: () => undefined, closeServers: async () => {} }
    const mediaServer = await createMediaServer(resolveMedia)
    return {
      harnessUrl: devUrl,
      mediaUrlOf: (id) => mediaServer.url(id),
      closeServers: () => mediaServer.close(),
    }
  }
  const distDir = path.join(REPO_ROOT, 'dist')
  if (!fs.existsSync(path.join(distDir, 'headless.html'))) {
    if (build) {
      execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' })
    } else {
      throw new Error(
        'Harness not built: dist/headless.html is missing. Run `npm run build` (or pass build:true / --build).',
      )
    }
  }
  const server = await createHarnessServer({ distDir, resolveMedia })
  return {
    harnessUrl: server.harnessUrl,
    mediaUrlOf: (id) => server.mediaUrl(id),
    closeServers: () => server.close(),
  }
}

/** Resolve everything needed to render one job (no browser involved). */
export function prepareJob(workspace, jobArgs, mediaUrlOf) {
  jobArgs = validate(renderRequestSchema, normalizeRenderInput(jobArgs))
  const { project, projectJsonPath } = jobArgs.projectObject
    ? { project: jobArgs.projectObject, projectJsonPath: '(inline)' }
    : loadProject(workspace, jobArgs.project)
  const settings = buildSettings(project, jobArgs)
  const { hasRange, inPoint, outPoint } = computeRange(jobArgs, settings.fps)

  const mediaIds = collectMediaIds(
    project,
    hasRange ? { inFrame: inPoint ?? 0, outFrame: outPoint ?? Number.POSITIVE_INFINITY } : null,
  )
  const { files, missing } = resolveMediaFiles(workspace, mediaIds)
  const media = [...files.entries()].map(([id, filePath]) => {
    const stat = fs.statSync(filePath)
    return {
      mediaId: id,
      url: mediaUrlOf(id),
      fingerprint: `${stat.size}:${stat.mtimeMs}`,
      metadata: readMediaMetadata(workspace, id) ?? undefined,
    }
  })

  const outName = `${(project.name ?? 'freecut-export').replace(/[^\w.-]+/g, '_')}.${settings.container}`
  const outPath = path.resolve(jobArgs.out ?? path.join('headless', 'output', outName))

  return {
    project,
    projectJsonPath,
    settings,
    hasRange,
    inPoint,
    outPoint,
    media,
    mediaSessionId: randomUUID(),
    missing,
    mediaResolved: files.size,
    mediaTotal: mediaIds.length,
    outPath,
  }
}

export class MissingMediaError extends Error {
  constructor(mediaIds) {
    super(`Referenced media source(s) not found on disk: ${mediaIds.join(', ')}`)
    this.name = 'MissingMediaError'
    this.code = 'MISSING_MEDIA'
    this.mediaIds = mediaIds
  }
}

export class AudioDecodeError extends Error {
  constructor(media) {
    super(`Audio cannot be decoded for ${media.length} media source(s)`)
    this.name = 'AudioDecodeError'
    this.code = 'AUDIO_DECODE_FAILED'
    this.media = media
  }
}

class HardwareGpuRequiredError extends HttpError {
  constructor() {
    super(
      422,
      'HARDWARE_GPU_REQUIRED',
      'This project uses GPU effects, but the active WebGPU adapter is software-only. ' +
        'Run on a native Linux host with NVIDIA Vulkan support or render natively.',
    )
    this.name = 'HardwareGpuRequiredError'
  }
}

function projectUsesGpuEffects(project) {
  const timeline = project?.timeline
  if (!timeline) return false
  const timelines = [timeline, ...(timeline.compositions ?? [])]
  return timelines.some((entry) =>
    (entry.items ?? []).some((item) => item.effects?.some((effect) => effect.enabled)),
  )
}

export function assertHardwareGpuForJob(job, softwareGpu) {
  if (softwareGpu && projectUsesGpuEffects(job.project)) {
    throw new HardwareGpuRequiredError()
  }
}

export function outputPathForContainer(requestedPath, container) {
  const extension = path.extname(requestedPath)
  return `${extension ? requestedPath.slice(0, -extension.length) : requestedPath}.${container}`
}

function warningMessage(warning) {
  return typeof warning === 'string' ? warning : warning.message
}

export function warningsHeaderValue(warnings) {
  return JSON.stringify(warnings).replace(/[^\t\x20-\x7E]/g, ' ')
}

/** Render one prepared job through an already-loaded harness page; saves to job.outPath. */
export async function renderJob(
  page,
  job,
  {
    setProgressLabel,
    onWarn,
    allowMissingMedia = false,
    softwareGpu = false,
    downloadTimeoutMs = 30 * 60_000,
  } = {},
) {
  const renderJobStartedAt = performance.now()
  const warn = onWarn ?? ((m) => console.warn(m))
  assertHardwareGpuForJob(job, softwareGpu)
  if (job.missing.length > 0) {
    if (!allowMissingMedia) throw new MissingMediaError(job.missing)
  }
  const preparationWarnings = []
  if (job.missing.length > 0)
    preparationWarnings.push({
      code: 'MISSING_MEDIA',
      message: `${job.missing.length} media source(s) not found on disk: ${job.missing.join(', ')}`,
      details: { mediaIds: job.missing },
    })
  const unsupportedAudio = job.media.filter((m) => m.metadata?.audioCodecSupported === false)
  if (unsupportedAudio.length > 0) {
    throw new AudioDecodeError(
      unsupportedAudio.map((media) => ({
        mediaId: media.mediaId,
        fileName: media.metadata.fileName,
        audioCodec: media.metadata.audioCodec ?? 'unknown',
      })),
    )
  }

  setProgressLabel?.(path.basename(job.outPath))
  const downloadPromise = page.waitForEvent('download', { timeout: downloadTimeoutMs })
  downloadPromise.catch(() => {})
  let summary
  try {
    summary = await page.evaluate((payload) => window.autocut.renderProject(payload), {
      project: job.project,
      settings: job.settings,
      media: job.media,
      mediaSessionId: job.mediaSessionId,
      renderWholeProject: !job.hasRange,
      inPoint: job.inPoint,
      outPoint: job.outPoint,
    })
  } catch (error) {
    throw normalizeHeadlessRenderError(error)
  }
  const download = await downloadPromise
  const effectiveContainer = summary.effectiveSettings?.container
  if (!effectiveContainer) throw new Error('Render summary omitted effectiveSettings.container')
  const outputPath = outputPathForContainer(job.outPath, effectiveContainer)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${randomUUID()}.partial`,
  )
  try {
    await download.saveAs(temporaryPath)
    await fs.promises.rm(outputPath, { force: true })
    await fs.promises.rename(temporaryPath, outputPath)
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
  const downloadCompletedAt = performance.now()
  summary.timings = {
    ...(summary.timings ?? {}),
    downloadMs: Math.max(
      0,
      downloadCompletedAt - renderJobStartedAt - (summary.timings?.totalMs ?? 0),
    ),
    totalMs: downloadCompletedAt - renderJobStartedAt,
  }
  const warnings = [...preparationWarnings, ...(summary.warnings ?? [])]
  for (const warning of warnings)
    warn(`  WARNING [${warning.code ?? 'UNKNOWN'}]: ${warningMessage(warning)}`)
  return { ...summary, fileName: path.basename(outputPath), outputPath, warnings }
}

function normalizeHeadlessRenderError(error) {
  const normalized = error instanceof Error ? error : new Error(String(error))
  const match = /\[([A-Z][A-Z0-9_]+)\]/.exec(normalized.message)
  if (match) normalized.code = match[1]
  return normalized
}
