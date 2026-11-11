import { git, gitLines } from './git.mjs';
import { parsePatch } from './patch.mjs';
import { parseMarkers } from './markers.mjs';

export { parseMarkers, parsePatch };

const MAX_TEXT = 120;
// -U0: only changed lines; -M: a rename that keeps its content adds nothing; explicit prefixes and
// options so that no Git setting (diff.noprefix, diff.external, textconv, signatures) alters the text.
const PATCH_OPTIONS = ['-p', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

export const normaliseAllowedPath = path => String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

/** Split a --range value into revisions for git: "A..B", "A...B", "B", or "B ^A ^C". */
export function parseRange(range) {
  const revisions = String(range ?? '').trim().split(/\s+/).filter(Boolean);
  if (!revisions.length) throw new Error('the range is empty');
  const option = revisions.find(revision => revision.startsWith('-'));
  if (option) throw new Error(`a revision may not start with "-": ${option}`);
  return revisions;
}

// What a merge adds by itself: the lines of the merge result that none of its parents has. A line
// that came in from a merged branch is the business of the commit on that branch that added it.
async function mergeAdditions(repo, merge) {
  let common = null;
  let binaries = null;
  for (const parent of merge.parents) {
    const added = new Map();
    const binary = new Set();
    for await (const event of parsePatch(gitLines(repo, ['diff-tree', '-r', ...PATCH_OPTIONS, parent, merge.sha]))) {
      if (event.kind === 'added') added.set(`${event.path}\0${event.line}`, event);
      else if (event.kind === 'binary') binary.add(event.path);
    }
    common = common ? new Map([...common].filter(([key]) => added.has(key))) : added;
    binaries = binaries ? new Set([...binaries].filter(path => binary.has(path))) : binary;
  }
  return { added: [...common.values()], binaries: [...binaries] };
}

/**
 * Scan the lines added by every commit in a range.
 *   repo        a directory inside the repository (default: the current directory)
 *   range       what Git accepts as revisions: "origin/main..HEAD", "HEAD", "HEAD ^origin/main"
 *   markers     [{ source, regex }] from parseMarkers
 *   allowFiles  repository paths whose hits are skipped (exact match, forward slashes)
 * Resolves to { range, commits, hits, notes, allowed }. Hits are { sha, short, path, line, marker, text },
 * oldest commit first. Throws when the range cannot be read or Git fails midway: a range that did not
 * scan is never reported as clean.
 */
export async function scanRange({ repo = '.', range, markers, allowFiles = [] }) {
  if (!Array.isArray(markers) || !markers.length) throw new Error('no markers: nothing could ever match');
  const revisions = parseRange(range);
  const allowedPaths = new Set(allowFiles.map(normaliseAllowedPath));
  const listing = git(repo, ['log', '--topo-order', '--reverse', '--no-show-signature', '--format=%H %h %P', ...revisions, '--']);
  const commits = listing.split('\n').filter(Boolean).map((line, index) => {
    const [sha, short, ...parents] = line.split(' ').filter(Boolean);
    return { sha, short, parents, index };
  });
  const result = { range: revisions.join(' '), commits: commits.length, hits: [], notes: [], allowed: 0 };
  if (!commits.length) return result;
  const bySha = new Map(commits.map(commit => [commit.sha, commit]));

  const addLine = (commit, event) => {
    const text = event.text.replace(/\r$/, ''); // a CRLF file: the CR is not part of the line
    for (const marker of markers) {
      if (!marker.regex.test(text)) continue;
      if (allowedPaths.has(event.path)) { result.allowed++; continue; }
      result.hits.push({ sha: commit.sha, short: commit.short, path: event.path, line: event.line, marker: marker.source,
        text, index: commit.index });
    }
  };
  const addBinary = (commit, path) => {
    if (!allowedPaths.has(path)) result.notes.push({ short: commit.short, path, index: commit.index });
  };

  if (commits.some(commit => commit.parents.length < 2)) {
    let current = null;
    const stream = gitLines(repo, ['log', '--no-merges', '--topo-order', '--reverse', '--no-show-signature',
      ...PATCH_OPTIONS, '--format=@@commit %H', ...revisions, '--']);
    for await (const event of parsePatch(stream)) {
      if (event.kind === 'commit') {
        current = bySha.get(event.sha);
        if (!current) throw new Error(`git log returned a commit that is not in the range: ${event.sha}`);
      } else if (!current) throw new Error('git log returned a change before its commit line');
      else if (event.kind === 'added') addLine(current, event);
      else addBinary(current, event.path);
    }
  }
  for (const merge of commits.filter(commit => commit.parents.length > 1)) {
    const { added, binaries } = await mergeAdditions(repo, merge);
    for (const event of added) addLine(merge, event);
    for (const path of binaries) addBinary(merge, path);
  }
  result.hits.sort((a, b) => a.index - b.index);
  result.notes.sort((a, b) => a.index - b.index);
  return result;
}

// Control characters are shown as \xNN so that a path or a line cannot forge a report line.
const printable = text => text.replace(/[\x00-\x1f\x7f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** One report line for a hit: "<short sha> <file>:<line> <marker> (<trimmed text>)". */
export function formatHit(hit) {
  const trimmed = hit.text.trim().replace(/\t/g, ' ');
  const text = trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed;
  return `${hit.short} ${printable(hit.path)}:${hit.line} ${printable(hit.marker)} (${printable(text)})`;
}
