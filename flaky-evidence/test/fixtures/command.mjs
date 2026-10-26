import { readFileSync, writeFileSync } from 'node:fs';

const [mode, state] = process.argv.slice(2);
let attempt = 1;
try { attempt += Number(readFileSync(state, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
writeFileSync(state, String(attempt));
process.stdout.write(`attempt ${attempt}\r\n`);
if (mode === 'fail' || (mode === 'flaky' && attempt === 1)) {
  process.stderr.write('original failure\r\n');
  process.exitCode = 7;
}
