const word = '[\\p{L}\\p{M}\\p{N}\\p{Pc}\\u200c\\u200d]'
const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'])
const unsupported = new Set([
  'not', 'if', 'then', 'else', 'contains', 'prefixItems', 'patternProperties',
  'propertyNames', 'dependentSchemas', 'dependencies', '$dynamicRef', '$recursiveRef',
  '$anchor', '$dynamicAnchor', '$recursiveAnchor',
])
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const escapePointer = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1')
const at = (path, key) => `${path}/${escapePointer(key)}`
const normalize = (text) => text.replace(/\r\n?/g, '\n').normalize('NFC')
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function literal(value) {
  if (typeof value === 'string' && value.length > 0) return value
  const result = JSON.stringify(value)
  if (result === undefined) throw new TypeError('Expected a JSON value')
  return result
}

function checker(instructions, options) {
  const texts = typeof instructions === 'string' ? [instructions] : instructions
  if (!Array.isArray(texts) || !texts.every((text) => typeof text === 'string')) {
    throw new TypeError('instructions must be a string or an array of strings')
  }
  const { caseSensitive = true, allowList = [] } = options
  if (typeof caseSensitive !== 'boolean') throw new TypeError('caseSensitive must be boolean')
  if (!Array.isArray(allowList)) throw new TypeError('allowList must be an array of values')
  const flags = caseSensitive ? 'u' : 'iu'
  const normalized = texts.map(normalize)
  const allowed = allowList.map((value) => normalize(literal(value)))
  const report = { ok: true, requirements: [], missing: [], enums: [], patterns: [] }
  function add(kind, value, path) {
    const escaped = escapeRegex(normalize(literal(value)))
    const numeric = typeof value === 'number'
    const left = numeric ? `(?<!${word}|[.+-])` : `(?<!${word})`
    const right = numeric ? `(?!${word}|\\.\\d)` : `(?!${word})`
    const matcher = new RegExp(`${left}${escaped}${right}`, flags)
    const exact = new RegExp(`^(?:${escaped})$`, flags)
    const status = normalized.some((text) => matcher.test(text)) ? 'mentioned'
      : allowed.some((text) => exact.test(text)) ? 'allowed' : 'missing'
    const entry = { kind, value, path, status }
    report.requirements.push(entry)
    if (status === 'missing') {
      report.missing.push(entry)
      report.ok = false
    }
    return entry
  }
  return { report, add }
}

function resolveRef(root, ref, path) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    throw new Error(`${path}: only local JSON Pointer $ref values are supported`)
  }
  let pointer
  try { pointer = decodeURIComponent(ref.slice(1)) } catch {
    throw new Error(`${path}: invalid percent encoding in $ref`)
  }
  if (pointer === '') return { node: root, path: '#' }
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/u.test(pointer)) {
    throw new Error(`${path}: invalid or unsupported $ref pointer ${JSON.stringify(ref)}`)
  }
  const keys = pointer.slice(1).split('/').map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'))
  let node = root
  for (const key of keys) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) {
      throw new Error(`${path}: unresolved $ref ${JSON.stringify(ref)}`)
    }
    node = node[key]
  }
  return { node, path: `#/${keys.map(escapePointer).join('/')}` }
}

/** Audit reachable schema vocabulary; this does not validate model output. */
export function checkSchema(schema, instructions, options = {}) {
  const { report, add } = checker(instructions, options)
  const visited = new Set()
  function walk(node, path) {
    if (visited.has(path)) return
    visited.add(path)
    if (typeof node === 'boolean') return
    if (!object(node)) throw new TypeError(`${path}: schema must be an object or boolean`)
    for (const key of Object.keys(node)) {
      if (unsupported.has(key) || (key === '$id' && path !== '#') ||
          (['additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems'].includes(key)
            && typeof node[key] !== 'boolean')) {
        throw new Error(`${at(path, key)}: unsupported schema keyword; use the documented subset`)
      }
    }
    if (Object.hasOwn(node, 'type')) {
      const declared = Array.isArray(node.type) ? node.type : [node.type]
      if (!declared.length || !declared.every((type) => types.has(type))) {
        throw new TypeError(`${at(path, 'type')}: invalid schema type`)
      }
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || !node.required.every((name) => typeof name === 'string')) {
        throw new TypeError(`${at(path, 'required')}: required must be an array of property names`)
      }
      node.required.forEach((name, index) => add('required', name, at(at(path, 'required'), index)))
    }
    if (Object.hasOwn(node, 'enum')) {
      if (!Array.isArray(node.enum) || !node.enum.length) {
        throw new TypeError(`${at(path, 'enum')}: enum must be a nonempty array`)
      }
      const enumPath = at(path, 'enum')
      const entries = node.enum.map((value, index) => add('enum', value, at(enumPath, index)))
      const valuesFor = (status) => entries.filter((entry) => entry.status === status).map((entry) => entry.value)
      const mentioned = valuesFor('mentioned')
      const missing = valuesFor('missing')
      report.enums.push({ path: enumPath, values: node.enum, mentioned, allowed: valuesFor('allowed'),
        missing, partial: mentioned.length > 0 && missing.length > 0 })
    }
    if (Object.hasOwn(node, 'const')) add('const', node.const, at(path, 'const'))
    if (Object.hasOwn(node, 'pattern')) {
      if (typeof node.pattern !== 'string') throw new TypeError(`${path}: pattern must be a string`)
      report.patterns.push({ path: at(path, 'pattern'), pattern: node.pattern, status: 'described?' })
    }
    if (Object.hasOwn(node, '$ref')) {
      const target = resolveRef(schema, node.$ref, at(path, '$ref'))
      walk(target.node, target.path)
    }
    if (Object.hasOwn(node, 'properties')) {
      if (!object(node.properties)) throw new TypeError(`${path}: properties must be an object`)
      for (const [name, child] of Object.entries(node.properties)) walk(child, at(at(path, 'properties'), name))
    }
    if (Object.hasOwn(node, 'items')) {
      if (Array.isArray(node.items)) node.items.forEach((child, i) => walk(child, at(at(path, 'items'), i)))
      else walk(node.items, at(path, 'items'))
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (!Object.hasOwn(node, key)) continue
      if (!Array.isArray(node[key]) || !node[key].length) throw new TypeError(`${path}: ${key} must be a nonempty array`)
      node[key].forEach((child, index) => walk(child, at(at(path, key), index)))
    }
  }
  walk(schema, '#')
  return report
}

function vocabularyLines(text) {
  if (typeof text !== 'string') throw new TypeError('vocabulary must be a string')
  return text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u)
    .map((value, index) => ({ value: value.trim(), path: `line:${index + 1}` }))
    .filter(({ value }) => value.length > 0)
}

/** One literal per nonblank line; there is no comment syntax. */
export function parseVocabulary(text) {
  return vocabularyLines(text).map(({ value }) => value)
}

export function checkVocabulary(vocabulary, instructions, options = {}) {
  const { report, add } = checker(instructions, options)
  for (const { value, path } of vocabularyLines(vocabulary)) add('vocabulary', value, path)
  return report
}
