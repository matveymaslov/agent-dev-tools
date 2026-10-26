import { spawnSync } from 'node:child_process';

function git(cwd, args, allowed = [0]) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0' };
  // The caller selects the repository by cwd, never by inherited Git overrides.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw new Error(`Cannot run Git: ${result.error.message}`, { cause: result.error });
  if (!allowed.includes(result.status)) {
    throw new Error(`Git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result;
}

export function snapshot(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).stdout.replace(/\r?\n$/, '');
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim();
  const output = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).stdout;
  const fields = output.split('\0');
  const dirtyPaths = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const status = fields[i].slice(0, 2);
    dirtyPaths.push(fields[i].slice(3));
    // Porcelain -z emits the destination first, then the source for a rename/copy.
    if (/[RC]/.test(status)) {
      if (!fields[i + 1]) throw new Error('Incomplete Git rename status.');
      dirtyPaths.push(fields[++i]);
    }
  }
  return { root, head, dirtyPaths };
}

export function compare(record, state) {
  // --quiet promises only "non-zero" on failure: a missing hash exits 1, and some Git
  // versions exit 128 for a short hash that matches several objects. Both mean the hash
  // does not name exactly one commit, so neither may throw.
  const resolved = git(state.root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${record.commit}^{commit}`], [0, 1, 128]);
  const result = (verdict, reason, changedPaths = [], resolvedCommit = null) => ({
    ...record, verdict, reason, changedPaths, resolvedCommit, head: state.head
  });
  if (resolved.status !== 0) {
    const said = resolved.stderr.split(/\r?\n/).find(line => line.trim() && !/^hint:/.test(line));
    return result('unknown commit', 'Unknown or ambiguous commit: the hash does not name exactly one commit in this clone '
      + '(it may be missing, history may be shallow or incomplete, or a short hash may match several objects); '
      + `use the full hash.${said ? ` Git said: ${said.trim()}` : ''}`);
  }
  const commit = resolved.stdout.trim();
  const ancestor = git(state.root, ['merge-base', '--is-ancestor', commit, state.head], [0, 1]);
  if (ancestor.status !== 0) return result('not on this history',
    'The proof commit is not an ancestor of HEAD in the available history.', [], commit);
  const historical = commit === state.head ? [] : git(state.root, ['diff', '--name-only', '-z', '--no-renames',
    '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', commit, state.head, '--']).stdout.split('\0').filter(Boolean);
  const covered = path => !record.paths.length || record.paths.some(scope => scope === '.' || path === scope ||
    path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`));
  const changed = [...new Set([...historical, ...state.dirtyPaths].filter(covered))].sort();
  if (changed.length) return result('stale', 'Covered paths differ from the proof commit or have uncommitted changes.', changed, commit);
  if (commit === state.head) return result('current', 'The proof commit is HEAD and the covered paths are clean.', [], commit);
  return result('still about these paths', 'The proof commit is an ancestor of HEAD; covered paths match and are clean.', [], commit);
}
