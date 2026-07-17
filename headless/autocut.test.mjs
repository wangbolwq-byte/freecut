import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createEditorUrl } from './agent.mjs'
import { createAutoCutServer } from './autocut-server.mjs'
import { AutoCutBrokerPage } from './lib/autocut-browser-session.mjs'
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

test('broker page sends only known operations and captures render downloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocut-broker-'))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\autocut-test-${process.pid}-${Date.now()}`
      : path.join(root, 'broker.sock')
  const sourceDownload = path.join(root, 'broker-render.webm')
  await writeFile(sourceDownload, 'rendered')
  const received = []
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const request = JSON.parse(buffer.slice(0, newline))
      received.push(request)
      const result =
        request.operation === 'renderProject'
          ? { summary: { effectiveSettings: { container: 'webm' } }, downloadPath: sourceDownload }
          : { id: 'created' }
      socket.end(`${JSON.stringify({ ok: true, result })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
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

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
