import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const operators = new Set(['regex_match', 'contains', 'equals', 'not_contains', 'starts_with', 'ends_with']);
const topKeys = new Set(['name', 'enabled', 'event', 'action', 'tool_matcher', 'pattern', 'conditions']);

// Match Python str.strip(): NEL is whitespace there; a BOM is not.
const pythonWhitespace = '[\\u0009-\\u000D\\u001C-\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]';
const scalarEdges = new RegExp(`^${pythonWhitespace}+|${pythonWhitespace}+$`, 'g');

function linesOf(text) {
  return [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)]
    .filter(match => match[0].length)
    .map((match, index) => ({ text: match[1], start: match.index, line: index + 1 }));
}

function location(text, offset) {
  const prefix = text.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: prefix.length, column: [...prefix.at(-1)].length + 1 };
}

// TextDecoder is authoritative. This locates the start of the first bad sequence.
function invalidOffset(bytes) {
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const count = b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2
      : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (!count || i + count > bytes.length) return i;
    for (let j = 1; j < count; j++) {
      if (bytes[i + j] < 0x80 || bytes[i + j] > 0xbf) return i;
    }
    if ((b === 0xe0 && bytes[i + 1] < 0xa0) || (b === 0xed && bytes[i + 1] >= 0xa0)
      || (b === 0xf0 && bytes[i + 1] < 0x90) || (b === 0xf4 && bytes[i + 1] >= 0x90)) return i;
    i += count;
  }
  return 0;
}

function parse(text, diagnostics) {
  const lines = linesOf(text);
  const patterns = [];
  const fields = new Map();
  const conditions = [];
  const fail = (message, offset = 0) => diagnostics.push({
    code: 'front-matter', message, ...location(text, offset),
  });
  if (lines[0]?.text !== '---') {
    fail('Expected an opening --- line at the start (no BOM).');
    return { patterns, bodyStart: text.length };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.text === '---');
  if (closing < 0) {
    fail('Missing closing --- line.');
    return { patterns, bodyStart: text.length };
  }
  const bodyStart = lines[closing + 1]?.start ?? text.length;
  let condition;
  let inConditions = false;

  function scalar(raw, start, topLevel) {
    const trimmed = raw.replace(scalarEdges, '');
    start += raw.indexOf(trimmed);
    let value = trimmed;
    let valueStart = start;
    // hookify has no YAML parser: any non-empty value is a plain string, so a
    // value starting with [ or { (a regex class, a quantifier group) is valid text.
    // Only an empty value or a block-scalar indicator cannot be read as one line.
    if (!trimmed || /^[|>][+-]?\d?$/.test(trimmed)) {
      fail('Expected a single-line value; hookify does not read block scalars or nested values here.', start);
      return null;
    }
    if (/^["']/.test(trimmed)) {
      if (trimmed.length < 2 || trimmed.at(-1) !== trimmed[0]) {
        fail('Unclosed scalar quote or trailing text after a quote.', start);
        return null;
      }
      value = trimmed.slice(1, -1);
      valueStart++;
    } else if (/["']$/.test(trimmed)) {
      fail('Unpaired scalar quote; quote the whole value.', start);
      return null;
    }
    const upstreamValue = trimmed.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
    if (upstreamValue !== value) {
      fail('Ambiguous outer quotes: hookify strips additional quote characters.', start);
      return null;
    }
    if (topLevel && /^(true|false)$/i.test(value)) value = value.toLowerCase() === 'true';
    return { value, start: valueStart, end: valueStart + (typeof value === 'string' ? value.length : trimmed.length) };
  }

  for (const line of lines.slice(1, closing)) {
    if (line.text.includes('---')) fail('hookify treats --- anywhere in front matter as its closing delimiter.', line.start);
    if (!line.text.trim() || line.text.trimStart().startsWith('#')) continue;
    if (/^[ \t]*\t/.test(line.text)) {
      fail('Use spaces, not tabs, for indentation.', line.start);
      continue;
    }
    const top = /^([a-z_]+):(?:[ \t]*(.*))$/.exec(line.text);
    if (top) {
      const [, key, raw] = top;
      condition = undefined;
      inConditions = false;
      if (!topKeys.has(key)) fail(`Unknown rule key: ${key}.`, line.start);
      if (fields.has(key)) fail(`Duplicate rule key: ${key}.`, line.start);
      fields.set(key, null);
      if (key === 'conditions') {
        if (raw.trim()) fail('Use an expanded conditions list, with one field per line.', line.start);
        inConditions = true;
      } else {
        const parsed = scalar(raw, line.start + line.text.length - raw.length, true);
        fields.set(key, parsed);
        if (key === 'pattern' && parsed && typeof parsed.value === 'string') patterns.push({ ...parsed, operator: 'regex_match' });
      }
      continue;
    }
    const item = /^  - ([a-z_]+):[ \t]*(.*)$/.exec(line.text);
    const continuation = /^ {4}([a-z_]+):[ \t]*(.*)$/.exec(line.text);
    const match = item || continuation;
    if (inConditions && match && (item || condition)) {
      if (item) {
        condition = new Map();
        conditions.push(condition);
        if (match[2].includes(',')) fail('hookify splits commas on list-item lines; put this value on a continuation line.', line.start);
      }
      const [, key, raw] = match;
      if (!['field', 'operator', 'pattern'].includes(key)) fail(`Unknown condition key: ${key}.`, line.start);
      if (condition.has(key)) fail(`Duplicate condition key: ${key}.`, line.start);
      condition.set(key, scalar(raw, line.start + line.text.length - raw.length, false));
    } else {
      fail('Malformed or unsupported front matter; use scalar keys and two/four-space expanded conditions.', line.start);
    }
  }
  for (const key of ['name', 'event', 'action', 'tool_matcher', 'pattern']) {
    if (fields.get(key) && typeof fields.get(key).value !== 'string') fail(`${key} must be text, but hookify converts true/false to booleans.`, fields.get(key).start);
  }
  const value = (key, fallback) => fields.get(key)?.value ?? fallback;
  const event = value('event', 'all');
  if (!['bash', 'file', 'stop', 'prompt', 'all'].includes(event)) fail('Unknown event.', fields.get('event')?.start);
  if (!['warn', 'block'].includes(value('action', 'warn'))) fail('Unknown action; use warn or block.', fields.get('action')?.start);
  if (typeof value('enabled', true) !== 'boolean') fail('enabled must be true or false.', fields.get('enabled')?.start);
  if (fields.has('conditions') && !conditions.length) fail('conditions must contain at least one mapping.');
  for (const entry of conditions) {
    // A key that is present but unreadable was already reported; do not repeat it as missing.
    if (!entry.has('field') || !entry.has('pattern')) fail('Each condition needs field and pattern.');
    const operator = entry.get('operator')?.value ?? 'regex_match';
    if (!operators.has(operator)) fail('Unknown condition operator.', entry.get('operator')?.start);
    if (entry.get('pattern')) patterns.push({ ...entry.get('pattern'), operator });
  }
  const unreadablePattern = fields.has('pattern') && fields.get('pattern') === null;
  if (!conditions.length && !unreadablePattern && !value('pattern', '')) fail('Expected a nonempty pattern or conditions.');
  if (event === 'file' || event === 'all') {
    const editOnly = conditions.find(entry => ['new_text', 'new_string'].includes(entry.get('field')?.value));
    if (editOnly || (!conditions.length && event === 'file' && value('pattern', ''))) {
      diagnostics.push({ code: 'write-content', ...location(text, editOnly?.get('field')?.start ?? fields.get('pattern').start),
        message: 'Write supplies content, not new_string. Use field: content for Write/Edit coverage; AND-ing another condition does not repair this.' });
    }
  }
  return { patterns, bodyStart };
}

/** Analyze bytes (preferred) or a decoded string. No filesystem access. */
export function lint(input) {
  let text;
  if (typeof input === 'string') {
    if (/[\uD800-\uDFFF]/u.test(input)) return { ok: false, diagnostics: [{ code: 'invalid-utf8', message: 'Input contains an unpaired Unicode surrogate.', line: 1, column: 1 }], patterns: [] };
    text = input;
  } else {
    if (!(input instanceof Uint8Array)) throw new TypeError('Expected a string or Uint8Array.');
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      const byteOffset = invalidOffset(input);
      const prefix = new TextDecoder().decode(input.subarray(0, byteOffset));
      return { ok: false, diagnostics: [{ code: 'invalid-utf8', byteOffset, ...location(prefix, prefix.length),
        message: `Invalid UTF-8 at byte offset ${byteOffset}; restore valid source bytes before fixing.` }], patterns: [] };
    }
  }
  const diagnostics = [];
  const parsed = parse(text, diagnostics);
  for (const line of linesOf(text)) {
    let offset = line.start;
    let column = 1;
    for (const character of line.text) {
      if (character.codePointAt(0) > 127) {
        const region = offset >= parsed.bodyStart ? 'body'
          : parsed.patterns.some(pattern => offset >= pattern.start && offset < pattern.end) ? 'pattern' : 'front-matter';
        const codePoint = `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
        diagnostics.push({ code: 'non-ascii', line: line.line, column, character, codePoint, region,
          message: `${codePoint} ${JSON.stringify(character)} in ${region}${region === 'body' ? '; rewrite this message text manually in ASCII' : ''}.` });
      }
      offset += character.length;
      column++;
    }
  }
  return { ok: diagnostics.length === 0, diagnostics, text, ...parsed };
}

/** Read and lint one rule; I/O errors become diagnostics. */
export async function lintFile(file) {
  try {
    return { file, ...lint(await readFile(file)) };
  } catch (error) {
    return { file, ok: false, diagnostics: [{ code: 'file-error', line: 1, column: 1, message: error.message }] };
  }
}

function escapePattern(pattern) {
  // Python identifiers accept Unicode letters, but not backslash escapes.
  for (const match of pattern.matchAll(/\(\?P<[^>]*>|\(\?P=[^)]*\)|\(\?\([^)]*\)/g)) {
    if (/[^\x00-\x7f]/.test(match[0])) throw new Error('Unicode group names/references need a manual, consistent ASCII rename.');
  }
  let result = '';
  for (const character of pattern) {
    const point = character.codePointAt(0);
    if (point <= 127) {
      result += character;
      continue;
    }
    let slashes = 0;
    for (let index = result.length - 1; index >= 0 && result[index] === '\\'; index--) slashes++;
    // Python treats backslash + non-ASCII as that literal character.
    if (slashes % 2) result = result.slice(0, -1);
    result += point <= 0xffff ? `\\u${point.toString(16).toUpperCase().padStart(4, '0')}`
      : `\\U${point.toString(16).toUpperCase().padStart(8, '0')}`;
  }
  return result;
}

/** Plan a lossless regex-only rewrite. Invalid/ambiguous files are never changed. */
export function fix(input) {
  const original = lint(input);
  if (original.diagnostics.some(d => ['invalid-utf8', 'front-matter'].includes(d.code))) {
    return { ...original, changed: false };
  }
  const replacements = [];
  for (const pattern of original.patterns) {
    if (pattern.operator !== 'regex_match' || !/[^\x00-\x7f]/.test(pattern.value)) continue;
    try {
      replacements.push({ ...pattern, replacement: escapePattern(pattern.value) });
    } catch (error) {
      return { ...original, ok: false, changed: false, diagnostics: [...original.diagnostics, {
        code: 'unsafe-pattern', ...location(original.text, pattern.start), message: error.message,
      }] };
    }
  }
  let text = original.text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, replacement.start) + replacement.replacement + text.slice(replacement.end);
  }
  return { ...lint(text), changed: text !== original.text };
}

/** Fix one regular file: exclusive backup, same-directory temporary, then rename. */
export async function fixFile(file) {
  let original;
  let temporary;
  let backup;
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error('Fix requires a regular file; symbolic links are not rewritten.');
    original = await readFile(file);
    const result = fix(original);
    if (!result.changed) return { file, ...result };
    const backupPath = `${file}.bak`;
    await writeFile(backupPath, original, { flag: 'wx', mode: stat.mode & 0o777 });
    backup = backupPath;
    temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, result.text, { encoding: 'utf8', flag: 'wx', mode: stat.mode & 0o777 });
    await chmod(temporary, stat.mode & 0o777);
    if (!(await readFile(file)).equals(original)) throw new Error('File changed during fix; original left untouched. Backup retained.');
    await rename(temporary, file);
    temporary = undefined;
    return { file, ...result, backup };
  } catch (error) {
    const result = original ? lint(original) : { diagnostics: [] };
    return { file, ...result, ok: false, changed: false, backup, diagnostics: [...result.diagnostics, {
      code: 'file-error', line: 1, column: 1, message: error.message,
    }] };
  } finally {
    if (temporary) {
      try { await unlink(temporary); } catch { /* The backup remains available after an I/O failure. */ }
    }
  }
}
