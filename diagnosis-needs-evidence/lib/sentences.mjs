// Prose check: which sentences of a text name a cause without evidence.

const LETTER_OR_DIGIT = String.raw`\p{L}\p{N}`;
const before = `(?<![${LETTER_OR_DIGIT}])`;
const after = `(?![${LETTER_OR_DIGIT}])`;

// A word that names a cause. "root cause" is covered by "cause". "because" is not
// a match: a letter stands in front of "cause" there.
const CAUSE = new RegExp(
  `${before}(?:cause[sd]?|diagnos(?:is|ed|es)` +
  `|причин(?:а|ы|е|у|ой|ою|ам|ами|ах)?` +
  `|диагноз(?:а|ы|у|е|ом|ов|ам|ами|ах)?)${after}`, 'iu');

// Evidence one: a reference path/file.ext:line, path/file.ext ~line, path/file.ext line N,
// path/file.ext#L12. The extension list is explicit so that host:port text such as
// "api.example.com:443" does not count as a code reference.
const EXTENSIONS = 'mjs|cjs|js|jsx|mts|cts|ts|tsx|json|jsonl|md|mdx|sh|bash|zsh|ps1|bat|cmd|py|rb|go|rs|java|kt|swift|' +
  'c|h|cc|cpp|hpp|cs|php|lua|pl|sql|ya?ml|toml|ini|cfg|conf|env|txt|log|html|css|scss|vue|svelte|xml|gradle|tf';
const REFERENCE = new RegExp(
  String.raw`[\p{L}\p{N}_./\\@+-]+\.(?:${EXTENSIONS})` + '`?' +
  String.raw`\s*(?::\s*\d+|~\s*\d+|#L\d+|,?\s+lines?\s+\d+|,?\s+строк[аи]?\s+\d+)`, 'iu');

// Evidence two: the text says plainly that it is a guess or that the code was not read.
const GUESS = new RegExp(
  `${before}(?:guess(?:es|ed|ing)?|hypothes(?:is|es)|not\\s+(?:yet\\s+)?(?:read|checked)` +
  `|догадк(?:а|и|е|у|ой|ою|ам|ами|ах)|гипотез(?:а|ы|е|у|ой|ою|ам|ами|ах)` +
  `|не\\s+(?:про)?чита(?:л[аио]?|ю|ем)|не\\s+прочитан[оаы]?` +
  `|не\\s+проверя(?:л[аио]?|ю|ем)|не\\s+проверен[оаы]?)${after}`, 'iu');

const SENTENCE_BREAK = /(?<=[.;!?…])\s+|\n+/;
const MAX_QUOTED = 160;

export const hasReference = text => REFERENCE.test(text);
export const hasGuessMark = text => GUESS.test(text);
export const namesCause = text => CAUSE.test(text);

/**
 * Sentences of `text` that name a cause while neither they nor the sentence after them
 * carry a code reference or a guess mark. Returned trimmed, long ones cut to 160 characters.
 */
export function bareCauses(text) {
  const sentences = String(text).split(SENTENCE_BREAK).map(s => s.trim()).filter(Boolean);
  const bare = [];
  sentences.forEach((sentence, index) => {
    if (!namesCause(sentence)) return;
    const near = `${sentence} ${sentences[index + 1] ?? ''}`;
    if (hasReference(near) || hasGuessMark(near)) return;
    bare.push(sentence.length > MAX_QUOTED ? `${sentence.slice(0, MAX_QUOTED)}…` : sentence);
  });
  return bare;
}
