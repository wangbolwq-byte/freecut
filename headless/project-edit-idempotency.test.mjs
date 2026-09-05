import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createProjectResource,
  editProjectResource,
  getProjectResource,
  saveProjectResource,
} from './lib/lifecycle-store.mjs'

async function fixture(t, id = 'demo') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'freecut-edit-replay-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const resource = await createProjectResource(workspace, {
    id,
    name: 'Demo',
    createdAt: 1,
    updatedAt: 1,
    metadata: { fps: 30 },
    timeline: { tracks: [], items: [] },
  })
  return { workspace, resource }
}

const ops = [{ callerId: 'titleA', op: 'addText', text: 'A', from: 0 }]
const request = (revision, changes = {}) => ({
  ops,
  persist: true,
  expectedRevision: revision,
  idempotencyKey: 'batch:one',
  ...changes,
})
const addTitle = (current) => ({
  ok: true,
  applied: 1,
  results: [{ callerId: 'titleA', detail: { id: 'title-1' } }],
  project: {
    ...current.project,
    timeline: {
      ...current.project.timeline,
      items: [...current.project.timeline.items, { id: 'title-1', text: 'A' }],
    },
  },
})
const mustNotEdit = () => assert.fail('A replay must not invoke the editor')

test('same batch replays its original result before revision checking without adding items', async (t) => {
  const { workspace, resource } = await fixture(t)
  const first = await editProjectResource(workspace, 'demo', request(resource.revision), addTitle)
  const replay = await editProjectResource(
    workspace,
    'demo',
    request(resource.revision, {
      ops: [{ from: 0, text: 'A', op: 'addText', callerId: 'titleA' }],
    }),
    mustNotEdit,
  )
  assert.equal(first.idempotency.protected, true)
  assert.equal(first.idempotency.replayed, false)
  assert.equal(replay.idempotency.replayed, true)
  assert.equal(replay.revision, first.revision)
  assert.equal(replay.baseRevision, resource.revision)
  assert.deepEqual(replay.results, first.results)
  assert.equal((await getProjectResource(workspace, 'demo')).project.timeline.items.length, 1)
})

test('replay after a newer edit reports both revisions and never reverts the project', async (t) => {
  const { workspace, resource } = await fixture(t)
  const first = await editProjectResource(workspace, 'demo', request(resource.revision), addTitle)
  const latest = await saveProjectResource(
    workspace,
    'demo',
    { ...first.project, name: 'Newer' },
    { expectedRevision: first.revision },
  )
  const replay = await editProjectResource(
    workspace,
    'demo',
    request(resource.revision),
    mustNotEdit,
  )
  assert.equal(replay.revision, first.revision)
  assert.equal(replay.currentRevision, latest.revision)
  assert.equal(replay.projectAdvanced, true)
  assert.equal((await getProjectResource(workspace, 'demo')).project.name, 'Newer')
})

test('same key with different operations conflicts even with force', async (t) => {
  const { workspace, resource } = await fixture(t)
  const first = await editProjectResource(workspace, 'demo', request(resource.revision), addTitle)
  await assert.rejects(
    editProjectResource(
      workspace,
      'demo',
      request(resource.revision, {
        force: true,
        ops: [{ ...ops[0], text: 'Different' }],
      }),
      mustNotEdit,
    ),
    (error) => error.code === 'IDEMPOTENCY_KEY_CONFLICT' && error.details.projectUnchanged,
  )
  assert.equal((await getProjectResource(workspace, 'demo')).revision, first.revision)
})

test('concurrent duplicate requests invoke the editor once', async (t) => {
  const { workspace, resource } = await fixture(t)
  let calls = 0
  const edit = (current) => {
    calls += 1
    return addTitle(current)
  }
  const [first, second] = await Promise.all([
    editProjectResource(workspace, 'demo', request(resource.revision), edit),
    editProjectResource(workspace, 'demo', request(resource.revision), edit),
  ])
  assert.equal(calls, 1)
  assert.equal(first.revision, second.revision)
  assert.equal(second.idempotency.replayed, true)
})

for (const interruption of ['afterPrepare', 'afterProjectCommit']) {
  test(`recover ${interruption} interruption without rerunning the editor`, async (t) => {
    const { workspace, resource } = await fixture(t)
    await assert.rejects(
      editProjectResource(workspace, 'demo', request(resource.revision), addTitle, {
        [interruption]: () => {
          throw new Error('simulated process interruption')
        },
      }),
      /simulated process interruption/,
    )
    const interrupted = await getProjectResource(workspace, 'demo')
    assert.equal(interrupted.revision === resource.revision, interruption === 'afterPrepare')
    const recovered = await editProjectResource(
      workspace,
      'demo',
      request(resource.revision),
      mustNotEdit,
    )
    assert.equal(recovered.idempotency.recovered, true)
    assert.equal(recovered.idempotency.replayed, true)
    assert.equal(recovered.project.timeline.items.length, 1)
    assert.equal((await getProjectResource(workspace, 'demo')).revision, recovered.revision)
    const replay = await editProjectResource(
      workspace,
      'demo',
      request(resource.revision),
      mustNotEdit,
    )
    assert.equal(replay.idempotency.recovered, false)
    assert.equal(replay.revision, recovered.revision)
  })
}

test('ambiguous prepared recovery stops safely even with force', async (t) => {
  const { workspace, resource } = await fixture(t)
  await assert.rejects(
    editProjectResource(workspace, 'demo', request(resource.revision), addTitle, {
      afterPrepare: () => {
        throw new Error('interrupt')
      },
    }),
  )
  const newer = await saveProjectResource(
    workspace,
    'demo',
    { ...resource.project, name: 'External change' },
    { expectedRevision: resource.revision },
  )
  await assert.rejects(
    editProjectResource(
      workspace,
      'demo',
      request(resource.revision, { force: true }),
      mustNotEdit,
    ),
    (error) => error.code === 'IDEMPOTENCY_RECOVERY_REQUIRED' && error.details.projectUnchanged,
  )
  assert.equal((await getProjectResource(workspace, 'demo')).revision, newer.revision)
})

test('a failed pre-persistence operation may retry, but its key cannot identify different operations', async (t) => {
  const { workspace, resource } = await fixture(t)
  await assert.rejects(
    editProjectResource(workspace, 'demo', request(resource.revision), () => {
      throw new Error('tool failed')
    }),
    /tool failed/,
  )
  assert.equal((await getProjectResource(workspace, 'demo')).revision, resource.revision)
  await assert.rejects(
    editProjectResource(
      workspace,
      'demo',
      request(resource.revision, { ops: [{ ...ops[0], text: 'Changed' }] }),
      mustNotEdit,
    ),
    (error) => error.code === 'IDEMPOTENCY_KEY_CONFLICT',
  )
  const retry = await editProjectResource(workspace, 'demo', request(resource.revision), addTitle)
  assert.equal(retry.project.timeline.items.length, 1)
})

test('idempotency is scoped by project and workspace, not globally by batch key', async (t) => {
  const first = await fixture(t)
  const second = await fixture(t)
  const secondProject = await createProjectResource(first.workspace, {
    ...first.resource.project,
    id: 'other',
  })
  for (const [workspace, resource] of [
    [first.workspace, first.resource],
    [second.workspace, second.resource],
    [first.workspace, secondProject],
  ]) {
    const result = await editProjectResource(
      workspace,
      resource.id,
      request(resource.revision),
      addTitle,
    )
    assert.equal(result.idempotency.replayed, false)
    assert.equal(result.project.timeline.items.length, 1)
  }
})

test('legacy edits explicitly report no replay protection and reject stale revision before editing', async (t) => {
  const { workspace, resource } = await fixture(t)
  const input = request(resource.revision, { idempotencyKey: undefined })
  const first = await editProjectResource(workspace, 'demo', input, addTitle)
  assert.deepEqual(first.idempotency, { protected: false, replayed: false })
  await assert.rejects(
    editProjectResource(workspace, 'demo', input, mustNotEdit),
    (error) => error.code === 'REVISION_CONFLICT',
  )
})

test('corrupted journal data cannot trigger an edit or overwrite the project', async (t) => {
  const { workspace, resource } = await fixture(t)
  const first = await editProjectResource(workspace, 'demo', request(resource.revision), addTitle)
  const dir = path.join(workspace, 'projects', 'demo', '.edit-receipts')
  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{broken')
  await assert.rejects(
    editProjectResource(workspace, 'demo', request(resource.revision), mustNotEdit),
    (error) => error.code === 'IDEMPOTENCY_RECOVERY_REQUIRED',
  )
  assert.equal((await getProjectResource(workspace, 'demo')).revision, first.revision)
})
