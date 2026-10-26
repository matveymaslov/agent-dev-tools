# hook-entry-by-shape

A small, zero-dependency Node.js library and CLI for installing a Claude Code
command hook exactly once. MIT licensed. Requires Node.js 22 or later.

## The problem

An installer may attach an extra marker key to its hook entry. If an interactive
settings re-save drops unknown keys, that marker disappears. A subsequent install
cannot recognize its own hook, appends another copy, and the hook runs twice.

This library identifies a hook by its **event, matcher, program, and script
path**. It never generates marker keys. The same identity powers installation,
lookup, removal, and duplicate repair.

## API

Use the package's named exports, or import `./index.js` from a checkout:

```js
import { install, find, remove, repair } from 'hook-entry-by-shape';

const entry = {
  event: 'PreToolUse',
  matcher: 'Bash',
  command: 'node "/opt/hooks/check.js"',
  timeout: 10,
};

install('settings.json', entry);
// { changed: true, added: 1, backupPath: '.../settings.json.20260102T030405006Z.bak' }
install('settings.json', entry);
// { changed: false, added: 0, backupPath: null }

const matches = find('settings.json', entry);
// [{ event, matcher, groupIndex, hookIndex, hook }]
repair('settings.json', entry);
// { changed, removed, backupPath }; keeps the first occurrence verbatim
remove('settings.json', entry);
// { changed, removed, backupPath }; removes every occurrence of this shape
```

All functions are synchronous and throw on invalid input or filesystem errors.
`entry.event` and `entry.command` are required. `matcher` is optional. Other entry
fields become command-handler fields; `type`, if supplied, must be `"command"`.
Supply JSON data, not objects with custom serialization or executable properties.
No hook command is executed by this library.

The resulting settings structure is the event → matcher group → handlers
structure described in the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#configuration).
For example, installation adds:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "node \"/opt/hooks/check.js\"", "timeout": 10 }]
    }]
  }
}
```

`install` appends one group only when no matching handler exists; it does not
repair existing duplicates or update an existing handler's options. `find`
returns one record per matching handler, in file order. `remove` and `repair`
remove individual handlers, preserving unrelated handlers in mixed groups.
Groups emptied by a removal are removed; the event array itself is retained.

### What counts as the same shape?

| Part | Comparison |
| --- | --- |
| Event | Exact string |
| Matcher | Exact string; omitted and `""` are equivalent; `"*"` stays distinct |
| Program | Full normalized token, never just its basename |
| Script | First argument, normalized as a path |
| Other arguments, timeout, async, unknown keys | Excluded from identity |

The supported shell form is `program script [arguments...]`. Single quotes,
double quotes, adjacent quoted fragments, and POSIX escaped spaces are handled.
For [exec form](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form), use
`command: 'node', args: ['/opt/hook folder/check.js']`; each argument is already a
literal token, so do not surround it with shell quotes.

Windows drive-absolute and UNC paths are recognized even on Linux. Windows
comparison normalizes backslashes, forward slashes, dot segments, and case. On
Windows, relative paths and bare program names also receive Windows comparison.
On Linux, relative paths are case-sensitive and backslashes are literal except
when escaping an unquoted space. All functions accept a third argument
`{ platform: 'win32' | 'linux' | 'darwin' }` to choose relative-path semantics when
editing another machine's settings. Absolute Windows paths still identify
Windows commands with that option set.

For example, these commands have the same shape:

```text
"C:\Program Files\Node\NODE.EXE" "D:\Hooks Folder\Check.js" --old
'c:/program files/node/node.exe' 'd:/hooks folder/check.js' --new
```

Arguments after the script and handler options intentionally do not distinguish
entries. If two tools share the same event, matcher, program, and script path,
they are indistinguishable to this library. Give distinct hooks distinct script
paths when both must survive removal or repair.

## CLI

From a checkout, run `node cli.js`. An installed package exposes
`hook-entry-by-shape` through npm's normal platform-specific bin wrappers.

Put the entry in `entry.json` to avoid POSIX, cmd.exe, and PowerShell quoting
differences:

```json
{
  "event": "Stop",
  "command": "node",
  "args": ["C:\\Hooks Folder\\check.js"]
}
```

```text
node cli.js install settings.json entry.json
node cli.js find settings.json entry.json
node cli.js repair settings.json entry.json
node cli.js remove settings.json entry.json
node cli.js find settings.json entry.json --platform win32
```

Results are JSON on stdout. Exit status: `0` success (including no change or no
matches), `1` invalid input or I/O failure, `2` bad command-line usage. Errors go
to stderr. Both JSON files may start with a UTF-8 BOM and use LF or CRLF.

## Writes and preservation

- Existing unrelated settings and handler objects keep their exact source bytes:
  whitespace, numeric spelling, escaped strings, and line endings are not
  regenerated. Only added/removed entries and their adjacent commas are edited.
- Before replacing an existing settings file, its exact previous bytes are
  atomically saved to a new file next to it, named
  `<settingsPath>.<UTC timestamp>.bak` (for example
  `settings.json.20260102T030405006Z.bak`; `-1`, `-2`, ... is appended if two
  writes share a millisecond). A backup is never overwritten, so the state from
  before the first change survives every later write. Names sort in write
  order. Backups accumulate, one per mutation that changed something; delete
  the ones you no longer need. No-op calls write neither settings nor a backup.
- Both backup and replacement are written to unique files opened exclusively in
  the destination directory, flushed, closed, and renamed into place. There is
  no truncate-and-rewrite or delete-before-rename fallback. A failed backup
  prevents the settings replacement. A failed settings rename leaves the old
  settings and their backup available. Temporary files are cleaned up on normal
  errors; a killed process can leave a temporary file.
- Existing POSIX permission bits are retained. New settings files use mode 0600
  (subject to OS behavior). Missing files are created by `install` only, along
  with any missing parent folders; there is no previous version to back up.
  Missing files produce no matches for other operations, which create nothing.

## Limits

- Strict UTF-8 JSON only: no comments, trailing commas, or duplicate object keys.
  Malformed target hook containers are rejected rather than rewritten.
- Direct program + script invocations only. Interpreter flags before the script,
  environment assignments/expansions, shell wrappers, substitutions, pipelines,
  redirections, compound commands, escaped quotes, and direct scripts without a
  separate program are outside the grammar. Unsupported target commands throw;
  unsupported existing commands are left alone. Use exec form for literal
  characters that a shell would interpret.
- Paths are compared lexically, without filesystem or PATH lookup. A bare
  `node` differs from `/usr/bin/node` and from `node.exe`. Relative paths differ
  from absolute paths. No environment expansion, symlink resolution, short-name
  resolution, or shell-specific execution equivalence is attempted.
- Callers must serialize writers. Atomic replacement prevents partial reads,
  but does not coordinate concurrent editors/installers or provide a multi-file
  transaction for settings and backup. No power-loss durability guarantee is
  made for directory entries, network filesystems, or unusual filesystems.
- Settings symlinks and non-regular files are rejected. Windows ACLs, ownership,
  extended attributes, and hard-link relationships are not copied. A Windows
  sharing violation causes an error without deleting the original.

## Tests

No dependency installation is needed:

```text
npm test
npm pack --dry-run
```

`npm test` runs `node --test "test/*.test.js"`; package consumers resolve the
library through `exports`. For local file imports, use `index.js`, not a
directory import.

Tests exercise the public API, CLI processes, marker stripping, mixed groups,
Windows path spellings, Linux case sensitivity, exact preservation, backups,
and injected filesystem failures. The repository's root workflow runs them on
Linux and Windows with Node.js 22 and 24. `.gitattributes` keeps executable
JavaScript files LF-terminated while tests explicitly cover CRLF settings.
