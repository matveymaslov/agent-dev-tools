const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/cli.cjs');

function fixture(content, notes = {}) {
  const scratch = path.resolve(__dirname, '../.test-tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'fixture-'));
  const index = path.join(dir, 'MEMORY.md');
  fs.writeFileSync(index, content);
  for (const [name, value] of Object.entries(notes)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  return { dir, index };
}

function run(args, cwd) {
  // File descriptors also work in containers that disallow pipe polling.
  const capture = fixture('');
  const stdout = path.join(capture.dir, 'stdout.txt');
  const stderr = path.join(capture.dir, 'stderr.txt');
  const out = fs.openSync(stdout, 'w');
  const err = fs.openSync(stderr, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [cli, ...args], { cwd, shell: false, stdio: ['ignore', out, err] });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  if (result.error) throw result.error;
  return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') };
}

module.exports = { fixture, run };
