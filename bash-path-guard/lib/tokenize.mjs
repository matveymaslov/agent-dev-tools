// A lexical reader, not a shell interpreter. It never expands variables or runs
// commands. Keep original spelling alongside quote removal for path diagnostics.
export function tokenize(source) {
  source = source.replace(/\r\n/g, '\n');
  const commands = [];
  const words = [];
  const heredocs = [];
  const errors = [];
  let index = 0;
  let depth = 0;
  const error = message => errors.push({ index, message });

  function word(stop, delimiter = false) {
    const start = index;
    const parts = [];
    let value = '';
    let quoted = false;
    const append = (text, cooked, mode, at) => {
      parts.push({ text, mode, index: at });
      value += cooked;
    };
    function substitution(end, width) {
      index += width;
      sequence(end);
      // Do not mistake child syntax for characters of the surrounding word.
      append('\0', '\0', 'expansion', index);
    }
    function quote(mark, mode) {
      quoted = true;
      index++;
      while (index < source.length && source[index] !== mark) {
        const at = index;
        const char = source[index];
        if (mode === 'double' && !delimiter && source.startsWith('$(', index)) {
          substitution(')', 2);
        } else if (mode === 'double' && !delimiter && char === '`') {
          substitution('`', 1);
        } else if (char === '\\' && mode !== 'single') {
          const next = source[index + 1];
          const escapes = mode === 'ansi' || (next && '$`"\\\n'.includes(next));
          if (escapes && next !== undefined) {
            append(source.slice(index, index + 2), next === '\n' ? '' : next, mode, at);
            index += 2;
          } else {
            append(char, char, mode, at);
            index++;
          }
        } else {
          append(char, char, mode, at);
          index++;
        }
      }
      if (source[index] === mark) index++;
      else error(`Unterminated ${mode} quote`);
    }
    while (index < source.length) {
      const char = source[index];
      if (/\s/.test(char) || ';&|<>()'.includes(char) || (stop && char === stop)) break;
      const at = index;
      if (source.startsWith("$'", index)) {
        index++;
        quote("'", 'ansi');
      } else if (source.startsWith('$"', index)) {
        index++;
        quote('"', 'double');
      } else if (char === "'") {
        quote("'", 'single');
      } else if (char === '"') {
        quote('"', 'double');
      } else if (char === '\\') {
        quoted = true;
        const next = source[index + 1];
        if (next === undefined) {
          error('Unfinished escape');
          index++;
        } else {
          append(source.slice(index, index + 2), next === '\n' ? '' : next, 'unquoted', at);
          index += 2;
        }
      } else if (!delimiter && source.startsWith('$(', index)) {
        substitution(')', 2);
      } else if (!delimiter && char === '`') {
        substitution('`', 1);
      } else {
        append(char, char, 'unquoted', at);
        index++;
      }
    }
    const result = { value, parts, index: start, quoted };
    if (!delimiter) words.push(result);
    return result;
  }

  function bodies(pending) {
    for (const marker of pending) {
      const start = index;
      let body = '';
      let found = false;
      while (index < source.length) {
        const begin = index;
        let logical = '';
        let continued;
        do {
          let end = source.indexOf('\n', index);
          if (end < 0) end = source.length;
          let line = source.slice(index, end);
          index = end < source.length ? end + 1 : end;
          if (marker.stripTabs) line = line.replace(/^\t+/, '');
          const slashes = line.match(/\\+$/)?.[0].length || 0;
          continued = !marker.quoted && slashes % 2 === 1 && end < source.length;
          logical += continued ? line.slice(0, -1) : line;
        } while (continued && index < source.length);
        if (logical === marker.value) {
          found = true;
          break;
        }
        body += source.slice(begin, index);
      }
      heredocs.push({ text: body, index: start, quoted: marker.quoted });
      if (!found) error('Unterminated here-document');
    }
  }

  function sequence(stop) {
    depth++;
    if (depth > 32) throw new Error('Shell nesting exceeds the inspection limit; use a script file.');
    let command = [];
    const pending = [];
    const flush = () => {
      if (command.length) commands.push(command);
      command = [];
    };
    while (index < source.length) {
      const char = source[index];
      if (stop && char === stop) {
        flush();
        index++;
        depth--;
        return;
      }
      if (char === '\n') {
        flush();
        index++;
        bodies(pending.splice(0));
      } else if (/\s/.test(char)) {
        index++;
      } else if (char === '#') {
        while (index < source.length && source[index] !== '\n') index++;
      } else if (source.startsWith('<<<', index)) {
        index += 3;
        while (/[ \t]/.test(source[index] || '\0')) index++;
        if (index < source.length) word(stop);
      } else if (source.startsWith('<<', index)) {
        index += 2;
        const stripTabs = source[index] === '-';
        if (stripTabs) index++;
        while (/[ \t]/.test(source[index] || '\0')) index++;
        const before = index;
        const marker = word(stop, true);
        if (index === before) {
          error('Missing here-document delimiter');
        } else pending.push({ ...marker, stripTabs });
      } else if (char === '<' || char === '>') {
        // Redirection operands are words, but not executable arguments.
        index++;
        if ('>&|'.includes(source[index] || '\0')) index++;
        while (/[ \t]/.test(source[index] || '\0')) index++;
        if (index < source.length && !';|&()\n'.includes(source[index])) word(stop);
      } else if (char === '(') {
        flush();
        index++;
        sequence(')');
      } else if (';&|)'.includes(char)) {
        flush();
        index++;
      } else {
        const token = word(stop);
        const descriptor = /^\d+$/.test(token.value) && '<>'.includes(source[index] || '\0');
        if (!descriptor && (token.value || token.quoted)) command.push(token);
      }
    }
    flush();
    if (pending.length) bodies(pending);
    if (stop) error('Unterminated command substitution or group');
    depth--;
  }
  sequence();
  return { commands, words, heredocs, errors };
}
