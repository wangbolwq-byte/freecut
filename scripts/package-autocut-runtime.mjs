import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOP_LEVEL_HEADLESS_FILES = [
  'agent.mjs',
  'autocut-agent.mjs',
  'autocut-server.mjs',
  'media-server.mjs',
  'server.mjs',
]
const RUNTIME_DEPENDENCIES = {
  '@babel/parser': '7.29.7',
  '@remotion/bundler': '4.0.499',
  '@remotion/renderer': '4.0.499',
  playwright: '1.60.0',
  'playwright-core': '1.60.0',
  pngjs: '7.0.0',
  react: '19.2.5',
  'react-dom': '19.2.5',
  remotion: '4.0.499',
  zod: '4.3.6',
}
const OPTION_KEYS = new Map([
  ['--output', 'output'],
  ['--platform-arch', 'platformArch'],
  ['--version', 'version'],
  ['--commit', 'commit'],
])

async function main(argv = process.argv.slice(2)) {
  const config = resolvePackageConfig(parseOptions(argv))

  await assertDirectory(path.join(REPO_ROOT, 'dist'))
  const runtimePackages = await collectRuntimePackages()
  await stageRuntime(config.outputRoot, runtimePackages)

  const runtimeManifest = {
    schemaVersion: 1,
    name: 'autocut',
    version: config.version,
    platformArch: config.platformArch,
    upstream: {
      repository: 'https://github.com/wangbolwq-byte/freecut',
      branch: 'dev',
      commit: config.commit,
    },
    entrypoints: {
      server: 'headless/autocut-server.mjs',
      agent: 'headless/autocut-agent.mjs',
      editor: 'dist/index.html',
      headless: 'dist/headless.html',
      remotionRenderer: 'headless/lib/remotion-renderer.mjs',
    },
  }
  await writeJson(path.join(config.outputRoot, 'runtime-manifest.json'), runtimeManifest)
  await writeJson(path.join(config.outputRoot, 'package.json'), {
    name: '@easyai/autocut-runtime',
    version: config.version,
    private: true,
    type: 'module',
    dependencies: RUNTIME_DEPENDENCIES,
  })
  await writeLaunchers(config.outputRoot)
  await writeFile(
    path.join(config.outputRoot, 'THIRD_PARTY_NOTICES.md'),
    [
      '# AutoCut runtime notices',
      '',
      `This runtime was built from FreeCut dev commit ${config.commit}.`,
      'Runtime dependency license texts are included below the licenses directory.',
      '',
      ...runtimePackages.map(
        (runtimePackage) => `- ${runtimePackage.name}@${runtimePackage.version}`,
      ),
      '',
    ].join('\n'),
    'utf8',
  )
  console.log(JSON.stringify({ outputRoot: config.outputRoot, runtimeManifest }, null, 2))
}

function resolvePackageConfig(options) {
  const platformArch = resolveOption(options.platformArch, currentPlatformArch)
  return {
    platformArch,
    outputRoot: path.resolve(
      resolveOption(options.output, () =>
        path.join(REPO_ROOT, 'build', 'autocut-runtime', platformArch),
      ),
    ),
    version: resolveOption(options.version, () => process.env.AUTOCUT_VERSION?.trim() || '0.1.5'),
    commit: resolveOption(options.commit, readCurrentCommit),
  }
}

async function stageRuntime(outputRoot, runtimePackages) {
  await rm(outputRoot, { recursive: true, force: true })
  await Promise.all([
    mkdir(path.join(outputRoot, 'headless'), { recursive: true }),
    mkdir(path.join(outputRoot, 'node_modules'), { recursive: true }),
    mkdir(path.join(outputRoot, 'bin'), { recursive: true }),
    mkdir(path.join(outputRoot, 'licenses'), { recursive: true }),
  ])
  await cp(path.join(REPO_ROOT, 'dist'), path.join(outputRoot, 'dist'), {
    recursive: true,
    filter: (source) => !source.endsWith('.map') && path.basename(source) !== '.gitkeep',
  })
  await cp(path.join(REPO_ROOT, 'headless', 'lib'), path.join(outputRoot, 'headless', 'lib'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.mjs'),
  })
  await Promise.all(
    TOP_LEVEL_HEADLESS_FILES.map((fileName) => copyHeadlessFile(outputRoot, fileName)),
  )
  for (const runtimePackage of runtimePackages) {
    await cp(
      runtimePackage.root,
      path.join(outputRoot, 'node_modules', runtimePackage.relativeRoot),
      {
        recursive: true,
        filter: (source) => path.basename(source) !== 'node_modules',
      },
    )
  }
  await cp(
    path.join(REPO_ROOT, 'LICENSE'),
    path.join(outputRoot, 'licenses', 'LICENSE.freecut.txt'),
  )
  await copyRuntimeLicenses(outputRoot, runtimePackages)
}

async function collectRuntimePackages() {
  const nodeModulesRoot = path.join(REPO_ROOT, 'node_modules')
  const packages = new Map()
  const pending = Object.entries(RUNTIME_DEPENDENCIES).map(([name, version]) => ({
    name,
    expectedVersion: version,
    root: path.join(nodeModulesRoot, name),
  }))
  while (pending.length > 0) {
    const current = pending.pop()
    const packageJsonPath = path.join(current.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    if (current.expectedVersion && packageJson.version !== current.expectedVersion) {
      throw new Error(
        `Runtime dependency ${current.name} must be ${current.expectedVersion}, received ${packageJson.version}`,
      )
    }
    const relativeRoot = path.relative(nodeModulesRoot, current.root)
    if (relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) {
      throw new Error(`Runtime dependency escapes node_modules: ${current.name}`)
    }
    if (packages.has(relativeRoot)) continue
    packages.set(relativeRoot, {
      name: packageJson.name ?? current.name,
      version: packageJson.version,
      root: current.root,
      relativeRoot,
    })
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
    }
    for (const dependencyName of Object.keys(dependencies)) {
      const dependencyRoot = await resolveInstalledDependency(current.root, dependencyName)
      if (dependencyRoot) pending.push({ name: dependencyName, root: dependencyRoot })
    }
  }
  return [...packages.values()].sort((left, right) =>
    left.relativeRoot.localeCompare(right.relativeRoot),
  )
}

async function resolveInstalledDependency(packageRoot, dependencyName) {
  const nodeModulesRoot = path.join(REPO_ROOT, 'node_modules')
  let current = packageRoot
  while (current.startsWith(nodeModulesRoot)) {
    const candidate = path.join(current, 'node_modules', dependencyName)
    if (await isDirectory(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const rootCandidate = path.join(nodeModulesRoot, dependencyName)
  return (await isDirectory(rootCandidate)) ? rootCandidate : undefined
}

async function copyRuntimeLicenses(outputRoot, runtimePackages) {
  for (const runtimePackage of runtimePackages) {
    const entries = await readdir(runtimePackage.root, { withFileTypes: true })
    const licenseFiles = entries
      .filter(
        (entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\..+)?$/iu.test(entry.name),
      )
      .map((entry) => entry.name)
    for (const licenseFile of licenseFiles) {
      const safePackageName = runtimePackage.relativeRoot.replaceAll(/[\\/]/gu, '__')
      await cp(
        path.join(runtimePackage.root, licenseFile),
        path.join(outputRoot, 'licenses', `${safePackageName}__${licenseFile}`),
      )
    }
  }
}

function copyHeadlessFile(outputRoot, fileName) {
  return cp(path.join(REPO_ROOT, 'headless', fileName), path.join(outputRoot, 'headless', fileName))
}

function resolveOption(value, fallback) {
  return value === undefined ? fallback() : value
}

function readCurrentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
}

async function writeLaunchers(outputRoot) {
  const launchers = {
    'autocut-agent': 'autocut-agent.mjs',
    'autocut-server': 'autocut-server.mjs',
  }
  for (const [name, entry] of Object.entries(launchers)) {
    const shellPath = path.join(outputRoot, 'bin', name)
    await writeFile(
      shellPath,
      `#!/bin/sh\nexec "\${AUTOCUT_NODE:-node}" "$(dirname "$0")/../headless/${entry}" "$@"\n`,
      { mode: 0o755 },
    )
    await writeFile(
      `${shellPath}.cmd`,
      `@echo off\r\nif "%AUTOCUT_NODE%"=="" set "AUTOCUT_NODE=node"\r\n"%AUTOCUT_NODE%" "%~dp0..\\headless\\${entry}" %*\r\n`,
      'utf8',
    )
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function assertDirectory(directory) {
  const { stat } = await import('node:fs/promises')
  if (!(await stat(directory).catch(() => null))?.isDirectory()) {
    throw new Error(`Required directory is missing: ${directory}`)
  }
}

async function isDirectory(directory) {
  const { stat } = await import('node:fs/promises')
  return (await stat(directory).catch(() => null))?.isDirectory() === true
}

function currentPlatformArch() {
  const platformKey = `${os.platform()}-${os.arch()}`
  const platformArch = new Map([
    ['darwin-arm64', 'macos-arm64'],
    ['win32-x64', 'windows-x64'],
  ]).get(platformKey)
  if (!platformArch) throw new Error(`Unsupported AutoCut runtime platform: ${platformKey}`)
  return platformArch
}

function parseOptions(argv) {
  if (argv.length % 2 !== 0) throw new Error(`Unknown or incomplete option: ${argv.at(-1)}`)
  return Object.fromEntries(
    Array.from({ length: argv.length / 2 }, (_value, index) =>
      parseOptionPair(argv[index * 2], argv[index * 2 + 1]),
    ),
  )
}

function parseOptionPair(flag, value) {
  const key = OPTION_KEYS.get(flag)
  if (!key || !value) throw new Error(`Unknown or incomplete option: ${flag}`)
  return [key, value]
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
