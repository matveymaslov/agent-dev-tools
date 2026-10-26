#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { DEFAULTS, inspect, lintReport } = require('../lib/index.cjs');

const HELP = `Usage: memory-index-lint <lint|archive> [MEMORY.md] [options]

  --max-lines N        Line budget (default: 200)
  --max-bytes N        UTF-8 byte budget (default: 25000)
  --near-percent N     Lint warning threshold, 1..100 (default: 90)
  --max-line-length N  Unicode characters per line (default: 240)
  --archive NAME       Archive filename beside the index (default: MEMORY.archive.md)
  --apply              Write the archive plan; otherwise read-only
  --help               Show this help

Exit codes: 0 clean/success; 1 lint findings; 2 usage, I/O or unsafe archive.
`;

function parse(args) {
  const command = args.shift();
  if (!['lint', 'archive'].includes(command)) throw new Error('Expected lint or archive; use --help.');
  const options = { ...DEFAULTS };
  let index;
  const numbers = { '--max-lines': 'maxLines', '--max-bytes': 'maxBytes', '--near-percent': 'nearPercent', '--max-line-length': 'maxLineLength' };
  while (args.length) {
    const arg = args.shift();
    if (numbers[arg]) {
      const raw = args.shift();
      const value = Number(raw);
      if (!/^\d+$/.test(raw || '') || !Number.isSafeInteger(value) || value < 1 || (arg === '--near-percent' && value > 100)) throw new Error(`Invalid value for ${arg}.`);
      options[numbers[arg]] = value;
    } else if (arg === '--apply' && command === 'archive') options.apply = true;
    else if (arg === '--archive' && command === 'archive') {
      options.archive = args.shift();
      if (!options.archive || options.archive.startsWith('--')) throw new Error('--archive needs a filename.');
    } else if (!arg.startsWith('-') && !index) index = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { command, index: path.resolve(index || 'MEMORY.md'), options };
}

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) process.stdout.write(HELP);
  else {
    const { command, index, options } = parse(args);
    if (command === 'lint') {
      const result = lintReport(inspect(index, options));
      process.stdout.write(result.output + '\n');
      process.exitCode = result.exitCode;
    } else {
      const { planArchive, archiveReport, applyArchive } = require('../lib/archive.cjs');
      const plan = planArchive(index, options);
      // Synchronous output makes the selected entries reviewable before any write.
      fs.writeSync(1, archiveReport(plan) + '\n');
      if (options.apply) {
        const backups = applyArchive(plan);
        for (const backup of backups) fs.writeSync(1, `Backup: ${backup}\n`);
        if (plan.selected.length) fs.writeSync(1, 'Applied. Note files are unchanged.\n');
      } else fs.writeSync(1, 'Dry run: no files written. Pass --apply to write this selection.\n');
    }
  }
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 2;
}
