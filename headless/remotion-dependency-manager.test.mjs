import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  RemotionDependencyError,
  externalImportPackageName,
  parseRemotionDependencyMap,
  prepareRemotionTaskDependencies,
} from './lib/remotion-dependency-manager.mjs'

test('legacy Remotion dependency pins require exact public npm versions', () => {
  assert.deepEqual(
    parseRemotionDependencyMap({ gsap: '3.13.0', '@scope/motion': '1.2.3-beta.1' }),
    {
      '@scope/motion': '1.2.3-beta.1',
      gsap: '3.13.0',
    },
  )
  assert.equal(externalImportPackageName('gsap/ScrollTrigger'), 'gsap')
  assert.equal(externalImportPackageName('@scope/motion/easing'), '@scope/motion')

  assert.throws(
    () => parseRemotionDependencyMap({ gsap: '^3.13.0' }),
    (error) =>
      error instanceof RemotionDependencyError &&
      error.code === 'REMOTION_TASK_CONFIG_INVALID' &&
      /exact semantic version/.test(error.message),
  )
  assert.throws(
    () => parseRemotionDependencyMap({ react: '19.2.5' }),
    (error) =>
      error instanceof RemotionDependencyError &&
      error.code === 'REMOTION_TASK_CONFIG_INVALID' &&
      /managed react runtime/.test(error.message),
  )
})

test('Remotion imports reuse bundled packages without invoking npm', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-remotion-runtime-dependency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const taskDirectory = path.join(root, 'task')
  const runtimeNodeModules = path.join(root, 'runtime', 'node_modules')
  await mkdir(path.join(runtimeNodeModules, 'gsap'), { recursive: true })
  await mkdir(taskDirectory)
  await writeFile(
    path.join(runtimeNodeModules, 'gsap', 'package.json'),
    `${JSON.stringify({ name: 'gsap', version: '3.13.0' })}\n`,
  )

  const result = await prepareRemotionTaskDependencies({
    taskDirectory,
    packageNames: ['gsap'],
    runtimeNodeModules,
    runNpm: async () => assert.fail('bundled GSAP must not invoke npm'),
  })

  assert.deepEqual(result.nodeModulesPaths, [runtimeNodeModules])
  assert.deepEqual(result.evidence.resolved, [
    { name: 'gsap', version: '3.13.0', source: 'runtime' },
  ])
  assert.deepEqual(result.evidence.requested, { gsap: 'auto' })
  assert.equal(result.evidence.cacheReused, true)
  assert.match(result.dependencyHash, /^sha256:[0-9a-f]{64}$/u)
})

test('Remotion imports install once and lock the resolved version in an isolated cache', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-remotion-task-dependency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const taskDirectory = path.join(root, 'task')
  const runtimeNodeModules = path.join(root, 'runtime', 'node_modules')
  const npmCliPath = path.join(root, 'npm-cli.js')
  await Promise.all([
    mkdir(taskDirectory, { recursive: true }),
    mkdir(runtimeNodeModules, { recursive: true }),
    writeFile(npmCliPath, 'fixture'),
  ])
  const calls = []
  const runNpm = async (input) => {
    calls.push(input)
    const packageJsonPath = path.join(input.cwd, 'package.json')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    for (const specifier of input.args.slice(input.args.indexOf('--save-exact') + 1)) {
      const name = specifier.startsWith('@')
        ? specifier.slice(0, specifier.indexOf('@', 1))
        : specifier.split('@')[0]
      const requestedVersion = specifier.slice(name.length + 1)
      const version = requestedVersion || '1.2.3'
      packageJson.dependencies[name] = version
      const packageRoot = path.join(input.cwd, 'node_modules', name)
      await mkdir(packageRoot, { recursive: true })
      await writeFile(
        path.join(packageRoot, 'package.json'),
        `${JSON.stringify({ name, version })}\n`,
      )
    }
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
    await writeFile(
      path.join(input.cwd, 'package-lock.json'),
      `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`,
    )
  }
  const input = {
    taskDirectory,
    packageNames: ['easing-library'],
    runtimeNodeModules,
    npmCliPath,
    runNpm,
  }

  const installed = await prepareRemotionTaskDependencies(input)
  const reused = await prepareRemotionTaskDependencies(input)

  assert.equal(calls.length, 1)
  assert.ok(calls[0].args.includes('--ignore-scripts'))
  assert.ok(calls[0].args.includes('--legacy-peer-deps'))
  assert.ok(calls[0].args.includes('--save-exact'))
  assert.ok(calls[0].args.includes('easing-library'))
  assert.equal(calls[0].env.NODE_ENV, 'production')
  assert.equal(installed.evidence.cacheReused, false)
  assert.equal(reused.evidence.cacheReused, true)
  assert.deepEqual(installed.evidence.resolved, [
    { name: 'easing-library', version: '1.2.3', source: 'task-cache' },
  ])
  assert.deepEqual(installed.evidence.requested, { 'easing-library': 'auto' })
  assert.match(installed.evidence.lockHash, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(installed.nodeModulesPaths.length, 2)
})
