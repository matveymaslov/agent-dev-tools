import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatHit, parseMarkers, parsePatch, scanRange } from '../lib/index.mjs';
import { readQuoted } from '../lib/patch.mjs';

const cli = fileURLToPath(new URL('../bin/added-lines-scan.mjs', import.meta.url));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const posix = process.platform !== 'win32';
const windowsSkip = 'file names with quotes, backslashes and newlines are not valid on Windows';

// Every repository lives in one sandbox, with an empty Git configuration, so the tests do not
// depend on the machine they run on (signing, hooks, default branch names, line-ending rules).
const sandbox = mkdtempSync(join(tmpdir(), 'added-lines-scan-'));
const emptyConfig = join(sandbox, 'gitconfig');
writeFileSync(emptyConfig, '');
after(() => rmSync(sandbox, { recursive: true, force: true }));
const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[name];
let counter = 0;
const unique = prefix => join(sandbox, `${prefix}-${++counter}`);

function git(dir, ...args) {
  const result = spawnSync('git', ['-C', dir, ...args], { env: ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const dir = unique('repo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
    git(dir, 'config', key, value);
  }
  return dir;
}

// files: { path: content } writes and stages the file, { path: null } removes it.
function commit(dir, message, files = {}) {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) git(dir, 'rm', '-q', '--', name);
    else {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
      git(dir, 'add', '--', name);
    }
  }
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const short = (dir, sha) => git(dir, 'log', '-1', '--format=%h', sha);

function markersFile(text) {
  const file = `${unique('markers')}.txt`;
  writeFileSync(file, text);
  return file;
}

function run(args, { cwd, env = ENV } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  return result;
}

const scan = (dir, range, markers, extra = []) => run(['--repo', dir, '--range', range, '--markers', markersFile(markers), ...extra]);
const lines = text => text.split('\n').filter(Boolean);

// ---- the failure the tool exists for ----

test('a leak added in one commit and removed by a later one is still reported', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'README.txt': 'hello\n' });
  const leak = commit(dir, 'add notes', { 'notes.txt': 'fine\nthe secret-token is here\nalso fine\n' });
  commit(dir, 'remove the leak', { 'notes.txt': 'fine\nalso fine\n' });
  // what a scan of the end state, or of the overall diff, sees: nothing
  assert.doesNotMatch(git(dir, 'diff', base, 'HEAD'), /secret-token/);
  assert.doesNotMatch(readFileSync(join(dir, 'notes.txt'), 'utf8'), /secret-token/);
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(lines(result.stdout), [`${short(dir, leak)} notes.txt:2 secret-token (the secret-token is here)`]);
  assert.match(result.stderr, /1 hit in 1 commit of .+\.\.HEAD \(2 commits scanned\)/);
});

test('a clean range exits 0 with a one-line summary of the range and the commit count', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'one\n' });
  commit(dir, 'two', { 'a.txt': 'one\ntwo\n' });
  commit(dir, 'three', { 'b.txt': 'three\n' });
  const result = scan(dir, `${base}..HEAD`, 'secret-token\nother-marker\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `added-lines-scan: clean: 2 commits in ${base}..HEAD scanned against 2 markers\n`);
  assert.equal(result.stderr, '');
});

test('an empty range is clean, with zero commits said explicitly', () => {
  const dir = makeRepo();
  commit(dir, 'base', { 'a.txt': 'secret-token\n' });
  const result = scan(dir, 'HEAD..HEAD', 'secret-token\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'added-lines-scan: clean: HEAD..HEAD has 0 commits, nothing to scan\n');
});

test('a marker that sits only in history before the range is not reported', () => {
  const dir = makeRepo();
  const base = commit(dir, 'already published', { 'a.txt': 'secret-token\n' });
  commit(dir, 'new work', { 'b.txt': 'fine\n' });
  assert.equal(scan(dir, `${base}..HEAD`, 'secret-token\n').status, 0);
  assert.equal(scan(dir, 'HEAD', 'secret-token\n').status, 1, 'the whole history, root commit included, does hold it');
});

test('hits come oldest commit first, one report line per hit, one per matching marker', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'x\n' });
  const first = commit(dir, 'first', { 'a.txt': 'x\nAlpha beta\n' });
  const second = commit(dir, 'second', { 'b.txt': 'beta only\nsecond ALPHA\n' });
  const result = scan(dir, `${base}..HEAD`, 'alpha\n/alpha/i\nbeta\n');
  assert.equal(result.status, 1);
  assert.deepEqual(lines(result.stdout), [
    `${short(dir, first)} a.txt:2 /alpha/i (Alpha beta)`,
    `${short(dir, first)} a.txt:2 beta (Alpha beta)`,
    `${short(dir, second)} b.txt:1 beta (beta only)`,
    `${short(dir, second)} b.txt:2 /alpha/i (second ALPHA)`,
  ]);
  assert.match(result.stderr, /4 hits in 2 commits/);
});

test('the range may be a single revision or revisions with exclusions, as a push of a new branch needs', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'x\n' });
  git(dir, 'switch', '-q', '-c', 'feature');
  const leak = commit(dir, 'feature', { 'a.txt': 'x\nsecret-token\n' });
  const result = scan(dir, `feature ^${base}`, 'secret-token\n');
  assert.equal(result.status, 1);
  assert.deepEqual(lines(result.stdout).map(line => line.split(' ')[0]), [short(dir, leak)]);
  assert.equal(scan(dir, `feature ^${leak}`, 'secret-token\n').status, 0);
});

// ---- what a patch can look like ----

test('line numbers are those of the new file, after deletions and with an added last line', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'd.txt': 'one\ntwo\nthree\nfour\nfive\n' });
  const change = commit(dir, 'rewrite', { 'd.txt': 'one\nthree\nfour\nfive\nsecret-token\n' });
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.deepEqual(lines(result.stdout), [`${short(dir, change)} d.txt:5 secret-token (secret-token)`]);
});

test('a commit that deletes a marker line adds nothing', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'fine\nsecret-token\nfine\n' });
  commit(dir, 'delete it', { 'a.txt': 'fine\nfine\n' });
  assert.equal(scan(dir, `${base}..HEAD`, 'secret-token\n').status, 0);
});

test('a renamed file reports only the lines the rename commit changed, under the new name and number', () => {
  const dir = makeRepo();
  const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of the old file`);
  body[3] = 'old line with secret-token';
  const base = commit(dir, 'base', { 'old name.txt': `${body.join('\n')}\n` });
  mkdirSync(join(dir, 'new'));
  git(dir, 'mv', 'old name.txt', 'new/new name.txt');
  const changed = [...body.slice(0, 8), 'added with secret-token', ...body.slice(8)];
  const rename = commit(dir, 'rename and edit', { 'new/new name.txt': `${changed.join('\n')}\n` });
  assert.match(git(dir, 'show', '--stat', '-M', '--format=', rename), /=>/, 'Git must see a rename for this test to mean anything');
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.deepEqual(lines(result.stdout), [`${short(dir, rename)} new/new name.txt:9 secret-token (added with secret-token)`]);
});

test('a pure rename adds nothing', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'one\nsecret-token\nthree\n' });
  git(dir, 'mv', 'a.txt', 'b.txt');
  commit(dir, 'rename only');
  assert.equal(scan(dir, `${base}..HEAD`, 'secret-token\n').status, 0);
});

test('CRLF files: the carriage return is not part of the line, so $ anchors match', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'x\r\n' });
  const change = commit(dir, 'crlf', { 'a.txt': 'x\r\nthe secret-token\r\nlast\r\n' });
  const result = scan(dir, `${base}..HEAD`, 'secret-token$\n');
  assert.equal(result.status, 1);
  assert.deepEqual(lines(result.stdout), [`${short(dir, change)} a.txt:2 secret-token$ (the secret-token)`]);
  assert.doesNotMatch(result.stdout, /\r/);
});

test('a file without a final newline is read correctly', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'a\nb' });
  const change = commit(dir, 'append', { 'a.txt': 'a\nb\nsecret-token' });
  assert.deepEqual(lines(scan(dir, `${base}..HEAD`, 'secret-token\n').stdout), [`${short(dir, change)} a.txt:3 secret-token (secret-token)`]);
});

test('added lines that look like patch headers are data', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'x\n' });
  const tricky = ['++ b/fake.txt secret-token', '-- a/fake.txt secret-token', '@@ -1,1 +1,1 @@ secret-token', '@@commit abc secret-token', 'diff --git a/x b/x secret-token'];
  const change = commit(dir, 'tricky', { 'a.txt': `x\n${tricky.join('\n')}\n` });
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(lines(result.stdout).map(line => line.slice(0, line.indexOf(' secret-token'))),
    tricky.map((_, i) => `${short(dir, change)} a.txt:${i + 2}`));
});

test('paths with spaces and non-ASCII letters, under a hostile Git configuration', () => {
  const dir = makeRepo();
  for (const [key, value] of [['core.quotepath', 'true'], ['diff.noprefix', 'true'], ['diff.renames', 'false'],
    ['diff.mnemonicPrefix', 'true'], ['log.showSignature', 'true'], ['core.pager', 'false']]) git(dir, 'config', key, value);
  const base = commit(dir, 'base', { 'x.txt': 'x\n' });
  const change = commit(dir, 'names', { 'my docs/a file.txt': 'secret-token\n', 'café/naïve ünï.txt': 'ok\nsecret-token\n' });
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(lines(result.stdout).sort(), [
    `${short(dir, change)} café/naïve ünï.txt:2 secret-token (secret-token)`,
    `${short(dir, change)} my docs/a file.txt:1 secret-token (secret-token)`,
  ]);
});

test('names with a quote, a backslash or a newline: found, and printed on one line each', { skip: posix ? false : windowsSkip }, () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'x.txt': 'x\n' });
  commit(dir, 'odd names', { 'we"ird\\name.txt': 'secret-token\n', 'two\nlines.txt': 'secret-token\n', 'tab\there.txt': 'secret-token\n' });
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(lines(result.stdout).length, 3, result.stdout);
  assert.match(result.stdout, / two\\x0alines\.txt:1 /);
  assert.match(result.stdout, / tab\\x09here\.txt:1 /);
  assert.match(result.stdout, / we"ird\\name\.txt:1 /);
});

// ---- merges ----

function mergeFixture() {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'f.txt': 'a\nb\nc\nd\ne\n' });
  git(dir, 'switch', '-q', '-c', 'side');
  const sideLeak = commit(dir, 'side branch', { 'leak.txt': 'secret-token on the side\n' });
  git(dir, 'switch', '-q', 'main');
  commit(dir, 'main moves on', { 'f.txt': 'a\nb\nc\nd\nE\n' });
  return { dir, base, sideLeak };
}

test('a merge reports nothing for lines that came from the merged branch; the branch commit reports them once', () => {
  const { dir, base, sideLeak } = mergeFixture();
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(lines(result.stdout), [`${short(dir, sideLeak)} leak.txt:1 secret-token (secret-token on the side)`]);
  assert.match(result.stderr, /\(3 commits scanned\)/);
});

test('a merge reports what the merge itself adds, such as a conflict resolution', () => {
  const { dir, base } = mergeFixture();
  git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\nd\nE\nresolved with secret-token\n');
  git(dir, 'add', '--', 'f.txt');
  git(dir, 'commit', '-q', '-m', 'merge side, with an addition');
  const merge = git(dir, 'rev-parse', 'HEAD');
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(result.status, 1, result.stderr);
  const reported = lines(result.stdout);
  assert.equal(reported.length, 2, result.stdout);
  assert.ok(reported.includes(`${short(dir, merge)} f.txt:6 secret-token (resolved with secret-token)`), result.stdout);
  assert.ok(reported.some(line => line.includes(' leak.txt:1 ')));
});

test('a merge that adds nothing of its own is clean', () => {
  const { dir, base } = mergeFixture();
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const result = scan(dir, `${base}..HEAD`, 'no-such-marker\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 commits/);
});

// ---- allowed files and binary files ----

test('--allow-file skips exactly the named path, in every spelling of the option', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'x.txt': 'x\n' });
  const change = commit(dir, 'two files', { 'a.txt': 'secret-token\n', 'docs/a.txt': 'secret-token\n', 'b.txt': 'secret-token\n' });
  const only = result => lines(result.stdout).map(line => line.split(' ')[1]).sort();
  assert.deepEqual(only(scan(dir, `${base}..HEAD`, 'secret-token\n')), ['a.txt:1', 'b.txt:1', 'docs/a.txt:1']);
  assert.deepEqual(only(scan(dir, `${base}..HEAD`, 'secret-token\n', ['--allow-file', 'a.txt'])), ['b.txt:1', 'docs/a.txt:1']);
  assert.deepEqual(only(scan(dir, `${base}..HEAD`, 'secret-token\n', ['--allow-file', 'docs/a.txt', '--allow-file', 'b.txt'])), ['a.txt:1']);
  assert.deepEqual(only(scan(dir, `${base}..HEAD`, 'secret-token\n', ['--allow-file=./a.txt', '--allow-file=docs\\a.txt'])), ['b.txt:1']);
  const several = scan(dir, `${base}..HEAD`, 'secret-token\n', ['--allow-file', 'a.txt', 'b.txt', 'docs/a.txt']);
  assert.equal(several.status, 0, several.stderr);
  assert.match(several.stdout, /3 matching lines in allowed files skipped/);
  assert.ok(short(dir, change));
});

test('binary files are skipped with a note, and a text hit beside them still counts', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'x.txt': 'x\n' });
  const binary = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from('secret-token'), Buffer.from([0, 255, 254])]);
  const first = commit(dir, 'binary', { 'my image.bin': binary });
  const quiet = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stderr, new RegExp(`note: skipped binary file "my image\\.bin" in ${short(dir, first)}`));
  assert.match(quiet.stdout, /clean/);
  const second = commit(dir, 'text and binary', { 'my image.bin': Buffer.concat([binary, Buffer.from([9])]), 't.txt': 'secret-token\n' });
  const loud = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(loud.status, 1);
  assert.deepEqual(lines(loud.stdout), [`${short(dir, second)} t.txt:1 secret-token (secret-token)`]);
  assert.equal((loud.stderr.match(/skipped binary file/g) || []).length, 2);
  const allowed = scan(dir, `${base}..HEAD`, 'secret-token\n', ['--allow-file', 'my image.bin']);
  assert.doesNotMatch(allowed.stderr, /skipped binary file/);
});

// ---- ranges and usage that must not read as clean ----

test('a range Git cannot read exits 2 and never says clean', () => {
  const dir = makeRepo();
  commit(dir, 'base', { 'a.txt': 'secret-token\n' });
  for (const range of ['no-such-ref..HEAD', 'HEAD..no-such-ref', 'abcdef0123456789abcdef0123456789abcdef01..HEAD', 'not a ref at all ^^^']) {
    const result = scan(dir, range, 'secret-token\n');
    assert.equal(result.status, 2, range);
    assert.equal(result.stdout, '', range);
    assert.match(result.stderr, /added-lines-scan: cannot scan/, range);
  }
});

test('a directory that is not a repository exits 2', () => {
  const plain = unique('plain');
  mkdirSync(plain);
  const result = scan(plain, 'HEAD', 'secret-token\n');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('an empty repository has no commit to read: exit 2, not clean', () => {
  const dir = makeRepo();
  const result = scan(dir, 'HEAD', 'secret-token\n');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('a range that would pass an option to git is refused', () => {
  const dir = makeRepo();
  commit(dir, 'base', { 'a.txt': 'x\n' });
  for (const range of ['--all', 'HEAD --output=out.txt', '-n1']) {
    const result = scan(dir, range, 'x\n');
    assert.equal(result.status, 2, range);
    assert.match(result.stderr, /may not start with "-"/);
  }
});

test('usage errors exit 2 with the usage text', () => {
  const dir = makeRepo();
  const markers = markersFile('x\n');
  for (const args of [[], ['--range', 'HEAD'], ['--markers', markers], ['--range', 'HEAD', '--markers', markers, '--bogus'],
    ['--range', 'HEAD', '--range', 'HEAD', '--markers', markers], ['--range', '--markers', markers], ['--range', 'HEAD', '--markers', markers, '--allow-file']]) {
    const result = run(['--repo', dir, ...args]);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage: added-lines-scan/, args.join(' '));
    assert.equal(result.stdout, '');
  }
  assert.equal(run(['--help']).status, 0);
  assert.match(run(['--help']).stdout, /Usage: added-lines-scan/);
});

test('an unreadable, empty or invalid markers file exits 2 and says which line', () => {
  const dir = makeRepo();
  commit(dir, 'base', { 'a.txt': 'x\n' });
  const missing = run(['--repo', dir, '--range', 'HEAD', '--markers', join(sandbox, 'no-such-file.txt')]);
  assert.equal(missing.status, 2);
  const empty = scan(dir, 'HEAD', '# only a comment\n\n   \n');
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /no markers/);
  const bad = scan(dir, 'HEAD', 'fine\n\n(unclosed\n');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /markers-\d+\.txt:3: invalid regular expression/);
  assert.equal(bad.stdout, '');
});

test('the repository comes from --repo or the current directory, never from inherited Git variables', () => {
  const dir = makeRepo();
  const elsewhere = makeRepo();
  commit(elsewhere, 'other', { 'o.txt': 'nothing\n' });
  const base = commit(dir, 'base', { 'a.txt': 'x\n' });
  commit(dir, 'leak', { 'a.txt': 'x\nsecret-token\n' });
  const markers = markersFile('secret-token\n');
  const fromCwd = run(['--range', `${base}..HEAD`, '--markers', markers], { cwd: dir });
  assert.equal(fromCwd.status, 1, fromCwd.stderr);
  const hostile = run(['--repo', dir, '--range', `${base}..HEAD`, '--markers', markers],
    { env: { ...ENV, GIT_DIR: join(elsewhere, '.git'), GIT_WORK_TREE: elsewhere, GIT_INDEX_FILE: join(elsewhere, '.git', 'index') } });
  assert.equal(hostile.status, 1, hostile.stderr);
});

// ---- the markers file ----

test('parseMarkers: comments, blank lines, trimming, the i flag, escapes, BOM and CRLF', () => {
  const text = '﻿# a comment\r\n\r\n  plain-word  \r\n/Mixed/i\r\n/slashed/\r\n\\#hash\r\n   # an indented comment\r\nfoo|bar\r\n';
  const markers = parseMarkers(text);
  assert.deepEqual(markers.map(marker => marker.source), ['plain-word', '/Mixed/i', '/slashed/', '\\#hash', 'foo|bar']);
  assert.ok(markers[0].regex.test('a plain-word here'));
  assert.ok(!markers[0].regex.test('PLAIN-WORD'), 'a plain line is case-sensitive');
  assert.ok(markers[1].regex.test('mIxEd') && markers[1].regex.test('MIXED'));
  assert.ok(markers[2].regex.test('slashed') && !markers[2].regex.test('SLASHED'));
  assert.ok(markers[3].regex.test('x #hash'));
  assert.ok(markers[4].regex.test('bar') && markers[4].regex.test('foo'));
  assert.deepEqual(parseMarkers('# nothing\n\n'), []);
});

test('parseMarkers: Cyrillic text matches with the i flag', () => {
  const [marker] = parseMarkers('/секрет/i\n');
  assert.ok(marker.regex.test('это СЕКРЕТ'));
});

test('parseMarkers: a path-like line that reads as /pattern/flags is an error with the way out', () => {
  assert.throws(() => parseMarkers('/home/alice\n', 'm.txt'), /m\.txt:1: .*only i is supported.*escape the first slash/);
  assert.throws(() => parseMarkers('/x/g\n'), /flags "g"/);
  const [escaped] = parseMarkers('\\/home\\/alice\n');
  assert.ok(escaped.regex.test('see /home/alice/x'));
});

test('parseMarkers: an invalid expression names the file and the line', () => {
  assert.throws(() => parseMarkers('ok\n[unclosed\n', 'list.txt'), /list\.txt:2: invalid regular expression/);
});

// ---- the patch reader ----

async function* from(list) { yield* list; }
const collect = async list => { const out = []; for await (const event of parsePatch(from(list))) out.push(event); return out; };

test('readQuoted: escapes, octal bytes decoded as UTF-8, and errors', () => {
  assert.equal(readQuoted('"a\\tb\\"c\\\\d\\n"').value, 'a\tb"c\\d\n');
  assert.equal(readQuoted('"caf\\303\\251"').value, 'café');
  assert.equal(readQuoted('"ünï"').value, 'ünï');
  assert.deepEqual(readQuoted('"a" "b"'), { value: 'a', end: 3 });
  assert.throws(() => readQuoted('"open'), /unterminated/);
  assert.throws(() => readQuoted('"bad \\q"'), /bad escape/);
  assert.throws(() => readQuoted('plain'), /not a quoted name/);
});

test('parsePatch: counts hunk lines, so a deletion-only hunk and context lines keep the numbering', async () => {
  const events = await collect([
    '@@commit abc', '', 'diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f',
    '@@ -3,2 +3,0 @@ heading', '-x', '-y', '@@ -9 +8,2 @@', '-old', '+new', '\\ No newline at end of file', '+newer',
  ]);
  assert.deepEqual(events, [
    { kind: 'commit', sha: 'abc' },
    { kind: 'added', path: 'f', line: 8, text: 'new' },
    { kind: 'added', path: 'f', line: 9, text: 'newer' },
  ]);
});

test('parsePatch: quoted names, the trailing tab, and binary files by header', async () => {
  const events = await collect([
    'diff --git "a/tab\\there.txt" "b/tab\\there.txt"', '--- "a/tab\\there.txt"', '+++ "b/tab\\there.txt"', '@@ -0,0 +1 @@', '+one',
    'diff --git a/sp ace.txt b/sp ace.txt', '--- /dev/null', '+++ b/sp ace.txt\t', '@@ -0,0 +1 @@', '+two',
    'diff --git a/bin dat.bin b/bin dat.bin', 'Binary files a/bin dat.bin and b/bin dat.bin differ',
    'diff --git a/old bin.bin b/new bin.bin', 'similarity index 90%', 'rename from old bin.bin', 'rename to new bin.bin', 'Binary files a/old bin.bin and b/new bin.bin differ',
  ]);
  assert.deepEqual(events.map(event => `${event.kind}:${event.path}`),
    ['added:tab\there.txt', 'added:sp ace.txt', 'binary:bin dat.bin', 'binary:new bin.bin']);
});

test('parsePatch: names with a quote, a backslash and a newline, as Git quotes them (any operating system)', async () => {
  const events = await collect([
    'diff --git "a/we\\"ird\\\\name.txt" "b/we\\"ird\\\\name.txt"', '--- "a/we\\"ird\\\\name.txt"', '+++ "b/we\\"ird\\\\name.txt"', '@@ -0,0 +1 @@', '+one',
    'diff --git "a/two\\nlines.txt" "b/two\\nlines.txt"', '--- /dev/null', '+++ "b/two\\nlines.txt"', '@@ -0,0 +1 @@', '+two',
    'diff --git "a/odd\\tbin.bin" "b/odd\\tbin.bin"', 'Binary files "a/odd\\tbin.bin" and "b/odd\\tbin.bin" differ',
    'diff --git "a/caf\\303\\251 old.bin" "b/caf\\303\\251 new.bin"', 'rename from "caf\\303\\251 old.bin"', 'rename to "caf\\303\\251 new.bin"',
    'Binary files "a/caf\\303\\251 old.bin" and "b/caf\\303\\251 new.bin" differ',
  ]);
  assert.deepEqual(events.map(event => `${event.kind}:${event.path}`),
    ['added:we"ird\\name.txt', 'added:two\nlines.txt', 'binary:odd\tbin.bin', 'binary:café new.bin']);
});

test('parsePatch fails on a patch it cannot read instead of passing it', async () => {
  await assert.rejects(collect(['diff --git a/f b/f', '+++ b/f', '@@ -1 +1 @@', '-a']), /ended inside a hunk/);
  await assert.rejects(collect(['diff --git a/f b/f', '+++ b/f', '@@ -1 +1 @@', '-a', '+b', '+c']), /hunk/);
  await assert.rejects(collect(['diff --git a/f b/f', '+++ b/f', '@@ -1 +1 @@', '-a', 'oops']), /unexpected line inside a hunk/);
  await assert.rejects(collect(['diff --git a/f b/f', '+++ b/f', '@@ nonsense @@']), /cannot read a hunk header/);
  await assert.rejects(collect(['diff --git a/f b/f', '+++ f']), /unexpected file name/);
  await assert.rejects(collect(['diff --git a/f b/f', '--- a/f', '+++ /dev/null', '@@ -0,0 +1 @@', '+x']), /no new file name/);
});

test('parsePatch: deleting a whole file (+++ /dev/null) is a hunk with nothing added', async () => {
  const events = await collect(['diff --git a/f b/f', 'deleted file mode 100644', '--- a/f', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b']);
  assert.deepEqual(events, []);
});

test('a commit that deletes a whole file adds nothing, and a leak it removes is still in the commit that added it', () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'keep.txt': 'x\n' });
  const leak = commit(dir, 'add', { 'gone.txt': 'secret-token\n' });
  commit(dir, 'delete the file', { 'gone.txt': null });
  const result = scan(dir, `${base}..HEAD`, 'secret-token\n');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(lines(result.stdout), [`${short(dir, leak)} gone.txt:1 secret-token (secret-token)`]);
  assert.equal(scan(dir, `${leak}..HEAD`, 'secret-token\n').status, 0);
});

test('formatHit trims, cuts at 120 characters and shows control characters instead of passing them on', () => {
  const hit = { short: 'abc1234', path: 'a b.txt', line: 7, marker: 'key\tword', text: `   ${'x'.repeat(130)}   ` };
  assert.equal(formatHit(hit), `abc1234 a b.txt:7 key\\x09word (${'x'.repeat(120)}…)`);
  assert.equal(formatHit({ ...hit, text: 'a\tb\x1b[31m' }), 'abc1234 a b.txt:7 key\\x09word (a b\\x1b[31m)');
});

test('scanRange resolves to the structure the command line prints', async () => {
  const dir = makeRepo();
  const base = commit(dir, 'base', { 'a.txt': 'x\n' });
  const change = commit(dir, 'leak', { 'a.txt': 'x\nsecret-token\n' });
  const result = await scanRange({ repo: dir, range: `${base}..HEAD`, markers: parseMarkers('secret-token\n') });
  assert.equal(result.commits, 1);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].sha, change);
  assert.equal(result.hits[0].path, 'a.txt');
  assert.equal(result.hits[0].line, 2);
  await assert.rejects(scanRange({ repo: dir, range: 'HEAD', markers: [] }), /no markers/);
  await assert.rejects(scanRange({ repo: dir, range: 'nope..HEAD', markers: parseMarkers('x\n') }), /git log failed/);
});

// ---- the pre-push hook from the README, run by a real git push ----

function hookFromReadme() {
  const block = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]).find(text => text.includes('pre-push'));
  assert.ok(block, 'no pre-push hook example in the README');
  return block;
}

function pushFixture() {
  const remote = unique('remote.git');
  git(sandbox, 'init', '-q', '--bare', '-b', 'main', remote);
  const dir = makeRepo();
  git(dir, 'remote', 'add', 'origin', remote);
  const slashed = path => path.replace(/\\/g, '/');
  const markers = markersFile('secret-token\n');
  const script = hookFromReadme()
    .replaceAll('/path/to/agent-dev-tools/added-lines-scan/bin/added-lines-scan.mjs', slashed(cli))
    .replaceAll('/path/to/markers.txt', slashed(markers));
  assert.ok(script.includes(slashed(cli)) && script.includes(slashed(markers)), 'the README hook no longer holds the placeholder paths');
  const hook = join(dir, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, script);
  chmodSync(hook, 0o755);
  const push = (...args) => {
    const result = spawnSync('git', ['-C', dir, 'push', ...args], { env: ENV, encoding: 'utf8', timeout: 60000 });
    return { ...result, output: `${result.stdout}${result.stderr}` }; // where a hook's report lands is Git's business
  };
  return { dir, remote, push };
}

test('the README pre-push hook, run by git push: clean pushes pass, a leak in any pushed commit blocks', () => {
  const { dir, remote, push } = pushFixture();
  commit(dir, 'first', { 'a.txt': 'fine\n' });
  const first = push('origin', 'main');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.output, /clean: 1 commit/);

  commit(dir, 'second', { 'a.txt': 'fine\nmore\n' });
  assert.equal(push('origin', 'main').status, 0);

  // a leak added and removed again before the push: the final tree is clean, the history is not
  const leak = commit(dir, 'leak', { 'b.txt': 'secret-token\n' });
  commit(dir, 'remove it', { 'b.txt': null });
  const blocked = push('origin', 'main');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.output, new RegExp(`${short(dir, leak)} b\\.txt:1 secret-token`));
  assert.equal(git(remote, 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD~2'), 'the remote must not have moved');

  // a new branch carries only what the remote does not have yet
  git(dir, 'switch', '-q', '-c', 'clean-branch', 'HEAD~2');
  commit(dir, 'branch work', { 'c.txt': 'fine\n' });
  const created = push('origin', 'clean-branch');
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.output, /clean: 1 commit/);

  git(dir, 'switch', '-q', '-c', 'leaky-branch', 'HEAD~1');
  commit(dir, 'leak on a new branch', { 'd.txt': 'secret-token\n' });
  assert.notEqual(push('origin', 'leaky-branch').status, 0);

  // deleting a remote branch publishes no commit
  assert.equal(push('origin', ':clean-branch').status, 0);
});
