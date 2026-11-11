#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { scanRange, parseMarkers, formatHit } from '../lib/index.mjs';

const usage = `Usage: added-lines-scan --range <revisions> --markers <file> [--repo <dir>] [--allow-file <path> ...]
  --range       what git accepts as revisions: origin/main..HEAD, HEAD, or "HEAD ^origin/main"
  --markers     one regular expression per line; # comments; /pattern/i for case-insensitive
  --repo        a directory inside the repository (default: the current directory)
  --allow-file  repository paths whose hits are skipped (repeatable)
Output: one line per hit, "<short sha> <file>:<line> <marker> (<text>)".
Exit 0 clean, 1 at least one hit, 2 usage error or a range that could not be scanned.
`;

class UsageError extends Error {}

function parse(args) {
  const options = { allowFiles: [] };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const inline = equals > 0 ? arg.slice(equals + 1) : undefined;
    if (name === '--range' || name === '--markers' || name === '--repo') {
      const key = name.slice(2);
      if (key in options) throw new UsageError(`${name} given twice`);
      const value = inline ?? args[i + 1];
      if (value === undefined || value === '') throw new UsageError(`${name} needs a value`);
      options[key] = value;
      i += inline === undefined ? 2 : 1;
    } else if (name === '--allow-file') {
      if (inline !== undefined) { options.allowFiles.push(inline); i += 1; continue; }
      i += 1;
      const before = options.allowFiles.length;
      while (i < args.length && !args[i].startsWith('--')) options.allowFiles.push(args[i++]);
      if (options.allowFiles.length === before) throw new UsageError('--allow-file needs a path');
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (!options.range) throw new UsageError('--range is required');
  if (!options.markers) throw new UsageError('--markers is required');
  return options;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(usage);
    return 0;
  }
  let options;
  try { options = parse(args); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`added-lines-scan: ${error.message}\n${usage}`);
    return 2;
  }
  let markers;
  try {
    markers = parseMarkers(readFileSync(options.markers, 'utf8'), options.markers);
    if (!markers.length) throw new Error(`${options.markers}: no markers (only comments and blank lines); nothing could ever match`);
  } catch (error) {
    process.stderr.write(`added-lines-scan: ${error.message}\n`);
    return 2;
  }
  let result;
  try { result = await scanRange({ repo: options.repo, range: options.range, markers, allowFiles: options.allowFiles }); }
  catch (error) {
    process.stderr.write(`added-lines-scan: cannot scan ${options.range}: ${error.message}\n`);
    return 2;
  }
  for (const note of result.notes) process.stderr.write(`added-lines-scan: note: skipped binary file ${JSON.stringify(note.path)} in ${note.short}\n`);
  if (result.hits.length) {
    process.stdout.write(`${result.hits.map(formatHit).join('\n')}\n`);
    const commits = new Set(result.hits.map(hit => hit.sha)).size;
    process.stderr.write(`added-lines-scan: ${plural(result.hits.length, 'hit')} in ${plural(commits, 'commit')} of ${result.range} (${plural(result.commits, 'commit')} scanned)\n`);
    return 1;
  }
  const skipped = result.allowed ? `; ${plural(result.allowed, 'matching line')} in allowed files skipped` : '';
  process.stdout.write(result.commits
    ? `added-lines-scan: clean: ${plural(result.commits, 'commit')} in ${result.range} scanned against ${plural(markers.length, 'marker')}${skipped}\n`
    : `added-lines-scan: clean: ${result.range} has 0 commits, nothing to scan\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
