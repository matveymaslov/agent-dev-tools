#!/usr/bin/env node
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fixFile, lintFile } from './index.mjs';

const help = `Usage: hookify-encoding-lint <lint|fix> <file-or-directory> [...paths]

Directories select hookify.*.local.md files directly inside them (not recursive).
Quote paths with spaces. No shell glob expansion is needed. Use -- before paths
that begin with a dash. Exit: 0 clean, 1 findings/I/O/no files, 2 usage error.
`;
const [command, ...args] = process.argv.slice(2);
if (command === '--help' || command === '-h') {
  console.log(help);
} else if (!['lint', 'fix'].includes(command) || !args.length || (args[0] !== '--' && args.some(arg => arg.startsWith('-')))) {
  console.error(help);
  process.exitCode = 2;
} else {
  const paths = args[0] === '--' ? args.slice(1) : args;
  const files = new Set();
  let failed = false;
  for (const input of paths) {
    try {
      const stat = await lstat(input);
      if (stat.isDirectory()) {
        const entries = (await readdir(input, { withFileTypes: true }))
          .filter(entry => /^hookify\..+\.local\.md$/.test(entry.name) && (entry.isFile() || entry.isSymbolicLink()));
        if (!entries.length) throw new Error('No hookify.*.local.md files found.');
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) files.add(path.resolve(input, entry.name));
      } else files.add(path.resolve(input));
    } catch (error) {
      console.log(`${input}:1:1: file-error: ${error.message}`);
      failed = true;
    }
  }
  if (!paths.length) {
    console.error(help);
    process.exitCode = 2;
  } else {
    for (const file of files) {
      const result = await (command === 'fix' ? fixFile : lintFile)(file);
      if (result.backup) console.log(`${file}: ${result.changed ? 'fixed' : 'unchanged'}; backup: ${result.backup}`);
      for (const diagnostic of result.diagnostics) {
        console.log(`${file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.code}: ${diagnostic.message}`);
      }
      if (result.ok) console.log(`${file}: OK`);
      failed ||= !result.ok;
    }
    process.exitCode = failed ? 1 : 0;
  }
}
