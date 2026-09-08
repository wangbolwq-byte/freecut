import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TARGETS = {
  'macos-arm64': { os: 'darwin', cpu: 'arm64' },
  'windows-x64': { os: 'win32', cpu: 'x64' },
}

function matchesRuntimePlatform(metadata, platformArch) {
  const target = TARGETS[platformArch]
  if (!target) throw new Error(`Unsupported AutoCut runtime platform: ${platformArch}`)
  return matchesConstraint(metadata.os, target.os) && matchesConstraint(metadata.cpu, target.cpu)
}

function matchesConstraint(values = [], target) {
  const constraints = Array.isArray(values) ? values : [values]
  if (constraints.includes(`!${target}`)) return false
  return matchesAllowedPlatforms(
    constraints.filter((value) => !value.startsWith('!')),
    target,
  )
}

function matchesAllowedPlatforms(allowed, target) {
  return allowed.length === 0 || allowed.includes(target) || allowed.includes('any')
}

export function resolveLockedRuntimePackages(lock, dependencies, platformArch) {
  const packages = new Map()
  const pending = Object.entries(dependencies).map(([name, version]) => ({
    name,
    version,
    parent: '',
    optional: false,
  }))
  while (pending.length > 0) {
    const request = pending.pop()
    const entry = resolveLockedRequest(lock.packages, request, platformArch)
    if (!entry) continue
    if (packages.has(entry.relativeRoot)) continue
    packages.set(entry.relativeRoot, entry)
    pending.push(...packageDependencies(lock.packages, entry))
  }
  return [...packages.values()].sort((left, right) =>
    left.relativeRoot.localeCompare(right.relativeRoot),
  )
}

function resolveLockedRequest(packages, request, platformArch) {
  const relativeRoot = resolveLockedDependency(packages, request.parent, request.name)
  if (!relativeRoot) {
    throw new Error(`Runtime dependency is missing from package-lock.json: ${request.name}`)
  }
  const metadata = packages[relativeRoot]
  if (!matchesRuntimePlatform(metadata, platformArch)) {
    if (request.optional) return undefined
    throw new Error(`Runtime dependency ${request.name} is incompatible with ${platformArch}`)
  }
  requireLockedVersion(request, metadata)
  return { name: request.name, relativeRoot, metadata }
}

function requireLockedVersion(request, metadata) {
  if (request.version && metadata.version !== request.version) {
    throw new Error(
      `Runtime dependency ${request.name} must be ${request.version}, received ${metadata.version}`,
    )
  }
}

function packageDependencies(packages, { relativeRoot, metadata }) {
  const optional = metadata.optionalDependencies ?? {}
  const children = { ...metadata.dependencies, ...optional }
  const requests = Object.keys(children).map((name) => ({
    name,
    parent: relativeRoot,
    optional: name in optional,
  }))
  return [...requests, ...packagePeerDependencies(packages, relativeRoot, metadata, children)]
}

function packagePeerDependencies(packages, parent, metadata, children) {
  return Object.keys(metadata.peerDependencies ?? {})
    .filter((name) => !(name in children))
    .filter((name) => !isMissingOptionalPeer(packages, parent, metadata, name))
    .map((name) => ({ name, parent, optional: false }))
}

function isMissingOptionalPeer(packages, parent, metadata, name) {
  return (
    metadata.peerDependenciesMeta?.[name]?.optional &&
    !resolveLockedDependency(packages, parent, name)
  )
}

function resolveLockedDependency(packages, parent, name) {
  let current = parent
  while (current) {
    const candidate = path.posix.join(current, 'node_modules', name)
    if (packages[candidate]) return candidate
    const next = path.posix.dirname(current)
    current = next === '.' ? '' : next
  }
  return resolveRootDependency(packages, name)
}

function resolveRootDependency(packages, name) {
  const candidate = `node_modules/${name}`
  return packages[candidate] ? candidate : undefined
}

export async function collectRuntimePackages({ repoRoot, dependencies, platformArch }) {
  const lock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'))
  const plan = resolveLockedRuntimePackages(lock, dependencies, platformArch)
  const packages = []
  for (const entry of plan) {
    const root = await resolvePackageRoot(repoRoot, entry, platformArch)
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    if (!matchesLockedPackage(metadata, entry, platformArch)) {
      throw new Error(`Runtime dependency does not match locked target: ${entry.name}`)
    }
    packages.push({
      name: metadata.name,
      version: metadata.version,
      license:
        typeof metadata.license === 'string' ? metadata.license : 'license metadata unavailable',
      root,
      relativeRoot: entry.relativeRoot.slice('node_modules/'.length),
    })
  }
  return packages
}

async function resolvePackageRoot(repoRoot, entry, platformArch) {
  const installedRoot = path.join(repoRoot, entry.relativeRoot)
  const installed = await readFile(path.join(installedRoot, 'package.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => undefined)
  if (installed && matchesLockedPackage(installed, entry, platformArch)) return installedRoot
  return resolveCachedPackage(repoRoot, entry)
}

function matchesLockedPackage(metadata, entry, platformArch) {
  return (
    metadata.name === entry.name &&
    metadata.version === entry.metadata.version &&
    matchesRuntimePlatform(metadata, platformArch)
  )
}

function requireLockedArchive({ resolved, integrity }, name) {
  if (!resolved) throw new Error(`Runtime dependency requires a locked HTTPS tarball: ${name}`)
  if (new URL(resolved).protocol !== 'https:') {
    throw new Error(`Runtime dependency requires a locked HTTPS tarball: ${name}`)
  }
  if (!integrity?.startsWith('sha512-')) {
    throw new Error(`Runtime dependency requires a locked SHA-512: ${name}`)
  }
  return { resolved, integrity }
}

async function resolveCachedPackage(repoRoot, entry) {
  const { resolved, integrity } = requireLockedArchive(entry.metadata, entry.name)
  const cacheRoot = path.join(repoRoot, 'build', '.autocut-package-cache')
  const cacheKey = createHash('sha256').update(integrity).digest('hex')
  const packageRoot = path.join(cacheRoot, cacheKey)
  const marker = path.join(packageRoot, '.autocut-integrity')
  if ((await readFile(marker, 'utf8').catch(() => '')) === integrity) return packageRoot
  await mkdir(cacheRoot, { recursive: true })
  const stagingRoot = await mkdtemp(path.join(cacheRoot, '.download-'))
  try {
    const archive = await downloadLockedArchive(resolved, integrity, entry.name)
    const archivePath = path.join(stagingRoot, 'package.tgz')
    const extractedRoot = path.join(stagingRoot, 'package')
    await writeFile(archivePath, archive)
    await mkdir(extractedRoot)
    await execFileAsync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', extractedRoot])
    await writeFile(path.join(extractedRoot, '.autocut-integrity'), integrity)
    await rm(packageRoot, { recursive: true, force: true })
    await rename(extractedRoot, packageRoot)
    return packageRoot
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function downloadLockedArchive(url, integrity, name) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Runtime dependency ${name} download HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== integrity) {
    throw new Error(`Runtime dependency integrity mismatch: ${name}`)
  }
  return archive
}
