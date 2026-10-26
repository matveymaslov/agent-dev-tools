const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, run } = require('./helpers.cjs');

test('archival never splits an HTML comment across indexes', () => {
  const content = '- [A](a.md) <!--\n- [B](b.md)\n-->\n- [C](c.md)\n';
  const { index, dir } = fixture(content, { 'a.md': 'A.', 'b.md': 'B.', 'c.md': 'C.' });
  const before = fs.readdirSync(dir);
  const result = run(['archive', index, '--max-lines', '4', '--apply']);
  assert.equal(result.status, 2);
  assert.equal(fs.readFileSync(index, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(dir), before);
});

test('HTML comment contents are not linted as visible entries', () => {
  const { index } = fixture('<!--\n- [Hidden](missing.md)\n-->\n- [Visible](note.md)\n', { 'note.md': 'A.' });
  const result = run(['lint', index]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const archiveText of ['# Archive\n```text\nUnfinished example\n', '<!--\n', '<div>\n']) {
  test(`unsafe archive Markdown is refused: ${JSON.stringify(archiveText)}`, () => {
    const content = '- [A](a.md)\n- [B](b.md)\n- [C](c.md)\n';
    const { index, dir } = fixture(content, {
      'a.md': 'A.', 'b.md': 'B.', 'c.md': 'C.', 'MEMORY.archive.md': archiveText,
    });
    const result = run(['archive', index, '--max-lines', '3', '--apply']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Markdown/);
    assert.equal(fs.readFileSync(index, 'utf8'), content);
    assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.archive.md'), 'utf8'), archiveText);
    assert.ok(fs.readdirSync(dir).every(name => !/\.bak-/.test(name)));
  });
}

test('an alias to a note cannot be used as the archive destination', t => {
  const { index, dir } = fixture('- [Alias](alias.md)\n- [B](b.md)\n- [C](c.md)\n', {
    'MEMORY.archive.md': 'Original note.', 'b.md': 'B.', 'c.md': 'C.',
  });
  const archive = path.join(dir, 'MEMORY.archive.md');
  try { fs.symlinkSync(archive, path.join(dir, 'alias.md'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return; }
    throw error;
  }
  const result = run(['archive', index, '--max-lines', '3', '--apply']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /already a note target/);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'Original note.');
});
