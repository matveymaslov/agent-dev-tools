import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { install, find, remove, repair } from '../index.js';
import { backupsOf, temporaryDirectory } from './temp.js';

const entry = { event: 'PreToolUse', matcher: 'Bash', command: 'node "/opt/hooks/check.js"' };
const own = { type: 'command', command: entry.command };
const group = (hooks, matcher = 'Bash') => ({ matcher, hooks });
function fixture(t, content = '{}\n') {
  const dir = temporaryDirectory('hook-shape-');
  // Only files this fixture created are removed; no recursive directory removal.
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const file = path.join(dir, 'settings.json');
  if (content !== null) fs.writeFileSync(file, content);
  return file;
}
const read = file => fs.readFileSync(file, 'utf8');

test('install is idempotent, including after a marker-stripping re-save', t => {
  const file = fixture(t);
  assert.equal(install(file, entry).changed, true);
  const once = read(file);
  assert.equal(install(file, entry).changed, false);
  assert.equal(read(file), once);
  const settings = JSON.parse(once);
  settings.hooks.PreToolUse[0].legacyMarker = 'old-installer';
  settings.hooks.PreToolUse[0].hooks[0].legacyMarker = true;
  fs.writeFileSync(file, JSON.stringify(settings));
  assert.equal(find(file, entry).length, 1);
  delete settings.hooks.PreToolUse[0].legacyMarker;
  delete settings.hooks.PreToolUse[0].hooks[0].legacyMarker;
  fs.writeFileSync(file, JSON.stringify(settings));
  assert.equal(install(file, entry).changed, false);
  assert.equal(find(file, entry).length, 1);
});

test('repair keeps the first matching handler and remove preserves mixed groups', t => {
  const other = { type: 'command', command: 'node /opt/hooks/other.js', timeout: 12 };
  const prompt = { type: 'prompt', prompt: 'Check the output.' };
  const settings = { permissions: { allow: ['Read'] }, hooks: {
    PreToolUse: [group([{ ...own, timeout: 9, legacy: true }, other, own]),
      { ...group([own, prompt]), legacy: 'keep' }, group([own]), group([own], 'Write')],
    Stop: [group([own])],
  } };
  const file = fixture(t, JSON.stringify(settings, null, 2));
  assert.equal(find(file, entry).length, 4);
  assert.equal(repair(file, entry).removed, 3);
  assert.equal(find(file, entry).length, 1);
  assert.deepEqual(find(file, entry)[0].hook, { ...own, timeout: 9, legacy: true });
  const repaired = JSON.parse(read(file));
  assert.deepEqual(repaired.hooks.PreToolUse[0].hooks, [settings.hooks.PreToolUse[0].hooks[0], other]);
  assert.deepEqual(repaired.hooks.PreToolUse[1], { ...group([prompt]), legacy: 'keep' });
  assert.equal(repair(file, entry).changed, false);
  assert.equal(remove(file, entry).removed, 1);
  const removed = JSON.parse(read(file));
  assert.deepEqual(removed.hooks.PreToolUse, [group([other]), { ...group([prompt]), legacy: 'keep' }, group([own], 'Write')]);
  assert.deepEqual(removed.hooks.Stop, settings.hooks.Stop);
  assert.deepEqual(removed.permissions, settings.permissions);
  assert.equal(remove(file, entry).changed, false);
});

test('unrelated values retain exact bytes, including large numbers, escapes and CRLF', t => {
  const prefix = '\uFEFF{\r\n\t"big": 900719925474099312345, "escape": "\\u0061",\r\n';
  const other = '{ "type":"command", "command":"node other.js", "x":1e+09 }';
  const suffix = ',\r\n\t"other": { "strange spacing" : [ true , null ] }\r\n}\r\n';
  const original = prefix + '\t"hooks": { "PreToolUse": [ { "matcher":"Bash", "hooks": [ ' + other + ' ] } ] }' + suffix;
  const file = fixture(t, original);
  install(file, entry);
  let updated = read(file);
  assert.ok(updated.startsWith(prefix));
  assert.ok(updated.endsWith(suffix));
  assert.ok(updated.includes(other));
  assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(read(backupsOf(file)[0]), original);
  remove(file, entry);
  updated = read(file);
  assert.ok(updated.startsWith(prefix));
  assert.ok(updated.endsWith(suffix));
  assert.ok(updated.includes(other));
});

test('absent files are created by install only; no-op calls make no backup', t => {
  const file = fixture(t, null);
  assert.deepEqual(find(file, entry), []);
  assert.equal(remove(file, entry).changed, false);
  assert.equal(repair(file, entry).changed, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(install(file, entry).backupPath, null);
  assert.equal(find(file, entry).length, 1);
  assert.deepEqual(backupsOf(file), []);
});

test('malformed JSON and malformed target containers never get overwritten', t => {
  for (const content of ['{', '[]', '{"hooks":null}', '{"hooks":[]}', '{"hooks":{"PreToolUse":{}}}',
    '{"hooks":{"PreToolUse":[{"hooks":null}]}}', '{"hooks":{},"hooks":{}}']) {
    const file = fixture(t, content);
    assert.throws(() => install(file, entry));
    assert.equal(read(file), content);
    assert.deepEqual(backupsOf(file), []);
  }
});

test('absent matcher equals empty matcher, but never a different pattern', t => {
  const file = fixture(t, JSON.stringify({ hooks: { Stop: [
    { hooks: [own] }, group([own], ''), group([own], '*'), group([own], 'Bash'),
  ] } }));
  const target = { event: 'Stop', command: entry.command };
  assert.equal(find(file, target).length, 2);
  assert.equal(repair(file, target).removed, 1);
  assert.equal(remove(file, target).removed, 1);
  assert.deepEqual(JSON.parse(read(file)).hooks.Stop, [group([own], '*'), group([own], 'Bash')]);
});

test('special object keys are ordinary JSON keys, never prototype lookups', t => {
  const file = fixture(t, '{"__proto__":{"untouched":true}}');
  const target = { ...entry, event: '__proto__' };
  install(file, target);
  assert.equal(find(file, target).length, 1);
  remove(file, target);
  assert.deepEqual(JSON.parse(read(file)).__proto__, { untouched: true });
  assert.equal({}.untouched, undefined);
});
