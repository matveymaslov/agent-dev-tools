#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { decide, DEFAULT_JOURNALS, journalMatcher } from '../lib/index.mjs';

const ENV_NAME = 'DIAGNOSIS_NEEDS_EVIDENCE_JOURNAL';
const usage = `Usage: diagnosis-needs-evidence [--journal <glob or /regex/>]...
Reads one Claude Code PreToolUse hook JSON object on stdin.
Exit 2 denies the call (the reason is on stderr); exit 0 lets it through.
Journal files: --journal (repeatable) or ${ENV_NAME} (one pattern per line);
default ${DEFAULT_JOURNALS.join(' and ')}.
Exit 1 means a configuration error: the call is let through and the problem is shown.
`;

function parse(args) {
  const journals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--journal') {
      if (i + 1 >= args.length) throw new Error('--journal needs a pattern');
      journals.push(args[++i]);
    } else if (arg.startsWith('--journal=')) journals.push(arg.slice('--journal='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return journals;
}

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  process.stdout.write(usage);
} else {
  let journals;
  try {
    journals = parse(args);
    if (!journals.length) {
      journals = String(process.env[ENV_NAME] ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }
    if (!journals.length) journals = DEFAULT_JOURNALS;
    journalMatcher(journals); // reject a bad pattern before any call depends on it
  } catch (error) {
    process.stderr.write(`diagnosis-needs-evidence: ${error.message}\n${usage}`);
    process.exitCode = 1;
    journals = null;
  }
  if (journals) {
    let input = null;
    try { input = JSON.parse(readFileSync(0, 'utf8')); }
    catch (error) { process.stderr.write(`diagnosis-needs-evidence: cannot read the hook JSON on stdin (${error.message}); the call was let through\n`); }
    if (input) {
      const result = decide(input, { journals });
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.code;
    }
  }
}
