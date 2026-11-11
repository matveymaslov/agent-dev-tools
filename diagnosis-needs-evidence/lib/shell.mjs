// A small shell reader: which words does a command line write to? It recognises output
// redirection (>, >>, >|, &>), tee, sed -i, perl -i, and the script given to sh -c / bash -c /
// eval. Quotes, comments, here-document bodies and command separators are tracked so that a
// ">" inside a string, "=>", ">=", "> /dev/null" and "2>&1" are not mistaken for a write to a file.
// It reads text; it never runs anything. Syntax it does not recognise is not seen.

const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'nice', 'stdbuf', 'builtin']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const MAX_NESTING = 3;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ESCAPABLE = ' \t"\'\\$`<>|&;()';

const commandName = word => word.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');

// Reads one expansion ($name, ${...}, $(...), `...`) starting at text[i].
function readExpansion(text, i) {
  if (text[i] === '`') {
    const close = text.indexOf('`', i + 1);
    return { end: close < 0 ? text.length : close + 1, dynamic: true };
  }
  if (text[i + 1] === '(') {
    let depth = 1;
    let j = i + 2;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
      j++;
    }
    return { end: j, dynamic: true };
  }
  if (text[i + 1] === '{') {
    const close = text.indexOf('}', i + 2);
    return { end: close < 0 ? text.length : close + 1, dynamic: true };
  }
  const name = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text.slice(i, i + 256));
  return name ? { end: i + name[0].length, dynamic: true } : { end: i + 1, dynamic: false };
}

function skipHeredocBody(text, from, heredoc) {
  let start = from;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    let line = text.slice(start, end).replace(/\r$/, '');
    if (heredoc.strip) line = line.replace(/^\t+/, '');
    start = newline < 0 ? text.length : newline + 1;
    if (line === heredoc.delimiter) break;
  }
  return start;
}

function readHeredocDelimiter(text, from) {
  let i = from;
  while (text[i] === ' ' || text[i] === '\t') i++;
  let delimiter = '';
  while (i < text.length && !/[\s;|&<>()]/.test(text[i])) {
    const char = text[i];
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, i + 1);
      const stop = close < 0 ? text.length : close;
      delimiter += text.slice(i + 1, stop);
      i = stop + 1;
    } else if (char === '\\') { delimiter += text[i + 1] ?? ''; i += 2; }
    else { delimiter += char; i++; }
  }
  return { delimiter, end: i };
}

function analyseCommand(segment, found, depth) {
  const words = segment.map(word => word.text);
  let at = 0;
  for (;;) {
    while (at < words.length && ASSIGNMENT.test(words[at])) at++;
    if (at < words.length && WRAPPERS.has(commandName(words[at]))) {
      at++;
      while (at < words.length && (words[at].startsWith('-') || ASSIGNMENT.test(words[at]))) at++;
      continue;
    }
    break;
  }
  if (at >= words.length) return;
  const name = commandName(words[at]);
  const rest = segment.slice(at + 1);
  const operands = rest.filter(word => !word.text.startsWith('-'));
  if (name === 'tee') found.targets.push(...operands);
  else if (name === 'sed' && rest.some(word => /^(?:-[nErszu]*i|--in-place)/.test(word.text))) found.targets.push(...operands);
  else if (name === 'perl' && rest.some(word => /^-(?:[pnalwWtTuUsSXcC]|0[0-7]*)*i/.test(word.text))) found.targets.push(...operands);
  else if (depth < MAX_NESTING && (SHELLS.has(name) || name === 'eval')) {
    let script;
    if (name === 'eval') script = rest.map(word => word.text).join(' ');
    else {
      const flag = rest.findIndex(word => /^-[a-z]*c[a-z]*$/i.test(word.text));
      script = flag >= 0 ? rest[flag + 1]?.text : undefined;
    }
    if (script) {
      const inner = scanShell(script, depth + 1);
      found.targets.push(...inner.targets);
      found.words.push(...inner.words);
    }
  }
}

/** Returns { targets, words }: the words a write goes to ({ text, dynamic }) and every word seen. */
export function scanShell(command, depth = 0) {
  const text = String(command);
  const found = { targets: [], words: [] };
  const heredocs = [];
  let segment = [];
  let word = null;
  let pending = null; // 'write' or 'other' while the next word is a redirection operand
  let i = 0;

  const open = () => (word ??= { text: '', dynamic: false });
  const endWord = () => {
    if (!word) return;
    const done = word;
    word = null;
    found.words.push(done.text);
    if (pending) {
      if (pending === 'write') found.targets.push(done);
      pending = null;
    } else segment.push(done);
  };
  const endCommand = () => {
    endWord();
    pending = null;
    analyseCommand(segment, found, depth);
    segment = [];
  };

  while (i < text.length) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      if (next === '\n') { i += 2; continue; }
      if (next !== undefined && ESCAPABLE.includes(next)) { open().text += next; i += 2; continue; }
      open().text += char; // a Windows path separator is kept as it is
      i++;
      continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", i + 1);
      const stop = close < 0 ? text.length : close;
      open().text += text.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (char === '$' && text[i + 1] === "'") {
      let j = i + 2;
      while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
      open().text += text.slice(i + 2, Math.min(j, text.length));
      i = j + 1;
      continue;
    }
    if (char === '"') {
      open();
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && '"\\$`\n'.includes(text[i + 1] ?? '')) {
          if (text[i + 1] !== '\n') word.text += text[i + 1];
          i += 2;
        } else if (text[i] === '$' || text[i] === '`') {
          const expansion = readExpansion(text, i);
          word.text += text.slice(i, expansion.end);
          if (expansion.dynamic) word.dynamic = true;
          i = expansion.end;
        } else word.text += text[i++];
      }
      i++;
      continue;
    }
    if (char === '$' || char === '`') {
      const expansion = readExpansion(text, i);
      open().text += text.slice(i, expansion.end);
      if (expansion.dynamic) word.dynamic = true;
      i = expansion.end;
      continue;
    }
    if (char === '#' && !word) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (char === '\n') {
      endCommand();
      i++;
      for (const heredoc of heredocs.splice(0)) i = skipHeredocBody(text, i, heredoc);
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') { endWord(); i++; continue; }
    if (char === ';' || char === '|' || char === '(' || char === ')') { endCommand(); i++; continue; }
    if (char === '&') {
      if (text[i + 1] === '>') { // &> and &>> write both streams to a file
        endWord();
        i += text[i + 2] === '>' ? 3 : 2;
        pending = 'write';
      } else { endCommand(); i += text[i + 1] === '&' ? 2 : 1; }
      continue;
    }
    if (char === '>') {
      // "=>" (arrow function) and ">=" (comparison) are not redirections.
      if ((text[i - 1] === '=' && word) || text[i + 1] === '=') { open().text += char; i++; continue; }
      let descriptor = null;
      if (word && /^\d+$/.test(word.text)) { descriptor = word.text; word = null; } else endWord();
      let j = i + 1;
      if (text[j] === '>') j++;
      else if (text[j] === '|') j++;
      if (text[j] === '(') { i = j; continue; } // process substitution, not a file
      if (text[j] === '&') {
        const duplicate = /^&(?:\d+|-)/.exec(text.slice(j, j + 24));
        if (duplicate) { i = j + duplicate[0].length; continue; } // 2>&1, >&2: not a file
        j++;
      }
      pending = descriptor && descriptor !== '1' ? 'other' : 'write';
      i = j;
      continue;
    }
    if (char === '<') {
      endWord();
      if (text.startsWith('<<<', i)) { i += 3; continue; } // here-string: the next word is data
      if (text.startsWith('<<', i)) {
        const strip = text[i + 2] === '-';
        const read = readHeredocDelimiter(text, i + (strip ? 3 : 2));
        heredocs.push({ delimiter: read.delimiter, strip });
        i = read.end;
        continue;
      }
      if (text[i + 1] === '(') { i++; continue; }
      pending = 'other';
      i++;
      continue;
    }
    open().text += char;
    i++;
  }
  endCommand();
  return found;
}
