#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from './lib/cli.mjs'
import {
  commandHelp,
  correctExamples,
  normalizeCommandArgv,
  optionNames,
  resolveCommand,
} from './lib/agent-command-contracts.mjs'
import {
  assertAutoCutWorkspace,
  withAutoCutBrowserSession,
} from './lib/autocut-browser-session.mjs'
import { runAgentCli } from './lib/agent-cli.mjs'
import {
  capabilities,
  compactCapabilities,
  EDIT_OPERATION_EXAMPLES,
  HEADLESS_API_VERSION,
  projectCreateRequestSchema,
  projectSaveRequestSchema,
  projectUpdateRequestSchema,
  lifecycleEditRequestSchema,
  mediaProbeRequestSchema,
  normalizeRenderInput,
  renderRequestSchema,
  validate,
} from './lib/contract.mjs'
import { prepareJob, renderJob } from './lib/render-core.mjs'
import { renderRemotionTask } from './lib/remotion-renderer.mjs'
import { collectAddClipMedia, resolveMediaFile } from './lib/workspace.mjs'
import {
  acquireWriterLock,
  assertAtomicReplace,
  commitStagedMedia,
  createProjectResource,
  getMediaResource,
  getProjectResource,
  listMediaResources,
  listProjectResources,
  rollbackStagedMedia,
  saveProjectResource,
  stageLocalMedia,
  updateMediaMetadata,
} from './lib/lifecycle-store.mjs'
import { isMainModule } from './lib/main-module.mjs'
import { auditRemixProject } from './lib/project-audit.mjs'

const envelope = (value) => ({ ok: true, apiVersion: HEADLESS_API_VERSION, ...value })
const number = (value) => (value === undefined ? undefined : Number(value))
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  } catch (cause) {
    const error = new Error(`Unable to read valid JSON from ${file}`)
    error.code = 'VALIDATION_ERROR'
    error.fields = [
      {
        path: file,
        message: cause instanceof Error ? cause.message : String(cause),
        code: 'invalid_json_file',
      },
    ]
    throw error
  }
}

async function withWriter(workspace, args, operation) {
  if (args['break-lock'])
    console.error('Attempting explicit recovery of a confirmed-dead workspace writer lock')
  const release = await acquireWriterLock(workspace, { breakLock: Boolean(args['break-lock']) })
  try {
    await assertAtomicReplace(workspace)
    return await operation()
  } finally {
    await release()
  }
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
  const commandArgv = normalizeCommandArgv(argv)
  const resolved = resolveCommand(commandArgv)
  if (resolved.kind === 'help') return envelope({ help: resolved.help })
  if (resolved.kind === 'unknown') throw unknownCommandUsageError(resolved)
  const contract = resolved.contract
  let args
  try {
    args = parseCliArgs(commandArgv, contract)
    assertCommandArgs(args, contract)
  } catch (error) {
    throw contextualizeCommandError(error, contract)
  }
  try {
    return await runCommand(args, dependencies, contract)
  } catch (error) {
    throw contextualizeCommandError(error, contract, args)
  }
}

async function runCommand(args, dependencies, contract) {
  const [group, action] = args._
  if (args.help) return envelope({ help: commandSpecificHelp(contract) })
  if (group === 'capabilities')
    return envelope(args.compact ? compactCapabilities() : capabilities())
  const workspace = path.resolve(args.workspace ?? process.env.AUTOCUT_WORKSPACE ?? '.')
  if (!fs.existsSync(workspace)) {
    const error = new Error(`Workspace not found: ${workspace}`)
    error.code = 'PREREQUISITE_ERROR'
    error.details = {
      nextActions: [
        'Select or create a Desktop project so the Host can inject its AutoCut workspace.',
      ],
    }
    throw error
  }
  assertAutoCutWorkspace(workspace)
  if (group === 'editor-url') return envelope(createEditorUrl(args))

  if (group === 'project' && action === 'list')
    return envelope({ projects: await listProjectResources(workspace), nextCursor: null })
  if (group === 'project' && action === 'get')
    return envelope(await getProjectResource(workspace, args.id))
  if (group === 'project' && action === 'audit') {
    if ((args.mode ?? 'remix') !== 'remix')
      throw commandUsageError(contract, '--mode must be remix', [
        { path: '--mode', message: 'must equal remix', code: 'invalid_value' },
      ])
    const current = await getProjectResource(workspace, args.id)
    return envelope({
      revision: current.revision,
      audit: auditRemixProject(current.project, {
        ...(args['track-id'] ? { trackId: args['track-id'] } : {}),
      }),
    })
  }
  if (group === 'media' && action === 'list')
    return envelope({ media: await listMediaResources(workspace) })
  if (group === 'media' && action === 'get')
    return envelope(await getMediaResource(workspace, args.id))
  if (group === 'remotion-render') {
    const taskPath = path.resolve(args.task)
    if (path.basename(taskPath) !== 'task.json') {
      throw commandUsageError(contract, '--task must reference a task.json file', [
        {
          path: '--task',
          message: 'must reference a task.json file',
          code: 'invalid_value',
        },
      ])
    }
    const renderTask = dependencies.renderRemotionTask ?? renderRemotionTask
    return envelope(
      await renderTask({
        workspaceDirectory: workspace,
        taskDirectory: path.dirname(taskPath),
      }),
    )
  }
  if (group === 'render') {
    const outputPath = args.out
      ? path.resolve(workspace, args.out)
      : path.join(workspace, 'exports', `${args.project}-render`)
    assertContainedOutput(workspace, outputPath, contract)
    const renderInput = validate(
      renderRequestSchema,
      normalizeRenderInput({
        project: args.project,
        out: outputPath,
        ...(args.codec ? { codec: args.codec } : {}),
        ...(args.container ? { container: args.container } : {}),
        ...(args.resolution ? { resolution: args.resolution } : {}),
        ...(args.fps ? { fps: args.fps } : {}),
        ...(args.quality ? { quality: args.quality } : {}),
        preset: args.preset ?? 'balanced',
        ...(args.duration ? { duration: args.duration } : {}),
        ...(args.in ? { in: args.in } : {}),
        ...(args['out-sec'] ? { 'out-sec': args['out-sec'] } : {}),
        ...(args['audio-only'] ? { 'audio-only': true } : {}),
      }),
    )
    return withAutoCutBrowserSession({ workspace, args }, async (page, mediaUrlOf) => {
      const job = prepareJob(workspace, renderInput, mediaUrlOf)
      assertContainedOutput(workspace, job.outPath, contract)
      const summary = await renderJob(page, job, {
        allowMissingMedia: Boolean(args['allow-missing-media']),
        downloadTimeoutMs: 0,
      })
      return envelope(summary)
    })
  }

  return withWriter(workspace, args, async () => {
    if (group === 'project' && action === 'create') {
      const input = validate(projectCreateRequestSchema, {
        ...(args.id ? { id: args.id } : {}),
        name: args.name,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.width ? { width: number(args.width) } : {}),
        ...(args.height ? { height: number(args.height) } : {}),
        ...(args.fps ? { fps: number(args.fps) } : {}),
        ...(args['background-color'] ? { backgroundColor: args['background-color'] } : {}),
      })
      const project = await withAutoCutBrowserSession({ workspace, args }, (page) =>
        page.evaluate((value) => window.autocut.createProject(value), input),
      )
      return envelope(await createProjectResource(workspace, project))
    }
    if (group === 'project' && action === 'save') {
      const body = validate(projectSaveRequestSchema, {
        project: readJson(args.file),
        expectedRevision: args['expected-revision'],
        force: Boolean(args.force),
      })
      if (body.project.id !== undefined && body.project.id !== args.id)
        throw commandUsageError(contract, 'Project body id must equal --id', [
          {
            path: 'project.id',
            message: 'must equal --id',
            code: 'invalid_value',
          },
        ])
      const project = await withAutoCutBrowserSession({ workspace, args }, (page) =>
        page.evaluate((value) => window.autocut.normalizeProject(value), {
          ...body.project,
          id: args.id,
        }),
      )
      return envelope(await saveProjectResource(workspace, args.id, project, body))
    }
    if (group === 'project' && action === 'update') {
      const body = validate(projectUpdateRequestSchema, {
        updates: {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.width ? { width: number(args.width) } : {}),
          ...(args.height ? { height: number(args.height) } : {}),
          ...(args.fps ? { fps: number(args.fps) } : {}),
          ...(args['background-color'] ? { backgroundColor: args['background-color'] } : {}),
        },
        expectedRevision: args['expected-revision'],
        force: Boolean(args.force),
      })
      const current = await getProjectResource(workspace, args.id)
      const next = {
        ...current.project,
        ...body.updates,
        metadata: {
          ...current.project.metadata,
          ...(body.updates.width !== undefined ? { width: body.updates.width } : {}),
          ...(body.updates.height !== undefined ? { height: body.updates.height } : {}),
          ...(body.updates.fps !== undefined ? { fps: body.updates.fps } : {}),
          ...(body.updates.backgroundColor !== undefined
            ? { backgroundColor: body.updates.backgroundColor }
            : {}),
        },
      }
      delete next.width
      delete next.height
      delete next.fps
      delete next.backgroundColor
      const project = await withAutoCutBrowserSession({ workspace, args }, (page) =>
        page.evaluate((value) => window.autocut.normalizeProject(value), next),
      )
      return envelope(await saveProjectResource(workspace, args.id, project, body))
    }
    if (group === 'project' && action === 'edit') {
      const body = validate(lifecycleEditRequestSchema, {
        ops: readJson(args.ops),
        persist: Boolean(args.persist),
        expectedRevision: args['expected-revision'],
        force: Boolean(args.force),
      })
      const current = await getProjectResource(workspace, args.id)
      const result = await withAutoCutBrowserSession({ workspace, args }, async (page) => {
        const edited = await page.evaluate((payload) => window.autocut.editProject(payload), {
          project: current.project,
          ops: body.ops,
          media: collectAddClipMedia(workspace, body.ops),
        })
        if (edited?.ok === false) throw projectEditFailure(edited, current.revision)
        if (!body.persist) return edited
        return {
          ...edited,
          project: await page.evaluate(
            (value) => window.autocut.normalizeProject(value),
            edited.project,
          ),
        }
      })
      if (!body.persist)
        return envelope({ ...result, persisted: false, baseRevision: current.revision })
      const saved = await saveProjectResource(workspace, args.id, result.project, body)
      return envelope({
        ...result,
        project: saved.project,
        persisted: true,
        revision: saved.revision,
        warnings: saved.warnings,
      })
    }
    if (group === 'media' && action === 'probe') {
      const body = validate(mediaProbeRequestSchema, {
        persist: Boolean(args.persist),
        expectedRevision: args['expected-revision'],
        force: Boolean(args.force),
      })
      const current = await getMediaResource(workspace, args.id)
      const source = resolveMediaFile(workspace, args.id)
      if (!source) {
        const error = new Error('Media source file is missing')
        error.code = 'PREREQUISITE_ERROR'
        error.details = {
          nextActions: [
            `Run autocut-agent media get --id ${args.id} to inspect the media resource.`,
            'Re-import the original source file if it is no longer present.',
          ],
        }
        throw error
      }
      const probe = await withAutoCutBrowserSession({ workspace, args }, (page, mediaUrlOf) =>
        page.evaluate((payload) => window.autocut.probeMedia(payload), {
          url: mediaUrlOf(args.id),
          fileName: path.basename(source),
          mimeType: current.metadata.mimeType,
        }),
      )
      if (!body.persist) return envelope({ mediaId: args.id, probe, persisted: false })
      const saved = await updateMediaMetadata(workspace, args.id, probe, body)
      return envelope({ mediaId: args.id, probe, persisted: true, revision: saved.revision })
    }
    if (group === 'media' && action === 'import') {
      let staged
      try {
        staged = await stageLocalMedia(workspace, args.file, args.id)
        const probe = await withAutoCutBrowserSession({ workspace, args }, (page, mediaUrlOf) =>
          page.evaluate((payload) => window.autocut.probeMedia(payload), {
            url: mediaUrlOf(staged.id),
            fileName: path.basename(staged.target),
            mimeType: staged.mimeType,
          }),
        )
        const media = await commitStagedMedia(staged, probe, { workspace, projectId: args.project })
        return envelope({
          media,
          duplicate: false,
          ...(args.project ? { associatedProjectId: args.project } : {}),
        })
      } catch (error) {
        if (staged) await rollbackStagedMedia(staged)
        throw error
      }
    }
    throw commandUsageError(contract, `Unknown command: ${group} ${action}`)
  })
}

function parseCliArgs(argv, contract) {
  try {
    return parseArgs(argv, { allowed: optionNames(contract) })
  } catch (error) {
    const match = /^Unknown option: (--[^\s]+)$/.exec(error instanceof Error ? error.message : '')
    if (!match) throw error
    const option = match[1]
    const suggestion = suggestOption(option, contract.allowedOptions)
    throw commandUsageError(
      contract,
      `Unknown option: ${option}`,
      [{ path: option, message: 'option is not allowed', code: 'unknown_option' }],
      {
        suggestion: suggestion ? `Use ${suggestion} instead of ${option}.` : contract.summary,
      },
    )
  }
}

function assertCommandArgs(args, contract) {
  if (
    args._.length !== contract.path.length ||
    !contract.path.every((part, index) => args._[index] === part)
  ) {
    throw commandUsageError(contract, `${contract.key} does not accept positional arguments`, [
      { path: '$', message: 'unexpected positional argument', code: 'unexpected_argument' },
    ])
  }
  if (args.help) return
  for (const required of contract.requiredOptions) {
    const key = required.slice(2)
    if (typeof args[key] !== 'string' || args[key].trim() === '') {
      throw commandUsageError(contract, `${required} is required`, [
        { path: required, message: 'option is required', code: 'required' },
      ])
    }
  }
  for (const option of contract.allowedOptions) {
    const key = option.slice(2)
    if (
      args[key] !== undefined &&
      !contract.booleanOptions.includes(option) &&
      typeof args[key] !== 'string'
    ) {
      throw commandUsageError(contract, `${option} requires a value`, [
        { path: option, message: 'option requires a value', code: 'invalid_type' },
      ])
    }
  }
}

function commandSpecificHelp(contract) {
  const help = commandHelp(contract)
  if (contract.key === 'project edit') {
    return {
      ...help,
      authoritativeItemIds: 'project.timeline.items[].id',
      resultReferenceExample: { $ref: 'addClipA#/detail/id' },
    }
  }
  if (contract.key === 'remotion-render') {
    return {
      ...help,
      taskLayout: 'projects/<project-or-assets>/remotion/<task-id>/task.json',
    }
  }
  return help
}

function unknownCommandUsageError(resolved) {
  const suggestion = suggestOption(resolved.command, resolved.candidates)
  return new CliUsageError(`Unknown command: ${resolved.command}`, {
    fields: [
      {
        path: resolved.command,
        message: 'command is not available',
        code: 'unknown_command',
      },
    ],
    command: resolved.help.command,
    allowedCommands: resolved.candidates,
    usage: resolved.help,
    ...correctExamplesFromHelp(resolved.help),
    ...(suggestion ? { suggestion: `Use ${suggestion} instead.` } : {}),
  })
}

function commandUsageError(contract, message, fields = [], details = {}) {
  return new CliUsageError(message, {
    fields,
    command: contract.key,
    allowedOptions: contract.allowedOptions,
    canonicalCommand: contract.examples[0].command,
    usage: commandSpecificHelp(contract),
    ...correctExamples(contract),
    ...(contract.key === 'project edit' ? { persisted: false, projectUnchanged: true } : {}),
    ...details,
  })
}

function contextualizeCommandError(error, contract, args) {
  if (!(error instanceof Error)) return error
  if (error instanceof CliUsageError && error.details?.correctExamples) return error
  const operationExamples =
    contract.key === 'project edit' ? projectEditCorrectionExamples(error, args) : []
  const revisionExamples =
    error.code === 'REVISION_CONFLICT' && args?.id
      ? [
          {
            description: 'Read the current resource revision before retrying.',
            command:
              contract.key === 'media probe'
                ? `autocut-agent media get --id ${args.id}`
                : `autocut-agent project get --id ${args.id}`,
          },
        ]
      : []
  const resourceExamples =
    error.code === 'PROJECT_NOT_FOUND'
      ? [{ description: 'List available project IDs.', command: 'autocut-agent project list' }]
      : error.code === 'MEDIA_NOT_FOUND' || error.code === 'MISSING_MEDIA'
        ? [{ description: 'List available media IDs.', command: 'autocut-agent media list' }]
        : []
  const context = {
    command: contract.key,
    allowedOptions: contract.allowedOptions,
    canonicalCommand: contract.examples[0].command,
    usage: commandSpecificHelp(contract),
    ...correctExamples(contract, [...operationExamples, ...revisionExamples, ...resourceExamples]),
    ...(contract.key === 'project edit' ? { persisted: false, projectUnchanged: true } : {}),
  }
  error.details = {
    ...(error.details && typeof error.details === 'object' ? error.details : {}),
    ...(error.expectedRevision ? { expectedRevision: error.expectedRevision } : {}),
    ...(error.actualRevision ? { actualRevision: error.actualRevision } : {}),
    ...context,
  }
  return error
}

function projectEditCorrectionExamples(error, args) {
  const fields = Array.isArray(error.fields) ? error.fields : []
  const operationIndex =
    error.details?.operationIndex ??
    fields.map((field) => /^ops\.(\d+)/.exec(field.path)?.[1]).find((value) => value !== undefined)
  if (operationIndex === undefined || !args?.ops) return []
  let operations
  try {
    operations = readJson(args.ops)
  } catch {
    return []
  }
  const operation = Array.isArray(operations) ? operations[Number(operationIndex)] : undefined
  if (!operation || typeof operation !== 'object') return []
  const op = typeof operation.op === 'string' ? operation.op : error.details?.operation
  if (!op) return []
  const example = EDIT_OPERATION_EXAMPLES[op]
  if (!example) return []
  return [
    {
      description: `Valid ${op} operation shape.`,
      ops: [{ callerId: `${op}Example`, ...example }],
    },
  ]
}

function correctExamplesFromHelp(help) {
  const examples = Array.isArray(help.examples) ? help.examples : []
  return {
    correctExamples: examples.slice(0, 8),
    ...(examples.length > 8 ? { correctExamplesTruncated: true } : {}),
  }
}

class CliUsageError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'CliUsageError'
    this.code = 'CLI_USAGE_ERROR'
    this.fields = details.fields
    this.details = details
  }
}

function projectEditFailure(result, baseRevision) {
  const details = {
    operationIndex: result.error?.operationIndex,
    ...(result.error?.callerId ? { callerId: result.error.callerId } : {}),
    ...(result.error?.op ? { operation: result.error.op } : {}),
    baseRevision,
    persisted: false,
    projectUnchanged: true,
  }
  const error = new Error(result.error?.message ?? 'AutoCut project edit failed')
  error.code = result.error?.code ?? 'EDIT_OPERATION_FAILED'
  error.fields = [
    {
      path: Number.isInteger(details.operationIndex) ? `ops.${details.operationIndex}` : 'ops',
      message: error.message,
      code: error.code,
    },
  ]
  error.details = details
  return error
}

function suggestOption(option, allowedOptions) {
  let best
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of allowedOptions) {
    const distance = editDistance(option, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return bestDistance <= Math.max(2, Math.floor(option.length / 3)) ? best : undefined
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let previous = row[0]
    row[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const current = row[rightIndex]
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
      previous = current
    }
  }
  return row[right.length]
}

function assertContainedOutput(workspace, outputPath, contract) {
  const relative = path.relative(path.resolve(workspace), path.resolve(outputPath))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw commandUsageError(
      contract,
      'AutoCut render output must stay inside the project autocut workspace',
      [{ path: '--out', message: 'must stay inside the workspace', code: 'invalid_path' }],
    )
  }
}

function createEditorUrl(args, env = process.env) {
  const editorUrl = env.AUTOCUT_EDITOR_URL?.trim()
  const projectToken = env.AUTOCUT_PROJECT_TOKEN?.trim()
  if (!editorUrl || !projectToken) {
    const missing = !editorUrl ? 'AUTOCUT_EDITOR_URL' : 'AUTOCUT_PROJECT_TOKEN'
    const error = new Error(`${missing} is required`)
    error.code = 'PREREQUISITE_ERROR'
    error.details = {
      nextActions: [
        'Open the AutoCut extension panel and choose 下载并验证, then retry this command.',
      ],
    }
    throw error
  }
  const url = new URL(args.id ? `/editor/${encodeURIComponent(args.id)}` : '/projects', editorUrl)
  url.searchParams.set('autocutProjectToken', projectToken)
  return { url: url.toString() }
}

if (isMainModule(import.meta.url)) {
  await runAgentCli(run)
}

export { createEditorUrl, run }
