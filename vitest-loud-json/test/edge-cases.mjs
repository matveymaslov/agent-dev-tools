import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { root, runFixture, runNode, scratch } from './helpers.mjs'

for (const [scenario, code, failed, pattern] of [
  ['clean', 0, 0, null],
  ['failure', 1, 1, /1 failed test/],
  ['collection', 1, 0, /Cannot collect this test file/],
  ['late-exit', 7, 0, /no cause for this exit was supplied/],
  ['after-test', 1, 0, /Unhandled error after test completion/],
]) {
  test(`real Vitest run: ${scenario}, tuple output path relative to root`, async () => {
    const run = await runFixture([], [], {
      config: 'scenario.config.mjs', env: { LOUD_SCENARIO: scenario },
    })
    const data = JSON.parse(readFileSync(`${run.report}.errors.json`, 'utf8'))
    assert.equal(run.status, code)
    assert.equal(data.exitCode, code)
    assert.equal(data.numFailedTests, failed)
    assert.equal(run.json.numFailedTests, failed)
    if (pattern) assert.match(run.stderr, pattern)
    else {
      assert.ok(!run.stderr.includes('[vitest-loud-json]'))
      assert.deepEqual(data.unhandledErrors, [])
      assert.deepEqual(data.reasons, [])
    }
    if (scenario === 'late-exit') assert.equal(data.exitCodeAtRunEnd, 0)
    if (scenario === 'after-test') {
      assert.equal(data.unhandledErrors.length, 2)
      assert.match(run.stderr, /Second rejection after test completion/)
    }
  })
}

test('serialized cycles, bigint, cause and primitive rejections survive in the sidecar', async () => {
  const dir = scratch('serialization-')
  const report = join(dir, 'report.json')
  const result = await runNode(['--input-type=module', '-e', `
    import Reporter from ${JSON.stringify(pathToFileURL(join(root, 'reporter.mjs')).href)};
    const reporter = new Reporter();
    reporter.onInit({config: {root: ${JSON.stringify(dir)}, watch: false,
      reporters: [['json', {}]], outputFile: {json: 'report.json'}}});
    const cause = {value: 2n}; cause.self = cause;
    process.exitCode = 1;
    reporter.onTestRunEnd([], [Object.assign(new Error('Nested failure'), {cause}), cause, 7n, null], 'passed');
  `])
  assert.equal(result.status, 1)
  const data = JSON.parse(readFileSync(`${report}.errors.json`, 'utf8'))
  assert.equal(data.unhandledErrors.length, 4)
  assert.match(data.unhandledErrors[0].cause, /2n/)
  assert.match(data.unhandledErrors[1].message, /Circular/)
  assert.equal(data.unhandledErrors[2].message, '7n')
  assert.equal(data.unhandledErrors[3].message, 'null')
  assert.match(result.stderr, /Nested failure/)
})

test('sidecar write failure cannot silently leave a green exit', async () => {
  const dir = scratch('write-error-')
  writeFileSync(join(dir, 'blocked'), 'not a directory')
  const result = await runNode(['--input-type=module', '-e', `
    import Reporter from ${JSON.stringify(pathToFileURL(join(root, 'reporter.mjs')).href)};
    const reporter = new Reporter();
    reporter.onInit({config: {root: ${JSON.stringify(dir)}, watch: false,
      reporters: ['json'], outputFile: 'blocked/report.json'}});
    reporter.onTestRunEnd([], [], 'passed');
  `])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Cannot write sidecar/)
})
