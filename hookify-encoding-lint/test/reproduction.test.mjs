import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fix, lint } from '../index.mjs';

const temporary = () => mkdtempSync(path.join(tmpdir(), 'hookify reproduction '));
const reproduction = fileURLToPath(new URL('../reproduce.py', import.meta.url));
const rule = pattern => `---\nname: sample\nevent: bash\naction: block\npattern: "${pattern}"\n---\nPlease review.\n`;

function execute(command, args) {
  const dir = temporary();
  const outPath = path.join(dir, 'stdout');
  const errPath = path.join(dir, 'stderr');
  const out = openSync(outPath, 'w');
  const err = openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(command, args, { stdio: ['ignore', out, err] });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return { ...result, stdout: readFileSync(outPath, 'utf8'), stderr: readFileSync(errPath, 'utf8') };
}

function python(args) {
  for (const [command, prefix] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const version = execute(command, [...prefix, '-c', 'import sys; assert sys.version_info.major == 3']);
    if (!version.error && version.status === 0) return execute(command, [...prefix, ...args]);
  }
  assert.fail('Python 3 is required; no interpreter found.');
}

test('Python cp1252 rejects exactly five byte values and the fixer removes their UTF-8 hazards', () => {
  const dir = temporary();
  const characters = ['\u0401', '\u040d', '\u040f', '\u0410', '\u041d', '\u201d'];
  const cases = [];
  for (const [index, character] of characters.entries()) {
    const before = rule(`^${character}$`).replaceAll('\n', index % 2 ? '\r\n' : '\n');
    const after = fix(Buffer.from(before));
    assert.equal(after.ok, true);
    assert.equal(after.changed, true);
    const source = path.join(dir, `before ${index}.md`);
    const fixed = path.join(dir, `after ${index}.md`);
    writeFileSync(source, before);
    writeFileSync(fixed, after.text);
    cases.push({ source, fixed, character, before: lint(before).patterns[0].value, after: after.patterns[0].value });
  }
  const input = path.join(dir, 'cases.json');
  writeFileSync(input, JSON.stringify(cases));
  const result = python(['-c', `import json, re, sys
from pathlib import Path
undefined = []
for value in range(256):
    try:
        bytes([value]).decode('cp1252')
    except UnicodeDecodeError:
        undefined.append(value)
assert undefined == [0x81, 0x8d, 0x8f, 0x90, 0x9d], undefined
with open(sys.argv[1], encoding='utf-8') as handle:
    cases = json.load(handle)
for case in cases:
    raw = Path(case['source']).read_bytes()
    assert raw.decode('utf-8')
    try:
        raw.decode('cp1252')
    except UnicodeDecodeError:
        pass
    else:
        raise AssertionError('Expected decode failure')
    fixed = Path(case['fixed']).read_bytes()
    assert fixed.decode('cp1252') == fixed.decode('utf-8')
    before, after = re.compile(case['before']), re.compile(case['after'])
    for text in [case['character'], '', 'x', case['character'] * 2]:
        assert bool(before.fullmatch(text)) == bool(after.fullmatch(text))
    assert after.fullmatch(case['character'])
print('five undefined bytes; fixed patterns equivalent')`, input]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixed patterns equivalent/);
});

test('portable reproduction demonstrates both decode failure and a corrupted pattern', () => {
  const result = python([reproduction, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.undefined_cp1252_bytes, ['81', '8D', '8F', '90', '9D']);
  assert.equal(report.decode_failure, true);
  assert.equal(report.utf8_pattern_matches, true);
  assert.equal(report.cp1252_pattern_matches, false);
  assert.equal(report.ascii_escape_matches, true);
  assert.equal(report.native, null);
});

test('native reproduction identifies the actual default codec without claiming Windows on Linux', () => {
  const result = python([reproduction, '--native', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.native.encoding, 'string');
  assert.equal(report.native.platform, process.platform === 'win32' ? 'win32' : process.platform);
  assert.equal(typeof report.native.decode_failure, 'boolean');
  if (report.native.encoding.toLowerCase().replaceAll('-', '') === 'cp1252') {
    assert.equal(report.native.decode_failure, true);
  }
});

test('reproduction fails visibly for a missing supplied plugin', () => {
  const result = python([reproduction, '--native', '--plugin', path.join(temporary(), 'missing')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugin|config_loader/i);
});
