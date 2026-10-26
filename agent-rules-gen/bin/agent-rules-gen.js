#!/usr/bin/env node
import { check, generate } from '../lib/index.js';

const usage = `Usage: agent-rules-gen <generate|check> [--source rules.md] [--out-dir .]

generate  Replace generated blocks, preserving handwritten text outside them.
check     Exit 1 if any output is missing, edited, stale, or has broken markers.

Paths resolve from the current directory. Quote paths that contain spaces.
Exit codes: 0 success, 1 check mismatch, 2 invalid arguments/input or I/O error.
`;

function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(usage);
    return 0;
  }
  const [command, ...flags] = args;
  if (!['generate', 'check'].includes(command)) throw new Error(usage.trimEnd());
  const options = {};
  const keys = { '--source': 'source', '--out-dir': 'outDir' };
  for (let i = 0; i < flags.length; i += 2) {
    if (!Object.hasOwn(keys, flags[i])) throw new Error(`Unknown option: ${flags[i]}`);
    const key = keys[flags[i]];
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${flags[i]}`);
    const value = flags[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flags[i]}`);
    options[key] = value;
  }
  const result = command === 'check' ? check(options) : generate(options);
  if (command === 'check') {
    for (const { file, reason } of result.issues) process.stderr.write(`${file}: ${reason}\n`);
    if (result.ok) process.stdout.write('Generated rules are fresh.\n');
    return result.ok ? 0 : 1;
  }
  for (const file of result.changed) process.stdout.write(`Updated ${file}\n`);
  if (!result.changed.length) process.stdout.write('Generated rules unchanged.\n');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`agent-rules-gen: ${error.message}\n`);
  process.exitCode = 2;
}
