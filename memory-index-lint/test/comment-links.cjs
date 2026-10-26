const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, run } = require('./helpers.cjs');

test('hidden links in an otherwise visible entry are not missing-file findings', () => {
  const { index } = fixture('- [Visible](note.md) <!-- [Hidden](absent.md) -->\n', { 'note.md': 'Generic note.' });
  const result = run(['lint', index]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /MISSING FILE/);
});
