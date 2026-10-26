import assert from 'node:assert/strict'
import { test } from 'node:test'
import { message, runFixture } from './helpers.mjs'

test('JSON alone hides an unhandled error despite exit 1 and zero failed tests', async () => {
  const run = await runFixture()
  assert.equal(run.status, 1)
  assert.equal(run.json.numPassedTests, 1)
  assert.equal(run.json.numFailedTests, 0)
  assert.equal(run.json.success, true)
  assert.ok(!`${run.stdout}${run.stderr}`.includes(message))
})
