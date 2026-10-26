// Source offsets allow edits without reserializing unrelated settings, numbers,
// escaped strings, or hooks. JSON.parse validates syntax before this small walker.
export function parseDocument(text) {
  const offset = text.startsWith('\uFEFF') ? 1 : 0;
  JSON.parse(text.slice(offset));
  let cursor = offset;
  const whitespace = () => { while (/[ \t\r\n]/.test(text[cursor] ?? 'x')) cursor++; };
  function string() {
    const start = cursor++;
    while (text[cursor] !== '"') {
      if (text[cursor] === '\\') cursor++;
      cursor++;
    }
    cursor++;
    return JSON.parse(text.slice(start, cursor));
  }
  function value() {
    whitespace();
    const start = cursor;
    const first = text[cursor];
    if (first === '{' || first === '[') {
      const kind = first === '{' ? 'object' : 'array';
      const close = kind === 'object' ? '}' : ']';
      const children = [], keys = new Set();
      cursor++; whitespace();
      while (text[cursor] !== close) {
        const memberStart = cursor;
        let key;
        if (kind === 'object') {
          key = string(); whitespace(); cursor++;
          if (keys.has(key)) throw new SyntaxError('Duplicate JSON object key: ' + key);
          keys.add(key);
        }
        const child = value();
        children.push(kind === 'object' ? { key, start: memberStart, end: child.end, node: child } : child);
        whitespace();
        if (text[cursor] === close) break;
        cursor++; whitespace();
      }
      cursor++;
      return { kind, start, end: cursor, children };
    }
    if (first === '"') string();
    else while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
    return { kind: 'value', start, end: cursor };
  }
  return value();
}

export const member = (node, key) => node.children.find(item => item.key === key)?.node;
export const decode = (text, node) => JSON.parse(text.slice(node.start, node.end));

export function append(node, serialized) {
  const last = node.children.at(-1);
  return { start: last?.end ?? node.start + 1, end: last?.end ?? node.start + 1,
    text: (last ? ',' : '') + serialized };
}

export function deletions(array, indices) {
  const edits = [];
  for (let i = 0; i < array.children.length; i++) {
    if (!indices.has(i)) continue;
    const first = i;
    while (indices.has(i + 1)) i++;
    const next = array.children[i + 1];
    const previous = array.children[first - 1];
    edits.push({
      start: !next && previous ? previous.end : array.children[first].start,
      end: next ? next.start : array.children[i].end,
      text: '',
    });
  }
  return edits;
}

export function applyEdits(text, edits) {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}
