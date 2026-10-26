const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { inspect, linesOf, readUtf8, pathKey } = require('./index.cjs');

function snapshot(file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Expected a regular file with one link (no symlinks): ${file}`);
  return { buffer: readUtf8(file), mode: stat.mode, ino: stat.ino, dev: stat.dev };
}

function assertUnchanged(file, before) {
  const now = snapshot(file, true);
  if ((!before && now) || (before && (!now || before.ino !== now.ino || before.dev !== now.dev || !before.buffer.equals(now.buffer)))) {
    throw new Error(`File changed after planning; run archive again: ${file}`);
  }
}

function realKey(file) {
  try { return pathKey(fs.realpathSync(file)); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return pathKey(file); throw error; }
}

function assertSafeMarkdown(text, file) {
  if (text.lastIndexOf('<!--') > text.lastIndexOf('-->')) throw new Error(`Unclosed Markdown comment: ${file}`);
  const visible = text.replace(/<!--[\s\S]*?-->/g, '');
  let fence;
  for (const { content } of linesOf(visible)) {
    const delimiter = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
    } else if (delimiter) fence = delimiter[1];
    else if (/<\/?[a-z][a-z\d]*(?:\s[^<>]*|)>/i.test(content)) {
      throw new Error(`Unsupported HTML in Markdown: ${file}`);
    }
  }
  if (fence) throw new Error(`Unclosed Markdown code fence: ${file}`);
}

function planArchive(index, options) {
  const report = inspect(index, options);
  const name = options.archive || 'MEMORY.archive.md';
  if (/[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || !name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) {
    throw new Error('--archive must be a portable filename beside the index.');
  }
  const archive = path.join(path.dirname(index), name);
  if (pathKey(archive) === pathKey(index)) throw new Error('Archive must differ from the index.');
  const encodedName = encodeURIComponent(name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const pointer = `Archived entries: [Archive](<${encodedName}>).`;
  const before = snapshot(index);
  if (!before.buffer.equals(report.buffer)) throw new Error('Index changed while planning; try again.');
  const archiveBefore = snapshot(archive, true);
  assertSafeMarkdown(report.text, index);
  if (archiveBefore) assertSafeMarkdown(archiveBefore.buffer.toString('utf8'), archive);
  for (const entry of report.entries) {
    if (entry.targets.some(target => realKey(target) === realKey(archive)) && entry.text.replace(/^\uFEFF/, '') !== pointer) {
      throw new Error(`Archive filename is already a note target on line ${entry.line}; choose another filename.`);
    }
  }
  const plan = { index, archive, before, archiveBefore, report, selected: [], pointer };
  const fits = text => linesOf(text).length < report.limits.maxLines && Buffer.byteLength(text) < report.limits.maxBytes;
  if (fits(report.text)) return { ...plan, nextIndex: report.text, nextArchive: null };
  const eol = report.text.match(/\r\n|\n|\r/)?.[0] || '\n';
  const candidates = report.entries.filter(entry => {
    if (!entry.movable || entry.lines.length !== 1) return false;
    if (entry.targets.some(target => [realKey(index), realKey(archive)].includes(realKey(target)))) return false;
    // Do not split multiline/lazy list paragraphs or a list's indented code.
    let next = entry.line;
    while (next < report.lines.length && !report.lines[next].content.trim()) next++;
    const following = report.lines[next]?.content;
    if (following && !/^(?:#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(following)) return false;
    return true;
  }).sort((a, b) => a.mtime - b.mtime || a.line - b.line);
  const removed = new Set();
  function render() {
    let body = report.lines.filter(line => !removed.has(line.number) && line.content.replace(/^\uFEFF/, '') !== pointer).map(line => line.raw).join('');
    const bom = report.text.startsWith('\uFEFF') ? '\uFEFF' : '';
    body = body.replace(/^\uFEFF/, '');
    return bom + pointer + eol + body;
  }
  let nextIndex = render();
  for (const candidate of candidates) {
    if (fits(nextIndex)) break;
    plan.selected.push(candidate);
    for (const line of candidate.lines) removed.add(line.number);
    nextIndex = render();
  }
  if (!fits(nextIndex) || !plan.selected.length) {
    throw new Error(`Cannot fit index and archive pointer strictly below ${report.limits.maxLines} lines / ${report.limits.maxBytes} bytes. ${candidates.length} eligible entries; missing, multiline and unsupported entries stay pinned. No files written.`);
  }
  let nextArchive = archiveBefore ? archiveBefore.buffer.toString('utf8') : `# Archived memory entries${eol}${eol}`;
  if (nextArchive && !/[\r\n]$/.test(nextArchive)) nextArchive += eol;
  for (const entry of plan.selected) {
    nextArchive += entry.raw.replace(/^\uFEFF/, '');
    if (!/[\r\n]$/.test(nextArchive)) nextArchive += eol;
  }
  return { ...plan, nextIndex, nextArchive };
}

function archiveReport(plan) {
  const output = [
    'Rule: least recently changed note first (filesystem mtime; newest target for multi-link entries; ties by original line).',
    `Target: strictly below ${plan.report.limits.maxLines} lines and ${plan.report.limits.maxBytes} UTF-8 bytes, including the archive pointer.`,
    `Archive: ${plan.archive}`,
  ];
  for (const entry of plan.selected) output.push(`MOVE line ${entry.line} [${new Date(entry.mtime).toISOString()}]: ${entry.text}`);
  output.push(`Result: ${linesOf(plan.nextIndex).length} lines; ${Buffer.byteLength(plan.nextIndex)} bytes; ${plan.selected.length} entries selected.`);
  if (!plan.selected.length) output.push('No changes: index is already below both limits.');
  return output.join('\n');
}

function applyArchive(plan) {
  if (!plan.selected.length) return [];
  const lock = `${plan.index}.memory-index-lint.lock`;
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Archive lock exists: ${lock}. Check for an active archiver before removing it.`);
    throw error;
  }
  const backups = [];
  const temps = [];
  let archiveWritten = false;
  try {
    assertUnchanged(plan.index, plan.before);
    assertUnchanged(plan.archive, plan.archiveBefore);
    const suffix = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(6).toString('hex');
    for (const [file, before] of [[plan.index, plan.before], [plan.archive, plan.archiveBefore]]) {
      if (!before) continue;
      const backup = `${file}.bak-${suffix}`;
      fs.writeFileSync(backup, before.buffer, { flag: 'wx', mode: 0o600 });
      backups.push(backup);
    }
    for (const [file, content, mode] of [
      [plan.archive, plan.nextArchive, plan.archiveBefore?.mode ?? 0o600],
      [plan.index, plan.nextIndex, plan.before.mode],
    ]) {
      const temp = `${file}.tmp-${suffix}`;
      fs.writeFileSync(temp, content, { flag: 'wx', mode });
      temps.push([temp, file]);
    }
    assertUnchanged(plan.index, plan.before);
    assertUnchanged(plan.archive, plan.archiveBefore);
    // Archive first: interruption can duplicate entries, but cannot lose them.
    fs.renameSync(temps[0][0], plan.archive);
    archiveWritten = true;
    assertUnchanged(plan.index, plan.before);
    fs.renameSync(temps[1][0], plan.index);
    return backups;
  } catch (error) {
    throw new Error(`${error.message}${archiveWritten ? ' Archive was saved; index was not replaced. Entries may exist in both indexes.' : ''}${backups.length ? ` Backups: ${backups.join(', ')}` : ''}`, { cause: error });
  } finally {
    for (const [temp] of temps) {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') process.stderr.write(`Cleanup failed: ${temp}: ${error.message}\n`); }
    }
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

module.exports = { planArchive, archiveReport, applyArchive };
