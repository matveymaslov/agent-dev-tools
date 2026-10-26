#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { checkSchema, checkVocabulary, parseVocabulary } from './index.mjs'

const help = `Usage: prompt-covers-schema (--schema FILE | --vocab FILE) [options] INSTRUCTIONS...

  --schema FILE       JSON Schema to audit
  --vocab FILE        Plain vocabulary, one literal per line
  --allow-list FILE   Exempt literals, one per line; may be repeated
  --ignore-case       Match without case distinctions (Unicode simple folding)
  --case-sensitive    Match exact case (default)
  --json              Print a JSON report, including input errors
  --help              Show this help
  --                  Treat remaining arguments as instruction filenames

Exit codes: 0 = all literals covered, 1 = missing literals, 2 = input error.
Patterns always appear as "described?" for manual review; they do not change exit status.
`

function parseArgs(args) {
  const options = { instructions: [], allowFiles: [], caseSensitive: true, json: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') { options.instructions.push(...args.slice(index + 1)); break }
    if (arg === '--help') { options.help = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--ignore-case') { options.caseSensitive = false; continue }
    if (arg === '--case-sensitive') { options.caseSensitive = true; continue }
    if (['--schema', '--vocab', '--allow-list'].includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a filename`)
      if (arg === '--allow-list') options.allowFiles.push(value)
      else {
        if (options.source) throw new Error('Choose exactly one --schema or --vocab file')
        options.source = value
        options.mode = arg
      }
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}; use --help`)
    else options.instructions.push(arg)
  }
  if (!options.help && (!options.source || !options.instructions.length)) {
    throw new Error('A --schema or --vocab file and at least one instruction file are required; use --help')
  }
  return options
}

function read(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')
}

function format(report) {
  const lines = [report.ok ? 'All required literals are covered.' : `${report.missing.length} required literal(s) unnamed:`]
  for (const entry of report.missing) lines.push(`missing ${entry.kind} ${entry.path}: ${JSON.stringify(entry.value)}`)
  for (const entry of report.enums.filter((entry) => entry.partial)) {
    lines.push(`partial enum ${entry.path}: missing ${entry.missing.map((value) => JSON.stringify(value)).join(', ')}`)
  }
  for (const entry of report.patterns) lines.push(`described? ${entry.path}: ${JSON.stringify(entry.pattern)}`)
  return `${lines.join('\n')}\n`
}

const args = process.argv.slice(2)
// Detect the output mode even when argument parsing fails, but respect the -- delimiter.
const delimiter = args.indexOf('--')
const json = (delimiter < 0 ? args : args.slice(0, delimiter)).includes('--json')
try {
  const options = parseArgs(args)
  if (options.help) process.stdout.write(help)
  else {
    const instructions = options.instructions.map(read)
    const matching = { caseSensitive: options.caseSensitive,
      allowList: options.allowFiles.flatMap((file) => parseVocabulary(read(file))) }
    const source = read(options.source)
    const report = options.mode === '--schema'
      ? checkSchema(JSON.parse(source), instructions, matching)
      : checkVocabulary(source, instructions, matching)
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : format(report))
    process.exitCode = report.ok ? 0 : 1
  }
} catch (error) {
  const message = error.message ?? String(error)
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  else process.stderr.write(`prompt-covers-schema: ${message}\n`)
  process.exitCode = 2
}
