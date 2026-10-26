import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { countTests } from './reports.mjs';

export { countTests } from './reports.mjs';
export const NOT_RUN = 3;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

async function reportStamp(path) {
  try {
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) throw new Error('Report path must be a regular file');
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Run an executable argument array and return { exitCode, executed, reason, commandCode, signal }. */
export async function runTests({ command, format, min = 1, report, cwd = process.cwd(),
  env = process.env, stdout = process.stdout, stderr = process.stderr, signal } = {}) {
  if (!['tap', 'json', 'junit'].includes(format)) throw new TypeError('Format must be tap, json, or junit');
  if (!Number.isSafeInteger(min) || min < 1) throw new TypeError('Minimum must be a positive safe integer');
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string') || !command[0]) {
    throw new TypeError('Command must be a nonempty executable argument array');
  }
  let commandCode = null;
  let childSignal = null;
  const notRun = (reason, executed = null) => {
    stderr.write(`tests-ran: not run: ${reason}\n`);
    return { exitCode: NOT_RUN, executed, reason, commandCode, signal: childSignal };
  };
  if (signal?.aborted) return notRun('command was aborted before starting');
  let path;
  let before;
  try {
    path = report === undefined ? undefined : resolve(cwd, report);
    if (path) before = await reportStamp(path);
  } catch (error) {
    return notRun(`cannot read report: ${error.message}`);
  }

  const chunks = [];
  let bytes = 0;
  let interrupted = false;
  let spawnError;
  let outputError;
  let child;
  try {
    child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['inherit', 'pipe', 'pipe'], shell: false });
  } catch (error) {
    return notRun(`command could not start: ${error.message}`);
  }
  const abort = () => {
    interrupted = true;
    // SIGKILL maps to forced termination on Windows as well as Unix.
    child.kill('SIGKILL');
  };
  const closed = new Promise(resolveClose => {
    child.on('error', error => { spawnError = error; });
    child.once('close', (code, terminationSignal) => {
      commandCode = code;
      childSignal = terminationSignal;
      resolveClose();
    });
  });
  const unreadable = error => {
    outputError = error;
    abort();
  };
  child.stdout.on('error', unreadable);
  child.stderr.on('error', unreadable);
  child.stdout.on('data', chunk => {
    if (path) return;
    bytes += chunk.length;
    if (bytes <= MAX_REPORT_BYTES) chunks.push(chunk);
  });
  child.stdout.pipe(stdout, { end: false });
  child.stderr.pipe(stderr, { end: false });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  await closed;
  signal?.removeEventListener('abort', abort);
  if (outputError) return notRun(`command output could not be read: ${outputError.message}`);
  if (spawnError) return notRun(`command could not complete: ${spawnError.message}`);
  if (interrupted || child.killed || childSignal || commandCode === null ||
    (process.platform === 'win32' && (commandCode >>> 0) >= 0x80000000)) {
    return notRun(`command was killed or interrupted${childSignal ? ` (${childSignal})` : ''}`);
  }
  let executed;
  try {
    let text;
    if (path) {
      const after = await reportStamp(path);
      if (!after) throw new Error('report file is missing');
      if (after === before) throw new Error('report is unchanged from the previous run');
      const info = await stat(path);
      if (info.size > MAX_REPORT_BYTES) throw new Error('report exceeds 64 MiB');
      text = await readFile(path, 'utf8');
    } else {
      if (bytes > MAX_REPORT_BYTES) throw new Error('report exceeds 64 MiB');
      text = Buffer.concat(chunks).toString('utf8');
    }
    executed = countTests(text, format);
  } catch (error) {
    return notRun(`cannot use ${format} report: ${error.message}`);
  }
  if (executed < min) return notRun(`executed ${executed} tests; minimum is ${min}`, executed);
  return { exitCode: commandCode, executed, reason: null, commandCode, signal: childSignal };
}
