import assert from 'node:assert/strict'
import { copyFileSync, lstatSync, mkdirSync, realpathSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { packageTree, root, runNode, scratch, treeBeforeTests, workspace } from './helpers.mjs'
import { checkReport } from '../check.mjs'

const linkedFixtures = []

test('CLI through a directory link still refuses an inconsistent report', async t => {
  const dir = scratch('bin-link-')
  linkedFixtures.push(dir)
  // The link points at a COPY of the package, never at the source folder: a link
  // left behind by a crash could otherwise let a later recursive delete reach the source.
  const copy = join(dir, 'package-copy')
  mkdirSync(copy)
  for (const name of ['check.mjs', 'package.json']) copyFileSync(join(root, name), join(copy, name))
  const alias = join(dir, 'linked-package')
  const report = join(dir, 'report.json')
  // Unlink the junction itself first; the workspace is removed when the process exits.
  t.after(() => { if (lstatSync(alias, { throwIfNoEntry: false })) unlinkSync(alias) })
  symlinkSync(copy, alias, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(report, '{"numFailedTests":0,"success":true}')
  const run = await runNode([join(alias, 'check.mjs'), report, '1'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /disagreement/i)
})

test('a recovered sidecar write keeps the failure reason in stderr and JSON', async () => {
  const dir = scratch('write-recovered-')
  const report = join(dir, 'blocked', 'report.json')
  writeFileSync(join(dir, 'blocked'), 'not a directory yet')
  const run = await runNode(['--input-type=module', '-e', `
    import { unlinkSync } from 'node:fs';
    import Reporter from ${JSON.stringify(pathToFileURL(join(root, 'reporter.mjs')).href)};
    const reporter = new Reporter();
    reporter.onInit({config: {root: ${JSON.stringify(dir)}, watch: false,
      reporters: ['json'], outputFile: 'blocked/report.json'}});
    unlinkSync(${JSON.stringify(join(dir, 'blocked'))});
    reporter.onTestRunEnd([], [], 'passed');
  `])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Cannot write sidecar/)
  const data = JSON.parse(readFileSync(`${report}.errors.json`, 'utf8'))
  assert.equal(data.exitCode, 1)
  assert.ok(data.reasons.some(reason => reason.includes('Cannot write sidecar')))
})

test('actual process status still protects against a later exit listener', async () => {
  const dir = scratch('exit-listener-')
  const report = join(dir, 'report.json')
  writeFileSync(report, '{"numFailedTests":0,"success":true}')
  const run = await runNode(['--input-type=module', '-e', `
    import Reporter from ${JSON.stringify(pathToFileURL(join(root, 'reporter.mjs')).href)};
    const reporter = new Reporter();
    reporter.onInit({config: {root: ${JSON.stringify(dir)}, watch: false,
      reporters: ['json'], outputFile: 'report.json'}});
    reporter.onTestRunEnd([], [], 'passed');
    process.on('exit', () => { process.exitCode = 7 });
  `])
  assert.equal(run.status, 7)
  const data = JSON.parse(readFileSync(`${report}.errors.json`, 'utf8'))
  assert.equal(data.exitCode, 0) // Exit listeners cannot observe future listeners.
  assert.throws(() => checkReport(report, run.status), /disagreement/i)
})

test('the suite writes nothing inside the package and links only to temp copies', () => {
  // Same file list as when the helpers loaded: no .runs folder, no stray reports.
  assert.deepEqual(packageTree(), treeBeforeTests)
  assert.equal(treeBeforeTests.some(path => path.split(/[\\/]/).includes('.runs')), false)
  for (const path of packageTree()) {
    assert.equal(lstatSync(join(root, path)).isSymbolicLink(), false, `Package contains a link or junction: ${path}`)
  }
  for (const dir of linkedFixtures) {
    assert.equal(realpathSync.native(dirname(dir)), realpathSync.native(workspace),
      'Linked CLI fixtures must live in the temporary test workspace')
    // The link was removed after use; the copy it pointed at is not the package.
    assert.equal(lstatSync(join(dir, 'linked-package'), { throwIfNoEntry: false }), undefined)
    assert.notEqual(realpathSync.native(join(dir, 'package-copy')), realpathSync.native(root))
  }
})
