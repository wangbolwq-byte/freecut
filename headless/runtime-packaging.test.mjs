import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { resolveLockedRuntimePackages } from '../scripts/autocut-runtime-dependencies.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')

test('runtime dependency selection follows the requested platform and requires locked dependencies', () => {
  const lock = {
    packages: {
      'node_modules/binding': {
        version: '1',
        optionalDependencies: { windows: '1', mac: '1' },
        dependencies: { shared: '1' },
      },
      'node_modules/windows': { version: '1', os: ['win32'], cpu: ['x64'] },
      'node_modules/mac': { version: '1', os: ['darwin'], cpu: ['arm64'] },
      'node_modules/shared': { version: '1' },
    },
  }
  const selected = (target) =>
    resolveLockedRuntimePackages(lock, { binding: '1' }, target).map((entry) => entry.name)
  assert.deepEqual(selected('windows-x64'), ['binding', 'shared', 'windows'])
  assert.deepEqual(selected('macos-arm64'), ['binding', 'mac', 'shared'])
  delete lock.packages['node_modules/shared']
  assert.throws(() => selected('windows-x64'), /missing from package-lock.json: shared/)
})

test('packaged AutoCut runtime includes standalone browser dependencies', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'autocut-runtime-package-'))
  const outputRoot = path.join(tempRoot, 'runtime')
  t.after(() => rm(tempRoot, { recursive: true, force: true }))

  await execFileAsync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'package-autocut-runtime.mjs'),
      '--output',
      outputRoot,
      '--platform-arch',
      process.platform === 'win32' ? 'windows-x64' : 'macos-arm64',
      '--version',
      '0.0.0-test',
      '--commit',
      'test-commit',
    ],
    { cwd: repoRoot },
  )

  const manifest = JSON.parse(
    await readFile(path.join(outputRoot, 'runtime-manifest.json'), 'utf8'),
  )
  assert.equal(manifest.features.renderProjectRevisionV1, true)
  const runtimePackage = JSON.parse(await readFile(path.join(outputRoot, 'package.json'), 'utf8'))
  assert.deepEqual(runtimePackage.dependencies, {
    '@babel/parser': '7.29.7',
    '@remotion/bundler': '4.0.499',
    '@remotion/renderer': '4.0.499',
    gsap: '3.13.0',
    playwright: '1.60.0',
    'playwright-core': '1.60.0',
    pngjs: '7.0.0',
    react: '19.2.5',
    'react-dom': '19.2.5',
    remotion: '4.0.499',
    zod: '4.3.6',
  })

  const packagedPlaywright = await import(
    pathToFileURL(path.join(outputRoot, 'node_modules', 'playwright', 'index.mjs')).href
  )
  assert.equal(typeof packagedPlaywright.chromium.launch, 'function')
  const packagedRemotionRenderer = await import(
    pathToFileURL(path.join(outputRoot, 'headless', 'lib', 'remotion-renderer.mjs')).href
  )
  assert.equal(typeof packagedRemotionRenderer.renderRemotionTask, 'function')
  const packagedBundler = await import(
    pathToFileURL(path.join(outputRoot, 'node_modules', '@remotion', 'bundler', 'dist', 'index.js'))
      .href
  )
  const packagedRenderer = await import(
    pathToFileURL(
      path.join(outputRoot, 'node_modules', '@remotion', 'renderer', 'dist', 'index.js'),
    ).href
  )
  assert.equal(typeof packagedBundler.bundle, 'function')
  assert.equal(typeof packagedRenderer.renderMedia, 'function')
  const packagedGsap = await import(
    pathToFileURL(path.join(outputRoot, 'node_modules', 'gsap', 'index.js')).href
  )
  assert.equal(typeof packagedGsap.gsap.parseEase, 'function')
  const runtimeManifest = JSON.parse(
    await readFile(path.join(outputRoot, 'runtime-manifest.json'), 'utf8'),
  )
  assert.equal(runtimeManifest.entrypoints.remotionRenderer, 'headless/lib/remotion-renderer.mjs')
  const notices = await readFile(path.join(outputRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  assert.match(
    notices,
    /gsap@3\.13\.0 — Standard 'no charge' license: https:\/\/gsap\.com\/standard-license\./u,
  )
  const packagedRendererCli =
    process.platform === 'win32'
      ? process.execPath
      : path.join(outputRoot, 'bin', 'remotion-render')
  const launcherArgs =
    process.platform === 'win32' ? [path.join(outputRoot, 'headless', 'remotion-render.mjs')] : []
  const packagedEnvironment = { ...process.env, AUTOCUT_NODE: process.execPath }
  const packagedHelp = await execFileAsync(packagedRendererCli, [...launcherArgs, '--help'], {
    cwd: outputRoot,
    env: packagedEnvironment,
  })
  const packagedHelpPayload = JSON.parse(packagedHelp.stdout)
  assert.equal(packagedHelpPayload.ok, true)
  assert.deepEqual(packagedHelpPayload.help.requiredOptions, ['--task'])
  assert.equal(packagedHelpPayload.help.canonicalCommand, 'remotion-render --task <task.json>')
  await assert.rejects(
    execFileAsync(packagedRendererCli, launcherArgs, {
      cwd: outputRoot,
      env: packagedEnvironment,
    }),
    (error) => {
      const payload = JSON.parse(error.stderr)
      assert.equal(payload.error.code, 'CLI_USAGE_ERROR')
      assert.equal(payload.error.usage.command, 'remotion-render')
      assert.equal(payload.error.usage.canonicalCommand, 'remotion-render --task <task.json>')
      return true
    },
  )
})
