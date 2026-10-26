const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({ maxLines: 200, maxBytes: 25000, nearPercent: 90, maxLineLength: 240 });

function readUtf8(file) {
  const buffer = fs.readFileSync(file);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Expected UTF-8 text: ${file}`);
  }
  return buffer;
}

function linesOf(text) {
  let offset = 0;
  return (text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [])
    .filter(raw => raw !== '')
    .map((raw, i) => {
      const content = raw.replace(/[\r\n]+$/, '');
      const line = { raw, content, number: i + 1, start: offset, end: offset + Buffer.byteLength(content) };
      offset += Buffer.byteLength(raw);
      return line;
    });
}

// A deliberately small inline-link reader. Balanced parentheses and angle-bracket
// destinations cover filenames without treating Markdown titles as part of paths.
function linksOf(text) {
  const source = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/(`+)[\s\S]*?\1/g, '');
  const links = [];
  const start = /(?<!!)\[(?:\\.|[^\]\\])*\]\(/g;
  let match;
  while ((match = start.exec(source))) {
    let i = start.lastIndex;
    while (/\s/.test(source[i] || '') && i < source.length) i++;
    let target = '';
    if (source[i] === '<') {
      const end = source.indexOf('>', i + 1);
      if (end < 0) continue;
      target = source.slice(i + 1, end);
      i = end + 1;
    } else {
      let depth = 0;
      while (i < source.length) {
        const char = source[i];
        if (char === '\\' && /[()\[\] ]/.test(source[i + 1] || '')) {
          target += source[i + 1]; i += 2; continue;
        }
        if (char === '(') depth++;
        if (char === ')') { if (!depth) break; depth--; }
        if (/\s/.test(char) && !depth) break;
        target += char; i++;
      }
    }
    const tail = source.slice(i).match(/^\s*(?:"[^"\r\n]*"|'[^'\r\n]*')?\s*\)/);
    if (!tail) continue;
    links.push(target);
    start.lastIndex = i + tail[0].length;
  }
  return links;
}

function resolveLink(target, directory) {
  if (!target || target.startsWith('#') || target.startsWith('//')) return null;
  // A Windows drive is a local path, not a URL scheme.
  const windowsAbsolute = /^[a-z]:[\\/]/i.test(target);
  if (!windowsAbsolute && /^[a-z][a-z\d+.-]*:/i.test(target)) return null;
  if (windowsAbsolute && process.platform !== 'win32') throw new Error('foreign Windows absolute path');
  const decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]);
  if (/[\0\r\n]/.test(decoded)) throw new Error('control character in path');
  return path.resolve(directory, decoded.replace(/\\/g, '/'));
}

function pathKey(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function inspect(index, options = DEFAULTS) {
  const limits = { ...DEFAULTS, ...options };
  const buffer = readUtf8(index);
  const text = buffer.toString('utf8');
  const lines = linesOf(text);
  const visible = linesOf(text.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => comment.replace(/[^\r\n]/g, ' ')));
  const cut = Math.min(buffer.length, limits.maxBytes, lines[limits.maxLines]?.start ?? buffer.length);
  const findings = [];
  const entries = [];
  let fence;
  let current;
  for (const line of lines) {
    const content = visible[line.number - 1].content.replace(/^\uFEFF/, '');
    const delimiter = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      current = null;
      continue;
    }
    if (delimiter) { fence = delimiter[1]; current = null; continue; }
    const bullet = /^(?:[-+*]|\d+[.)])\s+/.test(content);
    if (current && /^(?: {2,}|\t)\S/.test(content)) {
      current.lines.push(line);
      current.end = line.end;
      continue;
    }
    current = null;
    if (bullet || linksOf(content).length) {
      current = { line: line.number, end: line.end, start: line.start, lines: [line], bullet };
      entries.push(current);
    }
  }
  const seenTargets = new Map();
  const seenText = new Map();
  for (const entry of entries) {
    entry.text = entry.lines.map(line => line.content).join('\n');
    entry.raw = entry.lines.map(line => line.raw).join('');
    entry.targets = [];
    entry.mtime = -Infinity;
    entry.movable = entry.bullet && !/<!--|-->/.test(entry.text);
    const targets = linksOf(entry.text);
    if (/\[[^\]]*\](?!\()/.test(entry.text.replace(/(`+)[\s\S]*?\1/g, ''))) {
      findings.push({ code: 'UNSUPPORTED ENTRY', line: entry.line, detail: 'use inline Markdown links; entry will not be archived' });
      entry.movable = false;
    }
    if (!targets.length) entry.movable = false;
    const normalized = entry.text.replace(/^(?:[-+*]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
    if (seenText.has(normalized)) findings.push({ code: 'DUPLICATE', line: entry.line, detail: `text repeats line ${seenText.get(normalized)}` });
    else seenText.set(normalized, entry.line);
    for (const target of targets) {
      let file;
      try { file = resolveLink(target, path.dirname(index)); }
      catch (error) {
        findings.push({ code: 'INVALID LINK', line: entry.line, detail: `${target}: ${error.message}` });
        entry.movable = false;
        continue;
      }
      if (!file) continue;
      entry.targets.push(file);
      const key = pathKey(file);
      if (seenTargets.has(key)) findings.push({ code: 'DUPLICATE', line: entry.line, detail: `${target} repeats line ${seenTargets.get(key)}` });
      else seenTargets.set(key, entry.line);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) {
          findings.push({ code: 'NOT A FILE', line: entry.line, detail: target });
          entry.movable = false;
        } else entry.mtime = Math.max(entry.mtime, stat.mtimeMs);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        findings.push({ code: 'MISSING FILE', line: entry.line, detail: target });
        entry.movable = false;
      }
    }
    if (!entry.targets.length) entry.movable = false;
    if (entry.end > cut) findings.push({
      code: entry.start >= cut ? 'PAST CUT' : 'PARTIAL CUT', line: entry.line,
      detail: entry.text.replace(/\s+/g, ' '),
    });
  }
  for (const line of lines) {
    const length = [...line.content].length;
    if (length > limits.maxLineLength) findings.push({
      code: 'OVERLONG LINE', line: line.number,
      detail: `${length} characters; ${length - limits.maxLineLength} over ${limits.maxLineLength}`,
    });
  }
  return { index, buffer, text, lines, entries, findings, cut, limits };
}

function lintReport(report) {
  const { lines, buffer, limits, findings, cut } = report;
  const overLines = Math.max(0, lines.length - limits.maxLines);
  const overBytes = Math.max(0, buffer.length - limits.maxBytes);
  const near = lines.length / limits.maxLines >= limits.nearPercent / 100 || buffer.length / limits.maxBytes >= limits.nearPercent / 100;
  const output = [`Index: ${report.index}`, `${lines.length}/${limits.maxLines} lines; ${buffer.length}/${limits.maxBytes} UTF-8 bytes; cut at byte ${cut}.`];
  if (overLines || overBytes) output.push(`OVER LIMIT: ${overLines} lines and ${overBytes} bytes over.`);
  else if (near) output.push(`NEAR LIMIT: ${limits.maxLines - lines.length} lines and ${limits.maxBytes - buffer.length} bytes remaining.`);
  else output.push(`Capacity: ${limits.maxLines - lines.length} lines and ${limits.maxBytes - buffer.length} bytes remaining.`);
  for (const finding of findings) output.push(`${finding.code}: line ${finding.line}: ${finding.detail}`);
  const failed = Boolean(overLines || overBytes || near || findings.length);
  if (!failed) output.push('OK: no findings.');
  return { output: output.join('\n'), exitCode: failed ? 1 : 0 };
}

module.exports = { DEFAULTS, inspect, lintReport, linesOf, readUtf8, pathKey };
