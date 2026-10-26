import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkSchema, checkVocabulary, parseVocabulary } from '../index.mjs'

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const missing = (report) => report.missing.map(({ kind, value, path }) => ({ kind, value, path }))

test('lists unnamed enum values, constants and required names at their schema paths', () => {
  const schema = { type: 'object', required: ['state', 'marker'], properties: {
    state: { enum: ['pass', 'fail'] }, marker: { const: 'END' }, optional: { type: 'string' },
  } }
  const report = checkSchema(schema, 'Use state and pass.')
  assert.equal(report.ok, false)
  assert.deepEqual(missing(report), [
    { kind: 'required', value: 'marker', path: '#/required/1' },
    { kind: 'enum', value: 'fail', path: '#/properties/state/enum/1' },
    { kind: 'const', value: 'END', path: '#/properties/marker/const' },
  ])
  assert.equal(checkSchema(schema, 'state marker pass fail END').ok, true)
})

test('reports a partly named enum with the exact missing members', () => {
  const report = checkSchema({ enum: ['pass', 'fail', 'skip'] }, 'pass')
  assert.deepEqual(report.enums, [{
    path: '#/enum', values: ['pass', 'fail', 'skip'], mentioned: ['pass'],
    allowed: [], missing: ['fail', 'skip'], partial: true,
  }])
  assert.equal(checkSchema({ enum: ['pass', 'fail'] }, '').enums[0].partial, false)
})

test('follows nested anyOf through oneOf, allOf, properties and array items', () => {
  const schema = { anyOf: [{ type: 'null' }, { properties: { rows: { items: {
    allOf: [{ oneOf: [{ anyOf: [{ const: 'deep' }, { enum: ['near', 'far'] }] }] }],
  } } } }] }
  assert.deepEqual(missing(checkSchema(schema, 'near')), [
    { kind: 'const', value: 'deep', path: '#/anyOf/1/properties/rows/items/allOf/0/oneOf/0/anyOf/0/const' },
    { kind: 'enum', value: 'far', path: '#/anyOf/1/properties/rows/items/allOf/0/oneOf/0/anyOf/1/enum/1' },
  ])
})

test('resolves local definitions, keeps definition paths and ignores unused definitions', () => {
  for (const name of ['$defs', 'definitions']) {
    const schema = { properties: { status: { $ref: `#/${name}/status` } }, [name]: {
      status: { enum: ['ready', 'waiting'] }, unused: { const: 'unreachable' },
    } }
    assert.deepEqual(missing(checkSchema(schema, 'ready')), [
      { kind: 'enum', value: 'waiting', path: `#/${name}/status/enum/1` },
    ])
  }
})

test('handles recursive references once and still visits reference siblings', () => {
  const schema = { $ref: '#/$defs/node', const: 'root', $defs: { node: {
    required: ['name'], properties: { name: { enum: ['leaf'] }, next: { $ref: '#/$defs/node' } },
  } } }
  const report = checkSchema(schema, '')
  assert.deepEqual(report.missing.map((entry) => entry.value).sort(), ['leaf', 'name', 'root'])
  assert.equal(checkSchema({ $ref: '#', const: 'stop' }, 'stop').ok, true)
})

test('resolves escaped and percent-encoded pointers and escapes output property paths', () => {
  const schema = { properties: { 'a/b~c': { $ref: '#/$defs/a~1b~0%20c' } },
    $defs: { 'a/b~ c': { const: 'needle' } }, required: ['a/b~c'] }
  assert.deepEqual(missing(checkSchema(schema, 'a/b~c')), [
    { kind: 'const', value: 'needle', path: '#/$defs/a~1b~0 c/const' },
  ])
  assert.equal(checkSchema({ properties: { 'a/b~c': { const: 'x' } } }, '').missing[0].path,
    '#/properties/a~1b~0c/const')
})

test('rejects broken, external, anchor and inherited-property references', () => {
  for (const ref of ['#/$defs/missing', './other.json', 'https://example.com/schema', '#anchor', '#/toString', '#/%zz', '#/bad~2']) {
    assert.throws(() => checkSchema({ $ref: ref }, ''), /ref|pointer/i)
  }
})

test('whole words do not match similar words or larger identifiers', () => {
  for (const text of ['failed', 'prefail', 'fail_safe', 'fail2', 'éfail', 'fail\u0301', 'fail\u203Fnext']) {
    assert.equal(checkSchema({ const: 'fail' }, text).ok, false, text)
  }
  assert.equal(checkSchema({ const: 'fail' }, 'Choose (fail), please.').ok, true)
})

test('Unicode words, combining marks and explicit case mode work', () => {
  const schema = { enum: ['готов', 'café', '完了'] }
  assert.equal(checkSchema(schema, 'готовность caféine 未完了').missing.length, 3)
  assert.equal(checkSchema(schema, '«готов», café; 完了').ok, true)
  assert.equal(checkSchema(schema, 'ГОТОВ CAFÉ 完了').ok, false)
  assert.equal(checkSchema(schema, 'ГОТОВ CAFÉ 完了', { caseSensitive: false }).ok, true)
  assert.equal(checkSchema({ const: 'café' }, 'cafe\u0301').ok, true)
})

test('literal markers and phrases are escaped instead of interpreted as regexes', () => {
  assert.equal(checkSchema({ enum: ['[DONE]', 'a+b', 'needs review'] }, '[DONE] a+b needs review').ok, true)
  assert.equal(checkSchema({ enum: ['a.b', 'a+b'] }, 'axb aaab').missing.length, 2)
  assert.equal(checkSchema({ const: 'END!' }, 'FRIEND!').ok, false)
})

test('CRLF, BOM and multiple instruction files preserve independent matching', () => {
  const schema = { enum: ['pass', 'fail'] }
  assert.equal(checkSchema(schema, '\uFEFFpass\r\nfail\r\n').ok, true)
  assert.equal(checkSchema(schema, ['pass', 'fail']).ok, true)
  assert.equal(checkSchema({ const: 'passfail' }, ['pass', 'fail']).ok, false)
  assert.equal(checkSchema({ const: 'needs\nreview' }, ['needs', 'review']).ok, false)
  assert.equal(checkSchema({ const: 'needs\nreview' }, 'needs\r\nreview').ok, true)
})

test('allow list exempts exact values, retains evidence, and follows case mode', () => {
  const schema = { required: ['state'], properties: { state: { enum: ['pass', 'fail', 'skip'] } } }
  const report = checkSchema(schema, 'pass', { allowList: ['state', 'fail', 'skip'] })
  assert.equal(report.ok, true)
  assert.equal(report.requirements.filter((entry) => entry.status === 'allowed').length, 3)
  assert.deepEqual(report.enums[0].allowed, ['fail', 'skip'])
  assert.equal(checkSchema({ const: 'fail' }, '', { allowList: ['failed'] }).ok, false)
  assert.equal(checkSchema({ const: 'FAIL' }, '', { allowList: ['fail'] }).ok, false)
  assert.equal(checkSchema({ const: 'FAIL' }, '', { allowList: ['fail'], caseSensitive: false }).ok, true)
})

test('library allow-list values with trailing newlines are not exact exemptions', () => {
  assert.equal(checkSchema({ const: 'fail' }, '', { allowList: ['fail\n'] }).ok, false)
})

test('patterns are manual described? entries and do not masquerade as missing literals', () => {
  const report = checkSchema({ properties: { code: { pattern: '^[A-Z]{3}$' } } }, '')
  assert.equal(report.ok, true)
  assert.deepEqual(report.patterns, [{ path: '#/properties/code/pattern', pattern: '^[A-Z]{3}$', status: 'described?' }])
})

test('supports JSON primitive and composite values and explicit empty-string notation', () => {
  const schema = { enum: [true, false, null, 0, 12, '', { code: 'ok' }, ['a', 'b']] }
  assert.equal(checkSchema(schema, 'true false null 0 12 "" {"code":"ok"} ["a","b"]').ok, true)
  assert.equal(checkSchema({ enum: [0, ''] }, '').missing.length, 2)
  assert.equal(checkSchema({ const: 12 }, '123').ok, false)
})

test('numeric literals do not match inside different signed, decimal or exponent numbers', () => {
  for (const text of ['-12', '+12', '12.5', '0.12', '12e3']) {
    assert.equal(checkSchema({ const: 12 }, text).ok, false, text)
  }
  assert.equal(checkSchema({ const: 12 }, 'Choose 12.').ok, true)
  assert.equal(checkSchema({ const: -12 }, 'Choose -12.').ok, true)
})

test('plain vocabulary keeps markers, skips blanks, and reports original line numbers', () => {
  assert.deepEqual(parseVocabulary('\uFEFFpass\r\n\r\n fail \r\n#END\r\n'), ['pass', 'fail', '#END'])
  const report = checkVocabulary('\uFEFFpass\r\n\r\nfail\r\n#END\r\n', 'pass')
  assert.deepEqual(missing(report), [
    { kind: 'vocabulary', value: 'fail', path: 'line:3' },
    { kind: 'vocabulary', value: '#END', path: 'line:4' },
  ])
  assert.equal(checkVocabulary('pass\nfail', 'pass', { allowList: ['fail'] }).ok, true)
})

test('supports boolean schemas and tuple items without inspecting annotation examples', () => {
  assert.equal(checkSchema(true, '').ok, true)
  assert.equal(checkSchema(false, '').ok, true)
  const report = checkSchema({ items: [{ const: 'first' }, { enum: ['second'] }],
    examples: [{ enum: ['not-a-schema'] }], default: { const: 'also-not-a-schema' } }, '')
  assert.deepEqual(report.missing.map((entry) => entry.path), ['#/items/0/const', '#/items/1/enum/0'])
})

test('malformed supported keywords and unsupported schema-bearing keywords fail loudly', () => {
  for (const schema of [null, [], 'text', { enum: 'a' }, { enum: [] }, { required: 'x' },
    { required: [12] }, { properties: [] }, { items: null }, { anyOf: [] }, { oneOf: {} },
    { pattern: 3 }, { type: 'mystery' }, { $ref: 2 }, { not: { const: 'hidden' } },
    { if: { const: 'hidden' } }, { prefixItems: [{ const: 'hidden' }] },
    { additionalProperties: { const: 'hidden' } }, { $id: 'outer', properties: { x: { $id: 'inner' } } }]) {
    assert.throws(() => checkSchema(schema, ''), /schema|keyword|ref|supported|type|enum|required|pattern|items|properties|anyOf|oneOf/i)
  }
  assert.throws(() => checkSchema({}, 42), /instructions/i)
  assert.throws(() => checkSchema({}, '', { allowList: 'fail' }), /allowList/i)
  assert.throws(() => checkSchema({}, '', { caseSensitive: 'yes' }), /caseSensitive/i)
})

function fixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt covers schema '))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  const outputFiles = ['stdout.txt', 'stderr.txt']
  t.after(() => {
    for (const name of [...Object.keys(files), ...outputFiles]) unlinkSync(join(dir, name))
    rmdirSync(dir)
  })
  return (args) => {
    // File descriptors also work in environments that disallow child-process pipes.
    const descriptors = outputFiles.map((name) => openSync(join(dir, name), 'w'))
    let result
    try {
      result = spawnSync(process.execPath, [cli, ...args], {
        cwd: dir, stdio: ['ignore', ...descriptors], timeout: 10000,
      })
    } finally { descriptors.forEach(closeSync) }
    assert.ifError(result.error)
    return { ...result, stdout: readFileSync(join(dir, outputFiles[0]), 'utf8'),
      stderr: readFileSync(join(dir, outputFiles[1]), 'utf8') }
  }
}

test('CLI emits CI JSON and exit 1 for omissions, exit 0 for complete multiple files', (t) => {
  const run = fixture(t, { 'schema.json': JSON.stringify({ required: ['state'], properties: {
    state: { enum: ['pass', 'fail'] }, marker: { const: 'END' },
  } }), 'prompt one.md': 'state pass\r\n', 'prompt two.md': 'fail END\r\n' })
  const bad = run(['--schema', 'schema.json', '--json', 'prompt one.md'])
  assert.equal(bad.status, 1, bad.stderr)
  const report = JSON.parse(bad.stdout)
  assert.deepEqual(report.missing.map((entry) => entry.value), ['fail', 'END'])
  assert.equal(report.enums[0].partial, true)
  const good = run(['--schema', 'schema.json', '--json', 'prompt one.md', 'prompt two.md'])
  assert.equal(good.status, 0, good.stderr)
  assert.equal(JSON.parse(good.stdout).ok, true)
})

test('CLI handles vocabulary, allow lists, case options and spaced paths without a shell', (t) => {
  const run = fixture(t, { 'words list.txt': '\uFEFFpass\r\nfail\r\n', 'prompt.md': 'PASS', 'allow.txt': 'fail\r\n' })
  const result = run(['--vocab', 'words list.txt', '--ignore-case', '--allow-list', 'allow.txt', '--json', 'prompt.md'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ok, true)
  assert.equal(run(['--vocab', 'words list.txt', '--case-sensitive', 'prompt.md']).status, 1)
})

test('CLI text names missing values, partial enums and manual patterns with paths', (t) => {
  const run = fixture(t, { 'schema.json': JSON.stringify({ enum: ['pass', 'fail'], pattern: '^.+$' }), 'prompt.md': 'pass' })
  const result = run(['--schema', 'schema.json', 'prompt.md'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /#\/enum\/1.*fail/)
  assert.match(result.stdout, /partial.*#\/enum.*fail/i)
  assert.match(result.stdout, /described\?.*#\/pattern/)
})

test('CLI returns exit 2 and machine-readable errors for invalid input or usage', (t) => {
  const run = fixture(t, { 'bad.json': '{', 'remote.json': '{"$ref":"https://example.com/schema"}', 'prompt.md': 'words' })
  for (const args of [[], ['--schema'], ['--unknown'], ['--schema', 'bad.json', 'prompt.md'],
    ['--schema', 'remote.json', 'prompt.md'], ['--schema', 'missing.json', 'prompt.md'],
    ['--schema', 'bad.json', '--vocab', 'prompt.md', 'prompt.md'], ['--vocab', 'prompt.md']]) {
    const result = run(['--json', ...args])
    assert.equal(result.status, 2, result.stderr)
    assert.equal(JSON.parse(result.stdout).ok, false)
    assert.equal(typeof JSON.parse(result.stdout).error, 'string')
  }
  assert.equal(run(['--help']).status, 0)
})

test('CLI accepts UTF-8 BOM JSON and -- for instruction filenames beginning with a dash', (t) => {
  const run = fixture(t, { 'schema.json': '\uFEFF{"const":"ok"}', '-prompt.md': 'ok\r\n' })
  const result = run(['--schema', resolve(fileURLToPath(new URL('.', import.meta.url)), 'missing.json'), '--', '-prompt.md'])
  assert.equal(result.status, 2)
  const good = run(['--schema', 'schema.json', '--', '-prompt.md'])
  assert.equal(good.status, 0, good.stderr)
})
