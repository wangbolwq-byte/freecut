// FreeCut headless render service.
//
// Launches one warm headless Chrome + harness over a workspace and exposes a
// small HTTP API, so renders/edits avoid the per-call browser cold start.
// Requests are serialized (one page op at a time) to avoid GPU/CPU contention.
//
// Usage:
//   node headless/serve.mjs --workspace <dir> [--port 8787] [--build] [--head] [--harness-url <url>]
//
// API:
//   GET  /health                      -> { ok, harnessUrl }
//   GET  /projects                    -> [{ id, name, updatedAt }]
//   POST /render  { project|projectObject, codec?, container?, resolution?, fps?,
//                   quality?, in?, outSec?, duration?, audioOnly? }
//                                      -> the rendered video/audio file (attachment)
//   POST /edit    { project|projectObject, ops, ... }
//                                      -> { ok, project, applied, results } (edited project JSON)
//
// Example:
//   curl -X POST localhost:8787/render -H 'content-type: application/json' \
//     -d '{"project":"<id>","codec":"vp9","duration":5}' -o out.webm
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import {
  buildProjectSnapshot,
  collectAddClipMedia,
  listProjectIdsUsingMedia,
  listProjects,
  loadProject,
  persistEditedProject,
} from './lib/workspace.mjs'
import { parseArgs, chromeLaunchArgs } from './lib/cli.mjs'
import { prepareJob, renderJob, startHarness } from './lib/render-core.mjs'

const CONTAINER_MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 64 * 1024 * 1024) reject(new Error('Request body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e.message}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (!origin) return
  try {
    const url = new URL(origin)
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Headers', 'content-type,last-event-id')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Vary', 'Origin')
    }
  } catch {
    // Invalid Origin is treated as untrusted: no CORS headers.
  }
}

/** Inspect the WebGPU adapter so operators can confirm a real GPU vs software. */
async function probeGpu(page) {
  return page
    .evaluate(async () => {
      if (!globalThis.navigator?.gpu) return { available: false }
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) return { available: false }
      const info = adapter.info ?? {}
      return {
        available: true,
        vendor: info.vendor ?? '',
        architecture: info.architecture ?? '',
        description: info.description ?? '',
      }
    })
    .catch(() => ({ available: false }))
}

/** Heuristic: is this a software (CPU) WebGPU adapter rather than a real GPU? */
function isSoftwareGpu(gpu) {
  if (!gpu?.available) return true
  const s = `${gpu.vendor} ${gpu.architecture} ${gpu.description}`.toLowerCase()
  return /llvmpipe|lavapipe|swiftshader|software|mesa/.test(s)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const workspace = args.workspace
  if (!workspace) throw new Error('Missing --workspace <dir>')
  if (!fs.existsSync(workspace)) throw new Error(`Workspace not found: ${workspace}`)
  const port = args.port ? Number(args.port) : 8787

  const { harnessUrl, mediaUrlOf, closeServers } = await startHarness({
    workspace,
    devUrl: args['harness-url'],
    build: args.build,
  })

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !args.head,
    args: chromeLaunchArgs(),
  })
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error('[pageerror]', e.message))
  await page.exposeBinding('__freecutProgress', () => {})
  await page.goto(harnessUrl, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForFunction(() => Boolean(window.freecut?.ready), { timeout: 30_000 })

  // Report the WebGPU adapter so it's obvious whether this is a real GPU.
  const gpu = await probeGpu(page)
  if (gpu.available) {
    console.log(`WebGPU adapter: ${gpu.vendor || '?'} / ${gpu.architecture || gpu.description || '?'}`)
  }
  if (isSoftwareGpu(gpu)) {
    console.warn(
      'WARNING: WebGPU is software (no real GPU) — GPU effects will fail. ' +
        'Run on a Linux host with an NVIDIA GPU + Container Toolkit (--gpus all ' +
        '-e NVIDIA_DRIVER_CAPABILITIES=all), or render natively on Windows/macOS.',
    )
  }

  // Serialize page operations: one render/edit at a time.
  let queue = Promise.resolve()
  const enqueue = (fn) => {
    const run = queue.then(fn, fn)
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  const tmpDir = path.join(os.tmpdir(), 'freecut-serve')
  fs.mkdirSync(tmpDir, { recursive: true })
  let counter = 0
  let eventCounter = 0
  const eventClients = new Map()
  const lastPublishedRevision = new Map()

  const writeSseEvent = (res, event) => {
    res.write(`id: ${event.eventId}\n`)
    res.write(`event: project.changed\n`)
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const publishProjectChange = (projectId, snapshot, source, changedPaths = []) => {
    if (lastPublishedRevision.get(projectId) === snapshot.revision) return
    lastPublishedRevision.set(projectId, snapshot.revision)
    const event = {
      eventId: `${Date.now()}-${++eventCounter}`,
      type: 'project.changed',
      projectId,
      revision: snapshot.revision,
      source,
      changedPaths,
      timestamp: Date.now(),
    }
    for (const res of eventClients.get(projectId) ?? []) writeSseEvent(res, event)
  }

  const handleRender = async (req, res) => {
    const body = await readJsonBody(req)
    const container = body.container ?? (body.audioOnly ? 'mp3' : undefined)
    const outPath = path.join(tmpDir, `render-${process.pid}-${++counter}.${container ?? 'out'}`)
    const job = prepareJob(workspace, { ...body, out: outPath }, mediaUrlOf)
    // Fix the extension to the (possibly fallback-adjusted) container after settings build.
    const finalOut = path.join(tmpDir, `render-${process.pid}-${counter}.${job.settings.container}`)
    job.outPath = finalOut

    const t0 = Date.now()
    const summary = await enqueue(() => renderJob(page, job))
    console.log(
      `render ${job.project.name ?? job.project.id} -> ${job.settings.container} ` +
        `(${(summary.fileSize / 1e6).toFixed(2)}MB, ${summary.durationSeconds.toFixed(2)}s) in ${Date.now() - t0}ms`,
    )

    res.writeHead(200, {
      'Content-Type': CONTAINER_MIME[job.settings.container] ?? 'application/octet-stream',
      'Content-Length': fs.statSync(finalOut).size,
      'Content-Disposition': `attachment; filename="${path.basename(finalOut)}"`,
      // Header values must be ASCII; sanitize defensively so a warning never
      // turns a successful render into a 500.
      ...(summary.warnings?.length
        ? { 'X-Freecut-Warnings': JSON.stringify(summary.warnings).replace(/[^\t\x20-\x7E]/g, ' ') }
        : {}),
    })
    const stream = fs.createReadStream(finalOut)
    stream.pipe(res)
    stream.on('close', () => fs.rm(finalOut, () => {}))
  }

  const handleEdit = async (req, res) => {
    const body = await readJsonBody(req)
    const project = body.projectObject ?? loadProject(workspace, body.project).project
    const ops = Array.isArray(body.ops) ? body.ops : []
    const media = collectAddClipMedia(workspace, ops)
    const result = await enqueue(() =>
      page.evaluate((payload) => window.freecut.editProject(payload), { project, ops, media }),
    )
    sendJson(res, 200, result)
  }

  const handlePersistedEdit = async (req, res, projectId) => {
    const body = await readJsonBody(req)
    const loaded = loadProject(workspace, projectId)
    const currentSnapshot = buildProjectSnapshot(workspace, projectId)
    if (body.baseRevision && body.baseRevision !== currentSnapshot.revision) {
      sendJson(res, 409, {
        error: 'Project revision conflict',
        projectId,
        revision: currentSnapshot.revision,
      })
      return
    }
    const ops = Array.isArray(body.ops) ? body.ops : []
    const media = collectAddClipMedia(workspace, ops)
    const result = await enqueue(() =>
      page.evaluate((payload) => window.freecut.editProject(payload), {
        project: loaded.project,
        ops,
        media,
      }),
    )
    const project = persistEditedProject(workspace, loaded.projectJsonPath, result.project)
    const snapshot = buildProjectSnapshot(workspace, projectId)
    publishProjectChange(projectId, snapshot, 'headless-api', [
      ['projects', projectId, 'project.json'],
      ['projects', projectId, 'media-links.json'],
    ])
    sendJson(res, 200, {
      ok: true,
      projectId,
      revision: snapshot.revision,
      project,
      applied: result.applied,
      results: result.results,
    })
  }

  const handleSnapshot = async (res, projectId) => {
    sendJson(res, 200, buildProjectSnapshot(workspace, projectId))
  }

  const handleEvents = async (req, res, projectId) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    let clients = eventClients.get(projectId)
    if (!clients) {
      clients = new Set()
      eventClients.set(projectId, clients)
    }
    clients.add(res)

    try {
      const snapshot = buildProjectSnapshot(workspace, projectId)
      writeSseEvent(res, {
        eventId: `${Date.now()}-${++eventCounter}`,
        type: 'project.changed',
        projectId,
        revision: snapshot.revision,
        source: 'initial-snapshot',
        changedPaths: [],
        timestamp: Date.now(),
      })
    } catch (error) {
      res.write(`event: project.error\ndata: ${JSON.stringify({ error: error.message })}\n\n`)
    }

    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000)
    req.on('close', () => {
      clearInterval(heartbeat)
      clients.delete(res)
      if (clients.size === 0) eventClients.delete(projectId)
    })
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const route = `${req.method} ${url.pathname}`
    const persistedEditMatch = /^\/v1\/projects\/([^/]+)\/edit$/u.exec(url.pathname)
    const snapshotMatch = /^\/v1\/projects\/([^/]+)\/snapshot$/u.exec(url.pathname)
    const handler =
      req.method === 'POST' && persistedEditMatch
        ? () => handlePersistedEdit(req, res, decodeURIComponent(persistedEditMatch[1]))
        : req.method === 'GET' && snapshotMatch
          ? () => handleSnapshot(res, decodeURIComponent(snapshotMatch[1]))
          : route === 'GET /v1/events'
            ? () => {
                const projectId = url.searchParams.get('projectId')
                if (!projectId) {
                  sendJson(res, 400, { error: 'Missing projectId' })
                  return
                }
                return handleEvents(req, res, projectId)
              }
            : route === 'GET /health'
        ? async () => {
            const gpu = await probeGpu(page)
            sendJson(res, 200, { ok: true, gpu, software: isSoftwareGpu(gpu), harnessUrl })
          }
        : route === 'GET /projects'
          ? async () => sendJson(res, 200, listProjects(workspace))
          : route === 'POST /render'
            ? () => handleRender(req, res)
            : route === 'POST /edit'
              ? () => handleEdit(req, res)
              : null
    if (!handler) {
      sendJson(res, 404, { error: `No route: ${route}` })
      return
    }
    handler().catch((e) => {
      console.error(`${route} failed:`, e.message ?? e)
      if (!res.headersSent) sendJson(res, 500, { error: e.message ?? String(e) })
      else res.destroy()
    })
  })

  // Bind to loopback only — the render service has no auth, so exposing it
  // on the network would let any LAN peer render/edit projects and read media.
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  console.log(`FreeCut render service on http://localhost:${port}  (workspace: ${workspace})`)
  console.log(
    `  GET /health  GET /projects  POST /render  POST /edit  ` +
      `POST /v1/projects/:id/edit  GET /v1/projects/:id/snapshot  GET /v1/events`,
  )

  const pendingProjectPaths = new Map()
  let watchDebounce = null
  const scheduleProjectChange = (projectId, changedPath) => {
    let paths = pendingProjectPaths.get(projectId)
    if (!paths) {
      paths = new Set()
      pendingProjectPaths.set(projectId, paths)
    }
    paths.add(changedPath)
    clearTimeout(watchDebounce)
    watchDebounce = setTimeout(() => {
      const pending = [...pendingProjectPaths.entries()]
      pendingProjectPaths.clear()
      for (const [id, changed] of pending) {
        try {
          const snapshot = buildProjectSnapshot(workspace, id)
          publishProjectChange(
            id,
            snapshot,
            'external-filesystem',
            [...changed].map((value) => value.split('/').filter(Boolean)),
          )
        } catch {
          // Project may have been removed between the event and the debounce.
        }
      }
    }, 250)
  }

  const handleWorkspaceChange = (fileName) => {
    if (!fileName) return
    const relative = String(fileName).replaceAll('\\', '/')
    if (relative.includes('/cache/')) return
    const parts = relative.split('/').filter(Boolean)
    if (parts[0] === 'projects' && parts[1]) {
      scheduleProjectChange(parts[1], relative)
      return
    }
    if (parts[0] === 'media' && parts[1]) {
      for (const projectId of listProjectIdsUsingMedia(workspace, parts[1])) {
        scheduleProjectChange(projectId, relative)
      }
      return
    }
    if (relative === 'index.json') {
      for (const project of listProjects(workspace)) scheduleProjectChange(project.id, relative)
    }
  }

  let workspaceWatcher = null
  let pollTimer = null
  try {
    workspaceWatcher = fs.watch(
      workspace,
      { recursive: true, persistent: false },
      (_eventType, fileName) => handleWorkspaceChange(fileName),
    )
    workspaceWatcher.on('error', (error) => {
      console.warn(`Workspace watcher failed: ${error.message}`)
    })
  } catch (error) {
    console.warn(`Recursive workspace watcher unavailable; using revision polling: ${error.message}`)
    pollTimer = setInterval(() => {
      for (const project of listProjects(workspace)) scheduleProjectChange(project.id, 'poll')
    }, 750)
  }

  const shutdown = async () => {
    console.log('\nShutting down...')
    clearTimeout(watchDebounce)
    if (pollTimer) clearInterval(pollTimer)
    workspaceWatcher?.close()
    for (const clients of eventClients.values()) {
      for (const client of clients) client.end()
    }
    server.close()
    await browser.close()
    await closeServers()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('\nService failed to start:', e.message ?? e)
  process.exit(1)
})
