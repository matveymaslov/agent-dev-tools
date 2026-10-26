#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkFiles, exitCode } from '../index.mjs';

const usage = `Usage: proof-currency [--repo DIRECTORY] [--config FILE] [--report-only] [--] FILE...

Check commit proof records in JSON files or document front matter.
Files and config are relative to the invocation directory; coverage paths are
relative to the Git repository root. The default repository is the current one.

Exit: 0 current/unchanged, 1 stale/off-history/unknown, 2 input or Git error.
--report-only always exits 0; input errors still appear on stderr.
`;
const args = process.argv.slice(2);
const print = (fd, text) => {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
};
// Only actual options (before --) can turn on report-only.
const separator = args.indexOf('--');
const reportOnly = args.slice(0, separator < 0 ? args.length : separator).includes('--report-only');
try {
  let cwd = process.cwd();
  let config = {};
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { files.push(...args.slice(i + 1).map(file => resolve(file))); break; }
    if (arg === '--help' || arg === '-h') { print(1, usage); process.exit(0); }
    if (arg === '--report-only') continue;
    if (arg === '--repo' || arg === '--config') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--repo') cwd = resolve(value);
      else config = JSON.parse(readFileSync(resolve(value), 'utf8').replace(/^\uFEFF/, ''));
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else files.push(resolve(arg));
  }
  const results = checkFiles(files, { cwd, config });
  for (const result of results) {
    // JSON quoting keeps unusual paths and terminal control characters readable.
    print(1, `${JSON.stringify(result.source.file)} ${JSON.stringify(result.source.field)} @ ${result.commit}: ${result.verdict}\n`);
    print(1, `  ${result.reason}\n`);
    for (const path of result.changedPaths) print(1, `  changed: ${JSON.stringify(path)}\n`);
  }
  process.exitCode = exitCode(results, { reportOnly });
} catch (error) {
  print(2, `proof-currency: ${JSON.stringify(error.message)}\n`);
  process.exitCode = reportOnly ? 0 : 2;
}
