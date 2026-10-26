import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, closeSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check, generate, renderRules } from '../lib/index.js';

test('the bundled sample generates different sections, then removes obsolete rules', (t) => {
  const cwd = mkdtempSync(fileURLToPath(new URL('../.test sample-', import.meta.url)));
  t.after(() => {
    for (const name of readdirSync(cwd)) unlinkSync(join(cwd, name));
    rmdirSync(cwd);
  });
  const source = readFileSync(new URL('../examples/rules.md', import.meta.url), 'utf8');
  writeFileSync(join(cwd, 'rules.md'), source);
  generate({ cwd });
  const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  const claude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
  assert.match(agents, /## Verification/);
  assert.doesNotMatch(agents, /## Review/);
  assert.match(claude, /## Review/);
  assert.doesNotMatch(claude, /## Verification/);
  assert.deepEqual(generate({ cwd }).changed, []);
  writeFileSync(join(cwd, 'rules.md'), '---\nagents: [claude]\n---\nReplacement.\n');
  generate({ cwd });
  assert.doesNotMatch(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), /## Verification|Keep patches/);
  assert.equal(check({ cwd }).ok, true);
});

test('preserves a BOM-only prefix, no final newline and POSIX permission bits', (t) => {
  const cwd = mkdtempSync(fileURLToPath(new URL('../.test boundaries-', import.meta.url)));
  t.after(() => {
    for (const name of readdirSync(cwd)) unlinkSync(join(cwd, name));
    rmdirSync(cwd);
  });
  const source = '---\nagents: [codex]\n---\nOld text.\n';
  writeFileSync(join(cwd, 'rules.md'), source.replace('Old', 'New'));
  const file = join(cwd, 'AGENTS.md');
  writeFileSync(file, '\uFEFF' + renderRules(source)['AGENTS.md']);
  if (process.platform !== 'win32') chmodSync(file, 0o640);
  generate({ cwd });
  const result = readFileSync(file, 'utf8');
  assert.ok(result.startsWith('\uFEFF<!-- agent-rules-gen:begin -->'));
  assert.ok(result.endsWith('<!-- agent-rules-gen:end -->'));
  assert.match(result, /New text/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.equal(check({ cwd }).ok, true);
});

test('CLI rejects object-prototype names as unknown flags before writing', async (t) => {
  const cwd = mkdtempSync(fileURLToPath(new URL('../.test flags-', import.meta.url)));
  t.after(() => {
    for (const name of readdirSync(cwd)) unlinkSync(join(cwd, name));
    rmdirSync(cwd);
  });
  writeFileSync(join(cwd, 'rules.md'), '---\nagents: [codex]\n---\nRules.\n');
  for (const flag of ['constructor', 'toString', '__proto__']) {
    const output = join(cwd, 'result.log');
    const descriptor = openSync(output, 'w');
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../bin/agent-rules-gen.js', import.meta.url)), 'generate', flag, 'value',
    ], { cwd, shell: false, stdio: ['ignore', descriptor, descriptor] });
    closeSync(descriptor);
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(status, 2, flag);
    assert.match(readFileSync(output, 'utf8'), /Unknown option/);
    assert.deepEqual(readdirSync(cwd).sort(), ['result.log', 'rules.md']);
  }
});
