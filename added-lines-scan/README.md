# added-lines-scan

A push publishes every commit between the remote branch and yours, not the tree you end
up with. A secret, a private path or a name that was added in one commit and removed by a
later one is gone from your working tree and from `git diff origin/main`, and it is still
in the history that goes public. A scan of the final tree, or of the overall diff, calls
that range clean.

This tool scans the lines **added by each commit** in a range for forbidden markers and
exits non-zero on any hit, so it can sit in a `pre-push` hook or in CI. It reads each
commit's own patch, so a leak that a later commit removed is reported against the commit
that added it.

Zero dependencies. Requires Node.js 22 or newer and Git on PATH. MIT licensed. Runs on
Windows and Linux. It was developed and tested with Git 2.53; the Git options it uses are
old, but no other Git version has been run.

## Run

From this folder:

```sh
node bin/added-lines-scan.mjs --range origin/main..HEAD --markers markers.txt
node bin/added-lines-scan.mjs --range origin/main..HEAD --markers markers.txt \
  --repo /path/to/repo --allow-file docs/example.md --allow-file tests/fixtures.txt
```

| Option | Meaning |
| --- | --- |
| `--range <revisions>` | Required. What Git accepts as revisions: `origin/main..HEAD`, a single revision (every commit reachable from it, root included), or several separated by spaces such as `HEAD ^origin/main`. A revision may not start with `-`. |
| `--markers <file>` | Required. The markers file, below. Relative to the current directory. |
| `--repo <dir>` | A directory inside the repository. Default: the current directory. Inherited `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` are ignored. |
| `--allow-file <path>` | Skip hits in this path. Repeatable, and one flag may be followed by several paths. Also `--allow-file=<path>`. |
| `--help` | Print usage. |

After local installation with `npm install --global .` the command is `added-lines-scan`.
Quote arguments that contain spaces. Git is run directly, without a shell.

## Markers file

One regular expression per line, matched against each added line (without its line ending):

```text
# credentials
\bAKIA[0-9A-Z]{16}\b
-----BEGIN [A-Z ]*PRIVATE KEY-----

# names and places that must not appear in this repository
/acme-internal/i
\bproject-codename\b
\/srv\/private\/
```

- A blank line is ignored. A line whose first non-blank character is `#` is a comment;
  write `\#` to match a literal `#`.
- A line is a JavaScript regular expression, **case-sensitive**.
- `/pattern/i` makes it case-insensitive. `/pattern/` with no flag is the same as
  `pattern`. `i` is the only flag.
- A line that starts with `/` and ends in `/` plus lowercase letters reads as
  `/pattern/flags`. So `/home/alice` is an error ("only i is supported"), not a silent
  mismatch: escape the first slash, `\/home\/alice`, or wrap it, `/\/home\/alice/`.
- Leading and trailing whitespace is trimmed; use `\s` or `\x20` for a space that counts.
- An invalid expression, or a file with no markers at all, exits 2 and names the file and
  line. A scan that could never match is not reported as clean.

The markers file may itself name what must stay private. Keep it outside the repository,
or under `.git/`, so that it does not publish what it forbids.

## Output and exit codes

One line per hit on stdout: `<short sha> <file>:<line in the new file> <marker> (<trimmed text>)`.
The marker is the line from the markers file, the text is trimmed and cut at 120
characters, and control characters in paths and text are shown as `\xNN`, so a file
name cannot forge a report line. Hits come oldest commit first.

```text
3f9c2ab notes/deploy.md:14 /acme-internal/i (see the acme-internal wiki for the keys)
```

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | No added line matches. | stdout: `added-lines-scan: clean: 3 commits in origin/main..HEAD scanned against 2 markers`. An empty range says `has 0 commits, nothing to scan`. |
| 1 | At least one hit. | The hit lines on stdout, a count on stderr. |
| 2 | Usage error, an unreadable markers file, or a range that could not be scanned: an unknown revision, a directory that is not a repository, a repository with no commit, Git failing midway. | A message on stderr. **Never** a clean summary. |

Binary files are skipped with a note on stderr
(`added-lines-scan: note: skipped binary file "logo.png" in 3f9c2ab`). Hits skipped by
`--allow-file` are counted in the clean summary
(`; 2 matching lines in allowed files skipped`).

## What is scanned

For each commit in the range, the lines it adds relative to its parent, read from Git's own
patch with no context lines:

- **Line numbers** are those of the file after the commit. Deleted lines are never
  scanned, and deleting a line does not shift the numbering of the lines added after it.
- **Renames** are detected (`-M`). A rename that keeps the content adds nothing; a rename
  with an edit reports only the edited lines, under the new name.
- **The root commit** adds its whole tree.
- **A merge commit** is scanned for what the merge itself adds: the lines of the result that
  none of its parents has, such as a conflict resolution. Lines that came in from a merged
  branch are reported against the commit on that branch that added them, when that commit is
  in the range, and are not reported a second time against the merge.
- **CRLF files:** the carriage return is not part of the line, so `secret$` matches a
  CRLF line.
- **Paths** with spaces, non-ASCII letters, quotes or newlines are read exactly as Git
  stores them. The Git configuration (`core.quotepath`, `diff.noprefix`,
  `diff.renames`, `log.showSignature`, external diff and text conversion drivers) does not
  change what is scanned.
- **`--allow-file`** takes a repository path as printed in the report (forward slashes,
  from the repository root; `./` and backslashes are accepted) and skips hits in exactly that
  path. `docs/a.txt` does not allow `a.txt`, and there are no directories or globs.

## Pre-push hook

Save this as `.git/hooks/pre-push`, make it executable, and replace the two placeholder
paths. It scans exactly what the push would publish: an existing branch is scanned from the
commit the remote has; a new branch is scanned from everything no remote-tracking branch of
that remote has yet.

```sh
#!/bin/sh
# pre-push hook: scan every commit this push would publish.
remote="$1"
zero=0000000000000000000000000000000000000000
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  # Deleting a remote branch publishes no commit.
  [ "$local_sha" = "$zero" ] && continue
  if [ "$remote_sha" = "$zero" ]; then
    # A new branch: everything that no remote-tracking branch of this remote has.
    range="$local_sha $(git for-each-ref --format='^%(objectname)' "refs/remotes/$remote/")"
  else
    range="$remote_sha..$local_sha"
  fi
  node /path/to/agent-dev-tools/added-lines-scan/bin/added-lines-scan.mjs \
    --range "$range" --markers /path/to/markers.txt || status=1
done
exit $status
```

The hook's output is shown in the output of `git push`. Exit 1 (a hit) and exit 2 (could
not scan) both stop the push: a remote commit that the local clone does not have makes the
range unreadable, and the push is refused rather than waved through. On Windows the hook
runs under Git for Windows' `sh`; write the paths with forward slashes.

A hook is local, and `git push --no-verify` skips it. To enforce the rule, run the same
command in CI, with the full history fetched (`fetch-depth: 0` in GitHub Actions):

```sh
node added-lines-scan/bin/added-lines-scan.mjs --range origin/main..HEAD --markers markers.txt
```

## Library

```js
import { scanRange, parseMarkers, formatHit } from './lib/index.mjs';

const markers = parseMarkers(text, 'markers.txt'); // [{ source, regex }]; throws on a bad line
const { commits, hits, notes, allowed } = await scanRange({
  repo: '/path/to/repo',
  range: 'origin/main..HEAD',
  markers,
  allowFiles: ['docs/example.md'],
});
for (const hit of hits) console.log(formatHit(hit)); // hit: { sha, short, path, line, marker, text }
```

`scanRange` rejects when the range cannot be read or Git fails, rather than resolving to an
empty result. `notes` lists skipped binary files (`{ short, path }`); `allowed` counts
matching lines skipped by `allowFiles`.

## Limits

- It matches regular expressions against added lines, one line at a time. It finds what
  the markers say and nothing else: not a secret that is encoded, split across two lines,
  or spelled in a way no marker covers. It is not an entropy-based secret scanner.
- Only the **content of added lines** is scanned. Commit messages, author names and
  addresses, file names, branch and tag names are not. Check a commit message range
  separately, for example `git log --format=%B origin/main..HEAD`.
- Files that Git treats as binary are skipped, with a note. That includes files with NUL
  bytes and paths that `.gitattributes` marks `binary` or `-diff`. Text conversion filters
  are not run.
- A rename that Git does not detect (under 50 % similar, or more files than
  `diff.renameLimit` allows) shows as a deletion and an addition, and the whole file is
  scanned as added. That can add reports; it cannot hide one.
- In a shallow clone, the oldest fetched commits look like root commits and report their
  whole tree. Fetch the full history first.
- A submodule pointer change shows as a `Subproject commit <sha>` line; the submodule's own
  history is not scanned.
- Memory is proportional to the number of hits, and for a merge to the lines the merge adds
  relative to one parent. The patch itself is streamed, not held.
- Expressions are run as written. A pattern with catastrophic backtracking will be slow.

## Tests

From this folder:

```sh
npm test
# or, with no npm involved:
node --test test/added-lines-scan.test.mjs
```

Tests use only Node built-ins and build temporary Git repositories under the operating
system's temporary directory, with an empty Git configuration, and remove them afterwards.
They cover a leak that a later commit removes, a clean and an empty range, renames, merges
(branch lines versus the merge's own additions), deleted lines, CRLF, a file without a final
newline, added lines that look like patch headers, paths with spaces and non-ASCII letters,
binary files, `--allow-file`, bad ranges and usage, the markers file, and the pre-push hook
of this README run by real `git push` commands against a bare repository. The POSIX-only
test for file names with quotes and newlines is skipped on Windows.
