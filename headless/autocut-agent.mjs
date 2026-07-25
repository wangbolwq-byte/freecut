#!/usr/bin/env node
import { HEADLESS_API_VERSION } from './lib/contract.mjs'
import { isMainModule } from './lib/main-module.mjs'
import { run } from './agent.mjs'

if (isMainModule(import.meta.url)) {
  run()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      const details = error?.details && typeof error.details === 'object' ? error.details : {}
      console.error(
        JSON.stringify({
          ok: false,
          apiVersion: HEADLESS_API_VERSION,
          error: {
            code: error.code ?? 'INTERNAL_ERROR',
            message: error.message,
            fields: error.fields ?? [],
            ...details,
          },
        }),
      )
      process.exitCode = 1
    })
}
