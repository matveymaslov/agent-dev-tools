import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fix, fixFile, lint, lintFile } from '../index.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const rule = (header = 'pattern: danger', body = 'Please review.') =>
  `---\nname: sample-rule\nenabled: true\nevent: bash\n${header}\n---\n${body}\n`;
const temporary = () => mkdtempSync(path.join(tmpdir(), 'hookify lint '));
// Files also work in restricted runners that do not support child stdout pipes.
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
const run = (...args) => execute(process.execPath, [cli, ...args]);

test('clean ASCII rule passes through the library and CLI', async () => {
  const file = path.join(temporary(), 'hookify.clean.local.md');
  writeFileSync(file, rule());
  assert.deepEqual(lint(Buffer.from(rule())).diagnostics, []);
  assert.equal((await lintFile(file)).ok, true);
  const result = run('lint', file);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('every non-ASCII code point has a one-based line and code-point column', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = rule('pattern: "é😀я"', '— “text”').replaceAll('\n', newline);
    const findings = lint(Buffer.from(text)).diagnostics.filter(d => d.code === 'non-ascii');
    assert.deepEqual(findings.map(d => [d.character, d.line, d.column, d.region]), [
      ['é', 5, 11, 'pattern'], ['😀', 5, 12, 'pattern'], ['я', 5, 13, 'pattern'],
      ['—', 7, 1, 'body'], ['“', 7, 3, 'body'], ['”', 7, 8, 'body'],
    ]);
  }
});

test('non-ASCII metadata and comments are findings too, including a BOM', () => {
  const result = lint(Buffer.from('\ufeff' + rule('pattern: ok\n# café', 'body')));
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.filter(d => d.code === 'non-ascii').map(d => d.character), ['\ufeff', 'é']);
  assert.ok(result.diagnostics.some(d => d.code === 'front-matter'));
});

test('invalid UTF-8 is rejected instead of silently replacing bytes', () => {
  for (const bytes of [[0x80], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    const result = lint(Buffer.concat([Buffer.from(rule()), Buffer.from(bytes)]));
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, 'invalid-utf8');
    assert.equal(result.diagnostics[0].byteOffset, Buffer.byteLength(rule()));
  }
});

test('malformed front matter fails closed', () => {
  const invalid = [
    'no header', '---\nname: missing end', rule('pattern "missing colon"'),
    rule('pattern: "unclosed'), rule('pattern: one\npattern: two'),
    rule('conditions:\n  - field: new_text\n    pattern: bad\n    operator: ['),
    rule('conditions: []'), rule('conditions:\n  - pattern: bad'),
    rule('pattern: |\n  multiline'), rule('pattern: ok\n  nested: value'),
    rule('pattern: ok').replace('enabled: true', 'enabled: maybe'),
    rule('pattern: ok').replace('event: bash', 'event: unknown'),
  ];
  for (const text of invalid) {
    const result = lint(Buffer.from(text));
    assert.equal(result.ok, false, text);
    assert.ok(result.diagnostics.some(d => d.code === 'front-matter'), text);
  }
});

// hookify has no YAML parser: any non-empty value is a plain string after quote stripping.
for (const value of ['[A-Z]+', '[[:alpha:]]+', '{2}x', '{"a":1}', '[a-z]{2,3}', '&amp;', '*\\.md', '!important']) {
  test(`unquoted value ${value} is plain text to hookify and lints clean`, () => {
    const top = lint(Buffer.from(rule(`pattern: ${value}`)));
    assert.deepEqual(top.diagnostics, [], value);
    assert.equal(top.ok, true);
    assert.deepEqual(top.patterns.map(p => p.value), [value]);
    const nested = lint(Buffer.from(rule(`conditions:\n  - field: command\n    pattern: ${value}`)));
    assert.deepEqual(nested.diagnostics, [], value);
    assert.deepEqual(nested.patterns.map(p => p.value), [value]);
    const operator = lint(Buffer.from(rule(`conditions:\n  - field: command\n    operator: contains\n    pattern: ${value}`)));
    assert.deepEqual(operator.diagnostics, [], value);
  });
}

test('an unquoted [A-Z]+ rule lints clean through the CLI too', () => {
  const file = path.join(temporary(), 'hookify.upper.local.md');
  writeFileSync(file, rule('pattern: [A-Z]+'));
  const result = run('lint', file);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('fix rewrites non-ASCII in an unquoted bracket pattern and the result lints clean', () => {
  const result = fix(rule('pattern: [а-я]+'));
  assert.equal(result.changed, true);
  assert.ok(result.text.includes('pattern: [\\u0430-\\u044F]+'));
  assert.equal(lint(result.text).ok, true);
});

test('an unreadable value is reported once, without cascading missing-key errors', () => {
  const blockScalar = lint(Buffer.from(rule('pattern: |\n  multiline')));
  assert.equal(blockScalar.diagnostics.filter(d => d.code === 'front-matter').length >= 1, true);
  assert.equal(blockScalar.diagnostics.some(d => /nonempty pattern/.test(d.message)), false);
  const unclosed = lint(Buffer.from(rule('conditions:\n  - field: "command\n    pattern: x')));
  assert.deepEqual(unclosed.diagnostics.map(d => d.message), [
    'Unclosed scalar quote or trailing text after a quote.',
  ]);
  const missing = lint(Buffer.from(rule('conditions:\n  - field: command')));
  assert.ok(missing.diagnostics.some(d => d.message === 'Each condition needs field and pattern.'));
});

test('file conditions using edit text report the Write blind spot', () => {
  const text = rule('conditions:\n  - field: new_text\n    operator: regex_match\n    pattern: danger').replace('event: bash', 'event: file');
  assert.ok(lint(Buffer.from(text)).diagnostics.some(d => d.code === 'write-content'));
  assert.ok(lint(Buffer.from(text.replace('new_text', 'new_string'))).diagnostics.some(d => d.code === 'write-content'));
  assert.ok(lint(Buffer.from(text.replace('event: file', 'event: all'))).diagnostics.some(d => d.code === 'write-content'));
  assert.equal(lint(Buffer.from(text.replace('new_text', 'content'))).ok, true);
  assert.equal(lint(Buffer.from(text.replace('event: file', 'event: bash'))).ok, true);
  const withPath = text.replace('---\nPlease', '  - field: file_path\n    pattern: \\.txt$\n---\nPlease');
  assert.ok(lint(Buffer.from(withPath)).diagnostics.some(d => d.code === 'write-content'));
});

test('CLI errors are nonzero and one bad file does not hide another', () => {
  const dir = temporary();
  const unicode = path.join(dir, 'hookify.unicode.local.md');
  const invalid = path.join(dir, 'hookify.bytes.local.md');
  writeFileSync(unicode, rule('pattern: é'));
  writeFileSync(invalid, Buffer.from([0xff]));
  const result = run('lint', path.join(dir, 'absent.md'), unicode, invalid);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /non-ascii/);
  assert.match(result.stdout, /invalid-utf8/);
  assert.match(result.stdout, /file-error/);
  assert.equal(run('lint').status, 2);
  assert.equal(run('unknown', unicode).status, 2);
});

test('directory input discovers rule files without shell globs or backup files', () => {
  const dir = temporary();
  writeFileSync(path.join(dir, 'hookify.clean.local.md'), rule());
  writeFileSync(path.join(dir, 'hookify.clean.local.md.bak'), 'bad');
  writeFileSync(path.join(dir, 'README.md'), 'bad');
  assert.equal(run('lint', dir).status, 0);
  assert.equal(run('lint', temporary()).status, 1);
  assert.equal(readFileSync(path.join(dir, 'hookify.clean.local.md'), 'utf8'), rule());
});

function python(args) {
  for (const [command, prefix] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const version = execute(command, [...prefix, '-c', 'import sys; assert sys.version_info.major == 3']);
    if (!version.error && version.status === 0) return execute(command, [...prefix, ...args]);
  }
  assert.fail('Python 3 is required for regex equivalence and cp1252 tests; none found.');
}

test('fix preserves Python regex matching, including escaped Unicode and astral characters', () => {
  const pairs = [];
  const patterns = [
    '^Привет$', '[А-Яа-я]+', '(?:café|“hello”|a—b){1,3}', '😀+', '[😀-🙏]',
    '\\é', '\\\\é', '\\\\\\é', '[\\é]', '(?i)ä+', '(?#é)é',
    '(?P<word>é)(?P=word)', '(?P<x>я)(?(x)é|ñ)', 'a\u00a0b', '^é|я$',
  ];
  for (const pattern of patterns) {
    const original = rule(`pattern: "${pattern}"`);
    const result = fix(Buffer.from(original));
    assert.equal(result.changed, true, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.doesNotMatch(result.text, /[^\x00-\x7f]/);
    assert.equal(fix(Buffer.from(result.text)).changed, false);
    pairs.push([lint(original).patterns[0].value, lint(result.text).patterns[0].value]);
  }
  assert.match(pairs[4][1], /\\U0001F600/);
  assert.equal(pairs[5][1], '\\u00E9');
  const corpus = ['', 'Привет', 'привет', 'АБВ', 'абв', 'café', 'CAFÉ', '“hello”', 'a—b', '😀', '😀😀', '🙏', 'é', 'É', '\\é', '\\u00E9', 'яя', 'яé', 'éé', 'a\u00a0b', 'a b', 'none', '\ud83d\ude00'];
  const input = path.join(temporary(), 'patterns.json');
  writeFileSync(input, JSON.stringify({ pairs, corpus }));
  const result = python(['-c', `import json, re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    data = json.load(f)
for before, after in data['pairs']:
    a, b = re.compile(before, re.I), re.compile(after, re.I)
    assert a.groups == b.groups and a.groupindex == b.groupindex
    for text in data['corpus']:
        def matches(regex):
            return [(m.span(), m.group(), m.groups(), m.groupdict()) for m in regex.finditer(text)]
        assert matches(a) == matches(b), (before, after, ascii(text))
print('equivalent')`, input]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /equivalent/);
});

test('fix preserves body, metadata, comments, quotes, and CRLF bytes outside patterns', async () => {
  const original = rule('pattern: "café"\n# café', 'Please review café.').replaceAll('\n', '\r\n');
  const file = path.join(temporary(), 'a rule.md');
  writeFileSync(file, original);
  const result = await fixFile(file);
  assert.equal(result.changed, true);
  assert.equal(result.ok, false);
  assert.equal(result.backup, `${file}.bak`);
  assert.deepEqual(readFileSync(result.backup), Buffer.from(original));
  assert.equal(readFileSync(file, 'utf8'), original.replace('pattern: "café"', 'pattern: "caf\\u00E9"'));
  assert.equal(result.diagnostics.filter(d => d.code === 'non-ascii').length, 2);
  assert.ok(result.diagnostics.some(d => d.region === 'body' && /manually/.test(d.message)));
  const second = await fixFile(file);
  assert.equal(second.changed, false);
  assert.deepEqual(readFileSync(result.backup), Buffer.from(original));
});

test('fix refuses invalid bytes and malformed front matter without a backup or edit', async () => {
  for (const original of [Buffer.from([0xff]), Buffer.from(rule('pattern: "é'))]) {
    const file = path.join(temporary(), 'broken.md');
    writeFileSync(file, original);
    const result = await fixFile(file);
    assert.equal(result.changed, false);
    assert.equal(result.ok, false);
    assert.deepEqual(readFileSync(file), original);
    assert.equal(existsSync(`${file}.bak`), false);
  }
});

test('literal operators and Unicode group names remain manual findings', () => {
  for (const operator of ['contains', 'not_contains', 'equals', 'starts_with', 'ends_with']) {
    const original = rule(`conditions:\n  - field: command\n    operator: ${operator}\n    pattern: café`);
    const result = fix(original);
    assert.equal(result.changed, false);
    assert.equal(result.text, original);
    assert.equal(result.ok, false);
  }
  for (const pattern of ['(?P<имя>é)', '(?P=имя)', '(?(имя)é|я)']) {
    const original = rule(`pattern: "${pattern}"`);
    const result = fix(original);
    assert.equal(result.changed, false);
    assert.equal(result.text, original);
    assert.ok(result.diagnostics.some(d => d.code === 'unsafe-pattern'));
  }
});

test('fix never overwrites an existing backup', async () => {
  const file = path.join(temporary(), 'rule.md');
  const original = rule('pattern: café');
  writeFileSync(file, original);
  writeFileSync(`${file}.bak`, 'keep this');
  const result = await fixFile(file);
  assert.equal(result.changed, false);
  assert.equal(result.ok, false);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), 'keep this');
  assert.ok(result.diagnostics.some(d => d.code === 'file-error'));
});

test('fix CLI returns residual findings and names the backup', () => {
  const file = path.join(temporary(), 'rule.md');
  writeFileSync(file, rule('pattern: café', 'café'));
  const partial = run('fix', file);
  assert.equal(partial.status, 1, partial.stderr);
  assert.match(partial.stdout, /\.bak/);
  assert.match(partial.stdout, /body.*manually/);
  const clean = path.join(temporary(), 'rule.md');
  writeFileSync(clean, rule('pattern: café'));
  assert.equal(run('fix', clean).status, 0);
  assert.equal(run('lint', clean).status, 0);
  assert.equal(readFileSync(`${clean}.bak`, 'utf8'), rule('pattern: café'));
});

test('upstream delimiter, quote stripping, condition AND, and legacy file rules are checked', () => {
  for (const header of ['pattern: "é---я"', 'pattern: "\'é\'"', 'pattern: "true"', 'conditions:\n  - field: command, pattern: é']) {
    const result = fix(rule(header));
    assert.equal(result.changed, false);
    assert.ok(result.diagnostics.some(d => d.code === 'front-matter'));
  }
  const legacy = rule('pattern: danger').replace('event: bash', 'event: file');
  assert.ok(lint(legacy).diagnostics.some(d => d.code === 'write-content'));
  const both = rule('conditions:\n  - field: new_text\n    pattern: danger\n  - field: content\n    pattern: danger').replace('event: bash', 'event: file');
  assert.ok(lint(both).diagnostics.some(d => d.code === 'write-content'));
});
