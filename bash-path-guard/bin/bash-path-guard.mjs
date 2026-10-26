#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { hookDecision } from '../lib/guard.mjs';
import { lintText } from '../lib/lint.mjs';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'hook' && args.length === 0) {
  let result;
  try {
    result = hookDecision(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    result = { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Cannot read valid hook JSON from stdin; check the bash-path-guard hook configuration.',
    } };
  }
  // Exit zero so Claude Code consumes the decision JSON. An empty object
  // makes no permission decision; it must not grant permission itself.
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (mode === 'lint' && args.length > 0) {
  let status = 0;
  const files = args[0] === '--' ? args.slice(1) : args;
  if (!files.length) status = 2;
  for (const file of files) {
    if (!['.json', '.yaml', '.yml', '.ini', '.toml'].includes(extname(file).toLowerCase())) {
      process.stderr.write(`${file}: unsupported config format\n`);
      status = 2;
      continue;
    }
    try {
      for (const finding of lintText(readFileSync(file, 'utf8'))) {
        process.stdout.write(`${file}:${finding.line}:${finding.column}: suspicious drive-relative path ${finding.path}; use C:/Users/me or correctly escaped backslashes\n`);
        status = Math.max(status, 1);
      }
    } catch (error) {
      process.stderr.write(`${file}: ${error.code || 'unable to read file'}\n`);
      status = 2;
    }
  }
  process.exitCode = status;
} else {
  const help = 'Usage: bash-path-guard hook\n       bash-path-guard lint [--] <file.json|yaml|yml|ini|toml>...\n';
  if (mode === '--help' || mode === '-h') process.stdout.write(help);
  else {
    process.stderr.write(help);
    process.exitCode = 2;
  }
}
