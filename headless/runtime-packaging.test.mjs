import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')

test('packaged AutoCut runtime includes standalone browser dependencies', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'autocut-runtime-package-'))
  const outputRoot = path.join(tempRoot, 'runtime')
  t.after(() => rm(tempRoot, { recursive: true, force: true }))

  await execFileAsync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'package-autocut-runtime.mjs'),
      '--output',
      outputRoot,
      '--platform-arch',
      'macos-arm64',
      '--version',
      '0.0.0-test',
      '--commit',
      'test-commit',
    ],
    { cwd: repoRoot },
  )

  const runtimePackage = JSON.parse(await readFile(path.join(outputRoot, 'package.json'), 'utf8'))
  assert.deepEqual(runtimePackage.dependencies, {
    playwright: '1.60.0',
    'playwright-core': '1.60.0',
    zod: '4.3.6',
  })

  const packagedPlaywright = await import(
    pathToFileURL(path.join(outputRoot, 'node_modules', 'playwright', 'index.mjs')).href
  )
  assert.equal(typeof packagedPlaywright.chromium.launch, 'function')
})
