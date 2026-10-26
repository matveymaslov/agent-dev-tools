# prompt-covers-schema

Does your prompt name every word your validator demands?

A model can repeatedly fail a validator because the instructions never name an
accepted enum member, an exact marker, or a required field. Before running the
model, compare the schema's vocabulary with the instructions you actually hand it.
This small CLI and library lists the missing literals and their schema paths.
It has **zero dependencies**, uses Node.js 20 or newer, and never accesses the network.

## Quick start

Run these commands from this folder. No install or build step is needed.
They work in PowerShell, Command Prompt, and POSIX shells.

```sh
node cli.mjs --schema examples/schema.json examples/incomplete.md
```

This exits **1** and includes:

```text
missing enum #/$defs/state/enum/1: "fail"
missing enum #/$defs/state/enum/2: "skip"
partial enum #/$defs/state/enum: missing "fail", "skip"
described? #/properties/code/pattern: "^[A-Z]{3}$"
```

```sh
node cli.mjs --schema examples/schema.json examples/complete.md
node cli.mjs --vocab examples/vocabulary.txt examples/complete.md
node cli.mjs --schema examples/schema.json --json examples/complete.md
```

These exit **0**. Patterns remain manual `described?` entries even when the
instructions describe them. A human must decide whether that description suffices.

## CLI

```text
node cli.mjs (--schema FILE | --vocab FILE) [options] INSTRUCTIONS...
```

Pass any number of instruction files; coverage may come from any one of them.
Files are examined separately, so their adjoining edges cannot manufacture a match.
Paths are relative to the current directory. Quote paths containing spaces.
Use `--` before instruction filenames starting with `-`; prefix an option's filename
with `./` if that filename starts with `--`.

| Option | Meaning |
| --- | --- |
| `--schema FILE` | One JSON Schema file, mutually exclusive with `--vocab` |
| `--vocab FILE` | One UTF-8 vocabulary file, one literal per nonblank line |
| `--allow-list FILE` | Exempt literals, one per line; repeat for several files |
| `--ignore-case` | Unicode simple case folding, independent of locale |
| `--case-sensitive` | Exact case, the default; last case flag wins |
| `--json` | JSON on stdout, also for input errors |
| `--help` | Usage and exit codes |

Vocabulary and allow-list files trim line edges and skip blank lines. They have
**no comment syntax**: `#END` is a literal. UTF-8 BOM, LF, CRLF and CR line endings
are accepted. Allow lists match entire literals, not fragments or regular expressions;
they apply globally to matching values, including required property names.
For a numeric, boolean, null, composite or empty-string value, put its compact JSON
representation on the line (for example `false`, `{"code":"ok"}`, or `""`).

```sh
node cli.mjs --schema schema.json --allow-list allowed.txt --ignore-case "main prompt.md" policy.md
node cli.mjs --schema schema.json --json prompt.md > coverage.json
```

| Exit | Meaning |
| --- | --- |
| `0` | Every extracted literal is mentioned or explicitly allowed |
| `1` | At least one extracted literal is unnamed |
| `2` | Invalid arguments, unreadable files, invalid JSON, malformed supported keywords, or unsupported schema constructs |

## Library and JSON report

```js
import { checkSchema, checkVocabulary, parseVocabulary } from './index.mjs'

const report = checkSchema(
  { enum: ['pass', 'fail', 'skip'] },
  ['Choose pass or fail.', 'Use the exact spelling.'],
  { caseSensitive: true, allowList: ['skip'] },
)
console.log(report.ok) // true
console.log(report.enums[0].allowed) // ['skip']

checkVocabulary('pass\nfail', 'pass') // missing fail at line:2
parseVocabulary('pass\r\nfail\r\n') // ['pass', 'fail']
```

The library accepts parsed JSON Schema values and a string or array of strings for
instructions. It throws for invalid input. It performs no file, process or network I/O.
The CLI's JSON output is the same report:

- `ok`: whether `missing` is empty; does not certify manual pattern review.
- `requirements`: `{ kind, value, path, status }` for every extracted occurrence.
  `kind` is `enum`, `const`, `required`, or `vocabulary`.
  `status` is `mentioned`, `allowed`, or `missing`; an actual mention takes priority.
- `missing`: the requirements with status `missing`.
- `enums`: `{ path, values, mentioned, allowed, missing, partial }` per enum.
  `partial` means at least one actual mention and at least one unexempted omission.
- `patterns`: `{ path, pattern, status: "described?" }` for manual review.

Paths are `#` followed by a JSON Pointer, with `~` and `/` in keys escaped as `~0`
and `~1`. They are readable pointers, not percent-encoded URIs. Required names
point to their entry in `required`; enum members point to their array index.
Vocabulary paths use original line numbers, including skipped blank lines.
Input errors in JSON mode are `{ "ok": false, "error": "explanation" }` with exit 2.

## Schema subset

The walker visits `properties`, `items` (single schema or legacy tuple array),
`anyOf`, `oneOf`, `allOf`, and local JSON Pointer `$ref` targets, including `$defs`
and `definitions`. It collects `enum`, `const`, `required` and `pattern` at every
visited schema. `type` is accepted but does not add vocabulary.

References resolve against the same root document. Escaped and percent-encoded
pointers work; cycles terminate, and a definition is reported once at its source
path. Unused definitions are not checked. `$ref` siblings are always audited.
Every alternative is audited, as are optional properties: the purpose is to name
the entire available vocabulary before generation. This is deliberately more
conservative than choosing a single validating branch.

The reference rules and composition concepts are documented in the official
[JSON Schema structuring guide](https://json-schema.org/understanding-json-schema/structuring)
and [combining guide](https://json-schema.org/understanding-json-schema/reference/combining).

## Matching and limits

- Matching is literal, with Unicode letters, marks, numbers, connector punctuation
  (including `_`), and join controls treated as word characters. A literal must
  have no such character immediately before or after it. `failed`, `prefail`, and
  `fail_safe` do not name `fail`; `(fail)` does. Hyphens separate words.
- NFC normalization makes composed and decomposed accents equivalent. Case is
  significant by default. Case-insensitive mode uses JavaScript Unicode simple
  folding, not locale-specific collation or multi-character folding.
- Phrases and punctuation markers match literally, including internal spacing.
  Line endings normalize to LF. Strings match their contents; an empty string
  must appear as `""`. Other JSON values match their compact `JSON.stringify`
  representation, preserving object key order. Pretty-printed objects may not match.
  Numeric values must not be embedded in another number: `-12` and `12.5` do not
  name the numeric value `12`.
- This is a vocabulary audit, not a JSON Schema validator or a semantic prompt
  review. A mention in a negative example still counts. Boolean `false` schemas
  contain no vocabulary and pass even though they accept no instances.
- Patterns are never executed, inferred, or automatically approved. Other validation
  constraints (such as numeric ranges, lengths and `format`) are not audited.
- External references, anchors, nested `$id`, conditionals, `not`, `contains`,
  `prefixItems`, `patternProperties`, `propertyNames`, dependency schemas and
  dynamic/recursive references are rejected. Schema-valued `additionalProperties`,
  `additionalItems`, `unevaluatedProperties` and `unevaluatedItems` are rejected;
  their boolean forms are accepted. Unknown extension keywords and annotations
  are ignored, including `examples` and `default`; do not hide vocabularies there.
- Inputs are read into memory. Intended for small schemas and instruction sets;
  this is not a streaming parser or a complete schema meta-validator.

## Tests

```sh
npm test
```

Tests exercise behavior, real CLI exit codes, references, Unicode, CRLF and paths
containing spaces. They use temporary files and no network or shell commands.
The repository's root workflow runs them on Linux and Windows with Node 22 and 24
(`engines` allows Node 20, which is not part of that matrix). No dependencies
need installing.

`package.json` exposes the ES module and the `prompt-covers-schema` command; the
package file list excludes tests. License: [MIT](LICENSE).
