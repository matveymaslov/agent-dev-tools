import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { bareCauses } from './sentences.mjs';
import { DEFAULT_JOURNALS, compileJournal, journalMatcher } from './journal.mjs';
import { scanShell } from './shell.mjs';

export { bareCauses, DEFAULT_JOURNALS, compileJournal, journalMatcher, scanShell };

const PASS = { code: 0, stderr: '' };

/** The lines of `next` that `current` does not already have, counted as a multiset, joined by newlines. */
export function addedLines(current, next) {
  const available = new Map();
  for (const line of current.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')) {
    available.set(line, (available.get(line) ?? 0) + 1);
  }
  const added = [];
  for (const line of String(next).replace(/\r\n/g, '\n').split('\n')) {
    const left = available.get(line) ?? 0;
    if (left > 0) available.set(line, left - 1);
    else added.push(line);
  }
  return added.join('\n');
}

function currentContent(path, cwd) {
  const full = isAbsolute(path) ? path : resolve(cwd || process.cwd(), path);
  try { return readFileSync(full, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

// A command is judged when it writes to a journal: a target of a redirection, tee, sed -i or
// perl -i names a journal, or a target cannot be read from the text ("$LOG") while the command
// names a journal somewhere else.
function writesToJournal(command, isJournal) {
  const { targets, words } = scanShell(command);
  if (targets.some(target => isJournal(target.text))) return true;
  return targets.some(target => target.dynamic) && words.some(isJournal);
}

function verdict(bare) {
  if (!bare.length) return PASS;
  const more = bare.length > 1 ? ` (and ${bare.length - 1} more)` : '';
  return { code: 2, stderr:
    `diagnosis-needs-evidence: refused. This text is going into a work journal and names a cause without evidence: "${bare[0]}"${more}.\n` +
    'Put a reference to code you have read in that sentence or the next one (path/file.ext:line, path/file.ext ~line or path/file.ext line N), ' +
    'or mark the sentence as a guess ("guess", "hypothesis", "not read", "not checked"). Then write it again.\n' };
}

/**
 * Decide one PreToolUse call. `input` is the hook's JSON object. Returns { code, stderr }:
 * code 2 denies (stderr names the sentence and the fix); code 0 lets the call through, with a
 * note on stderr when the check itself failed. `options.journals` is a list of journal patterns
 * (globs or /regex/); it defaults to DEFAULT_JOURNALS.
 */
export function decide(input, options = {}) {
  try {
    const isJournal = journalMatcher(options.journals ?? DEFAULT_JOURNALS);
    const { tool_name: tool, tool_input: toolInput, cwd } = input || {};
    if (tool === 'Bash') {
      const command = String(toolInput?.command ?? '');
      return writesToJournal(command, isJournal) ? verdict(bareCauses(command)) : PASS;
    }
    const path = String(toolInput?.file_path ?? '');
    if (!path || !isJournal(path)) return PASS;
    let added;
    if (tool === 'Write') added = addedLines(currentContent(path, cwd), String(toolInput.content ?? ''));
    else if (tool === 'Edit') added = String(toolInput.new_string ?? '');
    else if (tool === 'MultiEdit') added = (toolInput.edits ?? []).map(edit => String(edit?.new_string ?? '')).join('\n');
    else return PASS;
    return verdict(bareCauses(added));
  } catch (error) {
    return { code: 0, stderr: `diagnosis-needs-evidence: could not check (${error.message}); the call was let through\n` };
  }
}
