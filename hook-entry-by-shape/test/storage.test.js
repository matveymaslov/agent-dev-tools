import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { install, remove, find } from '../index.js';
import { backupsOf, temporaryDirectory } from './temp.js';

const entry = { event: 'Stop', command: 'node check.js' };
function fixture(t, original = '{ "permissions": {"allow": ["Read"]} }\r\n') {
  const dir = temporaryDirectory('shape-storage-');
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, original);
  return { file, dir, original };
}

test('replacement uses a complete same-directory temp file and backs up exact bytes first', t => {
  const { file, original } = fixture(t);
  const rename = fs.renameSync;
  const calls = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls.push(to);
    assert.equal(path.dirname(from), path.dirname(to));
    assert.match(path.basename(from), /\.tmp$/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    if (to === file) {
      assert.equal(fs.readFileSync(calls[0], 'utf8'), original);
      const candidate = JSON.parse(fs.readFileSync(from));
      assert.equal(candidate.hooks.Stop[0].hooks[0].command, entry.command);
    }
    rename(from, to);
  });
  const { backupPath } = install(file, entry);
  assert.deepEqual(calls, [backupPath, file]);
  assert.equal(path.dirname(backupPath), path.dirname(file));
  assert.match(path.basename(backupPath), /^settings\.json\.\d{8}T\d{9}Z(-\d+)?\.bak$/);
});

for (const operation of ['writeFileSync', 'fsyncSync', 'backup rename', 'settings rename']) {
  test(`failure during ${operation} leaves the original intact and cleans temp files`, t => {
    const { file, dir, original } = fixture(t);
    if (operation.endsWith('rename')) {
      const rename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (from, to) => {
        if (operation === 'backup rename' ? to !== file : to === file) throw new Error('injected write failure');
        rename(from, to);
      });
    } else t.mock.method(fs, operation, () => { throw new Error('injected write failure'); });
    assert.throws(() => install(file, entry), /injected write failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
    for (const backup of backupsOf(file)) assert.equal(fs.readFileSync(backup, 'utf8'), original);
  });
}

test('no-op operations leave both settings and the previous backup byte-identical', t => {
  const { file, original } = fixture(t);
  install(file, entry);
  const first = fs.readFileSync(file, 'utf8');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('must not write'); });
  assert.equal(install(file, entry).changed, false);
  assert.equal(find(file, entry).length, 1);
  assert.equal(rename.mock.callCount(), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.deepEqual(backupsOf(file).map(backup => fs.readFileSync(backup, 'utf8')), [original]);
  rename.mock.restore();
  remove(file, entry);
  assert.deepEqual(backupsOf(file).map(backup => fs.readFileSync(backup, 'utf8')).sort(),
    [original, first].sort());
});

test('every write keeps its own backup, so the pristine file survives later writes', t => {
  const { file, original } = fixture(t);
  const other = { event: 'Stop', command: 'node other.js' };
  const states = [original];
  install(file, entry); states.push(fs.readFileSync(file, 'utf8'));
  install(file, other); states.push(fs.readFileSync(file, 'utf8'));
  remove(file, entry); states.push(fs.readFileSync(file, 'utf8'));
  const backups = backupsOf(file);
  assert.equal(backups.length, 3);
  assert.equal(new Set(backups).size, 3);
  // Names sort in write order and hold the bytes that preceded each write.
  assert.deepEqual(backups.map(backup => fs.readFileSync(backup, 'utf8')), states.slice(0, 3));
  assert.notEqual(fs.readFileSync(file, 'utf8'), states[0]);
});

test('two writes in the same millisecond get distinct backup names', t => {
  const { file, original } = fixture(t);
  t.mock.method(Date.prototype, 'toISOString', () => '2026-01-02T03:04:05.006Z');
  install(file, entry);
  const afterFirst = fs.readFileSync(file, 'utf8');
  install(file, { event: 'Stop', command: 'node other.js' });
  const dir = path.dirname(file);
  assert.deepEqual(backupsOf(file).map(backup => path.basename(backup)),
    ['settings.json.20260102T030405006Z-1.bak', 'settings.json.20260102T030405006Z.bak']);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json.20260102T030405006Z.bak'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json.20260102T030405006Z-1.bak'), 'utf8'), afterFirst);
});

test('install creates a missing settings folder, and other operations do not', t => {
  const root = temporaryDirectory('shape-missing-');
  const folder = path.join(root, 'nested', 'claude');
  const file = path.join(folder, 'settings.json');
  t.after(() => {
    for (const target of [file, folder, path.dirname(folder), root]) {
      try { (fs.lstatSync(target).isDirectory() ? fs.rmdirSync : fs.unlinkSync)(target); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  });
  assert.deepEqual(find(file, entry), []);
  assert.equal(remove(file, entry).changed, false);
  assert.equal(fs.existsSync(path.dirname(folder)), false);
  assert.deepEqual(install(file, entry), { changed: true, added: 1, backupPath: null });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop[0].hooks[0].command, entry.command);
  assert.deepEqual(fs.readdirSync(folder), ['settings.json']);
});

test('POSIX mode is retained for settings and backup', { skip: process.platform === 'win32' }, t => {
  const { file } = fixture(t);
  fs.chmodSync(file, 0o640);
  install(file, entry);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(fs.statSync(backupsOf(file)[0]).mode & 0o777, 0o640);
});

test('invalid UTF-8 is never silently replaced', t => {
  const { file } = fixture(t);
  const bytes = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
  fs.writeFileSync(file, bytes);
  assert.throws(() => install(file, entry));
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('a failed exclusive temp open never deletes an existing file', t => {
  const { file, original } = fixture(t);
  const open = fs.openSync;
  let collision;
  t.mock.method(fs, 'openSync', (name, flags, ...rest) => {
    if (flags === 'wx') {
      collision = name;
      const fd = open(name, 'wx', ...rest);
      fs.writeFileSync(fd, 'existing temp');
      fs.closeSync(fd);
    }
    return open(name, flags, ...rest);
  });
  assert.throws(() => install(file, entry), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(collision, 'utf8'), 'existing temp');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('symlinks are rejected without replacing the link or its target', { skip: process.platform === 'win32' }, t => {
  const { file, dir, original } = fixture(t);
  const link = path.join(dir, 'linked.json');
  fs.symlinkSync(file, link);
  assert.throws(() => install(link, entry), /regular file/);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
