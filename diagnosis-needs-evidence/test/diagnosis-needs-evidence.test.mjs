import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLines, bareCauses, compileJournal, decide, journalMatcher, scanShell } from '../lib/index.mjs';

const cli = fileURLToPath(new URL('../bin/diagnosis-needs-evidence.mjs', import.meta.url));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const LOG = '/work/project/notes/PHASE-3-RUN-LOG.md';

const edit = (text, file = LOG) => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: text } });
const bash = command => ({ tool_name: 'Bash', tool_input: { command } });
const write = (content, file_path) => ({ tool_name: 'Write', tool_input: { file_path, content } });

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'diagnosis-needs-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function cases(list) {
  for (const [name, input, want, options] of list) {
    test(name, () => {
      const result = decide(input, options);
      assert.equal(result.code, want, result.stderr);
      if (want === 2) assert.match(result.stderr, /refused/);
      else assert.equal(result.stderr, '');
    });
  }
}

// The cases below are the full set the hook was first built against: a cause written into a
// journal with no reference and no guess mark is refused, the sound entries pass.
cases([
  ['a cause with no reference and no mark is denied', edit('- 12:00 - the job stood for an hour. Cause: the retry loop never backs off.'), 2],
  ['the Russian word is denied the same way', edit('- 12:00 - задача стояла час, причина - нехватка памяти.'), 2],
  ['a diagnosis with no reference is denied', edit('- 12:00 - diagnosis: the cache key was reused across requests.'), 2],
  ['a cause with file:line in the same sentence passes', edit('- 12:00 - cause: the scheduler joins every reason (`src/queue/worker.mjs:120`).'), 0],
  ['a cause with the reference in the next sentence passes', edit('- 12:00 - the cause is the retry loop. Read in `src/loop.mjs` ~210.'), 0],
  ['a cause marked as a guess passes (Russian)', edit('- 12:00 - причина, вероятно, в нагрузке: догадка, код не читал.'), 0],
  ['"not read" marks it too', edit('- 12:00 - cause unknown, not read yet.'), 0],
  ['a reference three sentences away does not cover it', edit('- 12:00 - cause: load. The service was restarted. The job returned. See `x.mjs:5`.'), 2],
  ['an entry that names no cause passes', edit('- 12:00 - build 8 handed in, review started.'), 0],
  ['"because" alone is not a diagnosis word', edit('- 12:00 - returned because the reviewer said so.'), 0],
  ['another file is not a journal', edit('Cause: unknown.', '/work/project/docs/ROADMAP.md'), 0],
  ['a shell append of a bare cause into the journal is denied', bash(`echo "- 12:00 - причина: память" >> ${LOG}`), 2],
  ['a shell command that only reads the journal passes', bash(`grep -n "cause" ${LOG}`), 0],
  ['an arrow function is not a redirection into the journal', bash(`node -e "const a=[1].map(x=>x); console.log('cause: x', 'PHASE-3-RUN-LOG.md')"`), 0],
  ['a real append still is, beside an arrow function', bash(`node -e "[1].map(x=>x)"; echo "- cause: x" >> ${LOG}`), 2],
]);

test('a Write is judged by the lines it adds, not by old ones', t => {
  const file = join(workspace(t), 'RUN-LOG.md');
  const old = '- 11:00 - cause: the cache. (guessed from the symptom)\n- 11:00 - cause: the proxy.\n';
  writeFileSync(file, old);
  assert.equal(decide(write(`${old}- 12:00 - build 8 handed in.\n`, file)).code, 0);
  assert.equal(decide(write(`${old}- 12:00 - cause: x (\`a.mjs:1\`).\n`, file)).code, 0);
  const denied = decide(write(`${old}- 12:00 - cause: the network.\n`, file));
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /the network/);
  assert.doesNotMatch(denied.stderr, /the proxy/);
});

test('a Write to a file that does not exist yet is judged in full', t => {
  const file = join(workspace(t), 'RUN-LOG.md');
  assert.equal(decide(write('- 12:00 - cause: the network.\n', file)).code, 2);
  assert.equal(decide(write('old line\n- 12:00 - cause: x (`a.mjs:1`).\n', file)).code, 0);
});

test('a Write counts lines as a multiset: a second copy of an old bare line is new', t => {
  const file = join(workspace(t), 'RUN-LOG.md');
  writeFileSync(file, '- cause: the proxy.\n');
  assert.equal(decide(write('- cause: the proxy.\n', file)).code, 0);
  assert.equal(decide(write('- cause: the proxy.\n- cause: the proxy.\n', file)).code, 2);
});

test('a Write over a CRLF journal sees the same lines as old', t => {
  const file = join(workspace(t), 'RUN-LOG.md');
  writeFileSync(file, '- cause: the proxy.\r\n- plain line\r\n');
  assert.equal(decide(write('- cause: the proxy.\n- plain line\n- another plain line\n', file)).code, 0);
});

test('a Write with a relative path reads the current file from the hook cwd', t => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'JOURNAL.md'), '- cause: the proxy.\n');
  const input = { cwd: directory, ...write('- cause: the proxy.\n- done\n', 'JOURNAL.md') };
  assert.equal(decide(input).code, 0);
});

test('addedLines returns only new lines', () => {
  assert.equal(addedLines('a\nb\n', 'a\nc\nb\nd\n'), 'c\nd');
  assert.equal(addedLines('', 'x'), 'x');
});

test('an Edit judges new_string only, whatever old_string held', () => {
  const input = { tool_name: 'Edit', tool_input: { file_path: LOG, old_string: '- cause: the proxy.', new_string: '- 12:00 - handed in.' } };
  assert.equal(decide(input).code, 0);
});

test('a MultiEdit judges every new_string', () => {
  const edits = [{ old_string: 'a', new_string: 'fine' }, { old_string: 'b', new_string: 'cause: the network.' }];
  assert.equal(decide({ tool_name: 'MultiEdit', tool_input: { file_path: LOG, edits } }).code, 2);
});

test('tools other than Edit, Write, MultiEdit and Bash pass', () => {
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: LOG } }).code, 0);
  assert.equal(decide({ tool_name: 'Edit', tool_input: {} }).code, 0);
  assert.equal(decide(undefined).code, 0);
});

// ---- the words ----

test('Latin cause words, any case and ending', () => {
  for (const text of ['Cause: the cache.', 'It causes a stall.', 'The stall was caused by the proxy.', 'The root cause is the cache.',
    'Root-cause: the cache.', 'Diagnosis: the cache.', 'Diagnosed as a stale cache.', 'The diagnoses were wrong.']) {
    assert.equal(bareCauses(text).length, 1, text);
  }
});

test('Russian cause words, any case and ending', () => {
  for (const text of ['Причина: кэш.', 'причину искали час.', 'Причиной был прокси.', 'о причинах позже', 'Диагноз: кэш.',
    'Поставили диагноз кэш.', 'Диагнозом стал прокси.']) {
    assert.equal(bareCauses(text).length, 1, text);
  }
});

test('words that only contain a cause word do not count', () => {
  for (const text of ['returned because of the reviewer', 'a causal link', 'causeway closed', 'causing delays', 'a diagnostic run', 'причинять вред',
    'camelCaseId', 'precause']) {
    assert.deepEqual(bareCauses(text), [], text);
  }
});

test('every reference form counts as evidence', () => {
  for (const reference of ['src/a.ts:12', 'src/a.ts: 12', 'src/a.ts ~40', 'a.go line 7', 'a.rs, line 9', 'a.mjs lines 3-9', 'a.mjs строка 5',
    'a.py:1', '`lib/b.js`:5', 'C:\\work\\b.ps1:5', 'docs/уроки.md:3', 'src/a.ts#L42', 'README.MD:1']) {
    assert.deepEqual(bareCauses(`cause: the cache (${reference}).`), [], reference);
  }
});

test('text that only looks like a reference is not evidence', () => {
  for (const text of ['cause: timeout talking to api.example.com:443', 'cause: version 1.2:3', 'cause: at 12:30', 'cause: a.mjs without a line',
    'cause: see line 5']) {
    assert.equal(bareCauses(text).length, 1, text);
  }
});

test('every guess mark counts as evidence', () => {
  for (const mark of ['guess', 'Guessed', 'a hypothesis', 'two hypotheses', 'not read', 'not yet checked', 'not checked',
    'догадка', 'это догадкой', 'гипотеза', 'гипотезой', 'не читал', 'не прочитал', 'не проверял', 'не проверено']) {
    assert.deepEqual(bareCauses(`cause: the cache (${mark}).`), [], mark);
    assert.deepEqual(bareCauses(`причина: кэш, ${mark}.`), [], mark);
  }
});

test('the evidence may sit in the sentence after, never two after', () => {
  assert.deepEqual(bareCauses('Cause: the cache. Read in lib/a.mjs:7.'), []);
  assert.equal(bareCauses('Cause: the cache. It stalled. Read in lib/a.mjs:7.').length, 1);
  assert.deepEqual(bareCauses('Cause: the cache.\nGuess, code not read.'), []);
});

test('the quoted sentence is cut at 160 characters and extra causes are counted', () => {
  const long = `Cause: ${'x'.repeat(300)}`;
  const [quoted] = bareCauses(long);
  assert.equal(quoted.length, 161);
  const result = decide(edit(`Cause: one.\nCause: two.\nCause: three.`));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /"Cause: one\."/);
  assert.match(result.stderr, /and 2 more/);
  assert.match(result.stderr, /path\/file\.ext:line/);
});

// ---- shell writes ----

const SHELL = [
  ['a bare cause appended with a heredoc is denied', bash(`cat >> ${LOG} <<'EOF'\n- 12:00 - cause: the network.\nEOF`), 2],
  ['the same heredoc with a reference passes', bash(`cat >> ${LOG} <<'EOF'\n- 12:00 - cause: the network (lib/net.mjs:9).\nEOF`), 0],
  ['a heredoc whose redirection comes after the delimiter is denied', bash(`cat <<EOF > ${LOG}\ncause: the network.\nEOF`), 2],
  ['a truncating > is a write', bash(`echo "cause: the network." > ${LOG}`), 2],
  ['a write with the redirection first is denied', bash(`> ${LOG} echo "cause: the network."`), 2],
  ['a redirection without a space is denied', bash(`echo "cause: the network." >>${LOG}`), 2],
  ['tee -a is a write', bash(`echo "cause: the network." | tee -a ${LOG}`), 2],
  ['tee with a guess mark passes', bash(`echo "cause: the network, a guess." | tee -a ${LOG}`), 0],
  ['sed -i is a write', bash(`sed -i 's/pending/cause: the network./' ${LOG}`), 2],
  ['sed -i with a suffix is a write', bash(`sed -i.bak 's/pending/cause: the network./' ${LOG}`), 2],
  ['sed without -i only reads', bash(`sed -n '/cause: the network/p' ${LOG}`), 0],
  ['perl -pi is a write', bash(`perl -pi -e 's/pending/cause: the network./' ${LOG}`), 2],
  ['perl -Mstrict without -i only reads', bash(`perl -Mstrict -ne 'print if /cause: x/' ${LOG}`), 0],
  ['a command that names the journal but writes elsewhere passes', bash(`echo "cause: the network." > /tmp/other.txt; cat ${LOG}`), 0],
  ['> /dev/null is not a write to the journal', bash(`grep -c "cause: x" ${LOG} > /dev/null`), 0],
  ['2>&1 and >&2 are not writes to the journal', bash(`echo "cause: x" 2>&1 >&2; cat ${LOG}`), 0],
  ['an error stream redirected to the journal is not text the command adds', bash(`make 2>> ${LOG}; echo "cause: x"`), 0],
  ['>= is a comparison, not a redirection', bash(`node -e "if (a>=b) console.log('cause: x', 'PHASE-3-RUN-LOG.md')"`), 0],
  ['an unquoted => is not a redirection either', bash(`echo cause: x=>y; cat ${LOG}`), 0],
  ['a > inside a string is not a redirection', bash(`echo "a > b, cause: x"; cat ${LOG}`), 0],
  ['a redirection inside a comment is not a write', bash(`cat ${LOG} # cause: x >> ${LOG}`), 0],
  ['a write behind && and ; is found', bash(`cd /work && echo ok; echo "cause: x" >> ${LOG}`), 2],
  ['the journal path may be quoted and hold spaces', bash(`echo "cause: x" >> "/work/my notes/RUN-LOG.md"`), 2],
  ['the journal path may be a Windows path', bash(`echo "cause: x" >> C:\\work\\RUN-LOG.md`), 2],
  ['a target built from a variable counts when the journal is named elsewhere', bash(`LOG=${LOG}; echo "cause: x" >> "$LOG"`), 2],
  ['a target built from a variable without any journal in sight passes', bash(`echo "cause: x" >> "$OUT"`), 0],
  ['a script given to bash -c is read', bash(`bash -c 'echo "cause: x" >> ${LOG}'`), 2],
  ['a script given to eval is read', bash(`eval "echo cause: x >> ${LOG}"`), 2],
  ['a wrapper and an assignment before the command are skipped', bash(`FOO=1 sudo -n tee -a ${LOG} <<< "cause: x"`), 2],
  ['a non-journal file written with a redirection passes', bash(`echo "cause: x" >> /work/notes/todo.md`), 0],
  ['a cause inside a commit message beside a plain read passes', bash(`git commit -m "fix: root cause of the stall"; cat ${LOG}`), 0],
];
cases(SHELL);

test('scanShell reports targets, words and dynamic targets', () => {
  const found = scanShell(`echo hi > out.txt 2>/dev/null; tee -a "b c.md" < in.txt >> "$DIR/x.md"`);
  const targets = found.targets.map(t => `${t.text}|${t.dynamic}`).sort();
  assert.deepEqual(targets, ['$DIR/x.md|true', 'b c.md|false', 'out.txt|false']);
  assert.ok(found.words.includes('in.txt'));
});

test('scanShell skips here-document bodies, including <<- with tabs', () => {
  const found = scanShell(`cat <<-EOF > a.md\n\techo x > in-body.md\n\tEOF\necho y > after.md`);
  assert.deepEqual(found.targets.map(t => t.text), ['a.md', 'after.md']);
});

// ---- which files are journals ----

test('the default pattern: RUN-LOG or JOURNAL in the name, .md, any directory and letter case', () => {
  const isJournal = journalMatcher();
  for (const path of ['RUN-LOG.md', 'a/b/PHASE-9-RUN-LOG.md', 'C:\\notes\\run-log.md', 'journal.md', 'x/Daily-JOURNAL-2026.md', 'RUN-LOG-old.md']) {
    assert.ok(isJournal(path), path);
  }
  for (const path of ['notes.md', 'RUN-LOG.txt', 'RUN-LOG', 'a/RUN-LOG/readme.md', 'JOURNAL.mdx']) assert.ok(!isJournal(path), path);
});

test('a glob: * and ? stop at a slash, ** crosses it, {a,b} lists alternatives, the match ends the path', () => {
  const docs = journalMatcher(['docs/journal/*.md']);
  assert.ok(docs('/repo/docs/journal/2026.md'));
  assert.ok(docs('docs\\journal\\2026.md'));
  assert.ok(!docs('/repo/xdocs/journal/2026.md'));
  assert.ok(!docs('/repo/docs/journal/sub/2026.md'));
  const deep = journalMatcher(['notes/**/log.md']);
  assert.ok(deep('notes/log.md'));
  assert.ok(deep('/r/notes/a/b/log.md'));
  const braces = journalMatcher(['{work,agent}-log-?.txt']);
  assert.ok(braces('work-log-1.txt') && braces('x/agent-log-b.txt'));
  assert.ok(!braces('other-log-1.txt'));
  const absolute = journalMatcher(['/srv/agent/log.md']);
  assert.ok(absolute('/srv/agent/log.md'));
  assert.ok(!absolute('/home/srv/agent/log.md'));
});

test('a /regex/ is tested against the whole path with forward slashes, case-sensitive unless /i', () => {
  const sensitive = journalMatcher(['/notes-\\d+\\.txt$/']);
  assert.ok(sensitive('x/notes-12.txt'));
  assert.ok(!sensitive('x/NOTES-12.TXT'));
  assert.ok(journalMatcher(['/notes-\\d+\\.txt$/i'])('x/NOTES-12.TXT'));
  assert.ok(journalMatcher(['/^C:\\/work\\//'])('C:\\work\\a.md'));
});

test('a bad pattern is an error, not a silent no-match', () => {
  assert.throws(() => compileJournal('/(/'), /invalid journal regular expression/);
  assert.throws(() => compileJournal('{a,b'), /unbalanced/);
  assert.throws(() => compileJournal('  '), /empty/);
});

test('a custom pattern replaces the default and applies to Edit, Write and Bash', t => {
  const options = { journals: ['docs/journal/*.md'] };
  const file = '/repo/docs/journal/2026.md';
  assert.equal(decide(edit('cause: x.', file), options).code, 2);
  assert.equal(decide(edit('cause: x.', LOG), options).code, 0);
  assert.equal(decide(bash(`echo "cause: x" >> ${file}`), options).code, 2);
  assert.equal(decide(bash(`echo "cause: x" >> ${LOG}`), options).code, 0);
  const directory = workspace(t);
  mkdirSync(join(directory, 'docs', 'journal'), { recursive: true });
  assert.equal(decide(write('cause: x.\n', join(directory, 'docs', 'journal', 'a.md')), options).code, 2);
  assert.equal(decide(edit('cause: x.', '/repo/docs/notes.md')).code, 0);
});

test('several custom patterns: any of them makes a journal', () => {
  const options = { journals: ['/\\.journal$/', 'log/*.md'] };
  assert.equal(decide(edit('cause: x.', '/r/team.journal'), options).code, 2);
  assert.equal(decide(edit('cause: x.', '/r/log/a.md'), options).code, 2);
  assert.equal(decide(edit('cause: x.', '/r/other.md'), options).code, 0);
});

// ---- the check failing on its own ----

test('an unreadable current file lets the call through with a note', t => {
  const directory = workspace(t);
  const folder = join(directory, 'RUN-LOG.md');
  mkdirSync(folder);
  const result = decide(write('cause: x.\n', folder));
  assert.equal(result.code, 0);
  assert.match(result.stderr, /could not check/);
  assert.match(result.stderr, /let through/);
});

test('a bad journal option inside decide lets the call through with a note', () => {
  const result = decide(edit('cause: x.'), { journals: ['/(/'] });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /could not check/);
});

test('a malformed tool_input lets the call through with a note', () => {
  const result = decide({ tool_name: 'Write', tool_input: null });
  assert.equal(result.code, 0);
});

// ---- the command line ----

function hook(input, { args = [], env = {} } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', timeout: 15000, env: { ...process.env, DIAGNOSIS_NEEDS_EVIDENCE_JOURNAL: '', ...env },
  });
  assert.ifError(result.error);
  return result;
}

test('cli: a bare cause in a journal exits 2 with the sentence on stderr and nothing on stdout', () => {
  const result = hook(edit('Cause: the cache.'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /"Cause: the cache\."/);
  assert.equal(result.stdout, '');
});

test('cli: a sound entry exits 0 silently', () => {
  const result = hook(edit('Cause: the cache (lib/a.mjs:4).'));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('cli: a Bash write is denied', () => {
  assert.equal(hook(bash(`echo "cause: x" >> ${LOG}`)).status, 2);
});

test('cli: input that is not JSON is let through with a note', () => {
  const result = hook('this is not json');
  assert.equal(result.status, 0);
  assert.match(result.stderr, /let through/);
});

test('cli: --journal replaces the default, repeated and in the = form', () => {
  const docs = edit('Cause: x.', '/r/docs/journal/a.md');
  assert.equal(hook(docs).status, 0);
  assert.equal(hook(docs, { args: ['--journal', 'docs/journal/*.md'] }).status, 2);
  assert.equal(hook(edit('Cause: x.', '/r/team.journal'), { args: ['--journal', 'docs/journal/*.md', '--journal=/\\.journal$/'] }).status, 2);
  assert.equal(hook(edit('Cause: x.'), { args: ['--journal', 'docs/journal/*.md'] }).status, 0);
});

test('cli: the environment variable sets the journals, one pattern per line, and a flag wins over it', () => {
  const env = { DIAGNOSIS_NEEDS_EVIDENCE_JOURNAL: 'docs/journal/*.md\n/\\.journal$/' };
  assert.equal(hook(edit('Cause: x.', '/r/docs/journal/a.md'), { env }).status, 2);
  assert.equal(hook(edit('Cause: x.', '/r/team.journal'), { env }).status, 2);
  assert.equal(hook(edit('Cause: x.'), { env }).status, 0);
  assert.equal(hook(edit('Cause: x.', '/r/team.journal'), { env, args: ['--journal', 'other/*.md'] }).status, 0);
});

test('cli: a bad option or pattern exits 1 (let through, shown) and never 2', () => {
  for (const args of [['--bogus'], ['--journal'], ['--journal', '/(/'], ['--journal', '{a']]) {
    const result = hook(edit('Cause: x.'), { args });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /diagnosis-needs-evidence:/);
    assert.match(result.stderr, /Usage:/);
  }
  const env = hook(edit('Cause: x.'), { env: { DIAGNOSIS_NEEDS_EVIDENCE_JOURNAL: '/(/' } });
  assert.equal(env.status, 1);
});

test('cli: --help prints usage and exits 0', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: diagnosis-needs-evidence/);
});

test('README: the settings snippet is valid JSON with the Edit|Write|Bash matcher and a real script path', () => {
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
  const settings = blocks.find(block => block.hooks?.PreToolUse);
  assert.ok(settings, 'no settings snippet in the README');
  const [entry] = settings.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Edit|Write|Bash');
  assert.equal(entry.hooks[0].type, 'command');
  assert.match(entry.hooks[0].command, /diagnosis-needs-evidence\/bin\/diagnosis-needs-evidence\.mjs/);
});
