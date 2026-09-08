import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createEditorUrl, run } from './agent.mjs'
import { createAutoCutServer } from './autocut-server.mjs'
import { AutoCutBrokerPage } from './lib/autocut-browser-session.mjs'
import { createProjectResource, getProjectResource } from './lib/lifecycle-store.mjs'
import { listenJsonLineServer } from './test-json-line-server.mjs'
import { isMainModule } from './lib/main-module.mjs'

test(
  'AutoCut entrypoints recognize canonical path aliases',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-main-module-'))
    const target = fileURLToPath(import.meta.url)
    const aliasRoot = path.join(root, 'headless-link')
    try {
      await symlink(path.dirname(target), aliasRoot, 'dir')
      assert.equal(isMainModule(import.meta.url, path.join(aliasRoot, path.basename(target))), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('AutoCut server exposes the editor at root and versioned health data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-server-'))
  const dist = path.join(root, 'dist')
  await mkdir(dist)
  await writeFile(path.join(dist, 'index.html'), '<h1>AutoCut editor</h1>')
  await writeFile(path.join(dist, 'headless.html'), '<h1>AutoCut headless</h1>')
  const server = await createAutoCutServer({
    port: 0,
    distDir: dist,
    manifest: {
      schemaVersion: 1,
      name: 'autocut',
      version: '1.2.3',
      upstream: { repository: 'freecut', branch: 'dev', commit: 'abc123' },
    },
  })
  try {
    const editor = await fetch(server.base)
    assert.equal(editor.status, 200)
    assert.match(await editor.text(), /AutoCut editor/)
    const projectEditor = await fetch(`${server.base}/editor/demo?autocutProjectToken=token`)
    assert.equal(projectEditor.status, 200)
    assert.match(await projectEditor.text(), /AutoCut editor/)
    const projects = await fetch(`${server.base}/projects?autocutProjectToken=token`)
    assert.equal(projects.status, 200)
    assert.match(await projects.text(), /AutoCut editor/)
    const headless = await fetch(server.harnessUrl)
    assert.equal(headless.status, 200)
    assert.match(await headless.text(), /AutoCut headless/)
    const health = await fetch(`${server.base}/health`).then((response) => response.json())
    assert.deepEqual(health, {
      ok: true,
      name: 'autocut',
      status: 'ready',
      version: '1.2.3',
      upstream: { repository: 'freecut', branch: 'dev', commit: 'abc123' },
    })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('editor-url binds the visible editor to the injected project token', () => {
  const previousUrl = process.env.AUTOCUT_EDITOR_URL
  const previousToken = process.env.AUTOCUT_PROJECT_TOKEN
  process.env.AUTOCUT_EDITOR_URL = 'http://127.0.0.1:18787'
  process.env.AUTOCUT_PROJECT_TOKEN = 'project-token'
  try {
    assert.equal(
      createEditorUrl({ id: 'demo' }).url,
      'http://127.0.0.1:18787/editor/demo?autocutProjectToken=project-token',
    )
  } finally {
    restoreEnvironment('AUTOCUT_EDITOR_URL', previousUrl)
    restoreEnvironment('AUTOCUT_PROJECT_TOKEN', previousToken)
  }
})

test('AutoCut agent exposes compact capabilities and project edit help without a workspace', async () => {
  const compact = await run(['capabilities', '--compact'])
  assert.equal(compact.ok, true)
  assert.equal(compact.compact, true)
  assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') < 16 * 1024)
  assert.equal(compact.canonicalCommands.remotionRender, 'remotion-render --task <task.json>')
  assert.equal(compact.features.remotionNpmDependencies, true)
  assert.equal(compact.remotionDependencies.inferredFromImports, true)
  assert.equal(compact.remotionDependencies.taskDeclarationRequired, false)
  assert.deepEqual(compact.remotionDependencies.bundled, { gsap: '3.13.0' })

  const help = await run(['project', 'edit', '--help'])
  assert.equal(help.ok, true)
  assert.match(help.help.canonicalCommand, /--ops <operations\.json> --persist/)
  assert.equal(help.help.authoritativeItemIds, 'project.timeline.items[].id')

  await assert.rejects(run(['project', 'edit', '--operation', 'ops.json']), (error) => {
    assert.equal(error.code, 'CLI_USAGE_ERROR')
    assert.ok(error.details.allowedOptions.includes('--ops'))
    assert.match(error.details.canonicalCommand, /project edit/)
    return true
  })
})

test('AutoCut agent dispatches remotion-render to the global runner without a browser session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-remotion-agent-'))
  const workspace = path.join(root, 'autocut')
  const taskDirectory = path.join(workspace, 'projects', 'assets', 'remotion', 'title-card')
  const taskPath = path.join(taskDirectory, 'task.json')
  await mkdir(path.join(taskDirectory, 'src'), { recursive: true })
  await writeFile(taskPath, '{}')

  const calls = []
  try {
    const help = await run(['remotion-render', '--help'])
    assert.equal(help.help.canonicalCommand, 'remotion-render --task <task.json>')

    const result = await run(['remotion-render', '--workspace', workspace, '--task', taskPath], {
      async renderRemotionTask(input) {
        calls.push(input)
        return {
          ok: true,
          taskId: 'title-card',
          outputPath: path.join(taskDirectory, 'renders', 'title-card.webm'),
          alphaVerified: true,
        }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.taskId, 'title-card')
    assert.equal(result.alphaVerified, true)
    assert.deepEqual(calls, [{ workspaceDirectory: workspace, taskDirectory }])

    await assert.rejects(
      run(['remotion-render', '--workspace', workspace], {
        renderRemotionTask: async () => assert.fail('runner must not be called'),
      }),
      (error) => {
        assert.equal(error.code, 'CLI_USAGE_ERROR')
        assert.equal(error.details.canonicalCommand, 'remotion-render --task <task.json>')
        return true
      },
    )
    await assert.rejects(
      run(['remotion-render', '--workspace', workspace, '--task', taskPath, '--project', 'demo'], {
        renderRemotionTask: async () => assert.fail('runner must not be called'),
      }),
      (error) => {
        assert.equal(error.code, 'CLI_USAGE_ERROR')
        assert.ok(error.details.allowedOptions.includes('--task'))
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed project edit reports operation context and preserves project bytes and revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-agent-atomic-failure-'))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\autocut-agent-failure-${process.pid}-${Date.now()}`
      : path.join(root, 'broker.sock')
  const harness = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>headless</title>')
  })
  await new Promise((resolve, reject) => {
    harness.once('error', reject)
    harness.listen(0, '127.0.0.1', resolve)
  })
  const harnessAddress = harness.address()
  const harnessUrl = `http://127.0.0.1:${harnessAddress.port}/headless.html`
  const broker = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      socket.end(
        `${JSON.stringify({
          ok: true,
          result: {
            ok: false,
            applied: 1,
            results: [
              { callerId: 'first', op: 'addText', ok: true, detail: { id: 'temporary' } },
              { callerId: 'broken', op: 'addTransition', ok: false, error: 'invalid transition' },
            ],
            persisted: false,
            projectUnchanged: true,
            error: {
              code: 'EDIT_OPERATION_FAILED',
              message: 'Edit op "addTransition" failed: invalid transition',
              operationIndex: 1,
              callerId: 'broken',
              op: 'addTransition',
            },
          },
        })}\n`,
      )
    })
  })
  await new Promise((resolve, reject) => {
    broker.once('error', reject)
    broker.listen(endpoint, resolve)
  })
  const previousEndpoint = process.env.AUTOCUT_BROKER_ENDPOINT
  const previousToken = process.env.AUTOCUT_BROKER_TOKEN
  process.env.AUTOCUT_BROKER_ENDPOINT = endpoint
  process.env.AUTOCUT_BROKER_TOKEN = 'test-token'
  try {
    const created = await createProjectResource(root, {
      id: 'demo',
      name: 'Demo',
      description: '',
      createdAt: 1,
      updatedAt: 1,
      duration: 0,
      schemaVersion: 14,
      metadata: { width: 1920, height: 1080, fps: 30 },
      timeline: { tracks: [], items: [] },
    })
    const projectPath = path.join(root, 'projects', 'demo', 'project.json')
    const beforeBytes = await readFile(projectPath)
    const opsPath = path.join(root, 'operations.json')
    await writeFile(
      opsPath,
      JSON.stringify([
        { callerId: 'first', op: 'addText', text: 'temporary', from: 0 },
        {
          callerId: 'broken',
          op: 'addTransition',
          leftClipId: { $ref: 'first#/detail/id' },
          rightClipId: 'missing',
        },
      ]),
    )

    await assert.rejects(
      run([
        'project',
        'edit',
        '--workspace',
        root,
        '--id',
        'demo',
        '--ops',
        opsPath,
        '--persist',
        '--expected-revision',
        created.revision,
        '--harness-url',
        harnessUrl,
      ]),
      (error) => {
        assert.equal(error.code, 'EDIT_OPERATION_FAILED')
        assert.deepEqual(
          {
            operationIndex: error.details.operationIndex,
            callerId: error.details.callerId,
            operation: error.details.operation,
            baseRevision: error.details.baseRevision,
            persisted: error.details.persisted,
            projectUnchanged: error.details.projectUnchanged,
          },
          {
            operationIndex: 1,
            callerId: 'broken',
            operation: 'addTransition',
            baseRevision: created.revision,
            persisted: false,
            projectUnchanged: true,
          },
        )
        assert.equal(error.details.command, 'project edit')
        assert.equal(error.details.correctExamples[0].ops[0].op, 'addTransition')
        return true
      },
    )
    assert.deepEqual(await readFile(projectPath), beforeBytes)
    assert.equal((await getProjectResource(root, 'demo')).revision, created.revision)
  } finally {
    restoreEnvironment('AUTOCUT_BROKER_ENDPOINT', previousEndpoint)
    restoreEnvironment('AUTOCUT_BROKER_TOKEN', previousToken)
    await new Promise((resolve) => broker.close(resolve))
    await new Promise((resolve) => harness.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('broker page sends only known operations and captures render downloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-broker-'))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\autocut-test-${process.pid}-${Date.now()}`
      : path.join(root, 'broker.sock')
  const sourceDownload = path.join(root, 'broker-render.webm')
  await writeFile(sourceDownload, 'rendered')
  const received = []
  const server = await listenJsonLineServer(endpoint, (request) => {
    received.push(request)
    return request.operation === 'renderProject'
      ? { summary: { effectiveSettings: { container: 'webm' } }, downloadPath: sourceDownload }
      : { id: 'created' }
  })
  const page = new AutoCutBrokerPage({ endpoint, token: 'secret' })
  try {
    assert.deepEqual(
      await page.evaluate((value) => window.autocut.createProject(value), { name: 'Demo' }),
      { id: 'created' },
    )
    const downloadPromise = page.waitForEvent('download')
    assert.deepEqual(
      await page.evaluate((value) => window.autocut.renderProject(value), { project: {} }),
      { effectiveSettings: { container: 'webm' } },
    )
    const output = path.join(root, 'output.webm')
    await (await downloadPromise).saveAs(output)
    assert.equal(
      await import('node:fs/promises').then(({ readFile }) => readFile(output, 'utf8')),
      'rendered',
    )
    assert.deepEqual(
      received.map(({ token, operation }) => ({ token, operation })),
      [
        { token: 'secret', operation: 'createProject' },
        { token: 'secret', operation: 'renderProject' },
      ],
    )
    await assert.rejects(
      page.evaluate((value) => window.autocut.unknown(value), {}),
      /unknown page operation/,
    )
  } finally {
    await page.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('managed render submit returns after Host queueing and status uses the durable reference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-managed-render-'))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\autocut-managed-render-${process.pid}-${Date.now()}`
      : path.join(root, 'broker.sock')
  const requests = []
  const server = await listenJsonLineServer(endpoint, (request) => {
    requests.push(request)
    return request.operation === 'renderSubmit'
      ? { renderRef: 'autocut-render://render-1', status: 'queued', projectVersion: 'v1' }
      : {
          renderRef: 'autocut-render://render-1',
          status: 'running',
          progress: { percent: 48, message: 'rendering' },
        }
  })
  const previousEndpoint = process.env.AUTOCUT_BROKER_ENDPOINT
  const previousToken = process.env.AUTOCUT_BROKER_TOKEN
  process.env.AUTOCUT_BROKER_ENDPOINT = endpoint
  process.env.AUTOCUT_BROKER_TOKEN = 'managed-token'
  try {
    const created = await createProjectResource(root, {
      id: 'demo',
      name: 'Demo',
      description: '',
      createdAt: 1,
      updatedAt: 1,
      duration: 0,
      schemaVersion: 14,
      metadata: { width: 1920, height: 1080, fps: 30 },
      timeline: { tracks: [], items: [] },
    })
    const submitted = await run([
      'render',
      'submit',
      '--workspace',
      root,
      '--project',
      'demo',
      '--out',
      'projects/demo/renders/final.mp4',
      '--preset',
      'final',
    ])
    assert.equal(submitted.render.status, 'queued')
    assert.equal(requests[0].operation, 'renderSubmit')
    assert.equal(requests[0].payload.expectedRevision, created.revision)
    assert.equal(requests[0].payload.settings.preset, 'final')

    const status = await run([
      'render',
      'status',
      '--workspace',
      root,
      '--ref',
      submitted.render.renderRef,
    ])
    assert.equal(status.render.status, 'running')
    assert.equal(status.render.progress.percent, 48)
    assert.equal(requests[1].operation, 'renderStatus')
    assert.deepEqual(requests[1].payload, { renderRef: 'autocut-render://render-1' })
  } finally {
    restoreEnvironment('AUTOCUT_BROKER_ENDPOINT', previousEndpoint)
    restoreEnvironment('AUTOCUT_BROKER_TOKEN', previousToken)
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
