import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runWithEvidence, cpuBusyShare, sampleResources, countProcesses } from '../index.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/command.mjs', import.meta.url));
const MiB = 1024 ** 2;
const normal = { freeMemoryBytes: 500 * MiB, totalMemoryBytes: 1000 * MiB,
  cpuBusyShare: 0.2, cpuSampleMs: 1000, processCount: 20, errors: [] };
const temp = () => mkdtemp(join(tmpdir(), 'flaky evidence '));
const read = async path => JSON.parse(await readFile(path, 'utf8'));

async function scenario(codes, readings = codes.map(() => normal), options = {}) {
  const cwd = await temp();
  let executed = 0;
  let sampled = 0;
  const result = await runWithEvidence(['fake check', 'argument with spaces'], { cwd, ...options }, {
    sample: async () => readings[sampled++],
    execute: async () => ({ exitCode: codes[executed++], signal: null,
      stdoutTail: `attempt ${executed}\n`, stderrTail: executed === 1 ? 'original failure\n' : '',
      durationMs: 12, outputTruncated: false }),
  });
  return { ...result, cwd, executed, sampled, saved: await read(result.evidencePath) };
}

test('a fail then pass with equal readings is unexplained, preserving the first failure', async () => {
  const r = await scenario([7, 0]);
  assert.equal(r.evidence.classification.kind, 'unexplained');
  assert.equal(r.evidence.classification.message,
    'unexplained — possible race or order dependence, not pressure');
  assert.deepEqual(r.evidence.classification.reasons, []);
  assert.equal(r.exitCode, 7);
  assert.equal(r.executed, 2);
  assert.deepEqual(r.saved.runs.map(run => run.exitCode), [7, 0]);
  assert.equal(r.saved.runs[0].stderrTail, 'original failure\n');
  assert.equal(r.saved.runs[0].durationMs, 12);
  assert.equal(r.saved.runs[0].resources.processCount, 20);
  assert.equal(r.saved.runs[0].versions.node, process.version);
  assert.equal(typeof r.saved.runs[0].versions.os.release, 'string');
  assert.equal(r.saved.status, 'complete');
  assert.deepEqual(await readdir(r.cwd), [r.evidencePath.split(/[\\/]/).at(-1)]);
});

test('memory pressure requires a low first reading and measured recovery with numbers', async () => {
  const r = await scenario([9, 0], [{ ...normal, freeMemoryBytes: 50 * MiB }, normal]);
  assert.equal(r.evidence.classification.kind, 'pressure-suspected');
  const reason = r.evidence.classification.reasons[0];
  assert.equal(reason.metric, 'freeMemoryBytes');
  assert.equal(reason.first, 50 * MiB);
  assert.equal(reason.passed, 500 * MiB);
  assert.equal(reason.difference, 450 * MiB);
  assert.equal(reason.threshold, 150 * MiB);
  assert.match(r.evidence.classification.message, /52428800.*524288000/);
  assert.equal(r.exitCode, 9);
});

test('the evidence says resources were sampled before each attempt, not during it', async () => {
  const unexplained = await scenario([7, 0]);
  const pressure = await scenario([9, 0], [{ ...normal, freeMemoryBytes: 50 * MiB }, normal]);
  for (const r of [unexplained, pressure]) {
    assert.deepEqual(r.saved.resourceSampling, {
      when: 'before-each-attempt',
      note: 'Resources are sampled once, immediately before each attempt starts; '
        + 'they are not measured while the command runs.',
    });
    assert.equal(r.saved.classification.basis, r.saved.resourceSampling.note);
  }
  assert.match(pressure.evidence.classification.message, /before each run, not during it/);
  assert.equal(unexplained.evidence.classification.message,
    'unexplained — possible race or order dependence, not pressure');
});

test('CPU pressure includes shares, difference and recovery threshold', async () => {
  const r = await scenario([4, 0], [{ ...normal, cpuBusyShare: 0.95 }, normal]);
  assert.equal(r.evidence.classification.kind, 'pressure-suspected');
  assert.equal(r.evidence.classification.reasons[0].metric, 'cpuBusyShare');
  assert.equal(r.evidence.classification.reasons[0].first, 0.95);
  assert.equal(r.evidence.classification.reasons[0].passed, 0.2);
  assert.match(r.evidence.classification.message, /0\.95.*0\.2/);
});

test('healthy changes, reverse changes and process counts alone never imply pressure', async () => {
  for (const [first, passed] of [
    [normal, { ...normal, freeMemoryBytes: 900 * MiB, cpuBusyShare: 0 }],
    [normal, { ...normal, freeMemoryBytes: 10 * MiB, cpuBusyShare: 0.99 }],
    [{ ...normal, processCount: 2000 }, normal],
    [{ ...normal, cpuBusyShare: 0.9 }, { ...normal, cpuBusyShare: 0.85 }],
  ]) {
    const r = await scenario([1, 0], [first, passed]);
    assert.equal(r.evidence.classification.kind, 'unexplained');
  }
});

test('the original run is the comparison baseline, not a convenient intermediate failure', async () => {
  const r = await scenario([3, 2, 0], [normal, { ...normal, freeMemoryBytes: 0 }, normal]);
  assert.equal(r.evidence.classification.kind, 'unexplained');
  assert.equal(r.saved.runs.length, 3);
});

test('threshold overrides are saved and recovery must exceed the threshold', async () => {
  const readings = [{ ...normal, freeMemoryBytes: 0 }, { ...normal, freeMemoryBytes: 250 * MiB }];
  const r = await scenario([1, 0], readings, { thresholds: { memoryRecoveryRatio: 0.25 } });
  assert.equal(r.evidence.classification.kind, 'unexplained');
  assert.equal(r.saved.thresholds.memoryRecoveryRatio, 0.25);
});

test('persistent failure exhausts exactly N reruns and keeps every attempt', async () => {
  const r = await scenario([6, 7, 8, 9], undefined, { times: 3 });
  assert.equal(r.evidence.classification.kind, 'consistent-failure');
  assert.equal(r.executed, 4);
  assert.equal(r.sampled, 4);
  assert.deepEqual(r.saved.runs.map(run => run.exitCode), [6, 7, 8, 9]);
  assert.equal(r.exitCode, 6);
});

test('an initial pass does not rerun; zero reruns still keeps a failure', async () => {
  const passed = await scenario([0, 1]);
  assert.equal(passed.executed, 1);
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.evidence.classification.kind, 'passed');
  const failed = await scenario([5, 0], undefined, { times: 0 });
  assert.equal(failed.executed, 1);
  assert.equal(failed.exitCode, 5);
});

test('strict unexplained policy uses a distinct nonzero exit without erasing the first code', async () => {
  const r = await scenario([7, 0], undefined, { failOnUnexplained: true });
  assert.equal(r.exitCode, 1);
  assert.equal(r.saved.firstExitCode, 7);
  assert.equal(r.saved.exitCode, 1);
  const explained = await scenario([7, 0], [{ ...normal, freeMemoryBytes: 0 }, normal],
    { failOnUnexplained: true });
  assert.equal(explained.exitCode, 7);
});

test('missing, invalid or failed resource readings never invent pressure', async () => {
  for (const missing of [null, {}, { ...normal, freeMemoryBytes: NaN, cpuBusyShare: Infinity },
    { ...normal, freeMemoryBytes: -1, cpuBusyShare: -1 }]) {
    const r = await scenario([1, 0], [missing, normal]);
    assert.equal(r.evidence.classification.kind, 'unexplained');
  }
  const cwd = await temp();
  let run = 0;
  const r = await runWithEvidence(['fake'], { cwd }, {
    sample: async () => { throw new Error('readings unavailable'); },
    execute: async () => ({ exitCode: run++ === 0 ? 1 : 0, durationMs: 1 }),
  });
  assert.equal(r.evidence.classification.kind, 'unexplained');
  assert.match(r.evidence.runs[0].resources.errors.join(' '), /readings unavailable/);
});

test('failure is on disk before the next resource sample or command', async () => {
  const cwd = await temp();
  const evidencePath = join(cwd, 'evidence.json');
  let runs = 0;
  await runWithEvidence(['fake'], { cwd, evidencePath }, {
    sample: async () => {
      if (runs) assert.equal((await read(evidencePath)).runs[0].stderrTail, 'first failure');
      return normal;
    },
    execute: async () => ({ exitCode: runs++ ? 0 : 2, stderrTail: 'first failure', durationMs: 1 }),
  });
});

test('existing evidence is never overwritten and command never starts on path collision', async () => {
  const cwd = await temp();
  const evidencePath = join(cwd, 'existing.json');
  await writeFile(evidencePath, 'original');
  await assert.rejects(runWithEvidence(['fake'], { cwd, evidencePath }, {
    execute: () => assert.fail('must not run'), sample: async () => normal,
  }), { code: 'EEXIST' });
  assert.equal(await readFile(evidencePath, 'utf8'), 'original');
});

test('invalid command, counts and thresholds fail before running or writing evidence', async () => {
  const cwd = await temp();
  for (const command of [[], [''], ['node', 1], 'node', ['node', '\0']]) {
    await assert.rejects(runWithEvidence(command, { cwd }), /command/);
  }
  for (const options of [{ times: -1 }, { times: 1.5 }, { times: Infinity },
    { tailLines: 0 }, { tailBytes: 0 }, { failOnUnexplained: 'yes' },
    { thresholds: { cpuHighShare: NaN } }, { thresholds: { typo: 1 } }]) {
    await assert.rejects(runWithEvidence(['fake'], { cwd, ...options }));
  }
  assert.deepEqual(await readdir(cwd), []);
});

const cpu = (user, idle, sys = 0) => ({ times: { user, idle, sys, nice: 0, irq: 0 } });

test('Windows CPU times measure busy share across cores without loadavg', async () => {
  const before = [cpu(100, 100), cpu(200, 100)];
  const after = [cpu(140, 160, 10), cpu(270, 130, 20)];
  assert.equal(cpuBusyShare(before, after), 140 / 230);
  let snapshots = 0;
  let clock = 0;
  const r = await sampleResources({
    cpus: () => snapshots++ ? after : before,
    freemem: () => 123, totalmem: () => 456,
    countProcesses: async () => 8,
    sleep: async ms => { assert.equal(ms, 1000); clock += ms; },
    clock: () => clock,
  });
  assert.equal(r.cpuBusyShare, 140 / 230);
  assert.equal(r.cpuSampleMs, 1000);
  assert.equal(r.freeMemoryBytes, 123);
  assert.equal(r.processCount, 8);
});

test('CPU counter resets, missing cores and zero elapsed ticks yield unknown, not idle', () => {
  for (const [before, after] of [[[], []], [[cpu(1, 2)], [cpu(1, 2)]],
    [[cpu(5, 6)], [cpu(4, 9)]], [[cpu(1, 2)], []],
    [[cpu(1, 2)], [cpu(NaN, 4)]]]) assert.equal(cpuBusyShare(before, after), null);
});

test('failed process counting does not discard memory or CPU measurements', async () => {
  let n = 0;
  const r = await sampleResources({ cpus: () => [cpu(n++ * 10, 100)],
    freemem: () => 100, totalmem: () => 200, sleep: async () => {},
    countProcesses: async () => { throw new Error('denied'); } });
  assert.equal(r.processCount, null);
  assert.equal(r.freeMemoryBytes, 100);
  assert.equal(r.cpuBusyShare, 1);
  assert.match(r.errors.join(' '), /denied/);
});

test('Windows tasklist CSV and Unix ps PID counts are best effort and injectable', async () => {
  const windows = await countProcesses({ platform: 'win32', exec: async (file, args, options) => {
    assert.equal(file, 'tasklist.exe');
    assert.deepEqual(args, ['/FO', 'CSV', '/NH']);
    assert.equal(options.shell, false);
    assert.ok(options.timeout > 0);
    return { stdout: '"System Idle Process","0","Services","0","8 K"\r\n"check, worker.exe","42","Console","1","100 K"\r\n' };
  } });
  assert.equal(windows, 2);
  assert.equal(await countProcesses({ platform: 'linux', exec: async (file, args) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-e', '-o', 'pid=']);
    return { stdout: '  1\n  27\n99\n' };
  } }), 3);
  for (const stdout of ['', 'access denied', 'INFO: unavailable\r\n']) {
    assert.equal(await countProcesses({ platform: 'win32', exec: async () => ({ stdout }) }), null);
  }
  assert.equal(await countProcesses({ exec: async () => { throw new Error('no ps'); } }), null);
});

test('real commands fail then pass, fail always and pass always without a shell', async () => {
  for (const [mode, kind, codes] of [['flaky', 'unexplained', [7, 0]],
    ['fail', 'consistent-failure', [7, 7, 7]], ['pass', 'passed', [0]]]) {
    const cwd = await temp();
    const r = await runWithEvidence([process.execPath, fixture, mode, join(cwd, 'state with spaces')],
      { cwd }, { sample: async () => normal });
    assert.equal(r.evidence.classification.kind, kind);
    assert.deepEqual(r.evidence.runs.map(run => run.exitCode), codes);
    assert.equal(r.exitCode, codes[0]);
    assert.match(r.evidence.runs[0].stdoutTail, /attempt 1/);
    assert.ok(r.evidence.runs[0].durationMs >= 0);
    if (mode !== 'pass') assert.match(r.evidence.runs[0].stderrTail, /original failure/);
  }
});

test('arguments remain literal, CRLF is normalized and output tails stay bounded', async () => {
  const cwd = await temp();
  const argument = 'spaces & ; | $HOME "quoted" %PATH%';
  const r = await runWithEvidence([process.execPath, '-e',
    'process.stdout.write("old\\r\\n" + process.argv[1] + "\\r\\nlast\\r\\n"); process.stderr.write("x".repeat(10000))', argument],
  { cwd, tailLines: 2, tailBytes: 100 }, { sample: async () => normal });
  assert.equal(r.evidence.runs[0].stdoutTail, `${argument}\nlast\n`);
  assert.ok(Buffer.byteLength(r.evidence.runs[0].stderrTail) <= 100);
  assert.equal(r.evidence.runs[0].outputTruncated, true);
});

test('spawn errors remain evidence and never turn into a pass', async () => {
  const cwd = await temp();
  const r = await runWithEvidence([join(cwd, 'missing-executable')], { cwd, times: 0 },
    { sample: async () => normal });
  assert.equal(r.exitCode, 127);
  assert.equal(r.evidence.runs[0].spawnError.code, 'ENOENT');
  assert.equal(r.evidence.classification.kind, 'consistent-failure');
});

test('CLI preserves first exit, writes a JSON file and leaves command flags alone', async () => {
  const cwd = await temp();
  const result = spawnSync(process.execPath, [cli, '--times', '0', '--', process.execPath,
    '-e', 'console.error("original failure"); process.exit(7)'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /consistent failure/);
  const files = await readdir(cwd);
  assert.equal(files.length, 1);
  const evidence = await read(join(cwd, files[0]));
  assert.equal(evidence.runs[0].exitCode, 7);
  assert.match(evidence.runs[0].stderrTail, /original failure/);
});

test('CLI help and malformed options do not execute a command or write evidence', async () => {
  const cwd = await temp();
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--fail-on-unexplained/);
  for (const args of [[], ['--times', '-1', '--', process.execPath],
    ['--times', '1.5', '--', process.execPath], ['--unknown', '--', process.execPath], ['--']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /flaky-evidence/);
  }
  assert.deepEqual(await readdir(cwd), []);
});
