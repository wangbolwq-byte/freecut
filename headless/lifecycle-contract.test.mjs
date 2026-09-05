import test from 'node:test'
import assert from 'node:assert/strict'
import {
  capabilities,
  lifecycleEditRequestSchema,
  mediaProbeRequestSchema,
  projectCreateRequestSchema,
  projectSaveRequestSchema,
} from './lib/contract.mjs'

test('lifecycle project requests are strict and revision guarded', () => {
  assert.equal(
    projectCreateRequestSchema.safeParse({ name: 'Demo', surprise: true }).success,
    false,
  )
  const project = {
    id: 'demo',
    name: 'Demo',
    description: '',
    createdAt: 1,
    updatedAt: 1,
    duration: 0,
    schemaVersion: 14,
    metadata: { width: 1920, height: 1080, fps: 30 },
  }
  assert.equal(projectSaveRequestSchema.safeParse({ project, force: true }).success, true)
  assert.equal(projectSaveRequestSchema.safeParse({ project: {}, force: true }).success, false)
  assert.equal(
    projectSaveRequestSchema.safeParse({
      project: { ...project, rootFolderHandle: {} },
      force: true,
    }).success,
    false,
  )
  assert.equal(
    projectSaveRequestSchema.safeParse({ project: { ...project, surprise: true }, force: true })
      .success,
    false,
  )
  assert.equal(projectSaveRequestSchema.safeParse({ project: {} }).success, false)
  assert.equal(mediaProbeRequestSchema.safeParse({ persist: true }).success, false)
  assert.equal(mediaProbeRequestSchema.safeParse({ persist: true, force: true }).success, true)
})

test('lifecycle edits require unique caller ids and accept id references', () => {
  const valid = lifecycleEditRequestSchema.safeParse({
    ops: [
      { callerId: 'create', op: 'addText', text: 'hello', from: 0 },
      { callerId: 'move', op: 'moveItem', id: { $ref: 'create#/detail/created/0/id' }, from: 4 },
    ],
  })
  assert.equal(valid.success, true, JSON.stringify(valid.error?.issues))
  assert.equal(
    lifecycleEditRequestSchema.safeParse({
      ops: [
        { callerId: 'same', op: 'addText', text: 'a', from: 0 },
        { callerId: 'same', op: 'addText', text: 'b', from: 1 },
      ],
    }).success,
    false,
  )
  assert.equal(
    lifecycleEditRequestSchema.safeParse({
      ops: [{ callerId: 'bad', op: 'addText', text: 'a', from: 0, surprise: true }],
    }).success,
    false,
  )
  assert.equal(
    lifecycleEditRequestSchema.safeParse({
      ops: [
        {
          callerId: 'bad',
          op: 'addText',
          text: { $ref: 'later#/detail/id' },
          from: 0,
        },
        { callerId: 'later', op: 'addText', text: 'later', from: 1 },
      ],
    }).success,
    false,
  )
})

test('capabilities publish lifecycle constraints', () => {
  const result = capabilities()
  assert.equal(result.agentGuidance.sourceRangeClip, true)
  assert.equal(result.agentGuidance.projectAudit, true)
  assert.deepEqual(result.agentGuidance.lifecycleEdit, {
    opsFileRequired: true,
    callerIdRequiredPerOperation: true,
    callerIdPattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$',
    callerIdMustBeUnique: true,
    example: {
      callerId: 'addAcceptanceTitle',
      op: 'addText',
      text: 'AutoCut DEV acceptance',
      from: 540,
      durationInFrames: 90,
    },
  })
  assert.equal(result.lifecycle.httpMediaUpload, false)
  assert.equal(result.lifecycle.deleteProject, false)
  assert.equal(result.lifecycle.writerMode, 'exclusive')
  assert.ok(result.lifecycle.routes.includes('POST /v1/projects/:id/edit'))
})

test('idempotency keys are explicit, bounded, persisted-edit only and advertised', () => {
  const request = {
    ops: [{ callerId: 'title', op: 'addText', text: 'Title', from: 0 }],
    persist: true,
    force: true,
    idempotencyKey: 'scene-1:titles.v1',
  }
  assert.equal(lifecycleEditRequestSchema.safeParse(request).success, true)
  for (const idempotencyKey of ['', '../bad', 'a'.repeat(129)])
    assert.equal(
      lifecycleEditRequestSchema.safeParse({ ...request, idempotencyKey }).success,
      false,
    )
  assert.equal(lifecycleEditRequestSchema.safeParse({ ...request, persist: false }).success, false)
  assert.equal(capabilities().semantics.idempotency.forceBypassesConflict, false)
  assert.equal(capabilities().semantics.sourceTime.sourceStartUnit, 'source_frames')
})
