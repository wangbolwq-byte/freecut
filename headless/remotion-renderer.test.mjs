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

test('controlled Remotion validation rejects external imports and network capabilities', async (t) => {
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
    assert.ok((await readFile(result.outputPath)).byteLength > 0)
  },
)

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freecut-remotion-'))
  const workspace = path.join(root, 'autocut')
  const taskDirectory = path.join(workspace, 'projects', 'demo', 'remotion', 'lower-third')
  await mkdir(path.join(taskDirectory, 'src'), { recursive: true })
  await mkdir(path.join(taskDirectory, 'public'), { recursive: true })
  await writeFile(
    path.join(taskDirectory, 'task.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
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
        output: 'renders/lower-third.webm',
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    path.join(taskDirectory, 'src', 'Animation.tsx'),
    [
      'import React from "react";',
      'import {AbsoluteFill, useCurrentFrame} from "remotion";',
      'export default function Animation({title}: {title: string}) {',
      '  const frame = useCurrentFrame();',
      '  return <AbsoluteFill style={{opacity: frame > 0 ? 0.8 : 0.2}}>{title}</AbsoluteFill>;',
      '}',
      '',
    ].join('\n'),
  )
  return { root, workspace, taskDirectory }
}

function fakeRendererDependencies(calls, { alpha }) {
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
      await writeFile(options.outputLocation, 'fake-webm-alpha')
    },
    async getVideoMetadata(file) {
      calls.push({ name: 'getVideoMetadata', file })
      return {
        codec: 'vp9',
        pixelFormat: 'yuva420p',
        width: 640,
        height: 360,
        fps: 30,
        durationInSeconds: 1,
      }
    },
  }
}
