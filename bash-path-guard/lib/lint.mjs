// Intentionally lexical: even an invalid config can contain a damaged path.
// No guessing of format-specific escapes or rewriting the user's file.
export function lintText(text) {
  const findings = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  for (let line = 0; line < lines.length; line++) {
    const pattern = /(?<![\w])[a-z]:[a-z][^\s"'`,;#\[\]{}<>)]*/gi;
    for (const match of lines[line].matchAll(pattern)) {
      findings.push({ path: match[0], line: line + 1, column: match.index + 1 });
    }
  }
  return findings;
}
