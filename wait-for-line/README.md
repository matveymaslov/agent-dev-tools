# wait-for-line

A zero-dependency Node.js CLI and library that waits for a **new, complete log
line after arming**. MIT licensed. Requires Node.js 22 or newer.

## The problem

A watcher records a log's line count, then writes `armed: waiting for DONE` into
that same log. Its pattern is `DONE`. The watcher immediately matches its own
message and stops a job that has barely begun.

Other common failures: matching yesterday's result, losing a line written in
two parts, assuming LF on Windows, or staying attached to a renamed log.

This tool opens the file read-only, records its **byte offset** at arming, and
polls for complete new lines. It never appends status messages to the log.
Diagnostics go to stderr without quoting the pattern. The matched line alone
goes to stdout. Unanchored patterns produce a warning.

## CLI

Run directly from this folder; no installation or build is required:

```sh
node ./bin/wait-for-line.mjs --file "worker.log" --pattern "^DONE$" --timeout 2h --interval 1s
```

The package exposes the same command as `wait-for-line` when installed. The
double-quoted examples work in POSIX shells, PowerShell and Windows cmd.exe.
Quote paths containing spaces. For more complex patterns, use your shell's
literal quoting rules; the regex itself is JavaScript syntax without `/.../`
delimiters. To express alternatives, prefer `^(DONE|FINISHED)$`.

Check for accidental existing matches **before** starting the wait:

```sh
node ./bin/wait-for-line.mjs --file "worker.log" --pattern "DONE" --dry-run
```

Example preview:

```text
12: DONE
19: armed: waiting for DONE
```

Dry-run prints every matching existing line with a one-based line number,
including an unterminated final line. It does not arm or change the file. A
preview with no matches exits successfully and says so on stderr. Run the normal
command separately to arm; lines written between preview and arming are history.

| Option | Default | Meaning |
| --- | --- | --- |
| `--file <path>` | required | Regular UTF-8 log file |
| `--pattern <regex>` | required | JavaScript regex source, tested per line |
| `--timeout <duration>` | unlimited | Overall wait deadline, including initial access |
| `--interval <duration>` | `1s` | Time between polls |
| `--grace <duration>` | `5s` | How long a file that was already seen may stay missing before exit 3. A file that does not exist yet is awaited until `--timeout` |
| `--dry-run` | off | Preview existing matching lines and exit |
| `--help` | | Show usage |

Durations are positive values with `ms`, `s`, `m`, `h` or `d`, for example `250ms`,
`1.5s` or `2h`; they must resolve to whole, safe integer milliseconds. Poll sleeps
are shortened to respect the timeout and missing-file deadline.

Wait until stderr says `Armed at byte ...` before starting a producer if you
need a precise handoff. The library's `armed` event is easier to coordinate with.
Never redirect either output back to the watched log: the CLI refuses direct
redirection to the same file (including hard links). A shell using `>` can
truncate a file before the CLI starts; no program can undo that. An indirect
pipeline such as `tee`, or a concurrently retargeted link, cannot be guarded
atomically. Use a different diagnostics file.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | A fresh complete line matched; also successful dry-run or help |
| `1` | Invalid arguments/regex, permission or other I/O error, unsafe output redirection |
| `2` | Timeout expired without a match |
| `3` | A file that had been seen stayed missing for the grace period |

Only code `0` in normal waiting mode prints a matched line. Errors and status
messages go to stderr. Dry-run is a separate preview, so a missing file there
is an immediate I/O error (`1`); transient busy access is retried for at most
the smaller of `--timeout` and `--grace`, then exits `2`.

## Library

```js
import { waitForLine, dryRun, WaitForLineError } from './index.mjs';

try {
  const line = await waitForLine({
    file: 'worker.log',
    pattern: /^DONE$/,
    timeout: 2 * 60 * 60 * 1000,
    interval: 1000,
    grace: 5000,
    onEvent(event) {
      console.error(event.message);
      if (event.type === 'armed') {
        // Start the producer here. event.offset is the captured byte boundary.
      }
    },
    // signal: controller.signal,
  });
  console.log(line);
} catch (error) {
  if (error instanceof WaitForLineError) console.error(error.exitCode, error.message);
  else throw error;
}

for await (const { lineNumber, line } of dryRun({ file: 'worker.log', pattern: /DONE/ })) {
  console.log(`${lineNumber}: ${line}`);
}
```

`waitForLine(options)` resolves to the matched string without LF/CRLF. Options
mirror the CLI; library durations are positive integer milliseconds, and omitted
`timeout` means `Infinity`. A pattern may be a string or `RegExp`; the regex is
cloned and its state is reset for every line, leaving the caller's regex intact.

`WaitForLineError` has `code: 'TIMEOUT'`, `exitCode: 2`, or `code: 'FILE_GONE'`,
`exitCode: 3` (only for a file that was seen and then stayed missing). Other
errors, including permission errors, propagate. An
`AbortSignal` cancels polling and its sleeps. `onEvent` is synchronous (its return
value is not awaited); by default it prints human-readable messages to stderr.
Events have `{ type, message }` and `armed` additionally has `offset`. Types are
`warning`, `armed`, `replaced`, `truncated`, `missing`, `returned`, `busy`, and
`readable`. The library does not set a process exit code.

## File and line semantics

- Arming uses the first successful open/stat/boundary read. All bytes before
  that offset are history. If the file first appears after the watcher started,
  whatever it already holds at that first poll is history too, so create the log
  (for example as an empty file) before starting the watcher if its earliest
  lines matter.
- Only lines that start **after** that boundary can match. If the old file ends
  with a partial line, its eventual suffix is discarded through the next LF.
  A new partial line is buffered until LF arrives, even across several polls.
- LF and CRLF are accepted. The CR in CRLF is removed before matching and output;
  other whitespace is preserved. UTF-8 characters may span writes or read chunks.
- Every poll reopens the path and compares device/inode identity. Replacement
  starts reading at byte zero; a smaller file also starts at zero. In either
  case buffered fragments are discarded and a message explains the change.
- A 64-byte boundary check also detects many truncate-and-regrow or overwrite
  cases where the new size has already exceeded the old offset.
- A path that has **never existed** (missing at startup) is awaited until
  `--timeout`; the grace period does not apply, because nothing has disappeared
  yet. Without `--timeout` that wait is unlimited. A path that was seen and then
  went missing is retried through grace; a returning file resets the absence
  timer. If both deadlines expire, the earlier one wins (the grace deadline wins
  a tie).
- Reads use Node's ordinary shared-access open on Windows. `EBUSY`, `EAGAIN`,
  `EINTR`, and `ETXTBSY` are retried without advancing the failed read's offset.
  An exclusive writer cannot be forced to share; use a timeout to bound the wait.
  Permission errors fail visibly instead of being reported as disappearance.

The implementation uses polling, never `fs.watch`, and has no shell or `tail`
dependency. Node's Windows I/O uses libuv's shared read/write/delete access for a
normal open; see the [libuv Windows implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c).

## Limits

Polling is not a transaction or an audit log. Data written and removed between
polls can be missed. Writes to the old file after rotation are not drained;
following continues at the named path. A rewrite that preserves file identity,
size and the sampled boundary bytes is indistinguishable from ordinary append
activity. Choose a smaller interval or a producer protocol with sequence numbers
if these distinctions matter. Network filesystems may delay visibility or expose
unreliable file identities.

Only regular, UTF-8 text files are supported; not named pipes or UTF-16 logs.
Reads use 64 KiB chunks. Memory grows with the longest unfinished line; there is
no line-length limit. Invalid UTF-8 is decoded with replacement characters.
Patterns are trusted JavaScript regexes: expensive backtracking and blocked
filesystem calls cannot be interrupted by a polling deadline. Anchor warnings
are conservative advice, not proof that a pattern is safe. Dry-run reads up to
the size first observed, but a concurrent rewrite can change its preview.

## Test and package

From this folder, on Windows or Linux:

```sh
npm test
npm pack --dry-run
```

Tests use temporary files, real child processes and injected transient I/O errors.
They need no network, shell utilities, dependency installation or running service.
They cover old lines, partial writes, CRLF, UTF-8, replacement, truncation, busy
readers, deadlines, disappearance, dry-run and output redirection. The package
contains only the library, executable, README and MIT license.
