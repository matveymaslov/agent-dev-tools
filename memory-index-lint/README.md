# memory-index-lint

A small, zero-dependency Node.js CLI for checking and archiving a Markdown
auto-memory index. MIT licensed. Requires Node.js 22 or later.

## Why this exists

Claude Code loads a bounded prefix of `MEMORY.md` into each session. A lesson
can remain on disk while its index entry falls outside that prefix. The
[official memory documentation](https://code.claude.com/docs/en/memory#how-it-works)
describes a limit of 200 lines or 25 KB, whichever comes first. Some versions
also warn or reject writes exceeding the limit; an independently edited index
still benefits from a check.

This tool models a configurable **200 physical lines / 25,000 UTF-8 bytes**
budget. It is a conservative file-size check, not a reimplementation of a
particular Claude Code release. Character-based loaders can differ for Unicode.
Confirm the limits for your version and override them as needed.

## Run

No install, build, shell utilities, Git executable, network access, or API key
is needed. From this folder:

```sh
node bin/cli.cjs lint "/path/to/memory/MEMORY.md"
node bin/cli.cjs archive "/path/to/memory/MEMORY.md"
node bin/cli.cjs archive "/path/to/memory/MEMORY.md" --apply
```

On Windows, the same commands accept native quoted paths:

```powershell
node bin/cli.cjs lint "C:\Users\Example\memory\MEMORY.md"
```

The file argument defaults to `MEMORY.md` in the current working directory.
An npm package exposes the same commands as `memory-index-lint`.

```sh
node bin/cli.cjs lint MEMORY.md --max-lines 180 --max-bytes 22000
node bin/cli.cjs archive MEMORY.md --max-lines 180 --archive older-notes.md
node bin/cli.cjs --help
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--max-lines N` | `200` | Maximum physical lines, including headings and blanks |
| `--max-bytes N` | `25000` | Maximum UTF-8 bytes, including newlines and any BOM |
| `--near-percent N` | `90` | Lint warning when either budget reaches this percentage |
| `--max-line-length N` | `240` | Maximum Unicode code points per line, excluding newline |
| `--archive NAME` | `MEMORY.archive.md` | Archive filename beside the index; archive command only |
| `--apply` | off | Write the printed archive selection; archive command only |

Numeric options are positive integers; `--near-percent` is from 1 to 100.
Every relevant command accepts the same budget options. `--near-percent` and
`--max-line-length` affect lint only, not archival selection.

## Lint

Lint prints used and remaining capacity, the overage if any, and the byte
offset at which the configured prefix ends. Findings include:

- `OVER LIMIT` and `NEAR LIMIT`, with exact overage or remaining capacity.
- `PAST CUT` for fully excluded entries and `PARTIAL CUT` for truncated ones.
- `MISSING FILE`, `NOT A FILE`, and `INVALID LINK`, with entry line numbers.
- `DUPLICATE` for repeated normalized entry text or local file targets.
- `OVERLONG LINE`, with character count and excess length.
- `UNSUPPORTED ENTRY` for reference-style or ambiguous link syntax.

The byte limit can cut inside a line or a multibyte character. LF, CRLF and CR
each delimit a single physical line; a final newline does not add a phantom
line. Two consecutive final newlines do include one blank line.

Local inline Markdown links resolve relative to the index, independently of
the process working directory. Forward/backward slashes, URL-encoded filenames,
angle-bracket destinations, balanced parentheses, and optional quoted titles
are supported. Fragments and query strings are excluded when resolving files.
Remote URLs and fragment-only links are ignored. Fenced code and inline code
and HTML comments are not treated as note links. Duplicate paths normalize `.` and `..`, ignore
fragments, and use case-insensitive comparisons on Windows. Symlink aliases and
hard-link aliases are not deduplicated. UTF-8 input is required.

Exit codes: **0** means clean lint or successful archive/dry run; **1** means
lint findings (including near-limit warnings); **2** means invalid arguments,
unreadable input, or an unsafe/impossible archive operation.

## Archive rule and recovery

Archive prints its rule, destination, each selected entry's original line and
timestamp, and the resulting size **before any write**. It selects the least
recently changed referenced note first, using the filesystem modification
time (`mtime`). For an entry with multiple local links, the newest target time
wins. Ties use original line order. There is no Git-history dependency; copying
or checking out notes can change their timestamps.

Only top-level, single-line list items with resolvable local inline links are
eligible. The rule keeps choosing entries until the retained index is strictly
below both configured limits, counting this one-line pointer at the beginning:

```markdown
Archived entries: [Archive](<MEMORY.archive.md>).
```

The archive stays beside the original index so relative links keep working.
Entries are appended verbatim to it; **note files are never moved or deleted**.
The active index retains its existing content and line endings except for the
selected lines and archive pointer. Existing archive content is preserved.
Spaces and punctuation in the archive filename are URL-encoded in the pointer.

Dry run creates no locks, backups or other files. `--apply` recalculates the
selection from current input and prints it again. The selection matches a dry
run when the index, notes, timestamps, options and existing archive are unchanged.
If the index is already strictly below both limits, even `--apply` is a no-op.
Archival can leave a near-limit warning or unrelated lint findings; it does not
repair missing notes, duplicates or long retained lines.

When applying, the tool:

1. Acquires an exclusive lock beside the index and checks input snapshots.
2. Saves the exact original index as `MEMORY.md.bak-<timestamp>-<random>`.
3. Backs up an existing archive in the same way, without overwriting old backups.
4. Writes sibling temporary files, then replaces the archive before the index.

The two replacements are **not one filesystem transaction**. If interrupted
between them, entries may appear in both indexes, but the original index and
its backup retain the notes' references. An error after the archive replacement
reports that state and the available backups. To recover, stop other writers
and restore both files from the printed backups, or reconcile duplicate entries
before retrying. If there was no prior archive, inspect the newly created one
before removing it. A crash can leave `.tmp-*` files or the
`.memory-index-lint.lock`; remove these only after checking no archiver is active.
Backups remain until you choose to remove them.

## Boundaries

- This is a small Markdown subset, not a full CommonMark parser. Reference-style
  links are flagged. Multiline/lazy list items, plain prose, missing-target items,
  comment-bearing items, and fenced examples stay pinned. If they prevent fitting, archive fails before
  writing anything. Convert an entry into a standalone inline-linked list item
  when you want it eligible for archival. Archive rejects raw HTML tags and
  unclosed comments/code fences in either index so appended entries stay visible.
- Headers, blank lines, and unrecognized prose consume the budget even when they
  cannot be archived. Lint cannot infer semantic duplicates or importance.
- Archive filenames must be portable filenames in the same directory. Naming
  the index, an already-linked note, or a Windows reserved filename is rejected.
- Archive refuses symlinked/hard-linked index or archive files. Ancestor directory
  symlinks are not a sandbox. Only run it on directories you control, without
  simultaneous editors. Snapshot checks and the cooperative lock reduce races;
  they cannot prevent arbitrary external writes or guarantee power-loss durability.
- The archive is available for explicit reading. Its pointer does not guarantee
  Claude Code will read or recall the archived lessons.
- No auto-discovery of private memory directories and no reading of note bodies:
  only the supplied index/archive text and referenced files' metadata are used.

## Test and package

```sh
npm test
npm pack --dry-run
```

`npm test` runs `node --test index.js`. Tests exercise the CLI with synthetic
notes, explicit timestamps, LF/CRLF, Unicode paths, backup recovery and
interrupted writes. Generated fixtures and captured process output stay in
ignored `.test-tmp/` for inspection. No real memory is included. `index.js` is
the test entry point, not a library API.

The repository's root workflow runs the tests on Node.js 22 and 24 on Windows and
Linux. The npm allowlist ships only the CLI, library implementation, README and
license. No dependencies are installed to test or package it.
