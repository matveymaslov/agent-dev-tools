import * as os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

export const DEFAULT_THRESHOLDS = Object.freeze({
  memoryLowRatio: 0.10, memoryRecoveryRatio: 0.15,
  cpuHighShare: 0.85, cpuRecoveryShare: 0.20,
});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const share = value => nonnegative(value) && value <= 1;
const message = error => error instanceof Error ? error.message : String(error);

export function cpuBusyShare(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || !before.length || before.length !== after.length) return null;
  let total = 0;
  let idle = 0;
  for (let i = 0; i < before.length; i++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const start = before[i]?.times?.[key];
      const end = after[i]?.times?.[key];
      if (!nonnegative(start) || !nonnegative(end) || end < start) return null;
      total += end - start;
      if (key === 'idle') idle += end - start;
    }
  }
  return total > 0 ? (total - idle) / total : null;
}

export async function countProcesses({ platform = process.platform, exec = promisify(execFile) } = {}) {
  try {
    const windows = platform === 'win32';
    const { stdout } = await exec(windows ? 'tasklist.exe' : 'ps',
      windows ? ['/FO', 'CSV', '/NH'] : ['-e', '-o', 'pid='],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 ** 2, windowsHide: true, shell: false });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const valid = windows ? /^"(?:[^"]|"")*","\d+",/ : /^\s*\d+\s*$/;
    return lines.length && lines.every(line => valid.test(line)) ? lines.length : null;
  } catch {
    return null;
  }
}

export async function sampleResources(dependencies = {}) {
  const d = { cpus: os.cpus, freemem: os.freemem, totalmem: os.totalmem,
    countProcesses, sleep, clock: () => performance.now(), ...dependencies };
  const errors = [];
  const safely = async (name, operation) => {
    try { return await operation(); }
    catch (error) { errors.push(`${name}: ${message(error)}`); return null; }
  };
  const start = d.clock();
  const before = await safely('CPU start', d.cpus);
  await d.sleep(1000);
  const after = await safely('CPU end', d.cpus);
  const cpuSampleMs = d.clock() - start;
  const freeMemoryBytes = await safely('free memory', d.freemem);
  const totalMemoryBytes = await safely('total memory', d.totalmem);
  const processCount = await safely('process count', d.countProcesses);
  return normalizeResources({ freeMemoryBytes, totalMemoryBytes, cpuBusyShare: cpuBusyShare(before, after),
    cpuSampleMs, processCount, sampledAt: new Date().toISOString(), errors });
}

function normalizeResources(value) {
  const v = value ?? {};
  const errors = Array.isArray(v.errors) ? [...v.errors] : [];
  const result = { sampledAt: v.sampledAt ?? new Date().toISOString(), errors };
  for (const [key, valid] of Object.entries({ freeMemoryBytes: nonnegative,
    totalMemoryBytes: x => finite(x) && x > 0, cpuBusyShare: share,
    cpuSampleMs: nonnegative, processCount: x => Number.isSafeInteger(x) && x >= 0 })) {
    result[key] = valid(v[key]) ? v[key] : null;
    if (result[key] === null) errors.push(`${key}: unavailable or invalid`);
  }
  if (result.freeMemoryBytes > result.totalMemoryBytes && result.totalMemoryBytes !== null) {
    result.freeMemoryBytes = null;
    errors.push('freeMemoryBytes: exceeds total memory');
  }
  return result;
}

function tailBuffer(maxLines, maxBytes) {
  let buffer = Buffer.alloc(0);
  let truncated = false;
  return {
    append(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBytes) {
        buffer = buffer.subarray(buffer.length - maxBytes);
        // A byte cap may split a UTF-8 code point. Drop its continuation bytes.
        while (buffer.length && (buffer[0] & 0xc0) === 0x80) buffer = buffer.subarray(1);
        truncated = true;
      }
    },
    finish() {
      const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
      const lines = text.split('\n');
      const trailingNewline = lines.at(-1) === '';
      if (trailingNewline) lines.pop();
      if (lines.length > maxLines) truncated = true;
      return { text: lines.slice(-maxLines).join('\n') + (trailingNewline && text ? '\n' : ''), truncated };
    },
  };
}

export function executeCommand(command, { cwd, tailLines, tailBytes }) {
  return new Promise(resolveResult => {
    const start = performance.now();
    const out = tailBuffer(tailLines, tailBytes);
    const err = tailBuffer(tailLines, tailBytes);
    let spawnError = null;
    const finish = (code, signal) => {
      const stdout = out.finish();
      const stderr = err.finish();
      resolveResult({ exitCode: spawnError ? (spawnError.code === 'ENOENT' ? 127 : 126)
        : code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1),
      signal: signal ?? null, spawnError, durationMs: performance.now() - start,
      stdoutTail: stdout.text, stderrTail: stderr.text,
      outputTruncated: stdout.truncated || stderr.truncated });
    };
    let child;
    try {
      child = spawn(command[0], command.slice(1), { cwd, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      spawnError = { code: error.code ?? 'SPAWN_ERROR', message: message(error) };
      finish(null, null);
      return;
    }
    child.stdout.on('data', chunk => out.append(chunk));
    child.stderr.on('data', chunk => err.append(chunk));
    child.on('error', error => { spawnError = { code: error.code ?? 'SPAWN_ERROR', message: message(error) }; });
    child.on('close', finish);
  });
}

export const RESOURCE_SAMPLING_NOTE = 'Resources are sampled once, immediately before each attempt starts; '
  + 'they are not measured while the command runs.';

function classify(runs, thresholds) {
  const first = runs[0];
  if (first.exitCode === 0) return { kind: 'passed', message: 'passed on first run', reasons: [] };
  const passed = runs.find(run => run.exitCode === 0);
  if (!passed) return { kind: 'consistent-failure', message: 'consistent failure', reasons: [] };
  const a = first.resources;
  const b = passed.resources;
  const reasons = [];
  if (a.freeMemoryBytes !== null && b.freeMemoryBytes !== null && a.totalMemoryBytes !== null
    && a.totalMemoryBytes === b.totalMemoryBytes
    && a.freeMemoryBytes / a.totalMemoryBytes <= thresholds.memoryLowRatio
    && b.freeMemoryBytes - a.freeMemoryBytes > thresholds.memoryRecoveryRatio * a.totalMemoryBytes) {
    reasons.push({ metric: 'freeMemoryBytes', first: a.freeMemoryBytes, passed: b.freeMemoryBytes,
      difference: b.freeMemoryBytes - a.freeMemoryBytes,
      threshold: thresholds.memoryRecoveryRatio * a.totalMemoryBytes,
      pressureThreshold: thresholds.memoryLowRatio * a.totalMemoryBytes, unit: 'bytes' });
  }
  if (a.cpuBusyShare !== null && b.cpuBusyShare !== null
    && a.cpuBusyShare >= thresholds.cpuHighShare
    && a.cpuBusyShare - b.cpuBusyShare > thresholds.cpuRecoveryShare + 4 * Number.EPSILON) {
    reasons.push({ metric: 'cpuBusyShare', first: a.cpuBusyShare, passed: b.cpuBusyShare,
      difference: a.cpuBusyShare - b.cpuBusyShare, threshold: thresholds.cpuRecoveryShare,
      pressureThreshold: thresholds.cpuHighShare, unit: 'share' });
  }
  if (!reasons.length) return { kind: 'unexplained',
    message: 'unexplained — possible race or order dependence, not pressure', reasons,
    basis: RESOURCE_SAMPLING_NOTE };
  return { kind: 'pressure-suspected', firstRun: first.number, passedRun: passed.number, reasons,
    basis: RESOURCE_SAMPLING_NOTE,
    message: `pressure suspected (readings taken before each run, not during it): `
      + reasons.map(r => `${r.metric} ${r.first} -> ${r.passed} ${r.unit}; `
      + `difference ${r.difference} > ${r.threshold}; pressure threshold ${r.pressureThreshold}`).join('; ') };
}

function validate(command, options) {
  if (!Array.isArray(command) || !command.length || !command[0]
    || command.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('command must be a nonempty array of strings without NUL characters');
  }
  for (const [key, minimum] of [['times', 0], ['tailLines', 1], ['tailBytes', 1]]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < minimum) throw new TypeError(`${key} must be an integer >= ${minimum}`);
  }
  if (typeof options.failOnUnexplained !== 'boolean') throw new TypeError('failOnUnexplained must be boolean');
  for (const [key, value] of Object.entries(options.thresholds)) {
    if (!Object.hasOwn(DEFAULT_THRESHOLDS, key) || !share(value)) throw new TypeError(`invalid threshold: ${key}`);
  }
}

export async function runWithEvidence(command, options = {}, dependencies = {}) {
  const settings = { times: 2, cwd: process.cwd(), tailLines: 20, tailBytes: 65536,
    failOnUnexplained: false, ...options,
    thresholds: { ...DEFAULT_THRESHOLDS, ...options.thresholds } };
  validate(command, settings);
  const cwd = resolve(settings.cwd);
  const evidencePath = resolve(cwd, settings.evidencePath ?? `flaky-evidence-${Date.now()}-${randomUUID()}.json`);
  const evidence = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
    command: [...command], cwd, reruns: settings.times, thresholds: settings.thresholds,
    resourceSampling: { when: 'before-each-attempt', note: RESOURCE_SAMPLING_NOTE },
    failOnUnexplained: settings.failOnUnexplained, tailLines: settings.tailLines,
    tailBytes: settings.tailBytes, runs: [], firstExitCode: null, exitCode: null, classification: null };
  // Reserve the destination before any command, refusing to erase existing evidence.
  const initial = await open(evidencePath, 'wx', 0o600);
  try { await initial.writeFile(JSON.stringify(evidence, null, 2) + '\n'); }
  finally { await initial.close(); }
  const persist = async () => {
    const temporary = `${evidencePath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(evidence, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, evidencePath);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  };
  const sample = dependencies.sample ?? sampleResources;
  const execute = dependencies.execute ?? executeCommand;
  try {
    for (let i = 0; i <= settings.times; i++) {
      let resources;
      try { resources = normalizeResources(await sample()); }
      catch (error) { resources = normalizeResources({ errors: [message(error)] }); }
      const startedAt = new Date().toISOString();
      const start = performance.now();
      let run;
      try { run = await execute([...command], { ...settings, cwd }); }
      catch (error) {
        run = { exitCode: 126, spawnError: { code: error.code ?? 'EXECUTION_ERROR', message: message(error) },
          durationMs: performance.now() - start };
      }
      if (!Number.isInteger(run?.exitCode) || run.exitCode < 0) throw new TypeError('execute must return a nonnegative integer exitCode');
      evidence.runs.push({ stdoutTail: '', stderrTail: '', signal: null, spawnError: null,
        outputTruncated: false, ...run, number: i + 1, startedAt, resources,
        versions: { node: process.version, os: { platform: process.platform, type: os.type(),
          release: os.release(), version: os.version(), arch: os.arch() } } });
      evidence.firstExitCode = evidence.runs[0].exitCode;
      evidence.exitCode = evidence.firstExitCode;
      await persist();
      if (run.exitCode === 0) break;
    }
    evidence.classification = classify(evidence.runs, settings.thresholds);
    if (settings.failOnUnexplained && evidence.classification.kind === 'unexplained') evidence.exitCode = 1;
    evidence.status = 'complete';
    evidence.finishedAt = new Date().toISOString();
    await persist();
    return { evidencePath, evidence, exitCode: evidence.exitCode };
  } catch (error) {
    error.evidencePath = evidencePath;
    error.firstExitCode = evidence.firstExitCode;
    throw error;
  }
}
