# flaky-evidence

A failing check passes on rerun, and someone writes “load”. The original output,
machine state and versions have disappeared. A race or order dependence may be
hidden behind an explanation nobody measured.

This zero-dependency Node.js CLI and ESM library preserves the original failure,
samples resources before each attempt, and records the evidence behind its
classification. A successful rerun never silently clears the original exit code.
Requires Node.js 22 or newer. MIT licensed. This directory is a standalone package;
no files from elsewhere in the repository are needed.

**Resources are sampled before each attempt, not during it.** CPU, memory and
process-count readings are taken once, just before an attempt starts. They show how
busy the machine was when the attempt began; they say nothing about what happened
while the command ran. A spike in the middle of a run is invisible to this tool.
Every evidence file states this in its top-level `resourceSampling` field and in
`classification.basis`, so the limit travels with the data.

## Run from source

From this directory, on Linux or Windows:

```sh
node cli.mjs --times 3 -- node test/check.mjs
node cli.mjs --times 2 --output evidence.json -- node test/check.mjs
```

`test/check.mjs` represents your own check. `--times N` means **up to N additional
attempts after the first failure**, stopping at the first successful attempt.
The default is two retries. Zero means one attempt with no retries. An initial
pass is never rerun.

To use the executable name from a local package:

```sh
npm pack
npm install --global ./flaky-evidence-0.1.0.tgz
flaky-evidence --times 3 -- node test/check.mjs
```

This does not require a registry publication. The package contains only the
library, CLI, README, license and package metadata.

Arguments after `--` are passed literally as an argument vector. Paths and
arguments containing spaces stay intact; there is no implicit shell and no
automatic interpolation of metacharacters. Shell syntax requires an explicit
shell: for example, `-- sh -c 'node test/check.mjs'` on Linux or
`-- cmd.exe /d /s /c "node test/check.mjs"` on Windows. Windows `.cmd` and `.bat`
files (including many package-manager shims) need that explicit shell, or invoke
their JavaScript entry point with `node`. Shell quoting is then the caller's
responsibility. See [Node's child process documentation](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html).

## Classification

Only the **original attempt and first successful rerun** are compared. Intermediate
failures remain in the JSON but are never selected to make an explanation fit.

| Result | Meaning |
| --- | --- |
| `passed` | The first attempt exited zero; no retries. |
| `consistent-failure` | All requested attempts failed. With zero retries, only one failure was observed. |
| `pressure-suspected` | A failed first attempt passed on rerun, and at least one pressure rule below was met. The message and JSON include both readings, the difference and thresholds. |
| `unexplained` | A failed first attempt passed on rerun without sufficient measured pressure evidence: **“unexplained — possible race or order dependence, not pressure”**. Missing readings also lead here unless another available metric supports pressure. |

Default pressure rules require both a high-pressure starting point and recovery
**strictly beyond** a threshold:

* Memory: initial free memory is at most 10% of total, and free memory increases
  by more than 15% of that total. Total memory must match between attempts.
* CPU: initial busy share is at least 85%, and it decreases by more than 20
  percentage points. Comparisons tolerate floating point rounding at the boundary.
* Process counts are recorded for investigation; a count change alone is not a
  diagnosis of pressure.

For example, a failure at 52,428,800 free bytes followed by a pass at 524,288,000
free bytes on a 1,048,576,000-byte machine yields:

```text
pressure suspected (readings taken before each run, not during it): freeMemoryBytes 52428800 -> 524288000 bytes; difference 471859200 > 157286400; pressure threshold 104857600
```

The full numbers are also in `classification.reasons`. “Suspected” is deliberate:
a correlation is evidence for investigation, not proof that pressure caused the
failure. Stable readings do not rule out pressure at an unobserved time, and
“possible race or order dependence” does not prove either diagnosis.

## Exit codes and evidence

The default exit code is **the first attempt's code**, even if a rerun passes.
`--fail-on-unexplained` explicitly normalizes an unexplained result to exit **1**;
the actual first code remains in `firstExitCode` and `runs[0].exitCode`. The default
already fails on such results; this option supplies a consistent policy code.
It does not turn pressure-suspected results into successes.

Each valid invocation writes one JSON file in the working directory, named
`flaky-evidence-<timestamp>-<random-id>.json`, or the path supplied by `--output`.
The destination must not already exist: old evidence is never overwritten.
It is reserved before running the command; invalid options create no file.
Every completed attempt is saved **before** the next resource sample or command.
Updates use a flushed temporary file and same-directory rename, leaving one JSON
file at completion. Different invocations have independent files.

The JSON includes the command argument vector, working directory, timestamps,
configured thresholds, requested retry count, `resourceSampling` (when the
readings were taken), classification and **every run**:

* Exit code, signal, spawn error (if any), and command duration in milliseconds.
* Last 20 lines of stdout and stderr, capped at 64 KiB per stream, plus a
  truncation flag. CRLF is normalized to LF. Streams are kept separate.
* Free and total memory in bytes, CPU busy share from 0 to 1, actual CPU sample
  duration, best-effort process count, sample timestamp and collection errors.
* Collector Node version and OS platform, type, release, version and architecture.

CPU sampling compares aggregate `os.cpus().times` counters around a one-second
wait **before each command**; it does not use `os.loadavg()`. This works with Windows
CPU counters, where load averages are unavailable. See [Node's OS documentation](https://nodejs.org/download/release/v22.18.0/docs/api/os.html).
Memory is read after that sample. Process counting uses `tasklist.exe /FO CSV /NH`
on Windows and `ps -e -o pid=` elsewhere, with a two-second timeout and bounded
output. Missing tools, permissions or invalid counters produce `null` readings,
never fabricated zeros. Command duration excludes the sampling overhead.

Command-not-found is recorded as exit 127; other spawn errors as 126. Signal
termination is recorded as `128 + signal number` (129 if the signal number is
unknown), with the signal name retained. Usage or evidence-writing errors exit
2, unless a prior nonzero first exit code is already known. Storage errors are
printed to stderr and stop further attempts. A partial file has `status: running`.

## Library

```js
import { runWithEvidence } from './index.mjs';

const { evidencePath, evidence, exitCode } = await runWithEvidence(
  [process.execPath, 'test/check.mjs'],
  {
    times: 2,
    evidencePath: 'evidence.json', // Optional; must not exist.
    cwd: process.cwd(),
    failOnUnexplained: true,
    tailLines: 20,
    tailBytes: 65536,
    thresholds: {
      memoryLowRatio: 0.10,
      memoryRecoveryRatio: 0.15,
      cpuHighShare: 0.85,
      cpuRecoveryShare: 0.20,
    },
  },
);
console.log(evidence.classification.message, evidencePath);
process.exitCode = exitCode;
```

The optional third argument accepts `sample` and `execute` functions. `sample()`
returns a resource object with `freeMemoryBytes`, `totalMemoryBytes`,
`cpuBusyShare`, `cpuSampleMs`, `processCount` and optional `errors`/`sampledAt`.
`execute(command, options)` returns an object with `exitCode`, `durationMs`,
`stdoutTail`, `stderrTail` and optional `signal`, `spawnError`, `outputTruncated`.
Both may be async; adapters must return finite measurements and obey output caps.

For finer injection, `sampleResources({ cpus, freemem, totalmem, countProcesses,
sleep, clock })` accepts replacements for individual probes. `cpuBusyShare(before,
after)` accepts CPU counter arrays. `countProcesses({ platform, exec })` accepts a
platform name and a promise-based `execFile` replacement returning `{ stdout }`.
`DEFAULT_THRESHOLDS` and the real `executeCommand` are also exported.

## Tests

No test downloads dependencies, contacts a network service, or requires Git or a
shell. Tests use Node commands, temporary paths with spaces, injected readings,
Windows-style CPU snapshots and CRLF process listings.

```sh
npm test
node --test test/flaky-evidence.test.mjs
```

The first command also runs additional boundary regressions. Run these commands
on both Windows and Linux when releasing. The OS temporary directory must be
writable, and the environment must permit child processes with piped output.

## Limits

* Each attempt waits at least one second for a CPU sample, taken **before** the
  command starts. It is a preflight observation, not monitoring during the run:
  pressure that begins or ends while the command is running is not seen, and
  sampling itself may change a timing-sensitive reproduction.
* Memory and CPU reflect the host view exposed by Node; container quotas and
  per-process resource usage are not inferred. Process counts may include the
  counting process and can change while being collected.
* Node version describes the collector, not every executable or dependency in
  the command. Add application-specific version output to your check when needed.
* Output is retained as bounded UTF-8 tails, not a full log; stdout/stderr ordering
  is not reconstructed. No live child output is streamed to the terminal.
* Commands must be finite and noninteractive. Stdin is closed, there is no command
  timeout or process-tree supervision, and retries repeat real side effects in
  the same directory and inherited environment. Use checks safe to repeat.
* Abrupt termination can leave a running record or temporary file. Completed
  attempts already saved remain available; an interrupted attempt may be absent.
  There is no guarantee against disk failure or power loss.
* Evidence includes arguments, paths and output, which may contain secrets.
  Review it before sharing; no data is uploaded or automatically redacted.
