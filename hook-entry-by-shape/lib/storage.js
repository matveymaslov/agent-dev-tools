import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function readSettings(settingsPath) {
  const file = path.resolve(settingsPath);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('Settings path must be a regular file (no symlinks)');
    const bytes = fs.readFileSync(file);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { file, bytes, text, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { file, bytes: null, text: '{}\n', mode: 0o600 };
  }
}

function stage(file, bytes, mode) {
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  let descriptor, created = false;
  try {
    descriptor = fs.openSync(temp, 'wx', mode);
    created = true;
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    return temp;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) {
      try { fs.unlinkSync(temp); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.cleanupError = cleanup; }
    }
    throw error;
  }
}

function occupied(candidate) {
  try { fs.lstatSync(candidate); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Pick a backup name that does not exist yet: `<settings>.<UTC stamp>.bak`, with
 * `-1`, `-2`, ... appended if two writes land in the same millisecond. Backups are
 * never overwritten, so an earlier backup survives every later write.
 */
function backupPathFor(file) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  for (let n = 0; ; n++) {
    const candidate = `${file}.${stamp}${n ? '-' + n : ''}.bak`;
    if (!occupied(candidate)) return candidate;
  }
}

export function writeSettings(snapshot, text) {
  const { file, bytes, mode } = snapshot;
  const staged = new Set();
  try {
    // A settings file that does not exist yet may also lack its folder.
    if (bytes === null) fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = stage(file, Buffer.from(text, 'utf8'), mode);
    staged.add(next);
    let backupPath = null;
    if (bytes !== null) {
      backupPath = backupPathFor(file);
      const backup = stage(backupPath, bytes, mode);
      staged.add(backup);
      fs.renameSync(backup, backupPath);
      staged.delete(backup);
    }
    fs.renameSync(next, file);
    staged.delete(next);
    return backupPath;
  } finally {
    for (const temp of staged) fs.unlinkSync(temp);
  }
}
