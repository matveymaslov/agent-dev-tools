#!/usr/bin/env node
import { runTests } from '../lib/index.mjs';

const usage = 'Usage: tests-ran [--min N] --format tap|json|junit [--report file] -- <command...>';

function parse(args) {
  const separator = args.indexOf('--');
  if (separator === -1 || separator === args.length - 1) throw new Error('A command after -- is required');
  const options = { min: 1, command: args.slice(separator + 1) };
  const seen = new Set();
  for (let i = 0; i < separator; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!['--min', '--format', '--report'].includes(key) || seen.has(key)) throw new Error(`Unknown or repeated option: ${key}`);
    if (i + 1 >= separator || !value) throw new Error(`Missing value for ${key}`);
    seen.add(key);
    if (key === '--min') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Minimum must be a positive safe integer');
      options.min = Number(value);
    } else options[key.slice(2)] = value;
  }
  if (!['tap', 'json', 'junit'].includes(options.format)) throw new Error('Format must be tap, json, or junit');
  return options;
}

if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
  process.stdout.write(`${usage}\nExit 3 means not run; skipped and todo tests do not count.\n`);
} else {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const options = parse(process.argv.slice(2));
    const result = await runTests({ ...options, signal: controller.signal });
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`tests-ran: ${error.message}\n${usage}\n`);
    process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
