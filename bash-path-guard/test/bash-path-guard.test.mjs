import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCommand, hookDecision } from '../lib/guard.mjs';
import { lintText } from '../lib/lint.mjs';

const cli = fileURLToPath(new URL('../bin/bash-path-guard.mjs', import.meta.url));
function temporaryDirectory() {
  try { return mkdtempSync(join(tmpdir(), 'bash-path-guard-')); }
  catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(error.code)) throw error;
    return mkdtempSync(fileURLToPath(new URL('./.tmp-', import.meta.url)));
  }
}
// File descriptors work on Windows and on sandboxes without child-process pipe
// support. No shell quoting is involved in passing arguments to Node.
function runProcess(command, args, { input = '', timeout = 10000, env = process.env } = {}) {
  const directory = temporaryDirectory();
  const paths = ['stdin', 'stdout', 'stderr'].map(name => join(directory, name));
  writeFileSync(paths[0], input);
  const fds = paths.map((file, i) => openSync(file, i === 0 ? 'r' : 'w'));
  try {
    const result = spawnSync(command, args, { stdio: fds, timeout, env });
    return { ...result, stdout: readFileSync(paths[1], 'utf8'), stderr: readFileSync(paths[2], 'utf8') };
  } finally {
    fds.forEach(closeSync);
    paths.forEach(unlinkSync);
    rmdirSync(directory);
  }
}
const run = (args, input) => runProcess(process.execPath, [cli, ...args], { input });
const denied = command => assert.ok(inspectCommand(command).length, command);
const allowed = command => assert.deepEqual(inspectCommand(command), [], command);

const manglingCases = [
  { name: 'unquoted path', word: String.raw`C:\Users\me`, expected: 'C:Usersme' },
  { name: 'doubled unquoted slashes', word: String.raw`C:\\Users\\me`, expected: String.raw`C:\Users\me` },
  { name: 'doubled double-quoted slashes', word: String.raw`"C:\\Users\\me"`, expected: String.raw`C:\Users\me` },
  { name: 'ANSI-C quoting', word: String.raw`$'C:\\Users\\me'`, expected: String.raw`C:\Users\me` },
  { name: 'mixed quotes', word: String.raw`C:'\Users'\me`, expected: String.raw`C:\Usersme` },
  { name: 'line continuation', word: 'C:\\\nUsers\\me', expected: 'C:Usersme' },
];

for (const { name, word } of manglingCases) {
  test(`hook refuses ${name}`, () => denied(`printf '%s' ${word}`));
}

test('paths in safe words, comments and single quotes pass', () => {
  for (const command of [
    String.raw`printf '%s' 'C:\Users\me'`,
    String.raw`printf '%s' C:/Users/me`,
    String.raw`printf '%s' "C:/Users/me"`,
    String.raw`printf '%s' 'C:\Users\O'\''Brien'`,
    String.raw`echo safe # C:\Users\me`,
    String.raw`echo "text with 'apostrophes'"`,
    String.raw`printf '%s' 'powershell -Command setx SAMPLE value'`,
  ]) allowed(command);
});

test('all unsafe quote contexts are checked, including a quoted path in an unquoted heredoc', () => {
  for (const command of [
    String.raw`echo "C:\Users\me"`,
    String.raw`echo C:/Users\me`,
    String.raw`echo "C:/Program Files\app"`,
    String.raw`echo 'C:/Program Files'\app`,
    String.raw`echo \\server\share`,
    String.raw`echo "\\\\server\\share"`,
    "cat <<EOF\n'C:\\\\Users\\\\me'\nEOF\n",
    "cat <<'EOF'\nC:\\Users\\me\nEOF\n",
    "cat <<\\EOF\nC:\\Users\\me\nEOF\n",
    "cat <<\"EOF\"\r\nC:\\Users\\me\r\nEOF\r\n",
  ]) denied(command);
});

test('heredoc delimiters, multiple bodies, tab stripping and command resumption', () => {
  for (const command of [
    "cat <<'E OF'\nC:/Users/me\nE OF\n",
    "cat <<E'OF'\nC:/Users/me\nEOF\necho 'C:\\Users\\me'",
    "cat <<-EOF\n\tC:/Users/me\n\tEOF\n",
    "cat <<ONE <<'TWO'\nhello\nONE\nC:/Users/me\nTWO\n",
    String.raw`echo '<<EOF' 'C:\Users\me'`,
    String.raw`cat <<< 'C:\Users\me'`,
  ]) allowed(command);
  for (const command of [
    "cat <<E'OF'\nsafe\nEOF\necho C:\\Users\\me",
    "cat <<ONE <<'TWO'\nsafe\nONE\nC:\\Users\\me\nTWO\n",
    "cat <<-EOF\n\tC:\\\\Users\\\\me\n\tEOF\n",
    "cat <<EOF\nsafe\nE\\\nOF\necho C:\\Users\\me",
    String.raw`cat <<< "C:\\Users\\me"`,
  ]) denied(command);
});

test('nested command substitutions keep their own quote state', () => {
  denied(String.raw`echo "$(printf '%s' C:\Users\me)"`);
  denied('echo "`printf \'%s\' C:\\Users\\me`"');
  allowed(String.raw`echo "$(printf '%s' 'C:\Users\me')"`);
  allowed(String.raw`echo '$(printf "%s" C:\Users\me)'`);
});

const writers = [
  `powershell -Command "[Environment]::SetEnvironmentVariable('PATH', '', 'User')"`,
  `powershell.exe -NoProfile -c '[System.Environment]::SetEnvironmentVariable("SAMPLE", "value", "User")'`,
  `pwsh -Command 'setx SAMPLE value'`,
  `pwsh -Command 'reg add HKCU/Environment /v SAMPLE /d value'`,
  `pwsh -Command 'Set-ItemProperty -Path HKCU:/Environment -Name SAMPLE -Value value'`,
  `pwsh -Command 'Set-ItemProperty -Path Registry::HKEY_LOCAL_MACHINE/Software -Name SAMPLE -Value value'`,
  `pwsh -Command '$env:SAMPLE = "value"'`,
  `pwsh -Command 'Set-Item Env:SAMPLE value'`,
  `cmd.exe /c "setx SAMPLE value"`,
  `cmd /d /s /c "reg.exe add HKLM/Software/Sample /v value /d text"`,
  `cmd //c "set SAMPLE=value"`,
  `cmd /c"setx SAMPLE value"`,
  `powershell '[Environment]::SetEnvironmentVariable("SAMPLE", "value", "User")'`,
  `2>/dev/null powershell -Command 'setx SAMPLE value'`,
  `'C:/Program Files/PowerShell/pwsh.exe' -Command 'setx SAMPLE value'`,
  `env SAMPLE=value powershell -Command 'setx SAMPLE value'`,
  `echo "$(pwsh -Command 'setx SAMPLE value')"`,
  `cat <<EOF\n$(pwsh -Command 'setx SAMPLE value')\nEOF`,
];
for (const command of writers) {
  test(`inline write is refused: ${command}`, () => {
    assert.ok(inspectCommand(command).some(finding => /script file/i.test(finding.reason)));
  });
}

test('script files and read-only inline commands pass', () => {
  for (const command of [
    'powershell -NoProfile -File ./update-environment.ps1',
    'powershell -ExecutionPolicy RemoteSigned -File ./update-environment.ps1',
    'pwsh ./update-environment.ps1',
    'pwsh -File ./update.ps1 -Command setx',
    'cmd /c ./update-environment.cmd',
    `pwsh -Command 'Get-ItemProperty HKCU:/Environment'`,
    `powershell -Command '[Environment]::GetEnvironmentVariable("PATH")'`,
    'cmd /c "reg query HKCU/Environment"',
    'cmd /c "set SAMPLE"',
    "cat <<'EOF'\n$(pwsh -Command 'setx SAMPLE value')\nEOF",
    'echo powershell -Command setx SAMPLE value',
  ]) allowed(command);
});

test('hook protocol denies with a reason and leaves ordinary permissions alone', () => {
  const input = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const result = run(['hook'], JSON.stringify(input(String.raw`echo C:\Users\me`)));
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.hookEventName, 'PreToolUse');
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /forward slashes/i);
  const safe = run(['hook'], JSON.stringify(input("echo 'C:\\Users\\me'")));
  assert.equal(safe.status, 0);
  assert.deepEqual(JSON.parse(safe.stdout), {});
  assert.deepEqual(hookDecision({ tool_name: 'Read', tool_input: {} }), {});
});

test('malformed hook input and incomplete shell constructs fail closed', () => {
  for (const input of ['{', '{}', '{"tool_name":"Bash"}', 'null']) {
    const result = run(['hook'], input);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  for (const command of ['echo "open', "cat <<EOF\nbody", 'echo $(echo hi', 'cat <<']) denied(command);
});

test('lint finds mangled paths in every format and reports CRLF coordinates', () => {
  for (const [name, text] of [
    ['config.json', '{\r\n  "path": "C:Usersme.app"\r\n}'],
    ['config.yaml', 'path: C:Usersme.app\r\n'],
    ['config.yml', "path: 'D:Projectsapp'\n"],
    ['config.ini', '[app]\r\npath=C:Usersme.app\r\n'],
    ['config.toml', 'path = "C:Usersme.app"\r\n'],
  ]) {
    const findings = lintText(text);
    assert.equal(findings.length, 1, name);
    assert.match(findings[0].path, /^[CD]:[A-Z]/);
    assert.ok(findings[0].line >= 1);
    assert.ok(findings[0].column >= 1);
  }
  assert.deepEqual(lintText('\uFEFFone=ok\r\npath=C:Usersme\r\n'), [
    { path: 'C:Usersme', line: 2, column: 6 },
  ]);
});

test('lint passes clean paths, ordinary keys and URLs', () => {
  assert.deepEqual(lintText(String.raw`{"path":"C:\\Users\\me", "other":"D:/Projects/app", "url":"https://example.com"}`), []);
  assert.deepEqual(lintText('name:value\r\n[app]\npath=C:/Users/me'), []);
  assert.equal(lintText('paths=C:Usersme;D:Projectsapp').length, 2);
});

test('lint CLI reads every format, exits nonzero on findings and handles errors', t => {
  const directory = temporaryDirectory();
  const files = [];
  t.after(() => {
    for (const file of files) rmSync(file, { force: true });
    rmdirSync(directory);
  });
  // Repeat a path to exercise alias cleanup even on case-sensitive filesystems.
  // Keep JSON too: uppercase extensions must still reach the lint checks.
  for (const extension of ['json', 'yaml', 'yml', 'ini', 'toml', 'JSON', 'json']) {
    const file = join(directory, `config with spaces.${extension}`);
    files.push(file);
    writeFileSync(file, `path=C:Usersme.app\r\n`);
    const result = run(['lint', file]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`${file}:1:6`), result.stdout);
    assert.match(result.stdout, /C:Usersme\.app/);
    writeFileSync(file, 'path=C:/Users/me.app\r\n');
    assert.equal(run(['lint', file]).status, 0);
  }
  assert.equal(run(['lint', join(directory, 'missing.json')]).status, 2);
  assert.equal(run(['lint', join(directory, 'unsupported.txt')]).status, 2);
  assert.equal(run(['lint']).status, 2);
  assert.equal(run(['nonsense']).status, 2);
  assert.equal(run(['--help']).status, 0);
});

// Test the actual shell, never PowerShell/registry/environment writes. Windows
// must use Git Bash, not the unrelated WSL bash.exe in System32.
const shellEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
for (const key of ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH']) delete shellEnv[key];
const candidates = process.env.BASH_PATH ? [process.env.BASH_PATH] : process.platform === 'win32'
  ? [join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe'),
    join(process.env.LOCALAPPDATA || 'C:/Users/Default/AppData/Local', 'Programs/Git/bin/bash.exe'), 'bash.exe']
  : ['bash'];
let bash;
for (const candidate of candidates) {
  const probe = runProcess(candidate, ['--noprofile', '--norc', '-c', 'uname -s'], {
    timeout: 5000, env: shellEnv,
  });
  if (probe.status === 0 && (process.platform !== 'win32' || /MINGW|MSYS/.test(probe.stdout))) {
    bash = candidate;
    break;
  }
}
test('real Bash confirms mangling and preservation', { skip: !bash && process.platform !== 'win32' && !process.env.BASH_PATH }, t => {
  assert.ok(bash, 'Git Bash is required on Windows; set BASH_PATH to its bash.exe');
  t.diagnostic(`shell: ${bash}; platform: ${process.platform}`);
  const execute = script => {
    const result = runProcess(bash, ['--noprofile', '--norc', '-s'], {
      input: `${script}\n`, timeout: 5000, env: shellEnv,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replace(/\r\n/g, '\n');
  };
  for (const { name, word, expected } of manglingCases) {
    const command = `printf '%s' ${word}`;
    denied(command);
    assert.equal(execute(command), expected, name);
    assert.ok((word.match(/\\/g) || []).length > (expected.match(/\\/g) || []).length, name);
  }
  const heredoc = "cat <<EOF\nC:\\\\Users\\\\me\nEOF";
  denied(heredoc);
  assert.equal(execute(heredoc), 'C:\\Users\\me\n');
  const quotedBody = "cat <<EOF\n'C:\\\\Users\\\\me'\nEOF";
  denied(quotedBody);
  assert.equal(execute(quotedBody), "'C:\\Users\\me'\n");
  const safe = String.raw`printf '%s' 'C:\Users\me'`;
  allowed(safe);
  assert.equal(execute(safe), String.raw`C:\Users\me`);
  assert.equal(execute("printf '%s' C:/Users/me"), 'C:/Users/me');
  // These are conservative policy refusals, not claims of shell corruption.
  assert.equal(execute(String.raw`printf '%s' "C:\Users\me"`), String.raw`C:\Users\me`);
  assert.equal(execute("cat <<'EOF'\nC:\\\\Users\\\\me\nEOF"), 'C:\\\\Users\\\\me\n');
  const inline = String.raw`powershell -Command "[Environment]::SetEnvironmentVariable('SAMPLE', 'C:\\Users\\me' + $value, 'User')"`;
  denied(inline);
  const received = execute(`unset value\npowershell() { printf '%s\\n' "$@"; }\n${inline}`);
  assert.ok(received.includes(String.raw`C:\Users\me`));
  assert.ok(!received.includes('$value'));
});
