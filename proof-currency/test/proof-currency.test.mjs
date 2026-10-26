import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep fixtures for diagnosis; no network, shell, or shared repository mutations.
function temporaryDirectory() {
  try { return mkdtempSync(join(tmpdir(), 'proof-currency-')); }
  catch (error) {
    // Sandboxed POSIX runners can inherit a read-only TMPDIR.
    if (process.platform === 'win32' || !['EROFS', 'EACCES'].includes(error.code)) throw error;
    return mkdtempSync('/tmp/proof-currency-');
  }
}
const scratch = temporaryDirectory();
const cli = fileURLToPath(new URL('../bin/proof-currency.mjs', import.meta.url));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
  GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };
delete env.NODE_TEST_CONTEXT;
for (const key of Object.keys(env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT)$/.test(key)) delete env[key];
}
writeFileSync(env.GIT_CONFIG_GLOBAL, '');

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}
function put(repo, name, value = 'changed\n') {
  const filename = join(repo, name);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, value);
  return filename;
}
function commit(repo, message = 'Update fixture') {
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}
function repository() {
  const repo = mkdtempSync(join(scratch, 'repo-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Example Author');
  git(repo, 'config', 'user.email', 'author@example.invalid');
  git(repo, 'config', 'commit.gpgSign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  put(repo, 'src/code.txt', 'original\n');
  put(repo, 'docs/guide.md', 'Guide\n');
  return { repo, proof: commit(repo, 'Initial fixture') };
}
async function check(repo, proof, paths) {
  const { checkRecord } = await import('../index.mjs');
  return checkRecord({ commit: proof, ...(paths === undefined ? {} : { paths }) }, { cwd: repo });
}
function receipt(proof, paths) {
  const directory = mkdtempSync(join(scratch, 'receipt-'));
  return put(directory, 'receipt.json', JSON.stringify({ proof_commit: proof, ...(paths === undefined ? {} : { paths }) }));
}
function run(repo, ...args) {
  const result = spawnSync(process.execPath, [cli, '--repo', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ifError(result.error);
  return result;
}

test('a proof on another branch is not on this history and fails the CLI', async () => {
  const { repo } = repository();
  git(repo, 'checkout', '-b', 'topic');
  put(repo, 'src/code.txt');
  const proof = commit(repo);
  git(repo, 'checkout', 'main');
  const result = await check(repo, proof, ['src']);
  assert.equal(result.verdict, 'not on this history');
  assert.deepEqual(result.changedPaths, []);
  assert.match(result.reason, /ancestor|history/i);
  assert.equal(run(repo, receipt(proof, ['src'])).status, 1);
});

test('a real rebase leaves the old proof off history even with identical covered files', async () => {
  const { repo } = repository();
  git(repo, 'checkout', '-b', 'topic');
  put(repo, 'src/code.txt');
  const proof = commit(repo);
  git(repo, 'checkout', 'main');
  put(repo, 'docs/guide.md');
  commit(repo);
  git(repo, 'checkout', 'topic');
  git(repo, 'rebase', 'main');
  assert.notEqual(git(repo, 'rev-parse', 'HEAD'), proof);
  assert.equal((await check(repo, proof, ['src'])).verdict, 'not on this history');
});

test('a shallow local clone reports an absent proof as unknown and never current', async () => {
  const { repo, proof } = repository();
  put(repo, 'docs/guide.md');
  commit(repo);
  const clone = join(scratch, `shallow-${proof}`);
  git(scratch, 'clone', '--depth=1', pathToFileURL(repo).href, clone);
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  const result = await check(clone, proof, ['src']);
  assert.equal(result.verdict, 'unknown commit');
  assert.match(result.reason, /clone|resolve|available/i);
  assert.equal(run(clone, receipt(proof, ['src'])).status, 1);
});

test('an uncommitted covered change makes a HEAD proof stale and fails the CLI', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  const result = await check(repo, proof, ['src']);
  assert.equal(result.verdict, 'stale');
  assert.deepEqual(result.changedPaths, ['src/code.txt']);
  const output = run(repo, receipt(proof, ['src']));
  assert.equal(output.status, 1);
  assert.match(output.stdout, /stale/);
  assert.match(output.stdout, /src\/code\.txt/);
});

test('a changed ancestor is stale, with only covered changed paths listed', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  put(repo, 'docs/guide.md');
  commit(repo);
  const result = await check(repo, proof, ['src']);
  assert.equal(result.verdict, 'stale');
  assert.deepEqual(result.changedPaths, ['src/code.txt']);
});

test('HEAD is current when covered paths are clean, including abbreviated hashes', async () => {
  const { repo, proof } = repository();
  put(repo, 'docs/guide.md');
  const result = await check(repo, proof.slice(0, 12), ['src']);
  assert.equal(result.verdict, 'current');
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.resolvedCommit, proof);
  assert.equal(run(repo, receipt(proof, ['src'])).status, 0);
});

test('an unchanged ancestor is still about these paths, but dirty paths make it stale', async () => {
  const { repo, proof } = repository();
  put(repo, 'docs/guide.md');
  commit(repo);
  assert.equal((await check(repo, proof, ['src'])).verdict, 'still about these paths');
  assert.equal(run(repo, receipt(proof, ['src'])).status, 0);
  put(repo, 'src/code.txt');
  assert.equal((await check(repo, proof, ['src'])).verdict, 'stale');
});

test('missing paths, an empty list and dot cover the entire repository', async () => {
  const { repo, proof } = repository();
  assert.equal((await check(repo, proof)).verdict, 'current');
  put(repo, 'new directory/new file.txt');
  for (const paths of [undefined, [], ['.']]) {
    const result = await check(repo, proof, paths);
    assert.equal(result.verdict, 'stale');
    assert.deepEqual(result.changedPaths, ['new directory/new file.txt']);
  }
});

test('staged changes count even if the worktree has been restored to HEAD content', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  git(repo, 'add', '.');
  put(repo, 'src/code.txt', 'original\n');
  assert.equal((await check(repo, proof, ['src'])).verdict, 'stale');
});

test('deleted paths and both sides of staged and committed renames are covered', async () => {
  const { repo, proof } = repository();
  renameSync(join(repo, 'src/code.txt'), join(repo, 'docs/moved.txt'));
  git(repo, 'add', '.');
  assert.deepEqual((await check(repo, proof, ['src'])).changedPaths, ['src/code.txt']);
  assert.deepEqual((await check(repo, proof, ['docs/moved.txt'])).changedPaths, ['docs/moved.txt']);
  commit(repo);
  assert.deepEqual((await check(repo, proof, ['src'])).changedPaths, ['src/code.txt']);
  const head = git(repo, 'rev-parse', 'HEAD');
  unlinkSync(join(repo, 'docs/moved.txt'));
  assert.equal((await check(repo, head, ['docs'])).verdict, 'stale');
});

test('literal path boundaries, spaces, Unicode and Windows separators work', async () => {
  const { repo } = repository();
  put(repo, 'src/a [draft] café.txt', 'original\n');
  const proof = commit(repo);
  put(repo, 'src/a [draft] café.txt');
  put(repo, 'src-extra/code.txt');
  assert.deepEqual((await check(repo, proof, ['src\\a [draft] café.txt'])).changedPaths, ['src/a [draft] café.txt']);
  assert.equal((await check(repo, proof, ['sr'])).verdict, 'current');
});

test('NUL-delimited paths preserve embedded newlines on systems allowing them', { skip: process.platform === 'win32' }, async () => {
  const { repo } = repository();
  put(repo, 'src/line\nbreak.txt', 'original\n');
  const proof = commit(repo);
  put(repo, 'src/line\nbreak.txt');
  assert.deepEqual((await check(repo, proof, ['src'])).changedPaths, ['src/line\nbreak.txt']);
  commit(repo);
  assert.deepEqual((await check(repo, proof, ['src'])).changedPaths, ['src/line\nbreak.txt']);
});

test('JSON discovery supports nested receipts, multiple fields and separate scopes', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  const file = put(scratch, 'nested.json', JSON.stringify({ receipts: [
    { proof_commit: proof, paths: ['src'] },
    { verified_at: proof, commit: proof, paths: ['docs'] }
  ] }));
  const { checkFiles } = await import('../index.mjs');
  const results = checkFiles([file], { cwd: repo });
  assert.deepEqual(results.map(r => r.verdict), ['stale', 'current', 'current']);
  assert.ok(results.every(r => r.source.file === file && r.source.field));
  assert.equal(run(repo, file).status, 1);
});

test('front matter reads CRLF, comments, quoted hashes, inline and block path lists', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  const { checkFiles } = await import('../index.mjs');
  for (const paths of ['paths: [src, "docs/guide.md"]', 'paths:\n  - src\n  - \'docs/guide.md\'']) {
    const file = put(scratch, 'report.md', `\uFEFF---\ntitle: Example\nproof_commit: '${proof}' # checked\n${paths}\n---\n# Report\ncommit: irrelevant\n`.replaceAll('\n', '\r\n'));
    const results = checkFiles([file], { cwd: repo });
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'stale');
    assert.deepEqual(results[0].changedPaths, ['src/code.txt']);
  }
});

test('custom keys and paths key work in JSON and front matter through CLI and library', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  const config = { keys: ['checked_revision'], pathsKey: 'covers' };
  const configFile = put(scratch, 'config.json', JSON.stringify(config));
  const files = [put(scratch, 'custom.json', JSON.stringify({ checked_revision: proof, covers: ['src'] })),
    put(scratch, 'custom.md', `---\nchecked_revision: ${proof}\ncovers: [src]\n---\n`)];
  const { checkFiles } = await import('../index.mjs');
  assert.deepEqual(checkFiles(files, { cwd: repo, config }).map(r => r.verdict), ['stale', 'stale']);
  assert.equal(run(repo, '--config', configFile, ...files).status, 1);
});

test('report-only exits zero for every red verdict and input errors remain visible', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  const stale = receipt(proof, ['src']);
  const unknown = receipt('f'.repeat(40), ['src']);
  for (const file of [stale, unknown]) {
    assert.equal(run(repo, file).status, 1);
    assert.equal(run(repo, '--report-only', file).status, 0);
  }
  git(repo, 'checkout', '-b', 'topic');
  const offHistory = commit(repo);
  git(repo, 'checkout', 'main');
  assert.equal(run(repo, '--report-only', receipt(offHistory, ['src'])).status, 0);
  const missing = join(scratch, 'missing.json');
  const output = run(repo, '--report-only', missing);
  assert.equal(output.status, 0);
  assert.match(output.stderr, /error|cannot|no such/i);
  assert.equal(run(repo, missing).status, 2);
});

test('malformed records, unsafe paths and moving refs cannot silently pass', async () => {
  const { repo, proof } = repository();
  const { checkFiles } = await import('../index.mjs');
  for (const record of [
    { commit: 'HEAD' }, { commit: '--help' }, { commit: 1234 }, { commit: '' },
    { commit: proof, paths: 'src' }, { commit: proof, paths: ['../outside'] },
    { commit: proof, paths: ['/absolute'] }, { commit: proof, paths: ['C:\\absolute'] },
    { commit: proof, paths: [42] }, { commit: proof, paths: [''] }
  ]) {
    const file = put(scratch, 'invalid.json', JSON.stringify(record));
    assert.throws(() => checkFiles([file], { cwd: repo }));
    assert.equal(run(repo, file).status, 2);
  }
  for (const source of [`---\ncommit: ${proof}\ncommit: ${proof}\n---`,
    `---\ncommit: ${proof}\npaths: [src\n---`, `---\ncommit: ${proof}\n`]) {
    const file = put(scratch, 'invalid.md', source);
    assert.throws(() => checkFiles([file], { cwd: repo }));
  }
});

test('no records, malformed config and a non-repository fail explicitly', async () => {
  const { repo, proof } = repository();
  const empty = put(scratch, 'empty.md', '# Nothing recorded\n');
  const output = run(repo, empty);
  assert.equal(output.status, 2);
  assert.match(output.stderr, /no proof records/i);
  const file = receipt(proof, ['src']);
  for (const config of [{ keys: [] }, { keys: ['commit'], pathsKey: 'commit' }, { key: ['typo'] }]) {
    assert.equal(run(repo, '--config', put(scratch, 'bad-config.json', JSON.stringify(config)), file).status, 2);
  }
  assert.equal(run(scratch, file).status, 2);
  assert.equal(run(repo, '--help').status, 0);
  assert.equal(run(repo, '--unknown-option', file).status, 2);
});

test('repository root scopes work when invoked from a nested directory', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  assert.deepEqual((await check(join(repo, 'docs'), proof, ['src'])).changedPaths, ['src/code.txt']);
});

test('explicit null config values cannot silently select defaults', async () => {
  const { configuration } = await import('../lib/records.mjs');
  for (const config of [{ keys: null }, { pathsKey: null }]) assert.throws(() => configuration(config));
});

test('front matter handles comma and comment characters inside quoted coverage paths', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/part, #one.txt');
  const file = put(scratch, 'quoted.md', `---\ncommit: ${proof}\npaths: ["src/part, #one.txt"] # note\n---\n`);
  const { checkFiles } = await import('../index.mjs');
  assert.deepEqual(checkFiles([file], { cwd: repo })[0].changedPaths, ['src/part, #one.txt']);
});

test('CLI file paths follow the invocation directory and -- ends option parsing', () => {
  const { repo, proof } = repository();
  const file = put(scratch, '-receipt.json', JSON.stringify({ commit: proof, paths: ['src'] }));
  const result = spawnSync(process.execPath, [cli, '--repo', repo, '--', '-receipt.json'], {
    cwd: dirname(file), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /current/);
});

test('a missing commit and an existing non-commit object are both unknown', async () => {
  const { repo } = repository();
  for (const proof of ['0'.repeat(40), git(repo, 'rev-parse', 'HEAD:src/code.txt')]) {
    const result = await check(repo, proof, ['src']);
    assert.equal(result.verdict, 'unknown commit');
    assert.deepEqual(result.changedPaths, []);
  }
});

// Two commits whose hashes share their first four characters make that short hash
// ambiguous. Some Git versions exit 128 for it, which must not become an exception.
function ambiguousPrefix(repo) {
  let input = '';
  for (let i = 0; i < 4000; i++) {
    const message = `pile ${i}`;
    input += `commit refs/heads/pile\ncommitter Example Author <author@example.invalid> ${1700000000 + i} +0000\n`
      + `data ${message.length}\n${message}\n\n`;
  }
  const imported = spawnSync('git', ['-C', repo, 'fast-import', '--quiet'], { env, input, encoding: 'utf8' });
  assert.ifError(imported.error);
  assert.equal(imported.status, 0, imported.stderr);
  const seen = new Map();
  for (const id of git(repo, 'rev-list', '--all').split(/\r?\n/)) {
    const prefix = id.slice(0, 4);
    if (seen.has(prefix) && seen.get(prefix) !== id) return prefix;
    seen.set(prefix, id);
  }
  throw new Error('no ambiguous four-character prefix among 4000 commits');
}

test('an ambiguous short hash is answered as unknown or ambiguous, not thrown', async () => {
  const { repo } = repository();
  const prefix = ambiguousPrefix(repo);
  const result = await check(repo, prefix, ['src']);
  assert.equal(result.verdict, 'unknown commit');
  assert.match(result.reason, /unknown or ambiguous commit/i);
  assert.equal(result.resolvedCommit, null);
  assert.deepEqual(result.changedPaths, []);
  const cliResult = run(repo, receipt(prefix, ['src']));
  assert.equal(cliResult.status, 1, cliResult.stderr);
  assert.match(cliResult.stdout, /unknown commit/);
  assert.match(cliResult.stdout, /unknown or ambiguous commit/i);
});

test('changed paths are sorted, deduplicated and include untracked covered files', async () => {
  const { repo, proof } = repository();
  put(repo, 'src/code.txt');
  commit(repo);
  put(repo, 'src/code.txt', 'another change\n');
  put(repo, 'src/new file.txt');
  assert.deepEqual((await check(repo, proof, ['src', 'src/code.txt'])).changedPaths, ['src/code.txt', 'src/new file.txt']);
});
