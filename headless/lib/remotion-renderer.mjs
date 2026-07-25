import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse as parseJavascript } from '@babel/parser'
import pngjs from 'pngjs'

const { PNG } = pngjs
const execFileAsync = promisify(execFile)
const RUNTIME_NODE_MODULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'node_modules',
)
const TASK_FILE = 'task.json'
const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json', '.css']
const CODE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs'])
const ALLOWED_EXTERNAL_IMPORTS = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'remotion',
])
const FORBIDDEN_SOURCE_PATTERNS = [
  [/\bfetch\s*\(/u, 'fetch'],
  [/\bXMLHttpRequest\b/u, 'XMLHttpRequest'],
  [/\bWebSocket\b/u, 'WebSocket'],
  [/\bEventSource\b/u, 'EventSource'],
  [/\bsendBeacon\s*\(/u, 'sendBeacon'],
  [/\brequire\s*\(/u, 'require'],
  [/\bprocess\s*\./u, 'process'],
  [/\beval\s*\(/u, 'eval'],
  [/\bnew\s+Function\b/u, 'Function'],
  [/\b(?:https?|wss?):\/\//u, 'remote URL'],
]
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

export class RemotionTaskError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'RemotionTaskError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export async function renderRemotionTask(input) {
  const taskDirectory = await resolveTaskDirectory(input)
  const task = await readTask(taskDirectory)
  const sourceInventory = await validateSourceTree(taskDirectory, task)
  const browserExecutable = await resolveBrowserExecutable(input.browserExecutable)
  const dependencies = input.dependencies ?? (await loadRemotionDependencies())
  const temporaryDirectory = await mkdtemp(path.join(taskDirectory, '.autocut-render-'))
  const temporaryOutput = path.join(
    temporaryDirectory,
    task.renderMode === 'composition' ? 'render.mp4' : 'render.webm',
  )
  const outputPath = resolveContained(
    taskDirectory,
    task.output,
    'REMOTION_OUTPUT_OUTSIDE_TASK',
    'Remotion output',
  )

  try {
    const entryPoint = await writePrivateEntry({
      temporaryDirectory,
      sourceEntry: resolveContained(
        taskDirectory,
        task.entryPoint,
        'REMOTION_SOURCE_OUTSIDE_TASK',
        'Remotion source entry',
      ),
      task,
    })
    const publicDirectory = path.join(taskDirectory, 'public')
    const serveUrl = await dependencies.bundle({
      entryPoint,
      outDir: path.join(temporaryDirectory, 'bundle'),
      publicDir: (await isDirectory(publicDirectory)) ? publicDirectory : null,
      rootDir: taskDirectory,
      enableCaching: false,
      webpackOverride: (configuration) => ({
        ...configuration,
        resolve: {
          ...configuration.resolve,
          modules: [
            RUNTIME_NODE_MODULES,
            ...(configuration.resolve?.modules ?? []).filter(
              (entry) => entry !== RUNTIME_NODE_MODULES,
            ),
          ],
        },
        module: {
          ...configuration.module,
          rules: (configuration.module?.rules ?? []).map(withControlledEsbuildOptions),
        },
      }),
      onSymlinkDetected: (symlink) => {
        throw taskError(
          'REMOTION_SYMLINK_FORBIDDEN',
          `Remotion public asset symlink is not allowed: ${String(symlink)}`,
        )
      },
    })
    await enforceOfflineBundle(serveUrl)
    const sharedBrowserOptions = {
      browserExecutable,
      inputProps: task.inputProps,
      envVariables: {},
      logLevel: 'error',
      timeoutInMilliseconds: input.timeoutInMilliseconds ?? 60_000,
    }
    const composition = await dependencies.selectComposition({
      serveUrl,
      id: task.composition.id,
      ...sharedBrowserOptions,
    })
    assertCompositionMatchesTask(composition, task.composition)

    const representativeFrames = await renderRepresentativeFrames({
      dependencies,
      composition,
      serveUrl,
      sharedBrowserOptions,
      temporaryDirectory,
      requireTransparency: task.renderMode === 'transparent-overlay',
    })
    const transparentOverlay = task.renderMode === 'transparent-overlay'
    const renderOptions = {
      composition,
      serveUrl,
      outputLocation: temporaryOutput,
      inputProps: task.inputProps,
      envVariables: {},
      codec: transparentOverlay ? 'vp9' : 'h264',
      imageFormat: transparentOverlay ? 'png' : 'jpeg',
      pixelFormat: transparentOverlay ? 'yuva420p' : 'yuv420p',
      muted: true,
      overwrite: true,
      concurrency: 1,
      disallowParallelEncoding: true,
      browserExecutable,
      logLevel: 'error',
      timeoutInMilliseconds: input.timeoutInMilliseconds ?? 60_000,
      ...(process.env.REMOTION_LICENSE_KEY?.trim()
        ? { licenseKey: process.env.REMOTION_LICENSE_KEY.trim() }
        : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    }
    await dependencies.renderMedia(renderOptions)

    const metadata = await dependencies.getVideoMetadata(temporaryOutput)
    let alphaMode
    if (transparentOverlay) {
      alphaMode =
        metadata.pixelFormat === 'yuva420p'
          ? true
          : await (dependencies.probeWebmAlpha ?? probeWebmAlpha)(temporaryOutput)
      if (metadata.codec !== 'vp9' || !alphaMode) {
        throw taskError(
          'REMOTION_ALPHA_OUTPUT_INVALID',
          `Transparent Remotion output must be VP9 with WebM alpha mode, received ${metadata.codec}/${metadata.pixelFormat ?? 'unknown'}`,
          { codec: metadata.codec, pixelFormat: metadata.pixelFormat, alphaMode },
        )
      }
    } else if (metadata.codec !== 'h264') {
      throw taskError(
        'REMOTION_COMPOSITION_OUTPUT_INVALID',
        `Composition output must be H.264 MP4, received ${metadata.codec}/${metadata.pixelFormat ?? 'unknown'}`,
        { codec: metadata.codec, pixelFormat: metadata.pixelFormat },
      )
    }
    if (metadata.width !== task.composition.width || metadata.height !== task.composition.height) {
      throw taskError(
        'REMOTION_OUTPUT_DIMENSIONS_INVALID',
        `Remotion output dimensions ${metadata.width}x${metadata.height} do not match ${task.composition.width}x${task.composition.height}`,
      )
    }
    assertOutputTimingMatchesTask(metadata, task.composition)

    await mkdir(path.dirname(outputPath), { recursive: true })
    await rm(outputPath, { force: true })
    await rename(temporaryOutput, outputPath)
    const outputBytes = await readFile(outputPath)
    return {
      ok: true,
      taskId: task.taskId,
      renderMode: task.renderMode,
      compositionId: task.composition.id,
      outputPath,
      container: transparentOverlay ? 'webm' : 'mp4',
      codec: metadata.codec,
      pixelFormat: transparentOverlay ? 'yuva420p' : 'yuv420p',
      probedPixelFormat: metadata.pixelFormat,
      width: metadata.width,
      height: metadata.height,
      fps: task.composition.fps,
      durationInFrames: task.composition.durationInFrames,
      ...(transparentOverlay
        ? {
            alphaMode,
            alphaVerified: true,
            alphaSampleFrames: representativeFrames.map((sample) => sample.frame),
          }
        : {}),
      representativeFrames,
      sourceHash: hashInventory(sourceInventory),
      outputHash: `sha256:${createHash('sha256').update(outputBytes).digest('hex')}`,
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function enforceOfflineBundle(serveUrl) {
  if (/^[a-z]+:\/\//iu.test(serveUrl)) {
    throw taskError(
      'REMOTION_BUNDLE_INVALID',
      'Controlled Remotion rendering requires a local bundle directory',
    )
  }
  const indexPath = path.join(serveUrl, 'index.html')
  const html = await readFile(indexPath, 'utf8').catch(() => null)
  if (html === null) {
    throw taskError('REMOTION_BUNDLE_INVALID', 'Remotion bundle index.html is missing')
  }
  const policy = [
    "default-src 'self' data: blob:",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`
  const next = html.includes('<head>') ? html.replace('<head>', `<head>${meta}`) : `${meta}${html}`
  await writeFile(indexPath, next, 'utf8')
}

async function probeWebmAlpha(filePath) {
  const compositorDirectory = path.join(
    RUNTIME_NODE_MODULES,
    '@remotion',
    `compositor-${process.platform}-${process.arch}`,
  )
  const ffprobe = path.join(
    compositorDirectory,
    process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
  )
  if (!(await isFile(ffprobe))) {
    throw taskError(
      'REMOTION_ALPHA_PROBE_UNAVAILABLE',
      'The packaged Remotion ffprobe binary is unavailable',
    )
  }
  let stdout
  try {
    ;({ stdout } = await execFileAsync(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,pix_fmt:stream_tags=alpha_mode',
        '-of',
        'json',
        filePath,
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          ...(process.platform === 'darwin'
            ? { DYLD_LIBRARY_PATH: compositorDirectory }
            : process.platform === 'linux'
              ? { LD_LIBRARY_PATH: compositorDirectory }
              : {}),
        },
      },
    ))
  } catch (error) {
    throw taskError(
      'REMOTION_ALPHA_PROBE_FAILED',
      `Unable to inspect Remotion alpha output: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    const probe = JSON.parse(stdout)
    return probe.streams?.[0]?.tags?.alpha_mode === '1'
  } catch {
    throw taskError('REMOTION_ALPHA_PROBE_FAILED', 'Remotion ffprobe returned invalid JSON')
  }
}

function withControlledEsbuildOptions(rule) {
  if (!rule || typeof rule !== 'object' || !Array.isArray(rule.use)) return rule
  return {
    ...rule,
    use: rule.use.map((loader) => {
      if (
        !loader ||
        typeof loader !== 'object' ||
        typeof loader.loader !== 'string' ||
        !loader.loader.includes('@remotion/bundler/dist/esbuild-loader')
      ) {
        return loader
      }
      return {
        ...loader,
        options: {
          ...(loader.options ?? {}),
          tsconfigRaw: {
            compilerOptions: {
              jsx: 'react-jsx',
              target: 'ES2020',
              useDefineForClassFields: true,
            },
          },
        },
      }
    }),
  }
}

export async function validateRemotionTask(input) {
  const taskDirectory = await resolveTaskDirectory(input)
  const task = await readTask(taskDirectory)
  const sourceInventory = await validateSourceTree(taskDirectory, task)
  return {
    taskDirectory,
    task,
    sourceHash: hashInventory(sourceInventory),
  }
}

async function resolveTaskDirectory(input) {
  if (!input || typeof input !== 'object') {
    throw taskError('REMOTION_TASK_INVALID', 'Remotion task input must be an object')
  }
  const rawTaskDirectory = requireNonEmptyString(input.taskDirectory, 'taskDirectory')
  const rawWorkspace = input.workspaceDirectory ?? process.env.AUTOCUT_WORKSPACE
  const workspaceDirectory = requireNonEmptyString(rawWorkspace, 'AUTOCUT_WORKSPACE')
  const workspace = await realpath(path.resolve(workspaceDirectory)).catch(() => null)
  const taskDirectory = await realpath(path.resolve(rawTaskDirectory)).catch(() => null)
  if (!workspace || !taskDirectory) {
    throw taskError('REMOTION_TASK_NOT_FOUND', 'Remotion workspace or task directory was not found')
  }
  const relative = path.relative(workspace, taskDirectory)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw taskError(
      'REMOTION_TASK_OUTSIDE_WORKSPACE',
      'Remotion task must stay inside the active AutoCut workspace',
    )
  }
  const segments = relative.split(path.sep)
  if (
    segments.length !== 4 ||
    segments[0] !== 'projects' ||
    segments[2] !== 'remotion' ||
    !PORTABLE_ID.test(segments[1]) ||
    !PORTABLE_ID.test(segments[3])
  ) {
    throw taskError(
      'REMOTION_TASK_LAYOUT_INVALID',
      'Remotion task must be projects/<project-id>/remotion/<task-id>',
    )
  }
  return taskDirectory
}

async function readTask(taskDirectory) {
  const taskPath = path.join(taskDirectory, TASK_FILE)
  const raw = await readFile(taskPath, 'utf8').catch(() => null)
  if (raw === null) throw taskError('REMOTION_TASK_CONFIG_MISSING', `${TASK_FILE} is required`)
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw taskError(
      'REMOTION_TASK_CONFIG_INVALID',
      `${TASK_FILE} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  assertRecord(value, TASK_FILE)
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'renderMode',
      'taskId',
      'entryPoint',
      'componentExport',
      'composition',
      'inputProps',
      'output',
    ],
    TASK_FILE,
  )
  if (value.schemaVersion !== 1) {
    throw taskError('REMOTION_TASK_CONFIG_INVALID', 'task.json schemaVersion must be 1')
  }
  const renderMode =
    value.renderMode === undefined
      ? 'transparent-overlay'
      : value.renderMode === 'transparent-overlay' || value.renderMode === 'composition'
        ? value.renderMode
        : (() => {
            throw taskError(
              'REMOTION_TASK_CONFIG_INVALID',
              'renderMode must be transparent-overlay or composition',
            )
          })()
  const taskId = requirePortableId(value.taskId, 'taskId')
  if (taskId !== path.basename(taskDirectory)) {
    throw taskError(
      'REMOTION_TASK_CONFIG_INVALID',
      'taskId must match the Remotion task directory name',
    )
  }
  const entryPoint = requireRelativePath(value.entryPoint, 'entryPoint')
  if (!entryPoint.startsWith('src/')) {
    throw taskError('REMOTION_TASK_CONFIG_INVALID', 'entryPoint must stay below src/')
  }
  const componentExport = requireNonEmptyString(value.componentExport, 'componentExport')
  if (componentExport !== 'default' && !EXPORT_NAME.test(componentExport)) {
    throw taskError(
      'REMOTION_TASK_CONFIG_INVALID',
      'componentExport must be "default" or a JavaScript identifier',
    )
  }
  assertRecord(value.composition, 'composition')
  assertExactKeys(
    value.composition,
    ['id', 'width', 'height', 'fps', 'durationInFrames'],
    'composition',
  )
  const composition = {
    id: requirePortableId(value.composition.id, 'composition.id'),
    width: requireEvenInteger(value.composition.width, 'composition.width', 16, 7680),
    height: requireEvenInteger(value.composition.height, 'composition.height', 16, 4320),
    fps: requireInteger(value.composition.fps, 'composition.fps', 1, 120),
    durationInFrames: requireInteger(
      value.composition.durationInFrames,
      'composition.durationInFrames',
      1,
      60 * 60 * 120,
    ),
  }
  const inputProps = value.inputProps ?? {}
  assertRecord(inputProps, 'inputProps')
  assertJsonValue(inputProps, 'inputProps')
  const defaultOutputExtension = renderMode === 'composition' ? '.mp4' : '.webm'
  const output =
    value.output === undefined
      ? `renders/${taskId}${defaultOutputExtension}`
      : requireRelativePath(value.output, 'output')
  if (
    !output.startsWith('renders/') ||
    path.extname(output).toLowerCase() !== defaultOutputExtension
  ) {
    throw taskError(
      'REMOTION_TASK_CONFIG_INVALID',
      `output must be a ${defaultOutputExtension} file below renders/ for ${renderMode}`,
    )
  }
  return {
    schemaVersion: 1,
    renderMode,
    taskId,
    entryPoint,
    componentExport,
    composition,
    inputProps,
    output,
  }
}

async function validateSourceTree(taskDirectory, task) {
  const sourceEntryCandidate = resolveContained(
    taskDirectory,
    task.entryPoint,
    'REMOTION_SOURCE_OUTSIDE_TASK',
    'Remotion source entry',
  )
  const sourceEntry = await realpath(sourceEntryCandidate).catch(() => sourceEntryCandidate)
  if (!isContainedPath(taskDirectory, sourceEntry)) {
    throw taskError(
      'REMOTION_SOURCE_OUTSIDE_TASK',
      'Remotion source entry must stay inside the task directory',
    )
  }
  if (!(await isFile(sourceEntry))) {
    throw taskError(
      'REMOTION_SOURCE_MISSING',
      `Remotion source entry was not found: ${task.entryPoint}`,
    )
  }

  const inventory = new Map()
  const pending = [sourceEntry]
  while (pending.length > 0) {
    const filePath = pending.pop()
    if (inventory.has(filePath)) continue
    await assertNotSymlink(filePath)
    const bytes = await readFile(filePath)
    inventory.set(filePath, bytes)
    const extension = path.extname(filePath).toLowerCase()
    if (!CODE_EXTENSIONS.has(extension)) {
      if (extension === '.css') {
        pending.push(...(await validateCss(taskDirectory, bytes.toString('utf8'), filePath)))
      }
      continue
    }
    const source = bytes.toString('utf8')
    validateCode(source, filePath)
    let imports
    try {
      imports = collectModuleImports(
        parseJavascript(source, {
          sourceType: 'module',
          plugins: ['typescript', 'jsx', 'dynamicImport'],
        }),
      )
    } catch (error) {
      throw taskError(
        'REMOTION_SOURCE_INVALID',
        `Unable to parse imports in ${relativeDisplay(taskDirectory, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    for (const imported of imports) {
      if (imported.dynamic) {
        throw taskError(
          'REMOTION_DYNAMIC_IMPORT_FORBIDDEN',
          `Dynamic import is not allowed in ${relativeDisplay(taskDirectory, filePath)}`,
        )
      }
      if (!imported.specifier.startsWith('.') && !imported.specifier.startsWith('/')) {
        if (!ALLOWED_EXTERNAL_IMPORTS.has(imported.specifier)) {
          throw taskError(
            'REMOTION_IMPORT_FORBIDDEN',
            `Unsupported Remotion import "${imported.specifier}" in ${relativeDisplay(taskDirectory, filePath)}`,
          )
        }
        continue
      }
      if (imported.specifier.startsWith('/')) {
        throw taskError(
          'REMOTION_IMPORT_OUTSIDE_TASK',
          `Absolute import is not allowed in ${relativeDisplay(taskDirectory, filePath)}`,
        )
      }
      pending.push(await resolveLocalImport(taskDirectory, filePath, imported.specifier))
    }
  }

  const publicDirectory = path.join(taskDirectory, 'public')
  if (await isDirectory(publicDirectory)) {
    await collectDirectoryFiles(publicDirectory, inventory)
  }
  inventory.set(
    path.join(taskDirectory, TASK_FILE),
    await readFile(path.join(taskDirectory, TASK_FILE)),
  )
  return [...inventory.entries()]
    .map(([filePath, bytes]) => ({
      path: relativeDisplay(taskDirectory, filePath),
      bytes,
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function collectModuleImports(ast) {
  const imports = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (
      (value.type === 'ImportDeclaration' ||
        value.type === 'ExportNamedDeclaration' ||
        value.type === 'ExportAllDeclaration') &&
      typeof value.source?.value === 'string'
    ) {
      imports.push({ specifier: value.source.value, dynamic: false })
    }
    if (value.type === 'ImportExpression') {
      imports.push({
        specifier: typeof value.source?.value === 'string' ? value.source.value : '<dynamic>',
        dynamic: true,
      })
    }
    if (value.type === 'CallExpression' && value.callee?.type === 'Import') {
      const argument = value.arguments?.[0]
      imports.push({
        specifier: typeof argument?.value === 'string' ? argument.value : '<dynamic>',
        dynamic: true,
      })
    }
    for (const entry of Object.values(value)) {
      if (Array.isArray(entry)) entry.forEach(visit)
      else if (entry && typeof entry === 'object') visit(entry)
    }
  }
  visit(ast)
  return imports
}

async function resolveLocalImport(taskDirectory, importer, specifier) {
  if (specifier.includes('?') || specifier.includes('#')) {
    throw taskError('REMOTION_IMPORT_FORBIDDEN', `Import query/hash is not allowed: ${specifier}`)
  }
  const candidate = path.resolve(path.dirname(importer), specifier)
  const possibilities = path.extname(candidate)
    ? [candidate]
    : [
        ...SOURCE_EXTENSIONS.map((extension) => `${candidate}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) => path.join(candidate, `index${extension}`)),
      ]
  for (const possibility of possibilities) {
    if (await isFile(possibility)) {
      await assertNotSymlink(possibility)
      const realFilePath = await realpath(possibility)
      return realFilePath
    }
  }
  throw taskError(
    'REMOTION_IMPORT_MISSING',
    `Unable to resolve task-local import "${specifier}" from ${relativeDisplay(taskDirectory, importer)}`,
  )
}

async function collectDirectoryFiles(directory, inventory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw taskError(
        'REMOTION_SYMLINK_FORBIDDEN',
        `Remotion task symlink is not allowed: ${filePath}`,
      )
    }
    if (entry.isDirectory()) await collectDirectoryFiles(filePath, inventory)
    else if (entry.isFile()) inventory.set(filePath, await readFile(filePath))
  }
}

function validateCode(source, filePath) {
  for (const [pattern, label] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(source)) {
      throw taskError(
        'REMOTION_SOURCE_CAPABILITY_FORBIDDEN',
        `Remotion source may not use ${label}: ${filePath}`,
      )
    }
  }
}

async function validateCss(taskDirectory, source, filePath) {
  if (/@import\b/u.test(source)) {
    throw taskError(
      'REMOTION_SOURCE_CAPABILITY_FORBIDDEN',
      `Remotion CSS may not use @import: ${filePath}`,
    )
  }
  const assets = []
  for (const match of source.matchAll(/\burl\s*\(\s*(['"]?)([^'")]+)\1\s*\)/giu)) {
    const specifier = match[2].trim()
    if (specifier.startsWith('data:') || specifier.startsWith('#')) continue
    if (/^(?:https?:|\/\/|\/)/iu.test(specifier)) {
      throw taskError(
        'REMOTION_SOURCE_CAPABILITY_FORBIDDEN',
        `Remotion CSS may not load remote or absolute resources: ${filePath}`,
      )
    }
    assets.push(await resolveLocalImport(taskDirectory, filePath, specifier))
  }
  return assets
}

async function writePrivateEntry({ temporaryDirectory, sourceEntry, task }) {
  const entryPath = path.join(temporaryDirectory, 'entry.tsx')
  const sourceSpecifier = relativeImportSpecifier(entryPath, sourceEntry)
  const componentImport =
    task.componentExport === 'default'
      ? `import Animation from ${JSON.stringify(sourceSpecifier)};`
      : `import {${task.componentExport} as Animation} from ${JSON.stringify(sourceSpecifier)};`
  await writeFile(
    entryPath,
    [
      'import React from "react";',
      'import {Composition, registerRoot} from "remotion";',
      componentImport,
      `const inputProps = ${JSON.stringify(task.inputProps)};`,
      'const AutoCutRemotionRoot = () => (',
      '  <Composition',
      `    id=${JSON.stringify(task.composition.id)}`,
      '    component={Animation}',
      `    width={${task.composition.width}}`,
      `    height={${task.composition.height}}`,
      `    fps={${task.composition.fps}}`,
      `    durationInFrames={${task.composition.durationInFrames}}`,
      '    defaultProps={inputProps}',
      '  />',
      ');',
      'registerRoot(AutoCutRemotionRoot);',
      '',
    ].join('\n'),
    'utf8',
  )
  return entryPath
}

async function renderRepresentativeFrames({
  dependencies,
  composition,
  serveUrl,
  sharedBrowserOptions,
  temporaryDirectory,
  requireTransparency,
}) {
  const frames = [
    0,
    Math.floor((composition.durationInFrames - 1) / 2),
    composition.durationInFrames - 1,
  ].filter((frame, index, values) => values.indexOf(frame) === index)
  let foundTransparentPixel = false
  const samples = []
  for (const frame of frames) {
    const output = path.join(temporaryDirectory, `alpha-${frame}.png`)
    await dependencies.renderStill({
      composition,
      serveUrl,
      output,
      frame,
      imageFormat: 'png',
      overwrite: true,
      ...sharedBrowserOptions,
    })
    const bytes = await readFile(output)
    samples.push({
      frame,
      hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    })
    if (!requireTransparency) continue
    const image = PNG.sync.read(bytes)
    for (let index = 3; index < image.data.length; index += 4) {
      if (image.data[index] < 255) {
        foundTransparentPixel = true
        break
      }
    }
  }
  if (requireTransparency && !foundTransparentPixel) {
    throw taskError(
      'REMOTION_ALPHA_NOT_PRESENT',
      'Remotion composition did not contain transparent pixels in representative frames',
      { sampledFrames: frames },
    )
  }
  return samples
}

function assertOutputTimingMatchesTask(metadata, expected) {
  if (typeof metadata.fps === 'number' && Math.abs(metadata.fps - expected.fps) > 0.01) {
    throw taskError(
      'REMOTION_OUTPUT_FPS_INVALID',
      `Remotion output FPS ${metadata.fps} does not match ${expected.fps}`,
    )
  }
  if (typeof metadata.durationInSeconds === 'number') {
    const expectedDuration = expected.durationInFrames / expected.fps
    const frameTolerance = 1 / expected.fps
    if (Math.abs(metadata.durationInSeconds - expectedDuration) > frameTolerance) {
      throw taskError(
        'REMOTION_OUTPUT_DURATION_INVALID',
        `Remotion output duration ${metadata.durationInSeconds}s does not match ${expectedDuration}s`,
      )
    }
  }
}

function assertCompositionMatchesTask(composition, expected) {
  for (const key of ['width', 'height', 'fps', 'durationInFrames']) {
    if (composition[key] !== expected[key]) {
      throw taskError(
        'REMOTION_COMPOSITION_MISMATCH',
        `Remotion composition ${key} must be ${expected[key]}, received ${composition[key]}`,
      )
    }
  }
}

async function loadRemotionDependencies() {
  const [{ bundle }, renderer] = await Promise.all([
    import('@remotion/bundler'),
    import('@remotion/renderer'),
  ])
  return {
    bundle,
    selectComposition: renderer.selectComposition,
    renderStill: renderer.renderStill,
    renderMedia: renderer.renderMedia,
    getVideoMetadata: renderer.getVideoMetadata,
  }
}

async function resolveBrowserExecutable(explicit) {
  const configured = explicit ?? process.env.AUTOCUT_REMOTION_BROWSER
  const candidates = [
    configured,
    ...(process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            process.env.PROGRAMFILES
              ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
              : undefined,
            process.env['PROGRAMFILES(X86)']
              ? path.join(
                  process.env['PROGRAMFILES(X86)'],
                  'Google',
                  'Chrome',
                  'Application',
                  'chrome.exe',
                )
              : undefined,
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (
      await access(candidate)
        .then(() => true)
        .catch(() => false)
    )
      return candidate
  }
  throw taskError(
    'REMOTION_BROWSER_UNAVAILABLE',
    'A Host-provided Chrome executable is required for Remotion; automatic download is disabled',
  )
}

function resolveContained(root, relativePath, code, label) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relativePath)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw taskError(code, `${label} must stay inside the Remotion task directory`)
  }
  return resolved
}

function isContainedPath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function requireRelativePath(value, field) {
  const result = requireNonEmptyString(value, field).replaceAll('\\', '/')
  if (path.posix.isAbsolute(result) || result.split('/').includes('..')) {
    throw taskError('REMOTION_TASK_CONFIG_INVALID', `${field} must be a contained relative path`)
  }
  return result
}

function requirePortableId(value, field) {
  const result = requireNonEmptyString(value, field)
  if (!PORTABLE_ID.test(result)) {
    throw taskError('REMOTION_TASK_CONFIG_INVALID', `${field} must be a portable identifier`)
  }
  return result
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw taskError('REMOTION_TASK_CONFIG_INVALID', `${field} is required`)
  }
  return value.trim()
}

function requireInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw taskError(
      'REMOTION_TASK_CONFIG_INVALID',
      `${field} must be an integer between ${min} and ${max}`,
    )
  }
  return value
}

function requireEvenInteger(value, field, min, max) {
  const result = requireInteger(value, field, min, max)
  if (result % 2 !== 0) {
    throw taskError('REMOTION_TASK_CONFIG_INVALID', `${field} must be even for VP9 alpha output`)
  }
  return result
}

function assertRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw taskError('REMOTION_TASK_CONFIG_INVALID', `${field} must be an object`)
  }
}

function assertExactKeys(value, allowed, field) {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key))
  if (unknown.length > 0) {
    throw taskError(
      'REMOTION_TASK_CONFIG_INVALID',
      `${field} contains unsupported fields: ${unknown.join(', ')}`,
    )
  }
}

function assertJsonValue(value, field) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || serialized.length > 1024 * 1024) {
      throw new Error('value is missing or larger than 1 MiB')
    }
  } catch (error) {
    throw taskError(
      'REMOTION_TASK_CONFIG_INVALID',
      `${field} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function assertNotSymlink(filePath) {
  if ((await lstat(filePath)).isSymbolicLink()) {
    throw taskError(
      'REMOTION_SYMLINK_FORBIDDEN',
      `Remotion task symlink is not allowed: ${filePath}`,
    )
  }
}

async function isFile(filePath) {
  return (await stat(filePath).catch(() => null))?.isFile() === true
}

async function isDirectory(filePath) {
  return (await stat(filePath).catch(() => null))?.isDirectory() === true
}

function relativeImportSpecifier(fromFile, toFile) {
  const relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

function relativeDisplay(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function hashInventory(inventory) {
  const hash = createHash('sha256')
  for (const item of inventory) {
    hash.update(item.path)
    hash.update('\0')
    hash.update(item.bytes)
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function taskError(code, message, details = undefined) {
  return new RemotionTaskError(code, message, details)
}
