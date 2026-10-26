#!/usr/bin/env node
import { runWithEvidence } from './index.mjs';

const help = `Usage: flaky-evidence [--times N] [--output FILE] [--fail-on-unexplained] -- <command...>

Run once, then retry failures up to N times (default: 2); stop at the first pass.
Write one JSON evidence file; print its path and the classification.
Default exit: the FIRST run's code, even if a retry passes.
Resources (CPU, memory, processes) are sampled just before each attempt,
not while the command runs.
--fail-on-unexplained  Normalize an unexplained result to exit 1.
--output FILE         Evidence path (must not already exist).
--help                Show this help.

Arguments after -- are passed literally, without an implicit shell.
Windows .cmd/.bat scripts require an explicit cmd.exe /d /s /c command.
`;

try {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(help);
  } else {
    const separator = argv.indexOf('--');
    if (separator < 0 || separator === argv.length - 1) throw new Error('expected -- followed by a command');
    const options = {};
    const seen = new Set();
    for (let i = 0; i < separator; i++) {
      const flag = argv[i];
      if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`);
      seen.add(flag);
      if (flag === '--fail-on-unexplained') options.failOnUnexplained = true;
      else if (flag === '--times' || flag === '--output') {
        const value = argv[++i];
        if (i >= separator || !value) throw new Error(`missing value for ${flag}`);
        if (flag === '--times') {
          if (!/^\d+$/.test(value)) throw new Error('--times must be a nonnegative integer');
          options.times = Number(value);
        } else options.evidencePath = value;
      } else throw new Error(`unknown option: ${flag}`);
    }
    const result = await runWithEvidence(argv.slice(separator + 1), options);
    const { message, basis } = result.evidence.classification;
    process.stdout.write(`${message}\n${basis ? `Note: ${basis}\n` : ''}Evidence: ${result.evidencePath}\n`);
    process.exitCode = result.exitCode;
  }
} catch (error) {
  process.stderr.write(`flaky-evidence: ${error.message}\n${error.evidencePath ? `Evidence: ${error.evidencePath}\n` : ''}`);
  process.exitCode = error.firstExitCode || 2;
}
