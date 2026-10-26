const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, run } = require('./helpers.cjs');

function sample(eol = '\n') {
  const content = ['# Memory', '- [Recent](recent.md)', '- [Old](old.md)', '- [Middle](middle.md)', '- [Other](other.md)', ''].join(eol);
  const result = fixture(content, {
    'recent.md': 'Recent generic note.', 'old.md': 'Old generic note.',
    'middle.md': 'Middle generic note.', 'other.md': 'Other generic note.',
  });
  for (const [name, year] of [['old', 2000], ['middle', 2001], ['other', 2002], ['recent', 2003]]) {
    const when = new Date(`${year}-01-01T00:00:00Z`);
    fs.utimesSync(path.join(result.dir, name + '.md'), when, when);
  }
  return { ...result, content, archive: path.join(result.dir, 'MEMORY.archive.md') };
}

for (const eol of ['\n', '\r\n']) {
  test(`dry run is read-only; apply moves exactly printed entries (${JSON.stringify(eol)})`, () => {
    const { index, dir, archive, content } = sample(eol);
    const before = fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name))]);
    const args = ['archive', index, '--max-lines', '5'];
    const dry = run(args);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Rule: least recently changed/);
    assert.match(dry.stdout, /MOVE line 3.*Old/);
    assert.match(dry.stdout, /MOVE line 4.*Middle/);
    assert.doesNotMatch(dry.stdout, /MOVE line (2|5)/);
    assert.deepEqual(fs.readdirSync(dir), before.map(([name]) => name));
    for (const [name, buffer] of before) assert.deepEqual(fs.readFileSync(path.join(dir, name)), buffer);
    const applied = run([...args, '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    const selection = output => output.split('\n').filter(line => line.startsWith('MOVE '));
    assert.deepEqual(selection(applied.stdout), selection(dry.stdout));
    const active = fs.readFileSync(index, 'utf8');
    const archived = fs.readFileSync(archive, 'utf8');
    assert.equal(active, `Archived entries: [Archive](<MEMORY.archive.md>).${eol}# Memory${eol}- [Recent](recent.md)${eol}- [Other](other.md)${eol}`);
    assert.match(archived, /\[Old\]/);
    assert.match(archived, /\[Middle\]/);
    assert.doesNotMatch(archived, /\[Recent\]|\[Other\]/);
    const backups = fs.readdirSync(dir).filter(name => name.startsWith('MEMORY.md.bak-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), content);
    assert.equal(run(['lint', index, '--max-lines', '5', '--near-percent', '100']).status, 0);
    for (const [name, buffer] of before.filter(([name]) => name !== 'MEMORY.md')) assert.deepEqual(fs.readFileSync(path.join(dir, name)), buffer);
    const after = fs.readdirSync(dir);
    const again = run([...args, '--apply']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /No changes/);
    assert.deepEqual(fs.readdirSync(dir), after);
  });
}

test('byte pressure alone triggers archive and counts pointer overhead', () => {
  const { index, archive } = sample();
  const result = run(['archive', index, '--max-bytes', '80', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.statSync(index).size < 80);
  assert.match(fs.readFileSync(index, 'utf8'), /Archived entries:/);
  assert.ok(fs.readFileSync(archive, 'utf8').includes('[Old]'));
});

test('existing archive is appended and separately backed up; filenames with spaces work', () => {
  const { index, dir } = sample();
  const archive = path.join(dir, 'older notes.md');
  fs.writeFileSync(archive, '# Older notes\nKeep this text.');
  const result = run(['archive', index, '--archive', 'older notes.md', '--max-lines', '5', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.readFileSync(archive, 'utf8').startsWith('# Older notes\nKeep this text.\n'));
  assert.match(fs.readFileSync(index, 'utf8'), /older%20notes.md/);
  const backup = fs.readdirSync(dir).find(name => name.startsWith('older notes.md.bak-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '# Older notes\nKeep this text.');
});

test('mtime ties use original line order and multiple targets use newest mtime', () => {
  const { index, dir } = fixture('- [Mixed](old.md) [New](new.md)\n- [A](a.md)\n- [B](b.md)\n- [C](c.md)\n', {
    'old.md': 'Old.', 'new.md': 'New.', 'a.md': 'A.', 'b.md': 'B.', 'c.md': 'C.',
  });
  for (const file of ['old', 'a', 'b', 'c']) fs.utimesSync(path.join(dir, file + '.md'), 100, 100);
  fs.utimesSync(path.join(dir, 'new.md'), 200, 200);
  const result = run(['archive', index, '--max-lines', '4']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MOVE line 2.*\[A\]/);
  assert.match(result.stdout, /MOVE line 3.*\[B\]/);
  assert.doesNotMatch(result.stdout, /MOVE line 1/);
});

test('impossible budgets fail without writing backups or archives', () => {
  const { index, dir, content } = sample();
  const before = fs.readdirSync(dir);
  const result = run(['archive', index, '--max-bytes', '10', '--apply']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot fit/);
  assert.deepEqual(fs.readdirSync(dir), before);
  assert.equal(fs.readFileSync(index, 'utf8'), content);
});

test('missing notes, multiline entries and code examples remain pinned', () => {
  const content = '- [Missing](missing.md)\n- [Multiline](note.md)\n  continuation\n\n  second paragraph\n```md\n- [Code](note.md)\n```\n';
  const { index, dir } = fixture(content, { 'note.md': 'Generic note.' });
  const result = run(['archive', index, '--max-lines', '4', '--apply']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot fit/);
  assert.equal(fs.readFileSync(index, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['MEMORY.md', 'note.md']);
});

test('archive stays beside index and refuses index alias or note collisions', () => {
  const { index, dir, content } = sample();
  for (const name of ['MEMORY.md', '../elsewhere.md', 'nested/archive.md', 'nested\\archive.md', 'old.md']) {
    const result = run(['archive', index, '--archive', name, '--max-lines', '5', '--apply']);
    assert.equal(result.status, 2, name);
  }
  assert.equal(fs.readFileSync(index, 'utf8'), content);
  assert.equal(fs.readFileSync(path.join(dir, 'old.md'), 'utf8'), 'Old generic note.');
});

test('hard-linked index is never replaced', () => {
  const { index, dir } = sample();
  fs.linkSync(index, path.join(dir, 'index-copy.md'));
  const result = run(['archive', index, '--max-lines', '5', '--apply']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /regular file with one link/);
});

test('healthy index is a no-op with no archive or backups', () => {
  const { index, dir } = fixture('- [Note](note.md)', { 'note.md': 'Generic note.' });
  const result = run(['archive', index, '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No changes/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['MEMORY.md', 'note.md']);
});
