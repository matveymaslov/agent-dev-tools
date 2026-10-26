#!/usr/bin/env node
import fs from 'node:fs';
import { install, find, remove, repair } from './index.js';

const usage = 'Usage: hook-entry-by-shape <install|find|remove|repair> <settings.json> <entry.json> [--platform <win32|linux|darwin>]';
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(usage);
} else {
  const [action, settingsPath, entryPath, flag, platform] = args;
  const actions = { install, find, remove, repair };
  if (!Object.hasOwn(actions, action) || !settingsPath || !entryPath ||
      ![3, 5].includes(args.length) || (args.length === 5 && flag !== '--platform')) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    try {
      const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8').replace(/^\uFEFF/, ''));
      const result = actions[action](settingsPath, entry, { platform });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('hook-entry-by-shape: ' + error.message);
      process.exitCode = 1;
    }
  }
}
