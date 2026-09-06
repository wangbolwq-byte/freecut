import fs from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { chromeLaunchArgs } from './cli.mjs'
import { startHarness } from './render-core.mjs'
import { PageSession } from './page-session.mjs'

const BROKER_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const BROKER_DEFAULT_TIMEOUT_MS = 0

export async function withAutoCutBrowserSession({ workspace, args, env = process.env }, operation) {
  const endpoint = env.AUTOCUT_BROKER_ENDPOINT?.trim()
  return endpoint
    ? await withBrokerSession({ workspace, args, env, endpoint }, operation)
    : await withPlaywrightSession({ workspace, args }, operation)
}

async function withPlaywrightSession({ workspace, args }, operation) {
  const { chromium } = await import('playwright')
  const harness = await startHarness({
    workspace,
    devUrl: args['harness-url'],
    build: args.build,
  })
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !args.head,
    args: chromeLaunchArgs(),
  })
  const session = new PageSession({ browser, harnessUrl: harness.harnessUrl })
  try {
    await session.open()
    return await operation(session.page, harness.mediaUrlOf)
  } finally {
    await session.close().catch(() => {})
    await browser.close().catch(() => {})
    await harness.closeServers().catch(() => {})
  }
}

async function withBrokerSession({ workspace, args, env, endpoint }, operation) {
  const token = requireEnvironmentValue(env, 'AUTOCUT_BROKER_TOKEN')
  const harnessUrl = firstNonempty(
    args['harness-url'],
    env.AUTOCUT_HEADLESS_URL,
    env.AUTOCUT_HARNESS_URL,
  )
  if (!harnessUrl) {
    throw new Error('AUTOCUT_HEADLESS_URL is required when AUTOCUT_BROKER_ENDPOINT is configured')
  }
  const harness = await startHarness({ workspace, devUrl: harnessUrl, build: false })
  const page = new AutoCutBrokerPage({
    endpoint,
    token,
    requestId: env.AUTOCUT_MANAGED_RENDER_TASK_ID?.trim(),
  })
  try {
    return await operation(page, harness.mediaUrlOf)
  } finally {
    await page.close().catch(() => {})
    await harness.closeServers().catch(() => {})
  }
}

export class AutoCutBrokerPage {
  #pendingDownload

  constructor({ endpoint, token, requestId }) {
    this.endpoint = endpoint
    this.token = token
    this.requestId = requestId
  }

  async evaluate(callback, payload) {
    const operation = operationFromCallback(callback)
    const result = await requestBroker({
      endpoint: this.endpoint,
      token: this.token,
      operation,
      payload,
      requestId: this.requestId,
      timeoutMs: operation === 'renderProject' ? BROKER_DEFAULT_TIMEOUT_MS : 120_000,
    })
    return operation === 'renderProject' ? this.#completeRender(result) : result
  }

  waitForEvent(eventName, { timeout = BROKER_DEFAULT_TIMEOUT_MS } = {}) {
    if (eventName !== 'download') {
      return Promise.reject(new Error(`AutoCut broker does not support page event: ${eventName}`))
    }
    if (this.#pendingDownload) {
      return Promise.reject(new Error('AutoCut broker already has a pending download'))
    }
    let timer
    let resolvePromise
    let rejectPromise
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
      if (timeout > 0) {
        timer = setTimeout(() => {
          this.#pendingDownload = undefined
          reject(new Error(`AutoCut broker download timed out after ${timeout}ms`))
        }, timeout)
      }
    })
    this.#pendingDownload = {
      resolve: (download) => {
        if (timer) clearTimeout(timer)
        resolvePromise(download)
      },
      reject: (error) => {
        if (timer) clearTimeout(timer)
        rejectPromise(error)
      },
    }
    return promise
  }

  async close() {
    this.#pendingDownload?.reject(new Error('AutoCut broker page closed'))
    this.#pendingDownload = undefined
  }

  #completeRender(result) {
    const render = parseRenderResult(result)
    this.#pendingDownload?.resolve(new BrokerDownload(render.downloadPath))
    this.#pendingDownload = undefined
    return render.summary
  }
}

class BrokerDownload {
  constructor(downloadPath) {
    this.downloadPath = downloadPath
  }

  async saveAs(outputPath) {
    const resolvedOutput = path.resolve(outputPath)
    const resolvedDownload = path.resolve(this.downloadPath)
    await mkdir(path.dirname(resolvedOutput), { recursive: true })
    try {
      await rename(resolvedDownload, resolvedOutput)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      await copyFile(resolvedDownload, resolvedOutput)
      await rm(resolvedDownload, { force: true })
    }
  }
}

function operationFromCallback(callback) {
  const source = Function.prototype.toString.call(callback)
  for (const operation of [
    'createProject',
    'normalizeProject',
    'editProject',
    'probeMedia',
    'renderProject',
  ]) {
    if (
      source.includes(`window.autocut.${operation}`) ||
      source.includes(`window.freecut.${operation}`)
    ) {
      return operation
    }
  }
  throw new Error('AutoCut broker rejected an unknown page operation')
}

async function requestBroker({ endpoint, token, operation, payload, requestId, timeoutMs }) {
  const socket = net.createConnection(endpoint)
  socket.write(
    `${JSON.stringify({ token, operation, payload, ...(requestId ? { requestId } : {}) })}\n`,
  )
  const frame = await readBrokerFrame(socket, operation, timeoutMs)
  return parseBrokerFrame(frame)
}

function readBrokerFrame(socket, operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    const reader = createInterface({ input: socket })
    let receivedBytes = 0
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      reader.close()
      socket.destroy()
      callback()
    }
    if (timeoutMs > 0) socket.setTimeout(timeoutMs)
    socket.on('data', (chunk) => {
      receivedBytes += Buffer.byteLength(chunk)
      if (receivedBytes > BROKER_MAX_RESPONSE_BYTES) {
        finish(() => reject(new Error('AutoCut broker response exceeded the size limit')))
      }
    })
    reader.once('line', (line) => finish(() => resolve(line)))
    socket.once('timeout', () =>
      finish(() => reject(new Error(`AutoCut broker timed out during ${operation}`))),
    )
    socket.once('error', (error) => finish(() => reject(error)))
    socket.once('end', () =>
      finish(() => reject(new Error('AutoCut broker closed without a response'))),
    )
  })
}

export async function requestAutoCutHost(operation, payload, env = process.env) {
  const endpoint = requireEnvironmentValue(env, 'AUTOCUT_BROKER_ENDPOINT')
  const token = requireEnvironmentValue(env, 'AUTOCUT_BROKER_TOKEN')
  return await requestBroker({ endpoint, token, operation, payload, timeoutMs: 120_000 })
}

function parseBrokerFrame(frame) {
  const response = JSON.parse(frame)
  if (isRecord(response) && response.ok === true) return response.result
  throw brokerResponseError(response)
}

function brokerResponseError(response) {
  const details = isRecord(response) && isRecord(response.error) ? response.error : {}
  const error = new Error(stringOr(details.message, 'AutoCut broker operation failed'))
  error.code = stringOr(details.code, 'AUTOCUT_BROKER_ERROR')
  if (isRecord(details.details)) error.details = details.details
  return error
}

function parseRenderResult(result) {
  if (!result || typeof result !== 'object' || !result.downloadPath) {
    throw new Error('AutoCut broker render response omitted downloadPath')
  }
  return result
}

function requireEnvironmentValue(env, key) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function firstNonempty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim()
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value ? value : fallback
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertAutoCutWorkspace(workspace, env = process.env) {
  const expected = env.AUTOCUT_WORKSPACE?.trim()
  if (!expected) return
  const resolvedWorkspace = fs.realpathSync(workspace)
  const resolvedExpected = fs.realpathSync(expected)
  if (resolvedWorkspace !== resolvedExpected) {
    throw new Error(`AutoCut workspace must be ${resolvedExpected}`)
  }
}
