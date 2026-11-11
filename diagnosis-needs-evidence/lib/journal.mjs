// Which paths are work journals. A pattern is either a glob or a regular expression.

/** Files whose name contains RUN-LOG or JOURNAL and ends in .md, in any directory, any letter case. */
export const DEFAULT_JOURNALS = ['*RUN-LOG*.md', '*JOURNAL*.md'];

const REGEX_FORM = /^\/(.+)\/(i?)$/s;

export const normalisePath = path => String(path).replace(/\\/g, '/');

function escapeLiteral(char) {
  return /[\\^$.*+?()[\]{}|/-]/.test(char) ? `\\${char}` : char;
}

function globSource(glob) {
  let out = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if (char === '{') { out += '(?:'; braces++; }
    else if (char === '}' && braces) { out += ')'; braces--; }
    else if (char === ',' && braces) out += '|';
    else out += escapeLiteral(char);
  }
  if (braces) throw new Error(`unbalanced "{" in journal pattern "${glob}"`);
  return out;
}

/**
 * Compile one journal pattern to a RegExp tested against a path written with forward slashes.
 * `/regex/` and `/regex/i` are regular expressions (case-sensitive unless marked i) tested
 * against the whole path. Anything else is a glob, matched case-insensitively at the end of the
 * path from a directory boundary; a glob that starts with `/` or a drive letter must match from
 * the start of the path.
 */
export function compileJournal(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('empty journal pattern');
  const spec = pattern.trim();
  const regex = REGEX_FORM.exec(spec);
  if (regex) {
    try { return new RegExp(regex[1], regex[2]); }
    catch (error) { throw new Error(`invalid journal regular expression ${spec}: ${error.message}`); }
  }
  const glob = normalisePath(spec);
  const absolute = glob.startsWith('/') || /^[a-z]:\//i.test(glob);
  return new RegExp(`${absolute ? '^' : '(?:^|/)'}${globSource(glob)}$`, 'i');
}

/** A function telling whether a path (any slash style) names a journal under any of the patterns. */
export function journalMatcher(patterns = DEFAULT_JOURNALS) {
  const compiled = patterns.map(compileJournal);
  return path => {
    const normalised = normalisePath(path);
    return compiled.some(regex => regex.test(normalised));
  };
}
