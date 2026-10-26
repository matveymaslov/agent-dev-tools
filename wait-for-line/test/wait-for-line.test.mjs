import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../bin/wait-for-line.mjs', import.meta.url));

async function fixture(t, initial = '') {
  const dir = await fs.mkdtemp(join(tmpdir(), 'wait for line-'));
  const file = join(dir, 'worker log ü.txt');
  await fs.writeFile(file, initial);
  t.after(async () => {
    for (const name of await fs.readdir(dir)) await fs.unlink(join(dir, name));
    await fs.rmdir(dir);
  });
  return file;
}

function run(t, file, pattern = '^DONE$', options = {}, stdio = ['ignore', 'pipe', 'pipe']) {
  const args = ['--file', file, '--pattern', pattern];
  for (const [key, value] of Object.entries({ timeout: '4s', interval: '10ms', grace: '200ms', ...options })) {
    args.push(`--${key}`);
    if (value !== true) args.push(String(value));
  }
  // Files also work in sandboxes without usable child-process pipe capture.
  const outputDir = mkdtempSync(join(tmpdir(), 'wait output-'));
  const output = [join(outputDir, 'stdout'), join(outputDir, 'stderr')];
  const descriptors = output.map(path => openSync(path, 'w'));
  const childStdio = stdio.map((value, index) => value === 'pipe' ? descriptors[index - 1] : value);
  const child = spawn(process.execPath, [cli, ...args], { stdio: childStdio, shell: false });
  descriptors.forEach(closeSync);
  const state = { child, closed: false,
    get stdout() { return readFileSync(output[0], 'utf8'); },
    get stderr() { return readFileSync(output[1], 'utf8'); },
  };
  state.result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      state.closed = true;
      resolve({ code, signal, stdout: state.stdout, stderr: state.stderr });
    });
  });
  t.after(async () => {
    if (!state.closed) child.kill();
    await state.result;
    output.forEach(unlinkSync);
    rmdirSync(outputDir);
  });
  return state;
}

async function until(state, pattern) {
  const deadline = performance.now() + 6000;
  while (!pattern.test(state.stderr)) {
    assert.equal(state.closed, false, `Process exited before ${pattern}: ${state.stderr}`);
    assert.ok(performance.now() < deadline, `No ${pattern}: ${state.stderr}`);
    await delay(10);
  }
}

async function success(state, line = 'DONE') {
  const result = await state.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, `${line}\n`);
}

test('ignores existing matches and succeeds only on a new complete line', async t => {
  const file = await fixture(t, 'DONE\nold data\n');
  const state = run(t, file);
  await until(state, /Armed at byte/);
  await delay(60);
  assert.equal(state.closed, false);
  assert.equal(state.stdout, '');
  await fs.appendFile(file, 'DONE\n');
  await success(state);
});

test('a matching line split across writes waits for LF', async t => {
  const file = await fixture(t);
  const state = run(t, file);
  await until(state, /Armed at byte/);
  await fs.appendFile(file, 'DO');
  await delay(50);
  await fs.appendFile(file, 'NE');
  await delay(50);
  assert.equal(state.closed, false);
  assert.equal(state.stdout, '');
  await fs.appendFile(file, '\n');
  await success(state);
});

test('CRLF and a UTF-8 character split between writes are decoded intact', async t => {
  const file = await fixture(t, 'é\r\n');
  const state = run(t, file, '^DONE café ☕$');
  await until(state, /Armed at byte 4/);
  const bytes = Buffer.from('DONE café ☕\r');
  await fs.appendFile(file, bytes.subarray(0, 9));
  await delay(50);
  await fs.appendFile(file, bytes.subarray(9));
  await delay(50);
  assert.equal(state.closed, false);
  await fs.appendFile(file, '\n');
  await success(state, 'DONE café ☕');
});

test('the partial line already present at arming cannot become a fresh match', async t => {
  const file = await fixture(t, 'old prefix ');
  const state = run(t, file, 'DONE');
  await until(state, /Armed at byte/);
  await fs.appendFile(file, 'DONE\n');
  await delay(60);
  assert.equal(state.closed, false);
  await fs.appendFile(file, 'new DONE\r\n');
  await success(state, 'new DONE');
});

test('replacement is followed from the new start and partial old data is discarded', async t => {
  const file = await fixture(t, 'history\n');
  const state = run(t, file);
  await until(state, /Armed at byte/);
  await fs.appendFile(file, 'DO');
  await delay(50);
  await fs.rename(file, `${file}.old`);
  await fs.writeFile(file, 'NE\n');
  await until(state, /replaced.*start/i);
  await delay(50);
  assert.equal(state.closed, false, 'Fragments from different files must not join');
  await fs.appendFile(file, 'DONE\n');
  await success(state);
  assert.match(state.stderr, /replaced.*start/i);
});

test('truncation is followed from the new start and clears buffered fragments', async t => {
  const file = await fixture(t, `${'history '.repeat(40)}\n`);
  const state = run(t, file);
  await until(state, /Armed at byte/);
  await fs.appendFile(file, 'DO');
  await delay(50);
  await fs.truncate(file, 0);
  await until(state, /truncated.*start/i);
  await fs.appendFile(file, 'NE\n');
  await delay(50);
  assert.equal(state.closed, false, 'A fragment from before truncation must be discarded');
  await fs.appendFile(file, 'DONE\n');
  await success(state);
});

test('truncate and regrow beyond the old offset between polls is detected', async t => {
  const file = await fixture(t, 'old history\n');
  const state = run(t, file, '^DONE$', { interval: '200ms' });
  await until(state, /Armed at byte/);
  await fs.writeFile(file, `DONE\n${'new history '.repeat(20)}\n`);
  await success(state);
  assert.match(state.stderr, /truncated|rewritten/i);
});

test('timeout exits 2 with no match on stdout, even when interval exceeds timeout', async t => {
  const file = await fixture(t, 'DONE\n');
  const state = run(t, file, '^DONE$', { timeout: '80ms', interval: '1h' });
  const result = await state.result;
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /timed out/i);
});

test('a vanished file exits 3 after its grace period', async t => {
  const file = await fixture(t);
  const state = run(t, file);
  await until(state, /Armed at byte/);
  await fs.unlink(file);
  const result = await state.result;
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /missing/i);
  assert.match(result.stderr, /grace/i);
});

test('a missing file that returns during grace is followed', async t => {
  const file = await fixture(t);
  const state = run(t, file, '^DONE$', { grace: '2s' });
  await until(state, /Armed at byte/);
  await fs.rename(file, `${file}.old`);
  await until(state, /missing/i);
  await fs.writeFile(file, 'DONE\r\n');
  await success(state);
  assert.match(state.stderr, /returned/i);
});

test('a file that does not exist yet is awaited until the timeout, not the grace period', async t => {
  const file = await fixture(t);
  await fs.unlink(file);
  const started = performance.now();
  const result = await run(t, file, '^DONE$', { grace: '50ms', timeout: '700ms' }).result;
  assert.equal(result.code, 2, result.stderr);
  assert.ok(performance.now() - started >= 600, 'waited well past the 50 ms grace');
  assert.match(result.stderr, /does not exist yet/i);
  assert.match(result.stderr, /timed out/i);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('a file created long after the grace period has passed is still followed', async t => {
  const file = await fixture(t);
  await fs.unlink(file);
  const state = run(t, file, '^DONE$', { grace: '50ms' });
  await until(state, /does not exist yet/i);
  await delay(500);
  assert.equal(state.closed, false, state.stderr);
  await fs.writeFile(file, 'OLD\n');
  await until(state, /Armed at byte/);
  assert.match(state.stderr, /appeared/i);
  await fs.appendFile(file, 'DONE\n');
  await success(state);
});

test('a file that was seen and then removed still exits 3 after the grace period', async t => {
  const file = await fixture(t);
  const state = run(t, file, '^DONE$', { grace: '100ms', timeout: '4s' });
  await until(state, /Armed at byte/);
  await fs.unlink(file);
  const result = await state.result;
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /grace/i);
});

test('first appearance establishes the arming offset, skipping existing lines', async t => {
  const file = await fixture(t);
  await fs.unlink(file);
  const state = run(t, file, '^DONE$', { grace: '2s' });
  await until(state, /does not exist yet/i);
  await fs.writeFile(file, 'DONE\n');
  await until(state, /Armed at byte/);
  await delay(50);
  assert.equal(state.closed, false);
  await fs.appendFile(file, 'DONE\n');
  await success(state);
});

test('diagnostics warn about unanchored patterns without quoting the trigger or writing the log', async t => {
  const file = await fixture(t, 'history\n');
  const state = run(t, file, 'DONE');
  await until(state, /Armed at byte/);
  assert.match(state.stderr, /not fully anchored/i);
  assert.equal(state.stderr.includes('DONE'), false);
  assert.equal(await fs.readFile(file, 'utf8'), 'history\n');
  await fs.appendFile(file, 'DONE\n');
  await success(state);
});

test('dry-run shows numbered existing matches, including a partial self-message, without arming', async t => {
  const initial = 'noise\r\nDONE\r\narmed: waiting for DONE';
  const file = await fixture(t, initial);
  const result = await run(t, file, 'DONE', { 'dry-run': true }).result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '2: DONE\n3: armed: waiting for DONE\n');
  assert.doesNotMatch(result.stderr, /Armed at byte/);
  assert.equal(await fs.readFile(file, 'utf8'), initial);
});

test('dry-run with no matches exits successfully and says so', async t => {
  const file = await fixture(t, 'noise\n');
  const result = await run(t, file, '^DONE$', { 'dry-run': true }).result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no existing lines/i);
});

test('invalid regex, unknown options and invalid durations exit 1', async t => {
  const file = await fixture(t);
  for (const [pattern, options] of [['[', {}], ['DONE', { interval: '0ms' }], ['DONE', { timeout: '-1s' }], ['DONE', { timeout: '2hours' }], ['DONE', { surprise: true }]]) {
    const result = await run(t, file, pattern, options).result;
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Armed at byte/);
  }
});

test('refuses diagnostics or match output redirected into the watched file', async t => {
  const file = await fixture(t, 'history\n');
  for (const fd of [1, 2]) {
    const handle = await fs.open(file, 'a');
    try {
      const stdio = ['ignore', 'pipe', 'pipe'];
      stdio[fd] = handle.fd;
      const result = await run(t, file, 'DONE', {}, stdio).result;
      assert.equal(result.code, 1);
      assert.equal(await fs.readFile(file, 'utf8'), 'history\n');
    } finally {
      await handle.close();
    }
  }
});

test('an open writer can append while the reader waits', async t => {
  const file = await fixture(t);
  const writer = await fs.open(file, 'a');
  try {
    const state = run(t, file);
    await until(state, /Armed at byte/);
    await writer.write('DONE\n');
    await success(state);
  } finally {
    await writer.close();
  }
});

test('library returns a line and resets stateful regexes without changing the caller regex', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  const pattern = /^DONE$/g;
  pattern.lastIndex = 50;
  const waiting = waitForLine({ file, pattern, interval: 5, timeout: 2000,
    onEvent(event) { if (event.type === 'armed') void fs.appendFile(file, 'noise\nDONE\r\n'); },
  });
  assert.equal(await waiting, 'DONE');
  assert.equal(pattern.lastIndex, 50);
});

test('library retries transient busy open and read errors without losing a partial line', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  const realOpen = fs.open.bind(fs);
  let opens = 0;
  let reads = 0;
  const events = [];
  const writes = [];
  t.mock.method(fs, 'open', async (...args) => {
    if (++opens <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      if (++reads === 1) throw Object.assign(new Error('busy read'), { code: 'EAGAIN' });
      return read(...readArgs);
    };
    return handle;
  });
  const result = await waitForLine({ file, pattern: '^DONE$', interval: 5, timeout: 2000,
    onEvent(event) {
      events.push(event.type);
      if (event.type === 'armed') writes.push(fs.appendFile(file, 'DONE\n'));
    },
  });
  await Promise.all(writes);
  assert.equal(result, 'DONE');
  assert.ok(opens >= 4);
  assert.ok(reads >= 2);
  assert.ok(events.includes('busy'));
});

test('library timeout, gone and permission failures remain distinct', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  await assert.rejects(waitForLine({ file, pattern: '^DONE$', interval: 5, timeout: 30, onEvent() {} }), { exitCode: 2 });
  // Seen, then removed: the grace period applies and the code is 3.
  let armed;
  const sawArmed = new Promise(resolve => { armed = resolve; });
  const gone = waitForLine({ file, pattern: '^DONE$', interval: 5, grace: 30, timeout: 5000,
    onEvent(event) { if (event.type === 'armed') armed(); } });
  const outcome = assert.rejects(gone, { code: 'FILE_GONE', exitCode: 3 });
  await sawArmed;
  await fs.unlink(file);
  await outcome;
  // Never seen: no grace limit, so the overall timeout ends the wait with code 2.
  const events = [];
  await assert.rejects(waitForLine({ file, pattern: '^DONE$', interval: 5, grace: 10, timeout: 200,
    onEvent(event) { events.push(event.type); } }), { code: 'TIMEOUT', exitCode: 2 });
  assert.deepEqual(events, ['missing']);
  t.mock.method(fs, 'open', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  await assert.rejects(waitForLine({ file, pattern: '^DONE$', interval: 5, timeout: 30, onEvent() {} }), { code: 'EACCES' });
});

test('library supports aborting a long polling sleep', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  const controller = new AbortController();
  const waiting = waitForLine({ file, pattern: '^DONE$', interval: 3600000, signal: controller.signal,
    onEvent(event) { if (event.type === 'armed') controller.abort(); },
  });
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('a matching line spanning multiple read chunks stays intact', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  const line = `BEGIN ${'x'.repeat(140000)} END`;
  let write;
  const waiting = waitForLine({ file, pattern: '^BEGIN x+ END$', interval: 5, timeout: 2000,
    onEvent(event) { if (event.type === 'armed') write = fs.appendFile(file, `${line}\n`); },
  });
  assert.equal(await waiting, line);
  await write;
});

test('busy retry preserves an already consumed partial line', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  const realOpen = fs.open.bind(fs);
  let sawPartial = false;
  let injected = false;
  let write;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      if (sawPartial && !injected) {
        injected = true;
        await fs.appendFile(file, 'NE\n');
        throw Object.assign(new Error('temporarily locked'), { code: 'EBUSY' });
      }
      const result = await read(...readArgs);
      if (result.bytesRead === 2 && result.buffer.subarray(0, 2).toString() === 'DO') sawPartial = true;
      return result;
    };
    return handle;
  });
  const result = await waitForLine({ file, pattern: '^DONE$', interval: 5, timeout: 2000,
    onEvent(event) { if (event.type === 'armed') write = fs.appendFile(file, 'DO'); },
  });
  await write;
  assert.equal(result, 'DONE');
  assert.equal(injected, true);
});

test('busy reads are a timeout, not a vanished file', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  t.mock.method(fs, 'open', async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); });
  await assert.rejects(waitForLine({ file, pattern: '^DONE$', interval: 5, grace: 10, timeout: 40, onEvent() {} }), { exitCode: 2 });
});

test('dry-run retries a busy file and resets global regex state per line', async t => {
  const { dryRun } = await import('../index.mjs');
  const file = await fixture(t, 'DONE\r\nDONE\nDONE');
  const realOpen = fs.open.bind(fs);
  let attempts = 0;
  t.mock.method(fs, 'open', async (...args) => {
    if (++attempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realOpen(...args);
  });
  const matches = [];
  for await (const match of dryRun({ file, pattern: /^DONE$/g, interval: 5, onEvent() {} })) matches.push(match);
  assert.deepEqual(matches, [1, 2, 3].map(lineNumber => ({ lineNumber, line: 'DONE' })));
  assert.equal(attempts, 2);
});

test('anchor warnings catch escaped dollars and unanchored alternatives', async t => {
  const { dryRun } = await import('../index.mjs');
  const file = await fixture(t);
  for (const [pattern, expected] of [['^DONE$', false], ['^(DONE|FAIL)$', false], ['^DONE$|^FAIL$', false], ['^DONE$|FAIL', true], ['^DONE\\$', true], ['DONE', true]]) {
    const events = [];
    for await (const match of dryRun({ file, pattern, onEvent(event) { events.push(event); } })) assert.fail(JSON.stringify(match));
    assert.equal(events.some(event => event.type === 'warning'), expected, pattern);
  }
});

test('missing grace is reset after recovery and overall timeout still applies', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  const realOpen = fs.open.bind(fs);
  let opens = 0;
  const events = [];
  t.mock.method(fs, 'open', async (...args) => {
    opens++;
    if (opens >= 2 && opens <= 4) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return realOpen(...args);
  });
  // Wide margins: the file is "missing" for about three polls (tens of ms), far below
  // the 1 s grace, and the wait must then run past that grace (to the 2.5 s timeout)
  // for a grace period that was not reset to show up as exit 3.
  await assert.rejects(waitForLine({ file, pattern: '^DONE$', interval: 10, grace: 1000, timeout: 2500,
    onEvent(event) { events.push(event.type); },
  }), { exitCode: 2 });
  assert.ok(events.includes('missing'));
  assert.ok(events.includes('returned'));
});

test('a file that appears after the watcher started is armed only when it first appears', async t => {
  const { waitForLine } = await import('../index.mjs');
  const file = await fixture(t);
  await fs.unlink(file);
  const types = [];
  const waiting = waitForLine({ file, pattern: '^DONE$', interval: 5, grace: 10, timeout: 5000,
    onEvent(event) { types.push(event.type); } });
  await delay(150);
  assert.deepEqual(types, ['missing']);
  await fs.writeFile(file, 'old\n');
  while (!types.includes('armed')) await delay(5);
  assert.deepEqual(types, ['missing', 'returned', 'armed']);
  await fs.appendFile(file, 'DONE\n');
  assert.equal(await waiting, 'DONE');
});
