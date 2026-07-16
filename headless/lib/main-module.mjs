import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function isMainModule(metaUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) return false
  const modulePath = fs.realpathSync(fileURLToPath(metaUrl))
  const entryPath = fs.realpathSync(path.resolve(argvEntry))
  return modulePath === entryPath
}
