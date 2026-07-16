#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HEADLESS_API_VERSION } from './lib/contract.mjs'
import { run } from './agent.mjs'

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
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
