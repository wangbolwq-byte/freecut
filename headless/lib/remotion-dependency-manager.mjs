import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CACHE_SCHEMA_VERSION = 2
const MAX_DEPENDENCIES = 32
const MAX_NPM_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const RESERVED_RUNTIME_PACKAGES = new Set([
  '@remotion/bundler',
  '@remotion/renderer',
  'react',
  'react-dom',
  'remotion',
])

export const AUTOCUT_RUNTIME_NODE_MODULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'node_modules',
)

export class RemotionDependencyError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'RemotionDependencyError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function parseRemotionDependencyMap(value) {
  if (value === undefined) return Object.freeze({})
  assertDependencyRecord(value)
  const entries = Object.entries(value)
  assertDependencyLimit(entries.length)
  const dependencies = Object.fromEntries(
    entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => parseDependencyEntry(name, version)),
  )
  return Object.freeze(dependencies)
}

function assertDependencyRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return
  throw dependencyError(
    'REMOTION_TASK_CONFIG_INVALID',
    'dependencies must be an object of npm package names to exact versions',
  )
}

function assertDependencyLimit(count) {
  if (count <= MAX_DEPENDENCIES) return
  throw dependencyError(
    'REMOTION_TASK_CONFIG_INVALID',
    `dependencies may contain at most ${MAX_DEPENDENCIES} packages`,
  )
}

function parseDependencyEntry(name, version) {
  assertDependencyName(name)
  if (RESERVED_RUNTIME_PACKAGES.has(name)) {
    throw dependencyError(
      'REMOTION_TASK_CONFIG_INVALID',
      `dependencies may not override the managed ${name} runtime`,
    )
  }
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw dependencyError(
      'REMOTION_TASK_CONFIG_INVALID',
      `dependencies.${name} must be an exact semantic version such as 3.13.0`,
    )
  }
  return [name, version]
}

function assertDependencyName(name) {
  if (isValidPublicPackageName(name)) return
  throw dependencyError(
    'REMOTION_TASK_CONFIG_INVALID',
    `dependencies contains an invalid npm package name: ${name}`,
  )
}

export function externalImportPackageName(specifier) {
  if (typeof specifier !== 'string') return undefined
  if (specifier === '') return undefined
  if (specifier.startsWith('@')) return scopedImportPackageName(specifier)
  return specifier.split('/').at(0)
}

function scopedImportPackageName(specifier) {
  const [scope, name] = specifier.split('/')
  if (!scope || !name) return undefined
  return `${scope}/${name}`
}

export function isValidPublicPackageName(name) {
  if (typeof name !== 'string') return false
  return hasValidPublicPackageSyntax(name) && hasValidPublicPackagePrefix(name)
}

function hasValidPublicPackageSyntax(name) {
  return name.length <= 214 && PACKAGE_NAME.test(name)
}

function hasValidPublicPackagePrefix(name) {
  return !name.startsWith('.') && !name.startsWith('_')
}

export async function prepareRemotionTaskDependencies(input) {
  const requested = requestedDependencies(input)
  if (requested.length === 0) {
    return dependencyResolution({
      requested,
      resolved: [],
      nodeModulesPaths: [definedOr(input.runtimeNodeModules, AUTOCUT_RUNTIME_NODE_MODULES)],
      cacheReused: true,
    })
  }

  const runtimeNodeModules = definedOr(input.runtimeNodeModules, AUTOCUT_RUNTIME_NODE_MODULES)
  const { resolved, installRequests } = await resolveRuntimeDependencies(
    runtimeNodeModules,
    requested,
  )
  if (Object.keys(installRequests).length === 0) {
    return dependencyResolution({
      requested,
      resolved,
      nodeModulesPaths: [runtimeNodeModules],
      cacheReused: true,
    })
  }

  return dependencyResolutionFromCache({
    requested,
    resolved,
    runtimeNodeModules,
    installRequests,
    ...(await prepareDependencyCache(input, installRequests)),
  })
}

async function dependencyResolutionFromCache(input) {
  if (!input.cachedResolution) {
    throw dependencyError(
      'REMOTION_DEPENDENCY_INSTALL_INVALID',
      'The npm dependency cache did not contain every inferred package import',
      { packages: Object.keys(input.installRequests) },
    )
  }
  input.resolved.push(
    ...Object.entries(input.cachedResolution).map(([name, version]) => ({
      name,
      version,
      source: 'task-cache',
    })),
  )
  input.resolved.sort((left, right) => left.name.localeCompare(right.name))
  const lockBytes = await readFile(path.join(input.installationRoot, 'package-lock.json'))
  return dependencyResolution({
    requested: input.requested,
    resolved: input.resolved,
    nodeModulesPaths: [path.join(input.installationRoot, 'node_modules'), input.runtimeNodeModules],
    cacheReused: input.cacheReused,
    lockHash: `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`,
  })
}

function requestedDependencies(input) {
  const pinnedDependencies = input.dependencies ?? {}
  const packageNames = new Set([...(input.packageNames ?? []), ...Object.keys(pinnedDependencies)])
  if (packageNames.size > MAX_DEPENDENCIES) {
    throw dependencyError(
      'REMOTION_DEPENDENCY_LIMIT_EXCEEDED',
      `Remotion source may import at most ${MAX_DEPENDENCIES} npm packages`,
    )
  }
  return [...packageNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => requestedDependency(name, pinnedDependencies[name] ?? null))
}

function requestedDependency(name, pinnedVersion) {
  if (isValidPublicPackageName(name) && !RESERVED_RUNTIME_PACKAGES.has(name)) {
    return [name, pinnedVersion]
  }
  throw dependencyError(
    'REMOTION_DEPENDENCY_INVALID',
    `Remotion source imports an unsupported npm package name: ${name}`,
  )
}

async function resolveRuntimeDependencies(runtimeNodeModules, requested) {
  const resolved = []
  const installRequests = {}
  for (const [name, pinnedVersion] of requested) {
    const runtimeVersion = await readInstalledPackageVersion(runtimeNodeModules, name)
    if (runtimeVersionMatchesPin(runtimeVersion, pinnedVersion)) {
      resolved.push({ name, version: runtimeVersion, source: 'runtime' })
      continue
    }
    installRequests[name] = pinnedVersion
  }
  return { resolved, installRequests }
}

function runtimeVersionMatchesPin(runtimeVersion, pinnedVersion) {
  if (!runtimeVersion) return false
  return pinnedVersion === null || runtimeVersion === pinnedVersion
}

async function prepareDependencyCache(input, installRequests) {
  const cacheRoot = path.join(input.taskDirectory, '.autocut-dependencies')
  const installationRoot = path.join(cacheRoot, dependencyCacheKey(installRequests))
  let cachedResolution = await readValidInstallation(installationRoot, installRequests)
  const cacheReused = cachedResolution !== undefined
  if (!cacheReused) {
    await installDependencySet({ ...input, cacheRoot, installationRoot, requests: installRequests })
    cachedResolution = await readValidInstallation(installationRoot, installRequests)
  }
  return { installationRoot, cacheReused, cachedResolution }
}

function dependencyCacheKey(requests) {
  return createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: CACHE_SCHEMA_VERSION,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        requests,
      }),
    )
    .digest('hex')
}

async function installDependencySet(input) {
  await mkdir(input.cacheRoot, { recursive: true })
  const stagingRoot = `${input.installationRoot}.staging-${process.pid}-${randomUUID()}`
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  try {
    await writeFile(
      path.join(stagingRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: '@easyai/autocut-remotion-task-dependencies',
          version: '0.0.0',
          private: true,
          dependencies: {},
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const npmConfigPath = path.join(stagingRoot, '.npmrc')
    await writeFile(
      npmConfigPath,
      [
        'registry=https://registry.npmjs.org/',
        'replace-registry-host=always',
        'ignore-scripts=true',
        'audit=false',
        'fund=false',
        'package-lock=true',
        'legacy-peer-deps=true',
        'update-notifier=false',
        '',
      ].join('\n'),
      'utf8',
    )
    const nodeExecutable = path.resolve(input.nodeExecutable ?? process.execPath)
    const runNpm = await resolveNpmRunner(input, nodeExecutable)
    try {
      await runNpm({
        args: [
          'install',
          '--omit=dev',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=true',
          '--legacy-peer-deps',
          '--registry=https://registry.npmjs.org/',
          '--replace-registry-host=always',
          '--cache',
          path.join(input.cacheRoot, '.npm-cache'),
          '--userconfig',
          npmConfigPath,
          '--save-exact',
          ...Object.entries(input.requests).map(([name, version]) =>
            version === null ? name : `${name}@${version}`,
          ),
        ],
        cwd: stagingRoot,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          NPM_CONFIG_USERCONFIG: npmConfigPath,
          npm_config_update_notifier: 'false',
        },
      })
    } catch (error) {
      throw dependencyError(
        'REMOTION_DEPENDENCY_INSTALL_FAILED',
        `Unable to install npm packages inferred from Remotion imports: ${safeNpmError(error)}`,
        {
          packages: Object.keys(input.requests),
          installScripts: false,
          registry: 'https://registry.npmjs.org/',
        },
      )
    }
    const resolved = await readInstalledDependencyVersions(stagingRoot, input.requests)
    if (!resolved) {
      throw dependencyError(
        'REMOTION_DEPENDENCY_INSTALL_INVALID',
        'npm completed without locking every inferred package import to an exact version',
        { packages: Object.keys(input.requests) },
      )
    }
    await writeFile(
      path.join(stagingRoot, '.autocut-dependencies.json'),
      `${JSON.stringify(
        {
          schemaVersion: CACHE_SCHEMA_VERSION,
          requests: input.requests,
          resolved,
          installScripts: false,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await rm(input.installationRoot, { recursive: true, force: true })
    await rename(stagingRoot, input.installationRoot)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function resolveNpmRunner(input, nodeExecutable) {
  if (input.runNpm) return input.runNpm
  const npmCliPath = await resolveNpmCliPath(nodeExecutable, input.npmCliPath)
  return async ({ args, cwd, env }) => {
    await execFileAsync(nodeExecutable, [npmCliPath, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: input.installTimeoutInMilliseconds ?? DEFAULT_INSTALL_TIMEOUT_MS,
      maxBuffer: MAX_NPM_OUTPUT_BYTES,
    })
  }
}

async function resolveNpmCliPath(nodeExecutable, explicit) {
  const candidates = [
    explicit,
    path.resolve(
      path.dirname(nodeExecutable),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    path.resolve(path.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (
      await access(candidate)
        .then(() => true)
        .catch(() => false)
    ) {
      return candidate
    }
  }
  throw dependencyError(
    'REMOTION_DEPENDENCY_INSTALL_UNAVAILABLE',
    'The managed Node runtime does not include npm; update the EasyWork Host Runtime resource',
  )
}

async function readValidInstallation(root, requests) {
  if (!(await hasDependencyInstallationFiles(root))) return undefined
  const marker = await readJson(path.join(root, '.autocut-dependencies.json'))
  if (!(await isReusableDependencyMarker(root, marker, requests))) return undefined
  return marker.resolved
}

async function hasDependencyInstallationFiles(root) {
  const nodeModulesExists = await isDirectory(path.join(root, 'node_modules'))
  if (!nodeModulesExists) return false
  return isFile(path.join(root, 'package-lock.json'))
}

async function isReusableDependencyMarker(root, marker, requests) {
  if (!isValidDependencyMarker(marker, requests)) return false
  if (!sameDependencyNames(marker.resolved, requests)) return false
  return installedVersionsMatch(root, marker.resolved)
}

async function installedVersionsMatch(root, resolved) {
  const checks = await Promise.all(
    Object.entries(resolved).map(([name, version]) => installedVersionMatches(root, name, version)),
  )
  return checks.every(Boolean)
}

function isValidDependencyMarker(marker, requests) {
  if (marker?.schemaVersion !== CACHE_SCHEMA_VERSION) return false
  if (canonicalJson(marker.requests) !== canonicalJson(requests)) return false
  return isPlainObject(marker.resolved)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function installedVersionMatches(root, name, version) {
  if (!EXACT_VERSION.test(version)) return false
  const installed = await readInstalledPackageVersion(path.join(root, 'node_modules'), name)
  return installed === version
}

function sameDependencyNames(left, right) {
  return Object.keys(left).sort().join('\0') === Object.keys(right).sort().join('\0')
}

async function readInstalledDependencyVersions(root, requests) {
  const packageDependencies = await readPackageDependencies(root)
  if (!packageDependencies) return undefined
  return readRequestedDependencyVersions(root, requests, packageDependencies)
}

async function readPackageDependencies(root) {
  if (!(await isFile(path.join(root, 'package-lock.json')))) return undefined
  const packageJson = await readJson(path.join(root, 'package.json'))
  return isPlainObject(packageJson?.dependencies) ? packageJson.dependencies : undefined
}

async function readRequestedDependencyVersions(root, requests, packageDependencies) {
  const resolved = {}
  for (const [name, pinnedVersion] of Object.entries(requests)) {
    const declaredVersion = packageDependencies[name]
    const installedVersion = await readInstalledPackageVersion(
      path.join(root, 'node_modules'),
      name,
    )
    if (!installedDependencyMatches(declaredVersion, installedVersion, pinnedVersion))
      return undefined
    resolved[name] = installedVersion
  }
  return resolved
}

function installedDependencyMatches(declaredVersion, installedVersion, pinnedVersion) {
  if (typeof declaredVersion !== 'string') return false
  if (!EXACT_VERSION.test(declaredVersion)) return false
  if (installedVersion !== declaredVersion) return false
  return pinnedVersionMatches(installedVersion, pinnedVersion)
}

function pinnedVersionMatches(installedVersion, pinnedVersion) {
  if (pinnedVersion === null) return true
  return installedVersion === pinnedVersion
}

async function readInstalledPackageVersion(nodeModulesRoot, name) {
  const packageJson = await readFile(
    path.join(nodeModulesRoot, name, 'package.json'),
    'utf8',
  ).catch(() => undefined)
  if (!packageJson) return undefined
  try {
    const value = JSON.parse(packageJson)
    return typeof value.version === 'string' ? value.version : undefined
  } catch {
    return undefined
  }
}

function dependencyResolution({ requested, resolved, nodeModulesPaths, cacheReused, lockHash }) {
  const requestedDependencies = Object.fromEntries(
    requested.map(([name, version]) => [name, version ?? 'auto']),
  )
  const evidence = {
    requested: requestedDependencies,
    resolved,
    installScripts: false,
    networkAtRender: false,
    cacheReused,
    ...(lockHash ? { lockHash } : {}),
  }
  return {
    nodeModulesPaths,
    evidence,
    dependencyHash: `sha256:${createHash('sha256').update(canonicalJson(evidence)).digest('hex')}`,
  }
}

function safeNpmError(error) {
  return npmErrorOutput(error)
    .replaceAll(/\/\/[^/\s:@]+:[^@\s/]+@/gu, '//***@')
    .replaceAll(/((?:token|password|authorization)=)\S+/giu, '$1***')
    .trim()
    .slice(-2_000)
}

function npmErrorOutput(error) {
  const stderr = nonEmptyString(Reflect.get(Object(error), 'stderr'))
  if (stderr !== undefined) return stderr
  const stdout = nonEmptyString(Reflect.get(Object(error), 'stdout'))
  if (stdout !== undefined) return stdout
  return error instanceof Error ? error.message : String(error)
}

function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined
  return value.trim() ? value : undefined
}

function definedOr(value, fallback) {
  return value === undefined ? fallback : value
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function dependencyError(code, message, details = undefined) {
  return new RemotionDependencyError(code, message, details)
}

async function isFile(filePath) {
  return (await stat(filePath).catch(() => null))?.isFile() === true
}

async function isDirectory(filePath) {
  return (await stat(filePath).catch(() => null))?.isDirectory() === true
}

async function readJson(filePath) {
  const source = await readFile(filePath, 'utf8').catch(() => undefined)
  if (!source) return undefined
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}
