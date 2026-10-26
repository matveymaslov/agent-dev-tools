# proof-currency

Does a proof still describe the code?

A report can keep saying “proved” while its receipt points to a test run dozens
of commits behind the code being described. This small CLI checks the relationship
between recorded proof commits, the current Git history and the paths they cover.
It does not rerun tests or decide whether the original proof was sufficient.

Zero dependencies. Requires Node.js 22 or newer and Git 2.43 or newer on PATH.
No installation or build is needed to run it from a checkout.

## Run

From this folder:

```sh
node bin/proof-currency.mjs --repo /path/to/checkout /path/to/report.md /path/to/receipt.json
node bin/proof-currency.mjs --report-only --repo /path/to/checkout /path/to/receipt.json
node --test test/proof-currency.test.mjs
```

Use a native Windows directory in place of `/path/to/checkout` on Windows. Quote
arguments containing spaces. Git is invoked directly with an argument array,
without a shell. A packaged installation exposes the `proof-currency` command.

`--repo` defaults to the invocation directory, which may be inside the repository.
Input files and `--config` are relative to the **invocation directory**. Covered
paths always start at the **repository root**, even if the receipt lives elsewhere.
Name files explicitly; there is no recursive file discovery or shell globbing.
Use `--` before filenames starting with a dash. `--help` prints usage.

Each output record names its file, field and recorded commit, then gives a verdict
and a reason in words. A stale record lists every changed covered path. Filenames
are JSON-quoted so spaces, newlines and control characters remain unambiguous.

## Records

Default commit field names: `proof_commit`, `verified_at`, `commit`.
Values must be **strings containing hexadecimal commit hashes**, not dates,
branch names, tags or expressions such as `HEAD~2`. Both full hashes and unambiguous
abbreviations of at least four characters work. Full hashes are recommended: an
abbreviation that matches several commits is reported as `unknown commit` (“Unknown
or ambiguous commit”) rather than guessed, and one that was unique can become
ambiguous as a repository grows.

A JSON receipt:

```json
{
  "proof_commit": "0123456789abcdef0123456789abcdef01234567",
  "paths": ["src", "test/parser.test.mjs"]
}
```

The hash above is a placeholder; replace it with the actual tested commit.
JSON is searched recursively through objects and arrays. Each configured commit
field becomes a separate record. Its `paths` list belongs to the **same object**;
it is not inherited from a parent object. For different scopes, use separate
objects, for example an array of receipts. Object keys must be unique.

A document with front matter:

```yaml
---
title: Parser verification
verified_at: '0123456789abcdef0123456789abcdef01234567'
paths:
  - src/parser.mjs
  - test/parser.test.mjs
---
The parser checks passed at the recorded commit.
```

An inline list also works: `paths: [src, "test/parser.test.mjs"]`.
Front matter must begin at the start of the file and close with `---`. LF, CRLF
and an initial UTF-8 BOM work. Comments, unquoted strings, JSON double-quoted
strings and YAML-style single-quoted strings are supported. Single quotes inside
single-quoted strings are doubled. Indent block list entries with spaces.

This is a **flat subset**, not a general YAML parser: nested maps, anchors,
multiline scalars and complex YAML values are rejected. Quote strings containing
quote characters, commas or `#`. The document body is not parsed. A `.json`
extension, case-insensitively, selects JSON; other files use front matter.

`paths` contains literal files or directories, not globs or Git pathspecs.
Directories cover descendants, with a path-segment boundary: `src` does not cover
`src-extra`. Both `/` and `\` are accepted as separators in coverage lists.
Use `/` in portable records. Matching uses Git's case-sensitive path spelling.
Absolute paths, parent traversal, empty strings and non-string entries are errors.
An absent list, an empty list or `.` covers **every path**.

A receipt itself counts as a changed path when it is inside its own coverage.
Keep receipts outside the checkout or scope them to the code and tests they
actually describe; a newly written untracked receipt cannot make an all-paths
HEAD proof current.

## Configuration

An optional JSON config replaces the default key list and/or the paths field:

```json
{
  "keys": ["checked_revision", "tested_commit"],
  "pathsKey": "covers"
}
```

```sh
node bin/proof-currency.mjs --config proof.config.json receipt.json
```

The same config applies to JSON and front matter. Keys must be distinct flat
field names (letters, digits, underscore or hyphen, starting with a letter or
underscore). Dotted selectors are not supported. Unknown config options, null
values, an empty key list or overlapping commit/paths keys are errors.

## Verdicts and exits

| Verdict | Meaning | Exit contribution |
| --- | --- | --- |
| current | Commit is HEAD; covered paths are clean. | 0 |
| still about these paths | Commit is an ancestor of HEAD; covered paths match and are clean. | 0 |
| stale | Covered paths differ from the ancestor commit, or have staged, unstaged or untracked changes. Changed paths are listed. | 1 |
| not on this history | Known commit is not an ancestor of HEAD in the available history. | 1 |
| unknown commit | Hash cannot be resolved to exactly one commit in this clone: it is missing (including missing shallow history) or a short hash is ambiguous. The reason starts with “Unknown or ambiguous commit”. | 1 |

Any failing record makes the CLI exit 1. Unknown and off-history records have an
empty changed-path list: no comparison is claimed. A missing file, malformed
record, a file with no records, invalid config, Git failure or repository without
a HEAD commit exits 2 with a diagnostic on stderr. `--report-only` always exits 0,
including for input errors; diagnostics still appear. It is for reporting, not
for enforcing a gate.

## Library

All APIs are synchronous and use only Node built-ins:

```js
import { checkFiles, checkRecord, readRecords, exitCode } from './index.mjs';

const results = checkFiles(['receipts/check.json'], {
  cwd: '/path/to/checkout',
  config: { keys: ['proof_commit'], pathsKey: 'paths' }
});
for (const result of results) {
  console.log(result.verdict, result.reason, result.changedPaths);
}
process.exitCode = exitCode(results);
```

- `readRecords(file, config?)` reads a named file without accessing Git. It returns
  `{ commit, paths, source: { file, field } }` records; no records yields `[]`.
- `checkRecord({ commit, paths? }, { cwd? }?)` checks one supplied record.
- `checkFiles(files, { cwd?, config? }?)` resolves relative files against `cwd`,
  discovers all records, snapshots HEAD/status once and returns checked records.
  It rejects any input file containing no records.
- Results retain the record and add `verdict`, `reason`, `changedPaths`, `head`
  and `resolvedCommit` (null when unknown). Paths are sorted and deduplicated.
- `exitCode(results, { reportOnly? }?)` returns 0 or 1 for checked results. Input
  and Git errors throw; callers decide how to handle those errors.

## Limits

- Only Git's available history is considered. Nothing fetches missing history
  explicitly. An unresolved hash is always unknown. In a shallow clone, even a
  known commit may lack a traversable ancestry path; the history verdict says
  “in the available history” for that reason.
- “Unchanged” compares the proof and HEAD **snapshots**, plus current Git status.
  An intermediate change that was fully reverted is not reported. This tool
  checks code currency, not the trustworthiness of receipts or test coverage.
- Git-ignored files and worktree changes hidden by assume-unchanged/skip-worktree
  flags are outside status visibility. Runtime data, dependencies outside the
  checkout, environment variables and external services are outside coverage.
- Submodule changes are reported at the submodule path; coverage inside that
  path is conservatively marked stale. Submodule contents are not enumerated.
- Git filenames must be valid UTF-8. Literal backslashes in POSIX filenames are
  outside the portable coverage format. Use Git's stored case even on Windows.
- Keep the checkout stable during a check. No lock prevents a concurrent editor,
  checkout or commit; this is a read-time observation, not an atomic attestation.
- Commands are limited to `rev-parse`, `merge-base --is-ancestor`,
  `diff --name-only -z` and `status --porcelain=v1 -z`. Diff rename detection is
  disabled so both old and new paths remain visible. Status also accounts for
  both sides of renames. No diff tools, text conversion or filesystem monitor
  hooks are run. Git subprocess output has a 32 MiB limit; overflow is an error.

## Development

`npm test` runs `node --test test/proof-currency.test.mjs`. Tests create temporary
local repositories, exercise actual branches and rebases, and shallow-clone via
`file:`. They use no network or third-party packages. Fixtures are retained under
the OS temporary directory for diagnosis. The newline-filename test is skipped on
Windows, where that filename is not valid; other cases run on both systems.

The repository's root workflow runs the tests on Linux and Windows with Node 22
and 24, with no dependency installation.

Run `npm pack --dry-run` to inspect the package. It contains the CLI, library,
README and license; tests stay out of the package.

MIT licensed; see [LICENSE](LICENSE).
