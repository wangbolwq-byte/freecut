#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from './lib/cli.mjs'
import { createHarnessServer } from './server.mjs'

const DEFAULT_PORT = 18787
const OPTIONS = new Set(['port', 'dist', 'runtime-manifest', 'help'])
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function createAutoCutServer({
  port = DEFAULT_PORT,
  distDir = path.join(RUNTIME_ROOT, 'dist'),
  manifest = readRuntimeManifest(path.join(RUNTIME_ROOT, 'runtime-manifest.json')),
} = {}) {
  const normalizedPort = parsePort(port, { allowEphemeral: true })
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`AutoCut editor build is missing: ${path.join(distDir, 'index.html')}`)
  }
  if (!fs.existsSync(path.join(distDir, 'headless.html'))) {
    throw new Error(`AutoCut headless build is missing: ${path.join(distDir, 'headless.html')}`)
  }
  const health = {
    ok: true,
    name: 'autocut',
    status: 'ready',
    version: manifest.version,
    upstream: manifest.upstream,
  }
  return await createHarnessServer({
    distDir,
    port: normalizedPort,
    rootDocument: 'index.html',
    health,
  })
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { allowed: OPTIONS })
  if (args.help) {
    console.log(
      'Usage: autocut-server [--port 18787] [--dist <directory>] [--runtime-manifest <file>]',
    )
    return
  }
  const server = await createAutoCutServer(serverOptions(args))
  console.log(
    JSON.stringify({
      event: 'ready',
      name: 'autocut',
      port: server.port,
      baseUrl: server.base,
      harnessUrl: server.harnessUrl,
    }),
  )
  installShutdownHandlers(server)
}

function serverOptions(args) {
  const manifestPath = path.resolve(
    firstValue(args['runtime-manifest'], path.join(RUNTIME_ROOT, 'runtime-manifest.json')),
  )
  return {
    port: parsePort(firstValue(args.port, process.env.AUTOCUT_PORT, DEFAULT_PORT)),
    distDir: path.resolve(firstValue(args.dist, path.join(RUNTIME_ROOT, 'dist'))),
    manifest: readRuntimeManifest(manifestPath),
  }
}

function installShutdownHandlers(server) {
  const close = async () => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
}

function readRuntimeManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return developmentManifest()
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assertRuntimeManifest(manifest, manifestPath)
  return manifest
}

function developmentManifest() {
  return {
    schemaVersion: 1,
    name: 'autocut',
    version: '0.0.0-dev',
    upstream: { repository: 'freecut', branch: 'dev', commit: 'unknown' },
  }
}

function assertRuntimeManifest(manifest, manifestPath) {
  if (!runtimeManifestIsValid(manifest)) {
    throw new Error(`Invalid AutoCut runtime manifest: ${manifestPath}`)
  }
}

function runtimeManifestIsValid(manifest) {
  if (!isRecord(manifest)) return false
  return [
    manifest.schemaVersion === 1,
    manifest.name === 'autocut',
    typeof manifest.version === 'string',
    upstreamCommitIsValid(manifest.upstream),
  ].every(Boolean)
}

function upstreamCommitIsValid(upstream) {
  if (!isRecord(upstream)) return false
  return typeof upstream.commit === 'string'
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePort(value, { allowEphemeral = false } = {}) {
  const port = Number(value)
  const minimum = allowEphemeral ? 0 : 1024
  const invalid = [!Number.isInteger(port), port < minimum, port > 65535].includes(true)
  if (invalid) {
    throw new Error(`AutoCut port must be an integer between ${minimum} and 65535`)
  }
  return port
}

function firstValue(...values) {
  return values.find(isPresent)
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== ''
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

function isMainModule() {
  if (!process.argv[1]) return false
  const entryPath = fs.realpathSync(path.resolve(process.argv[1]))
  return fileURLToPath(import.meta.url) === entryPath
}
