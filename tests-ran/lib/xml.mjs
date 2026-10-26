// A deliberately limited, non-expanding XML reader for JUnit reports.
// DTDs/custom entities are rejected; comments and CDATA never become elements.
const namePattern = '[A-Za-z_][A-Za-z0-9_.:-]*';
const tagPattern = new RegExp(`<(/?)(${namePattern})((?:\\s+${namePattern}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, 'y');
const attributePattern = new RegExp(`\\s+(${namePattern})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'g');

function validCharacter(code) {
  return code === 9 || code === 10 || code === 13 ||
    (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
}

function decode(text) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) {
    throw new Error('Invalid XML entity');
  }
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => {
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity in predefined) return predefined[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!validCharacter(code)) throw new Error('Invalid XML character reference');
    return String.fromCodePoint(code);
  });
}

function parseXml(text) {
  for (const char of text) {
    if (!validCharacter(char.codePointAt(0))) throw new Error('Invalid XML character');
  }
  const stack = [];
  let root;
  let position = 0;
  while (position < text.length) {
    if (text[position] !== '<') {
      const next = text.indexOf('<', position);
      const end = next === -1 ? text.length : next;
      const body = text.slice(position, end);
      decode(body);
      if (body.includes(']]>') || (!stack.length && body.trim())) throw new Error('Invalid XML text');
      position = end;
      continue;
    }
    if (text.startsWith('<!--', position)) {
      const end = text.indexOf('-->', position + 4);
      const body = text.slice(position + 4, end);
      if (end === -1 || body.includes('--') || body.endsWith('-')) throw new Error('Invalid XML comment');
      position = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', position)) {
      const end = text.indexOf(']]>', position + 9);
      if (end === -1 || !stack.length) throw new Error('Invalid XML CDATA');
      position = end + 3;
      continue;
    }
    if (text.startsWith('<?', position)) {
      const end = text.indexOf('?>', position + 2);
      if (end === -1 || !/^<\?[A-Za-z_][\w.:-]*(?:\s|\?>)/.test(text.slice(position))) {
        throw new Error('Invalid XML processing instruction');
      }
      if (/^<\?xml(?:\s|\?>)/i.test(text.slice(position))) {
        const declaration = text.slice(position, end + 2);
        if (position !== 0 || !/^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')(?:\s+encoding\s*=\s*(?:"[A-Za-z][\w.-]*"|'[A-Za-z][\w.-]*'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/.test(declaration)) {
          throw new Error('Invalid XML declaration');
        }
      }
      position = end + 2;
      continue;
    }
    tagPattern.lastIndex = position;
    const tag = tagPattern.exec(text);
    if (!tag) throw new Error('Malformed XML or unsupported DTD');
    position = tagPattern.lastIndex;
    const [, closing, name, attributes, selfClosing] = tag;
    if (closing) {
      if (attributes || selfClosing || stack.pop()?.name !== name) throw new Error('Mismatched XML closing tag');
      continue;
    }
    const attrs = Object.create(null);
    for (const attribute of attributes.matchAll(attributePattern)) {
      if (Object.hasOwn(attrs, attribute[1])) throw new Error('Duplicate XML attribute');
      attrs[attribute[1]] = decode(attribute[2] ?? attribute[3]);
    }
    const namespaces = { xml: 'http://www.w3.org/XML/1998/namespace', ...stack.at(-1)?.namespaces };
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('xmlns:')) {
        const prefix = key.slice(6);
        if (!value || prefix === 'xmlns' || prefix.includes(':') ||
          (prefix === 'xml' && value !== namespaces.xml)) throw new Error('Invalid XML namespace declaration');
        namespaces[prefix] = value;
      }
    }
    const qualifiedNames = [name, ...Object.keys(attrs).filter(key => key !== 'xmlns' && !key.startsWith('xmlns:'))];
    for (const qualified of qualifiedNames) {
      const parts = qualified.split(':');
      if (parts.length > 2 || (parts.length === 2 && (!parts[1] || !Object.hasOwn(namespaces, parts[0])))) {
        throw new Error('Undeclared or invalid XML namespace prefix');
      }
    }
    const node = { name, local: name.split(':').at(-1), attrs, namespaces, children: [] };
    if (stack.length) stack.at(-1).children.push(node);
    else if (root) throw new Error('Multiple XML roots');
    else root = node;
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > 256) throw new Error('XML nesting exceeds 256 levels');
    }
  }
  if (!root || stack.length) throw new Error('Missing or incomplete XML document');
  return root;
}

function attributeCount(node, name) {
  if (!Object.hasOwn(node.attrs, name)) return undefined;
  const value = node.attrs[name];
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid JUnit ${name} count`);
  return Number(value);
}

function suiteCount(node) {
  const total = attributeCount(node, 'tests');
  const skipped = attributeCount(node, 'skipped');
  const disabled = attributeCount(node, 'disabled');
  const failures = attributeCount(node, 'failures');
  const errors = attributeCount(node, 'errors');
  for (const value of [skipped, disabled, failures, errors]) {
    if (total !== undefined && value !== undefined && value > total) throw new Error('Inconsistent JUnit counts');
  }
  const children = node.children.filter(child => ['testsuites', 'testsuite', 'testcase'].includes(child.local));
  if (!children.length) {
    if (total === undefined) {
      if (node.local === 'testsuites') return 0;
      throw new Error('JUnit suite has neither testcases nor a tests count');
    }
    const omitted = (skipped ?? 0) + (disabled ?? 0);
    if (omitted + (failures ?? 0) + (errors ?? 0) > total) throw new Error('Inconsistent JUnit counts');
    return total - omitted;
  }
  let executed = 0;
  for (const child of children) {
    if (child.local !== 'testcase') {
      executed += suiteCount(child);
      continue;
    }
    const excluded = child.children.some(item => item.local === 'skipped') ||
      ['notrun', 'skipped', 'disabled', 'todo', 'pending'].includes(child.attrs.status);
    if (!excluded) executed++;
  }
  // Ancestor totals differ between JUnit producers; validate only leaf suites.
  if (children.every(child => child.local === 'testcase')) {
    if (total !== undefined && total !== children.length) throw new Error('JUnit tests count disagrees with testcases');
    if ((skipped !== undefined || disabled !== undefined) && (skipped ?? 0) + (disabled ?? 0) !== children.length - executed) {
      throw new Error('JUnit skipped count disagrees with testcases');
    }
  }
  if (!Number.isSafeInteger(executed)) throw new Error('JUnit count exceeds safe integer range');
  return executed;
}

export function countJUnit(report) {
  const root = parseXml(report);
  if (!['testsuite', 'testsuites'].includes(root.local)) throw new Error('Expected a JUnit testsuite or testsuites root');
  return suiteCount(root);
}
