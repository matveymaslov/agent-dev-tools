import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { install, find, remove, repair } from '../index.js';
import { backupsOf, temporaryDirectory } from './temp.js';

function fixture(t, commands) {
  const dir = temporaryDirectory('shape-paths-');
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: commands.map(command =>
    typeof command === 'string' ? { type: 'command', command } : command) }] } }));
  return file;
}

test('Windows drive paths match quotes, separators, dot segments, and case on either host', t => {
  const commands = [
    '"C:\\Program Files\\Node\\NODE.EXE" "D:\\Hooks Folder\\Check.JS" --old',
    "'c:/program files/node/node.exe' 'd:/hooks folder/check.js' --new",
    '"C:/Program Files/Node/node.exe" "D:/Hooks Folder/./check.js"',
  ];
  const file = fixture(t, commands);
  const entry = { event: 'Stop', command: commands[1] };
  assert.equal(find(file, entry).length, 3);
  assert.equal(install(file, entry).changed, false);
  assert.equal(repair(file, entry).removed, 2);
  assert.equal(find(file, entry)[0].hook.command, commands[0]);
  assert.equal(remove(file, entry).removed, 1);
});

test('UNC paths and relative Windows paths normalize without basename collisions', t => {
  const file = fixture(t, [
    'NODE "\\\\Server\\Share\\Hooks\\Check.js"',
    'node "//server/share/hooks/check.js"',
    'node "//server/other/hooks/check.js"',
    'node ".\\Hooks\\Check.js"',
    'node ./hooks/check.js',
    'node ./elsewhere/check.js',
    'python ./hooks/check.js',
  ]);
  assert.equal(find(file, { event: 'Stop', command: 'node "//SERVER/SHARE/hooks/check.js"' }).length, 2);
  const entry = { event: 'Stop', command: 'node ./hooks/check.js' };
  assert.equal(find(file, entry, { platform: 'win32' }).length, 2);
  assert.equal(remove(file, entry, { platform: 'win32' }).removed, 2);
  assert.equal(JSON.parse(fs.readFileSync(file)).hooks.Stop[0].hooks.length, 5);
});

test('Linux is case-sensitive, keeps backslashes literal, and accepts escaped spaces', t => {
  const file = fixture(t, [
    'node "/tmp/hook folder/check.js" --first',
    "'node' '/tmp/hook folder/check.js' --second",
    'node /tmp/hook\\ folder/check.js',
    'NODE "/tmp/hook folder/check.js"',
    'node "/tmp/hook folder/Check.js"',
    'node "/tmp/other/check.js"',
    'node /tmp/hook\\folder/check.js',
  ]);
  assert.equal(find(file, { event: 'Stop', command: 'node "/tmp/hook folder/check.js"' }, { platform: 'linux' }).length, 3);
});

test('exec-form args and shell form share the same program and script identity', t => {
  const file = fixture(t, [
    { type: 'command', command: 'node', args: ['/tmp/hook folder/check.js', '--fix'] },
    'node "/tmp/hook folder/check.js" --dry-run',
    { type: 'command', command: 'node', args: ['/tmp/other.js'] },
    { type: 'prompt', command: 'node "/tmp/hook folder/check.js"' },
  ]);
  const entry = { event: 'Stop', command: 'node', args: ['/tmp/hook folder/check.js'], timeout: 7 };
  assert.equal(find(file, entry).length, 2);
  assert.equal(repair(file, entry).removed, 1);
  assert.equal(find(file, entry)[0].hook.args[1], '--fix');
});

test('unsupported shell expressions are preserved and rejected as targets', t => {
  const commands = [
    'node check.js && node other.js', 'node check.js | cat', 'node check.js > log',
    'FLAG=1 node check.js', 'node --require setup.js check.js', 'node -e "code"',
    'node "unterminated.js', 'node check.js\nnode other.js',
    'node "$(echo check.js)"', 'node $HOME/check.js', 'node check.js; exit',
    'node check.js # comment', 'node check.js &', 'node check.js`bad`',
  ];
  const file = fixture(t, [...commands, 'node check.js']);
  const original = fs.readFileSync(file, 'utf8');
  for (const command of commands) {
    assert.throws(() => install(file, { event: 'Stop', command }), TypeError);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
  const target = { event: 'Stop', command: 'node check.js' };
  assert.equal(find(file, target).length, 1);
  remove(file, target);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).hooks.Stop[0].hooks.map(hook => hook.command), commands);
});

test('different program paths, script paths, events, and matchers never collide', t => {
  const file = fixture(t, ['node check.js', '/usr/bin/node check.js', 'node other/check.js']);
  assert.equal(find(file, { event: 'Stop', command: 'node check.js' }).length, 1);
  assert.equal(find(file, { event: 'Start', command: 'node check.js' }).length, 0);
  assert.equal(find(file, { event: 'Stop', matcher: '*', command: 'node check.js' }).length, 0);
});

test('invalid entries fail before reading or writing settings', t => {
  const file = fixture(t, []);
  for (const entry of [null, [], {}, { event: '' }, { event: 'Stop', matcher: null, command: 'node check.js' },
    { event: 'Stop', command: '' }, { event: 'Stop', command: 'node' },
    { event: 'Stop', type: 'prompt', command: 'node check.js' },
    { event: 'Stop', command: 'node', args: [42] }]) {
    assert.throws(() => install(file, entry), TypeError);
  }
  assert.deepEqual(backupsOf(file), []);
});
