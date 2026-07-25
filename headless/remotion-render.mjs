#!/usr/bin/env node
import { run } from './agent.mjs'
import { runAgentCli } from './lib/agent-cli.mjs'
import { isMainModule } from './lib/main-module.mjs'

if (isMainModule(import.meta.url)) {
  await runAgentCli(run, ['remotion-render', ...process.argv.slice(2)])
}
