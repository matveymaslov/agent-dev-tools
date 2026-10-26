# bash-path-guard

A zero-dependency Node.js package with a Claude Code **PreToolUse hook** for
Bash and a **config path lint**. Requires Node.js 22 or newer. MIT licensed.

## Problem

Git Bash parses a command before the target program sees it. For example:

```bash
printf '%s' C:\Users\me               # receives C:Usersme
printf '%s' "C:\\Users\\me"           # receives C:\Users\me
cat <<EOF
{"path":"C:\\Users\\me"}
EOF
```

The unquoted heredoc also halves the doubled backslashes. That can turn intended
JSON escapes into invalid escapes or different characters. A command can exit
successfully while writing a damaged config file.

An inline `powershell -Command "... $value ..."` also gives Bash an opportunity to
expand `$value` before PowerShell sees it. Environment and registry changes can
therefore persist a damaged or empty value.

Use `C:/Users/me` when the target program supports forward slashes. Otherwise use
a literal Bash single-quoted argument such as `'C:\Users\me'`. For environment or
registry writes, put the operation in a reviewed `.ps1` or `.cmd` file and run it
by filename. Script contents must be written with an editor or a file-writing API
that preserves their bytes.

## Install

This folder is the entire package. No dependency installation, build step, or
network access is needed to run it:

```sh
node /absolute/path/bash-path-guard/bin/bash-path-guard.mjs --help
```

For a local npm installation, from this folder run `npm pack`, then install the
resulting archive with `npm install --global ./bash-path-guard-0.1.0.tgz`.
The installed command is `bash-path-guard`. These instructions do not assume
that a registry package has already been published.

### Claude Code hook

Merge this entry into your existing `.claude/settings.json` (or user settings).
Replace the example path with the absolute location of the installed CLI file;
keep Windows paths as forward slashes, including paths with spaces:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/tools/bash-path-guard/bin/bash-path-guard.mjs\" hook"
          }
        ]
      }
    ]
  }
}
```

On Linux, use a path such as `/opt/bash-path-guard/bin/bash-path-guard.mjs`.
If `node` is not on the hook process's PATH, replace it with its quoted absolute
executable path. Installation is manual; this package never rewrites settings.

The hook reads one JSON object from stdin, including `tool_name: "Bash"` and
`tool_input.command`. It writes one decision object to stdout, with no logging:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Reason and suggested repair in words"}}
```

On safe commands or unrelated tools it writes `{}`. This leaves normal permission
checks in place. Decisions use exit code zero, as required by the
[Claude Code hook protocol](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).
Malformed input, incomplete quotes/heredocs, or inspection limits produce a deny
decision with an explanation.

## What is refused

- Drive paths or UNC paths with backslashes in unquoted words, double quotes,
  ANSI-C quotes (`$'...'`), or any heredoc body. Paths crossing quote boundaries
  and paths with spaces are checked too.
- Inline `powershell`, `powershell.exe`, `pwsh`, or `cmd` writes using
  `SetEnvironmentVariable`, `setx`, `reg add`, or `Set-ItemProperty` targeting
  `HKCU`, `HKLM`, `HKEY_CURRENT_USER`, or `HKEY_LOCAL_MACHINE`.
- Inline `$env:NAME = ...`, `Set-Item`/`Set-ItemProperty`/`New-Item`/`Remove-Item`
  on `Env:`, and cmd `set NAME=...` writes.

The inline-write restriction applies even to single-quoted command strings or
commands using forward slashes. Use `powershell -File ./update.ps1` or
`cmd /c ./update.cmd`. Read-only inline commands and script-file invocations pass
if their argument paths satisfy the path rule.

The tokenizer tracks comments, ordinary and ANSI-C quotes, escapes, command
substitutions, redirections, here-strings, multiple heredocs, quoted/mixed/escaped
delimiters, `<<-` tab stripping, delimiter continuations, and LF/CRLF input.
It never executes the command being inspected.

### Conservative policy versus actual Bash damage

The path rule is intentionally stricter than Bash's escaping rules. For example,
`"C:\Users\me"` normally preserves its single backslashes, and a heredoc with a
quoted delimiter preserves the entire body. Both are still refused, to give
agents one consistent instruction: forward slashes, literal single-quoted path
arguments, or a script file. Quotes **inside** an unquoted heredoc body do not
protect anything. See the
[Bash double-quote rules](https://www.gnu.org/s/bash/manual/html_node/Double-Quotes.html)
and [heredoc rules](https://www.gnu.org/software/bash/manual/bash.html#Here-Documents).
Tests explicitly distinguish proven mangling from these policy refusals.

## Config lint

```sh
node /absolute/path/bash-path-guard/bin/bash-path-guard.mjs lint config.json settings.yaml app.ini tool.toml
```

Pass explicit UTF-8 file paths (`.json`, `.yaml`, `.yml`, `.ini`, `.toml`, case
insensitive). Multiple files and paths containing spaces work; use `--` before
the first filename if desired. The command reads files without modifying them.

It finds a drive letter and colon followed immediately by an ASCII letter,
such as `C:Usersme.app`, and reports `file:line:column` (one-based):

```text
config.json:2:12: suspicious drive-relative path C:Usersme.app; use C:/Users/me or correctly escaped backslashes
```

Exit codes: **0** clean, **1** suspicious paths, **2** usage/read/format error.
An error takes precedence over findings in other files. UTF-8 BOM and CRLF are
handled; UTF-16 files must be converted to UTF-8 first.

## Limits

This is an accident guard, not a security sandbox or a complete Bash parser.
It does not evaluate variables, aliases, functions, `eval`, encoded commands,
assembled command names, arbitrary wrappers, or script contents. A nested shell
command passed as literal data (`bash -c '...'`) is not recursively interpreted.
PowerShell/cmd write detection is lexical and conservative: text mentioning a
write inside an inline command may also be refused. Use a script file to make
complex commands reviewable. Complex shell grammar such as arithmetic shifts
can produce conservative syntax refusals. Input is limited to one MiB of command
text and 32 nested shell groups/substitutions.

The lint is a text scan, not four config parsers. It also sees comments, does not
decode JSON/YAML escapes, and cannot recover missing backslashes. Intentional
drive-relative paths (`C:relative`) and strings such as `x:value` are ambiguous
and may be flagged. URLs such as `https://example.com` and normal multi-letter
keys are not drive-path matches. It does not find every possible damaged path.

## Tests

From this package folder:

```sh
npm test
# or, with no npm involved:
node --test test/bash-path-guard.test.mjs
```

The suite uses only Node built-ins and local files/processes. It never connects
to the network or performs a real environment/registry write. Integration cases
invoke real Bash to measure lost backslashes and dollar signs; a harmless shell
function captures PowerShell arguments without running PowerShell.

On Windows, install Git for Windows and run the same test command in a terminal.
The suite looks for Git Bash in the usual installation directories and on PATH;
it rejects WSL Bash for this check. For a custom installation, set `BASH_PATH`
to the absolute `bash.exe` path. Missing Git Bash fails the Windows test. On
Linux, Bash is used when present; its absence is an explicitly skipped test.
An explicitly supplied but invalid `BASH_PATH` always fails.

The package's `.gitattributes` keeps executable JavaScript files as LF after Git
checkout. CRLF fixtures are built at runtime so Git's checkout conversion cannot
silently remove the CRLF coverage.
