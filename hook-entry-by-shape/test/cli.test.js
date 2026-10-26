import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from './temp.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
function run(...args) {
  const dir = temporaryDirectory('hook-cli-output-');
  const stdoutPath = path.join(dir, 'stdout');
  const stderrPath = path.join(dir, 'stderr');
  const stdout = fs.openSync(stdoutPath, 'wx');
  const stderr = fs.openSync(stderrPath, 'wx');
  try {
    const result = spawnSync(process.execPath, [cli, ...args], { stdio: ['ignore', stdout, stderr], shell: false });
    if (result.error) throw result.error;
    return { ...result, stdout: fs.readFileSync(stdoutPath, 'utf8'), stderr: fs.readFileSync(stderrPath, 'utf8') };
  } finally {
    fs.closeSync(stdout); fs.closeSync(stderr);
    fs.unlinkSync(stdoutPath); fs.unlinkSync(stderrPath); fs.rmdirSync(dir);
  }
}

test('CLI runs install/find/repair/remove with spaced paths and JSON arguments', t => {
  const dir = temporaryDirectory('hook cli ');
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const file = path.join(dir, 'settings file.json');
  const entryFile = path.join(dir, 'entry file.json');
  fs.writeFileSync(entryFile, '\uFEFF' + JSON.stringify({ event: 'Stop', command: 'node "C:\\Hook Folder\\Check.js"' }) + '\r\n');
  let result = run('install', file, entryFile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).added, 1);
  result = run('install', file, entryFile, '--platform', 'win32');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, false);
  const settings = JSON.parse(fs.readFileSync(file));
  settings.hooks.Stop.push(settings.hooks.Stop[0]);
  fs.writeFileSync(file, JSON.stringify(settings));
  result = run('find', file, entryFile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).length, 2);
  result = run('repair', file, entryFile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).removed, 1);
  result = run('remove', file, entryFile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).removed, 1);
  assert.deepEqual(JSON.parse(run('find', file, entryFile).stdout), []);
});

test('CLI help succeeds; bad usage and operational errors are visible and nonzero', () => {
  assert.equal(run('--help').status, 0);
  for (const args of [[], ['unknown'], ['toString', 'a', 'b'], ['install', 'a', 'b', '--unknown', 'x']]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
  const result = run('install', 'missing-settings.json', 'missing-entry.json');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hook-entry-by-shape:/);
});
