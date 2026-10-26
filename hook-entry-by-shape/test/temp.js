import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function temporaryDirectory(prefix) {
  try { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
  catch (error) {
    if (!['EROFS', 'EACCES', 'ENOENT'].includes(error.code)) throw error;
    return fs.mkdtempSync(path.join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-' + prefix));
  }
}

/** Backup files written next to a settings file, oldest name first. */
export function backupsOf(file) {
  const base = path.basename(file) + '.';
  return fs.readdirSync(path.dirname(file))
    .filter(name => name.startsWith(base) && name.endsWith('.bak')).sort()
    .map(name => path.join(path.dirname(file), name));
}
