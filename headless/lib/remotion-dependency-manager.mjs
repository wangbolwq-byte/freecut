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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw dependencyError(
      'REMOTION_TASK_CONFIG_INVALID',
      'dependencies must be an object of npm package names to exact versions',
    )
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_DEPENDENCIES) {
    throw dependencyError(
      'REMOTION_TASK_CONFIG_INVALID',
      `dependencies may contain at most ${MAX_DEPENDENCIES} packages`,
    )
  }
  const dependencies = {}
  for (const [name, version] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (
      name.length > 214 ||
      !PACKAGE_NAME.test(name) ||
      name.startsWith('.') ||
      name.startsWith('_')
    ) {
      throw dependencyError(
        'REMOTION_TASK_CONFIG_INVALID',
        `dependencies contains an invalid npm package name: ${name}`,
      )
    }
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
    dependencies[name] = version
  }
  return Object.freeze(dependencies)
}

export function externalImportPackageName(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return undefined
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return scope && name ? `${scope}/${name}` : undefined
  }
  return specifier.split('/')[0] || undefined
}

export function isValidPublicPackageName(name) {
  return (
    typeof name === 'string' &&
    name.length <= 214 &&
    PACKAGE_NAME.test(name) &&
    !name.startsWith('.') &&
    !name.startsWith('_')
  )
}

export async function prepareRemotionTaskDependencies(input) {
  const pinnedDependencies = input.dependencies ?? {}
  const packageNames = new Set([...(input.packageNames ?? []), ...Object.keys(pinnedDependencies)])
  if (packageNames.size > MAX_DEPENDENCIES) {
    throw dependencyError(
      'REMOTION_DEPENDENCY_LIMIT_EXCEEDED',
      `Remotion source may import at most ${MAX_DEPENDENCIES} npm packages`,
    )
  }
  const requested = [...packageNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      if (!isValidPublicPackageName(name) || RESERVED_RUNTIME_PACKAGES.has(name)) {
        throw dependencyError(
          'REMOTION_DEPENDENCY_INVALID',
          `Remotion source imports an unsupported npm package name: ${name}`,
        )
      }
      return [name, pinnedDependencies[name] ?? null]
    })
  if (requested.length === 0) {
    return dependencyResolution({
      requested,
      resolved: [],
      nodeModulesPaths: [input.runtimeNodeModules ?? AUTOCUT_RUNTIME_NODE_MODULES],
      cacheReused: true,
    })
  }

  const runtimeNodeModules = input.runtimeNodeModules ?? AUTOCUT_RUNTIME_NODE_MODULES
  const resolved = []
  const installRequests = {}
  for (const [name, pinnedVersion] of requested) {
    const runtimeVersion = await readInstalledPackageVersion(runtimeNodeModules, name)
    if (runtimeVersion && (pinnedVersion === null || runtimeVersion === pinnedVersion)) {
      resolved.push({ name, version: runtimeVersion, source: 'runtime' })
    } else {
      installRequests[name] = pinnedVersion
    }
  }
  if (Object.keys(installRequests).length === 0) {
    return dependencyResolution({
      requested,
      resolved,
      nodeModulesPaths: [runtimeNodeModules],
      cacheReused: true,
    })
  }

  const cacheRoot = path.join(input.taskDirectory, '.autocut-dependencies')
  const cacheKey = createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: CACHE_SCHEMA_VERSION,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        requests: installRequests,
      }),
    )
    .digest('hex')
  const installationRoot = path.join(cacheRoot, cacheKey)
  let cachedResolution = await readValidInstallation(installationRoot, installRequests)
  const cacheReused = cachedResolution !== undefined
  if (!cacheReused) {
    await installDependencySet({
      ...input,
      cacheRoot,
      installationRoot,
      requests: installRequests,
    })
    cachedResolution = await readValidInstallation(installationRoot, installRequests)
  }
  if (!cachedResolution) {
    throw dependencyError(
      'REMOTION_DEPENDENCY_INSTALL_INVALID',
      'The npm dependency cache did not contain every inferred package import',
      { packages: Object.keys(installRequests) },
    )
  }

  for (const [name, version] of Object.entries(cachedResolution)) {
    resolved.push({ name, version, source: 'task-cache' })
  }
  resolved.sort((left, right) => left.name.localeCompare(right.name))
  const lockBytes = await readFile(path.join(installationRoot, 'package-lock.json'))
  return dependencyResolution({
    requested,
    resolved,
    nodeModulesPaths: [path.join(installationRoot, 'node_modules'), runtimeNodeModules],
    cacheReused,
    lockHash: `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`,
  })
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
    const npmCliPath = await resolveNpmCliPath(nodeExecutable, input.npmCliPath)
    const runNpm =
      input.runNpm ??
      (async ({ args, cwd, env }) => {
        await execFileAsync(nodeExecutable, [npmCliPath, ...args], {
          cwd,
          env,
          encoding: 'utf8',
          timeout: input.installTimeoutInMilliseconds ?? DEFAULT_INSTALL_TIMEOUT_MS,
          maxBuffer: MAX_NPM_OUTPUT_BYTES,
        })
      })
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
  if (!(await isDirectory(path.join(root, 'node_modules')))) return undefined
  if (!(await isFile(path.join(root, 'package-lock.json')))) return undefined
  const marker = await readJson(path.join(root, '.autocut-dependencies.json'))
  if (
    marker?.schemaVersion !== CACHE_SCHEMA_VERSION ||
    canonicalJson(marker.requests) !== canonicalJson(requests) ||
    !marker.resolved ||
    typeof marker.resolved !== 'object' ||
    Array.isArray(marker.resolved)
  ) {
    return undefined
  }
  for (const [name, version] of Object.entries(marker.resolved)) {
    if (!EXACT_VERSION.test(version)) return undefined
    if ((await readInstalledPackageVersion(path.join(root, 'node_modules'), name)) !== version) {
      return undefined
    }
  }
  if (Object.keys(marker.resolved).sort().join('\0') !== Object.keys(requests).sort().join('\0')) {
    return undefined
  }
  return marker.resolved
}

async function readInstalledDependencyVersions(root, requests) {
  if (!(await isFile(path.join(root, 'package-lock.json')))) return undefined
  const packageJson = await readJson(path.join(root, 'package.json'))
  if (!packageJson?.dependencies || typeof packageJson.dependencies !== 'object') {
    return undefined
  }
  const resolved = {}
  for (const [name, pinnedVersion] of Object.entries(requests)) {
    const declaredVersion = packageJson.dependencies[name]
    const installedVersion = await readInstalledPackageVersion(
      path.join(root, 'node_modules'),
      name,
    )
    if (
      typeof declaredVersion !== 'string' ||
      !EXACT_VERSION.test(declaredVersion) ||
      installedVersion !== declaredVersion ||
      (pinnedVersion !== null && installedVersion !== pinnedVersion)
    ) {
      return undefined
    }
    resolved[name] = installedVersion
  }
  return resolved
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
  const output =
    typeof error?.stderr === 'string' && error.stderr.trim()
      ? error.stderr
      : typeof error?.stdout === 'string' && error.stdout.trim()
        ? error.stdout
        : error instanceof Error
          ? error.message
          : String(error)
  return output
    .replaceAll(/\/\/[^/\s:@]+:[^@\s/]+@/gu, '//***@')
    .replaceAll(/((?:token|password|authorization)=)\S+/giu, '$1***')
    .trim()
    .slice(-2_000)
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
