const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, run } = require('./helpers.cjs');

test('lint reports every requested finding with line numbers and overage', () => {
  const { index } = fixture([
    '# Memory',
    '- [Build](build.md)',
    '- [Build again](./build.md#example)',
    '- [Missing](missing.md)',
    '- [Late](late.md) ' + 'x'.repeat(90),
    '',
  ].join('\n'), { 'build.md': 'Generic build advice.', 'late.md': 'Generic test advice.' });
  const result = run(['lint', index, '--max-lines', '4', '--max-line-length', '80']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /OVER LIMIT.*1 line/);
  assert.match(result.stdout, /PAST CUT.*line 5/);
  assert.match(result.stdout, /MISSING FILE.*line 4.*missing.md/);
  assert.match(result.stdout, /DUPLICATE.*line 3.*line 2/);
  assert.match(result.stdout, /OVERLONG LINE.*line 5/);
});

test('near-limit is nonzero and prints remaining capacity', () => {
  const { index } = fixture('one\ntwo\nthree\nfour\n');
  const result = run(['lint', index, '--max-lines', '5', '--near-percent', '80']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /NEAR LIMIT/);
  assert.match(result.stdout, /1 line.*remaining/);
});

test('UTF-8 bytes determine the cut, including partially loaded entries', () => {
  const text = '- [Résumé](note.md) café\n';
  const { index } = fixture(text, { 'note.md': 'Generic note.' });
  const bytes = Buffer.byteLength(text);
  const result = run(['lint', index, '--max-bytes', String(bytes - 4)]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /OVER LIMIT.*4 bytes/);
  assert.match(result.stdout, /PARTIAL CUT.*line 1/);
});

for (const eol of ['\n', '\r\n', '\r']) {
  test(`line counting handles ${JSON.stringify(eol)} and no phantom final line`, () => {
    const { index } = fixture(`one${eol}two${eol}`);
    const result = run(['lint', index, '--max-lines', '3', '--near-percent', '100']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\/3 lines/);
  });
}

test('default 200-line and 25000-byte limits are independent', () => {
  const lines = fixture('note\n'.repeat(201));
  assert.match(run(['lint', lines.index]).stdout, /OVER LIMIT.*1 line/);
  const bytes = fixture('x'.repeat(25001));
  assert.match(run(['lint', bytes.index]).stdout, /OVER LIMIT.*1 byte/);
});

test('local links handle spaces, Unicode, parentheses, fragments and Windows separators', () => {
  const { index } = fixture([
    '- [One](<notes/first note.md>)',
    '- [Two](notes\\second.md#section)',
    '- [Three](notes/r%C3%A9sum%C3%A9.md)',
    '- [Four](notes/test(one).md "A title")',
    '- [Web](https://example.com/page) and [section](#intro)',
    '',
  ].join('\r\n'), {
    'notes/first note.md': 'A.', 'notes/second.md': 'B.',
    'notes/résumé.md': 'C.', 'notes/test(one).md': 'D.',
  });
  const result = run(['lint', index]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('code examples are not links and reference-style entries are explicitly unsupported', () => {
  const { index } = fixture('```md\n- [Example](absent.md)\n```\n`[Example](absent.md)`\n- [Note][ref]\n');
  const result = run(['lint', index]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /MISSING FILE/);
  assert.match(result.stdout, /UNSUPPORTED ENTRY.*line 5/);
});

test('duplicates include normalized text entries and normalized file targets', () => {
  const { index } = fixture('- Remember testing.\n- Remember   testing.\n');
  assert.match(run(['lint', index]).stdout, /DUPLICATE.*line 2.*line 1/);
});

test('directories and malformed link encodings are findings, not missing-note successes', () => {
  const { index, dir } = fixture('- [Directory](notes)\n- [Bad](bad%ZZ.md)\n');
  fs.mkdirSync(path.join(dir, 'notes'));
  const result = run(['lint', index]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /NOT A FILE/);
  assert.match(result.stdout, /INVALID LINK/);
});

test('lint is read-only and healthy input succeeds from a different working directory', () => {
  const { index, dir } = fixture('- [Note](note.md)\n', { 'note.md': 'Generic note.' });
  const before = fs.readFileSync(index);
  const result = run(['lint', index], path.dirname(dir));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['MEMORY.md', 'note.md']);
});

test('invalid CLI input and unreadable input fail clearly with exit 2', () => {
  const { index } = fixture('note');
  for (const args of [
    ['lint', index, '--max-lines', '0'], ['lint', index, '--max-bytes', '1.5'],
    ['lint', index, '--near-percent', '101'], ['lint', index, '--unknown'],
    ['lint', index, '--apply'], ['lint', index, 'extra'], ['unknown', index],
    ['lint', index + '.absent'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Error:/);
  }
});

test('invalid UTF-8 is rejected rather than rewritten', () => {
  const { index } = fixture(Buffer.from([0xff, 0xfe, 0x61]));
  const result = run(['lint', index]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /UTF-8/);
});
