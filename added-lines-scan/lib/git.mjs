import { spawn, spawnSync } from 'node:child_process';

// The caller picks the repository with --repo, never through inherited Git variables, and the
// user's Git configuration must not change what the output looks like.
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
const CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'log.showSignature=false',
  '-c', 'diff.noprefix=false', '-c', 'core.pager=cat'];

function environment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const name of INHERITED) delete env[name];
  return env;
}

const failure = (args, detail) => new Error(`git ${args[0]} failed: ${detail}`);

/** Run Git to completion and return its stdout. Throws on a non-zero exit or when Git cannot run. */
export function git(repo, args) {
  const result = spawnSync('git', [...CONFIG, '-C', repo, ...args], {
    env: environment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new Error(`cannot run git: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw failure(args, result.stderr.trim() || `exit ${result.status}`);
  return result.stdout;
}

/**
 * Run Git and yield its stdout one line at a time, split on LF only (a CR stays on its line), so a
 * large patch is never held in memory. Throws when Git cannot run or exits non-zero, after the
 * output so far has been yielded: a scan that reads a failed stream has not scanned anything.
 */
export async function* gitLines(repo, args) {
  const child = spawn('git', [...CONFIG, '-C', repo, ...args], {
    env: environment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk; });
  const finished = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let completed = false;
  try {
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      let from = 0;
      for (;;) {
        const at = text.indexOf('\n', from);
        if (at < 0) { pending += text.slice(from); break; }
        yield pending + text.slice(from, at);
        pending = '';
        from = at + 1;
      }
    }
    pending += decoder.decode();
    if (pending) yield pending;
    completed = true;
  } finally {
    // Only an abandoned or failed read stops Git; after a normal end it is left to exit by itself.
    if (!completed) child.kill();
  }
  const { code, signal, error } = await finished;
  if (error) throw new Error(`cannot run git: ${error.message}`, { cause: error });
  if (code !== 0) throw failure(args, stderr.trim() || `exit ${code ?? signal}`);
}
