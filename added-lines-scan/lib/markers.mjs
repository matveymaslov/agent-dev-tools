// The markers file: one regular expression per line.
//   # comment          a line whose first non-blank character is # (write \# to match a literal #)
//   (blank)            ignored
//   pattern            a JavaScript regular expression, case-sensitive
//   /pattern/i         the same, case-insensitive; /pattern/ with no flag is the same as pattern
// Leading and trailing whitespace on a line is trimmed; write \s or \x20 for a significant space.

const SLASHED = /^\/(.+)\/([a-z]*)$/;

/** Parse markers text into [{ source, regex }]; `source` is the line as written, for the report. */
export function parseMarkers(text, label = 'markers') {
  const markers = [];
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const where = `${label}:${index + 1}`;
    let pattern = line;
    let flags = '';
    const slashed = SLASHED.exec(line);
    if (slashed) {
      if (slashed[2] !== '' && slashed[2] !== 'i') {
        throw new Error(`${where}: "${line}" reads as /pattern/flags with the flags "${slashed[2]}", and only i is supported; ` +
          'to match a path that starts with a slash, escape the first slash: \\/...');
      }
      pattern = slashed[1];
      flags = slashed[2];
    }
    try { markers.push({ source: line, regex: new RegExp(pattern, flags) }); }
    catch (error) { throw new Error(`${where}: invalid regular expression: ${error.message}`); }
  });
  return markers;
}
