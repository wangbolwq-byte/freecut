import { execFileSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
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
const OPTION_KEYS = new Map([
  ['--output', 'output'],
  ['--platform-arch', 'platformArch'],
  ['--version', 'version'],
  ['--commit', 'commit'],
])

async function main(argv = process.argv.slice(2)) {
  const config = resolvePackageConfig(parseOptions(argv))

  await assertDirectory(path.join(REPO_ROOT, 'dist'))
  await assertDirectory(path.join(REPO_ROOT, 'node_modules', 'zod'))
  await stageRuntime(config.outputRoot)

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
    },
  }
  await writeJson(path.join(config.outputRoot, 'runtime-manifest.json'), runtimeManifest)
  await writeJson(path.join(config.outputRoot, 'package.json'), {
    name: '@easyai/autocut-runtime',
    version: config.version,
    private: true,
    type: 'module',
    dependencies: { zod: '4.3.6' },
  })
  await writeLaunchers(config.outputRoot)
  await writeFile(
    path.join(config.outputRoot, 'THIRD_PARTY_NOTICES.md'),
    [
      '# AutoCut runtime notices',
      '',
      `This runtime was built from FreeCut dev commit ${config.commit}.`,
      'FreeCut and Zod license texts are included below the licenses directory.',
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
    version: resolveOption(options.version, () => process.env.AUTOCUT_VERSION?.trim() || '0.1.2'),
    commit: resolveOption(options.commit, readCurrentCommit),
  }
}

async function stageRuntime(outputRoot) {
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
  await cp(
    path.join(REPO_ROOT, 'node_modules', 'zod'),
    path.join(outputRoot, 'node_modules', 'zod'),
    { recursive: true },
  )
  await Promise.all([
    cp(path.join(REPO_ROOT, 'LICENSE'), path.join(outputRoot, 'licenses', 'LICENSE.freecut.txt')),
    cp(
      path.join(REPO_ROOT, 'node_modules', 'zod', 'LICENSE'),
      path.join(outputRoot, 'licenses', 'LICENSE.zod.txt'),
    ),
  ])
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
