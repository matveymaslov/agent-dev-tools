# agent-dev-tools

Small, dependency-light tools for people who run coding agents. Each one starts from
a specific failure mode that is described at the top of its own README: a shell that
eats backslashes, a green exit code with zero tests run, a hook installed twice, a log
watcher that matches its own message. Every tool is a separate folder with its own
README, tests and `package.json`. They share no code, and only `vitest-loud-json` has
a dependency (Vitest).

| Tool | What it does | Status |
| --- | --- | --- |
| [agent-rules-gen](agent-rules-gen) | Generates `AGENTS.md` and `CLAUDE.md` from one Markdown rules source and checks them for drift. | 0.1.0 · 47 tests pass |
| [bash-path-guard](bash-path-guard) | Claude Code hook that blocks Bash commands whose unquoted Windows paths would lose their backslashes; also lints config files for paths already damaged that way. | 0.1.0 · 35 tests pass |
| [flaky-evidence](flaky-evidence) | Reruns a failing command, keeps the first failure's output, and records resource readings taken before each attempt to say whether machine pressure could explain a later pass. | 0.1.0 · 27 tests pass |
| [hook-entry-by-shape](hook-entry-by-shape) | Installs a Claude Code hook exactly once by matching its event, matcher, program and script path instead of a marker key; keeps a separate backup per write. | 0.1.0 · 28 tests pass, 2 skipped on Windows |
| [hookify-encoding-lint](hookify-encoding-lint) | Lints hookify rule files for non-ASCII text that breaks loading under a non-UTF-8 default encoding, and conservatively rewrites regex patterns to ASCII escapes. | 0.1.0 · 31 tests pass |
| [memory-index-lint](memory-index-lint) | Checks a Markdown memory index (`MEMORY.md`) against a line and byte budget and archives the overflow. | 0.1.0 · 39 tests pass |
| [prompt-covers-schema](prompt-covers-schema) | Lists the JSON Schema literals (enum members, constants, required names) that the instructions given to a model never mention. | 0.1.0 · 24 tests pass |
| [proof-currency](proof-currency) | Checks whether a recorded proof commit still describes the code it covers: current, stale, not on this history, or unknown. | 0.1.0 · 24 tests pass, 1 skipped on Windows |
| [tests-ran](tests-ran) | Runs a test command and fails it unless the machine-readable report shows tests that actually ran. | 0.1.0 · 48 tests pass, 1 skipped on Windows |
| [vitest-loud-json](vitest-loud-json) | Reporter and check that surface unhandled Vitest errors the JSON reporter hides, and refuse a report that disagrees with the process exit code. | 0.1.0 · 14 tests pass |
| [wait-for-line](wait-for-line) | Waits for a new complete log line after arming at a byte offset, with polling and rotation handling. | 0.1.0 · 31 tests pass |

"Status" is the tool's version and the result of its own test suite when this
repository was assembled: Windows 11, Node.js 24.14, the suites run with
`node --test` exactly as each `npm test` script does. Skipped tests are POSIX-only
cases that are skipped on Windows and run on Linux. None of the tools is published to
npm yet. The Linux and Node.js 22 legs of the CI matrix below had not been run when
this was written.

## Using a tool

Run a tool from a checkout, with no install step (except `vitest-loud-json`, which needs
`npm install` for Vitest). Each README shows the exact commands. For example:

```sh
node wait-for-line/bin/wait-for-line.mjs --file run.log --pattern '^DONE$' --timeout 2h
```

Most tools need Node.js 22 or newer; `hookify-encoding-lint`, `prompt-covers-schema`
and `vitest-loud-json` declare older minimums in their `package.json` (not covered by
the CI matrix), and `proof-currency` also needs Git 2.43 or newer.

## Tests

Each tool's tests use only Node's built-in test runner (plus Vitest for
`vitest-loud-json`):

```sh
cd wait-for-line
npm test
```

`.github/workflows/test.yml` runs every tool's tests on `ubuntu-latest` and
`windows-latest` with Node.js 22 and 24.

## License

MIT. See [LICENSE](LICENSE).
