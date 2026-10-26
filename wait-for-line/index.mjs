import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const CHUNK_SIZE = 64 * 1024;
const GUARD_SIZE = 64;
const BUSY = new Set(['EBUSY', 'EAGAIN', 'EINTR', 'ETXTBSY']);
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

export class WaitForLineError extends Error {
  constructor(message, code, exitCode) {
    super(message);
    this.name = 'WaitForLineError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function duration(value, name, allowInfinity = false) {
  if (allowInfinity && value === Infinity) return value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer in milliseconds.`);
  }
  return value;
}

function fullyAnchored(source) {
  // Conservative advice: every top-level alternative must have both anchors.
  let depth = 0;
  let inClass = false;
  let start = 0;
  let escaped = false;
  let lastWasAnchor = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (escaped) { escaped = false; lastWasAnchor = false; continue; }
    if (char === '\\') { escaped = true; lastWasAnchor = false; continue; }
    if (char === '[') inClass = true;
    if (char === ']' && inClass) inClass = false;
    if (!inClass) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (char === '|' && depth === 0) {
        if (source[start] !== '^' || !lastWasAnchor) return false;
        start = i + 1;
      }
    }
    lastWasAnchor = char === '$' && !inClass;
  }
  return source[start] === '^' && lastWasAnchor;
}

function configuration(options) {
  const { file, pattern, onEvent = event => console.error(event.message), signal } = options;
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('file must be a non-empty path.');
  if (typeof pattern !== 'string' && !(pattern instanceof RegExp)) throw new TypeError('pattern must be a string or RegExp.');
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');
  let regex;
  try { regex = new RegExp(pattern); } catch { throw new TypeError('Invalid regular expression.'); }
  const timeout = duration(options.timeout ?? Infinity, 'timeout', true);
  const interval = duration(options.interval ?? 1000, 'interval');
  const grace = duration(options.grace ?? 5000, 'grace');
  const emit = (type, message, details = {}) => onEvent({ type, message, ...details });
  if (!fullyAnchored(regex.source)) {
    emit('warning', 'Pattern is not fully anchored; prefer ^...$ to avoid matching status messages.');
  }
  return { file, regex, emit, signal, timeout, interval, grace };
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function sizeOf(stat) {
  if (!stat.isFile()) throw new TypeError('The watched path must be a regular file.');
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('File is too large for a safe byte offset.');
  return Number(stat.size);
}

async function readGuard(handle, offset) {
  const buffer = Buffer.alloc(Math.min(offset, GUARD_SIZE));
  let done = 0;
  while (done < buffer.length) {
    const { bytesRead } = await handle.read(buffer, done, buffer.length - done, offset - buffer.length + done);
    if (!bytesRead) throw Object.assign(new Error('File changed while reading its boundary; retrying.'), { code: 'EAGAIN' });
    done += bytesRead;
  }
  return buffer;
}

class Lines {
  constructor(discard = false) {
    this.discard = discard;
    this.parts = [];
    this.length = 0;
  }

  finish() {
    let bytes = Buffer.concat(this.parts, this.length);
    if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
    this.parts = [];
    this.length = 0;
    return bytes.toString('utf8');
  }

  *push(bytes) {
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      if (!this.discard) {
        this.parts.push(bytes.subarray(start, i));
        this.length += i - start;
        yield this.finish();
      }
      this.discard = false;
      start = i + 1;
    }
    if (!this.discard && start < bytes.length) {
      this.parts.push(bytes.subarray(start));
      this.length += bytes.length - start;
    }
  }
}

function matches(regex, line) {
  regex.lastIndex = 0;
  return regex.test(line);
}

/** Wait for a complete UTF-8 line whose first byte arrives after arming.
 * Durations are milliseconds. Resolves to the line without LF/CRLF.
 * Rejects with exitCode 2 on timeout, 3 when a file that was seen stays gone
 * past the grace period (a file that never existed is awaited until timeout),
 * or with an I/O error.
 * onEvent is synchronous; the 'armed' event establishes the byte boundary.
 */
export async function waitForLine(options) {
  const { file, regex, emit, signal, timeout, interval, grace } = configuration(options);
  const deadline = performance.now() + timeout;
  let missingSince;
  let identity;
  let offset = 0;
  let guard = Buffer.alloc(0);
  let lines = new Lines();
  let wasBusy = false;

  // The grace period only applies to a file that was seen and then went missing.
  // A file that has never existed yet is awaited until the overall timeout.
  const graceDeadline = () => (missingSince === undefined || identity === undefined ? Infinity : missingSince + grace);

  function check() {
    signal?.throwIfAborted();
    const now = performance.now();
    const goneDeadline = graceDeadline();
    if (now >= goneDeadline && goneDeadline <= deadline) {
      throw new WaitForLineError('File is still missing after the grace period.', 'FILE_GONE', 3);
    }
    if (now >= deadline) throw new WaitForLineError('Timed out waiting for a new matching line.', 'TIMEOUT', 2);
  }

  while (true) {
    check();
    let handle;
    try {
      // Node/libuv uses shared read/write/delete access on Windows for 'r'.
      // Reopen each poll so renames never leave us attached to the old file.
      handle = await fs.open(file, 'r');
      const stat = await handle.stat({ bigint: true });
      const end = sizeOf(stat);
      check();
      if (missingSince !== undefined) {
        emit('returned', identity ? 'File returned; continuing to follow it.' : 'File appeared; arming now.');
      }
      missingSince = undefined;
      if (!identity) {
        const initialGuard = await readGuard(handle, end);
        offset = end;
        guard = initialGuard;
        identity = stat;
        // Never treat the suffix of an old partial line as a new line.
        lines = new Lines(end > 0 && guard.at(-1) !== 10);
        emit('armed', `Armed at byte ${offset}; waiting for complete new lines.`, { offset });
      } else {
        let reset;
        if (!sameFile(identity, stat)) reset = ['replaced', 'File replaced; reading from the new start.'];
        else if (end < offset) reset = ['truncated', 'File truncated; reading from the new start.'];
        else if (!(await readGuard(handle, offset)).equals(guard)) {
          reset = ['truncated', 'File truncated or rewritten; reading from the new start.'];
        }
        if (reset) {
          identity = stat;
          offset = 0;
          guard = Buffer.alloc(0);
          lines = new Lines();
          emit(...reset);
        }
        // Snapshot the end for this poll: a fast writer cannot starve deadlines.
        while (offset < end) {
          check();
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, end - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          const bytes = buffer.subarray(0, bytesRead);
          offset += bytesRead;
          guard = Buffer.from(Buffer.concat([guard, bytes]).subarray(-GUARD_SIZE));
          for (const line of lines.push(bytes)) {
            check();
            if (matches(regex, line)) return line;
          }
        }
      }
      if (wasBusy) emit('readable', 'File is readable again; continuing.');
      wasBusy = false;
    } catch (error) {
      if (MISSING.has(error.code)) {
        if (missingSince === undefined) {
          missingSince = performance.now();
          if (identity) emit('missing', 'File is missing; waiting for it to return within the grace period.');
          else emit('missing', 'File does not exist yet; waiting for it to appear until the timeout.');
        }
      } else if (BUSY.has(error.code)) {
        missingSince = undefined;
        if (!wasBusy) emit('busy', 'File is busy; retrying read access.');
        wasBusy = true;
      } else {
        throw error;
      }
    } finally {
      await handle?.close();
    }
    check();
    const goneDeadline = graceDeadline();
    await sleep(Math.max(1, Math.min(interval, deadline - performance.now(), goneDeadline - performance.now(), 2147483647)), undefined, { signal });
  }
}

/** Preview a snapshot of existing lines, including an unterminated final line.
 * Yields { lineNumber, line } for each match. Does not arm or wait for a file.
 */
export async function* dryRun(options) {
  const { file, regex, emit, signal, timeout, interval, grace } = configuration(options);
  const deadline = performance.now() + Math.min(timeout, grace);
  let handle;
  let busy = false;
  let offset = 0;
  let end;
  const lines = new Lines();
  let lineNumber = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      try {
        handle ??= await fs.open(file, 'r');
        end ??= sizeOf(await handle.stat({ bigint: true }));
        if (offset >= end) break;
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, end - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        for (const line of lines.push(buffer.subarray(0, bytesRead))) {
          lineNumber++;
          if (matches(regex, line)) yield { lineNumber, line };
        }
        busy = false;
      } catch (error) {
        if (!BUSY.has(error.code)) throw error;
        if (performance.now() >= deadline) throw new WaitForLineError('Timed out waiting for read access during dry-run.', 'TIMEOUT', 2);
        if (!busy) emit('busy', 'File is busy; retrying read access.');
        busy = true;
        await sleep(Math.max(1, Math.min(interval, deadline - performance.now(), 2147483647)), undefined, { signal });
      }
    }
    if (lines.length) {
      const line = lines.finish();
      if (matches(regex, line)) yield { lineNumber: lineNumber + 1, line };
    }
  } finally {
    await handle?.close();
  }
}
