import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
export const message = 'Unhandled setup rejection: background work failed'

// Every run, report and copied package lives under one system-temp folder, never
// inside the package being tested. It is removed when the test process exits.
export const workspace = mkdtempSync(join(tmpdir(), 'vitest-loud-json-tests-'))
process.on('exit', () => {
  try { rmSync(workspace, { recursive: true, force: true }) } catch { /* Leave it for the OS temp cleaner. */ }
})

/** Create a fresh directory (the prefix may contain spaces) inside the temp workspace. */
export function scratch(prefix) {
  return mkdtempSync(join(workspace, prefix))
}

/** Sorted relative paths of everything in the package except installed dependencies. */
export function packageTree(dir = root, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return []
    const path = join(dir, entry.name)
    return [relative(base, path), ...(entry.isDirectory() ? packageTree(path, base) : [])]
  }).sort()
}

// Taken when the helpers load, i.e. before any test body has run.
export const treeBeforeTests = packageTree()

export function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NO_COLOR: '1', ...options.env }
    // Vitest is not a child of the Node test runner's serialization protocol.
    delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, args, {
      cwd: root, ...options, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status, signal) => {
      if (signal) reject(new Error(`Node terminated by ${signal}: ${stderr}`))
      else resolve({ status, stdout, stderr })
    })
  })
}

export async function runFixture(reporters = ['json'], extra = [], options = {}) {
  const dir = scratch('run with spaces-')
  const report = join(dir, 'results.json')
  const result = await runNode([
    vitest, 'run', '--config', join(root, 'fixture', options.config ?? 'vitest.config.mjs'),
    '--configLoader', 'runner', '--outputFile', report,
    ...reporters.flatMap(reporter => ['--reporter', reporter]), ...extra,
  ], {
    env: {
      LOUD_FIXTURE_CACHE: join(dir, 'cache'),
      LOUD_FIXTURE_REPORT: relative(join(root, 'fixture'), report),
      TMPDIR: dir, TMP: dir, TEMP: dir,
      ...options.env,
    },
  })
  return { ...result, report, dir, json: JSON.parse(readFileSync(report, 'utf8')) }
}
