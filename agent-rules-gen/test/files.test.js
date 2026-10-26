import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, generate } from '../lib/index.js';

const rules = '---\nagents: [codex, claude]\n---\n## Shared\nKeep changes small.\n';
const begin = '<!-- agent-rules-gen:begin -->';
const end = '<!-- agent-rules-gen:end -->';
const cli = fileURLToPath(new URL('../bin/agent-rules-gen.js', import.meta.url));

function fixture(t, source = rules) {
  let cwd;
  try { cwd = mkdtempSync(join(tmpdir(), 'agent-rules-gen space-')); } catch (error) {
    if (!['EROFS', 'EACCES'].includes(error.code)) throw error;
    cwd = mkdtempSync(fileURLToPath(new URL('../.test space-', import.meta.url)));
  }
  writeFileSync(join(cwd, 'rules.md'), source);
  // Fixtures are flat: remove only their individual files, never recursively.
  t.after(() => {
    for (const file of readdirSync(cwd)) unlinkSync(join(cwd, file));
    rmdirSync(cwd);
  });
  return cwd;
}

function run(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const stdoutFile = join(cwd, 'stdout.log');
    const stderrFile = join(cwd, 'stderr.log');
    const stdout = openSync(stdoutFile, 'w');
    const stderr = openSync(stderrFile, 'w');
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, shell: false, stdio: ['ignore', stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    child.on('error', reject);
    child.on('close', (status) => resolve({
      status, stdout: readFileSync(stdoutFile, 'utf8'), stderr: readFileSync(stderrFile, 'utf8'),
    }));
  });
}

test('generates both files; second run does not rewrite files or timestamps', (t) => {
  const cwd = fixture(t);
  assert.equal(check({ cwd }).ok, false);
  assert.equal(generate({ cwd }).changed.length, 2);
  assert.equal(check({ cwd }).ok, true);
  const file = join(cwd, 'AGENTS.md');
  const before = readFileSync(file);
  utimesSync(file, new Date(1000000000000), new Date(1000000000000));
  const mtime = statSync(file).mtimeMs;
  assert.deepEqual(generate({ cwd }).changed, []);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).mtimeMs, mtime);
});

test('check detects edited body/header and stale source without writing', (t) => {
  const cwd = fixture(t);
  generate({ cwd });
  const file = join(cwd, 'AGENTS.md');
  for (const edited of [
    readFileSync(file, 'utf8').replace('Keep changes small.', 'Ignore reviews.'),
    readFileSync(file, 'utf8').replace(/Source SHA-256[^\n]+/, 'Source SHA-256: false'),
  ]) {
    writeFileSync(file, edited);
    assert.equal(check({ cwd }).ok, false);
    assert.equal(readFileSync(file, 'utf8'), edited);
    generate({ cwd });
  }
  writeFileSync(join(cwd, 'rules.md'), rules.replace('small', 'focused'));
  assert.equal(check({ cwd }).issues.length, 2);
  generate({ cwd });
  assert.equal(check({ cwd }).ok, true);
});

for (const manual of ['', '# Manual\nLocal notes.\n', '# Manual without final newline', '\uFEFF# Manual\r\n']) {
  test(`preserves manual text and suffix byte-for-byte: ${JSON.stringify(manual)}`, (t) => {
    const cwd = fixture(t);
    const file = join(cwd, 'AGENTS.md');
    writeFileSync(file, manual);
    generate({ cwd });
    const generated = readFileSync(file, 'utf8');
    assert.ok(generated.startsWith(manual));
    const suffix = '\r\n\r\n## Local\nUnmanaged text.  ';
    writeFileSync(file, generated + suffix);
    assert.equal(check({ cwd }).ok, true);
    const prefix = generated.slice(0, generated.indexOf(begin));
    writeFileSync(join(cwd, 'rules.md'), rules.replace('small', 'focused'));
    generate({ cwd });
    const updated = readFileSync(file, 'utf8');
    assert.ok(updated.startsWith(prefix));
    assert.ok(updated.endsWith(suffix));
    assert.match(updated, /focused/);
  });
}

test('CRLF source creates CRLF files; Git-style checkout keeps the hash fresh', (t) => {
  const cwd = fixture(t, '\uFEFF' + rules.replace(/\n/g, '\r\n'));
  generate({ cwd });
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = join(cwd, name);
    const content = readFileSync(file, 'utf8');
    assert.ok(content.includes('\r\n'));
    assert.equal(content.replace(/\r\n/g, '').includes('\n'), false);
    writeFileSync(file, content.replace(/\r\n/g, '\n'));
  }
  writeFileSync(join(cwd, 'rules.md'), rules);
  assert.equal(check({ cwd }).ok, true);
});

test('each existing destination keeps its own newline style', (t) => {
  const cwd = fixture(t, rules.replace(/\n/g, '\r\n'));
  writeFileSync(join(cwd, 'AGENTS.md'), '# Manual\n');
  writeFileSync(join(cwd, 'CLAUDE.md'), '# Manual\r\n');
  generate({ cwd });
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8').includes('\r'), false);
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '').includes('\n'), false);
});

for (const broken of [
  begin + '\nText', end, end + '\n' + begin, begin + '\n' + begin + '\n' + end,
  begin + '\nText\n' + end + '\n' + begin + '\nText\n' + end,
  '<!-- agent-rules-gen:begin ->\nText\n' + end,
  'prefix ' + begin + '\nText\n' + end,
]) {
  test(`refuses ambiguous markers without modifying either file: ${JSON.stringify(broken)}`, (t) => {
    const cwd = fixture(t);
    const first = join(cwd, 'AGENTS.md');
    const second = join(cwd, 'CLAUDE.md');
    writeFileSync(first, '# Manual');
    writeFileSync(second, broken);
    assert.equal(check({ cwd }).ok, false);
    assert.throws(() => generate({ cwd }), /marker|block/i);
    assert.equal(readFileSync(first, 'utf8'), '# Manual');
    assert.equal(readFileSync(second, 'utf8'), broken);
  });
}

for (const fenceMark of ['```', '~~~~']) {
  test(`markers quoted inside a ${fenceMark} code fence are documentation, not markers`, (t) => {
    const cwd = fixture(t);
    const file = join(cwd, 'AGENTS.md');
    const quoted = [
      '# Contributing', '', 'The generated section is bounded like this:', '',
      fenceMark + 'markdown', begin, 'rules go here', end,
      '<!-- agent-rules-gen:begin ->', fenceMark, '',
    ].join('\n');
    writeFileSync(file, quoted);
    assert.equal(check({ cwd }).issues.some((issue) => /marker|fence/i.test(issue.reason)), false);
    generate({ cwd });
    const generated = readFileSync(file, 'utf8');
    assert.ok(generated.startsWith(quoted), 'quoted text is preserved byte for byte');
    assert.equal(generated.split(begin).length, 3, 'one quoted and one real begin marker');
    assert.equal(check({ cwd }).ok, true);

    // A later change replaces only the real block, wherever the quote sits.
    writeFileSync(join(cwd, 'rules.md'), rules.replace('small', 'focused'));
    generate({ cwd });
    const updated = readFileSync(file, 'utf8');
    assert.ok(updated.startsWith(quoted));
    assert.match(updated, /Keep changes focused\./);
    assert.equal(check({ cwd }).ok, true);

    // The same quote placed after the real block must not be taken for a second pair.
    const block = updated.slice(quoted.length);
    writeFileSync(file, block + '\n' + quoted);
    assert.equal(check({ cwd }).ok, true);
  });
}

test('a marker line outside any code fence is still refused after a closed fence', (t) => {
  const cwd = fixture(t);
  const file = join(cwd, 'AGENTS.md');
  const broken = '```\n' + begin + '\n```\n' + begin + '\nText\n';
  writeFileSync(file, broken);
  assert.equal(check({ cwd }).ok, false);
  assert.throws(() => generate({ cwd }), /marker|block/i);
  assert.equal(readFileSync(file, 'utf8'), broken);
});

test('an unterminated code fence in a destination is refused without writing', (t) => {
  const cwd = fixture(t);
  const file = join(cwd, 'AGENTS.md');
  const broken = '# Manual\n```sh\nnpm test\n';
  writeFileSync(file, broken);
  assert.match(check({ cwd }).issues[0].reason, /code fence/);
  assert.throws(() => generate({ cwd }), /code fence/);
  assert.equal(readFileSync(file, 'utf8'), broken);
  assert.equal(existsSync(join(cwd, 'CLAUDE.md')), false);
});

test('refuses invalid UTF-8 and source/output collisions without overwriting', (t) => {
  const cwd = fixture(t);
  const file = join(cwd, 'AGENTS.md');
  const bytes = Buffer.from([0xff, 0xfe, 0x61]);
  writeFileSync(file, bytes);
  assert.throws(() => generate({ cwd }), /UTF-8/);
  assert.deepEqual(readFileSync(file), bytes);
  writeFileSync(file, rules);
  assert.throws(() => generate({ cwd, source: 'AGENTS.md' }), /source|same/i);
  assert.equal(readFileSync(file, 'utf8'), rules);
});

test('refuses symlink destinations without touching their referents', (t) => {
  const cwd = fixture(t);
  const target = join(cwd, 'manual.md');
  const link = join(cwd, 'AGENTS.md');
  writeFileSync(target, '# Important manual content');
  try { symlinkSync(target, link); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Symlink privilege unavailable');
    throw error;
  }
  assert.throws(() => generate({ cwd }), /symbolic link/);
  assert.equal(check({ cwd }).ok, false);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), '# Important manual content');
});

test('check on a missing output directory creates nothing', (t) => {
  const cwd = fixture(t);
  const outDir = join(cwd, 'missing');
  assert.equal(check({ cwd, outDir }).ok, false);
  assert.equal(existsSync(outDir), false);
});

test('CLI handles spaces, Unicode, fresh/stale/edited states and usage errors', async (t) => {
  const cwd = fixture(t);
  const source = 'team rules é.md';
  writeFileSync(join(cwd, source), rules);
  const options = ['--source', source, '--out-dir', cwd];
  assert.equal((await run(cwd, 'check', ...options)).status, 1);
  assert.equal((await run(cwd, 'generate', ...options)).status, 0);
  assert.equal((await run(cwd, 'check', ...options)).status, 0);
  assert.match((await run(cwd, 'generate', ...options)).stdout, /unchanged/i);
  const file = join(cwd, 'AGENTS.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('small', 'large'));
  assert.equal((await run(cwd, 'check', ...options)).status, 1);
  assert.equal((await run(cwd, 'generate', ...options)).status, 0);
  writeFileSync(join(cwd, source), rules + '\n');
  assert.equal((await run(cwd, 'check', ...options)).status, 1);
  for (const args of [[], ['invalid'], ['generate', '--typo'], ['check', '--source'], ['generate', '--source', '--out-dir', '.']]) {
    const result = await run(cwd, ...args);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.length > 0);
  }
  assert.equal((await run(cwd, '--help')).status, 0);
  assert.equal((await run(cwd, 'generate', '--source', 'missing.md')).status, 2);
});
