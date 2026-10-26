#!/usr/bin/env node
import { readFileSync, realpathSync, writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Return a green report or throw. exitCode must come from the actual process. */
export function checkReport(file, exitCode) {
  if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
    throw new Error('A non-negative integer process exit code is required (signals are failures)')
  }
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const failed = report?.numFailedTests
  if (!Number.isSafeInteger(failed) || failed < 0) {
    throw new Error('Invalid report: numFailedTests must be a non-negative integer')
  }
  if ((exitCode !== 0) !== (failed !== 0)) {
    throw new Error(`Exit/report disagreement: exit ${exitCode}, numFailedTests ${failed}; refusing report`)
  }
  if (exitCode !== 0) throw new Error(`Vitest failed: exit ${exitCode}, numFailedTests ${failed}`)
  if (report.success !== true) throw new Error('Vitest report is unsuccessful or missing success: true')
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [file, code, ...extra] = process.argv.slice(2)
    if (!file || !/^\d+$/.test(code ?? '') || extra.length) {
      throw new Error('Usage: vitest-loud-json-check <report.json> <actual-exit-code>')
    }
    checkReport(file, Number(code))
  } catch (error) {
    writeSync(2, `[vitest-loud-json] ${error.message}\n`)
    process.exitCode = 1
  }
}
