// Reads a unified patch as Git prints it (git log -p / git diff-tree -p with -U0 and the prefixes
// a/ and b/) and yields what a scan needs:
//   { kind: 'commit', sha }                      a line "@@commit <sha>" from --format=@@commit %H
//   { kind: 'added', path, line, text }          an added line, line = its number in the new file
//   { kind: 'binary', path }                     a file Git reports as "Binary files ... differ"
// Hunk bodies are read by the counts in their @@ header, never by guessing from the first
// character, so an added line such as "++ b/x" (shown as "+++ b/x") is data, not a file header.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const SIMPLE_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };

/** Read the C-style quoted name that starts at text[start] (a double quote). Returns { value, end }. */
export function readQuoted(text, start = 0) {
  if (text[start] !== '"') throw new Error(`not a quoted name: ${text}`);
  const bytes = [];
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === '\\') {
      const simple = SIMPLE_ESCAPES[text[i + 1]];
      if (simple !== undefined) { bytes.push(simple); i += 2; continue; }
      const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4));
      if (!octal) throw new Error(`bad escape in quoted name: ${text}`);
      bytes.push(parseInt(octal[0], 8) & 255);
      i += 1 + octal[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i));
    bytes.push(...Buffer.from(char, 'utf8'));
    i += char.length;
  }
  if (i >= text.length) throw new Error(`unterminated quoted name: ${text}`);
  return { value: Buffer.from(bytes).toString('utf8'), end: i + 1 };
}

// "+++ b/path" (a quoted name when it has unusual characters, a trailing TAB when it has a space).
function newPath(rest) {
  if (rest === '/dev/null') return null;
  let name = rest;
  if (rest.startsWith('"')) name = readQuoted(rest).value;
  else if (rest.endsWith('\t')) name = rest.slice(0, -1);
  if (!name.startsWith('b/')) throw new Error(`unexpected file name in a patch header: ${rest}`);
  return name.slice(2);
}

// The path of a file from its "diff --git a/P b/P" header, for a binary file that has no ---/+++ lines.
function headerPath(header) {
  if (header.startsWith('"')) {
    const first = readQuoted(header);
    const rest = header.slice(first.end + 1);
    const second = rest.startsWith('"') ? readQuoted(rest).value : rest;
    return second.replace(/^b\//, '');
  }
  const half = (header.length - 5) / 2; // "a/P b/P" is 2 * length(P) + 5 characters
  if (Number.isInteger(half) && half > 0) {
    const name = header.slice(2, 2 + half);
    if (header === `a/${name} b/${name}`) return name;
  }
  const quoted = header.indexOf(' "b/');
  if (quoted >= 0 && header.endsWith('"')) return readQuoted(header.slice(quoted + 1)).value.slice(2);
  return header.slice(header.lastIndexOf(' b/') + 3); // a rename with spaces; "rename to" normally answers first
}

/** Parse an async iterable of patch lines. Throws on a patch it cannot read: a scan must not pass silently. */
export async function* parsePatch(lines) {
  let file = null;
  let hunk = null;
  for await (const line of lines) {
    if (hunk) {
      const mark = line[0];
      if (mark === '\\') continue; // "\ No newline at end of file"
      if (mark === '+') {
        if (file.path === null) throw new Error('an added line has no new file name');
        yield { kind: 'added', path: file.path, line: hunk.line, text: line.slice(1) };
        hunk.line++;
        hunk.added--;
      } else if (mark === '-') hunk.removed--;
      else if (mark === ' ') { hunk.line++; hunk.added--; hunk.removed--; }
      else throw new Error(`unexpected line inside a hunk: ${JSON.stringify(line.slice(0, 80))}`);
      if (hunk.added < 0 || hunk.removed < 0) throw new Error('a hunk is longer than its header says');
      if (hunk.added === 0 && hunk.removed === 0) hunk = null;
      continue;
    }
    if (line.startsWith('@@commit ')) {
      file = null;
      yield { kind: 'commit', sha: line.slice('@@commit '.length).trim() };
    } else if (line.startsWith('diff --git ')) file = { header: line.slice('diff --git '.length), renameTo: null, path: null };
    else if (!file) continue;
    else if (line.startsWith('rename to ')) {
      const name = line.slice('rename to '.length);
      file.renameTo = name.startsWith('"') ? readQuoted(name).value : name;
    } else if (line.startsWith('+++ ')) file.path = newPath(line.slice(4));
    else if (line.startsWith('Binary files ') && line.endsWith(' differ')) yield { kind: 'binary', path: file.renameTo ?? headerPath(file.header) };
    else if (line[0] === '+' || line[0] === ' ' || (line[0] === '-' && !line.startsWith('--- '))) {
      // A changed line outside any hunk means the reader and Git disagree about where a hunk ends.
      throw new Error(`a hunk is longer than its header says: ${JSON.stringify(line.slice(0, 80))}`);
    }
    else if (line.startsWith('@@ ')) {
      const header = HUNK.exec(line);
      if (!header) throw new Error(`cannot read a hunk header: ${JSON.stringify(line.slice(0, 80))}`);
      hunk = {
        removed: header[2] === undefined ? 1 : Number(header[2]),
        added: header[4] === undefined ? 1 : Number(header[4]),
        line: Number(header[3]),
      };
      if (hunk.added === 0 && hunk.removed === 0) hunk = null;
    }
  }
  if (hunk) throw new Error('the patch ended inside a hunk');
}
