import { resolve } from 'node:path';
import { configuration, readRecords, validateRecord } from './lib/records.mjs';
import { snapshot, compare } from './lib/git.mjs';

export { readRecords } from './lib/records.mjs';

export function checkRecord(record, { cwd = process.cwd() } = {}) {
  return compare(validateRecord(record), snapshot(cwd));
}

export function checkFiles(files, { cwd = process.cwd(), config = {} } = {}) {
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !file)) {
    throw new Error('Name at least one file to check.');
  }
  const settings = configuration(config);
  const records = files.flatMap(file => {
    const records = readRecords(resolve(cwd, file), settings);
    if (!records.length) throw new Error(`${file}: no proof records found.`);
    return records;
  });
  const state = snapshot(cwd);
  return records.map(record => compare(record, state));
}

export function exitCode(results, { reportOnly = false } = {}) {
  return reportOnly ? 0 : results.some(result => !['current', 'still about these paths'].includes(result.verdict)) ? 1 : 0;
}
