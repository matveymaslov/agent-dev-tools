#!/usr/bin/env node
import { fstatSync, statSync } from 'node:fs';
import { dryRun, waitForLine } from '../index.mjs';

const HELP = `Usage: wait-for-line --file <log> --pattern <regex> [options]

Wait for a complete line appended after arming. Polls without writing to the log.

  --timeout <duration>   Overall deadline (default: unlimited)
  --interval <duration>  Poll interval (default: 1s)
  --grace <duration>     How long a file that was already seen may stay missing
                         (default: 5s). A file that does not exist yet is
                         awaited until --timeout, with no grace limit.
  --dry-run              Print numbered existing matches and exit; do not arm
  --help                 Show this help

Durations: positive numbers with ms, s, m, h or d (e.g. 250ms, 1.5s, 2h).
Use a quoted JavaScript regex source, preferably ^...$, without / delimiters.
Diagnostics go to stderr; the matched line goes to stdout.
Exit codes: 0 match/preview/help, 1 usage/I/O error, 2 timeout, 3 seen file gone.
`;

function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text);
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const value = match && Number(match[1]) * units[match[2]];
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid duration; use a positive value such as 250ms, 1s or 2h.');
  return value;
}

function parse(args) {
  const options = {};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (seen.has(option)) throw new Error('Duplicate option. Use --help for usage.');
    seen.add(option);
    if (option === '--help' || option === '--dry-run') {
      options[option.slice(2)] = true;
    } else if (['--file', '--pattern', '--timeout', '--interval', '--grace'].includes(option)) {
      if (++i >= args.length) throw new Error('Missing option value. Use --help for usage.');
      options[option.slice(2)] = ['--file', '--pattern'].includes(option) ? args[i] : parseDuration(args[i]);
    } else throw new Error('Unknown option. Use --help for usage.');
  }
  if (!options.help && (!options.file || options.pattern === undefined)) throw new Error('--file and --pattern are required.');
  return options;
}

// Also guard against accidental shell redirection into the watched file,
// including hard links. A shell using '>' may already have truncated it.
const args = process.argv.slice(2);
let file = args[args.indexOf('--file') + 1];
function isWatchedOutput(fd) {
  if (!file) return false;
  try {
    const output = fstatSync(fd, { bigint: true });
    const watched = statSync(file, { bigint: true });
    return output.isFile() && watched.isFile() && output.dev === watched.dev && output.ino === watched.ino;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EBADF'].includes(error.code)) return false;
    throw error;
  }
}

function write(fd, text) {
  if (isWatchedOutput(fd)) throw new Error('Refusing output redirected into the watched file.');
  (fd === 1 ? process.stdout : process.stderr).write(text);
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => { process.exitCode = 1; });
}

try {
  const options = parse(args);
  file = options.file;
  if (isWatchedOutput(1) || isWatchedOutput(2)) throw new Error('Refusing output redirected into the watched file.');
  if (options.help) write(1, HELP);
  else {
    options.onEvent = event => write(2, `${event.message}\n`);
    if (options['dry-run']) {
      let count = 0;
      for await (const { lineNumber, line } of dryRun(options)) {
        write(1, `${lineNumber}: ${line}\n`);
        count++;
      }
      write(2, count ? `Dry-run found ${count} matching existing lines.\n` : 'No existing lines match.\n');
    } else {
      write(1, `${await waitForLine(options)}\n`);
    }
  }
} catch (error) {
  process.exitCode = error.exitCode ?? 1;
  try { write(2, `${error.message}\n`); } catch { /* Never write an error into the watched log. */ }
}
