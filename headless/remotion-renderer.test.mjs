import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pngjs from 'pngjs'

import {
  RemotionTaskError,
  renderRemotionTask,
  validateRemotionTask,
} from './lib/remotion-renderer.mjs'

const { PNG } = pngjs

test('controlled Remotion task renders verified VP9 alpha inside its project directory', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const calls = []

  const result = await renderRemotionTask({
    workspaceDirectory: fixture.workspace,
    taskDirectory: fixture.taskDirectory,
    browserExecutable: process.execPath,
    dependencies: fakeRendererDependencies(calls, { alpha: 96 }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.taskId, 'lower-third')
  assert.equal(result.codec, 'vp9')
  assert.equal(result.pixelFormat, 'yuva420p')
  assert.equal(result.alphaVerified, true)
  assert.deepEqual(result.alphaSampleFrames, [0, 14, 29])
  assert.match(result.sourceHash, /^sha256:[0-9a-f]{64}$/)
  assert.match(result.outputHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.representativeFrames.length, 3)
  for (const sample of result.representativeFrames) {
    assert.equal(
      path.dirname(sample.path),
      path.join(await realpath(fixture.taskDirectory), 'renders', 'representative'),
    )
    assert.ok((await readFile(sample.path)).byteLength > 0)
  }
  assert.equal(
    result.outputPath,
    path.join(await realpath(fixture.taskDirectory), 'renders', 'lower-third.webm'),
  )
  assert.equal(await readFile(result.outputPath, 'utf8'), 'fake-webm-alpha')

  const renderCall = calls.find((call) => call.name === 'renderMedia')
  assert.equal(renderCall.options.codec, 'vp9')
  assert.equal(renderCall.options.imageFormat, 'png')
  assert.equal(renderCall.options.pixelFormat, 'yuva420p')
  assert.equal(renderCall.options.muted, true)
  assert.deepEqual(renderCall.options.envVariables, {})
  const compositionCall = calls.find((call) => call.name === 'selectComposition')
  assert.match(compositionCall.bundleHtml, /Content-Security-Policy/)
  assert.match(compositionCall.bundleHtml, /connect-src 'self'/)
})

test('controlled Remotion task renders an opaque H.264 composition without alpha requirements', async (t) => {
  const fixture = await createFixture({ renderMode: 'composition' })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const calls = []

  const result = await renderRemotionTask({
    workspaceDirectory: fixture.workspace,
    taskDirectory: fixture.taskDirectory,
    browserExecutable: process.execPath,
    dependencies: fakeRendererDependencies(calls, { alpha: 255, codec: 'h264' }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.renderMode, 'composition')
  assert.equal(result.container, 'mp4')
  assert.equal(result.codec, 'h264')
  assert.equal(result.alphaVerified, undefined)
  assert.equal(result.representativeFrames.length, 3)
  assert.match(result.representativeFrames[0].hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(
    result.outputPath,
    path.join(await realpath(fixture.taskDirectory), 'renders', 'lower-third.mp4'),
  )

  const renderCall = calls.find((call) => call.name === 'renderMedia')
  assert.equal(renderCall.options.codec, 'h264')
  assert.equal(renderCall.options.imageFormat, 'jpeg')
  assert.equal(renderCall.options.pixelFormat, 'yuv420p')
})

test('controlled Remotion task infers GSAP imports and resolves them from the managed runtime', async (t) => {
  const fixture = await createFixture({
    renderMode: 'composition',
    useGsap: true,
  })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const runtimeNodeModules = path.join(fixture.root, 'runtime', 'node_modules')
  await mkdir(path.join(runtimeNodeModules, 'gsap'), { recursive: true })
  await writeFile(
    path.join(runtimeNodeModules, 'gsap', 'package.json'),
    `${JSON.stringify({ name: 'gsap', version: '3.13.0' })}\n`,
  )
  const calls = []

  const result = await renderRemotionTask({
    workspaceDirectory: fixture.workspace,
    taskDirectory: fixture.taskDirectory,
    browserExecutable: process.execPath,
    runtimeNodeModules,
    dependencies: fakeRendererDependencies(calls, { alpha: 255, codec: 'h264' }),
    runNpm: async () => assert.fail('bundled GSAP must not invoke npm'),
  })

  assert.deepEqual(result.dependencies.resolved, [
    { name: 'gsap', version: '3.13.0', source: 'runtime' },
  ])
  assert.equal(result.dependencies.networkAtRender, false)
  assert.match(result.dependencyHash, /^sha256:[0-9a-f]{64}$/u)
  const bundleCall = calls.find((call) => call.name === 'bundle')
  const configuration = bundleCall.options.webpackOverride({
    resolve: { modules: ['node_modules'] },
    module: { rules: [] },
  })
  assert.deepEqual(configuration.resolve.modules, [runtimeNodeModules, 'node_modules'])
})

test('controlled Remotion task allows readable local imports beyond the task directory', async (t) => {
  const fixture = await createFixture({ renderMode: 'composition' })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const projectMedia = path.join(fixture.root, 'project-media.png')
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'freecut-remotion-outside-'))
  t.after(() => rm(outsideRoot, { recursive: true, force: true }))
  const outsideMedia = path.join(outsideRoot, 'outside.png')
  await Promise.all([
    writeFile(projectMedia, 'project-image'),
    writeFile(outsideMedia, 'outside-image'),
  ])
  const sourceDirectory = path.join(fixture.taskDirectory, 'src')
  const projectMediaImport = relativeImport(sourceDirectory, projectMedia)
  const outsideMediaImport = relativeImport(sourceDirectory, outsideMedia)

  await writeFile(
    path.join(fixture.taskDirectory, 'src', 'Animation.tsx'),
    `import imageUrl from ${JSON.stringify(projectMediaImport)}; export default () => <img src={imageUrl} />;\n`,
  )
  await validateRemotionTask({
    workspaceDirectory: fixture.workspace,
    taskDirectory: fixture.taskDirectory,
  })

  await writeFile(
    path.join(fixture.taskDirectory, 'src', 'Animation.tsx'),
    `import imageUrl from ${JSON.stringify(outsideMediaImport)}; export default () => <img src={imageUrl} />;\n`,
  )
  await validateRemotionTask({
    workspaceDirectory: fixture.workspace,
    taskDirectory: fixture.taskDirectory,
  })
})

test('controlled Remotion validation infers public npm imports and rejects Node/network capabilities', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  await writeFile(
    path.join(fixture.taskDirectory, 'src', 'Animation.tsx'),
    'import fs from "node:fs"; export default () => null;\n',
  )
  await assert.rejects(
    validateRemotionTask({
      workspaceDirectory: fixture.workspace,
      taskDirectory: fixture.taskDirectory,
    }),
    (error) =>
      error instanceof RemotionTaskError &&
      error.code === 'REMOTION_IMPORT_FORBIDDEN' &&
      /node:fs/.test(error.message),
  )

  await writeFile(
    path.join(fixture.taskDirectory, 'src', 'Animation.tsx'),
    'import { gsap } from "gsap"; export default () => <div>{gsap.version}</div>;\n',
  )
  const validation = await validateRemotionTask({
    workspaceDirectory: fixture.workspace,
    taskDirectory: fixture.taskDirectory,
  })
  assert.deepEqual(validation.npmPackages, ['gsap'])

  await writeFile(
    path.join(fixture.taskDirectory, 'src', 'Animation.tsx'),
    'import { flushSync } from "react-dom"; export default () => <div>{typeof flushSync}</div>;\n',
  )
  const managedValidation = await validateRemotionTask({
    workspaceDirectory: fixture.workspace,
    taskDirectory: fixture.taskDirectory,
  })
  assert.deepEqual(managedValidation.npmPackages, [])

  await writeFile(
    path.join(fixture.taskDirectory, 'src', 'Animation.tsx'),
    'export default () => { fetch("https://example.test"); return null };\n',
  )
  await assert.rejects(
    validateRemotionTask({
      workspaceDirectory: fixture.workspace,
      taskDirectory: fixture.taskDirectory,
    }),
    (error) =>
      error instanceof RemotionTaskError &&
      error.code === 'REMOTION_SOURCE_CAPABILITY_FORBIDDEN' &&
      /fetch/.test(error.message),
  )
})

test('controlled Remotion validation infers literal dynamic imports only', async (t) => {
  const fixture = await createFixture({ renderMode: 'composition' })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  await writeFile(
    path.join(fixture.taskDirectory, 'src', 'Animation.tsx'),
    'export const loadGsap = () => import("gsap"); export default () => null;\n',
  )
  const validation = await validateRemotionTask({
    workspaceDirectory: fixture.workspace,
    taskDirectory: fixture.taskDirectory,
  })
  assert.deepEqual(validation.npmPackages, ['gsap'])

  await writeFile(
    path.join(fixture.taskDirectory, 'src', 'Animation.tsx'),
    'const name = "gsap"; export const loadGsap = () => import(name); export default () => null;\n',
  )
  await assert.rejects(
    validateRemotionTask({
      workspaceDirectory: fixture.workspace,
      taskDirectory: fixture.taskDirectory,
    }),
    (error) =>
      error instanceof RemotionTaskError &&
      error.code === 'REMOTION_DYNAMIC_IMPORT_FORBIDDEN' &&
      /string literal/.test(error.message),
  )
})

test('controlled Remotion rendering rejects compositions without transparent pixels', async (t) => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  await assert.rejects(
    renderRemotionTask({
      workspaceDirectory: fixture.workspace,
      taskDirectory: fixture.taskDirectory,
      browserExecutable: process.execPath,
      dependencies: fakeRendererDependencies([], { alpha: 255 }),
    }),
    (error) =>
      error instanceof RemotionTaskError &&
      error.code === 'REMOTION_ALPHA_NOT_PRESENT' &&
      /transparent pixels/.test(error.message),
  )
})

test('controlled Remotion tasks must use the project remotion directory layout', async (t) => {
  const fixture = await createFixture()
  const misplaced = path.join(fixture.workspace, 'remotion', 'lower-third')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  await mkdir(path.dirname(misplaced), { recursive: true })
  await mkdir(misplaced)

  await assert.rejects(
    validateRemotionTask({
      workspaceDirectory: fixture.workspace,
      taskDirectory: misplaced,
    }),
    (error) => error instanceof RemotionTaskError && error.code === 'REMOTION_TASK_LAYOUT_INVALID',
  )
})

test(
  'controlled Remotion task renders a real transparent WebM',
  { skip: process.env.AUTOCUT_REMOTION_INTEGRATION !== '1' },
  async (t) => {
    const fixture = await createFixture()
    t.after(() => rm(fixture.root, { recursive: true, force: true }))

    const result = await renderRemotionTask({
      workspaceDirectory: fixture.workspace,
      taskDirectory: fixture.taskDirectory,
      browserExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      timeoutInMilliseconds: 120_000,
    })

    assert.equal(result.codec, 'vp9')
    assert.equal(result.pixelFormat, 'yuva420p')
    assert.equal(result.alphaVerified, true)
    assert.equal(result.representativeFrames.length, 3)
    for (const sample of result.representativeFrames) {
      assert.ok((await readFile(sample.path)).byteLength > 0)
    }
    assert.ok((await readFile(result.outputPath)).byteLength > 0)
  },
)

test(
  'controlled Remotion task renders a real H.264 MP4 composition',
  { skip: process.env.AUTOCUT_REMOTION_INTEGRATION !== '1' },
  async (t) => {
    const fixture = await createFixture({
      renderMode: 'composition',
      externalAsset: true,
      useGsap: true,
    })
    t.after(() => rm(fixture.root, { recursive: true, force: true }))

    const result = await renderRemotionTask({
      workspaceDirectory: fixture.workspace,
      taskDirectory: fixture.taskDirectory,
      browserExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      timeoutInMilliseconds: 120_000,
    })

    assert.equal(result.renderMode, 'composition')
    assert.equal(result.container, 'mp4')
    assert.equal(result.codec, 'h264')
    assert.equal(result.alphaVerified, undefined)
    assert.equal(result.representativeFrames.length, 3)
    for (const sample of result.representativeFrames) {
      assert.ok((await readFile(sample.path)).byteLength > 0)
    }
    assert.ok((await readFile(result.outputPath)).byteLength > 0)
  },
)

async function createFixture({
  renderMode = 'transparent-overlay',
  externalAsset = false,
  useGsap = false,
  dependencies,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freecut-remotion-'))
  const workspace = path.join(root, 'autocut')
  const taskDirectory = path.join(workspace, 'projects', 'demo', 'remotion', 'lower-third')
  await mkdir(path.join(taskDirectory, 'src'), { recursive: true })
  await mkdir(path.join(taskDirectory, 'public'), { recursive: true })
  let externalAssetImport
  if (externalAsset) {
    const externalAssetPath = path.join(root, 'shared-assets', 'background.png')
    await mkdir(path.dirname(externalAssetPath), { recursive: true })
    const image = new PNG({ width: 2, height: 2 })
    image.data.fill(255)
    await writeFile(externalAssetPath, PNG.sync.write(image))
    externalAssetImport = relativeImport(path.join(taskDirectory, 'src'), externalAssetPath)
  }
  await writeFile(
    path.join(taskDirectory, 'task.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ...(renderMode === 'transparent-overlay' ? {} : { renderMode }),
        taskId: 'lower-third',
        entryPoint: 'src/Animation.tsx',
        componentExport: 'default',
        composition: {
          id: 'lower-third',
          width: 640,
          height: 360,
          fps: 30,
          durationInFrames: 30,
        },
        inputProps: { title: 'AutoCut' },
        ...(dependencies ? { dependencies } : {}),
        output:
          renderMode === 'composition' ? 'renders/lower-third.mp4' : 'renders/lower-third.webm',
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    path.join(taskDirectory, 'src', 'Animation.tsx'),
    [
      'import React from "react";',
      `import {AbsoluteFill, Img, useCurrentFrame} from "remotion";`,
      ...(useGsap ? ['import {gsap} from "gsap";'] : []),
      ...(externalAssetImport
        ? [`import backgroundUrl from ${JSON.stringify(externalAssetImport)};`]
        : []),
      'export default function Animation({title}: {title: string}) {',
      '  const frame = useCurrentFrame();',
      ...(useGsap
        ? ['  const opacity = gsap.parseEase("power2.out")(frame / 29);']
        : ['  const opacity = frame > 0 ? 0.8 : 0.2;']),
      `  return <AbsoluteFill style={{opacity}}>${externalAssetImport ? '<Img src={backgroundUrl} />' : ''}{title}</AbsoluteFill>;`,
      '}',
      '',
    ].join('\n'),
  )
  return { root, workspace, taskDirectory }
}

function fakeRendererDependencies(calls, { alpha, codec = 'vp9' }) {
  const composition = {
    id: 'lower-third',
    width: 640,
    height: 360,
    fps: 30,
    durationInFrames: 30,
  }
  return {
    async bundle(options) {
      calls.push({ name: 'bundle', options })
      await mkdir(options.outDir, { recursive: true })
      await writeFile(
        path.join(options.outDir, 'index.html'),
        '<html><head></head><body></body></html>',
      )
      return options.outDir
    },
    async selectComposition(options) {
      calls.push({
        name: 'selectComposition',
        options,
        bundleHtml: await readFile(path.join(options.serveUrl, 'index.html'), 'utf8'),
      })
      return composition
    },
    async renderStill(options) {
      calls.push({ name: 'renderStill', options })
      const image = new PNG({ width: 2, height: 2 })
      for (let index = 0; index < image.data.length; index += 4) {
        image.data[index] = 255
        image.data[index + 1] = 0
        image.data[index + 2] = 0
        image.data[index + 3] = alpha
      }
      await writeFile(options.output, PNG.sync.write(image))
    },
    async renderMedia(options) {
      calls.push({ name: 'renderMedia', options })
      await writeFile(options.outputLocation, codec === 'h264' ? 'fake-mp4' : 'fake-webm-alpha')
    },
    async getVideoMetadata(file) {
      calls.push({ name: 'getVideoMetadata', file })
      return {
        codec,
        pixelFormat: codec === 'h264' ? 'yuv420p' : 'yuva420p',
        width: 640,
        height: 360,
        fps: 30,
        durationInSeconds: 1,
      }
    },
  }
}

function relativeImport(fromDirectory, target) {
  const relative = path.relative(fromDirectory, target).split(path.sep).join('/')
  return relative.startsWith('.') ? relative : `./${relative}`
}
