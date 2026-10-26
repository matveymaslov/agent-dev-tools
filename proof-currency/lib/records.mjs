import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const defaults = ['proof_commit', 'verified_at', 'commit'];
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function configuration(config = {}) {
  if (!object(config) || Object.keys(config).some(key => !['keys', 'pathsKey'].includes(key))) {
    throw new Error('Config must be an object with only keys and pathsKey.');
  }
  const keys = own(config, 'keys') ? config.keys : defaults;
  const pathsKey = own(config, 'pathsKey') ? config.pathsKey : 'paths';
  const validKey = value => typeof value === 'string' && /^[A-Za-z_][\w-]*$/.test(value);
  if (!Array.isArray(keys) || !keys.length || !keys.every(validKey) ||
      new Set(keys).size !== keys.length || !validKey(pathsKey) || keys.includes(pathsKey)) {
    throw new Error('Config needs distinct nonempty field names and a separate pathsKey.');
  }
  return { keys, pathsKey };
}

export function validateRecord(record) {
  if (!object(record) || typeof record.commit !== 'string' || !/^[a-f\d]{4,64}$/i.test(record.commit)) {
    throw new Error('A proof commit must be a hexadecimal commit hash (4–64 characters), not a moving ref.');
  }
  if (record.paths !== undefined && (!Array.isArray(record.paths) || record.paths.some(path => typeof path !== 'string'))) {
    throw new Error('Covered paths must be a list of strings.');
  }
  const paths = (record.paths ?? []).map(path => {
    const slash = path.replaceAll('\\', '/');
    if (!slash || slash.includes('\0') || slash.startsWith('/') || /^[A-Za-z]:/.test(slash) || slash.split('/').includes('..')) {
      throw new Error('Covered paths must be nonempty repository-relative paths without parent traversal.');
    }
    return slash.split('/').filter(part => part && part !== '.').join('/') || '.';
  });
  return { ...record, paths: [...new Set(paths)] };
}

// A deliberately small front-matter grammar: flat keys, strings and string lists.
// Reject unsupported syntax rather than silently dropping or broadening a proof.
function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === '"' && char === '\\') { i++; continue; }
    if (quote === "'" && char === "'" && line[i + 1] === "'") { i++; continue; }
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  if (quote) throw new Error('Unterminated front-matter string.');
  return line.trimEnd();
}

function scalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const value = JSON.parse(text);
    if (typeof value !== 'string') throw new Error('Expected a front-matter string.');
    return value;
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new Error('Invalid single-quoted string.');
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (!text || /^[\[\]{}&*!|>]/.test(text) || /:\s/.test(text)) {
    throw new Error('Unsupported front-matter value; use a string or a list of strings.');
  }
  return text;
}

function inlineList(text) {
  if (!text.endsWith(']')) throw new Error('Unterminated front-matter list.');
  const body = text.slice(1, -1);
  if (!body.trim()) return [];
  const items = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote === '"' && char === '\\') { i++; continue; }
    if (quote === "'" && char === "'" && body[i + 1] === "'") { i++; continue; }
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ',') { items.push(scalar(body.slice(start, i))); start = i + 1; }
  }
  items.push(scalar(body.slice(start)));
  return items;
}

function frontMatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw new Error('Front matter has no closing --- delimiter.');
  const result = Object.create(null);
  let listKey;
  for (const line of lines.slice(1, end)) {
    const clean = stripComment(line);
    if (!clean.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(clean);
    if (item && listKey) { result[listKey].push(scalar(item[1])); continue; }
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(clean);
    if (!field) throw new Error('Front matter supports only flat fields and indented string lists.');
    const [, key, raw] = field;
    if (own(result, key)) throw new Error(`Duplicate front-matter field: ${key}`);
    listKey = undefined;
    if (!raw) { result[key] = []; listKey = key; }
    else result[key] = raw.startsWith('[') ? inlineList(raw) : scalar(raw);
  }
  return result;
}

export function readRecords(file, config = {}) {
  const { keys, pathsKey } = configuration(config);
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const value = extname(file).toLowerCase() === '.json' ? JSON.parse(text) : frontMatter(text);
    const records = [];
    function visit(value, location = '$') {
      if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${location}[${i}]`)); return; }
      if (!object(value)) return;
      for (const key of keys) {
        if (own(value, key)) records.push(validateRecord({ commit: value[key],
          ...(own(value, pathsKey) ? { paths: value[pathsKey] } : {}),
          source: { file, field: `${location}.${key}` } }));
      }
      for (const [key, item] of Object.entries(value)) if (!keys.includes(key) && key !== pathsKey) visit(item, `${location}.${key}`);
    }
    visit(value);
    return records;
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
}
