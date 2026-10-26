# tests-ran

A zero-dependency Node CLI and library that requires evidence of executed tests.
MIT licensed. Requires Node 22 or later.

An empty glob, a renamed test directory, an unmatched filter, or a runner's
“pass with no tests” option can produce a successful command with zero tests.
For example, Node's test runner can print `tests 0` and still exit successfully.
A green exit code alone does not establish that anything was tested.

`tests-ran` runs your command, passes its stdout and stderr through without
rewriting them, and counts executed tests in its machine report. Skipped,
pending, todo, disabled, and cancelled tests do not satisfy the minimum.

## CLI

```text
tests-ran [--min N] --format tap|json|junit [--report file] -- <command...>
```

The minimum defaults to **1** and must be a positive safe integer. Without
`--report`, the report is read from stdout. With `--report`, it is read from
that file after the command closes; ordinary output can use both streams.
Relative report paths resolve against the command's current directory.
An existing report must be rewritten by this run; an unchanged file is rejected.
The tool never deletes your report.

| Condition | Exit code |
| --- | --- |
| Enough executed tests and normal command completion | Command's own code |
| Too few executed tests; missing, stale, or invalid report | 3 |
| Command fails to start, is cancelled, or termination is detected | 3 |
| Invalid CLI arguments | 2 |

Exit 3 also writes a human-readable `tests-ran: not run: ...` reason to stderr.
A failing test command is still failing, even when enough tests executed.
The child's own exit code can also be 3; the additional diagnostic identifies
the wrapper's “not run” verdict. `--help` prints usage without running a command.

From a checkout, replace `tests-ran` below with `node bin/tests-ran.mjs`.
After local installation with `npm install --global .`, the executable is
available as `tests-ran`. No runtime or development dependencies are needed.

### Node TAP

Select TAP explicitly: the default reporter depends on how Node is invoked.

```sh
tests-ran --min 1 --format tap -- node --test --test-reporter=tap test/example.test.mjs
```

The reader uses Node's unindented summary counts, not `ok` lines or plans.
Nested subtests and LF/CRLF reports are supported. Executed means `pass + fail`;
all six summary counts must be present and consistent.
[Node test reporters](https://nodejs.org/docs/latest-v24.x/api/test.html#test-reporters).

### Vitest JSON

```sh
tests-ran --format json --report results.json -- node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=results.json
```

### Jest JSON

```sh
tests-ran --format json --report results.json -- node node_modules/jest/bin/jest.js --runInBand --json --outputFile=results.json
```

JSON readers use `numPassedTests + numFailedTests` and validate the total against
pending and todo counts. Older reports may omit `numTodoTests`. If assertion
details are present, their counts must agree. Interrupted and collection-only
reports are rejected. A failed suite with no executed assertions counts as zero.
Use a report file when runner logs would otherwise mix with JSON on stdout.
[Vitest reporters](https://vitest.dev/guide/reporters.html#json-reporter) and
[Jest JSON output](https://jestjs.io/docs/cli#--outputfilefilename).

### JUnit XML

```sh
tests-ran --format junit --report results.xml -- node --test --test-reporter=junit --test-reporter-destination=results.xml test/example.test.mjs
```

Any runner producing the supported JUnit subset can be used. Both `<testsuite>`
and `<testsuites>` roots and nested suites are accepted. Actual `<testcase>`
elements count once, excluding `<skipped>` and non-running `status` values;
failures and errors count as executed. Todo should be encoded as `<skipped>`.
Ancestor totals are never added to descendant counts. A suite with no case
details can instead supply `tests`, with optional `skipped` and `disabled`
counts, which are subtracted. Comments, CDATA, and escaped log text are ignored.

## Library

```js
import { countTests, runTests, NOT_RUN } from 'tests-ran';

const executed = countTests(reportText, 'junit'); // number; throws on bad input
const result = await runTests({
  command: [process.execPath, '--test', '--test-reporter=tap', 'test/example.test.mjs'],
  format: 'tap',
  min: 1,
});
process.exitCode = result.exitCode;
```

`runTests` also accepts `report`, `cwd`, `env`, writable `stdout`/`stderr`, and an
AbortSignal as `signal`. Streams default to the current process's streams and
remain open. Stdin is inherited. The result has `exitCode`, `executed` (null if
unknown), `reason` (null for normal completion), `commandCode`, and `signal`.
Invalid library options throw; run/report failures return `NOT_RUN` (3).
Aborting terminates the direct child and produces the same verdict on Windows
and Unix, including when a complete report was already printed.

## Portability and limits

- Commands are executable argument arrays, with no implicit shell. Arguments
  containing spaces, quotes, or shell metacharacters are passed literally.
  The examples invoke runner JavaScript through Node, avoiding platform-specific
  npm launchers. To run a Windows `.cmd`/`.bat` script, invoke `cmd.exe /d /s /c`
  explicitly and apply that shell's quoting rules; Unix shell syntax likewise
  requires an explicit shell. [Node child processes](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
- Termination reported by Node as a signal, wrapper cancellation, or a Windows
  abnormal status produces exit 3. Windows can also terminate a process with an
  arbitrary ordinary exit code; after a complete report, Node cannot distinguish
  that from a natural exit with the same code. That code is preserved. An absent
  or incomplete report still produces 3. Killing the wrapper itself forcibly
  prevents it from issuing any verdict. Descendant process trees are not managed.
- This checks the runner's evidence, not test quality or truthful instrumentation.
  Reports must belong to this run. File identity, size, and modification/change
  timestamps detect an unchanged old report, but cannot prove a rewritten report
  is truthful. Do not share one report file between concurrent runs.
- Only Node-style TAP summaries, Jest/Vitest aggregate JSON, and the documented
  JUnit subset are supported. This is not a general TAP or XML validator. XML is
  UTF-8; DTDs and custom entities are rejected, and nesting is limited to 256
  levels. Standard/numeric entities, CDATA, and comments are supported.
  Reports are limited to 64 MiB. Unsupported or inconsistent data fails closed.
- Run one finite command, without watch mode. Stdout is piped, so a runner may
  choose different formatting than when attached to a terminal. Bytes it emits
  are preserved per stream; ordering between stdout and stderr is not guaranteed.
- Under another `node:test` harness, remove its internal `NODE_TEST_CONTEXT`
  environment variable before launching a nested runner. Otherwise Node may emit
  its internal binary reporting protocol instead of the selected text reporter.

## Development

```sh
npm test
```

Tests use only Node built-ins, temporary local fixtures, and direct child
processes. They need no network or installed test runner. The repository's root
workflow runs them on Linux and Windows with Node 22 and 24.

`npm pack --dry-run --ignore-scripts` lists the publishable package contents.
The package includes only the CLI, library, README, license, and metadata.
