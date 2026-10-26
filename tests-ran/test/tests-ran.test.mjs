import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'bin', 'tests-ran.mjs');
const library = new URL('../lib/index.mjs', import.meta.url);
// A nested Node runner must not inherit the parent's binary test reporter.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const tap = (passed = 0, failed = 0, skipped = 0, todo = 0, cancelled = 0) =>
  `TAP version 13\n1..${passed + failed + skipped + todo + cancelled}\n` +
  `# tests ${passed + failed + skipped + todo + cancelled}\n# suites 0\n` +
  `# pass ${passed}\n# fail ${failed}\n# cancelled ${cancelled}\n` +
  `# skipped ${skipped}\n# todo ${todo}\n# duration_ms 1.2\n`;
const json = (passed = 0, failed = 0, pending = 0, todo = 0) => JSON.stringify({
  numTotalTests: passed + failed + pending + todo,
  numPassedTests: passed, numFailedTests: failed,
  numPendingTests: pending, numTodoTests: todo,
});
const reports = {
  tap: [tap(), tap(2), tap(0, 0, 1, 1), tap(1, 1, 1, 1)],
  json: [json(), json(2), json(0, 0, 1, 1), json(1, 1, 1, 1)],
  junit: [
    '<testsuites tests="0"/>',
    '<testsuite tests="2"><testcase name="one"/><testcase name="two"/></testsuite>',
    '<testsuite tests="2" skipped="2"><testcase><skipped/></testcase><testcase><skipped message="todo"/></testcase></testsuite>',
    '<testsuite tests="4" skipped="2"><testcase/><testcase><failure/></testcase><testcase><skipped/></testcase><testcase><skipped message="todo"/></testcase></testsuite>',
  ],
};

function workspace(t) {
  const cwd = mkdtempSync(join(root, '.test-space-'));
  t.after(() => {
    for (const name of readdirSync(cwd)) unlinkSync(join(cwd, name));
    rmdirSync(cwd);
  });
  return cwd;
}

// Arguments are passed as an array: no shell, quoting tricks, or network.
function run(t, format, report, { code = 0, min = 1, file = false, kill = false, extra = [] } = {}) {
  const cwd = workspace(t);
  const reportPath = join(cwd, 'machine report.txt');
  const stdout = file ? 'ordinary output\r\nλ\n' : report;
  const stderr = 'ordinary error\r\n';
  const script = `
    const fs = require('node:fs');
    const config = JSON.parse(process.argv[1]);
    if (config.file) fs.writeFileSync(config.reportPath, config.report);
    process.stdout.write(config.stdout);
    process.stderr.write(config.stderr);
    if (config.kill) process.kill(process.pid, 'SIGKILL');
    else process.exitCode = config.code;
  `;
  const result = spawnSync(process.execPath, [cli, '--min', String(min), '--format', format,
    ...(file ? ['--report', reportPath] : []), ...extra, '--', process.execPath,
    '-e', script, JSON.stringify({ file, reportPath, report, stdout, stderr, code, kill })],
  { cwd, env: childEnv, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, originalStdout: stdout, originalStderr: stderr };
}

function notRun(result) {
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /not run/i);
}

for (const [format, [zero, some, skipped, mixed]] of Object.entries(reports)) {
  test(`${format}: successful command with zero tests is not run`, t => notRun(run(t, format, zero)));
  test(`${format}: executed tests preserve success and both output streams`, t => {
    const result = run(t, format, some);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, result.originalStdout);
    assert.equal(result.stderr, result.originalStderr);
  });
  test(`${format}: executed tests preserve the command's failure code`, t => {
    assert.equal(run(t, format, some, { code: 7 }).status, 7);
  });
  test(`${format}: skipped and todo do not count`, t => notRun(run(t, format, skipped)));
  test(`${format}: minimum uses executed counts`, t => {
    assert.equal(run(t, format, mixed, { min: 2, code: 9 }).status, 9);
    notRun(run(t, format, mixed, { min: 3 }));
  });
  test(`${format}: reads a report path with spaces, retaining ordinary output`, t => {
    const result = run(t, format, some, { file: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, result.originalStdout);
    assert.equal(result.stderr, result.originalStderr);
  });
  test(`${format}: zero tests in a file are not run`, t => notRun(run(t, format, zero, { file: true })));
  test(`${format}: malformed and absent stdout reports are not run`, t => {
    notRun(run(t, format, 'not a machine report'));
    notRun(run(t, format, ''));
  });
  test(`${format}: missing report file is not run`, t => {
    const result = run(t, format, some, { extra: ['--report', 'absent.xml'] });
    notRun(result);
    assert.match(result.stderr, /report/i);
  });
  test(`${format}: malformed report file is not run`, t => notRun(run(t, format, 'broken', { file: true })));
}

test('TAP uses only top-level summary counts with nested subtests and CRLF', async () => {
  const { countTests } = await import(library);
  const report = 'TAP version 13\n# Subtest: group\n    # Subtest: child\n' +
    '    ok 1 - child\n    # tests 999\n    1..1\nok 1 - group\n' +
    tap(1).replace('TAP version 13\n', '');
  assert.equal(countTests(report, 'tap'), 1);
  assert.equal(countTests(report.replaceAll('\n', '\r\n'), 'tap'), 1);
});

test('TAP cancelled tests do not count', t => notRun(run(t, 'tap', tap(0, 0, 0, 0, 2))));

test('TAP incomplete, duplicate and inconsistent summaries are rejected', async () => {
  const { countTests } = await import(library);
  for (const report of [tap(1).replace('# skipped 0\n', ''), tap(1) + '# tests 1\n',
    tap(1).replace('# tests 1', '# tests 0'), tap(1).replace('# pass 1', '# pass -1')]) {
    assert.throws(() => countTests(report, 'tap'));
  }
});

test('JSON recognizes Jest without numTodoTests and validates numeric totals', async () => {
  const { countTests } = await import(library);
  const oldJest = JSON.parse(json(1));
  delete oldJest.numTodoTests;
  assert.equal(countTests(JSON.stringify(oldJest), 'json'), 1);
  for (const value of [{}, [], { ...oldJest, numTotalTests: 0 },
    { ...oldJest, numPassedTests: '1' }, { ...oldJest, numPassedTests: -1 },
    { ...oldJest, numTotalTests: 1.5 }]) {
    assert.throws(() => countTests(JSON.stringify(value), 'json'));
  }
});

test('JSON collect-only assertions are not executions', t => {
  const report = { ...JSON.parse(json(1)), testResults: [
    { assertionResults: [{ status: 'passed', wouldRun: true }] },
  ] };
  notRun(run(t, 'json', JSON.stringify(report)));
});

test('JSON assertions must agree with summary counts and interrupted reports are rejected', async () => {
  const { countTests } = await import(library);
  for (const report of [
    { ...JSON.parse(json(1)), numTodoTests: null },
    { ...JSON.parse(json(1)), wasInterrupted: true },
    { ...JSON.parse(json(1)), testResults: [] },
    { ...JSON.parse(json(1)), testResults: [{ assertionResults: [{ status: 'pending' }] }] },
    { ...JSON.parse(json(1)), testResults: [{ assertionResults: [{ status: 'unknown' }] }] },
  ]) assert.throws(() => countTests(JSON.stringify(report), 'json'), JSON.stringify(report));
  const complete = { ...JSON.parse(json(1, 1, 1, 1)), testResults: [
    { assertionResults: ['passed', 'failed', 'pending', 'todo'].map(status => ({ status })) },
  ] };
  assert.equal(countTests(JSON.stringify(complete), 'json'), 2);
});

test('JUnit validates XML declarations, comments and aggregate failure counts', async () => {
  const { countTests } = await import(library);
  for (const xml of [
    '<?xml garbage?><testsuite tests="1"/>',
    '<!-- invalid---><testsuite tests="1"/>',
    '<testsuite tests="1" failures="1" skipped="1"/>',
    '<testsuite tests="1" disabled="1"><testcase/></testsuite>',
    '<testsuite tests="1" failures="1" errors="1"/>',
    '<x:testsuite tests="1"><x:testcase/></x:testsuite>',
  ]) assert.throws(() => countTests(xml, 'junit'), xml);
});

test('library counts zero and executed reports for every format', async () => {
  const { countTests } = await import(library);
  for (const [format, values] of Object.entries(reports)) {
    assert.deepEqual(values.map(value => countTests(value, format)), [0, 2, 0, 2]);
  }
});

test('library treats child output read errors as not run', async t => {
  const { runTests } = await import(library);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  t.mock.method(childProcess, 'spawn', () => {
    setImmediate(() => {
      child.stdout.destroy(new Error('output read failed'));
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.resume();
  stderr.resume();
  const result = await runTests({ command: ['example'], format: 'tap', stdout, stderr });
  assert.equal(result.exitCode, 3);
  assert.match(result.reason, /output.*read/i);
});

test('JUnit handles both roots, nested suites, skips and aggregate-only leaves', async () => {
  const { countTests } = await import(library);
  const inner = '<testsuite tests="3" skipped="1"><testsuite tests="2" skipped="1">' +
    '<testcase/><testcase><skipped/></testcase></testsuite><testsuite tests="1"/></testsuite>';
  assert.equal(countTests(inner, 'junit'), 2);
  assert.equal(countTests(`<testsuites tests="3" skipped="1">${inner}</testsuites>`, 'junit'), 2);
  assert.equal(countTests('<testsuite tests="4" skipped="1" disabled="1"/>', 'junit'), 2);
});

test('JUnit ignores markup in comments, CDATA and escaped text', async () => {
  const { countTests } = await import(library);
  const xml = '<?xml version="1.0"?>\r\n<testsuites><!-- <testcase/> -->' +
    '<testsuite tests="1"><testcase name="a &amp; b > c">' +
    '<system-out><![CDATA[<testcase/><skipped/>]]>&lt;testcase/&gt;</system-out>' +
    '</testcase></testsuite></testsuites>';
  assert.equal(countTests(xml, 'junit'), 1);
});

test('JUnit rejects malformed XML, invalid entities, contradictory counts and unsupported roots', async () => {
  const { countTests } = await import(library);
  for (const xml of [
    '<testsuite tests="1">', '<testsuite tests="1"></testsuites>',
    '<other><testcase/></other>', '<testsuite tests="1"/><testsuite tests="1"/>',
    '<testsuite tests="one"/>', '<testsuite tests="0" skipped="1"/>',
    '<testsuite tests="2"><testcase/></testsuite>', '<testsuite/>',
    '<testsuite tests="1"><testcase name="&unknown;"/></testsuite>',
    '<testsuite tests="1" tests="1"/>', '<!DOCTYPE testsuite><testsuite tests="1"/>',
    '<testsuite tests="1"><testcase><skipped/></testcase></testsuite>trailing',
  ]) assert.throws(() => countTests(xml, 'junit'), xml);
});

test('a report left by a previous run cannot turn an empty run green', t => {
  const cwd = workspace(t);
  const report = join(cwd, 'old.json');
  writeFileSync(report, json(10));
  const result = spawnSync(process.execPath, [cli, '--format', 'json', '--report', report,
    '--', process.execPath, '-e', ''], { cwd, env: childEnv, encoding: 'utf8', timeout: 15000 });
  notRun(result);
  assert.match(result.stderr, /unchanged|stale|previous/i);
});

test('a killed child with no report is not run on every platform', t => {
  notRun(run(t, 'tap', '', { kill: true }));
});

test('a killed child cannot use a complete report to claim success', { skip: process.platform === 'win32' }, t => {
  notRun(run(t, 'tap', tap(1), { kill: true }));
});

test('library cancellation after a complete report is not run, including on Windows', async t => {
  const { runTests } = await import(library);
  const output = new PassThrough();
  const error = new PassThrough();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  t.after(() => clearTimeout(timeout));
  output.on('data', () => controller.abort());
  error.resume();
  const result = await runTests({ command: [process.execPath, '-e',
    `process.stdout.write(${JSON.stringify(tap(1))}); setInterval(() => {}, 1000);`],
  format: 'tap', signal: controller.signal, stdout: output, stderr: error });
  assert.equal(result.exitCode, 3);
  assert.match(result.reason, /killed|interrupt|abort/i);
});

test('nonexistent executable is not run', t => {
  const result = spawnSync(process.execPath, [cli, '--format', 'tap', '--',
    join(workspace(t), 'missing-executable')], { env: childEnv, encoding: 'utf8', timeout: 15000 });
  notRun(result);
});

test('minimum must be a positive integer and arguments must be complete', t => {
  for (const args of [[], ['--min', '0'], ['--min', '-1'], ['--min', '1.5'],
    ['--min', '1e3'], ['--format', 'unknown'], ['--report'], ['--unknown']]) {
    const result = spawnSync(process.execPath, [cli, ...args, '--', process.execPath, '-e', ''],
      { cwd: workspace(t), env: childEnv, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 2, result.stderr);
  }
});

test('real Node runner: empty glob stays not run and nested skipped tests are excluded', t => {
  const cwd = workspace(t);
  const path = join(cwd, 'nested test.mjs');
  writeFileSync(path, `import { test, describe, it } from 'node:test';
    describe('group', () => { it('runs', () => {}); it.skip('skips', () => {}); it.todo('later'); });`);
  const args = [cli, '--format', 'tap', '--', process.execPath, '--test', '--test-reporter=tap'];
  const empty = spawnSync(process.execPath, [...args, 'absent-*.test.mjs'],
    { cwd, env: childEnv, encoding: 'utf8', timeout: 15000 });
  notRun(empty);
  const some = spawnSync(process.execPath, [...args, path], { cwd, env: childEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(some.status, 0, some.stderr);
  const threshold = spawnSync(process.execPath, [cli, '--min', '2', ...args.slice(1), path],
    { cwd, env: childEnv, encoding: 'utf8', timeout: 15000 });
  notRun(threshold);
});
