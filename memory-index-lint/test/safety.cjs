const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, run } = require('./helpers.cjs');
const { planArchive, applyArchive } = require('../lib/archive.cjs');

function ready() {
  const result = fixture('- [A](a.md)\n- [B](b.md)\n- [C](c.md)\n', {
    'a.md': 'First generic note.', 'b.md': 'Second generic note.', 'c.md': 'Third generic note.',
  });
  return { ...result, plan: planArchive(result.index, { maxLines: 3 }) };
}

test('index edited after planning is preserved and no backup is created', () => {
  const { index, dir, plan } = ready();
  fs.appendFileSync(index, 'An independent edit.\n');
  const before = fs.readFileSync(index);
  assert.throws(() => applyArchive(plan), /changed after planning/);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.ok(fs.readdirSync(dir).every(file => !/bak-|lock|archive/.test(file)));
});

test('an archive created after planning is not overwritten', () => {
  const { plan } = ready();
  fs.writeFileSync(plan.archive, 'Independent archive.');
  assert.throws(() => applyArchive(plan), /changed after planning/);
  assert.equal(fs.readFileSync(plan.archive, 'utf8'), 'Independent archive.');
});

test('an existing lock prevents writes and is never removed by another invocation', () => {
  const { index, plan } = ready();
  const lock = `${index}.memory-index-lint.lock`;
  fs.writeFileSync(lock, 'held');
  assert.throws(() => applyArchive(plan), /lock exists/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'held');
  assert.deepEqual(fs.readFileSync(index), plan.before.buffer);
});

test('failed index replacement retains original, saved archive and recovery backup', t => {
  const { index, dir, plan } = ready();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === index) throw new Error('Simulated replacement failure');
    return rename(from, to);
  });
  assert.throws(() => applyArchive(plan), /Archive was saved; index was not replaced.*Backups:/);
  assert.deepEqual(fs.readFileSync(index), plan.before.buffer);
  assert.equal(fs.readFileSync(plan.archive, 'utf8'), plan.nextArchive);
  const backup = fs.readdirSync(dir).find(file => file.startsWith('MEMORY.md.bak-'));
  assert.deepEqual(fs.readFileSync(path.join(dir, backup)), plan.before.buffer);
  assert.ok(fs.readdirSync(dir).every(file => !/\.tmp-|\.lock$/.test(file)));
});

test('symlinked archive is refused without changing its target', t => {
  const { index, dir, plan } = ready();
  const target = path.join(dir, 'target.md');
  fs.writeFileSync(target, 'Keep this note.');
  try { fs.symlinkSync(target, plan.archive, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return; }
    throw error;
  }
  assert.throws(() => planArchive(index, { maxLines: 3 }), /regular file with one link/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Keep this note.');
});

test('BOM and unterminated last entry survive archival and a repeat run', () => {
  const { index, dir } = fixture('\uFEFF- [A](a.md)\r\n- [B](b.md)\r\n- [C](c.md)', {
    'a.md': 'A.', 'b.md': 'B.', 'c.md': 'C.',
  });
  const first = run(['archive', index, '--max-lines', '3', '--apply']);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.readFileSync(index, 'utf8').startsWith('\uFEFFArchived entries:'));
  const second = run(['archive', index, '--max-lines', '3', '--apply']);
  assert.equal(second.status, 0, second.stderr);
  const all = fs.readFileSync(index, 'utf8') + fs.readFileSync(path.join(dir, 'MEMORY.archive.md'), 'utf8');
  for (const name of ['A', 'B', 'C']) assert.equal(all.split(`[${name}]`).length - 1, 1);
});

test('mixed inline and reference-style links are pinned, never moved away from definitions', () => {
  const content = '- [Inline](note.md) and [Reference][ref]\n\n[ref]: note.md\n';
  const { index } = fixture(content, { 'note.md': 'Generic note.' });
  const lint = run(['lint', index]);
  assert.equal(lint.status, 1);
  assert.match(lint.stdout, /UNSUPPORTED ENTRY/);
  const archive = run(['archive', index, '--max-lines', '2', '--apply']);
  assert.equal(archive.status, 2);
  assert.equal(fs.readFileSync(index, 'utf8'), content);
});

test('an entry followed by an indented paragraph across a blank line stays intact', () => {
  const content = '- [Note](note.md)\n\n  Keep this explanation.\n';
  const { index } = fixture(content, { 'note.md': 'Generic note.' });
  assert.equal(run(['archive', index, '--max-lines', '3', '--apply']).status, 2);
  assert.equal(fs.readFileSync(index, 'utf8'), content);
});
