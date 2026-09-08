import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { run } from './agent.mjs'
import { createProjectResource } from './lib/lifecycle-store.mjs'
import { listenJsonLineServer } from './test-json-line-server.mjs'
import {
  AUTOCUT_AGENT_COMMAND_CONTRACTS,
  commandHelp,
  correctExamples,
  normalizeCommandArgv,
} from './lib/agent-command-contracts.mjs'

const execFileAsync = promisify(execFile)

test('persisted edit CLI replays the same key without another browser edit', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'autocut-edit-cli-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\autocut-edit-${process.pid}-${Date.now()}`
      : path.join(workspace, 'broker.sock')
  const calls = []
  const server = await listenJsonLineServer(endpoint, (request) => {
    calls.push(request.operation)
    if (request.operation === 'editProject') {
      return {
        ok: true,
        applied: 1,
        results: [{ callerId: 'titleA', detail: { id: 'created-title' } }],
        project: {
          ...request.payload.project,
          timeline: {
            ...request.payload.project.timeline,
            items: [
              { id: 'created-title', type: 'text', text: 'A', from: 0, durationInFrames: 30 },
            ],
          },
        },
      }
    }
    return request.operation === 'normalizeProject' ? request.payload : {}
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const harness = http.createServer((_request, response) =>
    response.end('<html>Headless fixture</html>'),
  )
  await new Promise((resolve) => harness.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => harness.close(resolve)))
  const created = await createProjectResource(workspace, {
    id: 'edit-demo',
    name: 'Edit',
    metadata: { fps: 30 },
    timeline: { tracks: [], items: [] },
  })
  const opsFile = path.join(workspace, 'operations.json')
  await writeFile(
    opsFile,
    JSON.stringify([
      { callerId: 'titleA', op: 'addText', text: 'A', from: 0, durationInFrames: 30 },
    ]),
  )
  const argv = [
    path.join(import.meta.dirname, 'agent.mjs'),
    'project',
    'edit',
    '--workspace',
    workspace,
    '--id',
    'edit-demo',
    '--ops',
    opsFile,
    '--persist',
    '--expected-revision',
    created.revision,
    '--idempotency-key',
    'cli-batch-one',
  ]
  const env = {
    ...process.env,
    AUTOCUT_BROKER_ENDPOINT: endpoint,
    AUTOCUT_BROKER_TOKEN: 'test-token',
    AUTOCUT_HEADLESS_URL: `http://127.0.0.1:${harness.address().port}/headless.html`,
  }
  const first = JSON.parse((await execFileAsync(process.execPath, argv, { env })).stdout)
  const replay = JSON.parse((await execFileAsync(process.execPath, argv, { env })).stdout)
  assert.equal(first.idempotency.replayed, false)
  assert.equal(replay.idempotency.replayed, true)
  assert.equal(replay.revision, first.revision)
  assert.equal(replay.project.timeline.items.length, 1)
  assert.equal(calls.filter((operation) => operation === 'editProject').length, 1)
  assert.equal(calls.filter((operation) => operation === 'normalizeProject').length, 1)
})

test('audit CLI preserves full structured failure on stdout and exits nonzero', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'autocut-audit-result-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const created = await createProjectResource(workspace, {
    id: 'audit-demo',
    name: 'Audit',
    metadata: { fps: 30 },
    timeline: {
      tracks: [{ id: 'main', kind: 'video' }],
      items: [
        { id: 'first', type: 'video', trackId: 'main', from: 0, durationInFrames: 30 },
        { id: 'second', type: 'video', trackId: 'main', from: 60, durationInFrames: 30 },
      ],
    },
  })
  const argv = ['project', 'audit', '--workspace', workspace, '--id', 'audit-demo']
  const result = await run(argv)
  assert.equal(result.ok, false)
  assert.equal(result.audit.ok, result.ok)
  assert.equal(result.audit.revision, created.revision)
  assert.equal(result.error.code, 'PROJECT_AUDIT_FAILED')
  await assert.rejects(
    execFileAsync(process.execPath, [path.join(import.meta.dirname, 'agent.mjs'), ...argv]),
    (error) => {
      assert.equal(error.code, 1)
      assert.equal(error.stderr, '')
      const output = JSON.parse(error.stdout)
      assert.equal(output.executionStatus, 'completed')
      assert.equal(output.audit.issues[0].code, 'timeline_gap')
      return true
    },
  )
})

test('audit Host receipt records rule failure rather than successful execution as successful audit', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'autocut-audit-receipt-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\autocut-audit-${process.pid}-${Date.now()}`
      : path.join(workspace, 'broker.sock')
  const receipts = []
  const server = await listenJsonLineServer(endpoint, (request) => {
    receipts.push(request.payload)
    return {}
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await createProjectResource(workspace, {
    id: 'audit-demo',
    timeline: {
      tracks: [{ id: 'main', kind: 'video' }],
      items: [
        { id: 'a', type: 'video', trackId: 'main', from: 0, durationInFrames: 30 },
        { id: 'b', type: 'video', trackId: 'main', from: 45, durationInFrames: 30 },
      ],
    },
  })
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        path.join(import.meta.dirname, 'agent.mjs'),
        'project',
        'audit',
        '--workspace',
        workspace,
        '--id',
        'audit-demo',
      ],
      {
        env: {
          ...process.env,
          AUTOCUT_BROKER_ENDPOINT: endpoint,
          AUTOCUT_BROKER_TOKEN: 'test-token',
        },
      },
    ),
    (error) => error.code === 1,
  )
  assert.deepEqual(
    receipts.map((entry) => entry.status),
    ['started', 'failed'],
  )
  assert.equal(receipts[1].error.code, 'PROJECT_AUDIT_FAILED')
  assert.equal(receipts[1].result.audit.status, 'failed')
  assert.equal(receipts[1].result.audit.readOnly, true)
})

test('every AutoCut Agent leaf command exposes help from the canonical contract', async () => {
  for (const contract of Object.values(AUTOCUT_AGENT_COMMAND_CONTRACTS)) {
    const result = await run([...contract.path, '--help'])
    assert.deepEqual(result.help.allowedOptions, contract.allowedOptions, contract.key)
    assert.deepEqual(result.help.requiredOptions, contract.requiredOptions, contract.key)
    assert.equal(result.help.canonicalCommand, contract.examples[0].command, contract.key)
    assert.deepEqual(commandHelp(contract).examples, contract.examples, contract.key)
  }

  const root = await run(['--help'])
  assert.ok(root.help.commands.includes('project'))
  assert.equal(root.help.commandDetails.length, Object.keys(AUTOCUT_AGENT_COMMAND_CONTRACTS).length)
  assert.ok(
    root.help.examples.some((example) => example.command === 'remotion-render --task <task.json>'),
  )
  const project = await run(['project', '--help'])
  assert.ok(project.help.commands.includes('project edit'))
  const media = await run(['media', '--help'])
  assert.ok(media.help.commands.includes('media import'))
})

test('help command and common help aliases resolve to the same detailed contract', async () => {
  const root = await run(['help'])
  assert.ok(root.help.commandDetails.some((entry) => entry.command === 'remotion-render'))
  assert.deepEqual(await run(['-h']), root)

  for (const argv of [
    ['help', 'remotion-render'],
    ['remotion-render', 'help'],
    ['remotion-render', '-h'],
  ]) {
    const result = await run(argv)
    assert.equal(result.help.command, 'remotion-render')
    assert.equal(result.help.requiredOptions[0], '--task')
    assert.equal(result.help.canonicalCommand, 'remotion-render --task <task.json>')
  }

  const projectEdit = await run(['help', 'project', 'edit'])
  assert.equal(projectEdit.help.command, 'project edit')
  assert.match(projectEdit.help.canonicalCommand, /--expected-revision/)
})

test('help aliases do not consume option values named help', () => {
  assert.deepEqual(normalizeCommandArgv(['project', 'create', '--name', 'help']), [
    'project',
    'create',
    '--name',
    'help',
  ])
  assert.deepEqual(normalizeCommandArgv(['render', '--project', 'help']), [
    'render',
    '--project',
    'help',
  ])
})

test('every required option failure includes examples for its own command', async () => {
  for (const contract of Object.values(AUTOCUT_AGENT_COMMAND_CONTRACTS)) {
    if (contract.requiredOptions.length === 0) continue
    await assert.rejects(run(contract.path), (error) => {
      assert.equal(error.code, 'CLI_USAGE_ERROR', contract.key)
      assert.equal(error.details.command, contract.key, contract.key)
      assert.equal(error.details.usage.command, contract.key, contract.key)
      assert.equal(error.details.usage.canonicalCommand, contract.examples[0].command, contract.key)
      assert.ok(error.details.correctExamples.length > 0, contract.key)
      assert.equal(
        error.details.correctExamples[0].command,
        contract.examples[0].command,
        contract.key,
      )
      return true
    })
  }
})

test('unknown commands and options return scoped suggestions instead of project edit fallback', async () => {
  await assert.rejects(run(['project', 'wat']), (error) => {
    assert.equal(error.code, 'CLI_USAGE_ERROR')
    assert.ok(error.details.allowedCommands.includes('project get'))
    assert.ok(error.details.usage.commandDetails.some((entry) => entry.command === 'project edit'))
    assert.ok(error.details.correctExamples.every((example) => example.command))
    return true
  })

  for (const [argv, expectedCommand, expectedOption] of [
    [['project', 'create', '--nam'], 'project create', '--name'],
    [['media', 'import', '--files'], 'media import', '--file'],
    [['render', '--projec'], 'render', '--project'],
    [['remotion-render', '--tasks'], 'remotion-render', '--task'],
  ]) {
    await assert.rejects(run(argv), (error) => {
      assert.equal(error.code, 'CLI_USAGE_ERROR')
      assert.equal(error.details.command, expectedCommand)
      assert.ok(error.details.allowedOptions.includes(expectedOption))
      assert.match(error.details.suggestion, new RegExp(expectedOption))
      assert.equal(
        error.details.correctExamples.some((example) => /project edit/.test(example.command)),
        false,
      )
      return true
    })
  }
})

test('command validation errors are self-correcting without a schema lookup', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'autocut-command-contract-'))
  const operations = path.join(workspace, 'invalid-operations.json')
  await writeFile(
    operations,
    JSON.stringify([
      {
        callerId: 'overlayTrack',
        op: 'addTrack',
        trackKind: 'video',
      },
    ]),
  )
  try {
    await assert.rejects(
      run(['project', 'audit', '--workspace', workspace, '--id', 'demo', '--mode', 'unknown']),
      (error) => {
        assert.equal(error.code, 'CLI_USAGE_ERROR')
        assert.equal(error.details.command, 'project audit')
        assert.match(error.details.correctExamples[0].command, /--mode remix/)
        return true
      },
    )

    await assert.rejects(
      run(['project', 'get', '--workspace', workspace, '--id', 'missing']),
      (error) => {
        assert.equal(error.code, 'PROJECT_NOT_FOUND')
        assert.equal(error.details.command, 'project get')
        assert.equal(error.details.correctExamples[0].command, 'autocut-agent project list')
        return true
      },
    )

    await assert.rejects(
      run(['project', 'edit', '--workspace', workspace, '--id', 'demo', '--ops', operations]),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR')
        assert.equal(error.details.command, 'project edit')
        assert.equal(error.details.persisted, false)
        assert.equal(error.details.projectUnchanged, true)
        assert.equal(error.details.correctExamples[0].ops[0].op, 'addTrack')
        assert.equal(error.details.correctExamples[0].ops[0].kind, 'video')
        assert.ok(
          error.fields.some(
            (field) =>
              field.path === 'ops.0.trackKind' &&
              field.message.includes('use "kind" instead of "trackKind"'),
          ),
        )
        return true
      },
    )

    await assert.rejects(
      run(['render', '--workspace', workspace, '--project', 'demo', '--out', '../outside.mp4']),
      (error) => {
        assert.equal(error.code, 'CLI_USAGE_ERROR')
        assert.equal(error.details.command, 'render')
        assert.match(error.details.correctExamples[0].command, /projects\/<project-id>\/renders/)
        return true
      },
    )

    await assert.rejects(
      run(['render', '--workspace', workspace, '--project', 'demo', '--preset', 'fastest']),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR')
        assert.equal(error.details.command, 'render')
        assert.ok(error.fields.some((field) => field.path === 'preset'))
        assert.match(error.details.correctExamples[0].command, /--preset draft/)
        return true
      },
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('correct examples are capped and explicitly marked when truncated', () => {
  const contract = AUTOCUT_AGENT_COMMAND_CONTRACTS['project edit']
  const extras = Array.from({ length: 10 }, (_, index) => ({
    description: `Example ${index}`,
    command: `autocut-agent project get --id demo-${index}`,
  }))
  const result = correctExamples(contract, extras)
  assert.equal(result.correctExamples.length, 8)
  assert.equal(result.correctExamplesTruncated, true)
})

test('the executable serializes command-scoped correction examples in one error result', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(import.meta.dirname, 'agent.mjs'),
      'media',
      'import',
    ]),
    (error) => {
      const payload = JSON.parse(error.stderr)
      assert.equal(payload.error.code, 'CLI_USAGE_ERROR')
      assert.equal(payload.error.command, 'media import')
      assert.equal(payload.error.usage.command, 'media import')
      assert.match(payload.error.correctExamples[0].command, /media import --file/)
      assert.equal(
        payload.error.correctExamples.some((example) => /project edit/.test(example.command)),
        false,
      )
      return true
    },
  )
})

test('the executable returns detailed remotion-render help without requiring a workspace', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    path.join(import.meta.dirname, 'remotion-render.mjs'),
    '--help',
  ])
  const payload = JSON.parse(stdout)
  assert.equal(stderr, '')
  assert.equal(payload.ok, true)
  assert.equal(payload.help.command, 'remotion-render')
  assert.deepEqual(payload.help.requiredOptions, ['--task'])
  assert.equal(payload.help.canonicalCommand, 'remotion-render --task <task.json>')
})
