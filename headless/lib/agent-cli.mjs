import { HEADLESS_API_VERSION } from './contract.mjs'

export async function runAgentCli(run, argv = process.argv.slice(2)) {
  try {
    const result = await run(argv)
    console.log(JSON.stringify(result, null, 2))
    if (result?.ok === false) process.exitCode = 1
  } catch (error) {
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
  }
}
