import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')

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
      'macos-arm64',
      '--version',
      '0.0.0-test',
      '--commit',
      'test-commit',
    ],
    { cwd: repoRoot },
  )

  const runtimePackage = JSON.parse(await readFile(path.join(outputRoot, 'package.json'), 'utf8'))
  assert.deepEqual(runtimePackage.dependencies, {
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
  const runtimeManifest = JSON.parse(
    await readFile(path.join(outputRoot, 'runtime-manifest.json'), 'utf8'),
  )
  assert.equal(runtimeManifest.entrypoints.remotionRenderer, 'headless/lib/remotion-renderer.mjs')
  const packagedRendererCli = path.join(outputRoot, 'bin', 'remotion-render')
  const packagedEnvironment = { ...process.env, AUTOCUT_NODE: process.execPath }
  const packagedHelp = await execFileAsync(packagedRendererCli, ['--help'], {
    cwd: outputRoot,
    env: packagedEnvironment,
  })
  const packagedHelpPayload = JSON.parse(packagedHelp.stdout)
  assert.equal(packagedHelpPayload.ok, true)
  assert.deepEqual(packagedHelpPayload.help.requiredOptions, ['--task'])
  assert.equal(packagedHelpPayload.help.canonicalCommand, 'remotion-render --task <task.json>')
  await assert.rejects(
    execFileAsync(packagedRendererCli, [], {
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
