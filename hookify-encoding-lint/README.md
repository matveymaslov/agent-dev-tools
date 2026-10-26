# hookify-encoding-lint

An offline, zero-dependency Node.js CLI and library for checking hookify rule files
before relying on them to block an operation. MIT licensed; copy this directory
into its own repository or run it directly. Nothing is installed into Claude Code.

## Problem and inspected version

This tool targets **hookify 0.1.0** in `anthropics/claude-code`, inspected at commit
`94506ff0d3bd9185f1752da36e968775021fb48f`. This is a source pin, not a claim about
every release or installation. See the [plugin manifest](https://github.com/anthropics/claude-code/blob/94506ff0d3bd9185f1752da36e968775021fb48f/plugins/hookify/.claude-plugin/plugin.json#L3).

The [loader](https://github.com/anthropics/claude-code/blob/94506ff0d3bd9185f1752da36e968775021fb48f/plugins/hookify/core/config_loader.py#L244)
opens rules without specifying an encoding. On Windows installations whose Python
default is cp1252, a UTF-8 file can fail decoding or produce corrupted text.
`UnicodeDecodeError` reaches the earlier `ValueError` handler, which logs a
malformed-rule error and returns `None`. The [collector](https://github.com/anthropics/claude-code/blob/94506ff0d3bd9185f1752da36e968775021fb48f/plugins/hookify/core/config_loader.py#L198)
omits that rule. A blocking rule then provides no protection; there is a log line,
but no blocking response from that rule.

Python's cp1252 codec leaves bytes `81 8D 8F 90 9D` undefined. For example, one
`Ё` (UTF-8 `D0 81`) anywhere in a file causes decoding to fail. `é` (`C3 A9`)
decodes without an exception but becomes different characters, changing a regex.
Not every non-ASCII character causes a decode exception. Windows does not always
use cp1252: locale, Python version and UTF-8 mode matter. The portable reproduction
uses the explicit Python codec so it also demonstrates the defect on Linux.

There is a second, independent coverage problem. The inspected [field extraction](https://github.com/anthropics/claude-code/blob/94506ff0d3bd9185f1752da36e968775021fb48f/plugins/hookify/core/rule_engine.py#L235)
maps `new_text` and `new_string` to the tool's `new_string` value. Write supplies
`content`, so these fields yield an empty string for Write. A pattern requiring
nonempty text misses the write. `content` handles Write and Edit. The
[legacy file-rule shorthand](https://github.com/anthropics/claude-code/blob/94506ff0d3bd9185f1752da36e968775021fb48f/plugins/hookify/core/config_loader.py#L57)
also selects `new_text`. Conditions are [AND-ed](https://github.com/anthropics/claude-code/blob/94506ff0d3bd9185f1752da36e968775021fb48f/plugins/hookify/core/rule_engine.py#L120);
adding another condition for `content` does not repair an existing edit-only one.

## CLI

Requires Node.js 18 or newer. From this directory, no installation is needed:

```sh
node cli.mjs lint "/path/to/project/.claude"
node cli.mjs lint "./hookify.sample.local.md"
node cli.mjs fix "./hookify.sample.local.md"
node cli.mjs lint -- "-leading-dash.md"
```

These commands also work in PowerShell/cmd; use your Windows path, for example
`node cli.mjs lint "C:\work\sample project\.claude"`. Directories select only
`hookify.*.local.md` immediately inside them. Backups are ignored. Multiple files
and directories are accepted. Shell glob expansion and Git are not required.

`lint` reports every non-ASCII code point with a one-based line and column (Unicode
code points, not bytes or screen cells). It also reports invalid UTF-8, missing or
malformed front matter, unsupported syntax, and Write coverage problems. Invalid
UTF-8 stops analysis of that file at the first bad sequence and includes its byte
offset. Other files are still checked. ASCII-only supported rules pass.

`fix` changes only non-ASCII characters inside regex pattern values: `é` becomes
`\u00E9`; characters above U+FFFF use Python's `\U0001F600` form. A UTF-16
surrogate pair would change Python matching, so the longer form is intentional.
Existing escapes, quotes, and LF/CRLF/CR line endings are preserved. Python
[regex escapes](https://docs.python.org/3/library/re.html) interpret these ASCII
sequences as the original characters.

Before replacing a changed file, `fix` creates an exclusive, byte-for-byte
`<file>.bak` backup. An existing backup prevents a second rewrite; review and move
it yourself before retrying. A same-directory temporary file is renamed over the
original. Symbolic links are refused for fixing. Avoid editing the same file while
fixing it. A failed write can leave a backup, whose path is reported.

Message body text, metadata, comments and literal-operator patterns stay unchanged
and are listed for manual rewriting in ASCII. No translation or word replacement
is attempted. Invalid UTF-8, malformed front matter and Unicode group identifiers
are left untouched. Unicode group names need a consistent manual rename because
Python does not accept escapes in those identifiers.

Exit codes: **0** means clean after the requested operation; **1** means remaining
findings, an I/O error, or no matching files; **2** means a usage error. A partial
fix with remaining prose findings exits 1. Review the backup, rewrite prose, then
lint again. The tool never submits an issue or contacts a service.

## Supported rule format

The upstream parser is a small line parser, not a full YAML implementation. This
tool accepts a conservative subset: exact `---` delimiters, single-line plain or
quoted scalars, and expanded conditions with two/four-space indentation. It rejects
duplicate/unknown keys, invalid enums, empty conditions, tabs, ambiguous quotes,
empty values and block scalars (`|`, `>`).

Upstream reads every non-empty value as a plain string (after stripping quote
characters and mapping `true`/`false`), so an unquoted value that starts with `[`,
`{`, `&`, `*` or `!` is valid and lints clean. `pattern: [A-Z]+` needs no quotes.
Do not use YAML quote escaping: upstream strips outer quotes without decoding YAML
escapes. Inline comments are not stripped from scalar values by upstream. A value
that cannot be read is reported once; it does not also produce a "missing field"
or "empty pattern" finding.

A generic ASCII rule covering both Write and Edit:

```yaml
---
name: review-sample
enabled: true
event: file
action: block
conditions:
  - field: content
    operator: regex_match
    pattern: "caf\u00E9"
---
Please review the matching text before continuing.
```

For a Bash rule, `event: bash` plus a top-level `pattern` is supported. Literal
operators (`contains`, `equals`, `not_contains`, `starts_with`, `ends_with`) cannot
use regex escapes as a lossless replacement, so their Unicode remains a finding.
This is not a general regex validator or a guarantee that a rule blocks every
operation. It does not install hooks, infer intended patterns, repair already
corrupted text, or redesign conditions. A stricter subset can flag files that the
upstream parser accepts or silently ignores. Validate rules with real hook events.

## Library

```js
import { lint, fix, lintFile, fixFile } from './index.mjs';

const result = lint(new TextEncoder().encode(ruleText));
console.log(result.ok, result.diagnostics);
const proposed = fix(ruleText); // In-memory only; does not create a backup.
const checked = await lintFile('hookify.sample.local.md');
const written = await fixFile('hookify.sample.local.md'); // Creates .bak on change.
```

`lint` and `fix` accept a string or `Uint8Array`; bytes allow UTF-8 validation before
decoding. Results include `ok` and `diagnostics`; each diagnostic has `code`,
`message`, `line`, and `column`. Valid UTF-8 results also include `text` and parsed
`patterns`. `fix` adds `changed`; file operations add `file`, and a file rewrite
adds `backup`. File I/O failures become diagnostics. Unsupported in-memory input
types throw `TypeError`. No Python runtime is needed by the Node CLI or library.

## Tests and reproduction

Tests require Node.js and Python 3 (tried as `python3`, `python`, then `py -3`). All
tests are offline and use only standard libraries. Run from this directory:

```sh
npm test
python3 reproduce.py
python3 reproduce.py --native --json
```

On Windows, use `py -3 reproduce.py` if `python3` is unavailable. The explicit test
entry points, without npm or shell globs, are:

```sh
node --test test/hookify-encoding-lint.test.mjs test/reproduction.test.mjs test/scalar-whitespace.test.mjs
```

Tests compile original and fixed patterns with Python `re` and compare matches,
including Cyrillic, punctuation, ranges, astral characters and escaped literals.
They also exercise cp1252 against actual UTF-8 rule bytes, backups, CLI exit codes,
paths with spaces, line endings and Python-specific scalar whitespace.

For a **native Windows check of the actual plugin loader**, point at an existing,
trusted hookify plugin directory (containing `core/config_loader.py`):

```powershell
py -3 -X utf8=0 reproduce.py --native --plugin "C:\path\to\plugins\hookify" --json
```

This imports that local plugin and runs it only against a generated generic rule
in a temporary directory. It never reads your project's rules. Inspect the report:
`platform: "win32"`, `encoding: "cp1252"`, `decode_failure: true`, `loaded_rules: 0`,
and `windows_skip_confirmed: true` establish the native skip. It also reports the
installed plugin version and captured loader log. A UTF-8 or other locale may not
reproduce it; exit 0 alone does **not** establish the native Windows observation.
Without `--plugin`, `--native` checks only the default codec, not hookify.

The repository's root workflow runs these tests on Linux and Windows. Checking
hookify's own loader natively on Windows with `--plugin` is a separate manual step;
portable cp1252 emulation is not evidence of a native Windows run.

To inspect the package contents, use `npm pack --dry-run` in this directory. The
package has no dependencies or lifecycle hooks. Its file list includes source,
tests, reproduction, README and license.

## Neutral issue draft (not submitted)

**Title:** Explicit UTF-8 rule loading and Write content coverage in hookify

I inspected hookify 0.1.0 at commit
`94506ff0d3bd9185f1752da36e968775021fb48f`.

`load_rule_file` opens files without an encoding. With Python's cp1252 default,
a UTF-8 rule containing one U+0401 character raises `UnicodeDecodeError`.
The loader logs a malformed-rule error and the rule is omitted. Some other
characters decode successfully into different text, changing regex behavior.

A minimal standard-library reproduction is:

```python
import re
print(re.fullmatch(r"\u00E9", "\u00e9") is not None)
print(re.fullmatch("\u00e9".encode("utf-8").decode("cp1252"), "\u00e9") is not None)
"\u0401".encode("utf-8").decode("cp1252")  # UnicodeDecodeError
```

Separately, a file condition using `new_text` receives an empty string for Write,
whose payload uses `content`. `content` already handles Write and Edit in the
inspected engine. The legacy file-pattern shorthand also selects `new_text`.

Would explicit UTF-8 decoding, a clearly visible rule-load failure, and tests for
non-ASCII rules and Write/Edit coverage be appropriate? Documenting `content` for
shared coverage would also help. The reproduction above emulates cp1252 on any
OS; native Windows behavior depends on the actual Python encoding configuration.
