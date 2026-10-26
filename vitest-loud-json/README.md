# vitest-loud-json

Vitest's JSON-only reporter can produce `success: true` and
`numFailedTests: 0` while the process exits 1 because of an unhandled rejection
outside a test. The error itself is absent from the terminal and JSON report.
This tiny companion prints errors and failure reasons in one stderr block and
writes `results.json.errors.json` beside `results.json`. No runtime dependencies.

Tested with **Vitest 4.1.10**, pinned in `devDependencies`; Node 20.19+ or 22.12+.
Use `vitest run`. Watch mode is intentionally rejected.

## Use

From a checkout of this folder: `npm install`, `npm test`, then `npm pack`.
Install the resulting tarball as a dev dependency in your test project,
alongside `vitest@4.1.10`. The package name below is `vitest-loud-json`.

```js
// vitest.config.mjs
export default {
  test: {
    reporters: ['json', 'vitest-loud-json'],
    outputFile: { json: 'results.json' },
  },
}
```

Equivalent CLI (after installing both packages):

```sh
node node_modules/vitest/vitest.mjs run --reporter=json --reporter=vitest-loud-json --outputFile=results.json
```

An explicit JSON output file is required. The reporter also supports
`['json', { outputFile: 'results.json' }]`; that option wins over `test.outputFile`.
Relative paths resolve from Vitest's `root`. Diagnostics use stderr, leaving
JSON report contents unchanged. Clean runs have an empty error list and no block.

## Refuse a false green

Run this **immediately after Vitest**, using its real process exit status:

```sh
# Bash / sh
node node_modules/vitest-loud-json/check.mjs results.json "$?"
```

```powershell
# PowerShell
node node_modules/vitest-loud-json/check.mjs results.json $LASTEXITCODE
```

```bat
:: Windows cmd.exe
node node_modules/vitest-loud-json/check.mjs results.json %ERRORLEVEL%
```

The installed npm bin is also `vitest-loud-json-check <report> <actual-exit-code>`.
It exits 1 for a mismatch in either direction, any non-zero exit, unsuccessful
reports, missing files, invalid JSON or malformed arguments. For programmatic
use, `checkReport(path, childExitCode)` from `vitest-loud-json/check` returns the
report or throws. Pass `null` for signal termination; it is rejected.

## Sidecar and limits

The version-1 sidecar contains `unhandledErrors` (name/message/type/stack/code/cause
when supplied), `moduleErrors`, `writeErrors`, failed-test/file counts, `runReason`,
`reasons`, `exitCodeAtRunEnd` and `exitCode`. Non-string error values are inspected
as text, so circular values and bigint cannot break JSON serialization.

`exitCode` is the status **observed by this reporter's synchronous process exit
listener**. Coverage or teardown can change it after the test-end callback;
when Vitest supplies no cause, the block says so. A later exit listener can still
change the final status. Always give the check the actual child process status,
not the sidecar's snapshot. A sidecar write failure fails the process loudly.

No reporter can observe errors Vitest filters with `onUnhandledError`, guarantee
output after a hard kill, or run before it has loaded. Startup crashes may leave
no report, or an incomplete sidecar (`exitCode: null`). Disabling unhandled-error
failure with `dangerouslyIgnoreUnhandledErrors` remains your Vitest policy.
The guard does not prove report freshness: remove old reports before a run.
Only single-run CLI use and Vitest 4.1.10 are verified; no watch, repeated API
runs, or Vitest 5 support is claimed.

## Reproduce and test

```sh
npm install
npm test
```

`npm test` runs `node --test index.js`. The suite runs real Vitest subprocesses:
first JSON-only, then the companion. It checks setup and after-test rejections,
clean runs, failed assertions, collection failures, late exit codes, CLI links
and write failures. It uses Node paths and processes, including paths with
spaces and CRLF input; no shell or git assumptions.

The tests write nothing inside the package. All run output goes to one folder
under the system temp directory, removed when the test process exits, and the
last test fails if the package's file list changed during the run. The CLI-link
test links a temporary *copy* of the package, never the package folder itself.
The repository's root workflow runs the suite on Windows and Linux with Node 22
and 24 (`engines` also allows Node 20.19+, which is not in that matrix).

API references: [custom reporters](https://vitest.dev/advanced/reporters.html)
and [reporter configuration](https://vitest.dev/guide/reporters.html).
The checked-in fixture pins the version; current online docs may describe newer
Vitest releases. MIT licensed.
