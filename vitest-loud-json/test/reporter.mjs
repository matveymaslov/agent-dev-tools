import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { message, root, runFixture } from './helpers.mjs'

test('companion prints the unhandled error and records the actual failing exit', async () => {
  const run = await runFixture(['json', join(root, 'reporter.mjs')])
  assert.equal(run.status, 1)
  assert.equal(run.json.numFailedTests, 0)
  assert.equal(run.json.numPassedTests, 1)
  assert.match(run.stderr, /\[vitest-loud-json\] exit 1/)
  assert.ok(run.stderr.includes(message))
  assert.equal(run.stderr.match(/\[vitest-loud-json\]/g).length, 1)
  const sidecar = JSON.parse(readFileSync(`${run.report}.errors.json`, 'utf8'))
  assert.equal(sidecar.exitCode, run.status)
  assert.equal(sidecar.numFailedTests, 0)
  assert.equal(sidecar.unhandledErrors.length, 1)
  assert.equal(sidecar.unhandledErrors[0].message, message)
  assert.ok(sidecar.unhandledErrors[0].stack.includes('setup.mjs'))
  assert.ok(sidecar.reasons.some(reason => /unhandled/.test(reason)))
})
