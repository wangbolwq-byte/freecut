#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from './lib/cli.mjs'
import {
  assertAutoCutWorkspace,
  withAutoCutBrowserSession,
} from './lib/autocut-browser-session.mjs'
import {
  capabilities,
  HEADLESS_API_VERSION,
  projectCreateRequestSchema,
  projectSaveRequestSchema,
  projectUpdateRequestSchema,
  lifecycleEditRequestSchema,
  mediaProbeRequestSchema,
  validate,
} from './lib/contract.mjs'
import { prepareJob, renderJob } from './lib/render-core.mjs'
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

const OPTIONS = new Set([
  'workspace',
  'json',
  'id',
  'name',
  'description',
  'width',
  'height',
  'fps',
  'background-color',
  'file',
  'ops',
  'persist',
  'expected-revision',
  'force',
  'project',
  'build',
  'harness-url',
  'head',
  'break-lock',
  'out',
  'codec',
  'container',
  'resolution',
  'quality',
  'preset',
  'duration',
  'in',
  'out-sec',
  'audio-only',
  'allow-missing-media',
  'mode',
  'track-id',
])

const envelope = (value) => ({ ok: true, apiVersion: HEADLESS_API_VERSION, ...value })
const number = (value) => (value === undefined ? undefined : Number(value))
const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))

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

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { allowed: OPTIONS })
  const [group, action] = args._
  const workspace = path.resolve(args.workspace ?? process.env.AUTOCUT_WORKSPACE ?? '.')
  if (!fs.existsSync(workspace)) throw new Error(`Workspace not found: ${workspace}`)
  assertAutoCutWorkspace(workspace)
  if (group === 'capabilities') return envelope(capabilities())
  if (group === 'editor-url') return envelope(createEditorUrl(args))
  if (!action && group !== 'render')
    throw new Error('Expected a command such as project list or media import')

  if (group === 'project' && action === 'list')
    return envelope({ projects: await listProjectResources(workspace), nextCursor: null })
  if (group === 'project' && action === 'get')
    return envelope(await getProjectResource(workspace, args.id))
  if (group === 'project' && action === 'audit') {
    if (!args.id) throw new Error('--id is required')
    if ((args.mode ?? 'remix') !== 'remix') throw new Error('--mode must be remix')
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
  if (group === 'render') {
    if (!args.project) throw new Error('--project is required')
    return withAutoCutBrowserSession({ workspace, args }, async (page, mediaUrlOf) => {
      const outputPath = args.out
        ? path.resolve(workspace, args.out)
        : path.join(workspace, 'exports', `${args.project}-render`)
      const job = prepareJob(
        workspace,
        {
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
        },
        mediaUrlOf,
      )
      assertContainedOutput(workspace, job.outPath)
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
      if (!args.file) throw new Error('--file is required')
      const body = validate(projectSaveRequestSchema, {
        project: readJson(args.file),
        expectedRevision: args['expected-revision'],
        force: Boolean(args.force),
      })
      if (body.project.id !== undefined && body.project.id !== args.id)
        throw new Error('Project body id must equal --id')
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
      if (!args.ops) throw new Error('--ops is required')
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
      if (!source) throw new Error('Media source file is missing')
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
      if (!args.file) throw new Error('--file is required')
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
    throw new Error(`Unknown command: ${group} ${action}`)
  })
}

function assertContainedOutput(workspace, outputPath) {
  const relative = path.relative(path.resolve(workspace), path.resolve(outputPath))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('AutoCut render output must stay inside the project autocut workspace')
  }
}

function createEditorUrl(args, env = process.env) {
  const editorUrl = env.AUTOCUT_EDITOR_URL?.trim()
  const projectToken = env.AUTOCUT_PROJECT_TOKEN?.trim()
  if (!editorUrl) throw new Error('AUTOCUT_EDITOR_URL is required')
  if (!projectToken) throw new Error('AUTOCUT_PROJECT_TOKEN is required')
  const url = new URL(args.id ? `/editor/${encodeURIComponent(args.id)}` : '/projects', editorUrl)
  url.searchParams.set('autocutProjectToken', projectToken)
  return { url: url.toString() }
}

if (isMainModule(import.meta.url)) {
  run()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          ok: false,
          apiVersion: HEADLESS_API_VERSION,
          error: {
            code: error.code ?? 'INTERNAL_ERROR',
            message: error.message,
            fields: error.fields ?? [],
          },
        }),
      )
      process.exitCode = 1
    })
}

export { createEditorUrl, run }
