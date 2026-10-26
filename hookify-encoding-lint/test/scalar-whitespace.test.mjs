import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fix } from '../index.mjs';

test('fix retains Python scalar trimming and regex meaning around NEL and BOM', () => {
  const cases = [];
  for (const scalar of ['café\u0085', '\u0085café', '"café"\u0085', '\u0085"café"', 'café\ufeff', '\ufeffcafé']) {
    for (const newline of ['\n', '\r\n']) {
      const before = ['---', 'name: sample', 'event: bash', `pattern: ${scalar}`, '---', 'Review.'].join(newline);
      const result = fix(before);
      assert.equal(result.changed, true, JSON.stringify(result));
      cases.push([before, result.text]);
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'hookify whitespace '));
  const input = path.join(dir, 'cases.json');
  const outPath = path.join(dir, 'stdout');
  const errPath = path.join(dir, 'stderr');
  writeFileSync(input, JSON.stringify(cases));
  const script = `import json, re, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    cases = json.load(handle)
def pattern(source):
    # hookify 0.1.0 parse_frontmatter scalar steps, including Python whitespace.
    line = next(line for line in source.split('\\n') if line.startswith('pattern:'))
    return line.strip().split(':', 1)[1].strip().strip('"').strip("'")
for before, after in cases:
    a, b = re.compile(pattern(before)), re.compile(pattern(after))
    for text in ['caf\\u00e9', 'caf\\u00e9\\u0085', '\\u0085caf\\u00e9', 'caf\\u00e9\\ufeff', '\\ufeffcaf\\u00e9', '']:
        assert bool(a.fullmatch(text)) == bool(b.fullmatch(text)), (ascii(pattern(before)), ascii(pattern(after)), ascii(text))
print('equivalent')`;
  let result;
  for (const [command, prefix] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const out = openSync(outPath, 'w');
    const err = openSync(errPath, 'w');
    try {
      result = spawnSync(command, [...prefix, '-c', script, input], { stdio: ['ignore', out, err] });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    if (!result.error) break;
  }
  assert.equal(result.status, 0, readFileSync(errPath, 'utf8'));
  assert.match(readFileSync(outPath, 'utf8'), /equivalent/);
});
