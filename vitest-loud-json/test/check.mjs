import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkReport } from '../check.mjs'
import { root, runNode, scratch } from './helpers.mjs'

test('guard rejects disagreements in both directions and every failed run', async () => {
  const dir = scratch('check with spaces-')
  const report = join(dir, 'report.json')
  for (const [exitCode, failed, success, pattern] of [
    [1, 0, true, /disagreement/i],
    [0, 1, false, /disagreement/i],
    [1, 1, false, /failed/i],
    [0, 0, false, /unsuccessful/i],
    [0, -1, true, /numFailedTests/],
    [0, '0', true, /numFailedTests/],
    [null, 0, true, /exit code/i],
  ]) {
    writeFileSync(report, JSON.stringify({ numFailedTests: failed, success }))
    assert.throws(() => checkReport(report, exitCode), pattern)
  }
  writeFileSync(report, '{"numFailedTests":0,"success":true}\r\n')
  assert.equal(checkReport(report, 0).numFailedTests, 0)
  const refused = await runNode([join(root, 'check.mjs'), report, '1'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /disagreement/i)
  assert.equal((await runNode([join(root, 'check.mjs'), report, '0'])).status, 0)
  assert.equal((await runNode([join(root, 'check.mjs'), report])).status, 1)
  writeFileSync(report, '{}')
  assert.throws(() => checkReport(report, 0), /numFailedTests/)
  writeFileSync(report, 'not JSON')
  assert.throws(() => checkReport(report, 0))
  assert.throws(() => checkReport(join(dir, 'missing.json'), 0))
})
